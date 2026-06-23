---
title: ADR-064 - Net Worth Current Value Live Overlay
type: adr
status: accepted
date: 2026-05-31
tags: [adr, portfolio, net-worth, snapshots, live-overlay, freshness, staleness, portfolioSummaryService, valuation, reconciliation]
description: Overlay the latest Net Worth snapshot's investments value with the live portfolioSummaryService total at read time, so the headline, last chart point, and latest table row stay in sync with Dashboard and Performance across hourly price refreshes — not just at startup.
related: [docs/adr/043-portfolio-snapshot-atomicity, docs/adr/044-portfolio-summary-single-source-of-truth, docs/adr/061-snapshot-valuation-parity, docs/features/net-worth, docs/api/portfolio-summary]
---

# ADR-064: Net Worth Current Value Live Overlay

## Status

**Accepted** — Implemented 2026-05-31.

## Date

2026-05-31

## Context

### Three-surface data-source table

| Surface | Endpoint | Investment value source | Freshness |
|---------|----------|------------------------|-----------|
| Dashboard "Total Value" | `GET /api/info/portfolio-summary` | `portfolioSummaryService.getPortfolioSummary()` | Live; 60s `portfolioSummaryCache` |
| Performance "Portfolio Value" | `GET /api/info/portfolio-performance` | Same live summary, overlaid at read time via `_performanceHelpers.js:84-95` | Live; 60s cache |
| Net Worth "Investments" headline + last chart point | `GET /api/info/net-worth` | `portfolio_performance_snapshots.value` via `infoRepositoryNetWorth.getNetWorthFromSnapshots` | **Stored; only rebuilt at startup** |

ADR-044 unified Dashboard and Performance onto `portfolioSummaryService`. ADR-061 rewrote `snapshotBuilder` non-unit valuation to mirror the same formulas, ensuring that *at snapshot compute time* the stored value matched the live summary. Neither ADR addressed what happens *between* snapshot rebuilds.

### Root cause: snapshots are only rebuilt once — at startup

`computeAndStoreSnapshots()` is called in exactly one place: `apps/node-backend/src/startup/warmup.js:227`. After that, `refreshActiveHoldingQuotes` (warmup.js:271-282) runs on an hourly schedule, mutating `investments.current_price` in place. This immediately updates Dashboard and Performance (they recompute from the DB via the live service), but the stored snapshot rows are never rewritten. Net Worth reads those rows and therefore freezes at the boot-time price.

Consequence: after any hourly price refresh the three-page divergence returns, even though ADR-061 guaranteed parity at boot. A user could see:

- Dashboard: €128,500 (live, post-refresh)
- Performance: €128,500 (live, post-refresh)
- Net Worth "Investments": €125,000 (frozen at boot)

This divergence was reported repeatedly despite the ADR-061 fix, because that fix only narrowed the *formula* gap, not the *freshness* gap.

### Why not just rebuild snapshots on every price refresh?

`computeAndStoreSnapshots()` does a full O(D × A) day walk and a DELETE + batched INSERT. For a portfolio with 3+ years of daily history this takes ~1-3 s and briefly holds a table-level write lock (mitigated by ADR-043 atomicity, but still disruptive). Triggering it hourly would create unnecessary load and a potential write-thundering problem. The historical series does not need to change — only the *current* point does.

### The existing pattern: Performance route live overlay

`apps/node-backend/src/routes/info/_performanceHelpers.js:84-95` already solves the equivalent problem for the Performance page: it fetches the stored snapshot metrics but then overwrites `currentValue`, `totalInvested`, `totalGainLoss`, and `totalReturnPct` with the live `portfolioSummaryService` result before returning them to the caller. Dashboard and Performance are therefore always equal regardless of when `computeAndStoreSnapshots` last ran.

## Decision

Mirror the `_performanceHelpers.js` pattern for the Net Worth endpoint. The most-recent point (headline `current`, the last chart snapshot, and the latest table row) is overlaid with `portfolioSummaryService.getPortfolioSummary().totals.totalPortfolioValue` at read time. Historical days remain snapshot-backed.

### Implementation — four files changed

**1. `apps/node-backend/src/repositories/infoRepositoryNetWorth.js`**

`getNetWorthFromSnapshots(targetCurrency, { liveInvestments } = {})` now accepts an optional `liveInvestments` number. When `Number.isFinite(liveInvestments)` the function overwrites the latest snapshot row's `investments` value and recomputes `netWorth = liquid + liveInvestments` before deriving `current` and `monthlyChange`. All historical rows are untouched.

**2. `apps/node-backend/src/routes/info/_liveSummary.js`** (NEW)

Shared helper module exposing:

