---
title: Net Worth Feature
type: feature
status: active
date: 2026-06-18
updated: 2026-06-18
tags: [feature, net-worth, portfolio, chart, zoom, frontend, performance, snapshots, fixed-income, valuation-parity, accrued-interest, appreciation, live-overlay, valuation-freshness, daily-granularity, gap-fill, price-history, per-account, adr-093, adr-100]
description: Daily net worth tracking with zoomable/scrollable charts, series toggling, LTTB downsampling, and daily breakdown tables. Powered by pre-computed snapshots whose non-unit asset valuation mirrors live portfolio summary formulas (ADR-061); the latest point is overlaid with the live summary at read time so the headline stays in sync across hourly price refreshes (ADR-064). Historical price series are kept dense at daily granularity via a daily gap-detecting backfill. Per-account breakdown table (ADR-093/ADR-100) shows cash + holdings + total per in_net_worth account.
aliases: [net worth, networth, wealth tracking, financial health]
related_code:
  - apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx
  - apps/frontend/src/utils/downsample.ts
  - apps/node-backend/src/routes/info.js
  - apps/node-backend/src/routes/info/netWorth.js
  - apps/node-backend/src/routes/info/_liveSummary.js
  - apps/node-backend/src/repositories/infoRepositoryNetWorth.js
  - apps/node-backend/src/services/portfolioPerformanceSnapshotService.js
  - apps/node-backend/src/services/portfolio/snapshotBuilder.js
---

# Net Worth Feature

## Overview

The Net Worth page (`/portfolio/net-worth`) tracks daily net worth by combining liquid assets (bank balances) and investment values (including fixed-income: real estate, savings, bonds). It features a highly optimized, zoomable/scrollable area chart with series toggling, LTTB downsampling for performance, and a daily breakdown table.

## Data Model

### Response Shape

```typescript
interface NetWorthResponse {
  current: {
    liquid: number;      // Current bank balances
    investments: number; // Current portfolio value (all asset classes)
    netWorth: number;    // liquid + investments
  };
  monthlyChange: number;
  monthlyChangePercent: number;
  snapshots: Array<{
    date: string;        // YYYY-MM-DD
    liquid: number;
    investments: number;
    netWorth: number;
  }>;
}
```

### Backend Computation

The net worth is computed by `infoRepositoryNetWorth.getNetWorthFromSnapshots(targetCurrency, { liveInvestments })` in the backend, which combines:
- **Investments**: Pre-computed daily portfolio values from `portfolio_performance_snapshots` (includes unit-based assets: stocks, ETFs, crypto, metals, AND non-unit assets: real estate, savings, bonds). The snapshot builder mirrors `portfolioSummaryService` formulas exactly — see valuation formulas below. The **latest snapshot row's** `investments` value is then overlaid with the live summary total at read time (see "Live overlay" below).
- **Liquid**: Daily bank account balances derived from the transactions table (latest balance per account per day via lateral join, with fallback to cumulative transaction flow)

Key architectural property: historical days are **snapshot-backed** (no network calls for past data). The *current* point is overlaid live (see below).

The endpoint uses a sophisticated caching strategy with **inflight request coalescing** to prevent duplicate computations:

```javascript
// 5-minute TTL cache with inflight deduplication
const data = await resolveCacheWithInflight(netWorthResponseCache, cacheKey, {
  ttlMs: NET_WORTH_CACHE_TTL_MS,
  requireData: true,
  keepPreviousData: true,
  loader: async () => {
    const liveInvestments = await resolveLivePortfolioValue(targetCurrency);
    return infoRepositoryNetWorth.getNetWorthFromSnapshots(targetCurrency, { liveInvestments });
  },
});
```

#### Live overlay for the current point (2026-05-31, ADR-064)

`computeAndStoreSnapshots()` runs only at startup warmup. After the hourly `refreshActiveHoldingQuotes` mutates `investments.current_price`, the stored snapshots do not change — but Dashboard and Performance recompute from the live service immediately. Before this fix, Net Worth froze at the boot-time price.

The fix mirrors the pattern already used by the Performance route (`_performanceHelpers.js:84-95`): a new shared helper `resolveLivePortfolioValue(targetCurrency)` (in [[apps/node-backend/src/routes/info/_liveSummary.js]]) reads `portfolioSummaryService.getPortfolioSummary().totals.totalPortfolioValue` from the shared 60-second `portfolioSummaryCache`. The repository overlays this value onto the latest snapshot row before computing `current` and `monthlyChange`. Historical rows are untouched.

