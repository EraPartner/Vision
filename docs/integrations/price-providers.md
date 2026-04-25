---
title: Integration - Price Providers
type: integration
description: Live and historical price feeds for stocks, crypto, and other investments
date: 2026-04-21
last_modified: 2026-04-25
tags: [integration, price, stocks, crypto, api, historical-quotes, quote-backfill, phase-1, eur-to-usd-mapping]
aliases: [price providers, market data, Binance, Kinesis, Yahoo Finance, live prices]
status: active
related_code: [[apps/node-backend/src/services/priceProviderService.js], [apps/node-backend/src/services/quoteBackfillService.js], [apps/node-backend/src/services/prices/priceProviderRegistry.js]]
---

# Integration: Price Providers

## Overview

Price providers fetch live and historical market prices for investments, supporting multiple asset classes and data sources.

> [!info] Note (2026-04-16)
> The **net worth endpoint** (`GET /api/info/net-worth`) no longer calls price providers at request time. Investment values are now pre-computed daily via `portfolioPerformanceSnapshotService` and persisted to `portfolio_performance_snapshots`. Price providers are used only during snapshot backfill (application startup) and hourly refresh cycles, not during request handling.

## Supported Providers

### Manual
- **Asset Classes**: All
- **Usage**: User enters prices manually
- **Implementation**: No API calls, uses stored `current_price`

### Binance
- **Asset Classes**: Crypto
- **API**: Binance market data API
- **Endpoint**: `https://api.binance.com/api/v3/ticker/price`
- **Features**: 
  - Real-time crypto quote data
  - Broad pair coverage

### Kinesis
- **Asset Classes**: Metals, commodities
- **API**: Kinesis market trendline API
- **Endpoint**: default `https://api.kinesis.money/api/market-data/trendlines` via `KINESIS_BASE_URL` ([[apps/node-backend/src/config/kinesisConfig.js]])
- **Features**:
  - Live/latest price from trendline points
  - Historical points from same symbol stream
  - Symbol resolution from either explicit `price_provider_id` or configured asset-name mapping
  - **EUR-to-USD remapping (2026-04-25):** When `price_provider_id` is set to a EUR-denominated symbol (e.g., `KAU_EUR`, `XAU_EUR`), it is remapped to its USD equivalent (`KAU_USD`, `XAU_USD`) before API requests. Unmapped EUR symbols trigger a `WARN`-level log message to catch misconfiguration early, since Kinesis only provides USD symbols
  - Isolated needle-spike sanitization (up/down) replaces only confirmed single-point anomalies using geometric interpolation from neighboring points, preserving non-spike detail; thresholds are tuned for moderate one-day needles (robust `6σ`, bridge `4σ`, min jump `18%`, local needle ratio `1.8x`) ([[apps/node-backend/src/services/priceProviderService.js]])

### Yahoo Finance
- **Asset Classes**: Stocks, ETFs, Metals
- **Implementation**: Web scraping / Yahoo Finance API
- **Features**:
  - Real-time quotes
  - Previous close fallback when real-time quote is unavailable/zero
  - Historical data
  - Wide coverage
  - Supports futures-style metals tickers (for example, `GC=F`)

### Custom
- **Asset Classes**: All
- **Configuration**: Custom latest/history URLs and JSON paths
- **Usage**: For proprietary or unsupported APIs

## Historical Quote Cache

- Historical quotes for provider-backed assets are persisted in `asset_price_history` (daily close per investment).
- `GET /api/investments/:id/price-history` uses read-through behavior: read DB first, fetch provider when coverage is missing, then upsert refreshed rows.
- Startup backfill for held unit-based assets (`stock`, `etf`, `crypto`, `metals`) is orchestrated by [[apps/node-backend/src/services/quoteBackfillService.js|quoteBackfillService]]:
  - Computes **holding windows** (periods where units > 0) from transaction history
  - Fetches and sanitizes historical prices (provider-agnostic spike detection)
  - Persists quotes only within holding windows
  - Cleans up stale quotes outside windows after backfill
  - Ignores `is_active` flag — all investments with transaction history get quotes
