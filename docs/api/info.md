---
title: Info & Analytics API
type: endpoint
status: active
date: 2026-04-09
tags: [api, analytics, statistics, dashboard]
description: API endpoints for statistics, analytics, and dashboard data
aliases: [info-api, analytics-api, statistics-api, dashboard-api]
related_code: ["apps/node-backend/src/routes/info.js", "apps/node-backend/src/repositories/infoRepository.js", "apps/node-backend/src/services/currencyConversionService.js"]
---

# Info & Analytics API

Comprehensive analytics and statistics endpoints for dashboards and financial insights.

## Base URL

```
/api/info
```

## Currency Query Parameters

- Conversion-capable info endpoints accept `currency` (preferred) and `target_currency` (alias).
- Values are normalized to uppercase 3-letter codes.
- Invalid/unsupported target values fall back to EUR behavior.

## Endpoints

### GET /api/info

Get general statistics about the workspace.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `currency` | string | Target 3-letter currency code for converted totals (default: EUR) |
| `target_currency` | string | Alias for `currency` |

**Response:** `200 OK`

```json
{
  "total_transactions": 1250,
  "total_recipients": 45,
  "total_categories": 28,
  "total_investments": 15,
  "categories": [...]
}
```

---

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
    { "key": "kbc", "name": "KBC", "adapter_class": "KBCAdapter" },
    { "key": "belfius", "name": "Belfius", "adapter_class": "BelfiusAdapter" },
    { "key": "revolut", "name": "Revolut", "adapter_class": "RevolutAdapter" },
    { "key": "vision", "name": "Vision", "adapter_class": "VisionAdapter" },
    { "key": "sabb", "name": "SABB", "adapter_class": "SABBAdapter" },
    { "key": "wise", "name": "Wise", "adapter_class": "WiseAdapter" }
  ],
  "total_count": 6
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

### GET /api/info/transaction-summary

Get transaction summary with optional filters.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `bank_account` | string | Filter by bank account |
| `start_date` | date | Start date (YYYY-MM-DD) |
| `end_date` | date | End date (YYYY-MM-DD) |
| `currency` | string | Target 3-letter currency code for converted totals (default: EUR) |
| `target_currency` | string | Alias for `currency` |

**Response:** `200 OK`

```json
{
  "total_count": 150,
  "total_income": 5000.00,
  "total_expenses": -3200.00,
  "net": 1800.00
}
```

---

### GET /api/info/monthly-summary

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
- Internal repository refactor extracted shared monthly summary aggregation logic (`buildMonthlySummary`) to remove duplicate summary reducers across MV and fallback paths without changing endpoint output semantics ([[apps/node-backend/src/repositories/infoRepository.js]]).
- Internal repository refactor now also reuses a shared row-mapping helper (`mapRowsForAmountConversion`) across summary/cashflow/planned/insights conversions to remove repeated `parseFloat` mapping while preserving all endpoint contracts and conversion semantics ([[apps/node-backend/src/repositories/infoRepository.js]]).
- Internal repository refactor additionally consolidates repeated date-to-`YYYY-MM-DD` normalization behind `formatDateToYmd()` to reduce formatting duplication without changing output fields or date semantics ([[apps/node-backend/src/repositories/infoRepository.js]]).
- Internal repository refactor also centralizes repeated month-key formatting/extraction (`formatYearMonthKey`, `extractYearMonth`, `formatDateToYm`) used by monthly summary, bank history, spending trend, and MoM period logic; response fields and values remain unchanged ([[apps/node-backend/src/repositories/infoRepository.js]]).
- Monthly-summary MV fast path removed a redundant unused conversion pass (`mvConverted`) while keeping the merged income/spending conversion output path unchanged ([[apps/node-backend/src/repositories/infoRepository.js]]).

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

### GET /api/info/average-vs-current-spending

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

### GET /api/info/cashflow-comparison

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

---