Staleness budget: the overlay is baked into the 5-minute net-worth cache; the live value refreshes ~hourly. Net Worth therefore tracks Dashboard within ≤5 min vs. the previous "frozen since startup" behaviour.

If `resolveLivePortfolioValue` errors, it returns `undefined` and the repository falls back to the stored snapshot value, so Net Worth still responds rather than failing.

> [!info] Known limitation — historical unit-split days
> The live overlay reconciles only the latest point. For holdings with a stock split in their history, the *historical* chart days prior to the split may still show an inflated cost basis. This secondary issue is tracked in `TODO.md` and requires a separate `snapshotBuilder` change to propagate split-adjusted prices into `asset_price_history`.

#### Daily-granularity price history (2026-05-31, ADR-065)

The historical price series that feeds snapshot computation is now kept dense at daily granularity by a recurring gap-fill job. This ensures Net Worth and Portfolio Performance charts render at daily resolution across the full holding window, including multi-year positions.

**What was wrong before:** Three compounding issues produced ~biweekly chart granularity:
1. Binance history was capped at 365 days, silently discarding all older crypto data.
2. `needsHistoryRefresh` only checked that the stored series *spanned* the window endpoints — interior gaps were invisible to it, so sparse-but-endpoint-spanning series were never re-fetched.
3. Full backfill (`backfillHistoricalAssetQuotes`) ran only at startup; no job healed gaps introduced by partial provider responses, outages, or the 365-day cap.

**How it is fixed:**
- Binance paginates with `startTime`/`endTime`/`limit=1000` across the full holding window (30-page guard).
- `fetchHistoricalPrices` accepts a `force=true` option that bypasses the `needsHistoryRefresh` short-circuit.
- A daily `setInterval` in `warmup.js` calls `backfillHoldingGaps()` from `quoteBackfillService`, which uses `holdingWindowsNeedBackfill` (gap threshold: 9 days) to detect interior holes across all holding windows (including closed positions) and re-fetches with `force=true`.
- When `backfillHoldingGaps` writes new rows (`filled > 0`), it calls `computeAndStoreSnapshots()` so the Net Worth chart reflects the denser history in the same daily job cycle.
- A one-time `bun run quotes:densify` script (see [[docs/reference/scripts|Scripts Reference]]) heals existing sparse deployments without requiring a restart.

