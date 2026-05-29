---
title: Integration - Price Providers
type: integration
description: Live and historical price feeds for stocks, crypto, and other investments. Startup price refresh is skipped when the host is offline (2026-05-03).
date: 2026-04-21
last_modified: 2026-05-29
updated: 2026-05-29
tags: [integration, price, stocks, crypto, api, historical-quotes, quote-backfill, phase-1, eur-to-usd-mapping, data-sanitization, kinesis, offline-resilience, price-history-default, provider-timeout, parallel-fetching, startup-optimization, network-reachability]
aliases: [price providers, market data, Binance, Kinesis, Yahoo Finance, live prices]
status: active
related_code: [[apps/node-backend/src/services/priceProviderService.js], [apps/node-backend/src/services/quoteBackfillService.js], [apps/node-backend/src/services/prices/priceProviderRegistry.js], [apps/node-backend/tests/priceProviderRegistry.test.js], [apps/node-backend/src/lib/network.js]]
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
  - **Currency conversion for EUR investments (May 2026):** Live prices converted to investment currency at current FX rate; historical series converted per-date using historical FX rates (single bulk-loaded query). EUR-denominated investments now store currency-native prices instead of USD
  - **Stale-run removal (2026-04-26):** Kinesis API occasionally stalls for 60–137 hours (observed on KAU/KAG), returning ≥ 8 consecutive identical prices before jumping to new levels. Sanitizer collapses these runs to first point only, preserving correct price level without chart flatlines
  - **Edge-point anomalies (2026-04-26):** Year-boundary rollover bugs cause first/last points at ~50% of real price (Jan 1, 2025 artifact on KAU observed). Edge sanitizer checks first and last points using local needle ratio `1.8x`, replacing anomalies with neighbor value
  - Isolated needle-spike sanitization (up/down) replaces only confirmed single-point anomalies using geometric interpolation from neighboring points, preserving non-spike detail; thresholds are tuned for moderate one-day needles (robust `6σ`, bridge `4σ`, min jump `18%`, local needle ratio `1.8x`)

### Yahoo Finance
- **Asset Classes**: Stocks, ETFs, Metals
- **Implementation**: Web scraping / Yahoo Finance API
- **Features**:
  - Real-time quotes
  - **Batched quote requests (2026-05-29):** `PROVIDERS.yahoo` in `priceProviderRegistry.js` now issues a single `yahooFinance.quote([symbols])` call for all Yahoo-backed investments, normalizing the result to an array. A portfolio of ~30 holdings drops from ~30 outbound requests to 1. The per-symbol chart-close fallback (`_fetchYahooLatestClose`) is retained for symbols unresolved by the batch and for whole-batch failure.
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
- **Range-filtering on persist (2026-04-26):** `_persistAndResolve()` now filters historical points to the requested `[fromMs, toMs]` window before saving to the database via `saveHistoricalPointsToDatabase()`. Providers (Yahoo, Binance, Kinesis) return data beyond the requested bounds; previously, all points were persisted unfiltered, causing `cleanupStaleQuotes` to delete thousands of out-of-window rows on every startup, which were then re-inserted on the next startup. The in-memory provider cache still retains the full response for reuse across multiple window calls, but only the relevant subset is persisted to the DB.

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

## Error Handling & Offline Fallback

If price fetch fails:
- Fallback to previous close where available (Yahoo)
- Fallback to latest historical close from Yahoo chart data when quote fields are unavailable
- Fallback to existing stored `current_price` (`cached` source) when provider data is unavailable
- Fallback to last persisted `asset_price_history` point (`historical_fallback` source) when live providers are unreachable and in-memory cache is cold (e.g., app restart with no internet)
- Log error
- Continue with other investments

**Offline Resilience (Apr 2026):**
Each fallback source is tracked in the refresh response as `priceSources: Record<investmentId, PriceSource>`. The frontend uses this to differentiate:
- `live`: Fresh real-time quote — no warning
- `close`, `cached`: Potentially stale but known good — no warning
- `historical_fallback`: Database-backed but may be stale — frontend shows warning toast `portfolio.refreshedPricesStale` with count of stale prices

This makes graceful offline degradation visible without blocking the user.

