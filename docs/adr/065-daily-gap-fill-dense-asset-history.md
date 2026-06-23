---
title: ADR-065 - Daily Gap-Fill for Dense Asset Price History
type: adr
status: accepted
date: 2026-05-31
tags: [adr, portfolio, price-history, binance, quote-backfill, gap-fill, daily-granularity, sparsity, asset-price-history, startup-optimization, backfill, densify]
description: Add a daily gap-detecting backfill pass + force-refetch path + full-window Binance pagination to keep asset_price_history dense at daily granularity, then recompute snapshots when new rows are written. Addresses needsHistoryRefresh endpoint-only check + Binance 365-day cap + startup-only full backfill that left interior gaps rendering as ~biweekly chart points.
related: [docs/adr/064-net-worth-current-value-live-overlay, docs/adr/061-snapshot-valuation-parity, docs/adr/043-portfolio-snapshot-atomicity, docs/integrations/price-providers, docs/features/net-worth]
---

# ADR-065: Daily Gap-Fill for Dense Asset Price History

## Status

**Accepted** — Implemented 2026-05-31.

## Date

2026-05-31

## Context

### Observed symptom

Portfolio and asset detail charts were rendering price series at approximately biweekly granularity instead of daily, even for investments with years of complete provider data available. The charts were visually choppy and failed to reflect intraweek price movement.

### Three independent root causes

#### 1. Binance 365-day cap silently discarded old history

`fetchHistoricalPrices` in `priceProviderService.js` capped the history window:

```javascript
const days = Math.min(daysDiff, 365);
```

A crypto position held for two or three years therefore only ever received one year of price history. The first startup backfill filled the most-recent year; everything older remained empty. Subsequent backfills never re-fetched (see cause 2 below).

#### 2. `needsHistoryRefresh` checked only endpoints, not interior gaps

`priceCache.js`'s `needsHistoryRefresh(investment, fromMs, toMs)` returned `false` — "no refresh needed" — whenever the persisted `asset_price_history` series had at least one row at or before `fromMs` and at least one row at or after `toMs`. It made no check for interior gaps. A series that spanned the window but had large holes (because only the last 365 days were ever fetched, or because the provider returned sparse data on an earlier run) was permanently considered "complete" and never re-fetched.

#### 3. Full backfill ran only at startup; hourly refresh was open-positions-only and 7-day window

`quoteBackfillService.backfillHistoricalAssetQuotes()` (full historical window, all investments) ran once — at startup warmup — and was never re-run. `refreshActiveHoldingQuotes()` ran hourly but only covered the last 7 days and only currently-open positions. No scheduled job healed interior gaps in historical windows for closed positions.

### Combined effect

For a crypto position held since 2023:
- Startup backfill populated 2025-05-01 → 2026-05-31 (365 days)
- 2023-01-01 → 2025-04-30 had zero rows
- `needsHistoryRefresh` saw a row inside the window (2025-05-01) → returned false → no re-fetch ever triggered
- Chart showed ~14-day sparsity in the covered year (typical Binance API cadence in the old single-fetch mode) and complete absence before the 365-day boundary

## Decision

Three coordinated changes keep `asset_price_history` dense at daily granularity across all holding windows, including historical windows and closed positions.

### 1. Full-window Binance pagination

The `days = Math.min(daysDiff, 365)` cap is removed. Instead, a new helper `_fetchBinanceKlines(symbol, startMs, endMs)` paginates the Binance `/api/v3/klines` endpoint with:

- `startTime` / `endTime` timestamps
- `limit=1000` (BINANCE_PAGE_LIMIT) per request
- A runaway guard of 30 pages maximum (BINANCE_MAX_PAGES) with a `WARN` log if hit
- `interval=1d` for daily close prices

The cache key is now window-aware: `binance-history:${symbol}:${dayKey(start)}:${dayKey(end)}`.

The full holding window (position open date → today) is fetched, so a 3-year-old crypto position gets 3 years of daily closes on the first re-fetch.

### 2. `force` option on `fetchHistoricalPrices`

`fetchHistoricalPrices(investment, { fromMs, toMs, dbOnly, force })` now accepts a `force` boolean. When `force=true`, the `needsHistoryRefresh` short-circuit is bypassed entirely, unconditionally going to the provider. This is the only safe way to re-populate interior gaps: the endpoint-spanning check will always return false for a sparse-but-endpoint-spanning series.

### 3. Daily gap-detecting backfill — `quoteBackfillService`

Two new exported functions complement the existing startup-only `backfillHistoricalAssetQuotes`:

**`holdingWindowsNeedBackfill(holdingWindows, storedDates, { thresholdDays, todayUtc })`**

Pure function. Walks `[windowStart, ...storedDatesInWindow, windowEnd]` for each holding window and returns `true` if any consecutive-date gap exceeds `thresholdDays` (default `GAP_THRESHOLD_DAYS = 9`). The threshold is chosen to be:
- Above normal weekend/holiday gaps (2–4 days)
- Above typical national-holiday clusters (up to 6 days)
- Below the ~14-day biweekly sparse cadence that triggered the original bug report

**`backfillHoldingGaps({ thresholdDays })`**

Iterates all investments, loads their stored `price_dates`, calls `holdingWindowsNeedBackfill`, and if a window needs backfill, calls the per-investment backfill path with `{ force: true }`. Tracks `{ checked, needed, filled, failed }`. `filled` increments only when the stored row count grows after the re-fetch (idempotency check).

