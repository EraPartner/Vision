---
title: Info & Analytics API
type: endpoint
status: active
date: 2026-04-25
updated: 2026-06-19
tags: [api, analytics, statistics, dashboard, phase-g-deprecation, ing, bnp, supported-adapters]
description: API endpoints for statistics, analytics, and dashboard data. Phase G removed 6 overlapping endpoints; see aggregations API for their replacements. May 2026: Added ING and BNP Paribas Fortis adapters (8 total banks supported).
aliases: [info-api, analytics-api, statistics-api, dashboard-api]
related_code: ["apps/node-backend/src/routes/info.js", "apps/node-backend/src/repositories/infoRepository.js", "apps/node-backend/src/repositories/infoRepositoryHelpers.js", "apps/node-backend/src/repositories/infoRepositoryStatistics.js", "apps/node-backend/src/repositories/infoRepositoryMonthly.js", "apps/node-backend/src/repositories/infoRepositoryBanks.js", "apps/node-backend/src/repositories/infoRepositoryNetWorth.js", "apps/node-backend/src/repositories/infoRepositoryPlanned.js", "apps/node-backend/src/repositories/infoRepositoryRecipients.js", "apps/node-backend/src/services/currency/currencyConversionService.js", "apps/node-backend/src/services/portfolioPerformanceSnapshotService.js", "apps/node-backend/src/utils/downsample.js"]
---

# Info & Analytics API

Comprehensive analytics and statistics endpoints for dashboards and financial insights.

