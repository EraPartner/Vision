---
title: Net Worth Feature
type: feature
status: active
date: 2026-06-20
updated: 2026-08-27
tags:
  [
    feature,
    net-worth,
    portfolio,
    chart,
    frontend,
    performance,
    snapshots,
    fixed-income,
    valuation-parity,
    accrued-interest,
    appreciation,
    live-overlay,
    valuation-freshness,
    daily-granularity,
    gap-fill,
    price-history,
    per-account,
    period-selector,
    scrub,
    shared-chart-card,
    adr-093,
    adr-100,
  ]
description: Daily net worth tracking with a responsive, period-scoped area chart at full daily resolution (no downsampling), all three series (total/liquid/investments) shown together with a legend, drag-to-compare scrubbing, and a daily aggregate breakdown table. The chart shares the app-wide ChartCard / ChartPeriodSelector chrome with the Performance page. Powered by pre-computed snapshots whose non-unit asset valuation mirrors live portfolio summary formulas (ADR-061); the latest point is overlaid with the live summary at read time so the headline stays in sync across hourly price refreshes (ADR-064). Historical price series are kept dense at daily granularity via a daily gap-detecting backfill.
aliases: [net worth, networth, wealth tracking, financial health]
related_code:
  - apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx
  - apps/frontend/src/pages/portfolio/net-worth/NetWorthChart.tsx
  - apps/frontend/src/components/charts/ChartCard.tsx
  - apps/frontend/src/components/charts/ChartPeriodSelector.tsx
  - apps/frontend/src/components/charts/chartPeriods.ts
  - apps/node-backend/src/routes/info.js
  - apps/node-backend/src/routes/info/netWorth.js
  - apps/node-backend/src/routes/info/_liveSummary.js
  - apps/node-backend/src/repositories/infoRepositoryNetWorth.js
  - apps/node-backend/src/services/portfolioPerformanceSnapshotService.js
  - apps/node-backend/src/services/portfolio/snapshotBuilder.js
---

# Net Worth Feature

## Shareable view state

The selected chart range is stored in `?period=1m|3m|6m|1y|3y|all`. The default range is omitted. Invalid values fall back to the default without rewriting the URL, and changes replace the current history entry.

## Overview

The Net Worth page (`/portfolio/net-worth`) tracks daily net worth by combining liquid assets (bank balances) and investment values (including fixed-income: real estate, savings, bonds). It features a responsive, period-scoped area chart that renders at **full daily resolution** (no downsampling) so both the line and the drag-to-compare scrubbing stay day-granular, all three series shown together with a legend, and a daily breakdown table.

The hero total also identifies the provenance of its live investment component. `Investment prices
as of …` uses the oldest valid timestamp across live-provider holdings, while manual holdings do not
participate. If any live holding has no valid timestamp, the hero says `Live investment prices not
fetched`; a portfolio containing only manual holdings shows no price caption. This caption describes
the investment part of the total only. Liquid balances and historical snapshot points have separate
provenance contracts.

Code links: [[apps/frontend/src/features/portfolio/PriceFreshnessCaption.tsx]], [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]], [[apps/frontend/src/utils/priceStaleness.ts]]

> [!note] 2026-06-19 — chart simplified to the shared responsive pattern
> The bespoke zoom/scroll net-worth chart (18 discrete `DAY_WIDTH_OPTIONS` zoom levels, scroll-driven visible-domain recomputation, per-series LTTB downsample capped at 400 points, single-series toggle, right-hand Y-axis) was **removed**. It is replaced by the same `ChartCard` + `ChartPeriodSelector` + `AreaChart` chrome the Performance page uses: a 1M/3M/6M/1Y/3Y/All segmented selector (client-side window filter — the endpoint already returns the full series), all three series drawn at once (Total filled, Liquid/Investments as lines) with a `ChartLegend`, left Y-axis, and pointer-drag scrubbing. Removing LTTB makes the chart "as granular as possible" — every daily snapshot is a scrub stop. `useNetWorthChartScroll.ts` and the zoom/domain/tick helpers in `netWorthChartUtils.ts` were deleted; the shared window logic now lives in `apps/frontend/src/components/charts/chartPeriods.ts` (`filterByPeriod`).

