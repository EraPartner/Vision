---
title: Net Worth Feature
type: feature
status: active
date: 2026-04-16
updated: 2026-05-18
tags: [feature, net-worth, portfolio, chart, zoom, frontend, performance, snapshots, fixed-income, valuation-parity, accrued-interest, appreciation]
description: Daily net worth tracking with zoomable/scrollable charts, series toggling, LTTB downsampling, and daily breakdown tables. Powered by pre-computed snapshots whose non-unit asset valuation now mirrors the live portfolio summary formulas exactly (ADR-061).
aliases: [net worth, networth, wealth tracking, financial health]
related_code:
  - apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx
  - apps/frontend/src/utils/downsample.ts
  - apps/node-backend/src/routes/info.js
  - apps/node-backend/src/repositories/infoRepository.js
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

The net worth is computed by `infoRepository.getNetWorthFromSnapshots(currency)` in the backend, which combines:
- **Investments**: Pre-computed daily portfolio values from `portfolio_performance_snapshots` (includes unit-based assets: stocks, ETFs, crypto, metals, AND non-unit assets: real estate, savings, bonds). The snapshot builder now mirrors `portfolioSummaryService` formulas exactly — see valuation formulas below.
- **Liquid**: Daily bank account balances derived from the transactions table (latest balance per account per day via lateral join, with fallback to cumulative transaction flow)

Key architectural change: **No network calls at request time.** All investment values come from `portfolio_performance_snapshots`, which is populated offline by `snapshotBuilder.computeDailySnapshots()` ([[apps/node-backend/src/services/portfolio/snapshotBuilder.js]]).

The endpoint uses a sophisticated caching strategy with **inflight request coalescing** to prevent duplicate computations:

```javascript
// 5-minute TTL cache with inflight deduplication
const data = await resolveCacheWithInflight(netWorthResponseCache, cacheKey, {
  ttlMs: NET_WORTH_CACHE_TTL_MS,
  requireData: true,
  keepPreviousData: true,
  loader: () => infoRepository.getNetWorthFromSnapshots(targetCurrency),
});
```

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

> [!info] Three-page parity
> Dashboard "Total Value", Performance "Portfolio Value", and Net Worth "Investments" now show the same value for the same day, all derived from the same underlying formulas.

Implementation notes:
- Route-level cache behavior in `info` routes is now centralized through shared helpers (`getFreshCachedData`, `setCachedData`, `setInflightCache`, `resolveCacheWithInflight`) and reused by both `GET /api/info/net-worth` and `GET /api/info/portfolio-performance`, preserving TTL and concurrent-request deduplication behavior while reducing duplicate logic ([[apps/node-backend/src/routes/info.js]]).
- `GET /api/info/category-breakdown` now uses a dedicated repository path (`getCategoryBreakdown`) instead of full `getStatistics`, and hot-path info route imports (exchange-rates + portfolio-performance snapshot service) are module-scoped to remove repeated dynamic import overhead without changing API responses ([[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/repositories/infoRepository.js]]).
- Info-route response caches now opportunistically prune expired entries and enforce a bounded maximum entry count to prevent long-lived unbounded memory growth while keeping inflight dedupe semantics intact ([[apps/node-backend/src/routes/info.js]]).

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

## Related Features

- [[docs/features/portfolio|Portfolio]] — Investment-specific performance tracking
- [[docs/features/exchange-rates|Exchange Rates]] — Currency normalization for multi-currency portfolios
- [[docs/features/portfolio|Portfolio]] — Overall portfolio management