**Startup Behavior When Offline (May 2026):**
During server startup, before any price refresh attempts, a network reachability probe (TCP to 1.1.1.1:443, 1.5s timeout) determines if the host has internet connectivity. When the probe detects offline status:
- **Startup refresh skipped**: `refreshInvestmentPricesOnStartup()` is not called
- **Historical backfill skipped**: `backfillHistoricalAssetQuotes()` is not called
- **No timeouts**: Avoids 5–15s burn-time on per-call timeouts waiting for unreachable providers
- **Cached/DB fallback**: Snapshots and info endpoints use existing stored `current_price` and `asset_price_history` rows
- **Faster readiness**: `/health/detailed` ready status reached ~15 seconds sooner when offline

Scheduled hourly refreshes (`refreshActiveHoldingQuotes()`) also skip themselves when `isInternetReachable({ force: true })` returns false, avoiding unnecessary timeout delays.

**Provider Timeout Safety (Apr 2026):**
- Binance ticker fetch now includes `signal: AbortSignal.timeout(8_000)` to abort after 8 seconds if the provider is unreachable/slow
- Prevents hung refresh requests that would block startup or user-initiated refreshes indefinitely
- Timeouts fall through to cached/historical fallback without blocking other providers

**Parallel Provider Fetching (Apr 2026):**
- The four provider buckets in `fetchLivePricesDetailed` (Binance, Yahoo, Custom, Kinesis) are now wrapped in async IIFEs and awaited via `Promise.allSettled()`
- Changes from sequential bucket execution (wall time = sum of provider times) to parallel execution (wall time = max of provider times)
- Improves overall refresh latency, especially when individual providers are slow or unresponsive
- Failures in one provider (e.g., timeout) no longer block execution of other providers
- Fallback chain is applied per-investment based on individual provider success/failure

**Custom Provider Health Recording (2026-04-28):**
- Custom provider now records success/error health metrics via `recordProviderSuccess('custom')` and `recordProviderError('custom', err)` to maintain consistency with Yahoo, Binance, and Kinesis health tracking
- Previously custom provider errors were silently logged without health recording

**Binance Symbol Coercion Fix (2026-04-28):**
- Binance historical symbol coercion now correctly appends `USDT` only when symbol lacks a known quote suffix
- Previously: `symbol.replace(/EUR$/, 'USDT')` was a no-op on non-EUR symbols (e.g., `BTCUSDT` remained unchanged, no USDT appended)
- Now: Logic checks for existing `EUR`, `USDT`, `USDC`, `BUSD`, `BTC`, `ETH` suffixes before appending `USDT`, preventing duplicate suffixes
- **Binance Ticker Validation (2026-04-28):** Parsed ticker prices now validate `Number.isFinite(p) && p > 0` before populating priceMap, preventing NaN/zero prices from being stored as valid quotes

**Price Cache Eviction (2026-04-28):**
- In-memory price cache now runs scheduled `sweepExpiredCacheEntries()` every 5 minutes (with `unref()` for graceful shutdown) to prevent unbounded Map growth
- Previously relied on lazy-delete only; large portfolios over extended uptime could accumulate orphaned cache entries
- Entries expire based on provider-specific TTLs (typically 60 minutes for live quotes)

Code links: [[apps/node-backend/src/services/prices/priceProviderRegistry.js]], [[apps/node-backend/src/services/priceProviderService.js]]

**Price History & Report Timestamp Metadata (Apr 2026):**
- Price-history endpoint (`GET /api/investments/:id/price-history`) now defaults `db_only=true` to prevent accidental external-fetch when no query is supplied (safe default for offline-first). Frontend can opt out with `?db_only=false` for explicit provider refresh.
- Backend provides `getLatestPriceUpdatedAt()` helper returning `MAX(price_updated_at)` across active non-manual investments for report provenance.
- Portfolio PDF reports include a "Prices as of <date>" meta row on the cover page. If prices are >1 day old, age in days is shown. If no live prices ever recorded, shows "No live prices recorded".

## Related

- [[docs/api/investments|API: Investments]]
- [[docs/api/admin|API: Admin]] (Kinesis history sanitization endpoint)
- [[docs/features/portfolio|Feature: Portfolio]]
- [[docs/performance/chart-downsampling|Chart Data Downsampling]]

Code links: [[apps/node-backend/src/services/priceProviderService.js]], [[apps/node-backend/src/config/kinesisConfig.js]], [[apps/node-backend/src/main.js]], [[apps/node-backend/src/routes/admin.js]], [[alembic/versions/0019_asset_price_history_cache.py]]
