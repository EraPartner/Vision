---
title: Market Lookup Feature
type: feature
status: active
date: 2026-06-05
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

#### Provider-aware detail view (non-Yahoo holdings)

Search, quote, chart, and news are served from Yahoo (`/api/market/*`). Yahoo has
no data for symbols that price via Vision's own providers — Kinesis (`KAU_EUR`,
`KAG_EUR`, …), custom JSON endpoints, or Binance crypto symbols — so a free
symbol lookup of those shows empty quote/chart.

When the page is opened **from a portfolio holding** (double-click the name in the
investment detail dialog or a holdings table), the URL carries `investmentId`
alongside `symbol`. If that holding's `price_provider` is not `yahoo`, the page:

- Resolves the holding from `usePortfolio()` summaries.
- Serves the **Price Chart** from the holding's own stored history via
  `GET /api/investments/:id/price-history` (range mapped to `from_ms`), reusing the
  same provider pipeline the portfolio overlay uses — including Kinesis USD→EUR
  historical-rate conversion. Points carry only a price, so high/low collapse to
  close and there are no volume bars.
- Synthesizes a minimal price/change header from those points (change is measured
  across the visible range).
- Hides the fundamentals, analyst, and news sections, which don't exist for these
  assets.

Yahoo holdings and free symbol search are unchanged — they still use the full
Yahoo quote/chart/news path.

> **Upstream resilience (`validateResult: false`):** every market-route Yahoo call
> — search, quote, quoteSummary, chart, and news — passes `{ validateResult: false }`
> to yahoo-finance2. The library validates each upstream payload against its own
> schema and *throws* on any mismatch; Yahoo's responses drift (new `quoteType`s,
> non-Yahoo search entries missing `name`/`permalink`, null chart `meta`) and vary by
> IP/geo, so otherwise-fine requests intermittently 502 — empty search dropdowns,
> broken charts. We read only a small subset of well-known fields, so the routes opt
> out of the throw and degrade to whatever data came back. Note: yahoo-finance2
> v3.14.1 is behind latest; bumping it may reduce (but won't eliminate) these drifts.

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
