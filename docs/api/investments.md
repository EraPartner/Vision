---
title: API - Investments
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/investments
description: Investment portfolio management (stocks, crypto, real estate, savings)
date: 2026-04-21
tags: [api, investments, portfolio, stocks, crypto, metals]
status: active
aliases: [investments-api, portfolio-api, holdings, stocks, crypto, real-estate, savings, bonds, metals]
related_code: [[apps/node-backend/src/routes/investments.js]], [[apps/node-backend/src/repositories/investmentRepository.js]]
---

# Investments API

## Overview

The Investments API manages investment holdings across various asset classes: stocks, ETFs, crypto, metals, real estate, savings, and bonds. It supports live price feeds from multiple providers.

The storage layer uses PostgreSQL inheritance (`investments_base` + asset-specific child tables, and `portfolio_transactions_base` + transaction child tables) while preserving API compatibility via legacy views (`investments`, `portfolio_transactions`).

## Endpoints

### GET /api/investments

Retrieve a list of investments.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 200 | Max items (max 1000) |
| offset | integer | 0 | Items to skip |
| asset_class | string | null | Filter by asset class |
| active | boolean | true | Show active/inactive |

**Asset Class Values:** stock, etf, crypto, metals, real_estate, savings, bond

**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "name": "Apple Inc.",
      "symbol": "AAPL",
      "asset_class": "stock",
      "currency": "USD",
      "current_price": 185.50,
      "interest_rate": null,
      "maturity_date": null,
      "location": null,
      "municipality": null,
      "cadastral_income": null,
      "municipality_tax_rate": null,
      "notes": "Tech stock",
      "is_active": true,
      "price_provider": "yahoo",
      "price_provider_id": "AAPL",
      "price_provider_url": null,
      "price_provider_latest_url": null,
      "price_provider_latest_path": null,
      "price_provider_history_url": null,
      "price_provider_history_path": null,
      "price_provider_history_ts_path": null,
      "price_provider_history_price_path": null,
      "price_updated_at": "2026-03-18T10:00:00Z",
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-03-18T10:00:00Z"
    }
  ],
  "total": 50,
  "limit": 200,
  "offset": 0,
  "links": []
}
```

Notes:
- Internal route refactor consolidated shared query/ID parsing helpers (`parseDefaultListOptions`, `parseBulkTransactionsOptions`, `parseInvestmentTransactionsOptions`, `parseDbOnlyQueryValue`, `parseRequestId`, `parseTxnRequestId`) to reduce duplication while preserving all defaults, clamping rules, and endpoint response semantics ([[apps/node-backend/src/routes/investments.js]]).
- Follow-up route refactor extracted shared transaction-id validation for transaction mutation endpoints via `parseAndValidateTxnRequestId(req, res)` and centralized validation-error response mapping via `handleValidationError(res, err)`; status codes and error payloads remain unchanged ([[apps/node-backend/src/routes/investments.js]]).
- Investment list (`GET /api/investments`) and per-investment transaction list (`GET /api/investments/:id/transactions`) now use repository one-query pagination helpers (`getAllWithCount`) instead of separate list/count route calls, preserving filters, totals, ordering, and response payload shape ([[apps/node-backend/src/routes/investments.js]], [[apps/node-backend/src/repositories/investmentRepository.js]], [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]).

### GET /api/investments/providers

Get supported price providers.

**Response:**
```json
{
  "providers": [
    { "key": "manual", "name": "Manual", "description": "Set price manually" },
    { "key": "binance", "name": "Binance", "description": "Crypto prices (use trading pair, e.g. \"BTCUSDT\")" },
    { "key": "yahoo", "name": "Yahoo Finance", "description": "Stocks, ETFs & metals (use ticker, e.g. \"AAPL\", \"VWCE.DE\", \"GC=F\")" },
    { "key": "kinesis", "name": "Kinesis", "description": "Precious metals & commodities (use symbol, e.g. \"KAU_USD\")" },
    { "key": "custom", "name": "Custom JSON", "description": "Any JSON endpoint with a configurable price path" }
  ]
}
```

### GET /api/investments/:id/price-history

Fetch historical price points for an investment from its provider-specific history source.

Current support:
- `yahoo` and `custom` providers: endpoint reads persisted DB history first, fetches provider history when range coverage is missing, then upserts refreshed rows.
- Other providers return persisted history if available.

Persistence notes:
- Historical quotes are stored in `asset_price_history` (daily `price_date` and `close_price` per investment).
- Startup runs background backfill (`backfillHistoricalAssetQuotes`) for held market-priced assets from first transaction date.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| from_ms | integer | Optional lower bound (unix timestamp ms) |
| to_ms | integer | Optional upper bound (unix timestamp ms) |
| db_only | boolean (`true`/`false` or `1`/`0`) | Optional. When true, serves only persisted DB history and skips external provider refresh/fetch |

**Response:**
```json
{
  "investment_id": 42,
  "provider": "custom",
  "points": [
    { "timestampMs": 1774461600000, "price": 716.75 },
    { "timestampMs": 1774462500000, "price": 717.0 }
  ]
}
```

### POST /api/investments/refresh-prices

Refresh prices from live providers for all investments.

Fallback chain for each investment price:
1. Live quote (`live`)
2. Previous close (`close`, when provider live price is missing/0)
3. Latest historical close from Yahoo chart data (`close`, when quote fields are unavailable)
4. Stored `current_price` in DB (`cached`)

Additional refresh behavior:
- Yahoo refresh accepts either `price_provider_id` **or** investment `symbol` (symbol fallback), matching Market Lookup symbol handling.
- Kinesis refresh/history resolution uses shared config resolution (`_resolveKinesisConfig`) so live and historical paths use the same symbol/timeframe mapping.
- Route-level live-refresh eligibility for `kinesis` accepts either explicit `price_provider_id` or asset-name/symbol mapping via `getKinesisAssetConfig`, so mapped metals can refresh even when `provider_id` is empty.
- Price writes are persisted through inheritance tables (`investments_base` + asset child table) to avoid direct updates on the non-updatable `investments` compatibility view.

Compatibility safeguard:
- A DB migration adds an `INSTEAD OF UPDATE` trigger on the `investments` view, so legacy `UPDATE investments ...` statements are redirected to inheritance tables and no longer error.
- Migration `0017_investment_custom_provider_history` adds custom-provider latest/history columns on `investments_base`, conditionally applies legacy `investments` table column updates only for table/partition relations, creates `metals_investments` if missing, and refreshes both `investments` view + `investments_view_update_instead()` to include new provider fields and metals handling ([[alembic/versions/0017_investment_custom_provider_history.py]]).
- Migration `0021_price_provider_binance` replaces `coingecko`/`kraken` enum values with `binance` by altering `investments_base.price_provider` directly (not the `investments` compatibility view), dropping the default before enum conversion, then restoring `DEFAULT 'manual'` after conversion. The migration also handles PostgreSQL relation dependencies by backing up and dropping all dependent `public` views that reference `investments_base` (table-level or `price_provider` column-level dependencies), then recreating them from captured definitions; when the `investments` view is restored and `investments_view_update_instead()` exists, it recreates trigger `update_investments_view_instead` ([[alembic/versions/0021_update_price_provider_enum.py]]).
- Migration `0022_add_kinesis_price_provider_enum` extends enum `price_provider` with value `kinesis`. Downgrade remaps `kinesis` rows to `manual`, rebuilds the enum without `kinesis`, and applies the same dependent-view/trigger handling pattern used by the prior enum migration to keep compatibility views functional ([[alembic/versions/0022_add_kinesis_price_provider_enum.py]]).
- Alembic baseline migration `0001_initial_database_schema` guards indexes and triggers to only operate on base tables (`relkind='r'`) in `public`, preventing `cannot create index on relation "investments"` when `investments` is a compatibility view in inheritance-schema setups ([[alembic/versions/0001_initial_database_schema.py]]).

**Response:**
```json
{
  "updated": 9,
  "total": 15,
  "prices": {
    "1": 185.50,
    "2": 45000.00
  },
  "priceSources": {
    "1": "close",
    "2": "live",
    "3": "cached"
  }
}
```

- `total`: investments considered for refresh (with live providers)
- `updated`: investments whose DB row was actively updated this run

### POST /api/investments

Create a new investment.

**Request Body:**
```json
{
  "name": "Apple Inc.",
  "symbol": "AAPL",
  "asset_class": "stock",
  "currency": "USD",
  "current_price": 185.50,
  "price_provider": "yahoo",
  "price_provider_id": "AAPL",
  "price_provider_latest_url": "https://example.com/latest",
  "price_provider_latest_path": "data.price",
  "price_provider_history_url": "https://example.com/history",
  "price_provider_history_path": "points",
  "price_provider_history_ts_path": "timestamp_ms",
  "price_provider_history_price_path": "price",
  "notes": "Tech stock"
}
```

Custom provider path configuration fields:

- `price_provider_latest_url`: endpoint used to resolve current/refresh price.
- `price_provider_latest_path`: JSON path to latest price value.
- `price_provider_history_url`: endpoint used to resolve historical chart points.
- `price_provider_history_path`: JSON path to array of history rows.
- `price_provider_history_ts_path`: JSON path (relative to each history row) for timestamp in ms.
- `price_provider_history_price_path`: JSON path (relative to each history row) for price.

Fallback compatibility:
- legacy `price_provider_url` and `price_provider_id` are still read for custom latest-price resolution.
- legacy-schema create compatibility: when DB relation `investments` lacks new custom-provider columns, create falls back to legacy insert fields and maps `price_provider_latest_path` → `price_provider_id`, `price_provider_latest_url` → `price_provider_url`.
- recommended schema state for full custom-provider latest/history compatibility is migration `0017_investment_custom_provider_history` ([[alembic/versions/0017_investment_custom_provider_history.py]]).

**Required Fields:** name, asset_class

Create-path compatibility:
- `create()` auto-detects inheritance schema by checking `investments_base`; when present, it inserts into the asset-specific child table (`stock_investments`, `etf_investments`, `crypto_investments`, `metals_investments`, `real_estate_investments`, `savings_investments`, `bond_investments`) and then reads the created row from the `investments` compatibility view.
- In legacy schema mode, `create()` still performs `INSERT INTO investments ...`; if that path fails with `cannot insert into view "investments"`, it falls back to inheritance-table insert and caches inheritance mode for subsequent creates ([[apps/node-backend/src/repositories/investmentRepository.js]]).
- In inheritance mode, if child-table insert fails with duplicate-id primary key violation (`23505`, `<child_table>_pkey`, `Key (id)`), `create()` self-heals by resyncing the `investments_base` sequence (`setval(..., COALESCE(MAX(id), 0) + 1, false)`) and retries the insert once ([[apps/node-backend/src/repositories/investmentRepository.js]]).

### GET /api/investments/:id

Get a single investment by ID.

### PATCH /api/investments/:id

Update an investment.

Validation and mutability rules:
- `asset_class` is immutable after creation; attempts to change it return `400` with `VALIDATION_ERROR`.
- `symbol` (ticker) is editable for unit-based investments but must be non-empty when provided and globally unique (case-insensitive).
- Route-level update now maps repository validation failures to `400` instead of generic `500` for business-rule violations.
- Existing DB `updated_at` triggers keep timestamp-only edit history (no previous-value history required).

Code links: [[apps/node-backend/src/routes/investments.js]], [[apps/node-backend/src/repositories/investmentRepository.js]]

### DELETE /api/investments/:id

Delete an investment (hard delete).

Delete-path compatibility:
- `hardDelete()` now detects inheritance schema and deletes through `investments_base` when needed.
- If legacy `DELETE FROM investments ...` fails with a non-updatable view error, the repository falls back to base-table delete and caches inheritance mode for subsequent deletes ([[apps/node-backend/src/repositories/investmentRepository.js]]).

### GET /api/investments/:id/transactions

Get portfolio transactions for an investment.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| type | string | null | Filter by transaction type |
| limit | integer | 200 | Max items |
| offset | integer | 0 | Items to skip |

**Transaction Types:** buy, sell, gift, dividend, fee, tax, interest, rent_income, appreciation

### GET /api/investments/transactions

Get portfolio transactions for **multiple investments** in a single request.

This endpoint is intended for portfolio pages that need to load many holdings at once and avoids client-side N-request fan-out.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `investment_ids` | string | required | Comma-separated investment IDs (e.g. `1,2,5`) |
| `type` | string | null | Optional transaction type filter |
| `per_investment_limit` | integer | 1000 | Max rows per investment (clamped 1..5000) |
| `limit` | integer | null | Optional global cap after per-investment limiting (clamped 1..200000) |
| `offset` | integer | 0 | Global offset after ordering |

**Behavior notes:**
- Repository uses per-investment ranking (`ROW_NUMBER() OVER (PARTITION BY investment_id ORDER BY date DESC, id DESC)`) so each investment contributes at most `per_investment_limit` rows.
- Final result is globally ordered by `date DESC, id DESC`.
- `total` is computed with the same `investment_ids` + `type` filter (before global `limit/offset`).
- Route cache key for bulk transactions now includes `limit` to prevent collisions between requests that differ only by limit value.

**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "investment_id": 5,
      "type": "buy",
      "date": "2026-01-15",
      "amount": 1855.00,
      "units": 10,
      "price_per_unit": 185.50,
      "fees": 5.00,
      "currency": "USD",
      "fx_rate_to_eur": 0.92,
      "created_at": "2026-01-15T10:00:00Z"
    }
  ],
  "total": 500,
  "limit": 1000,
  "offset": 0,
  "links": []
}
```