### GET /api/info/category-breakdown

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

Implementation note:
- Route now calls dedicated repository method `getCategoryBreakdown(targetCurrency)` instead of full `getStatistics(...)`, avoiding unrelated top-level stats computation while preserving payload shape (`{ categories, links: [] }`) and currency behavior ([[apps/node-backend/src/routes/info.js]], [[apps/node-backend/src/repositories/infoRepository.js]]).
- Category aggregation in MV-backed breakdown/statistics paths now uses map-based merge helpers instead of repeated array `.find(...)` scans, reducing merge complexity while preserving category totals/counts and sort order ([[apps/node-backend/src/repositories/infoRepository.js]]).

---

### GET /api/info/bank-balances

Get current and historical balances per bank account.

Notes:
- For non-EUR targets, conversion is date-aware for both the current account balances and monthly history rows.
- Historical FX lookup uses each row `date` when converting bank-balance datasets.
- If historical conversion fails for a row set, conversion retries with latest available rates so the endpoint still returns balance data.
- Internal repository refactor extracted shared historical-FX fallback conversion helper for current balances and history rows, preserving identical fallback behavior while reducing duplication ([[apps/node-backend/src/repositories/infoRepository.js]]).

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

### GET /api/info/recipient-insights

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

Get pre-computed portfolio performance snapshots with per-class breakdowns.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `start_date` | string | `2000-01-01` | Start date filter (YYYY-MM-DD) |
| `end_date` | string | today | End date filter (YYYY-MM-DD) |
| `currency` | string | EUR | Target 3-letter currency code |
| `target_currency` | string | EUR | Alias for `currency` |

Notes:
- Reads from the `portfolio_performance_snapshots` table — no on-demand computation.
- Returns daily snapshots with per-class value/invested breakdowns (stocks+ETFs, crypto, metals).
- Includes inflation-adjusted values using Belgian monthly inflation rates.
- Route-level rate limited (`30 req / 60s`) to protect against excessive queries.
- Internal route refactor extracted shared snapshot payload mapping and date-string helpers (`mapPortfolioPerformanceSnapshot`, `buildPortfolioPerformancePayload`, `getCurrentDateString`) to remove duplication without changing response shape or field semantics ([[apps/node-backend/src/routes/info.js]]).
- Snapshot service import is now module-scoped for this route and cache warmer (`warmInfoCaches`) to remove repeated dynamic-import overhead while preserving cache semantics and response payloads ([[apps/node-backend/src/routes/info.js]]).

Caching behavior (route-level):
- Shared cache/inflight utilities (`getFreshCachedData`, `setCachedData`, `setInflightCache`, `resolveCacheWithInflight`) now power both `/api/info/net-worth` and `/api/info/portfolio-performance` response caches.
- This keeps TTL and concurrent-request deduplication behavior consistent while preserving existing API contracts and payloads ([[apps/node-backend/src/routes/info.js]]).

**Response:** `200 OK`

```json
{
  "currency": "EUR",
  "start_date": "2025-01-01",
  "end_date": "2026-03-31",
  "snapshots": [
    {
      "date": "2025-01-15",
      "invested": 50000.00,
      "value": 52500.00,
      "stocks_etfs_value": 30000.00,
      "crypto_value": 10000.00,
      "metals_value": 12500.00,
      "stocks_etfs_invested": 28000.00,
      "crypto_invested": 9500.00,
      "metals_invested": 12500.00,
      "inflation_adjusted_value": 51800.00,
      "gain_loss": 2500.00,
      "return_pct": 5.0
    }
  ]
}
```

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

Code links: [[apps/node-backend/src/repositories/infoRepository.js]], [[apps/node-backend/src/services/currencyConversionService.js]], [[apps/node-backend/src/services/belgianInflationService.js]], [[apps/node-backend/src/routes/info.js]], [[apps/node-backend/tests/infoRepository.test.js]]