**LTTB downsampling is unchanged**: The 400-point hard cap on LTTB applied in the frontend is unaffected. For dense multi-year series the downsampler now receives daily-resolution input rather than biweekly-sparse input, producing better shape-preservation in the output. See [[docs/reference/algorithms#lttb-largest-triangle-three-buckets-downsampling|LTTB algorithm]].

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

### Series Toggling

Users can toggle between three series views:
- **Total** (`netWorth`): Solid line, primary color, full opacity fill
- **Investments** (`investments`): Dashed line, blue color, semi-transparent fill
- **Liquid** (`liquid`): Dashed line, accent color, semi-transparent fill

### Zoom System

The chart implements a multi-level zoom system with 18 discrete zoom levels:

```typescript
const DAY_WIDTH_OPTIONS = [20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1, 0.75, 0.5, 0.25, 0.15, 0.1, 0.05, 0.03];
```

- **Zoom in**: Increases pixels per day (wider view, fewer visible days)
- **Zoom out**: Decreases pixels per day (narrower view, more visible days)
- **Anchor preservation**: Before zooming, the current scroll position ratio is captured and restored after the zoom completes, preventing disorienting jumps

### Scroll-Based Domain Computation

The Y-axis domain is dynamically computed based on the currently visible viewport:

1. **Scroll tracking**: Listens to scroll events with `requestAnimationFrame` throttling
2. **Idle detection**: After 120ms of no scrolling, forces a domain recalculation
3. **Threshold gating**: Ignores scroll movements under 24px to avoid unnecessary re-renders
4. **Nice domain**: Uses a "nice step" algorithm to compute clean Y-axis tick values (1, 2, 5 × 10^n)

### LTTB Downsampling

When the number of data points exceeds the visible viewport capacity, the **Largest-Triangle-Three-Buckets** algorithm reduces the data while preserving visual shape:

```typescript
const maxPointsForZoom = Math.max(150, Math.min(500, Math.round(scrollWidth / dayWidth)));
const threshold = Math.min(maxPointsForZoom, 400);
if (snapshots.length <= threshold) return snapshots;
return downsampleLTTB(snapshots, threshold, (_item, i) => i, (item) => item[selectedSeries]);
```

- **Adaptive threshold**: Based on container width and current zoom level
- **Per-series**: Downsampling is applied to the currently selected series
- **Maximum 400 points**: Hard cap to ensure smooth rendering

## Y-Axis Domain Algorithms

### computeYDomain

Computes the raw domain across all visible points for all series:

```typescript
function computeYDomain(points, series = ['netWorth', 'liquid', 'investments']): [number, number]
```

- Scans all points for min/max across specified series
- Adds 3% padding (minimum 1 unit)
- Floors the lower bound and ceilings the upper bound

### computeNiceYDomain

Converts a raw domain to "nice" tick values:

```typescript
function computeNiceYDomain(domain: [number, number], tickCount = 7): [number, number]
```

Uses the `niceStep` algorithm which selects from {1, 2, 5} × 10^n to produce clean, human-readable axis labels.

### computeSeriesDomainForRange

Computes the domain for a specific series within a scroll range:

```typescript
function computeSeriesDomainForRange(points, series, startIndex, endIndex): [number, number]
```

Used during scrolling to compute the Y-axis domain for only the visible portion of the chart.

## UI Components

### Summary Cards

Three KPI cards at the top:
1. **Net Worth**: Current total with monthly change (+amount, +percentage)
2. **Liquid**: Current bank balances with percentage of net worth
3. **Investments**: Current portfolio value with percentage of net worth

### Chart Controls

- **Series buttons**: Toggle between Total/Investments/Liquid views
- **Zoom buttons**: Zoom in/out with anchor preservation
- **Latest button**: Scroll to the most recent data point (shown when not at latest)

### Statistics Row

Three additional cards below the chart:
- **Peak**: Highest net worth recorded (seeded with current net worth to prevent invalid display when snapshots are empty)
- **Lowest**: Lowest net worth recorded (seeded with current net worth to prevent invalid display when snapshots are empty)
- **Days Tracked**: Total number of daily snapshots

Implementation note: When a brand-new user has no historical snapshots (or all data is filtered out), the peak and trough calculations are seeded with `current.netWorth` instead of `±Infinity` to avoid displaying "€-∞" and "€∞" in the cards.

### Daily Breakdown Table

A `VirtualDataTable` showing daily snapshots in reverse chronological order:
- Columns: Date, Liquid, Investments, Net Worth, Change
- Change column shows day-over-day difference with color coding

## Performance Optimizations

1. **No object spread in loops**: Snapshot normalization avoids spread for large arrays
2. **Memoized formatters**: Currency and date formatters are memoized to avoid recreation
3. **rAF-throttled scroll handlers**: Scroll events are batched via `requestAnimationFrame`
4. **Scroll idle timer**: Forces domain recalculation after scrolling stops
5. **Range change detection**: Skips domain updates if the visible range hasn't changed
6. **LTTB downsampling**: Reduces thousands of points to hundreds for smooth rendering
7. **Animation disabled**: Recharts animations are disabled (`isAnimationActive={false}`)

## Per-Account Net-Worth Breakdown (2026-06-18, ADR-093 / ADR-100)

`NetWorthPage` now includes a **"By Account"** table below the main chart. Each row shows one
`in_net_worth=true` account's:

| Column | Source |
|--------|--------|
| Cash | Computed ledger balance (ADR-094 reconciliation) |
| Holdings | `byAccount[account_id].currentValue` from `getPortfolioSummary` |
| Total | Cash + Holdings |

Unassigned lots (`account_id: null`) are surfaced as a single "Unassigned" row.

Frontend hook: `apps/frontend/src/hooks/portfolio/useAccountNetWorth.ts` — fetches accounts, the
per-account cash balances, and the `byAccount` array from the portfolio summary in parallel and
merges them.

The historical time-series chart is unchanged — it remains a single-aggregate series. Per-account
historical series require per-account daily snapshots, which are not yet built. See
[[docs/adr/100-net-worth-account-native-holdings|ADR-100]] for the deliberate scoping of this.

## Related Features

- [[docs/features/portfolio|Portfolio]] — Investment-specific performance tracking and per-account holdings
- [[docs/features/exchange-rates|Exchange Rates]] — Currency normalization for multi-currency portfolios
- [[docs/adr/100-net-worth-account-native-holdings|ADR-100]] — Per-account holdings parity decision
- [[docs/adr/093-net-worth-sum-of-accounts|ADR-093]] — Net worth = Σ accounts definition
