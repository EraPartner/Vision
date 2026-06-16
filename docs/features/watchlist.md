---
title: Watchlist Feature
type: feature
status: active
date: 2026-04-17
last_modified: 2026-06-16
updated: 2026-06-16
tags: [feature, watchlist, investments, tracking, alerts, phase-3.6, offline-resilience, online-status-detection, api-client-migration, validation, june-2026]
description: Investment watchlist for tracking securities not yet in the portfolio with target price alerts. June 2026: POST/PATCH now return 400 ValidationError for invalid target_price, asset_class, or currency, instead of DB-level 500.
aliases: [watch list, price alerts, investment tracking]
related_code:
  - apps/frontend/src/pages/portfolio/WatchlistPage.tsx
  - apps/frontend/src/components/portfolio/AddToWatchlistDialog.tsx
  - apps/frontend/src/hooks/usePortfolio.ts
  - apps/frontend/src/types/watchlist.ts
  - apps/frontend/src/lib/api.ts
  - apps/node-backend/src/routes/watchlist.js
  - apps/node-backend/src/repositories/watchlistRepository.js
---

# Watchlist Feature

## Overview

The Watchlist feature (`/portfolio/watchlist`) allows users to track securities they are interested in but haven't yet added to their portfolio. Users can set target prices and receive visual indicators when targets are met.

## Data Model

### TypeScript Type

```typescript
interface WatchlistItem {
  id: number;
  symbol: string;
  name: string;
  provider: string;
  target_price?: number;
  current_price?: number;
  created_at: string;
  updated_at: string;
}
```

### Database Table: `watchlist`

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Primary key |
| `symbol` | VARCHAR | Ticker symbol |
| `name` | VARCHAR | Security name |
| `provider` | VARCHAR | Price provider key |
| `target_price` | DECIMAL | Optional target price alert |
| `current_price` | DECIMAL | Latest fetched price |
| `created_at` | TIMESTAMP | Creation timestamp |
| `updated_at` | TIMESTAMP | Last update timestamp |

## API Endpoints

### GET /api/watchlist

Returns all watchlist items with current prices.

Implementation note:
- Backend list pagination now normalizes `limit` and `offset` (`limit` clamped to `1..5000`, `offset` floored at `0`) to prevent pathological page sizes while preserving payload shape (`{ items, total, limit, offset }`) ([[apps/node-backend/src/routes/watchlist.js]]).
- Backend watchlist list endpoint now uses repository one-query pagination (`getAllWithCount`) instead of separate list + count calls, preserving filter/order/response semantics while reducing DB round-trips ([[apps/node-backend/src/routes/watchlist.js]], [[apps/node-backend/src/repositories/watchlistRepository.js]]).

### POST /api/watchlist

Adds a security to the watchlist. Required fields: `name`, `asset_class`, `target_price`.

### PATCH /api/watchlist/:id

Updates a watchlist item (e.g., set target price). All fields are optional (partial update).

### Input Validation (June 2026)

POST and PATCH now validate typed fields before the database layer, returning `400 ValidationError` for:

- `target_price` that is not a finite number ≥ 0
- `asset_class` outside `{stock, etf, crypto, metals}`
- `currency` that is not a 3-letter alphabetic code

Previously these reached the typed DB column and surfaced as opaque 500 errors. Callers sending valid data are unaffected.

See [[docs/api/watchlist|Watchlist API]] for the full error-response table.

### DELETE /api/watchlist/:id

Removes a security from the watchlist.

## Display Logic

The watchlist page uses a smart display strategy:

