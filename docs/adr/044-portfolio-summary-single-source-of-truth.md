---
title: ADR-044 - Portfolio Summary Single Source of Truth
type: adr
status: accepted
date: 2026-04-29
tags: [adr, portfolio, api, caching, reconciliation, frontend-sync]
description: Realtime endpoint `/api/info/portfolio-summary` as single source of truth for dashboard + performance totals. Eliminates divergence from dual compute paths and different FX timing strategies.
related: [docs/features/portfolio, docs/api/info, docs/api/investments, docs/features/dashboard]
---

# ADR-044: Portfolio Summary as Single Source of Truth

## Status

**Accepted** — Implemented 2026-04-29.

## Date

2026-04-29

## Context

The Vision dashboard overview page and portfolio performance page display critical totals:
- Total portfolio value
- Total invested capital
- Total gain/loss
- Realized vs. unrealized splits
- Return percentage

Prior to this ADR, two separate computation paths produced these values:

**Dashboard (client-side):**
- Requested per-investment summaries from `/api/investments` endpoint
- Frontend loop: recomputed portfolio totals client-side via FX conversion at request time
- Currency conversion applied in browser using current exchange rates
- **Characteristic**: FX timing = request time

**Performance Page (server-side):**
- Used pre-computed daily snapshots from `portfolio_performance_snapshots` table (computed during startup and on schedule)
- Returned historical FX rates embedded in snapshots
- **Characteristic**: FX timing = snapshot creation time (potentially days stale)

**The Problem:**

1. **Divergent FX rates**: Dashboard FX conversion happens at user request time; performance page uses historical rates from last snapshot compute. If exchange rates moved between snapshot time and dashboard render, user saw different total values on the same day.

2. **Divergent compute logic**: Two separate calculation paths meant two opportunities for rounding drift, precision loss, or incorrect component aggregation. Dashboard totals ≠ performance metrics totals by design.

3. **User confusion**: Dashboard headline "Total: EUR 100,000" but performance page headline "Total: EUR 99,999.50" — same moment, different values.

4. **No single source of truth**: Both paths considered "correct" but produced different results. When users questioned the value, there was no authoritative number to point to.

## Decision

Introduce `GET /api/info/portfolio-summary?currency=EUR` as the **single source of truth** for all portfolio total metrics:

1. **New realtime endpoint** computes totals server-side with currency conversion applied pre-serialization
2. **Both dashboard and performance page** now consume this endpoint for headline metrics
3. **Same computation path** = same totals by construction
4. **Consistent FX timing** = conversion applied at endpoint call time for both surfaces
5. **Cache strategy** = 60-second in-memory TTL with invalidation on any investment/transaction write

### New Service: portfolioSummaryService

**Location:** `apps/node-backend/src/services/portfolio/portfolioSummaryService.js`

**Exports:**

```javascript
/**
 * Compute realtime portfolio totals for a target currency.
 * Single source of truth: called by dashboard and performance page.
 * @param {string} targetCurrency - Target 3-letter currency code (default: EUR)
 * @returns {Promise<object>}
 *   {
 *     currency: 'EUR',
 *     computed_at: '2026-04-29T12:34:56.000Z',
 *     totals: {
 *       currentValue: 125000.00,
 *       totalInvested: 100000.00,
 *       totalGainLoss: 25000.00,
 *       realized: 5000.00,
 *       unrealized: 20000.00,
 *       fees: 0.00,
 *       taxes: 0.00,
 *       income: 0.00,
 *       totalReturnPct: 25.0
 *     },
 *     summaries: [
 *       { asset_class: 'stock', currentValue: 80000, invested: 60000, ... },
 *       { asset_class: 'crypto', currentValue: 45000, invested: 40000, ... }
 *     ]
 *   }
 */
export async function getPortfolioSummary(targetCurrency = 'EUR') {
  // Implementation: Fetch all investments with prices, compute totals, convert to target currency
  // Invariant: sum(summaries[].currentValue) === totals.currentValue
  // Invariant: sum(summaries[].invested) === totals.invested
}

/**
 * Backward-compatible wrapper for legacy code.
 * Now delegates to getPortfolioSummary().
 * @deprecated Use getPortfolioSummary() directly
 */
export async function getBreakdownSummary(targetCurrency = 'EUR') {
  const summary = await getPortfolioSummary(targetCurrency);
  return summary.summaries;
}
```

### New Route: portfolioSummary.js

**Location:** `apps/node-backend/src/routes/info/portfolioSummary.js`

**Endpoint:** `GET /api/info/portfolio-summary`

**Query Parameters:**
- `currency` (optional, default: EUR) — 3-letter currency code

**Rate Limit:** 60 req/min (higher than performance/net-worth due to frequent dashboard renders)

**Cache:** 60-second in-memory TTL with `resolveCacheWithInflight` pattern (prevents cache stampede on cold start)

**Response:** `200 OK` with portfolio summary object (see schema below)

### Cache Invalidation

**Trigger:** Any investment or transaction write clears the summary cache:
- `POST /api/investments` → invalidate
- `PATCH /api/investments/:id` → invalidate
- `DELETE /api/investments/:id` → invalidate
- `POST /api/investments/:id/transactions` → invalidate
- `PATCH /api/investments/transactions/:txnId` → invalidate
- `DELETE /api/investments/transactions/:txnId` → invalidate
- `POST /api/transactions` → invalidate
- `PATCH /api/transactions/:id` → invalidate
- `DELETE /api/transactions/:id` → invalidate

