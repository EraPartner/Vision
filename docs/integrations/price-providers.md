---
title: Integration - Price Providers
type: integration
description: Live price feeds for stocks, crypto, and other investments
date: 2026-03-24
tags: [integration, price, stocks, crypto, api]
related_code: [[apps/node-backend/src/services/priceProviderService.js]]
---

# Integration: Price Providers

## Overview

Price providers fetch live market prices for investments, supporting multiple asset classes and data sources.

## Supported Providers

### Manual
- **Asset Classes**: All
- **Usage**: User enters prices manually
- **Implementation**: No API calls, uses stored `current_price`

### CoinGecko
- **Asset Classes**: Crypto
- **API**: CoinGecko Free API
- **Endpoint**: `https://api.coingecko.com/api/v3/simple/price`
- **Features**: 
  - Free tier (limited calls)
  - Historical data available
  - Market cap, volume

### Yahoo Finance
- **Asset Classes**: Stocks, ETFs, Metals
- **Implementation**: Web scraping / Yahoo Finance API
- **Features**:
  - Real-time quotes
  - Previous close fallback when real-time quote is unavailable/zero
  - Historical data
  - Wide coverage
  - Supports futures-style metals tickers (for example, `GC=F`)

### Kraken
- **Asset Classes**: Crypto
- **API**: Kraken REST API
- **Endpoint**: `https://api.kraken.com/0/public/Ticker`
- **Features**:
  - Real-time exchange rates
  - Multiple trading pairs

### Custom
- **Asset Classes**: All
- **Configuration**: Custom API URL and parameters
- **Usage**: For proprietary or unsupported APIs

## Usage

### Configure Investment
```javascript
POST /api/investments
{
  "name": "Bitcoin",
  "symbol": "BTC",
  "asset_class": "crypto",
  "price_provider": "coingecko",
  "price_provider_id": "bitcoin"
}
```

### Refresh Prices
```javascript
POST /api/investments/refresh-prices
```

Response:
```json
{
  "updated": 10,
  "total": 15,
  "prices": {
    "1": 45000.00,
    "2": 185.50
  },
  "priceSources": {
    "1": "live",
    "2": "close",
    "3": "cached"
  }
}
```

## Price Provider Fields

| Field | Type | Description |
|-------|------|-------------|
| price_provider | enum | Provider name |
| price_provider_id | string | Provider-specific ID |
| price_provider_url | string | Custom endpoint URL |
| price_updated_at | timestamp | Last price fetch |

## Rate Limits

- CoinGecko: ~10-30 calls/minute (free tier)
- Yahoo: Depends on usage
- Kraken: 15 calls/second

## Error Handling

If price fetch fails:
- Fallback to previous close where available (Yahoo)
- Fallback to latest historical close from Yahoo chart data when quote fields are unavailable
- Fallback to existing stored `current_price` when provider data is unavailable
- Log error
- Continue with other investments

## Related

- [[docs/api/investments|API: Investments]]
- [[docs/features/portfolio|Feature: Portfolio]]