- **At or below target**: Shows the current price (encourages buying)
- **Above target**: Shows the percentage above target (shows how much it's exceeded)

This provides actionable information: either "it's cheap enough" (price shown) or "it's gone up X%" (percentage shown).

## API Integration (Phase 3.6)

### ApiClient Watchlist Methods

**Phase 3.6 Enhancement**: WatchlistPage now uses encapsulated `apiClient` methods instead of raw `fetch()` calls, improving code maintainability and enabling shared error handling.

Available methods:
- `getWatchlist(params?)` — `GET /api/watchlist` with optional `limit`/`offset` pagination
- `createWatchlistItem(data)` — `POST /api/watchlist` to add item
- `updateWatchlistItem(id, data)` — `PATCH /api/watchlist/:id` to update (e.g., set target price)
- `deleteWatchlistItem(id)` — `DELETE /api/watchlist/:id` to remove item
- `getMarketQuotes(symbols)` — `GET /api/market/quotes?symbols=...` to fetch current prices for multiple symbols

All methods are typed and integrate with React Query for caching and invalidation.

Code links: [[apps/frontend/src/lib/api.ts]], [[apps/frontend/src/pages/portfolio/WatchlistPage.tsx]]

## Price Updates

Watchlist prices are updated when:
1. The user manually refreshes investment prices via `POST /api/investments/refresh-prices`
2. The price provider service fetches live prices for all tracked symbols
3. **Phase 3.6**: WatchlistPage uses `useQuery({ queryKey: ["watchlist-quotes", symbols], queryFn: () => apiClient.getMarketQuotes(symbols) })` with 60s refetch interval for automatic market quote updates

## API Client Migration (2026-04-29)

**AddToWatchlistDialog** refactored to use encapsulated `apiClient` methods instead of raw `fetch()` calls:
- Replaced 3 raw `fetch()` calls with `searchMarket()`, `getMarketQuotes()`, `createWatchlistItem()` from api client
- Removed hardcoded `API_BASE_URL` dependency (now sourced via api client)
- Added `MarketSearchResult` type export from `[[apps/frontend/src/lib/api/market.ts]]`
- Dialog now benefits from shared error handling, retry logic, and timeout controls

### Prefill from Market Lookup (2026-06-16)

`AddToWatchlistDialog` accepts an optional `prefill?: WatchlistPrefill` prop:

```typescript
interface WatchlistPrefill {
  symbol: string;
  name: string;
  type?: string;      // maps to asset class auto-detection
  currency?: string;
  price?: number;     // seeds the target price field
}
```

When `prefill` is provided the dialog **skips its internal search step**: it seeds the selected asset, auto-detects asset class from `type`, sets currency, and defaults the target price to the current price. The user is one confirm away from adding the item. Search-based usage (no `prefill`) is completely unchanged.

The primary caller of the prefill path is `[[apps/frontend/src/pages/research/MarketLookupPage.tsx]]`: when a Yahoo symbol's detail view is open, an "Add to Watchlist" outline button in the quote header opens this dialog pre-populated from the current live quote. See [[docs/features/market-lookup|Market Lookup]] for the full quote-header action context.

## Offline Resilience

The watchlist page gracefully degrades when offline:

- **Online status detection**: Uses `useOnlineStatus()` hook to monitor browser connectivity
- **Query gating**: Quotes query is enabled only when `isOnline`, preventing unnecessary API calls during offline periods
- **Conditional refetch**: refetchInterval is conditional on `isOnline`; when offline, no background refetches occur
- **Retry strategy**: `retry: 1` only when online; offline requests skip retries to fail fast
- **Dialog handling**: Add/edit dialogs wrap queryFns in try/catch, set `retry: false`, and `refetchOnWindowFocus: false` to prevent unhandled rejections or spinner storms
- **User feedback**: When quotes are unavailable (offline or provider error), a banner displays showing i18n key `watchlist.quotesOffline` ("Live quotes unavailable. Showing target prices only.")
- **Target price fallback**: Page continues to show target prices and allow editing even when live quotes are unavailable

Code links: [[apps/frontend/src/pages/portfolio/WatchlistPage.tsx]], [[apps/frontend/src/hooks/useOnlineStatus.ts]]

## i18n Fixes (2026-04-28)

**Dutch Localization Cleanup:**
- Fixed corrupted `watchlist.empty` i18n key in Dutch (`nl.json`): previously contained ~80 escaped backslashes instead of actual newline character (`\n`)
  - Fixed in: `i18n/source/nl.json`, `apps/frontend/src/locales/nl.ts`, `packaging/electron/i18n/nl.json`
- Translated `portfolio.refreshPricesFailedTitle` from English "Refresh prices failed" to Dutch "Bijwerken van koersen mislukt"
- Translated `portfolio.recordTxnFailedTitle` from English "Record transaction failed" to Dutch "Registreren van portfoliotransactie mislukt"

**Dutch Translation Gap — RESOLVED (2026-06-16):**
- The `*FailedTitle` keys (categories/recipients/transactions/portfolio — 18 keys total) that
  previously displayed English text in the Dutch locale are now fully translated in
  `i18n/source/nl.json`. No remaining `*FailedTitle` gap.

## Adding from Watchlist

Users can promote a watchlist item to a full portfolio investment with one click, which:
1. Opens the `AddInvestmentFromMarketDialog` pre-filled with the watchlist data
2. Creates the investment in the portfolio
3. Optionally removes the item from the watchlist

## Related Features

- [[docs/features/portfolio|Portfolio]] — Full investment tracking
- [[docs/features/market-lookup|Market Lookup]] — Finding securities to add to watchlist or portfolio
- [[docs/integrations/price-providers|Price Providers]] — Live price fetching