```javascript
export async function resolveLiveSummary(targetCurrency)
// Returns full portfolioSummaryService result from the shared portfolioSummaryCache.

export async function resolveLivePortfolioValue(targetCurrency)
// Returns summary.totals.totalPortfolioValue or undefined on error.
// Callers fall back to the stored snapshot value when this returns undefined.
```

Both are served from the existing 60-second `portfolioSummaryCache` (defined in `_cache.js`). `resolveLivePortfolioValue` degrades gracefully: if the live service throws, it logs the error and returns `undefined` so the net-worth response still returns (with the stored snapshot value) rather than failing entirely.

**3. `apps/node-backend/src/routes/info/netWorth.js`**

The cached loader now:
1. Resolves `liveInvestments` via `resolveLivePortfolioValue(targetCurrency)`
2. Passes it to `getNetWorthFromSnapshots(targetCurrency, { liveInvestments })`

The 5-minute net-worth response cache (`NET_WORTH_CACHE_TTL_MS`) is unaffected; the overlay is baked into the cached payload.

**4. `apps/node-backend/src/routes/info.js`**

`warmNetWorthCache` (the startup pre-warm path) applies the same overlay so the first 5 minutes after boot are not stale either.

### API response shape

Unchanged. The `NetWorthResponse` shape is identical; only the numeric value of `current.investments`, `current.netWorth`, the last `snapshots[]` entry, and `monthlyChange` / `monthlyChangePercent` may differ from a pre-fix response.

## Consequences

### Positive

1. **Single source of truth extended to Net Worth**: Dashboard, Performance, and Net Worth now all show the same `current` investments value, sourced from the shared `portfolioSummaryCache`.
2. **Staleness budget tightened**: Net Worth "Investments" now tracks Dashboard within ≤5 min (the net-worth cache TTL) instead of "frozen since startup" (potentially hours or days on long-running servers).
3. **No schema changes**: `portfolio_performance_snapshots` is untouched.
4. **No frontend changes**: The frontend consumes the same `NetWorthResponse` shape.
5. **Graceful degradation**: `resolveLivePortfolioValue` catches errors and returns `undefined`; Net Worth falls back to the stored snapshot rather than 500-ing.
6. **Reuses existing cache**: No new cache is introduced; `portfolioSummaryCache` already runs at 60s TTL and is invalidated on any investment/transaction write.

### Negative / Tradeoffs

1. **Live overlay is baked into the 5-min cache**: Within a single cache window, the displayed "current" value is the live total *at cache-fill time*, not the instantaneous live total. Staleness window is ≤5 min.
2. **`monthlyChange` includes live-overlay effect**: The month-on-month delta is now computed against the live-overlaid latest point, not the stored snapshot. For unit-only portfolios this is strictly more accurate; for mixed portfolios with unresolved split/return-of-capital adjustments the direction of the delta may differ from the raw snapshot.

### Known limitation — historical unit-split days not reconciled (NOT fixed by this change)

The snapshot builder's unit-accounting still ignores `split` and `return_of_capital` transaction types. For a holding that has undergone a stock split, the *historical* chart points prior to the split date may still show an inflated per-unit cost basis. **Only the latest point is reconciled by this change.** The secondary bug is tracked in `TODO.md` and requires a separate snapshot-builder change to propagate split-adjusted prices into `asset_price_history`.

## Implementation

- **Repository**: [[apps/node-backend/src/repositories/infoRepositoryNetWorth.js]]
- **New shared helper**: [[apps/node-backend/src/routes/info/_liveSummary.js]]
- **Net Worth route**: [[apps/node-backend/src/routes/info/netWorth.js]]
- **Info route / warmup path**: [[apps/node-backend/src/routes/info.js]]
- **Reference pattern (Performance)**: [[apps/node-backend/src/routes/info/_performanceHelpers.js]]

## Related Decisions

- [[docs/adr/043-portfolio-snapshot-atomicity|ADR-043]] — Atomic snapshot replace; ensures concurrent reads never see a torn table during startup warmup
- [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044]] — Established `portfolioSummaryService` as the single source of truth for Dashboard + Performance totals; this ADR extends that to Net Worth
- [[docs/adr/061-snapshot-valuation-parity|ADR-061]] — Rewrote `snapshotBuilder` non-unit formulas to match `portfolioSummaryService` at compute time; this ADR fixes the *freshness* gap that ADR-061 left open

## Related Docs

- [[docs/features/net-worth|Net Worth Feature]] — Backend Computation section, Three-page parity callout
- [[docs/api/portfolio-summary|Portfolio Summary API]] — Live summary endpoint shared by Dashboard, Performance, and (now) Net Worth overlay
