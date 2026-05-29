---
title: Aggregations API
type: endpoint
status: active
date: 2026-04-25
updated: 2026-05-29
last_modified: 2026-05-29
recipient_pivot_added: 2026-04-28
tags: [endpoint, api, aggregations, backend, phase-2, phase-6, phase-9, phase-10, phase-d, phase-e, phase-f, phase-g, phase-h, phase-h-v2, decimal, money, cashflow-forecast, multi-method-forecast, statistical-forecasting, ensemble-methods, accuracy-persistence, materialized-cache, nightly-job, category-breakdown, fallback-resilience, rolling-window, url-persistence, rolling-cache, rolling-diagnostics, recipient-pivot, saved-charts]
description: Server-computed transaction aggregations with materialized-view source distinction; includes planned cash flow forecast (Phase 6), 8-method statistical forecast with inverse-MSE ensemble (Phase 10 + F), persisted accuracy metrics with fallback-to-memory resilience (Phase D), nightly cache materialization (Phase E), per-category breakdown with reconciliation (Phase G), rolling-window cash flow forecast (Phase H), and per-recipient spending pivot for custom charts (April 2026)
aliases: [aggregations, stats aggregation, computed stats, aggregation endpoints, cashflow-forecast, cash-flow-forecast, multi-method-forecast]
related_code:
  - apps/node-backend/src/routes/aggregations.js
  - apps/node-backend/src/services/calculations/aggregation/
  - apps/node-backend/src/services/calculations/aggregation/recipientPivot.js
  - apps/node-backend/src/services/calculations/forecast/index.js
  - apps/node-backend/src/services/calculations/forecast/categoryBreakdown.js
  - apps/node-backend/src/repositories/infoRepositoryMonthly.js
  - apps/node-backend/src/repositories/infoRepo.forecast.js
  - apps/node-backend/src/repositories/cashflowForecastAccuracyRepository.js
  - apps/node-backend/src/repositories/cashflowForecastMcRepository.js
  - apps/node-backend/src/repositories/cashflowForecastMcRollingRepository.js
  - apps/node-backend/src/jobs/refreshCashflowForecastMc.js
  - apps/frontend/src/lib/api.ts
  - apps/frontend/src/lib/api/aggregations.ts
  - apps/frontend/src/hooks/useRecipientPivot.ts
  - apps/frontend/src/utils/forecastMerge.ts
  - apps/frontend/src/hooks/useFilteredDashboardStats.ts
  - apps/frontend/src/components/dashboard/CashFlowForecastChart.tsx
  - apps/frontend/src/components/dashboard/ForecastInner.tsx
  - apps/frontend/src/components/dashboard/ForecastInnerRolling.tsx
  - apps/frontend/src/components/dashboard/CashFlowForecastDiagnostics.tsx
  - apps/frontend/src/components/charts/LineChart.tsx
  - apps/node-backend/src/services/calculations/aggregation/cashflowForecast.js
  - alembic/versions/0012_cashflow_forecast_accuracy.py
  - alembic/versions/0013_cashflow_forecast_mc.py
  - alembic/versions/0017_saved_charts_recipients_variants.py
---

# Aggregations API

> [!abstract] Overview
> Phase 2 introduces `/api/aggregations/*` endpoints — server-computed financial aggregations with metadata indicating whether data was served from materialized views (`'mv'`) or computed live (`'live'`). These endpoints power dashboard stat cards and statistics widgets with support for category/recipient exclusions.

> [!info] Phase 9 Migration Complete
> Legacy `/api/info/*` endpoints were removed in Phase 9. All aggregation requests now route through `/api/aggregations/*`.

## Endpoint Details

| Property | Value |
|----------|-------|
| **Base Path** | `/api/aggregations` |
| **Methods** | GET (read-only) |
| **Authentication** | None |
| **Rate Limit** | 600 req/min (`aggregationRateLimiter`; bypassed in development) |

## Response Envelope

All endpoints follow the unified response envelope (ADR-026) with a nested aggregation domain envelope:

```json
{
  "ok": true,
  "data": {
    "data": { /* endpoint-specific aggregation result */ },
    "meta": {
      "source": "mv" | "live",
      "computedAt": "2026-04-16T12:34:56.789Z"
    }
  },
  "meta": {
    "requestId": "...",
    "computedAt": "2026-04-16T12:34:56.789Z"
  }
}
```

**Transport envelope** (outer `ok`, outer `meta`):

| Field | Meaning |
|-------|---------|
| `ok` | Always `true` on success |
| `meta.requestId` | Correlation ID for request tracing |

**Aggregation envelope** (inner `data`, inner `meta`):

