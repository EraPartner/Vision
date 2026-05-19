---
title: Exchange Rates Feature
type: feature
status: active
date: 2026-04-02
tags: [feature, exchange-rates, currency, frontend, backend, ECB]
description: Exchange rate viewing and management with live ECB rates, fallback rates, and manual refresh capability
aliases: [FX rates, currency rates, exchange rates page]
related_code:
  - apps/frontend/src/pages/portfolio/ExchangeRatesPage.tsx
  - apps/node-backend/src/routes/info.js
  - apps/node-backend/src/services/currency/currencyConversionService.js
---

# Exchange Rates Feature

## Overview

The Exchange Rates page (`/portfolio/exchange-rates`) displays current exchange rates from the European Central Bank (ECB) and hardcoded fallback rates. It allows users to view, compare, and manually refresh exchange rates used throughout the application for currency normalization.

## Architecture

### Frontend Page

Located at `[[apps/frontend/src/pages/portfolio/ExchangeRatesPage.tsx]]`, the page displays:

#### Summary Cards
1. **Stored Rates**: Total number of rates in the database
2. **Fallback Currencies**: Number of hardcoded fallback currencies
3. **Latest Fetch**: Date of the most recent rate fetch and timestamp

#### Tabs
- **Live Rates**: Table of current ECB rates with columns:
  - Currency code
  - Unit to EUR (rate_to_eur)
  - EUR to Unit (1 / rate_to_eur)
  - 100 Units in EUR
- **Fallback Rates**: Table of hardcoded fallback rates (same columns)

#### Refresh Button
Triggers `POST /api/info/exchange-rates/refresh` to fetch fresh rates from ECB.

### Backend Endpoints

Located in `[[apps/node-backend/src/routes/info.js]]`:

#### GET /api/info/exchange-rates

Returns cached exchange rates from the database:

```json
{
  "total_rates": 33,
  "rates": [
    { "currency": "USD", "rate_to_eur": 0.92, "rate_date": "2026-04-01", "fetched_at": "2026-04-01T10:00:00Z" }
  ],
  "fallback_rates": { "USD": 0.92, "GBP": 1.17, ... }
}
```

**Auto-refresh logic**: If stored rates are from a previous day, the endpoint clears the memory cache and triggers a background `warmCache()` call to fetch fresh rates.

**Rate limiting**: 30 requests per minute per IP.

#### POST /api/info/exchange-rates/refresh

Forces a fresh fetch from the ECB API:
1. Clears the memory cache
2. Calls `warmCache()` to fetch from ECB
3. Persists rates to the `exchange_rates` database table

**Rate limiting**: Uses `adminRateLimiter` (stricter than the standard limiter).

## Rate Sources

### Primary: ECB (European Central Bank)

- Fetched via XML parsing from ECB's daily reference rates feed
- Covers ~33 currencies
- Parsed using regex-based XML parser handling both single-quoted and double-quoted attribute formats

### Fallback: Hardcoded Rates

Defined in `FALLBACK_RATES` constant in `[[apps/node-backend/src/services/currency/currencyConversionService.js]]`:
- Covers ~40 currencies
- Used when ECB data is unavailable or for rare currencies
- Updated manually when significant rate changes occur

## Data Model

### Database Table: `exchange_rates`

| Column | Type | Description |
|--------|------|-------------|
| `currency_code` | VARCHAR(3) | ISO 4217 currency code |
| `rate_to_eur` | DECIMAL | Exchange rate to EUR |
| `rate_date` | DATE | Date of the rate |
| `fetched_at` | TIMESTAMP | When the rate was fetched |
| `is_latest` | BOOLEAN | Whether this is the latest rate for this currency |

## Frontend Implementation Details

### Query Configuration

```typescript
useQuery<ExchangeRatesData>({
  queryKey: ["exchangeRates"],
  queryFn: () => apiClient.request("/api/info/exchange-rates"),
  staleTime: 60_000,
})
```

### Refresh Mutation

```typescript
useMutation({
  mutationFn: () => apiClient.request("/api/info/exchange-rates/refresh", { method: "POST" }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["exchangeRates"] });
    toast.success(t('exchangeRates.refreshSuccess'));
  },
})
```

### Rate Display

Each rate row shows four representations:
1. **Currency code**: Monospace font for readability
2. **Unit to EUR**: 6 decimal places (e.g., `0.920000`)
3. **EUR to Unit**: 4 decimal places (e.g., `1.0870`)
4. **100 in EUR**: Formatted as currency using `Intl.NumberFormat`

## Usage Across the Application

Exchange rates are consumed by:
- **Portfolio pages**: Cross-currency display normalization
- **Net Worth**: Currency-aware net worth computation
- **Portfolio Tax**: Tax and fee conversion to target currency
- **Transaction display**: Multi-currency transaction amounts

## Related Features

- [[docs/integrations/currency-conversion|Currency Conversion]] — Core currency conversion service
- [[docs/features/portfolio|Portfolio]] — Multi-currency portfolio tracking
- [[docs/features/net-worth|Net Worth]] — Currency-normalized net worth computation
