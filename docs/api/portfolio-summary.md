---
title: Portfolio Summary API
type: endpoint
status: active
date: 2026-04-29
updated: 2026-06-11
tags: [endpoint, api, portfolio, realtime, summary, totals, dashboard, performance, net-worth, live-overlay, fx-attribution, asset-gain, fx-gain, purchase-date-rates]
description: Realtime portfolio totals endpoint serving as single source of truth for dashboard, performance, and (from 2026-05-31) net-worth current-point metrics. Single computation path, consistent FX timing, 60s cache TTL. 2026-06-11 (ADR-074): flows convert at transaction-date FX; gainLoss = assetGain + fxGain; new per-investment assetGain/fxGain/nativeCurrentValue/usedFallbackRate fields; new totals totalAssetGain/totalFxGain/usedFallbackRate.
aliases: [portfolio-totals, portfolio-metrics, summary-api]
related_code: ["apps/node-backend/src/services/portfolio/portfolioSummaryService.js", "apps/node-backend/src/routes/info/portfolioSummary.js", "apps/node-backend/src/routes/info/_cache.js", "apps/node-backend/src/routes/info/_liveSummary.js", "apps/frontend/src/hooks/portfolio/usePortfolioSummary.ts", "apps/frontend/src/lib/api/info.ts"]
---

# Portfolio Summary API

