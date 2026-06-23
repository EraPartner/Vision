---
title: API - Watchlist
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/watchlist
description: Investment watchlist management
date: 2026-06-18
updated: 2026-06-18
tags: [api, watchlist, investments, validation, backtest, added-price, adr-097, migration-0058]
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
| asset_class | string | null | Filter by asset class (stock, etf, crypto, metals) |

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
      "added_price": 212.50,
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
  "added_price": 212.50,
  "currency": "USD",
  "notes": "Watch for drop",
  "price_provider_id": "TSLA"
}
```

**Required Fields:** `name`, `asset_class`, `target_price`

**`added_price` (June 2026, ADR-097, migration 0058):**

Optional field. When omitted, the backend attempts to snapshot the live quote for `symbol` at add time and set `added_price` automatically. If no quote is available, `added_price` is stored as `null`. The frontend displays "Since added {date} +X%" only when `added_price` is non-null.

`PATCH /api/watchlist/:id` can update `added_price` to reset the baseline.

> [!info] Migration required
> `added_price` is added by migration 0058 (authored, not applied). Until the migration runs, the column does not exist and the backtest display is suppressed.

**Field Validation (June 2026):**

POST and PATCH now validate typed fields before reaching the database, returning `400 ValidationError` instead of a DB-level 500 on bad input:

| Field | Rule | Error message |
|-------|------|---------------|
| `target_price` | Finite number ≥ 0 | `target_price must be a non-negative number` |
| `asset_class` | One of `stock`, `etf`, `crypto`, `metals` | `asset_class must be one of: stock, etf, crypto, metals` |
| `currency` | Exactly 3 letters (`/^[A-Za-z]{3}$/`) | `currency must be a 3-letter code` |

For PATCH, validation applies only to fields that are present in the request body (partial update semantics are preserved). The repository's column allowlist continues to prevent injection regardless of validation.

> [!info] Non-breaking change
> This tightening only affects requests that would have previously surfaced as opaque 500 errors. Callers sending well-formed data are unaffected.

### GET /api/watchlist/:id

Get single watchlist item.

### PATCH /api/watchlist/:id

Update watchlist item. Accepts any subset of writable fields. See field validation rules above.

### DELETE /api/watchlist/:id

Remove item from watchlist.

## Related

- [[docs/api/investments|Investments API]]

## Testing references (2026-04-10)

- [[apps/node-backend/tests/routes/watchlist.test.js]] adds route-level regression coverage for query normalization (`limit`, `offset`), validation/error paths, defaulting behavior, and not-found responses for `GET /api/watchlist/:id`.

Related docs: [[docs/testing/testing|Testing Documentation]], [[docs/testing/test-inventory|Test Inventory]].
