---
title: API - Investments
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/investments
description: Investment portfolio management (stocks, crypto, real estate, savings)
date: 2026-03-18
tags: [api, investments, portfolio, stocks, crypto]
related_code: [[apps/node-backend/src/routes/investments.js]]
---

# Investments API

## Overview

The Investments API manages investment holdings across various asset classes: stocks, ETFs, crypto, real estate, savings, and bonds. It supports live price feeds from multiple providers.

## Endpoints

### GET /api/investments

Retrieve a list of investments.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 200 | Max items (max 1000) |
| offset | integer | 0 | Items to skip |
| asset_class | string | null | Filter by asset class |
| active | boolean | true | Show active/inactive |

**Asset Class Values:** stock, etf, crypto, real_estate, savings, bond

**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "name": "Apple Inc.",
      "symbol": "AAPL",
      "asset_class": "stock",
      "currency": "USD",
      "current_price": 185.50,
      "interest_rate": null,
      "maturity_date": null,
      "location": null,
      "municipality": null,
      "cadastral_income": null,
      "municipality_tax_rate": null,
      "notes": "Tech stock",
      "is_active": true,
      "price_provider": "yahoo",
      "price_provider_id": "AAPL",
      "price_provider_url": null,
      "price_updated_at": "2026-03-18T10:00:00Z",
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-03-18T10:00:00Z"
    }
  ],
  "total": 50,
  "limit": 200,
  "offset": 0,
  "links": []
}
```

### GET /api/investments/providers

Get supported price providers.

**Response:**
```json
{
  "providers": ["manual", "coingecko", "yahoo", "kraken", "custom"]
}
```

### POST /api/investments/refresh-prices

Refresh prices from live providers for all investments.

**Response:**
```json
{
  "updated": 10,
  "total": 15,
  "prices": {
    "1": 185.50,
    "2": 45000.00
  }
}
```

### POST /api/investments

Create a new investment.

**Request Body:**
```json
{
  "name": "Apple Inc.",
  "symbol": "AAPL",
  "asset_class": "stock",
  "currency": "USD",
  "current_price": 185.50,
  "price_provider": "yahoo",
  "price_provider_id": "AAPL",
  "notes": "Tech stock"
}
```

**Required Fields:** name, asset_class

### GET /api/investments/:id

Get a single investment by ID.

### PATCH /api/investments/:id

Update an investment.

### DELETE /api/investments/:id

Delete an investment (hard delete).

### GET /api/investments/:id/transactions

Get portfolio transactions for an investment.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| type | string | null | Filter by transaction type |
| limit | integer | 200 | Max items |
| offset | integer | 0 | Items to skip |

**Transaction Types:** buy, sell, dividend, fee, tax, interest, rent_income, appreciation

### POST /api/investments/:id/transactions

Create a portfolio transaction.

**Request Body:**
```json
{
  "type": "buy",
  "date": "2026-01-15",
  "amount": 1855.00,
  "units": 10,
  "price_per_unit": 185.50,
  "fees": 5.00,
  "currency": "USD",
  "note": "Initial purchase"
}
```

**Required Fields:** type, date, amount

### DELETE /api/investments/transactions/:txnId

Delete a portfolio transaction.

### GET /api/investments/:id/summary

Get investment summary with holdings breakdown.

**Response:**
```json
{
  "investment_id": 1,
  "breakdown": {
    "total_units": 50,
    "total_cost": 9000.00,
    "current_value": 9275.00,
    "total_dividends": 250.00,
    "total_fees": 25.00
  }
}
```

## Price Providers

| Provider | Asset Classes | Description |
|----------|---------------|-------------|
| manual | all | Manual price entry |
| coingecko | crypto | CoinGecko API |
| yahoo | stock, etf | Yahoo Finance |
| kraken | crypto | Kraken exchange |
| custom | all | Custom API |

## Belgian Tax Fields

For real estate investments:
- `municipality`: Belgian municipality name
- `cadastral_income`: Cadastral income (kadastraal inkomen)
- `municipality_tax_rate`: Municipal tax rate

## Related

- [[docs/api/watchlist|Watchlist API]]
- [[docs/adr/002-database-schema|Database Schema]]
