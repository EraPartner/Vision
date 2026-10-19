---
title: Exchange Rates Feature
type: feature
status: active
date: 2026-10-19
updated: 2026-10-19
tags:
  [feature, exchange-rates, currency, frontend, backend, ECB, admin, url-state]
description: Exchange rate viewing and management with the latest stored ECB rates and manual refresh at the canonical /admin/exchange-rates route. Since 2026-10-19 conversions use stored rates only; the built-in fallback rates and their tab are gone.
aliases: [FX rates, currency rates, exchange rates page]
related_code:
  - apps/frontend/src/pages/admin/ExchangeRatesPage.tsx
  - apps/frontend/src/components/notifications/FxStatusBanner.tsx
  - apps/node-backend/src/routes/info.ts
  - apps/node-backend/src/services/currency/currencyConversionService.ts
---

# Exchange Rates Feature

## Overview

The Exchange Rates page (`/admin/exchange-rates`, in the admin-mode section) displays the latest
stored exchange rates from the European Central Bank (ECB) and its supplementary source. It allows
viewing and manually refreshing the exchange rates used throughout the application for currency
normalization. These stored rates are the only rates conversions use: a currency without one is
unavailable and flagged where it is shown, never converted at a built-in rate
([[docs/adr/216-server-owned-domain-calculations|ADR-216]]). It lives under admin mode because it inspects/manages the FX rate feed
rather than being a per-user portfolio task (conversion itself happens automatically everywhere).
The retired `/portfolio/exchange-rates` alias now renders Not Found.

## Architecture

### Frontend Page

Located at `[[apps/frontend/src/pages/admin/ExchangeRatesPage.tsx]]` (gated by `RequireAdmin`), the page displays:

#### Summary Cards

1. **Stored Rates**: Total number of rates in the database
2. **Latest Fetch**: Date of the most recent rate fetch and timestamp

The former **Fallback Currencies** card was removed on 2026-10-19.

Summary cards stack below the extra-large breakpoint. Counts and rate values follow the selected number format; dates follow the selected date format. The **100 Units in EUR** column always uses EUR, independent of the preferred display currency.

#### Rates table

One table of the latest stored rates, with columns:

- Currency code
- Unit to EUR (rate_to_eur)
- EUR to Unit (1 / rate_to_eur)
- 100 Units in EUR

With no stored rates the page shows an empty state with a **Refresh** action. The Live/Fallback
tabs and their `?tab=` state were removed on 2026-10-19 together with the built-in rates.

#### Refresh Button

Triggers `POST /api/info/exchange-rates/refresh` to fetch fresh rates from ECB.

#### Global stale-rate warning

`FxStatusBanner` appears in the application layout when stored rates are stale or none are stored (`source: "fallback"`), in which case it says that amounts in other currencies can't be converted. The admin page relies on this single warning instead of repeating it inside the page. It shows the last successful fetch time when available. Its inline **Refresh** button calls the same `POST /api/info/exchange-rates/refresh` endpoint as the admin page, invalidates both exchange-rate cache families, and reloads the banner status. Success and failure are reported with localized toasts. Dismissing the warning still suppresses it locally for one hour.

### Backend Endpoints

Located in `[[apps/node-backend/src/routes/info.ts]]`:

#### GET /api/info/exchange-rates

Returns cached exchange rates from the database:

```json
{
  "total_rates": 33,
  "rates": [
    { "currency": "USD", "rate_to_eur": 0.92, "rate_date": "2026-04-01", "fetched_at": "2026-04-01T10:00:00Z" }
  ],
  "source": "database",
  "is_stale": false,
  "last_fetched_at": "2026-04-01T10:00:00Z"
}
```

`source` is `database`, or `fallback` when nothing is stored (only EUR amounts can then be
converted); `is_stale` and `last_fetched_at` complete the `ExchangeRates` schema in
`openapi.yaml`, inside the ADR-026 envelope.

The `fallback_rates` field (the server's hard-coded constants) was removed on 2026-10-19. The web
`useCurrencyConverter` hook and the server-owned display figures convert at the latest stored rates
only ([[docs/integrations/currency-conversion|Currency Conversion]],
[[docs/adr/216-server-owned-domain-calculations|ADR-216]]).

**Auto-refresh logic**: If stored rates are from a previous day, the endpoint clears the memory cache and triggers a background `warmCache()` call to fetch fresh rates. With `db_only=true` (also `1`) it serves the stored rates without that refresh; the admin page asks for it.

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

### Supplementary: open.er-api.com

Fills currencies ECB does not publish (Gulf, South Asian and African currencies, among others).
ECB takes priority on overlap.

### No built-in rates (2026-10-19)

The `FALLBACK_RATES` constant was removed from
`[[apps/node-backend/src/services/currency/currencyConversionService.ts]]`; the Belgian tax
dashboards, its last readers, now use stored rates too. An amount without a stored rate is left
out of totals and flagged, never added 1:1; see
[[docs/integrations/currency-conversion|Currency Conversion]].

## Data Model

### Database Table: `exchange_rates`

| Column          | Type       | Description                                       |
| --------------- | ---------- | ------------------------------------------------- |
| `currency_code` | VARCHAR(3) | ISO 4217 currency code                            |
| `rate_to_eur`   | DECIMAL    | Exchange rate to EUR                              |
| `rate_date`     | DATE       | Date of the rate                                  |
| `fetched_at`    | TIMESTAMP  | When the rate was fetched                         |
| `is_latest`     | BOOLEAN    | Whether this is the latest rate for this currency |

## Frontend Implementation Details

### Query Configuration

```typescript
useQuery<ExchangeRatesData>({
  queryKey: exchangeRateKeys.all,
  queryFn: () => apiClient.getExchangeRates({ dbOnly: true }),
  staleTime: 10 * 60_000,
});
```

The admin page and conversion consumers share `exchangeRateKeys.all` (`["exchange-rates"]`). The global status banner keeps its legacy `exchangeRateKeys.fxStatus` key (`["exchangeRates", { dbOnly: true }]`) because it uses a shorter staleness policy and warning-specific lifecycle.

### Refresh Mutation

```typescript
useMutation({
  mutationFn: () => apiClient.refreshExchangeRates(),
  onSuccess: async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: exchangeRateKeys.all }),
      queryClient.invalidateQueries({ queryKey: exchangeRateKeys.fxStatus }),
    ]);
    toast.success(t("exchangeRates.refreshSuccess"));
  },
});
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
