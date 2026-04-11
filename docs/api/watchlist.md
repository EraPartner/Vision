---
title: API - Watchlist
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/watchlist
description: Investment watchlist management
date: 2026-04-10
tags: [api, watchlist, investments]
status: active
aliases: [watchlist-api, tracked-symbols, watch list]
related_code:
  - apps/node-backend/src/routes/watchlist.js
  - apps/node-backend/src/repositories/watchlistRepository.js
---

# Watchlist API

## Overview

The Watchlist API manages investment watchlists for tracking stocks, ETFs, and cryptocurrencies with target prices.

## Endpoints

### GET /api/watchlist

Retrieve all watchlist items.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 50 | Max items to return |
| offset | integer | 0 | Items to skip |
| asset_class | string | null | Filter by asset class (stock, etf, crypto) |

Notes:
- `limit` is normalized to a safe range of `1..5000` (default `50`).
- `offset` is normalized to a minimum of `0` (default `0`).
- This preserves endpoint response shape while preventing unbounded list-page scans on malformed or extreme inputs ([[apps/node-backend/src/routes/watchlist.js]]).
- Watchlist list retrieval now uses repository one-query pagination (`getAllWithCount`) instead of separate `getAll` + `getCount` calls in route code; ordering/filter behavior and response shape are unchanged ([[apps/node-backend/src/routes/watchlist.js]], [[apps/node-backend/src/repositories/watchlistRepository.js]]).

**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "name": "Tesla Inc.",
      "symbol": "TSLA",
      "asset_class": "stock",
      "target_price": 250.00,
      "currency": "USD",
      "notes": "Watch for drop",
      "price_provider_id": "TSLA",
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-01T00:00:00Z"
    }
  ],
  "total": 10,
  "limit": 50,
  "offset": 0
}
```

### POST /api/watchlist

Add item to watchlist.

**Request Body:**
```json
{
  "name": "Tesla Inc.",
  "symbol": "TSLA",
  "asset_class": "stock",
  "target_price": 250.00,
  "currency": "USD",
  "notes": "Watch for drop",
  "price_provider_id": "TSLA"
}
```

**Required Fields:** name, asset_class, target_price

### GET /api/watchlist/:id

Get single watchlist item.

### PATCH /api/watchlist/:id

Update watchlist item.

### DELETE /api/watchlist/:id

Remove item from watchlist.

## Related

- [[docs/api/investments|Investments API]]

## Testing references (2026-04-10)

- [[apps/node-backend/tests/routes/watchlist.test.js]] adds route-level regression coverage for query normalization (`limit`, `offset`), validation/error paths, defaulting behavior, and not-found responses for `GET /api/watchlist/:id`.

Related docs: [[docs/testing/testing|Testing Documentation]], [[docs/testing/test-inventory|Test Inventory]].
