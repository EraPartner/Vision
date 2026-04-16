---
title: ADR-008 - Performance Page Server-Computed Response
type: adr
status: Accepted
date: 2026-04-16
tags: [adr, performance, backend, frontend, optimization, api-design]
description: Move performance computations from frontend to backend, fix contribution-adjusted heatmap formula
aliases: [adr-008, performance-response, server-computed-performance]
---

# ADR-008: Performance Page Server-Computed Response

## Status
Accepted

## Date
2026-04-16

## Context

The Portfolio Performance page previously computed all metrics, heatmaps, and breakdowns on the client:

1. **Client-side computation overhead**: Frontend fetched 1000+ snapshots and performed 6 heavy useMemo chains to compute metrics, heatmap, and per-investment breakdown
2. **Request waterfall**: Page made 4 sequential API calls (snapshots → portfolio → exchange rates → inflation rates), blocking chart render
3. **Heatmap formula bug**: Monthly return formula conflated cash deposits/withdrawals with investment performance. Old formula used net value change without adjusting for contribution size: `monthlyReturn = (currValue - prevValue - netFlow) / prevValue`
4. **Payload inefficiency**: Client received full historical snapshot dataset (1000+ rows) even when viewing filtered periods (1m/3m/6m/1y/3y)
5. **Breakdown computation waste**: Per-investment summary required client-side currency conversion, asset iteration, and cost-basis calculation

## Decision

Move all performance computations to the backend and refactor the API response:

### Backend (`/api/info/portfolio-performance`)

**New Response Structure:**
```json
{
  "currency": "EUR",
  "start_date": "2000-01-01",
  "end_date": "2026-04-16",
  "snapshots": [...downsampled to ~400 points...],
  "metrics": {
    "currentValue": 52500.00,
    "totalInvested": 50000.00,
    "totalGainLoss": 2500.00,
    "totalReturnPct": 5.0,
    "annualizedReturn": 3.8,
    "realReturnPct": 2.1,
    "cumulativeInflation": 0.035
  },
  "heatmap": {
    "years": [2025, 2026],
    "data": { "2025": { "01": 1.5, "02": 2.1 }, "2026": { "01": 3.2 } },
    "maxAbsPct": 3.2
  },
  "breakdownSummary": [
    {
      "id": 1,
      "name": "Apple Inc.",
      "symbol": "AAPL",
      "assetClass": "stock",
      "currency": "USD",
      "currentValue": 15000.00,
      "totalInvested": 12000.00,
      "gainLoss": 3000.00,
      "gainLossPercent": 25.0
    }
  ]
}
```

**New Query Parameter:**
- `period`: `1m|3m|6m|1y|3y|all` (default `all`) — filters snapshot data for charting while metrics/heatmap always use full history

**Backend Implementation:**
- New service: `portfolioPerformanceSnapshotService.js`
  - `computeMetrics(snapshots)` — aggregates overall portfolio metrics
  - `computeHeatmap(snapshots)` — computes monthly contribution-adjusted returns
  - `getBreakdownSummary(currency)` — queries investments + transactions, calculates weighted cost basis, converts to target currency
- New utility: `downsample.js` — LTTB downsampler ported from frontend to backend
- Period-filtered snapshots are downsampled to ~400 points before response
- Cache key now includes period: `${currency}:${period}`

**Heatmap Formula (Contribution-Adjusted):**
```
monthlyReturn = ((currValue / currInvested) / (prevValue / prevInvested) - 1) * 100
```

This formula divides each month's value by its invested capital, then compares the ratio to the prior month. This correctly isolates investment performance from the effect of new deposits or withdrawals.

**Example:**
- Month 1: `invested=100, value=105` → ratio = `1.05`
- Month 2: Invest additional `50`. Now: `invested=150, value=155` → ratio = `1.033` 
- Contribution-adjusted return = `(1.033 / 1.05 - 1) * 100 = -1.6%`
- This reflects that performance *declined* despite higher absolute value (the $50 deposit inflates value without investment gains)

### Frontend (`PerformancePage.tsx`)

**Eliminated:**
- 4 heavy useMemo blocks: `filteredSnapshots`, `downsampledSnapshots`, `overallMetrics`, `heatmapData`
- `usePortfolio()` hook (removed request waterfall)
- Exchange-rate query from `PerformanceBreakdown` component
- `convertToTarget()` helper (all values pre-converted by server)

**Retained:**
- 2 lightweight mapping transforms: `chartData`, `relativePerformanceData`
- `selectedPeriod` now in query key and API parameter
- Direct prop passing: `breakdownSummary` and `heatmapData` from API response

**Result:**
- Page load: 4 requests → 1 request
- Payload size (1-month view): 1000 snapshots → 30 snapshots + metrics + breakdown
- Time to interactive: significant reduction from removed waterfall and client computations

## Consequences

### Positive
- **Reduced client payload**: 30-40x smaller for filtered periods
- **Faster page load**: Single API call instead of waterfall; no 6-layer memo chains
- **Correct heatmap**: Contribution-adjusted formula prevents inflation from cash flows
- **Maintenance**: Metric computation centralized on backend; changes propagate instantly
- **Caching efficiency**: Per-period cache keys allow independent warming and invalidation
- **Offline-ready breakdown**: All values pre-converted eliminates client FX logic

### Negative
- **Server CPU for metrics**: Backend now computes metrics per API call (but cached for 5 minutes)
- **Fixed metric window**: Metrics always span full history (cannot be period-filtered); addressed by keeping separate cache keys
- **Response complexity**: Clients must handle 3 nested objects (snapshots, metrics, heatmap) instead of just snapshots

### Neutral
- **Relative performance chart**: Still computed client-side from snapshots (efficient, feature-specific logic)
- **Period parameter semantics**: Only affects snapshot data, not metrics/heatmap (explicit and documented)
- **Cache busting**: Portfolio transaction changes invalidate cache server-side via standard refresh

## Implementation Notes

- **Startup warmup**: `warmInfoCaches()` now warms the `all` period (full historical data) for instant first responses
- **Downsampling threshold**: 400 points balances visual fidelity with network payload
- **Heatmap null values**: First month is `null` (no prior anchor); subsequent months use contribution-adjusted formula
- **Inflation data**: Real return and inflation-adjusted value use backend Belgian monthly rates
- **Backward compatibility**: Response adds new fields; existing `snapshots` field behavior unchanged (just downsampled now)

## Related

- [[docs/features/portfolio|Feature: Portfolio & Investments]] — Performance page details
- [[docs/api/info|Info & Analytics API]] — `/api/info/portfolio-performance` endpoint docs
- [[docs/performance/chart-downsampling|Chart Data Downsampling]] — LTTB algorithm
- [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js|Portfolio Performance Service]]
- [[apps/node-backend/src/utils/downsample.js|Backend Downsampler]]
- [[apps/frontend/src/pages/portfolio/PerformancePage.tsx|Performance Page Component]]