Unlike the existing hourly `refreshActiveHoldingQuotes` (last 7 days, open positions only) and the startup-only `backfillHistoricalAssetQuotes`, `backfillHoldingGaps` heals interior gaps across all windows including closed positions.

### 4. Daily scheduling — `warmup.js`

A daily `setInterval` (`ONE_DAY_MS`, wrapped in the existing `withInFlightGuard` + offline guard) calls `backfillHoldingGaps()`. If `result.filled > 0`, it calls `computeAndStoreSnapshots()` so the Performance and Net Worth pages reflect the denser history. (ADR-064 live overlay only fixes the latest point; historical rows require a full snapshot recompute to propagate new price rows into the chart.)

`apps/node-backend/src/main.js` captures the interval handle and clears it on graceful shutdown (`holdingGapBackfillInterval`).

### 5. One-time densify script

`apps/node-backend/scripts/densify-asset-history.js` runs `backfillHoldingGaps` off the boot path for users upgrading from sparse history, then recomputes snapshots if rows were written. Exposed as root `package.json` script `quotes:densify`.

## Consequences

### Positive

1. **Daily-granularity charts**: Asset price charts now render at daily resolution across the full holding window, including multi-year crypto positions.
2. **Self-healing**: The daily scheduled job detects and fills gaps introduced by provider outages, API rate-limit partial responses, or future schema migrations, without manual intervention.
3. **Idempotent**: `backfillHoldingGaps` only calls the provider when a gap is detected and only increments `filled` when rows actually grow. Running it repeatedly on a dense series is cheap (single DB read per investment, no provider call).
4. **Binance full-window coverage**: Removing the 365-day cap and adding pagination means 3–5 year crypto histories are populated correctly on first backfill.
5. **Snapshot recompute on fill**: When gaps are healed, `computeAndStoreSnapshots()` runs automatically so the Net Worth and Performance charts update within the same daily job cycle.
6. **One-time densify for existing deployments**: `bun run quotes:densify` heals legacy sparse data without requiring a restart.

### Negative / Tradeoffs

1. **Daily job adds load**: `backfillHoldingGaps` makes one DB read per investment plus one or more provider fetches for investments with detected gaps. For a typical portfolio (~20 investments) on a well-maintained system this is negligible; for a first-run densify on a large portfolio it may take several minutes.
2. **Binance pagination can hit the 30-page runaway guard**: A holding window exceeding 30,000 days would be truncated at the guard. This is a theoretical concern only (82 years of daily data); the `WARN` log makes it visible.
3. **`force` bypasses cache correctness checks**: Callers using `force=true` outside the gap-fill path should be aware they will always hit the provider.
4. **Snapshot recompute is O(D × A)**: Triggering `computeAndStoreSnapshots` from the daily job has the same cost as the startup warmup recompute. For portfolios with ≥10 years of history this is ~1–3 s. The daily gap-fill only triggers recompute when `filled > 0`, so stable systems pay no cost.

### Known open follow-up — Kinesis `timeFrame` unit ambiguity

The Kinesis provider's default `timeFrame=60` parameter was deliberately **not changed** in this work. The value's unit is ambiguous: `kinesisConfig.js` comments say "minutes"; `docs/reference/environment-variables.md` says "days"; `providerHealthService` probes using 60. Changing the value without first running an empirical diagnostic (fetching with different values and checking the returned point density) risks breaking Kinesis history. This ambiguity is tracked in `TODO.md` and should be resolved before any Kinesis history sparsity investigation is attempted.

Note also: `normalizeHistoryPoints` deduplicates by date, so finer-than-daily provider cadence does not itself cause sparsity — only missing dates do.

## Implementation

- **Binance pagination**: [[apps/node-backend/src/services/priceProviderService.js]]
- **`force` option**: [[apps/node-backend/src/services/priceProviderService.js]]
- **`holdingWindowsNeedBackfill` / `backfillHoldingGaps`**: [[apps/node-backend/src/services/quoteBackfillService.js]]
- **Daily schedule + snapshot trigger**: [[apps/node-backend/src/startup/warmup.js]]
- **Graceful shutdown handle**: [[apps/node-backend/src/main.js]]
- **One-time densify script**: [[apps/node-backend/scripts/densify-asset-history.js]]
- **Root script entry point**: `quotes:densify` in root `package.json`

## Related Decisions

- [[docs/adr/064-net-worth-current-value-live-overlay|ADR-064]] — Live overlay for the Net Worth current point; this ADR ensures the *historical* rows that feed the Net Worth chart are dense enough to render correctly
- [[docs/adr/061-snapshot-valuation-parity|ADR-061]] — Snapshot valuation formula parity; new price rows written by the gap-fill will produce correct valuations on the next snapshot recompute because the formulas now mirror `portfolioSummaryService`
- [[docs/adr/043-portfolio-snapshot-atomicity|ADR-043]] — Atomic snapshot replace; the daily-triggered `computeAndStoreSnapshots` uses the same atomic DELETE + INSERT already guaranteed by this ADR

## Related Docs

- [[docs/integrations/price-providers|Price Providers Integration]] — Binance pagination and daily gap-fill behavior
- [[docs/features/net-worth|Net Worth Feature]] — Historical chart density and snapshot recompute
- [[docs/reference/scripts|Scripts Reference]] — `quotes:densify` one-time script
