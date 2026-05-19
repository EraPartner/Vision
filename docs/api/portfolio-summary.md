---
title: Portfolio Summary API
type: endpoint
status: active
date: 2026-04-29
tags: [endpoint, api, portfolio, realtime, summary, totals, dashboard, performance]
description: Realtime portfolio totals endpoint serving as single source of truth for dashboard and performance page metrics. Single computation path, consistent FX timing, 60s cache TTL.
aliases: [portfolio-totals, portfolio-metrics, summary-api]
related_code: ["apps/node-backend/src/services/portfolio/portfolioSummaryService.js", "apps/node-backend/src/routes/info/portfolioSummary.js", "apps/node-backend/src/routes/info/_cache.js", "apps/frontend/src/hooks/portfolio/usePortfolioSummary.ts", "apps/frontend/src/lib/api/info.ts"]
---

# Portfolio Summary API

> [!abstract] Overview
> Realtime endpoint computing portfolio totals (value, invested, gain/loss, returns) with FX conversion applied server-side. Single source of truth for dashboard overview cards and performance page headline metrics. Eliminates divergence from dual compute paths and ensures consistent FX timing across UI surfaces.

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
| `currentValue` | number | Sum of all investments' current market value in target currency |
| `totalInvested` | number | Sum of all cost basis across all investments |
| `totalGainLoss` | number | Current value − total invested (realized + unrealized) |
| `realized` | number | Realized gains/losses from closed positions and completed transactions |
| `unrealized` | number | Unrealized gains/losses from open positions (current − cost basis) |
| `fees` | number | Cumulative fees paid (broker/platform fees from transactions) |
| `taxes` | number | Cumulative taxes paid (estate/capital gains taxes) |
| `income` | number | Cumulative dividends/interest/yield received |
| `totalReturnPct` | number | Total return percentage: (totalGainLoss / totalInvested) × 100 |

**summaries[] object (one per asset class):**
| Field | Type | Description |
|-------|------|-------------|
| `asset_class` | string | Asset class: `stock`, `etf`, `crypto`, `metals`, `real_estate`, `savings`, or `bonds` |
| `currentValue` | number | Sum of investments in this class (current market value in target currency) |
| `invested` | number | Sum of cost basis for this class |
| `gainLoss` | number | Gain/loss for this class |
| `realized` | number | Realized gains for this class |
| `unrealized` | number | Unrealized gains for this class |
| `fees` | number | Fees for this class |
| `taxes` | number | Taxes for this class |
| `income` | number | Income for this class |
| `returnPct` | number | Return % for this class |
| `count` | integer | Number of investments in this class |

**Reconciliation invariant (verified by test):**
```
sum(summaries[].currentValue) === totals.currentValue
sum(summaries[].invested) === totals.invested
sum(summaries[].gainLoss) === totals.gainLoss
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
2. Group by asset class
3. For each group, sum the values and convert total to target currency using live exchange rates
4. Apply same rate to all computations (totals and summaries)

**Rate source:** `exchange_rates` table with fallback to `currencyConversionService`

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
- [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044]] — Architecture decision and rationale
- [[docs/reference/code-patterns#portfolio-totals-pattern|Portfolio Totals Pattern]] — Implementation guidelines
- [[docs/api/portfolio-summary|Performance API]] — Snapshot timeseries and annualized metrics

## Changelog

### 2026-04-29 — Initial Release

- New realtime endpoint `/api/info/portfolio-summary`
- Single source of truth for dashboard + performance page totals
- 60s cache TTL with atomic invalidation
- Reconciliation invariant verified by tests (sum of summaries = totals)