## Data Model

### Response Shape

```typescript
interface NetWorthResponse {
  current: {
    liquid: number; // Current bank balances
    liabilities: number; // Current liability-account balances
    investments: number; // Current portfolio value (all asset classes)
    netWorth: number; // liquid + liabilities + investments
  };
  monthlyChange: number;
  monthlyChangePercent: number;
  snapshots: Array<{
    date: string; // YYYY-MM-DD
    liquid: number;
    liabilities: number;
    investments: number;
    netWorth: number;
  }>;
}
```

### Backend Computation

The net worth is computed by `infoRepositoryNetWorth.getNetWorthFromSnapshots(targetCurrency, { liveInvestments })` in the backend, which combines:

- **Investments**: Pre-computed daily portfolio values from `portfolio_performance_snapshots` (includes unit-based assets: stocks, ETFs, crypto, metals, AND non-unit assets: real estate, savings, bonds). The snapshot builder mirrors `portfolioSummaryService` formulas exactly — see valuation formulas below. The **latest snapshot row's** `investments` value is then overlaid with the live summary total at read time (see "Live overlay" below).
- **Liquid and liabilities**: Daily per-currency account balances derived with the shared statement-anchor-plus-delta rule, with a cumulative transaction-flow fallback when rows are unattributed

Both the liquid history and current point apply the effective-date boundary from
[[docs/adr/123-effective-date-current-balances|ADR-123]]. Future ledger rows neither leak backward
into history nor change today's liquid value; they enter the cash-flow forecast instead.
An in-net-worth account with no active balance partitions contributes no current-point override,
so it cannot erase a transaction-flow fallback derived from unattributed ledger rows.

The history span starts only from an active transaction that its answering path can value, or from
an investment snapshot ([[docs/adr/124-net-worth-active-source-span|ADR-124]]). Inactive-only
ledgers therefore return an empty snapshot series instead of a run of zero-value days measured out
by archived activity.

Key architectural property: historical days are **snapshot-backed** (no network calls for past data). The _current_ point is overlaid live (see below).

The endpoint uses a sophisticated caching strategy with **inflight request coalescing** to prevent duplicate computations:

```javascript
// 5-minute TTL cache with inflight deduplication
const data = await resolveCacheWithInflight(netWorthResponseCache, cacheKey, {
  ttlMs: NET_WORTH_CACHE_TTL_MS,
  requireData: true,
  keepPreviousData: true,
  loader: async () => {
    const liveInvestments = await resolveLivePortfolioValue(targetCurrency);
    return infoRepositoryNetWorth.getNetWorthFromSnapshots(targetCurrency, {
      liveInvestments,
    });
  },
});
```

#### Live overlay for the current point (2026-05-31, ADR-064)

`computeAndStoreSnapshots()` runs only at startup warmup. After the hourly `refreshActiveHoldingQuotes` mutates `investments.current_price`, the stored snapshots do not change — but Dashboard and Performance recompute from the live service immediately. Before this fix, Net Worth froze at the boot-time price.

The fix mirrors the pattern already used by the Performance route (`_performanceHelpers.js:84-95`): a new shared helper `resolveLivePortfolioValue(targetCurrency)` (in [[apps/node-backend/src/routes/info/_liveSummary.js]]) reads `portfolioSummaryService.getPortfolioSummary().totals.totalPortfolioValue` from the shared 60-second `portfolioSummaryCache`. The repository overlays this value onto the latest snapshot row before computing `current` and `monthlyChange`. Historical rows are untouched.

