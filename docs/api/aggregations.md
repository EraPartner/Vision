---
title: Aggregations API
type: endpoint
status: active
date: 2026-04-16
tags: [endpoint, api, aggregations, backend, phase-2]
description: Server-computed transaction aggregations with materialized-view source distinction, behind AGGREGATIONS_V2_ENABLED feature flag
aliases: [aggregations, stats aggregation, computed stats, aggregation endpoints]
related_code:
  - apps/node-backend/src/routes/aggregations.js
  - apps/node-backend/src/services/calculations/aggregation/
  - apps/frontend/src/lib/api.ts
  - apps/frontend/src/hooks/useFilteredDashboardStats.ts
---

# Aggregations API

> [!abstract] Overview
> Phase 2 introduces `/api/aggregations/*` endpoints — server-computed financial aggregations with metadata indicating whether data was served from materialized views (`'mv'`) or computed live (`'live'`). These endpoints power dashboard stat cards and statistics widgets with support for category/recipient exclusions.

> [!info] Feature Flag
> All endpoints require `AGGREGATIONS_V2_ENABLED=true`. Legacy `/api/info/*` endpoints coexist through Phase 8; removed in Phase 9.

## Endpoint Details

| Property | Value |
|----------|-------|
| **Base Path** | `/api/aggregations` |
| **Methods** | GET (read-only) |
| **Authentication** | None |
| **Rate Limit** | None |

## Response Envelope

All endpoints return a standard envelope:

```json
{
  "data": { /* endpoint-specific data */ },
  "meta": {
    "source": "mv" | "live",
    "computedAt": "2026-04-16T12:34:56.789Z"
  }
}
```

**Metadata fields:**

| Field | Type | Meaning |
|-------|------|---------|
| `source` | `'mv' \| 'live'` | `'mv'` = served from materialized view (no exclusions); `'live'` = dynamically computed (due to category or recipient exclusions) |
| `computedAt` | ISO 8601 timestamp | When the computation was performed |

## Endpoints

### Monthly Summary

Summary of financial totals per month.

**Path:** `GET /api/aggregations/monthly-summary`

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `currency` | string | EUR | Target currency (3-letter code, case-insensitive) |
| `excluded_category_ids[]` | integer[] | [] | Categories to exclude from totals |
| `excluded_recipient_ids[]` | integer[] | [] | Recipients to exclude from totals |

**Response (data field):**

```json
{
  "months": [
    {
      "month": 1,
      "year": 2026,
      "period_start": "2026-01-01",
      "period_end": "2026-01-31",
      "total_spending": -1200.00,
      "total_income": 3500.00,
      "net_amount": 2300.00,
      "transaction_count": 42
    }
  ],
  "summary": {
    "total_spending": -4800.00,
    "total_income": 14000.00,
    "net_amount": 9200.00,
    "transaction_count": 168,
    "period_start": "2026-01-01",
    "period_end": "2026-04-16"
  }
}
```

**Frontend Usage:**

```typescript
const envelope = await apiClient.getAggregationMonthlySummary({
  excluded_category_ids: [5, 10],
  excluded_recipient_ids: [3],
  currency: 'EUR'
});
// envelope.data.months[n] → latest month with transaction_count > 0
// envelope.meta.source → 'mv' or 'live'
```

---

### Category Breakdown

Spending totals by category.

**Path:** `GET /api/aggregations/category-breakdown`

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `currency` | string | EUR | Target currency |

**Response (data field):**

```json
{
  "categories": [
    {
      "id": 5,
      "name": "Groceries",
      "count": 28,
      "total": 420.50
    },
    {
      "id": null,
      "name": "[Uncategorized]",
      "count": 3,
      "total": 45.00
    }
  ]
}
```

---

### Recipient Insights

Top merchants and month-over-month spending changes.

**Path:** `GET /api/aggregations/recipient-insights`

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `currency` | string | EUR | Target currency |

**Response (data field):**

```json
{
  "topMerchants": [
    {
      "recipientId": 12,
      "name": "SuperMart",
      "totalSpend": 850.00,
      "transactionCount": 14,
      "avgAmount": 60.71,
      "firstSeen": "2025-06-01",
      "lastSeen": "2026-04-10"
    }
  ],
  "monthOverMonth": [
    {
      "recipientId": 12,
      "name": "SuperMart",
      "currentSpend": 125.00,
      "previousSpend": 98.50,
      "changePercent": 26.88
    }
  ]
}
```

---

### Cashflow Comparison

Current vs. historical daily flow (with and without planned transactions).

**Path:** `GET /api/aggregations/cashflow-comparison`

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `currency` | string | EUR | Target currency |
| `excluded_category_ids[]` | integer[] | [] | Categories to exclude |
| `excluded_recipient_ids[]` | integer[] | [] | Recipients to exclude |

**Response (data field):**