> [!warning] Phase G Consolidation (April 2026)
> Six endpoints were removed and migrated to `/api/aggregations/*` (see [[#removed-endpoints-phase-g|Removed Endpoints]] below). Remaining endpoints continue as the production API surface. Earlier phases (2-8) migrated new logic to aggregations (see [[docs/adr/010-phase1-aggregation-strategy]], [[docs/adr/011-phase2-aggregation-envelope-standard]], [[docs/adr/016-aggregation-shadow-mode]]). See [[docs/reference/api-endpoint-matrix#phase-g-endpoint-consolidation|API Endpoint Matrix Phase G]] for consolidation summary.

## Base URL

```
/api/info
```

## Currency Query Parameters

- Conversion-capable info endpoints accept `currency` (preferred) and `target_currency` (alias).
- Values are normalized to uppercase 3-letter codes.
- Invalid/unsupported target values fall back to EUR behavior.

## Monetary Precision (Phase 9)

All monetary values in responses use **Decimal.js** for precision to eliminate IEEE 754 floating-point drift. Values are serialized as JSON `number` type, safe to 2 decimal places (cents). This enforcement is applied at the repository layer; see [[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021]] and [[docs/reference/code-patterns#money-utility-pattern-phase-9|Money Utility Pattern]] for implementation details.

## Endpoints

### GET /api/info/banks

List all bank accounts in the workspace.

**Response:** `200 OK`

```json
{
  "banks": [
    { "id": 1, "name": "Main Account", "balance": 5000.00 }
  ]
}
```

---

### GET /api/info/supported-adapters

List all supported bank adapters.

**Response:** `200 OK`

```json
{
  "adapters": [
    { "key": "belfius", "name": "Belfius", "adapter_class": "BelfiusAdapter" },
    { "key": "revolut", "name": "Revolut", "adapter_class": "RevolutAdapter" },
    { "key": "ing", "name": "ING", "adapter_class": "INGAdapter" },
    { "key": "kbc", "name": "KBC", "adapter_class": "KBCAdapter" },
    { "key": "bnp", "name": "BNP Paribas Fortis", "adapter_class": "BNPAdapter" },
    { "key": "sabb", "name": "SABB", "adapter_class": "SABBAdapter" },
    { "key": "wise", "name": "Wise", "adapter_class": "WiseAdapter" },
    { "key": "vision", "name": "Vision", "adapter_class": "VisionAdapter" }
  ],
  "total_count": 8
}
```

---

### GET /api/info/transaction-count

Get total number of transactions.

**Response:** `200 OK`

```json
{
  "total_transactions": 1250
}
```

---

### ~~GET /api/info/monthly-summary~~ *(removed — use `/api/aggregations/monthly-summary`)*

> **Removed in Phase G.** Route deleted. Use [[docs/api/aggregations|`GET /api/aggregations/monthly-summary`]] instead.

Get monthly financial summary for the last 12 months.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `excluded_category_ids` | number[] | Categories to exclude |
| `currency` | string | Target 3-letter currency code for converted amounts (default: EUR) |
| `target_currency` | string | Alias for `currency` |

**Response:** `200 OK`

```json
{
  "months": [
    {
      "month": "2025-03",
      "income": 5000.00,
      "expenses": -3200.00,
      "net": 1800.00
    }
  ],
  "summary": {
    "avg_income": 4800.00,
    "avg_expenses": -3100.00,
    "avg_net": 1700.00
  }
}
```

Notes:
- Historical currency conversion is date-aware for this endpoint: each transaction/month row is converted using its own row date (instead of latest FX rates).
- This makes month-over-month values stable across restarts and exchange-rate cache refreshes.
- Phase 3.1 refactoring: monolithic 1445-line repository split into 7 domain modules; monthly summary logic now in `monthlyRepository` (`infoRepositoryMonthly.js`). Shared helpers (`buildMonthlySummary`, `mapRowsForAmountConversion`, `formatDateToYmd`, `formatYearMonthKey`) extracted to `infoRepositoryHelpers.js` to eliminate duplication without changing endpoint contracts ([[apps/node-backend/src/repositories/infoRepositoryMonthly.js]]).
- Phase 3.1 optimization: income/spending rows batch-converted in 1 `convertRowsToEur` call via `batchConvertGroupsWithHistoricalRateFallback()` instead of separate conversions per month.
- Monthly-summary MV fast path removed a redundant unused conversion pass (`mvConverted`) while keeping the merged income/spending conversion output path unchanged.

---

### GET /api/info/planned-expenses-next-month

Get planned expenses for next month.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `currency` | string | Target 3-letter currency code for converted amounts (default: EUR) |
| `target_currency` | string | Alias for `currency` |

**Response:** `200 OK`

```json
{
  "total": 1200.00,
  "items": [
    {
      "id": 1,
      "recipient": "Rent",
      "amount": 1000.00,
      "planned_date": "2025-04-01"
    }
  ]
}
```

---

### ~~GET /api/info/average-vs-current-spending~~ *(removed — use `/api/aggregations/average-vs-current`)*

> **Removed in Phase G.** Use [[docs/api/aggregations|`GET /api/aggregations/average-vs-current`]] instead.

Compare current month spending to historical average.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `currency` | string | Target 3-letter currency code for converted amounts (default: EUR) |
| `target_currency` | string | Alias for `currency` |

**Response:** `200 OK`

```json
{
  "current_month": "2025-03",
  "current_spending": 2500.00,
  "average_spending": 2800.00,
  "difference": -300.00,
  "percent_change": -10.7
}
```

---

### ~~GET /api/info/cashflow-comparison~~ *(removed — use `/api/aggregations/cashflow-comparison`)*

> **Removed in Phase G.** Use [[docs/api/aggregations|`GET /api/aggregations/cashflow-comparison`]] instead.

Compare cashflow between periods.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `excluded_category_ids` | number[] | Categories to exclude |
| `excluded_recipient_ids` | number[] | Recipients to exclude |
| `currency` | string | Target 3-letter currency code for converted amounts (default: EUR) |
| `target_currency` | string | Alias for `currency` |

**Response:** `200 OK`

```json
{
  "current_period": {
    "income": 5000.00,
    "expenses": -3200.00,
    "net": 1800.00
  },
  "previous_period": {
    "income": 4500.00,
    "expenses": -2800.00,
    "net": 1700.00
  }
}
```

Notes:
- Historical and current transaction rows are converted with date-specific FX (`date` field).
- Planned rows are converted with date-specific FX using `planned_date`.
- This avoids retroactive movement of historical daily/average cashflow lines when latest exchange rates change.
- Phase 3.1 optimization: eliminated 3 redundant `exchange_rates` queries by batching all row groups into 1 `convertRowsToEur` call via `batchConvertGroupsWithHistoricalRateFallback()` helper.

---

### ~~GET /api/info/category-breakdown~~ *(removed — use `/api/aggregations/category-breakdown`)*

> **Removed in Phase G.** Use [[docs/api/aggregations|`GET /api/aggregations/category-breakdown`]] instead.

Get spending breakdown by category.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `currency` | string | Target 3-letter currency code for converted totals (default: EUR) |
| `target_currency` | string | Alias for `currency` |

**Response:** `200 OK`

```json
{
  "categories": [
    {
      "id": 1,
      "name": "FOOD:GROCERIES",
      "total": -450.00,
      "count": 15
    }
  ]
}
```

Implementation notes:
- Route calls dedicated repository method `getCategoryBreakdown(targetCurrency)` instead of full `getStatistics(...)`, avoiding unrelated top-level stats computation while preserving payload shape (`{ categories, links: [] }`) and currency behavior ([[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/repositories/infoRepository.js]]).
- Category aggregation in MV-backed breakdown/statistics paths uses map-based merge helpers instead of repeated array `.find(...)` scans, reducing merge complexity while preserving category totals/counts and sort order ([[apps/node-backend/src/repositories/infoRepository.js]]).
- Phase 3.1: categorization logic is part of `statisticsRepository` domain module within composite `infoRepository` barrel ([[apps/node-backend/src/repositories/infoRepositoryStatistics.js]]).

---

### ~~GET /api/info/bank-balances~~ *(removed — use `/api/aggregations/bank-balances`)*

> **Removed in Phase G.** Use [[docs/api/aggregations|`GET /api/aggregations/bank-balances`]] instead.

Get current and historical balances per bank account.

Notes:
- For non-EUR targets, conversion is date-aware for both the current account balances and monthly history rows.
- Historical FX lookup uses each row `date` when converting bank-balance datasets.
- If historical conversion fails for a row set, conversion retries with latest available rates so the endpoint still returns balance data.
- Phase 3.1 optimization: eliminated 1 redundant `exchange_rates` query by batching current balances and history rows into 1 `convertRowsToEur` call via `batchConvertGroupsWithHistoricalRateFallback()` helper; queries now execute in parallel via `Promise.all()` ([[apps/node-backend/src/repositories/infoRepository.js]]).

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `currency` | string | Target 3-letter currency code for converted balances (default: EUR) |
| `target_currency` | string | Alias for `currency` |

**Response:** `200 OK`

```json
{
  "accounts": [
    {
      "bank_account": "Main Account",
      "balance": 5000.00,
      "first_transaction": "2024-01-15",
      "last_transaction": "2025-03-18",
      "transaction_count": 450
    }
  ]
}
```

---

### GET /api/info/recurring-patterns

Detect recurring transaction patterns.

**Response:** `200 OK`

```json
{
  "patterns": [
    {
      "recipient_id": 1,
      "recipient_name": "Netflix",
      "amount": -15.99,
      "frequency": "monthly",
      "last_date": "2025-03-01"
    }
  ],
  "total": 1
}
```

---

### GET /api/info/net-worth

Get net worth combining bank balances + portfolio value.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `currency` | string | Target 3-letter currency code for converted snapshots (default: EUR) |
| `target_currency` | string | Alias for `currency` |

Notes:
- Route applies per-currency in-memory response caching (TTL 60s) to reduce repeated heavy repository recomputation on dashboard refreshes.
- Concurrent requests for the same currency are deduplicated in-flight and share the same repository promise.
- Route uses a modest per-route rate limiter (`30 requests / 60s` per key prefix) to protect expensive net-worth computations.
- Returns **daily** snapshots (not monthly) from the first available data date until today.
- Seed date (`first_data_date`) is the minimum of: first `portfolio_transactions.date`, first active `investments.created_at`, and first active `transactions.date`.
- If the active-only seed date is empty (legacy/partially-migrated data), backend automatically retries seed date discovery without active filters to avoid false all-zero responses.
- Portfolio contribution uses cumulative portfolio transaction cashflow from that seed date onward.
- Bank balance and portfolio series both start at `first_data_date`, so timelines include transaction-only workspaces (no investments).
- Historical conversion is date-aware for both bank history and portfolio history using each snapshot `day`.
- FX changes are reflected over time in historical snapshots (instead of applying only latest rates).
- If historical conversion fails for a snapshot set, conversion retries with latest available rates so net worth data still loads.
- When bank-account balance snapshots are unavailable, liquid net worth falls back to cumulative transaction flow (date- and currency-aware) so snapshots remain populated instead of returning empty liquid history.
- Regression coverage includes a transactions-only (no investments) case to ensure `/api/info/net-worth` still returns non-zero liquid/net worth when transaction data exists ([[apps/node-backend/tests/infoRepository.test.js]]).
- Latest snapshot investment value is reconciled from active investment holdings (`units` × `current_price` for unit-based assets, principal-based for savings/bonds, plus appreciation for real estate) so current net worth is not stuck at `0` when historical portfolio aggregation is sparse.
- Historical unit-priced investment valuation uses persisted/provider historical quotes first and falls back to transaction-derived unit price carry-forward when quote history is missing; it does not backfill past days from mutable `current_price`.
- Backend emits debug/warn/info logs for net worth computation context (`firstDataDate`, snapshot count, current totals, fallback usage) to speed up production troubleshooting without changing API shape.
- Daily net-worth snapshots are sanitized for isolated one-day investment spikes/troughs: confirmed outlier days are replaced with geometric interpolation (`sqrt(prev*next)`) and `netWorth` is recomputed with unchanged liquid value; `monthlyChange` and baseline calculations use sanitized snapshots ([[apps/node-backend/src/repositories/infoRepository.js]], [[apps/node-backend/tests/infoRepository.test.js]]).
- Net-worth daily timeline loops were refactored around shared UTC/day helpers (`addDaysUtc`, `getDayKeyUtc`, `getUtcDayEndTimestamp`) to reduce repeated ad-hoc date key/timestamp construction while preserving endpoint behavior and output semantics ([[apps/node-backend/src/repositories/infoRepository.js]]).

**Response:** `200 OK`

```json
{
  "current": {
    "liquid": 25000.0,
    "investments": 125000.0,
    "netWorth": 150000.0
  },
  "monthlyChange": 500.0,
  "monthlyChangePercent": 0.33,
  "snapshots": [
    {
      "date": "2026-01-15",
      "liquid": 24000.0,
      "investments": 120000.0,
      "netWorth": 144000.0
    }
  ]
}
```

---

### GET /api/info/net-worth/by-account

Net worth split per account (Σ-accounts, ADR-100): each account's current cash + holdings and its rebuilt daily holdings history. The Σ over accounts equals the aggregate net worth by construction. Only accounts with `in_net_worth = true` contribute the cash side (ADR-089); legacy holdings with no account collapse into a single unassigned row (`accountId: null`, holdings only).

**Query parameters:** `currency` (alias `target_currency`, default `EUR`) — all amounts are converted to this currency.

**Notes:**

- Route uses a modest per-route rate limiter (`30 requests / 60s` per key prefix) shared with the net-worth cache.
- Per-account current cash is converted from each account's native currency at the latest rate; holdings come from the daily value-by-account split rebuilt by the holdings-history builder.

**Response:** `200 OK`

```json
{
  "currency": "EUR",
  "accounts": [
    {
      "accountId": 1,
      "name": "Brokerage",
      "currency": "USD",
      "cash": 1500.0,
      "currentHoldings": 84000.0,
      "currentTotal": 85500.0,
      "holdingsSeries": [
        { "date": "2026-06-18", "holdings": 84000.0 }
      ]
    }
  ]
}
```

---

### ~~GET /api/info/recipient-insights~~ *(removed — use `/api/aggregations/recipient-insights`)*

> **Removed in Phase G.** Use [[docs/api/aggregations|`GET /api/aggregations/recipient-insights`]] instead.

Get spending insights per recipient/merchant.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `currency` | string | Target 3-letter currency code for converted spend metrics (default: EUR) |
| `target_currency` | string | Alias for `currency` |

**Response:** `200 OK`

```json
{
  "recipients": [
    {
      "id": 1,
      "name": "Supermarket",
      "total_spent": -1200.00,
      "transaction_count": 25,
      "avg_transaction": -48.00,
      "last_transaction": "2025-03-15"
    }
  ]
}
```

---

### GET /api/info/exchange-rates

Get cached exchange rates from database.

Notes:
- Rates are fetched from ECB and supplemented with open.er-api for non-ECB currencies.
- Stats endpoints can be requested in any valid 3-letter code (ISO-style), with EUR fallback when invalid.
- Core tested currencies include EUR, USD, GBP, SAR, AED.
- Latest exchange-rate rows are updated per currency while historical rows are preserved.
- Route imports for DB/currency services are now module-scoped (instead of per-request dynamic imports) to remove avoidable hot-path import overhead while preserving endpoint behavior and response contracts ([[apps/node-backend/src/routes/info.js]]).
- In-memory net-worth and portfolio-performance response caches now prune expired entries opportunistically and enforce a bounded size (`MAX_CACHE_ENTRIES`) to avoid unbounded growth across many currency/date key combinations while preserving cache-hit/inflight-dedupe semantics ([[apps/node-backend/src/routes/info.js]]).

**Response:** `200 OK`

```json
{
  "total_rates": 30,
  "rates": [
    { "currency": "USD", "rate_to_eur": 0.92, "rate_date": "2025-03-18", "fetched_at": "2025-03-18T10:30:00Z" }
  ],
  "fallback_rates": { "USD": 0.917, "GBP": 1.176 }
}
```

---

### POST /api/info/exchange-rates/refresh

Force refresh exchange rates from ECB API.

**Response:** `200 OK`

```json
{
  "message": "Exchange rates refreshed from ECB"
}
```

---

### GET /api/info/inflation-rates

Get Belgian monthly inflation rates used by portfolio real-return calculations.

Notes:
- Source data is fetched from Statbel with Eurostat HICP index as fallback and cached server-side.
- Response `source` indicates where the response came from: `memory`, `database`, `statbel`, or `eurostat`.
- Supports optional month filtering with `start_month` and `end_month` in `YYYY-MM` (or `YYYY-MM-DD`, month part is used).
- Supports optional `db_only=true|1` to force persisted DB rates for immediate responses (decoupled from external API latency).
- When `db_only` is enabled, the backend serves DB rates immediately and schedules background external refresh (Statbel then Eurostat fallback) without blocking the response.
- Statbel fetch uses retry + backoff across multiple candidate Statbel base URLs.
- On Statbel failure, service attempts Eurostat HICP monthly index and derives monthly inflation as month-over-month index change.
- If both external sources fail, API falls back to persisted DB rates and warning logs are throttled to reduce noise during prolonged outages.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `start_month` | string | Start month filter (`YYYY-MM`) |
| `end_month` | string | End month filter (`YYYY-MM`) |
| `db_only` | boolean | If `true`/`1`, return persisted DB rates only and do external refresh in background |

**Response:** `200 OK`

```json
{
  "source": "database",
  "total_rates": 24,
  "rates": [
    { "month": "2024-01", "monthly_rate": 0.0021 },
    { "month": "2024-02", "monthly_rate": 0.0018 }
  ]
}
```

---

### POST /api/info/inflation-rates/refresh

Force refresh Belgian inflation rates from Statbel.

Notes:
- Admin-limited endpoint (same admin limiter pattern as exchange-rate refresh).
- Clears in-memory cache and repopulates persisted monthly rates.

**Response:** `200 OK`

```json
{
  "message": "Belgian inflation rates refreshed from Statbel",
  "source": "statbel",
  "total_rates": 120
}
```

---

### GET /api/info/portfolio-performance

Get pre-computed portfolio performance snapshots with enriched metrics, heatmap, and breakdown summary.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `period` | string | `all` | Period filter: `5d`, `1m`, `3m`, `6m`, `1y`, `3y`, or `all` |
| `currency` | string | EUR | Target 3-letter currency code |
| `target_currency` | string | EUR | Alias for `currency` |

Notes:
- **Backend-computed response**: Metrics, heatmap, and per-investment breakdown are now computed server-side (no client-side computation). Client receives final aggregates ready to render.
- **Period filtering**: `period` parameter controls which snapshots are returned for charting (5d/1m/3m/6m/1y/3y/all). Metrics and heatmap always use full historical data.
- **Short-period (5d) support**: New 5d period enables daily data inspection. Frontend applies adaptive chart formatting for short periods (≤6m): x-axis shows day+month (e.g., "15 Jan"), y-axis uses `auto/auto` domain to zoom into data range.
- **Downsampling**: Period-filtered snapshots are downsampled server-side to 400 points using LTTB algorithm for efficient charting.
- **Heatmap correction**: Monthly heatmap now uses contribution-adjusted returns: `((curr.value / curr.invested) / (prev.value / prev.invested) - 1) * 100`. This fixes the old frontend formula which conflated cash deposits/withdrawals with investment performance.
- **Pre-converted values**: Breakdown summary values are converted to target currency server-side; client receives final amounts.
- **Cache key**: Response cache key now includes period: `${currency}:${period}` to preserve separate cached responses per period.
- Reads from the `portfolio_performance_snapshots` table — no on-demand computation.
- Includes per-class value/invested breakdowns (stocks+ETFs, crypto, metals) in metrics.
- Route-level rate limited (`30 req / 60s`) to protect against excessive queries.
- Caching behavior: shared cache/inflight utilities (`getFreshCachedData`, `setCachedData`, `setInflightCache`, `resolveCacheWithInflight`) now power both `/api/info/net-worth` and `/api/info/portfolio-performance` response caches for consistent TTL and concurrent-request deduplication ([[apps/node-backend/src/routes/info.js]]).
- `warmInfoCaches` now warms the `all` period (full historical data) for instant startup responses ([[apps/node-backend/src/routes/info.js]]).

**Response:** `200 OK`

```json
{
  "currency": "EUR",
  "start_date": "2000-01-01",
  "end_date": "2026-04-16",
  "snapshots": [
    {
      "date": "2026-04-01",
      "invested": 50000.00,
      "value": 52500.00,
      "stocks_etfs_value": 30000.00,
      "crypto_value": 10000.00,
      "metals_value": 12500.00,
      "stocks_etfs_invested": 28000.00,
      "crypto_invested": 9500.00,
      "metals_invested": 12500.00
    }
  ],
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
    "data": {
      "2025": {
        "01": 1.5,
        "02": 2.1,
        "03": -0.8
      },
      "2026": {
        "01": 3.2,
        "02": 1.9,
        "03": 0.5,
        "04": null
      }
    },
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

**Response Field Descriptions:**

- `snapshots`: Period-filtered (1m/3m/6m/1y/3y/all) and LTTB-downsampled to ~400 points for efficient charting
- `metrics`: Overall portfolio performance metrics computed from full historical data
  - `currentValue`: Latest portfolio value
  - `totalInvested`: Total buy cost (in target currency)
  - `totalGainLoss`: Absolute gain/loss (currentValue - totalInvested)
  - `totalReturnPct`: Simple return percentage
  - `annualizedReturn`: CAGR (Compound Annual Growth Rate) from inception to today
  - `realReturnPct`: Inflation-adjusted return using Belgian monthly rates
  - `cumulativeInflation`: Total inflation impact over period
- `heatmap`: Monthly contribution-adjusted returns by year-month (uses corrected formula)
  - `years`: Array of year keys
  - `data`: Nested object `{year: {month: percent}}`; `null` for missing months
  - `maxAbsPct`: Max absolute percentage (for chart color scaling)
- `breakdownSummary`: Per-investment summary with pre-converted currency values
  - All monetary fields (`currentValue`, `totalInvested`, `gainLoss`) are in target currency
  - `gainLossPercent`: Per-investment return percentage

---

### POST /api/info/refresh-views

Manually refresh materialized views.

**Response:** `200 OK`

```json
{
  "message": "Materialized views refreshed",
  "duration_ms": 150
}
```

Security/performance notes:
- Endpoint now uses `adminRateLimiter` to protect materialized-view refresh from abuse bursts.
- Route registration/behavior is covered by targeted tests in [[apps/node-backend/tests/routes/info.test.js]].

Code links: [[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/middleware/rateLimiter.js]]

---

## Removed Endpoints (Phase G)

The following endpoints were removed in Phase G (April 2026) as they are now handled by `/api/aggregations/*` equivalents:

1. **`GET /api/info/monthly-summary`** → Use [[docs/api/aggregations#monthly-summary|`GET /api/aggregations/monthly-summary`]]
2. **`GET /api/info/average-vs-current-spending`** → Use [[docs/api/aggregations#average-vs-current|`GET /api/aggregations/average-vs-current`]]
3. **`GET /api/info/cashflow-comparison`** → Use [[docs/api/aggregations#cashflow-comparison|`GET /api/aggregations/cashflow-comparison`]]
4. **`GET /api/info/category-breakdown`** → Use [[docs/api/aggregations#category-breakdown|`GET /api/aggregations/category-breakdown`]]
5. **`GET /api/info/bank-balances`** → Use [[docs/api/aggregations#bank-balances|`GET /api/aggregations/bank-balances`]]
6. **`GET /api/info/recipient-insights`** → Use [[docs/api/aggregations#recipient-insights|`GET /api/aggregations/recipient-insights`]]

**Frontend impact:** Four of these have `apiClient` method equivalents (`getMonthlyFinancialSummary()`, `getCashflowComparison()`, `getBankBalances()`, `getRecipientInsights()`) which now proxy to aggregations and unwrap the response envelope transparently. See [[docs/reference/api-client-methods#info--statistics-phase-g-aggregation-migration|API Client Methods]] for details.

**Historical note:** Earlier sections still document the deprecated endpoints with their response schema for reference. These routes return 404 in production after Phase G.

## Removed Endpoints (Phase 9)

The following endpoints were removed during Phase 9 cutover as they were superseded or no longer in use:

1. **`GET /api/info`** — General workspace statistics (total transactions, recipients, categories, investments). Removed; use targeted endpoints or `/api/aggregations/*` for similar aggregated data.
2. **`GET /api/info/transaction-summary`** — Transaction summary with bank/date/currency filters. Removed; use `GET /api/transactions` with filtering params for equivalent data.

---

## Use Cases

- **Dashboard**: Display key metrics on home screen
- **Reports**: Generate monthly/quarterly reports
- **Trends**: Analyze spending patterns over time
- **Budgeting**: Compare actual vs. expected spending

---

## Performance

These endpoints are optimized using:
- [[docs/performance/materialized-views]] - Pre-computed aggregations
- [[docs/performance/caching-strategies]] - Cached exchange rates

---

## See Also

- [[docs/api/index]] - API Index
- [[docs/features/transactions]] - Transactions Feature
- [[docs/performance/materialized-views]] - Materialized Views

Code links: [[apps/node-backend/src/repositories/infoRepository.js]] (barrel), [[apps/node-backend/src/repositories/infoRepositoryHelpers.js]] (shared), [[apps/node-backend/src/repositories/infoRepositoryMonthly.js]] (monthly), [[apps/node-backend/src/repositories/infoRepositoryBanks.js]] (banks), [[apps/node-backend/src/repositories/infoRepositoryNetWorth.js]] (net worth), [[apps/node-backend/src/repositories/infoRepositoryStatistics.js]] (stats), [[apps/node-backend/src/repositories/infoRepositoryPlanned.js]] (planned), [[apps/node-backend/src/repositories/infoRepositoryRecipients.js]] (recipients), [[apps/node-backend/src/services/currency/currencyConversionService.js]], [[apps/node-backend/src/services/belgianInflationService.js]], [[apps/node-backend/src/routes/info.js]], [[apps/node-backend/tests/infoRepository.test.js]]