> [!abstract] Overview
> Realtime endpoint computing portfolio totals (value, invested, gain/loss, returns) with FX conversion applied server-side. Single source of truth for dashboard overview cards, performance page headline metrics, and (from 2026-05-31) the Net Worth endpoint's *current* investments value. Eliminates divergence from dual compute paths and ensures consistent FX timing across all three UI surfaces.
>
> **2026-06-11 (ADR-074) — FX attribution semantics change.** `totalInvested` / `totalBuyCost` / `gainLoss` / `realizedGain` / `unrealizedGain` / `avgCostBasis` / fees / taxes / income are now converted at **transaction-date** FX rates (invested is locked at purchase-date rates; it no longer drifts with today's FX). `gainLoss` **includes** the FX component and equals `assetGain + fxGain`. New additive fields carry the decomposition.

## Endpoint Details

| Property | Value |
|----------|-------|
| **Path** | `/api/info/portfolio-summary` |
| **Method** | GET |
| **Authentication** | Session (required) |
| **Rate Limit** | 60 req/min |
| **Cache TTL** | 60 seconds (in-memory) |
| **Invalidation** | On any investment or transaction write |

## Request

### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `currency` | string | No | EUR | Target 3-letter currency code for FX conversion (e.g., `USD`, `GBP`, `CHF`) |

**Examples:**
- `/api/info/portfolio-summary` — Totals in EUR (default)
- `/api/info/portfolio-summary?currency=USD` — Totals in USD
- `/api/info/portfolio-summary?currency=GBP` — Totals in GBP

### Headers

```
Content-Type: application/json
```

## Response

### Success (200 OK)

```json
{
  "currency": "EUR",
  "computed_at": "2026-06-11T12:34:56.000Z",
  "totals": {
    "currentValue": 125000.00,
    "totalInvested": 100000.00,
    "totalGainLoss": 25000.00,
    "totalAssetGain": 22000.00,
    "totalFxGain": 3000.00,
    "realized": 5000.00,
    "unrealized": 20000.00,
    "fees": 0.00,
    "taxes": 0.00,
    "income": 0.00,
    "totalReturnPct": 25.0,
    "usedFallbackRate": false
  },
  "summaries": [
    {
      "asset_class": "stock",
      "currentValue": 80000.00,
      "invested": 60000.00,
      "gainLoss": 20000.00,
      "assetGain": 17500.00,
      "fxGain": 2500.00,
      "nativeCurrentValue": 87000.00,
      "realized": 3000.00,
      "unrealized": 17000.00,
      "fees": 0.00,
      "taxes": 0.00,
      "income": 0.00,
      "returnPct": 33.33,
      "count": 5,
      "usedFallbackRate": false
    },
    {
      "asset_class": "crypto",
      "currentValue": 45000.00,
      "invested": 40000.00,
      "gainLoss": 5000.00,
      "assetGain": 4500.00,
      "fxGain": 500.00,
      "nativeCurrentValue": 45000.00,
      "realized": 2000.00,
      "unrealized": 3000.00,
      "fees": 0.00,
      "taxes": 0.00,
      "income": 0.00,
      "returnPct": 12.50,
      "count": 3,
      "usedFallbackRate": false
    }
  ]
}
```

### Response Fields

**Top-level:**
| Field | Type | Description |
|-------|------|-------------|
| `currency` | string | Echo of requested currency (default EUR) |
| `computed_at` | string (ISO-8601) | Timestamp when this snapshot was computed; refreshes on cache invalidation |
| `totals` | object | Aggregate portfolio metrics across all assets |
| `summaries` | array | Per-asset-class breakdown with individual metrics |

**totals object:**
| Field | Type | Description |
|-------|------|-------------|
| `currentValue` | number | Sum of all investments' current market value in target currency (today's FX) |
| `totalInvested` | number | Sum of all cost basis at **transaction-date** FX rates (does not drift with today's FX) |
| `totalGainLoss` | number | `currentValue − totalInvested`; includes both asset and FX components (`= totalAssetGain + totalFxGain`) |
| `totalAssetGain` | number | **New (ADR-074).** Pure asset-performance component: native-currency gain × today's rate |
| `totalFxGain` | number | **New (ADR-074).** Currency-movement component: `totalGainLoss − totalAssetGain` |
| `realized` | number | Realized gains/losses from closed positions (converted at transaction-date rates) |
| `unrealized` | number | Unrealized gains/losses from open positions (current − cost basis at purchase-date rates) |
| `fees` | number | Cumulative fees paid (converted at transaction-date rates) |
| `taxes` | number | Cumulative taxes paid (converted at transaction-date rates) |
| `income` | number | Cumulative dividends/interest/yield received (converted at transaction-date rates) |
| `totalReturnPct` | number | Total return percentage: `(totalGainLoss / totalInvested) × 100` |
| `usedFallbackRate` | boolean | **New (ADR-074).** `true` if any investment lacked a transaction-date rate and fell back to today's rate; a disclosure flag for the UI |

**summaries[] object (one per asset class):**
| Field | Type | Description |
|-------|------|-------------|
| `asset_class` | string | Asset class: `stock`, `etf`, `crypto`, `metals`, `real_estate`, `savings`, or `bonds` |
| `currentValue` | number | Current market value in target currency (today's FX) |
| `invested` | number | Cost basis at transaction-date FX rates |
| `gainLoss` | number | `currentValue − invested` (= `assetGain + fxGain`) |
| `assetGain` | number | **New (ADR-074).** Pure asset-performance component for this class |
| `fxGain` | number | **New (ADR-074).** Currency-movement component for this class |
| `nativeCurrentValue` | number | **New (ADR-074).** Current market value in the investment's native currency (before FX conversion) |
| `realized` | number | Realized gains for this class |
| `unrealized` | number | Unrealized gains for this class |
| `fees` | number | Fees for this class |
| `taxes` | number | Taxes for this class |
| `income` | number | Income for this class |
| `returnPct` | number | Return % for this class |
| `count` | integer | Number of investments in this class |
| `usedFallbackRate` | boolean | **New (ADR-074).** `true` if any transaction in this class used a fallback (non-historical) rate |

**Reconciliation invariants (verified by test):**
```
sum(summaries[].currentValue) === totals.currentValue
sum(summaries[].invested)     === totals.totalInvested
sum(summaries[].gainLoss)     === totals.totalGainLoss
sum(summaries[].assetGain)    === totals.totalAssetGain
sum(summaries[].fxGain)       === totals.totalFxGain
gainLoss === assetGain + fxGain   (per-investment AND in totals)
(totalGainLoss / totalInvested) × 100 = totalReturnPct
```

### Error Responses

| Status | Description | Example |
|--------|-------------|---------|
| 400 | Invalid currency code | `{ "ok": false, "error": { "code": "APP_ERROR", "message": "Unsupported currency: XYZ" } }` |
| 401 | Not authenticated | User session expired |
| 429 | Rate limited | User exceeded 60 req/min quota |
| 500 | Server error | Database or conversion service unavailable |

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Error message" } }
```

## Caching Strategy

**TTL:** 60 seconds
- Balances freshness (price refreshes run on 5-min intervals) with low latency
- Most dashboard renders hit cache; cold-start time is ~200-400ms

**Invalidation:** Atomic on write
- `POST /api/investments` → clears cache
- `PATCH /api/investments/:id` → clears cache
- `DELETE /api/investments/:id` → clears cache
- `POST /api/investments/:id/transactions` → clears cache
- `PATCH /api/investments/transactions/:txnId` → clears cache
- `DELETE /api/investments/transactions/:txnId` → clears cache
- `POST /api/transactions` → clears cache
- `PATCH /api/transactions/:id` → clears cache
- `DELETE /api/transactions/:id` → clears cache

**Inflight dedup:** If two requests arrive during cache miss, the second waits for the first's result instead of re-computing.

## FX Conversion

All monetary values in the response are pre-converted to the target currency on the server. The conversion applies:

1. Fetch all investments with their current prices and cost basis
2. For each investment, load the `fx_rate_to_eur` stamped on every portfolio transaction (or look up the stored on-or-before rate from `exchange_rates`)
3. Flows (buys, sells, fees, taxes, income) are converted at their **transaction-date** rate; holdings values are converted at today's rate
4. `assetGain` = native-currency gain × today's rate; `fxGain` = `gainLoss − assetGain`
5. Group by asset class and sum totals

**Rate source (ADR-074):** `portfolio_transactions.fx_rate_to_eur` per row (preferred) → stored on-or-before rate from `exchange_rates` (≤7-day lookback) → today's rate with `usedFallbackRate: true`

> [!warning] Semantics change from pre-ADR-074
> Before 2026-06-11, `totalInvested` was restated at today's FX rate on every call, so "invested" drifted with the market. After ADR-074 it is locked at purchase-date rates. Multi-currency portfolios will see different `totalInvested` and `gainLoss` figures compared to pre-ADR-074 readings — this is the intentional fix, not a regression.

## Use Cases

### Dashboard Overview Cards

Frontend dashboard renders four headline cards using this endpoint:

```typescript
const { data } = usePortfolioSummaryQuery(displayCurrency);

// Total Portfolio Value
<Card>Total: {data?.totals.currentValue.toFixed(2)}</Card>

// Total Invested
<Card>Invested: {data?.totals.totalInvested.toFixed(2)}</Card>

// Total Gain/Loss
<Card>Gain/Loss: {data?.totals.totalGainLoss.toFixed(2)}</Card>

// Return %
<Card>Return: {data?.totals.totalReturnPct.toFixed(2)}%</Card>
```

### Performance Page Headline Metrics

Performance page headline metrics (updated 2026-04-29):

```typescript
const { data: performance } = usePortfolioPerformanceQuery(displayCurrency, period);

// Override snapshot-era totals with realtime values
const metricsBlock = {
  ...performance.metrics,
  currentValue: portfolioSummary.totals.currentValue,
  totalInvested: portfolioSummary.totals.totalInvested,
  totalGainLoss: portfolioSummary.totals.totalGainLoss,
  totalReturnPct: portfolioSummary.totals.totalReturnPct,
};
```

### Net Worth Current-Point Overlay (2026-05-31)

The `GET /api/info/net-worth` endpoint now overlays its *current* investments value with the live summary from this endpoint, via the shared `portfolioSummaryCache`. The new shared helper `resolveLivePortfolioValue(targetCurrency)` in `apps/node-backend/src/routes/info/_liveSummary.js` reads `totals.totalPortfolioValue` from the cache and passes it to `infoRepositoryNetWorth.getNetWorthFromSnapshots`. This means Dashboard, Performance, and Net Worth all derive their "current portfolio value" from the same source — a true single source of truth across all three surfaces. Historical Net Worth snapshot days are unaffected. See [[docs/adr/064-net-worth-current-value-live-overlay|ADR-064]].

### Per-Asset-Class Breakdown

Portfolio composition chart uses `summaries`:

```typescript
const chartData = data?.summaries.map(s => ({
  asset_class: s.asset_class,
  value: s.currentValue,
  invested: s.invested,
  allocation: (s.currentValue / data.totals.currentValue) * 100,
}));
```

## Examples

### cURL

```bash
# Get portfolio totals in EUR (default)
curl -X GET "http://localhost:3002/api/info/portfolio-summary" \
  -H "Content-Type: application/json"

# Get portfolio totals in USD
curl -X GET "http://localhost:3002/api/info/portfolio-summary?currency=USD" \
  -H "Content-Type: application/json"
```

### JavaScript (Fetch)

```javascript
const response = await fetch('/api/info/portfolio-summary?currency=EUR', {
  method: 'GET',
  credentials: 'include', // Include session cookie
});
const data = await response.json();
console.log(`Total: ${data.totals.currentValue}`);
```

### React Query (Frontend)

```typescript
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';

function usePortfolioSummaryQuery(currency = 'EUR') {
  return useQuery({
    queryKey: ['portfolio-summary', currency],
    queryFn: () => apiClient.getPortfolioSummary({ currency }),
    staleTime: 60_000, // 60 seconds
    retry: 1,
  });
}

// Usage in component
const { data, isLoading } = usePortfolioSummaryQuery(displayCurrency);
if (isLoading) return <Loading />;
return <div>Total: {data.totals.currentValue}</div>;
```

## Related

- [[docs/api/info|Info & Analytics API]] — Other portfolio/statistics endpoints
- [[docs/api/investments|Investments API]] — Per-investment data and price updates
- [[docs/features/portfolio|Portfolio Feature]] — Feature overview and asset classes
- [[docs/adr/074-fx-attribution-historical-rates|ADR-074]] — FX attribution decision and rationale
- [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044]] — Single source of truth architecture decision
- [[docs/adr/073-shared-portfolio-math-package|ADR-073]] — Shared portfolio math (fxMultiplier converted track)
- [[docs/integrations/currency-conversion|Currency Conversion]] — ECB full-history tier, on-or-before convention
- [[docs/reference/code-patterns#portfolio-totals-pattern|Portfolio Totals Pattern]] — Implementation guidelines
- [[docs/api/portfolio-summary|Performance API]] — Snapshot timeseries and annualized metrics

## Changelog

### 2026-06-11 — FX attribution fields + purchase-date rate semantics (ADR-074)

- **Semantics change:** `totalInvested`, `totalBuyCost`, `gainLoss`, `realizedGain`, `unrealizedGain`, `avgCostBasis`, fees, taxes, and income are now converted at **transaction-date** FX rates instead of today's rate. Invested capital no longer drifts with FX.
- **New totals fields:** `totalAssetGain` (pure asset performance), `totalFxGain` (currency effect), `usedFallbackRate` (disclosure flag).
- **New per-investment fields:** `assetGain`, `fxGain`, `nativeCurrentValue`, `usedFallbackRate`.
- **Identity guaranteed:** `gainLoss = assetGain + fxGain` holds per-investment and in totals.
- `fx_rate_to_eur` is now auto-resolved from stored `exchange_rates` (on-or-before ≤7 days) on transaction create/edit when not explicitly provided and currency ≠ EUR.
- Source: [[apps/node-backend/src/services/portfolio/portfolioSummaryService.js]], [[apps/node-backend/src/controllers/investmentController.js]]

### 2026-05-31 — Net Worth overlay extended single source of truth

- The Net Worth endpoint (`GET /api/info/net-worth`) now reads `totals.totalPortfolioValue` from `portfolioSummaryCache` (this endpoint's cache) and overlays it onto the latest snapshot before computing the headline `current` value, last chart point, and latest table row.
- New shared helper `apps/node-backend/src/routes/info/_liveSummary.js` exposes `resolveLiveSummary` and `resolveLivePortfolioValue` for use by both `netWorth.js` and the startup warmup path.
- API response shape of `/api/info/net-worth` is UNCHANGED. No frontend changes.
- This extends the "single source of truth" guarantee from Dashboard + Performance to all three portfolio pages. See [[docs/adr/064-net-worth-current-value-live-overlay|ADR-064]].

### 2026-04-29 — Initial Release

- New realtime endpoint `/api/info/portfolio-summary`
- Single source of truth for dashboard + performance page totals
- 60s cache TTL with atomic invalidation
- Reconciliation invariant verified by tests (sum of summaries = totals)
