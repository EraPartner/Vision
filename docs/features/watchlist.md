---
title: Watchlist Feature
type: feature
status: active
date: 2026-04-02
tags: [feature, watchlist, investments, tracking, alerts]
description: Investment watchlist for tracking securities not yet in the portfolio with target price alerts
aliases: [watch list, price alerts, investment tracking]
related_code:
  - apps/frontend/src/pages/portfolio/WatchlistPage.tsx
  - apps/frontend/src/hooks/usePortfolio.ts
  - apps/frontend/src/types/watchlist.ts
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

Adds a security to the watchlist.

### PATCH /api/watchlist/:id

Updates a watchlist item (e.g., set target price).

### DELETE /api/watchlist/:id

Removes a security from the watchlist.

## Display Logic

The watchlist page uses a smart display strategy:

- **At or below target**: Shows the current price (encourages buying)
- **Above target**: Shows the percentage above target (shows how much it's exceeded)

This provides actionable information: either "it's cheap enough" (price shown) or "it's gone up X%" (percentage shown).

## Price Updates

Watchlist prices are updated when:
1. The user manually refreshes investment prices via `POST /api/investments/refresh-prices`
2. The price provider service fetches live prices for all tracked symbols

## Adding from Watchlist

Users can promote a watchlist item to a full portfolio investment with one click, which:
1. Opens the `AddInvestmentFromMarketDialog` pre-filled with the watchlist data
2. Creates the investment in the portfolio
3. Optionally removes the item from the watchlist

## Related Features

- [[docs/features/portfolio|Portfolio]] — Full investment tracking
- [[docs/features/market-lookup|Market Lookup]] — Finding securities to add to watchlist or portfolio
- [[docs/integrations/price-providers|Price Providers]] — Live price fetching