Staleness budget: the overlay is baked into the 5-minute net-worth cache; the live value refreshes ~hourly. Net Worth therefore tracks Dashboard within ≤5 min vs. the previous "frozen since startup" behaviour.

If `resolveLivePortfolioValue` errors, it returns `undefined` and the repository falls back to the stored snapshot value, so Net Worth still responds rather than failing.

> [!info] Known limitation — historical unit-split days
> The live overlay reconciles only the latest point. For holdings with a stock split in their history, the _historical_ chart days prior to the split may still show an inflated cost basis. This secondary issue is tracked in `TODO.md` and requires a separate `snapshotBuilder` change to propagate split-adjusted prices into `asset_price_history`.

#### Daily-granularity price history (2026-05-31, ADR-065)

The historical price series that feeds snapshot computation is now kept dense at daily granularity by a recurring gap-fill job. This ensures Net Worth and Portfolio Performance charts render at daily resolution across the full holding window, including multi-year positions.

**What was wrong before:** Three compounding issues produced ~biweekly chart granularity:

1. Binance history was capped at 365 days, silently discarding all older crypto data.
2. `needsHistoryRefresh` only checked that the stored series _spanned_ the window endpoints — interior gaps were invisible to it, so sparse-but-endpoint-spanning series were never re-fetched.
3. Full backfill (`backfillHistoricalAssetQuotes`) ran only at startup; no job healed gaps introduced by partial provider responses, outages, or the 365-day cap.

**How it is fixed:**

- Binance paginates with `startTime`/`endTime`/`limit=1000` across the full holding window (30-page guard).
- `fetchHistoricalPrices` accepts a `force=true` option that bypasses the `needsHistoryRefresh` short-circuit.
- A daily `setInterval` in `warmup.js` calls `backfillHoldingGaps()` from `quoteBackfillService`, which uses `holdingWindowsNeedBackfill` (gap threshold: 9 days) to detect interior holes across all holding windows (including closed positions) and re-fetches with `force=true`.
- When `backfillHoldingGaps` writes new rows (`filled > 0`), it calls `computeAndStoreSnapshots()` so the Net Worth chart reflects the denser history in the same daily job cycle.
- A one-time `bun run quotes:densify` script (see [[docs/reference/scripts|Scripts Reference]]) heals existing sparse deployments without requiring a restart.

**Frontend downsampling removed (2026-06-19)**: The net-worth chart no longer applies LTTB (or any
downsample) — it renders the full daily series. The dense daily backfill described here therefore
flows straight through to the chart at full resolution, and every day is a scrub stop. The former
LTTB helper and its shared-package copy were removed after their last caller disappeared.

See [[docs/adr/065-daily-gap-fill-dense-asset-history|ADR-065]] for the full decision record including the Kinesis `timeFrame` unit ambiguity caveat.

### Non-Unit Asset Valuation Formulas (2026-05-18, ADR-061)

`portfolio_performance_snapshots` previously valued savings, bonds, and real estate using raw `investments.current_price`, ignoring accrued interest and appreciation transactions. This caused a divergence between Net Worth "Investments" and Portfolio Overview / Performance "Portfolio Value". The snapshot builder now uses the same formulas as `portfolioSummaryService`:

**Fixed-income (savings, bond):**

```
value = runningInvested + accruedInterest

accruedInterest = runningInvested × (interestRate / 100 / 365)
                  × calendarDaysBetween(startDate, day)

startDate = date of most recent `interest` transaction
            OR date of first `buy` transaction if no interest payments yet
```

An `interest` transaction resets the accrual clock to that date (matching how a real interest payment zeroes the owed amount). `calendarDaysBetween` uses `APP_TIMEZONE` per ADR-009.

**Real estate:**

```
value = runningInvested + cumulativeAppreciation

runningInvested     = sum of `buy` transaction amounts (converted to target currency)
                      minus `sell` amounts
cumulativeAppreciation = sum of `appreciation` transaction amounts
```