| Field | Type | Meaning |
|-------|------|---------|
| `data.data` | object | Endpoint-specific aggregation result (see endpoint sections) |
| `data.meta.source` | `'mv' \| 'live' \| 'cache'` | `'mv'` = served from materialized view (no exclusions); `'live'` = dynamically computed (due to category or recipient exclusions or custom params); `'cache'` = served from 6-hour TTL cache (Phase E cash flow forecast only) |
| `data.meta.computedAt` | ISO 8601 timestamp | When the aggregation was computed or cached |

**Frontend unwrapping:** After `unwrapEnvelope()` strips the outer `ok/meta` layer, consumers receive `{ data, meta: { source, computedAt } }` (the aggregation envelope).

## Monetary Precision (Phase 9)

All monetary values in aggregation responses use **Decimal.js** for precision to eliminate IEEE 754 floating-point drift. Values are serialized as JSON `number` type, safe to 2 decimal places (cents). See [[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021]] for the decision rationale and [[docs/reference/code-patterns#money-utility-pattern-phase-9|Money Utility Pattern]] for implementation details.

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
| `all_time` | boolean | false | When `true`, return full all-time history; when `false`, return recent months only. Always bypasses MV fast-path and uses live SQL for complete accuracy |

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

**Implementation Notes:**

- **MV Fast-Path Optimization**: When `all_time=false` and no category/recipient exclusions are present, the backend reads from `mv_monthly_summary` (recent months only, ~5–10ms response). Otherwise, live SQL executes against full transaction history.
- **All-Time Bypass**: When `all_time=true`, the fast path is unconditionally bypassed—live SQL always executes to guarantee complete all-time history. MVs retain only the last 12 months, insufficient for full history queries. See [[docs/performance/materialized-views#mv-monthly-summary]] for details.
- **Historical FX Conversion**: Each month's transactions are converted using date-specific FX rates (not latest rates), preserving month-over-month stability across restarts and rate cache refreshes.

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

### Recipient Pivot

Per-recipient aggregated spending data with category and time-bucket filtering, supporting custom chart rendering with recipients and categories as co-series.

**Path:** `GET /api/aggregations/recipient-pivot`

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `currency` | string | EUR | Target currency (3-letter code, case-insensitive) |
| `time_bucket` | string | monthly | `monthly` or `yearly` |
| `category_ids[]` | integer[] | [] | Categories to include (if empty, all included) |
| `recipient_ids[]` | integer[] | [] | Recipients to include (if empty, all included) |
| `date_range_start` | string | null | ISO date filter start (YYYY-MM-DD) |
| `date_range_end` | string | null | ISO date filter end (YYYY-MM-DD) |

**Response (data field):**

```json
{
  "recipients": [
    {
      "recipient_id": 10,
      "recipient_name": "SuperMart",
      "periods": [
        {
          "period": "2026-01",
          "total": 425.50,
          "count": 8
        },
        {
          "period": "2026-02",
          "total": 382.75,
          "count": 7
        }
      ],
      "total": 808.25,
      "count": 15
    },
    {
      "recipient_id": 11,
      "recipient_name": "Gas Station",
      "periods": [
        {
          "period": "2026-01",
          "total": 85.00,
          "count": 2
        },
        {
          "period": "2026-02",
          "total": 92.50,
          "count": 2
        }
      ],
      "total": 177.50,
      "count": 4
    }
  ]
}
```

**Field Descriptions:**

| Field | Type | Meaning |
|-------|------|---------|
| `recipients[]` | array | Per-recipient aggregated series |
| `recipient_id` | number | Recipient ID |
| `recipient_name` | string | Recipient display name |
| `periods[]` | array | Time-bucketed spending (monthly/yearly) |
| `period` | string | Period key (YYYY-MM for monthly, YYYY for yearly) |
| `total` | number | Recipient spending in this period |
| `count` | number | Transaction count in this period |
| `total` | number | Total recipient spending across all periods |
| `count` | number | Total transaction count |

**Frontend Usage:**

```typescript
const envelope = await apiClient.getAggregationRecipientPivot({
  currency: 'EUR',
  time_bucket: 'monthly',
  recipient_ids: [10, 11],
  category_ids: [5, 7],
  date_range_start: '2026-01-01',
  date_range_end: '2026-03-31'
});

// envelope.data.recipients → array of per-recipient series
// Render as CustomChart with recipients as series
```

**Use Case:**

The Recipient Pivot endpoint powers the **Custom Charts** feature's ability to render charts with recipients (merchants) as independent series alongside categories. When a user saves a chart with `recipient_ids` populated, the frontend calls this endpoint with the chart's filters and renders the result as a multi-series chart.

---

### Cash Flow Forecast

N-month forward projection of income and expenses from active, unexecuted planned transactions (Phase 6).

**Path:** `GET /api/aggregations/cashflow-forecast`

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `months` | integer | 3 | 24 | Number of months to forecast |

**Response (data field):**

```json
{
  "forecast": [
    {
      "month": "2026-05",
      "income": 3500.00,
      "expenses": -2150.75,
      "net": 1349.25,
      "items": [
        {
          "id": 42,
          "planned_date": "2026-05-01",
          "currency": "EUR",
          "amount": 3500.00,
          "memo": "Salary",
          "recipient_name": "Employer Inc.",
          "category_name": "INCOME:SALARY",
          "is_recurring": false,
          "recurrence_pattern": null
        }
      ]
    },
    {
      "month": "2026-06",
      "income": 3500.00,
      "expenses": -2150.75,
      "net": 1349.25,
      "items": []
    }
  ]
}
```

**Field Descriptions:**

| Field | Type | Meaning |
|-------|------|---------|
| `month` | string | `YYYY-MM` format |
| `income` | number | Sum of positive (incoming) amounts |
| `expenses` | number | Sum of negative (outgoing) amounts (negative value) |
| `net` | number | `income + expenses` |
| `items` | array | Forecast line items in this month |

**Frontend Usage:**

```typescript
const envelope = await apiClient.getAggregationCashflowForecast({
  months: 6
});
// envelope.data.forecast[n].month → "2026-05"
// envelope.data.forecast[n].net → projected cash position
// envelope.meta.source → always "live" (computed on-demand)
```

See [[docs/features/cash-flow-forecast|Cash Flow Forecast Feature]] for details.

---

### Cash Flow Forecast (Rolling Window — Phase H)

N-day rolling-window projection of income and expenses from actual transactions + planned transactions, with configurable window (30/60/90/180 days). Supports walk-forward backtest diagnostics via optional `include_backtest` parameter and uses 6-hour TTL MC rolling cache.

**Path:** `GET /api/aggregations/cashflow-forecast-rolling`

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `days_back` | integer | 90 | 365 | Historical lookback window (days, typically 3× the forecast window) |
| `days_forward` | integer | 90 | 365 | Days to forecast ahead (max 365) |
| `currency` | string | EUR | — | Target currency (3-letter code, case-insensitive) |
| `excluded_category_ids[]` | integer[] | [] | — | Categories to exclude from forecast |
| `excluded_recipient_ids[]` | integer[] | [] | — | Recipients to exclude from forecast |
| `include_planned` | boolean | false | — | When `true`, overlay pending planned transactions into cumulative view |
| `history_months` | integer | 36 | 120 | Historical window for training methods (in months) |
| `mc_paths` | integer | 500 | 5000 | Monte Carlo simulation paths per method (rolling-window default; distinct from month view default of 1000) |
| `mc_percentiles[]` | integer[] | [25,75] | — | Percentiles for confidence bands (rolling-window defaults; distinct from month view [10,50,90]) |
| `include_backtest` | boolean | false | — | When `true`, runs expensive walk-forward backtest and includes diagnostics in response (frontend uses lazy-load via separate query, only enabled when user opens diagnostics sheet) |

**Note:** `days_back + days_forward` must be ≤ 730 days; requests exceeding this limit return 400 error.

> [!info] Rolling Window Defaults
> Rolling mode uses separate MC defaults from month view: **500 paths** and **P25/P75 percentiles** (vs. month view: 1000 paths, P10/P50/P90). The rolling window's broader horizon (up to 180+ days) makes higher path counts computationally expensive. Cache checks for these rolling-specific defaults; when frontend requests match them, response is served from 6-hour TTL cache.

**Response (data field):**

```json
{
  "window_start": "2026-01-28",
  "window_end": "2026-07-27",
  "today": "2026-04-28",
  "currency": "EUR",
  "days_back": 90,
  "days_forward": 90,
  "actual": [
    { "date": "2026-01-28", "net": 12.34, "cumulative": 12.34 },
    { "date": "2026-01-29", "net": 45.67, "cumulative": 58.01 }
  ],
  "methods": [
    {
      "id": "simple_avg",
      "label": "Simple Average",
      "daily": [
        { "date": "2026-04-29", "value": 42.15 },
        { "date": "2026-04-30", "value": 39.80 }
      ],
      "cumulative": [
        { "date": "2026-04-29", "value": 3450.75 },
        { "date": "2026-04-30", "value": 3490.55 }
      ],
      "bands": null,
      "error": null
    },
    {
      "id": "monte_carlo_parametric",
      "label": "Monte Carlo (Parametric)",
      "daily": [ /* ... */ ],
      "cumulative": [ /* ... */ ],
      "bands": {
        "p10": [ { "date": "2026-04-29", "value": 35.20 } ],
        "p50": [ { "date": "2026-04-29", "value": 42.15 } ],
        "p90": [ { "date": "2026-04-29", "value": 49.10 } ]
      },
      "error": null
    }
  ],
  "planned": [
    { "date": "2026-05-01", "net": -1200 },
    { "date": "2026-05-15", "net": 3500 }
  ],
  "diagnostics": {
    "history_months": 36,
    "backtest": [
      {
        "method_id": "simple_avg",
        "label": "Simple Average",
        "mae": 125.45,
        "rmse": 165.30,
        "mape": 8.2,
        "months": 36
      }
    ]
  },
  "history_months": 36,
  "include_planned": false
}
```

**Field Descriptions:**

| Field | Type | Meaning |
|-------|------|---------|
| `window_start` | string | Start of rolling window (today - days_back), YYYY-MM-DD format |
| `window_end` | string | End of rolling window (today + days_forward), YYYY-MM-DD format |
| `today` | string | Current date (YYYY-MM-DD) |
| `currency` | string | Target currency |
| `days_back` | integer | Historical lookback window (days) |
| `days_forward` | integer | Forecast horizon (days) |
| `actual[]` | array | Realized daily net cash flow (past dates only) |
| `actual[].date` | string | ISO date (YYYY-MM-DD) |
| `actual[].net` | number | Daily net amount |
| `actual[].cumulative` | number | Cumulative from window start through date |
| `methods[]` | array | Array of 8 forecasting methods (5 point + 2 MC + 1 ensemble); same structure as month-mode forecast |
| `methods[].id` | string | Method identifier (simple_avg, weighted_avg, ewma, holt_winters, prophet_lite, ensemble_imse, monte_carlo_parametric, monte_carlo_block_bootstrap) |
| `methods[].label` | string | Human-readable method name |
| `methods[].daily[]` | array | Daily forecast values (future dates only) |
| `methods[].cumulative[]` | array | Cumulative sum including actual-to-date and forecast |
| `methods[].bands` | object \| null | Confidence bands for MC methods; `{ p10: [], p50: [], p90: [], ... }` per requested percentile |
| `methods[].error` | string \| null | Error code if method failed |
| `planned[]` | array | Pending planned transaction dates (if `include_planned=true`) |
| `planned[].date` | string | Planned date |
| `planned[].net` | number | Planned net amount |
| `diagnostics` | object \| null | Walk-forward backtest results (null if `include_backtest=false`) |
| `diagnostics.backtest[].method_id` | string | Forecasting method identifier |
| `diagnostics.backtest[].mae` | number | Mean Absolute Error (EUR/currency) |
| `diagnostics.backtest[].rmse` | number | Root Mean Squared Error |
| `diagnostics.backtest[].mape` | number | Mean Absolute Percentage Error (%) |
| `diagnostics.backtest[].months` | integer | Number of backtest windows |
| `history_months` | integer | Historical training window (months) |
| `include_planned` | boolean | Whether planned transactions are included in response |

**Frontend Usage:**

```typescript
const envelope = await apiClient.getCashflowForecastRolling({
  days_forward: 90,
  days_back: 90,
  currency: 'EUR',
  include_planned: false,
  include_backtest: true,
  mc_paths: 500,
  mc_percentiles: [25, 75]
});
// envelope.data.actual → historical actuals
// envelope.data.methods[] → 8 forecasting methods with daily/cumulative series
// envelope.data.planned[] → pending planned transactions (if include_planned=true)
// envelope.data.diagnostics → backtest results (if include_backtest=true)
// envelope.data.window_start/window_end → rolling window boundaries
// envelope.meta.source → "cache" (6-hour TTL) or "live" (fresh computation)
```

**Implementation Notes:**

- **Reuses forecast engine:** Leverages the same 8-method statistical engine as `/api/aggregations/cashflow-forecast-methods` (5 point + 2 MC + 1 ensemble)
- **Cumulative anchor:** Cumulative balance is computed relative to window start (not absolute account balance), allowing visualization of trend within the rolling window independently
- **Planned overlay:** When `include_planned=true`, pending planned transactions are interpolated into the response; cumulative includes planned amounts
- **MC seed:** Uses seeded PRNG derived from `hash(userId | todayIso | daysBack | daysForward | filterHash)` for deterministic samples across identical requests; seed changes daily as `today` shifts
- **Rolling MC defaults:** Backend defaults to 500 paths and [25,75] percentiles (distinct from month view 1000 paths and [10,50,90]). Frontend requests use these defaults; `include_backtest: false` in main chart query allows lighter load
- **Caching (Phase H v2):** Uses 6-hour TTL `cashflow_forecast_mc_rolling` table when using rolling-window default MC params (500 paths, [25,75] percentiles)
  - `meta.source === 'cache'` indicates cached result (within last 6 hours)
  - `meta.source === 'live'` indicates freshly computed result
  - Cache skipped when `include_backtest=true` (requires fresh computation)
- **Lazy diagnostics (Phase H v2):** Frontend splits rolling query into two:
  - **Main query** (`include_backtest: false`) — runs on page load, feeds chart with lower cost
  - **Diagnostics query** (`include_backtest: true`) — lazy-loaded, only enabled when user opens diagnostics sheet; includes walk-forward backtest with per-window metrics
  - When user closes diagnostics sheet, backtest query is disabled, avoiding wasted computation
  - Diagnostics response includes `diagnostics` field (same structure as month-mode) when `include_backtest=true`

See [[docs/features/cash-flow-forecast|Cash Flow Forecast Feature]] — Phase H v2 for feature and UX details.

---

### Sankey Flow (Phase 7)

Directed income-to-category flow graph for d3-sankey visualization with support for category/recipient exclusions.

**Path:** `GET /api/aggregations/sankey`

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `year` | integer | current year | Year to analyze (YYYY format) |
| `currency` | string | EUR | Target currency |
| `excluded_category_ids[]` | integer[] | [] | Categories to exclude from the flow calculation |
| `excluded_recipient_ids[]` | integer[] | [] | Recipients to exclude from the flow calculation |

**Response (data field):**

```json
{
  "nodes": [
    { "id": "__income__", "label": "Income", "value": 9550.50 },
    { "id": "cat:Groceries", "label": "Groceries", "value": 4200.50 },
    { "id": "cat:Transport", "label": "Transport", "value": 1850.00 },
    { "id": "__savings__", "label": "Savings / Unspent", "value": 2900.00 }
  ],
  "links": [
    {
      "source": "__income__",
      "target": "cat:Groceries",
      "value": 4200.50
    },
    {
      "source": "__income__",
      "target": "cat:Transport",
      "value": 1850.00
    },
    {
      "source": "__income__",
      "target": "__savings__",
      "value": 2900.00
    }
  ],
  "year": 2026
}
```

**Frontend Usage:**

```typescript
const envelope = await apiClient.getSankeyFlow({
  year: 2026,
  currency: 'EUR',
  excluded_category_ids: [5, 10],
  excluded_recipient_ids: [3]
});
// envelope.data.nodes → [Income, ...topCategories, Savings]
// envelope.data.links → flows from Income to categories (excluding specified filters)
// envelope.meta.source → 'live' (always computed with exclusions)
```

**Exclusion Logic:**

When `excluded_category_ids[]` or `excluded_recipient_ids[]` are provided:
- Transactions matching those filters are excluded from the calculation
- Income and category flows are recomputed based on remaining transactions
- Savings node recalculates as: `remaining_income - remaining_spending`
- Backend always returns `meta.source === 'live'` (computed on-demand due to exclusions)

See [[docs/features/sankey-flow|Sankey Flow Feature]] for visualization details.

### Multi-Method Cash Flow Forecast (Phase 10 + F)

Real-time cash flow forecast for the current month using eight forecasting methods (7 base + inverse-MSE ensemble) with ensemble diagnostics via walk-forward backtesting.

**Path:** `GET /api/aggregations/cashflow-forecast-methods`

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `currency` | string | EUR | — | Target currency (3-letter code, case-insensitive) |
| `excluded_category_ids[]` | integer[] | [] | — | Categories to exclude |
| `excluded_recipient_ids[]` | integer[] | [] | — | Recipients to exclude |
| `history_months` | integer | 36 | 120 | Historical window for training (days = history_months × 30) |
| `mc_paths` | integer | 1000 | 5000 | Monte Carlo simulation paths per method |
| `mc_percentiles[]` | integer[] | [10,50,90] | — | Percentiles for MC confidence bands (e.g., `[5,25,75,95]`) |
| `include_planned` | boolean | false | — | Include pending planned transactions in cumulative overlay? |
| `include_backtest` | boolean | true | — | Include walk-forward backtest diagnostics (MAE/RMSE/MAPE)? |
| `include_breakdown` | boolean | false | — | Include per-category breakdown with reconciliation to aggregate (Phase G)? |

**Response (data field):**

```json
{
  "month": "2026-04",
  "currency": "EUR",
  "days_in_month": 30,
  "current_day": 24,
  "actual": [
    { "date": "2026-04-01", "net": 150.50, "cumulative": 150.50 },
    { "date": "2026-04-02", "net": -25.00, "cumulative": 125.50 },
    { "date": "2026-04-03", "net": null, "cumulative": null }
  ],
  "planned": [
    { "date": "2026-04-25", "net": -1200.00 },
    { "date": "2026-04-30", "net": 3500.00 }
  ],
  "methods": [
    {
      "id": "simple_avg",
      "label": "Simple Average",
      "daily": [
        { "date": "2026-04-25", "value": 45.30 },
        { "date": "2026-04-26", "value": 40.15 },
        { "date": "2026-04-27", "value": 48.90 }
      ],
      "cumulative": [
        { "date": "2026-04-01", "value": 150.50 },
        { "date": "2026-04-24", "value": 1245.70 },
        { "date": "2026-04-25", "value": 1291.00 }
      ],
      "bands": null,
      "error": null
    },
    {
      "id": "monte_carlo_parametric",
      "label": "Monte Carlo (Parametric)",
      "daily": [
        { "date": "2026-04-25", "value": 42.80 },
        { "date": "2026-04-26", "value": 38.60 },
        { "date": "2026-04-27", "value": 51.20 }
      ],
      "cumulative": [
        { "date": "2026-04-24", "value": 1245.70 },
        { "date": "2026-04-25", "value": 1288.50 }
      ],
      "bands": {
        "p10": [
          { "date": "2026-04-25", "value": 30.50 },
          { "date": "2026-04-26", "value": 28.20 }
        ],
        "p50": [
          { "date": "2026-04-25", "value": 42.80 },
          { "date": "2026-04-26", "value": 38.60 }
        ],
        "p90": [
          { "date": "2026-04-25", "value": 55.10 },
          { "date": "2026-04-26", "value": 49.00 }
        ]
      },
      "error": null
    }
  ],
  "diagnostics": {
    "history_months": 36,
    "backtest": [
      {
        "method_id": "simple_avg",
        "label": "Simple Average",
        "mae": 125.45,
        "rmse": 165.30,
        "mape": 8.2,
        "months": 36,
        "per_month": [
          {
            "month": "2025-12",
            "mae": 115.20,
            "rmse": 155.80,
            "mape": 7.8,
            "sample_days": 28
          }
        ]
      }
    ]
  },
  "history_months": 36,
  "category_breakdown": [
    {
      "category_id": 5,
      "general": "Groceries",
      "detail": "Supermarket",
      "actual": [
        { "date": "2026-04-01", "net": 45.50, "cumulative": 45.50 },
        { "date": "2026-04-02", "net": -10.00, "cumulative": 35.50 }
      ],
      "forecast": [
        { "date": "2026-04-25", "value": 42.15 },
        { "date": "2026-04-26", "value": 48.30 }
      ],
      "cumulative": [
        { "date": "2026-04-01", "value": 45.50 },
        { "date": "2026-04-25", "value": 1234.65 }
      ]
    }
  ]
}
```

**Field Descriptions:**

| Field | Type | Meaning |
|-------|------|---------|
| `month` | string | `YYYY-MM` current month |
| `currency` | string | Target currency |
| `days_in_month` | integer | Total days in current month (28-31) |
| `current_day` | integer | Today's day-of-month (1-31) |
| `actual[]` | array | Realized daily net cash flow (past and today) |
| `actual[].date` | string | ISO date (YYYY-MM-DD) |
| `actual[].net` | number \| null | Daily net (null for future dates) |
| `actual[].cumulative` | number \| null | Cumulative through date (null for future) |
| `planned[]` | array | Pending planned transaction dates (if `include_planned=true`) |
| `planned[].date` | string | Planned date |
| `planned[].net` | number | Planned net amount |
| `methods[].id` | string | Method identifier: `simple_avg`, `weighted_avg`, `ewma`, `holt_winters`, `prophet_lite`, `monte_carlo_parametric`, `monte_carlo_block_bootstrap` |
| `methods[].label` | string | Human-readable method name |
| `methods[].daily[]` | array | Daily forecast values (null for past, forecast for future) |
| `methods[].cumulative[]` | array | Cumulative sum including actual-to-date and method's forecast |
| `methods[].bands` | object \| null | Confidence bands (only for MC methods); `{ p10: [], p50: [], p90: [], ... }` per requested percentile |
| `methods[].error` | string \| null | Error code if method failed (e.g., `"forecast_failed"`) |
| `diagnostics` | object \| null | Walk-forward backtest results (null if `include_backtest=false`) |
| `diagnostics.backtest[].mae` | number | Mean Absolute Error (EUR) across all historical months |
| `diagnostics.backtest[].rmse` | number | Root Mean Squared Error (EUR) |
| `diagnostics.backtest[].mape` | number | Mean Absolute Percentage Error (%) |
| `diagnostics.backtest[].months` | integer | Number of months in backtest window |
| `diagnostics.backtest[].per_month[]` | array | Per-month accuracy breakdown |
| `category_breakdown[]` | array | Per-category breakdown with reconciliation (only if `include_breakdown=true`, Phase G) |
| `category_breakdown[].category_id` | number \| null | Category ID; null for uncategorized |
| `category_breakdown[].general` | string | General category name (e.g., "Groceries") |
| `category_breakdown[].detail` | string | Detail category name (e.g., "Supermarket") |
| `category_breakdown[].actual[]` | array | Per-category realized daily net (past and today) with cumulative |
| `category_breakdown[].forecast[]` | array | Per-category simple-average forecast (reconciled) |
| `category_breakdown[].cumulative[]` | array | Per-category cumulative series (actual + forecast) |

**Eight Forecasting Methods:**

| Method ID | Label | Type | Description |
|-----------|-------|------|-------------|
| `simple_avg` | Simple Average | Point | Per-day-of-month mean across history |
| `weighted_avg` | Weighted Average | Point | Linear recency weights (newer days matter more) |
| `ewma` | Exponential Moving Average | Point | Exponential smoothing (α=0.15) on daily flow |
| `holt_winters` | Holt-Winters | Point | Double exponential smoothing with weekly + monthly seasonality (M1=7, M2=30); 3⁴ grid search |
| `prophet_lite` | Prophet Lite | Point | Piecewise-linear trend + Fourier (K=3 weekly, K=10 yearly) + Belgian holiday dummies; needs ≥60 days or returns zeros |
| `monte_carlo_parametric` | Monte Carlo (Parametric) | Distribution | Gaussian sampling per (day-of-week, day-of-month) bucket; includes confidence bands |
| `monte_carlo_block_bootstrap` | Monte Carlo (Block Bootstrap) | Distribution | Stationary block bootstrap over detrended residuals (L=7 block length); includes confidence bands |
| `ensemble_imse` | Ensemble (inv-MSE) | Combination | Weighted average of 5 point methods using inverse-MSE (1/RMSE²) weights from historical accuracy; falls back to equal weights when accuracy data unavailable |

**Determinism & Reproducibility:**

Each Monte Carlo method uses a seeded PRNG derived from `hash(userId | yyyymm | filterHash)` to ensure:
- Same user, same month, same filters → identical samples across requests
- Enables ensemble combination and cross-session caching
- `filterHash` includes currency, excluded categories, excluded recipients, and `include_planned` flag

See [[apps/node-backend/src/services/calculations/forecast/index.js|Forecast Service]] for implementation details.

**Caching (Phase E):**

When using default parameters (mc_paths=1000, mc_percentiles=[10,50,90]), responses are served from a 6-hour TTL cache:
- `meta.source === 'cache'` indicates cached result (likely within last 6 hours, from nightly pre-compute)
- `meta.source === 'live'` indicates freshly computed result (custom parameters or cache miss/expiry)
- Nightly job (`refreshCashflowForecastMc`) precomputes forecasts for all active users at ~02:00 UTC
- Cache lookup is O(1) DB query (~5ms); live computation with 1000 paths ≈ 300-500ms

**Ensemble Method (Phase F):**

The 8th method (`ensemble_imse`) is a weighted combination of the 5 point-forecast methods:
- Weights derived from inverse-MSE (1/RMSE²) of historical accuracy metrics in `cashflow_forecast_accuracy` table
- Higher-performing methods (lower RMSE) receive higher weights; weights always sum to 1.0
- Falls back to equal weights (0.2 per method) on first run or when accuracy data is unavailable (e.g., after migration)
- Runs after all 7 base methods; excludes MC methods and any errored methods from the combination
- Provides a data-driven forecast without requiring manual tuning
- Ensemble diagnostics available in response: `diagnostics.ensemble_weights` shows per-method inverse-MSE weights

**Frontend Integration (Phase C):**

---

### Cash Flow Forecast Accuracy (Phase D)

Persisted monthly backtest accuracy metrics (MAE/RMSE/MAPE) per forecasting method. Enables trend analysis and sparkline visualization in the diagnostics panel.

**Path:** `GET /api/aggregations/cashflow-forecast-accuracy`

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `limit_months` | integer | 24 | 120 | Historical window to return (in months) |

**Response (data field):**

```json
{
  "methods": [
    {
      "method_id": "simple_avg",
      "as_of_month": "2026-04",
      "mae": 125.45,
      "rmse": 165.30,
      "mape": 8.2,
      "sample_days": 28,
      "history": [
        {
          "month": "2025-12",
          "mae": 115.20,
          "rmse": 155.80,
          "mape": 7.8,
          "sample_days": 28
        },
        {
          "month": "2026-01",
          "mae": 132.50,
          "rmse": 175.20,
          "mape": 8.5,
          "sample_days": 31
        },
        {
          "month": "2026-04",
          "mae": 125.45,
          "rmse": 165.30,
          "mape": 8.2,
          "sample_days": 24
        }
      ]
    },
    {
      "method_id": "ewma",
      "as_of_month": "2026-04",
      "mae": 110.80,
      "rmse": 150.20,
      "mape": 7.1,
      "sample_days": 28,
      "history": [/* ... */]
    }
  ],
  "limit_months": 24
}
```

**Field Descriptions:**

| Field | Type | Meaning |
|-------|------|---------|
| `methods[]` | array | Per-method accuracy records and historical trend |
| `method_id` | string | Forecasting method identifier (same 7 methods as Phase 10) |
| `as_of_month` | string | Latest month with accuracy data (YYYY-MM format) |
| `mae` | number | Mean Absolute Error for latest month (EUR or currency) |
| `rmse` | number | Root Mean Squared Error for latest month |
| `mape` | number | Mean Absolute Percentage Error for latest month (%) |
| `sample_days` | integer | Days included in latest month's backtest |
| `history[]` | array | Time-series of accuracy metrics (newest first, up to `limit_months`) |
| `history[].month` | string | Month in YYYY-MM format |
| `history[].mae` | number | MAE for that month |
| `history[].rmse` | number | RMSE for that month |
| `history[].mape` | number | MAPE for that month (%) |
| `history[].sample_days` | integer | Days in that month's backtest |
| `limit_months` | integer | Historical window returned |

**Frontend Usage:**

```typescript
const envelope = await apiClient.getCashflowForecastAccuracy({
  limit_months: 24
});

// Group by method for dashboard
const methodAccuracy: Record<string, AccuracyMethodEntry> = {};
envelope.data.methods.forEach((m) => {
  methodAccuracy[m.method_id] = m;
});

// Render sparkline for each method using history array
methodAccuracy.simple_avg.history.forEach((point) => {
  console.log(`${point.month}: MAE=${point.mae}`);
});
```

**Data Source & Persistence:**

- Table: `cashflow_forecast_accuracy` (created by Alembic migration 0012_cashflow_forecast_accuracy)
- UPSERT on (user_id, method_id, as_of_month) — idempotent
- Populated by nightly batch job (Phase G) or manual updates from `/api/aggregations/cashflow-forecast-methods` backtest
- **Fallback (April 2026):** If the database is unreachable or the table is missing, backend's `accuracyStore` falls back to an in-memory Map for backward compatibility:
  - Triggers on error codes: `42P01` (undefined_table), `ECONNREFUSED` (DB unreachable), `ENOTFOUND` (host unresolved), `ETIMEDOUT` (connection timeout)
  - Supports dev/test environments without a running PostgreSQL instance
  - Fallback is silent; forecast endpoints remain usable with or without accuracy persistence

**Use Cases:**

1. **Trend Analysis:** Visualize MAE improvement/degradation over time per method
2. **Ensemble Weighting:** Inverse-MSE weights proportional to historical accuracy (Phase G)
3. **Diagnostics Dashboard:** Sparklines in right-panel showing 24-month accuracy trends
4. **Method Stability:** Identify which methods are consistently accurate vs. noisy

---

Dashboard visualization via `CashFlowForecastChart` component:
- Multi-method chart with all 8 forecasting methods available (5 point + 2 MC + 1 ensemble)
- **Default visibility:** Displays 6 methods by default — 5 point methods (Simple Average, Weighted Average, EWMA, Holt-Winters, Prophet Lite) + Ensemble inv-MSE. Monte Carlo methods are hidden by default but can be toggled on via pill controls to reduce clutter in the default view.
- View toggle (cumulative balance vs. daily net) via Tabs
- Per-method visibility toggles via pill buttons
- Monte Carlo confidence bands (P10/P90) as dashed LineSeries (visible when MC methods are toggled on)
- Planned transaction overlay switch (refetches with `include_planned=true`)
- Diagnostics panel showing backtest accuracy metrics and ensemble weight preview

See [[docs/components/dashboard|Dashboard Components]] for component documentation.

**Walk-Forward Backtest:**

If `include_backtest=true` (default), the response includes accuracy metrics computed via walk-forward validation:
- For each historical month, refit all 7 methods on prior `history_months` and forecast that month's actual
- Compute MAE (mean absolute error), RMSE, and MAPE (mean absolute % error)
- Aggregate across all historical windows; also return per-month breakdown
- Helps identify which methods perform best on your data; ensemble Phase F will use these metrics

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
| 400 | `{ "ok": false, "error": { "code": "APP_ERROR", "message": "Invalid currency code" } }` | Malformed currency param |
| 500 | `{ "ok": false, "error": { "code": "APP_ERROR", "message": "Error computing aggregation: {label}" } }` | Server error during computation |

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
await apiClient.getSankeyFlow({ year: 2026, currency: 'EUR' }); // Phase 7
await apiClient.getAggregationRecipientPivot({ // Custom Charts feature
  currency: 'EUR',
  time_bucket: 'monthly',
  recipient_ids: [10, 11],
  category_ids: [5, 7]
});

// Forecast endpoints
await apiClient.getCashflowForecastMethods({ // Phase 10 + C + F
  currency: 'EUR',
  history_months: 36,
  include_backtest: true
});
await apiClient.getCashflowForecastRolling({ // Phase H (rolling window)
  days_forward: 30,
  days_back: 90,
  currency: 'EUR'
});
await apiClient.getCashflowForecastAccuracy({ limit_months: 24 }); // Phase D
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
