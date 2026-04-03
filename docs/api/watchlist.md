---
title: API - Watchlist
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/watchlist
description: Investment watchlist management
date: 2026-04-02
tags: [api, watchlist, investments]
status: active
aliases: [watchlist-api, tracked-symbols, watch list]
related_code: [[apps/node-backend/src/routes/watchlist.js]], [[apps/node-backend/src/repositories/watchlistRepository.js]]
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
