---
title: Integration - Kinesis Price Provider
type: integration
status: active
date: 2026-04-25
last_modified: 2026-05-14
tags: [integration, kinesis, price-provider, metals, commodities, eur-to-usd-mapping, data-sanitization, currency-conversion, historical-fx]
description: Kinesis market data provider for metals and commodity price feeds with EUR-to-USD symbol remapping, currency conversion, and misconfiguration detection
aliases: [kinesis, kinesis price provider, metals prices, commodity data, kinesis eur conversion]
related_code: ["apps/node-backend/src/services/priceProviderService.js", "apps/node-backend/src/services/prices/priceProviderRegistry.js", "apps/node-backend/src/config/kinesisConfig.js", "apps/node-backend/src/routes/admin.js", "apps/node-backend/tests/priceProviderRegistry.test.js"]
---

# Integration: Kinesis Price Provider

## Overview

Kinesis is a market data provider used for metals and commodity price feeds in Vision's portfolio system.

---

## Supported Asset Classes

| Asset Class | Examples |
|-------------|----------|
| metals | GC=F (Gold), SI=F (Silver) |
| commodities | Various commodity futures |

---

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `KINESIS_API_KEY` | API key for Kinesis |
| `KINESIS_BASE_URL` | Base URL for Kinesis API |

### Config File

**Location:** `apps/node-backend/src/config/kinesisConfig.js`

Contains:
- Asset symbol mappings
- Timeframe configurations
- Request rate limits

### EUR-to-USD Symbol Remapping

The Kinesis API only provides USD-denominated symbols. When an investment has a EUR-denominated symbol in `price_provider_id`, it is remapped to the USD equivalent before the API request.

**Mapping Table:**

| EUR Symbol | USD Equivalent |
|------------|----------------|
| `KAU_EUR` | `KAU_USD` |
| `KAG_EUR` | `KAG_USD` |
| `XAU_EUR` | `XAU_USD` |
| `XAG_EUR` | `XAG_USD` |
| `XPT_EUR` | `XPT_USD` |
| `XPD_EUR` | `XPD_USD` |

**Implementation:** Defined as `KINESIS_EUR_TO_USD` constant in `resolveKinesisConfig()` ([[apps/node-backend/src/services/prices/priceProviderRegistry.js#L61-L69]]). The symbol lookup happens before any asset config fallback, ensuring EUR variants are always normalized to their USD counterparts.

**Misconfiguration Detection (Added 2026-04-25):** When a `price_provider_id` ends with `_EUR` but is not found in the `KINESIS_EUR_TO_USD` mapping, the system logs a `WARN`-level message: `Kinesis: unmapped EUR symbol "{providerId}" — add it to KINESIS_EUR_TO_USD or the API call will fail`. This early warning prevents silent API failures for newly added EUR-denominated assets.

### Currency Conversion (May 2026)

When an investment has a EUR-denominated symbol (e.g., `KAU_EUR`) remapped to USD (`KAU_USD`), Vision now converts the fetched USD price back to the investment's currency:

**Live Price Path:**
- `PROVIDERS.kinesis` in `priceProviderRegistry.js` returns `needsUsdToEur` flag if the symbol was remapped
- When `needsUsdToEur=true` and investment currency ≠ USD, live USD price is converted to investment currency using current FX rate
- Returns `{ price, currency: <investment currency>, source }`

**Historical Series Path:**
- `fetchHistoricalPrices()` in `priceProviderService.js` converts fetched USD points to investment currency via `convertRowsToEur(..., { useHistoricalRatesByDate: true })`
- Each point is converted at its own historical FX rate (bulk-loaded from `currency_rates` in a single query)
- No per-date DB round-trips; efficient single-query rate-index load
- Persists currency-native prices to `asset_price_history`

**Result:**
EUR-denominated Kinesis investments now store prices in their native currency (EUR) instead of silently storing USD. Both live-price and historical-series consumers receive currency-native values.

---

## API Usage

### Live Price Fetch

```
GET {base_url}/quote?symbol={symbol}
```

### Historical Data

```
GET {base_url}/history?symbol={symbol}&from={date}&to={date}&interval={interval}
```

---

## Integration Details

### Price Provider Service

Kinesis is integrated into `priceProviderService.js` alongside other providers (Binance, Yahoo, Custom).

#### Provider Resolution

1. Check `price_provider_id` first
2. Fall back to `symbol` mapping
3. Use Kinesis asset config for name/symbol mapping

#### Refresh Eligibility

An investment is eligible for Kinesis refresh when:
- `price_provider` = 'kinesis'
- Has `price_provider_id` OR name/symbol maps through Kinesis config

### Data Quality Sanitization

Kinesis historical data may contain data quality issues from API behavior:

#### Stale Data Plateaus (Added 2026-04-26)

The Kinesis API occasionally stalls price updates for extended periods (60–137 hours observed for KAU/KAG), returning runs of identical prices before jumping to a new level. These stale plateaus create flat-line artifacts in charts.

The sanitizer removes runs of ≥ 8 consecutive identical prices, keeping only the first point of each run. This collapses the plateau while preserving the correct price level when updates resume.

**Example**: Series `[100, 114.30, 114.30, 114.30, 114.30, 114.30, 114.30, 114.30, 114.30, 102]` becomes `[100, 114.30, 102]`.

#### Edge-Point Anomalies (Added 2026-04-26)

Kinesis API data windows sometimes return year-boundary rollover artifacts (Jan 1, 2025 observed: first point at exactly 50% of real price). Edge-point sanitization checks the first and last points of each data window using a local needle ratio (`1.8x`): if a point deviates by more than 1.8x from its single neighbor, it is replaced with that neighbor value.

**Example**: First point `46.31` (half of `92.60`) is corrected to `92.60`.

#### Isolated Needle Spikes (Existing)

Kinesis also contains isolated one-day needles (up/down spikes) detected via MAD-based robust outlier detection. These are replaced with geometric interpolation of neighbors.

#### Implementation

The function `sanitizeKinesisIsolatedSpikes(points)` (in `priceProviderRegistry.js`):
1. Removes stale runs (≥ 8 identical prices)
2. Checks and corrects edge points (first/last)
3. Detects middle-point isolated spikes using MAD thresholds
4. Returns cleaned points (immutable)

Historical sanitization via:

```javascript
sanitizePersistedKinesisHistory(investmentId)
```

This function:
1. Scans persisted `asset_price_history` rows
2. Applies the full sanitization pipeline
3. Persists corrected points back to DB

### Admin Endpoint

```
POST /api/admin/investments/kinesis/sanitize-history
```

Manually trigger sanitization for all Kinesis investments.

---

## Fallback Chain

When Kinesis is unavailable:
1. Use cached `current_price` from DB
2. Use persisted `asset_price_history` data
3. Skip update (do not zero out prices)

---

## Related

- [[docs/integrations/price-providers]] — Price providers overview
- [[docs/features/portfolio#price-providers]] — Portfolio price providers
- [[docs/api/admin]] — Admin API
