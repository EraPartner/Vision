---
title: Market Lookup Feature
type: feature
status: active
date: 2026-04-02
tags: [feature, market, lookup, stocks, search, frontend]
description: Market security lookup for finding stocks, ETFs, and other securities to add to the portfolio
aliases: [stock lookup, market search, security search, ticker search]
related_code:
  - apps/frontend/src/pages/MarketLookupPage.tsx
  - apps/node-backend/src/routes/marketLookup.js
---

# Market Lookup Feature

## Overview

The Market Lookup page (`/portfolio/market`) allows users to search for publicly traded securities (stocks, ETFs) by name or ticker symbol and add them directly to their portfolio. It integrates with external market data providers to find securities.

## Architecture

### Frontend Page

Located at `[[apps/frontend/src/pages/MarketLookupPage.tsx]]`, the page provides:

1. **Search input**: Text search for security names and ticker symbols
2. **Results list**: Matching securities with name, symbol, exchange, and type
3. **Add to portfolio**: One-click action to create a new investment from search results

### Backend Endpoints

Located at `[[apps/node-backend/src/routes/marketLookup.js]]`:

#### GET /api/market-lookup/search

Searches for securities matching a query string.

**Query parameters:**
- `q` — Search query (required)
- `type` — Filter by security type (optional)

**Response:**
```json
{
  "results": [
    {
      "symbol": "AAPL",
      "name": "Apple Inc.",
      "exchange": "NASDAQ",
      "type": "stock"
    }
  ],
  "total": 1
}
```

#### GET /api/market-lookup/symbol/:symbol

Gets detailed information for a specific symbol.

### Integration with Price Providers

The market lookup uses the same price provider infrastructure as the portfolio:
- **Yahoo Finance**: Primary source for stock/ETF lookups
- **Binance**: For cryptocurrency symbols

### Adding to Portfolio

When a user selects a security from search results:
1. The `AddInvestmentFromMarketDialog` component opens
2. Pre-fills the investment form with symbol, name, and provider
3. User confirms or modifies details
4. Creates the investment via `POST /api/investments`

## Query Configuration

```typescript
// Market lookup queries are handled directly via apiClient.request()
// rather than dedicated hooks, as they are infrequently used
```

## Related Features

- [[docs/features/portfolio|Portfolio]] — Investment management
- [[docs/integrations/price-providers|Price Providers]] — Market data sources