- Lightweight hourly refresh via `refreshActiveHoldingQuotes()` updates currently-held investments (7-day lookback, open windows only)
- Transaction-triggered refresh via `refreshQuotesForInvestment()` (fire-and-forget) handles single-investment updates on buy/sell/edit
- Startup live refresh now prioritizes fast availability for Kinesis-backed investments: when a valid persisted `current_price` exists, it is used immediately and the external Kinesis refresh is deferred to background execution.
- If provider fetch fails, history requests fall back to persisted DB rows.
- `fetchLivePricesDetailed` uses provider-consistent cache keys, including investment-scoped keys for `custom`/`kinesis` to keep cache reads and writes aligned.
- Live refresh keeps an explicit Binance batch fetch block in `fetchLivePricesDetailed` for crypto provider efficiency.
- Kinesis sanitization is applied before latest extraction and before historical cache/persist writes so cached history avoids isolated trendline needles ([[apps/node-backend/src/services/priceProviderService.js]]).
- `fetchHistoricalPrices` sanitizes Kinesis points and persists through `saveHistoricalPointsToDatabase()` before returning (moved from `_saveHistoricalPointsToDatabase`, now exported) ([[apps/node-backend/src/services/priceProviderService.js]]).
- Persisted Kinesis history can be re-sanitized in place via `sanitizePersistedKinesisHistory()`: it scans `investments.price_provider='kinesis'`, loads persisted `asset_price_history` points, applies isolated spike sanitization, upserts corrected points with source `kinesis`, and returns `{ processed, updated, correctedPoints, failed }`.
- Internal historical-fetch refactor in `fetchHistoricalPrices` extracts shared range-filter and persist+resolve helpers to reduce duplication while preserving provider-specific behavior, cache keys, and fallback semantics ([[apps/node-backend/src/services/priceProviderService.js]]).

## Usage

### Configure Investment
```javascript
POST /api/investments
{
  "name": "Bitcoin",
  "symbol": "BTC",
  "asset_class": "crypto",
  "price_provider": "binance",
  "price_provider_id": "BTCUSDT"
}
```

### Refresh Prices
```javascript
POST /api/investments/refresh-prices
```

Response:
```json
{
  "updated": 10,
  "total": 15,
  "prices": {
    "1": 45000.00,
    "2": 185.50
  },
  "priceSources": {
    "1": "live",
    "2": "close",
    "3": "cached"
  }
}
```

## Price Provider Fields

| Field | Type | Description |
|-------|------|-------------|
| price_provider | enum | Provider name |
| price_provider_id | string | Provider-specific ID |
| price_provider_url | string | Custom endpoint URL |
| price_updated_at | timestamp | Last price fetch |

## Rate Limits

- Binance: provider/network dependent
- Kinesis: provider/network dependent
- Yahoo: Depends on usage

## Error Handling

If price fetch fails:
- Fallback to previous close where available (Yahoo)
- Fallback to latest historical close from Yahoo chart data when quote fields are unavailable
- Fallback to existing stored `current_price` when provider data is unavailable
- Log error
- Continue with other investments

## Related

- [[docs/api/investments|API: Investments]]
- [[docs/api/admin|API: Admin]] (Kinesis history sanitization endpoint)
- [[docs/features/portfolio|Feature: Portfolio]]
- [[docs/performance/chart-downsampling|Chart Data Downsampling]]

Code links: [[apps/node-backend/src/services/priceProviderService.js]], [[apps/node-backend/src/config/kinesisConfig.js]], [[apps/node-backend/src/main.js]], [[apps/node-backend/src/routes/admin.js]], [[alembic/versions/0019_asset_price_history_cache.py]]
