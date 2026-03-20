---
title: Feature - Portfolio & Investments
type: feature
status: active
date: 2026-03-18
tags: [feature, portfolio, investments, stocks, crypto]
description: Track stocks, ETFs, crypto, real estate, savings, and bonds
related_code: ["apps/node-backend/src/routes/investments.js", "apps/node-backend/src/services/priceProviderService.js"]
---

# Feature: Portfolio & Investments

## Overview

Vision's portfolio management tracks various investment types with live price updates and comprehensive transaction history.

## Supported Asset Classes

| Asset Class | Description | Examples |
|-------------|-------------|----------|
| stock | Individual stocks | AAPL, MSFT, TSLA |
| etf | Exchange-traded funds | IWDA, VWCE |
| crypto | Cryptocurrencies | BTC, ETH |
| real_estate | Property investments | Apartments, houses |
| savings | Savings accounts | Term deposits |
| bonds | Fixed income | Government bonds |

## Investment Management

### Creating Investments
```javascript
POST /api/investments
{
  "name": "Apple Inc.",
  "symbol": "AAPL",
  "asset_class": "stock",
  "currency": "USD",
  "current_price": 185.50,
  "price_provider": "yahoo",
  "price_provider_id": "AAPL"
}
```

### Price Providers

| Provider | Asset Classes | API |
|----------|---------------|-----|
| manual | all | User-entered prices |
| coingecko | crypto | CoinGecko API |
| yahoo | stock, etf | Yahoo Finance |
| kraken | crypto | Kraken Exchange |
| custom | all | Custom API endpoint |

### Price Refresh
```
POST /api/investments/refresh-prices
```

Updates all investments with non-manual price providers.

## Portfolio Transactions

### Transaction Types

| Type | Description |
|------|-------------|
| buy | Purchase of units |
| sell | Sale of units |
| dividend | Dividend payment |
| fee | Transaction fees |
| taxes | Tax payments |
| interest | Interest income |
| rent_income | Rental income (real estate) |
| appreciation | Value appreciation |

### Recording Transactions
```javascript
POST /api/investments/:id/transactions
{
  "type": "buy",
  "date": "2026-01-15",
  "amount": 1855.00,
  "units": 10,
  "price_per_unit": 185.50,
  "fees": 5.00,
  "currency": "USD"
}
```

## Holdings Calculation

Portfolio calculates:
- **Total Units**: Sum of all buy/sell transactions
- **Average Cost**: Weighted average purchase price
- **Current Value**: Units × Current Price
- **Total Dividends**: Sum of all dividend transactions
- **Total Fees**: Sum of all fees
- **Gains/Losses**: Current Value - Total Cost

## Belgian Tax Features

### Real Estate Fields
- `municipality`: Belgian municipality name
- `cadastral_income`: Kadastraal inkomen
- `municipality_tax_rate`: Municipal tax rate

These support Belgian tax reporting requirements.

## Watchlist

Track investments without owning them:

```javascript
POST /api/watchlist
{
  "name": "Tesla Inc.",
  "symbol": "TSLA",
  "asset_class": "stock",
  "target_price": 250.00,
  "currency": "USD"
}
```

## Net Worth Tracking

Portfolio automatically contributes to net worth calculations via materialized views.

## Related

- [[docs/api/investments|API: Investments]]
- [[docs/api/watchlist|API: Watchlist]]
- [[docs/adr/002-database-schema|Database Schema]]