**Implementation:** `invalidatePortfolioCaches()` helper in `_cache.js` clears summary + performance + net-worth caches atomically.

### Performance Page Integration

The performance page no longer recomputes totals. Instead:
1. Fetch `/api/info/portfolio-performance` for snapshot timeseries and annualized metrics
2. Override the `currentValue`, `totalInvested`, `totalGainLoss`, and `totalReturnPct` fields with realtime values from `/api/info/portfolio-summary`
3. Keep `annualizedReturn`, `realReturnPct`, `cumulativeInflation` from snapshots (these are snapshot-only, not realtime)

**Reconciliation invariant** (verified by test):
```javascript
// Before overrides:
snapshot.breakdownSummary = [{ currentValue: X }, { currentValue: Y }, ...]
// Overridden totals:
snapshot.totals.currentValue === sum(breakdownSummary[].currentValue)
```

### Dashboard Integration

Dashboard headline cards now source from `/api/info/portfolio-summary`:

```typescript
// Frontend hook
const { data } = usePortfolioSummaryQuery(targetCurrency);
// Renders dashboard.totalValue = data.totals.currentValue
// (Previously computed client-side via FX loop)
```

## Consequences

### Positive

1. **Single source of truth**: Dashboard and performance page guaranteed to show same totals (same data source, same compute)
2. **Consistent FX timing**: All conversions apply at request time, eliminating stale-rate divergence
3. **Simpler front-end**: Dashboard no longer needs client-side FX computation; just reads `.totals`
4. **Testable invariant**: `sum(summaries) === totals` verified in unit tests and property tests
5. **Cache strategy**: 60s TTL balances freshness (new prices every minute) with low latency (cache hit for 99% of dashboard renders)

### Tradeoffs

1. **New endpoint**: Adds one more HTTP call during dashboard/performance page load (but dashboard already loads multiple detail endpoints, so impact is minimal)
2. **Cache TTL**: Totals may lag live prices by up to 60 seconds; acceptable for user-facing dashboards (volatility and price refresh intervals are on 5-minute+ timescales)
3. **Snapshot-timeseries loss**: Performance page no longer shows snapshot-era totals in the heatmap. Instead, it uses current totals + snapshot-era allocation percentages. Acceptable because the goal is to show recent performance, not historical portfolio value (which would require storing totals at each snapshot).

## Rejected Alternatives

### 1. Snapshot-Only Approach (Always Historical)

Keep dashboard totals synchronized with performance page by using historical snapshots everywhere.

**Rationale for rejection:**
- Dashboard would always lag (show yesterday's value) ✗
- Poor UX: investor updates portfolio, dashboard still shows stale value for 24+ hours ✗
- Defeats the purpose of realtime price refresh ✗

### 2. Backend FX Mirror (No Cache)

Compute totals server-side but don't cache (recompute on every request).

**Rationale for rejection:**
- 4 FX conversions × ~50 assets per request = high latency ✗
- Materialized view + cache strategy is more efficient ✗
- Dashboard renders dozens of times; cache is necessary for performance ✗

## Reference Schema

### GET /api/info/portfolio-summary Response

```json
{
  "currency": "EUR",
  "computed_at": "2026-04-29T12:34:56.000Z",
  "totals": {
    "currentValue": 125000.00,
    "totalInvested": 100000.00,
    "totalGainLoss": 25000.00,
    "realized": 5000.00,
    "unrealized": 20000.00,
    "fees": 0.00,
    "taxes": 0.00,
    "income": 0.00,
    "totalReturnPct": 25.0
  },
  "summaries": [
    {
      "asset_class": "stock",
      "currentValue": 80000.00,
      "invested": 60000.00,
      "gainLoss": 20000.00,
      "realized": 3000.00,
      "unrealized": 17000.00,
      "fees": 0.00,
      "taxes": 0.00,
      "income": 0.00,
      "returnPct": 33.33,
      "count": 5
    },
    {
      "asset_class": "crypto",
      "currentValue": 45000.00,
      "invested": 40000.00,
      "gainLoss": 5000.00,
      "realized": 2000.00,
      "unrealized": 3000.00,
      "fees": 0.00,
      "taxes": 0.00,
      "income": 0.00,
      "returnPct": 12.50,
      "count": 3
    }
  ]
}
```

## Related Documents

- [[docs/features/portfolio|Portfolio & Investments Feature]]
- [[docs/api/info|Info & Analytics API]]
- [[docs/api/investments|Investments API]]
- [[docs/reference/code-patterns#portfolio-totals-pattern|Portfolio Totals Pattern (Code)]]
- [[docs/adr/008-performance-page-server-computed-response|ADR-008: Performance Page Server-Computed Response]]

## Implementation Checklist

- [x] Service layer: `portfolioSummaryService.js`
- [x] Route layer: `routes/info/portfolioSummary.js`
- [x] Cache helpers: `routes/info/_cache.js` with TTL and invalidation
- [x] Performance page override: use realtime totals in payload
- [x] Dashboard integration: `usePortfolioSummaryQuery` hook
- [x] Unit tests: 11 tests (empty, single-currency, FX, mixed-currency, math, reconciliation, parity)
- [x] Frontend types: `PortfolioSummaryTotals`, `PortfolioSummaryItem`, `PortfolioSummaryResponse`
- [x] API endpoint matrix update