**Legacy fallback:** If an investment has no buy transactions but has `current_price` set and the current day is on or after `active_from`, the snapshot uses `current_price` (converted). This preserves display for manually-entered investments without seed transactions.

**Unit-based assets (stock, etf, crypto, metals) — latest day only:**
On the most recent snapshot day, `investments.current_price` is used directly instead of `asset_price_history` forward-fill. Historical days are unchanged. This guarantees the latest snapshot reconciles with the live summary even when `asset_price_history` lags behind a price refresh.

> [!warning] Historical chart redraw
> When `computeAndStoreSnapshots` runs after this change, historical net-worth values for fixed-income and real-estate days shift (typically upward as accrued interest and appreciation are now layered in). Users will see the Net Worth chart redraw on the next page refresh. This is expected and correct behavior.

> [!info] Three-page parity (formula + freshness)
> Dashboard "Total Value", Performance "Portfolio Value", and Net Worth "Investments" now show the same value for the current day — derived from the same underlying formulas (ADR-061) **and** sourced from the same live `portfolioSummaryService` result (ADR-064). Parity is maintained across hourly price refreshes, not just at snapshot compute time. Historical days remain snapshot-backed (correct — history must not swing with today's live price). See [[docs/adr/064-net-worth-current-value-live-overlay|ADR-064]].

Implementation notes:

- Route-level cache behavior in `info` routes is centralized through shared helpers (`getFreshCachedData`, `setCachedData`, `setInflightCache`, `resolveCacheWithInflight`) and reused by both `GET /api/info/net-worth` and `GET /api/info/portfolio-performance`, preserving TTL and concurrent-request deduplication behavior while reducing duplicate logic ([[apps/node-backend/src/routes/info.js]]).
- The live-overlay helper `resolveLivePortfolioValue` (and the broader `resolveLiveSummary`) live in [[apps/node-backend/src/routes/info/_liveSummary.js]] so they can be imported by both `netWorth.js` and the warmup pre-warm path in `info.js` without circular dependencies.
- `GET /api/info/category-breakdown` uses a dedicated repository path (`getCategoryBreakdown`) instead of full `getStatistics`, and hot-path info route imports (exchange-rates + portfolio-performance snapshot service) are module-scoped to remove repeated dynamic import overhead without changing API responses ([[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/repositories/infoRepositoryNetWorth.js]]).
- Info-route response caches opportunistically prune expired entries and enforce a bounded maximum entry count to prevent long-lived unbounded memory growth while keeping inflight dedupe semantics intact ([[apps/node-backend/src/routes/info.js]]).

## Chart Architecture

### Series & Period

All three series render simultaneously (`NetWorthChart.tsx`):

- **Total** (`netWorth`): solid primary line with a gradient area fill — the headline series.
- **Liquid** (`liquid`): line only (`fillOpacity: 0`), `--chart-2`.
- **Investments** (`investments`): line only (`fillOpacity: 0`), `--chart-4`.

A `ChartLegend` below the chart names the three. The window is scoped by a shared
`ChartPeriodSelector` (1M/3M/6M/1Y/3Y/All); the net-worth endpoint returns the full series, so
the period is applied **client-side** via `filterByPeriod` (anchored to the latest data point, not
wall-clock today). The X-axis tick format adapts to the window (day+month for ≤6M, month+year
otherwise).

### Full daily resolution (no downsampling)

The chart consumes every daily snapshot in the selected window directly — there is **no LTTB or
any other downsample**. visx renders multi-thousand-point paths as a single SVG path without
trouble, and keeping every point means the drag-to-compare scrub lands on every day. This mirrors
the deliberate "no LTTB" decision the Performance route already made server-side
([[docs/features/portfolio|Portfolio Performance]]).

### Y-axis domain

The Y-axis domain is computed by the shared `AreaChart` primitive (min/max across the visible
series with 8% padding, `nice: true` ticks). The chart no longer maintains its own scroll-driven
domain recomputation — the visible window is whatever the period selector scopes.

## UI Components

### Summary Cards

The summary uses a two-column desktop composition. The left side is an
intrinsic-height **Net Worth** hero with the current total and monthly change.
The right side is a vertical component breakdown:

1. **Liquid**: Current non-liability bank balances with percentage of net worth
2. **Investments**: Current portfolio value with percentage of net worth
3. **Liabilities**: Current liability-account balance with percentage of net worth; hidden when zero

The hero is not stretched to match the component stack. On smaller viewports,
the hero and breakdown stack in reading order.

### Chart Controls

- **Period selector**: 1M/3M/6M/1Y/3Y/All segmented control (`ChartPeriodSelector`) in the card
  header, scoping the visible window. All three series are always shown (no per-series toggle).

### Statistics Row

Three additional cards below the chart:

- **Peak Net Worth**: Highest net worth within the **currently selected chart period** (derived from `displaySnapshots`, the period-scoped snapshot window)
- **Lowest Point**: Lowest net worth within the **currently selected chart period**
- **Days Tracked**: Number of daily snapshots in the **currently selected chart period**

These cards follow the period selector (1M/3M/6M/1Y/3Y/All) so the figures reflect the same
date window as the chart. The **"ALL TIME" change badge** in the page header is unaffected -- it
always compares the first and last snapshot in the full series.

Implementation note: When a brand-new user has no historical snapshots (or all data is filtered
out by the period), the peak and trough calculations are seeded with `current.netWorth` instead
of `±Infinity` to avoid displaying "€-∞" and "€∞" in the cards.

### Daily Breakdown Table

A `VirtualDataTable` showing daily snapshots in reverse chronological order:

- Columns: Date, Liquid, Investments, Net Worth, Change
- Change column shows day-over-day difference with color coding

### Browser print layout

Printing `/portfolio/net-worth` produces a report view of the visible net-worth page. Application
chrome and interactive header actions are hidden, glass materials become light paper surfaces, and
cards, tables, and charts avoid internal page breaks where possible. The print rules are scoped to
this route and do not affect the normal screen layout.

## Performance Optimizations

1. **No object spread in loops**: Snapshot normalization avoids spread for large arrays
2. **Memoized formatters**: Currency and date formatters are memoized to avoid recreation
3. **Client-side period window**: `filterByPeriod` narrows the rendered array for short windows; the full series is fetched once and cached (React Query, 120s `staleTime`)
4. **Single SVG path per series**: full daily resolution renders as one `LinePath`/`AreaClosed` per series — no per-point DOM nodes
5. **Memoized series/legend**: chart series and legend descriptors are memoized on `t`

## Retired Per-Account Net-Worth Path (2026-08-10, ADR-108)

ADR-108 and WP-C1 removed the experimental per-account net-worth path. The build flag, per-account
grid and chart, frontend hook, endpoint, and the snapshot `splitByAccount` / `value_by_account`
payloads no longer exist. Net Worth remains an aggregate historical series backed by
`portfolio_performance_snapshots`.

Migration 0074's `portfolio_snapshot_accounts` table is intentionally dormant and remains covered
by the backup manifest. It is not populated or read by the application. The still-open WP-C7 owns
any future forward-only per-broker history; the dormant table is not evidence that such history is
currently implemented.

## Related Features

- [[docs/features/portfolio|Portfolio]] — Investment-specific performance tracking and per-account holdings
- [[docs/features/exchange-rates|Exchange Rates]] — Currency normalization for multi-currency portfolios
- [[docs/adr/108-portfolio-accounts-v2-broker-tags|ADR-108]] — Retires the per-account net-worth path and keeps portfolio account tags
- [[docs/adr/100-net-worth-account-native-holdings|ADR-100]] — Historical per-account design, superseded by ADR-108
- [[docs/adr/093-net-worth-sum-of-accounts|ADR-093]] — Net worth = Σ accounts definition