Code links: [[apps/node-backend/src/routes/investments.js]], [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]], [[apps/frontend/src/lib/api.ts]], [[apps/frontend/src/hooks/usePortfolio.ts]]

### POST /api/investments/:id/transactions

Create a portfolio transaction.

**Request Body:**
```json
{
  "type": "buy",
  "date": "2026-01-15",
  "amount": 1855.00,
  "units": 10,
  "price_per_unit": 185.50,
  "fees": 5.00,
  "taxes": 0.00,
  "currency": "USD",
  "fx_rate_to_eur": 0.9200000000,
  "note": "Initial purchase",
  "is_recurring": false,
  "recurrence_interval": "monthly",
  "recurrence_end_date": "2027-01-15"
}
```

**Request Body Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | string | Yes | Transaction type: buy, sell, gift, dividend, fee, tax, interest, rent_income, appreciation |
| date | string | Yes | Transaction date (YYYY-MM-DD) |
| amount | number | No | Total amount (auto-computed if missing for unit-based types) |
| units | number | No | Number of units (required for buy/sell/gift on unit-based assets) |
| price_per_unit | number | No | Price per unit (auto-computed if missing for unit-based types) |
| fees | number | No | Transaction fees |
| taxes | number | No | Transaction taxes (supported for dividend transactions) |
| currency | string | No | Currency code (defaults to investment currency) |
| fx_rate_to_eur | number | No | FX rate to EUR at transaction date |
| note | string | No | Transaction note |
| is_recurring | boolean | No | Whether this transaction is recurring |
| recurrence_interval | string | No | Recurrence pattern: daily, weekly, bi-weekly, monthly, quarterly, yearly |
| recurrence_end_date | string | No | End date for recurring transactions (YYYY-MM-DD) |

