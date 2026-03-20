---
title: Integration - Price Providers
type: integration
description: Live price feeds for stocks, crypto, and other investments
date: 2026-03-18
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
- **Asset Classes**: Stocks, ETFs
- **Implementation**: Web scraping / Yahoo Finance API
- **Features**:
  - Real-time quotes
  - Historical data
  - Wide coverage

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
- Keep existing price
- Log error
- Continue with other investments

## Related

- [[docs/api/investments|API: Investments]]
- [[docs/features/portfolio|Feature: Portfolio]]
