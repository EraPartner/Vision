---
title: Integration - Kinesis Price Provider
type: integration
status: active
date: 2026-04-02
last_modified: 2026-04-25
tags: [integration, kinesis, price-provider, metals, commodities, eur-to-usd-mapping]
description: Kinesis market data provider for metals and commodity price feeds with EUR-to-USD symbol remapping
aliases: [kinesis, kinesis price provider, metals prices, commodity data]
related_code: ["apps/node-backend/src/services/priceProviderService.js", "apps/node-backend/src/services/prices/priceProviderRegistry.js", "apps/node-backend/src/config/kinesisConfig.js", "apps/node-backend/src/routes/admin.js"]
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

The Kinesis API only provides USD-denominated symbols. When an investment has a EUR-denominated symbol in `price_provider_id`, it is silently remapped to the USD equivalent before the API request. This prevents "Kinesis: no data returned" warnings during startup.

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

### Spike Sanitization

Kinesis historical data may contain isolated price spikes. The system includes:

```javascript
sanitizePersistedKinesisHistory(investmentId)
```

This function:
1. Scans persisted `asset_price_history` rows
2. Detects isolated one-day needles (up/down spikes)
3. Replaces outliers with geometric interpolation of neighbors
4. Persists corrected points back to DB

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