**Required Fields:** type, date (additional type-specific validation below)

Unit-based buy/sell behavior (asset classes: stock, etf, crypto, metals):
- Request may include any 2 of `amount`, `units`, `price_per_unit`; backend computes the missing third value.
- If all 3 are provided and inconsistent, request is rejected with `400`.
- Precision policy during normalization/storage: `amount` (4 decimals), `units` (8 decimals), `price_per_unit` (6 decimals).
- Compatibility tolerance is applied for all-3-field consistency checks to avoid false rejections from client-side rounding differences.
- Oversell protection: `sell` transactions are rejected with `400` / `VALIDATION_ERROR` when `units` exceed net units held on the transaction date.

Dividend behavior:
- `dividend` transactions support optional `fees` and `taxes`.

Gift behavior (unit-based assets):
- New `gift` transaction type requires `units`.
- `amount` defaults to `0` when omitted (optional basis amount can still be provided).
- `fees` and `taxes` are forced to `0`.

Create-path compatibility:
- `create()` now supports inheritance schema for portfolio transactions; if `portfolio_transactions` is a non-updatable compatibility view, it inserts into the asset-specific child transaction table based on the investment `asset_class`.
- Before inherited child-table insert, `create()` proactively resyncs the `portfolio_transactions_base` sequence to reduce sequence drift failures; if insert still hits duplicate id (`23505`), it self-heals by resyncing again and retries once ([[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]).
- Metals transactions now route to dedicated `metals_transactions` inheritance table (no longer shared through `stock_transactions`) while preserving `portfolio_transactions` view compatibility ([[apps/node-backend/src/repositories/portfolioTransactionRepository.js]], [[alembic/versions/0018_metals_transactions_inheritance_split.py]]).
- Request validation and transaction payload normalization are enforced in route handlers and reflected in client form behavior ([[apps/node-backend/src/routes/investments.js]], [[apps/frontend/src/components/portfolio/AddPortfolioTxnDialog.tsx]]).
- Optional `fx_rate_to_eur` is accepted and persisted for portfolio transactions (inheritance base/child + compatibility view path), enabling transaction-level FX locking for later P&L calculations ([[apps/node-backend/src/routes/investments.js]], [[alembic/versions/0016_add_fx_rate_to_portfolio_transactions.py]], [[apps/frontend/src/types/api.ts]]).
- `POST /api/investments/:id/transactions` now forwards preloaded investment `asset_class` from route lookup into repository create (`preloaded_asset_class`) so repository can skip a duplicate investment metadata query; validation and response behavior remain unchanged ([[apps/node-backend/src/routes/investments.js]], [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]).
- `POST /api/investments/refresh-prices` now performs update writes in bounded batches (instead of one unbounded `Promise.all`) to reduce DB/pool contention spikes while preserving response payload semantics (`updated`, `total`, `prices`, `priceSources`) and per-investment update behavior ([[apps/node-backend/src/routes/investments.js]]).
- Migration safety note: in inherited-schema deployments where `portfolio_transactions` is a compatibility view, migration `0016_add_fx_rate_to_portfolio_transactions` now checks relation kind before running `ALTER TABLE` (`r`/`p` only) and keeps the view recreation path for `relkind='v'`, so migration does not fail on view-backed schemas ([[alembic/versions/0016_add_fx_rate_to_portfolio_transactions.py]], [[docs/features/portfolio|Feature: Portfolio & Investments]]).
- Add/Edit portfolio transaction dialogs expose an optional `fx_rate_to_eur` field and pass it through to create payloads when set ([[apps/frontend/src/components/portfolio/AddPortfolioTxnDialog.tsx]], [[apps/frontend/src/components/portfolio/EditPortfolioTxnDialog.tsx]], [[apps/frontend/src/hooks/usePortfolio.ts]]).
- If `fx_rate_to_eur` is omitted, FX conversion uses historical rates from `exchange_rates` for transaction dates; missing rows are auto-backfilled from ECB historical data at startup, with nearest DB historical-rate fallback when exact dates are unavailable ([[apps/node-backend/src/services/currencyConversionService.js]], [[apps/node-backend/src/main.js]]).

### PATCH /api/investments/transactions/:txnId

Update a portfolio transaction by transaction ID.

Update endpoint notes:
- Route is available at `PATCH /api/investments/transactions/:txnId` ([[apps/node-backend/src/routes/investments.js]]).
- Repository update logic keeps inheritance compatibility fallback behavior for non-updatable `portfolio_transactions` views ([[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]).
- Transaction `type` is immutable on edit; attempts to change it return `400` with `VALIDATION_ERROR`.
- Unit-based buy/sell updates enforce the same 2-of-3 pricing rule as create: when changing pricing fields, client must send at least 2 of `amount`, `units`, `price_per_unit`, and backend computes the missing value.
- If all 3 pricing fields are sent on update and inconsistent, request is rejected with `400` (with the same precision normalization and compatibility tolerance handling as create).
- Optional `fx_rate_to_eur` is supported on update payloads as well, including UI edit flow ([[apps/frontend/src/components/portfolio/EditPortfolioTxnDialog.tsx]], [[apps/node-backend/src/routes/investments.js]], [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]).
- Oversell protection also applies on update: edited `sell` rows are rejected when resulting sold units exceed holdings for the effective transaction date.

Update-path compatibility:
- For repository-level transaction update paths (PATCH), if `UPDATE portfolio_transactions ...` fails because `portfolio_transactions` is a non-updatable compatibility view, the repository falls back to updating `portfolio_transactions_base` plus the asset-specific child transaction table ([[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]).
- Migration safety: alembic migration `0016_add_fx_rate_to_portfolio_transactions` runs `ALTER TABLE` only when `portfolio_transactions` is a table/partitioned table (`relkind in ('r','p')`), so startup no longer attempts `ALTER TABLE` on a compatibility view ([[alembic/versions/0016_add_fx_rate_to_portfolio_transactions.py]]).

### DELETE /api/investments/transactions/:txnId

Delete a portfolio transaction.

Delete-path compatibility:
- `hardDelete()` supports inheritance schema by falling back from `portfolio_transactions` view delete to `portfolio_transactions_base` delete when needed ([[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]).

### GET /api/investments/:id/summary

Get investment summary with holdings breakdown.

**Response:**
```json
{
  "investment_id": 1,
  "breakdown": {
    "total_units": 50,
    "total_cost": 9000.00,
    "current_value": 9275.00,
    "total_dividends": 250.00,
    "total_fees": 25.00
  }
}
```

## Examples

### List Investments

**curl:**
```bash
curl "http://localhost:3002/api/investments?limit=20"
```

**apiClient:**
```ts
const { data } = await apiClient.getInvestments({ limit: 20 });
```

### Create Investment

**curl:**
```bash
curl -X POST http://localhost:3002/api/investments \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Apple Inc.",
    "asset_class": "stock",
    "symbol": "AAPL",
    "currency": "USD",
    "price_provider": "yahoo"
  }'
```

**apiClient:**
```ts
const investment = await apiClient.createInvestment({
  name: 'Apple Inc.',
  asset_class: 'stock',
  symbol: 'AAPL',
  currency: 'USD',
  price_provider: 'yahoo',
});
```

### Add Portfolio Transaction

**curl:**
```bash
curl -X POST http://localhost:3002/api/investments/5/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "type": "buy",
    "date": "2026-01-15",
    "units": 10,
    "price_per_unit": 185.50,
    "currency": "USD"
  }'
```

**apiClient:**
```ts
const txn = await apiClient.createPortfolioTransaction(5, {
  type: 'buy',
  date: '2026-01-15',
  units: 10,
  price_per_unit: 185.50,
  currency: 'USD',
});
```

### Update Prices

**curl:**
```bash
curl -X POST http://localhost:3002/api/investments/update-prices
```

**apiClient:**
```ts
await apiClient.updateInvestmentPrices();
```

## Price Providers

| Provider | Asset Classes | Description |
|----------|---------------|-------------|
| manual | all | Manual price entry |
| binance | crypto | Binance market data |
| yahoo | stock, etf, metals | Yahoo Finance |
| kinesis | metals, commodities | Kinesis market data |
| custom | all | Custom API |

## Belgian Tax Fields

For real estate investments:
- `municipality`: Belgian municipality name
- `cadastral_income`: Cadastral income (kadastraal inkomen)
- `municipality_tax_rate`: Municipal tax rate

## Related

- [[docs/api/watchlist|Watchlist API]]
- [[docs/adr/002-database-schema|Database Schema]]

Metals implementation code links: [[apps/node-backend/src/repositories/investmentRepository.js]], [[apps/node-backend/src/repositories/infoRepository.js]], [[apps/node-backend/src/services/priceProviderService.js]]

Historical quote cache code links: [[apps/node-backend/src/services/priceProviderService.js]], [[apps/node-backend/src/config/kinesisConfig.js]], [[apps/node-backend/src/routes/investments.js]], [[apps/node-backend/src/main.js]], [[alembic/versions/0019_asset_price_history_cache.py]]