```json
{
  "days_in_month": 30,
  "current_day": 16,
  "month": 4,
  "year": 2026,
  "without_planned": [
    { "day": 1, "average": 50.00, "current": null },
    { "day": 16, "average": 75.00, "current": 65.50 }
  ],
  "with_planned": [
    { "day": 1, "average": 50.00, "current": 55.00 },
    { "day": 16, "average": 75.00, "current": 120.50 }
  ]
}
```

---

### Average vs. Current

Average metrics vs. current period (always computed live in Phase 2).

**Path:** `GET /api/aggregations/average-vs-current`

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `currency` | string | EUR | Target currency |

**Response (data field):**

```json
{
  "averageDailySpend": 75.00,
  "currentDailySpend": 82.50,
  "percentChange": 10.0,
  "averageMonthlySpend": 2250.00,
  "currentMonthlySpend": 1320.00
}
```

> [!note]
> This endpoint always returns `meta.source === 'live'` in Phase 2 because the "current period" metric requires dynamic computation. Future phases may optimize this with additional MV variants.

---

### Bank Balances

Account balances and historical balance data.

**Path:** `GET /api/aggregations/bank-balances`

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `currency` | string | EUR | Target currency |

**Response (data field):**

```json
{
  "accounts": [
    {
      "bank_account": "IBAN:BE12345678901234",
      "balance": 5230.50,
      "transaction_count": 156,
      "first_transaction": "2025-03-01",
      "last_transaction": "2026-04-10"
    }
  ],
  "total_net_position": 12450.75,
  "history": {
    "IBAN:BE12345678901234": [
      { "month": "2026-01", "balance": 4800.00 },
      { "month": "2026-02", "balance": 5100.00 },
      { "month": "2026-03", "balance": 5230.50 }
    ]
  },
  "total_history": [
    { "month": "2026-01", "balance": 9500.00 },
    { "month": "2026-02", "balance": 10200.00 },
    { "month": "2026-03", "balance": 12450.75 }
  ]
}
```

---

## Source Heuristic

The `meta.source` field distinguishes between two computation modes:

| Condition | Source | Rationale |
|-----------|--------|-----------|
| No `excluded_category_ids[]` AND no `excluded_recipient_ids[]` | `'mv'` | Unfiltered request served from materialized view (fast, stale) |
| `excluded_category_ids[]` OR `excluded_recipient_ids[]` present | `'live'` | Exclusions require live scan of all transactions (slower, current) |
| `/average-vs-current` | `'live'` | Phase 2 always computes current-period metrics live |

---

## Error Handling

All aggregation endpoints return errors in the standard envelope:

| Status | Response | Cause |
|--------|----------|-------|
| 400 | `{ "detail": "Invalid currency code" }` | Malformed currency param |
| 500 | `{ "detail": "Error computing aggregation: {label}" }` | Server error during computation |

---

## Frontend Integration

### useFilteredDashboardStats Hook

Dashboard stat cards fetch from `/api/aggregations/monthly-summary` with exclusions applied:

```typescript
import { useFilteredDashboardStats } from '@/hooks/useFilteredDashboardStats';

function DashboardPage() {
  const { data: stats } = useFilteredDashboardStats();
  // stats.monthlyIncome, stats.monthlySpending, stats.netBalance
}
```

See [[apps/frontend/src/hooks/useFilteredDashboardStats.ts|useFilteredDashboardStats.ts]] for implementation.

### API Client

All aggregation methods are available on `apiClient`:

```typescript
import { apiClient } from '@/lib/api';

// Monthly summary with exclusions
const envelope = await apiClient.getAggregationMonthlySummary({
  excluded_category_ids: [5],
  excluded_recipient_ids: [3],
  currency: 'EUR'
});

// Category breakdown (no exclusions)
const catEnvelope = await apiClient.getAggregationCategoryBreakdown({ currency: 'EUR' });

// Other endpoints
await apiClient.getAggregationRecipientInsights({ currency: 'EUR' });
await apiClient.getAggregationCashflowComparison({ currency: 'EUR' });
await apiClient.getAggregationAverageVsCurrent({ currency: 'EUR' });
await apiClient.getAggregationBankBalances({ currency: 'EUR' });
```

See [[apps/frontend/src/lib/api.ts|api.ts]] (lines ~1019–1107) for type definitions.

---

## Metadata & Roadmap

- **Phase 2 (current)**: Launch `mv` and `live` sources. Portfolio aggregations remain out of scope (separate `/api/info` endpoints with TTL caches).
- **Phase 3–8**: Shadow-mode parity testing; MV extension for history queries.
- **Phase 9**: Remove legacy `/api/info/*` endpoints after proven parity.

---

## Related

- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]]
- [[docs/features/statistics|Statistics Feature]]
- [[docs/components/dashboard|Dashboard Components]]
- [[docs/architecture/backend-architecture|Backend Architecture]]
- [[docs/reference/code-patterns|Code Patterns Reference]]
