---
title: Market Lookup API
type: endpoint
status: active
date: 2026-04-10
tags:
  - api
  - market
  - stocks
  - finance
description: API endpoints for real-time market data, search, quotes, and charts
aliases:
  - market-api
  - stock-search
  - quotes-api
  - yahoo-finance
related_code:
  - apps/node-backend/src/routes/marketLookup.js
---

# Market Lookup API

Real-time market data endpoints powered by Yahoo Finance. Provides stock search, quotes, historical charts, and news.

## Base URL

```
/api/market
```

## Endpoints

### GET /api/market/search

Search for stock tickers and companies.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search query (e.g., "apple") |

**Response:** `200 OK`

```json
{
  "items": [
    {
      "symbol": "AAPL",
      "name": "Apple Inc.",
      "type": "EQUITY",
      "exchange": "NASDAQ"
    }
  ]
}
```

**Error Response:** `502 Bad Gateway` - Market search unavailable

---

### GET /api/market/quote

Get detailed quotes and fundamentals for one or more symbols.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbols` | string | Yes | Comma-separated list of symbols (e.g., "AAPL,MSFT") |

**Response:** `200 OK`

```json
{
  "quotes": [
    {
      "symbol": "AAPL",
      "name": "Apple Inc.",
      "price": 175.43,
      "change": 2.15,
      "changePercent": 1.24,
      "currency": "USD",
      "exchange": "NASDAQ",
      "type": "EQUITY",
      "open": 173.50,
      "dayHigh": 176.20,
      "dayLow": 173.00,
      "prevClose": 173.28,
      "volume": 52436789,
      "avgVolume": 61234567,
      "high52w": 199.62,
      "low52w": 164.08,
      "marketCap": 2750000000000,
      "pe": 28.45,
      "forwardPE": 24.32,
      "dividendYield": 0.0052,
      "eps": 6.17,
      "beta": 1.28,
      "priceToBook": 45.67,
      "analystConsensus": {
        "strongBuy": 12,
        "buy": 24,
        "hold": 8,
        "sell": 2,
        "strongSell": 0
      },
      "recentAnalystActions": [
        {
          "date": 1709203200,
          "firm": "Morgan Stanley",
          "toGrade": "Overweight",
          "fromGrade": "Equal-Weight",
          "action": "upgrade",
          "priceTarget": 200.00
        }
      ]
    }
  ]
}
```

**Error Response:** `502 Bad Gateway` - Market quote unavailable

---

### GET /api/market/chart

Get historical price chart data for a symbol.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `symbol` | string | Yes | - | Stock symbol (e.g., "AAPL") |
| `range` | string | No | `1mo` | Time range: `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `max` |
| `interval` | string | No | `1d` | Data interval: `1d`, `1wk`, `1mo` |

**Response:** `200 OK`

```json
{
  "symbol": "AAPL",
  "currency": "USD",
  "points": [
    {
      "time": 1709246400000,
      "close": 175.43,
      "high": 176.20,
      "low": 173.00,
      "volume": 52436789
    }
  ]
}
```

**Error Response:** `502 Bad Gateway` - Market chart unavailable

---

### GET /api/market/news

Get news articles for one or more symbols.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `symbols` | string | No | `SPY,QQQ,DIA` | Comma-separated symbols (max 10) |
| `count` | number | No | 20 | Number of articles (max 50) |

**Response:** `200 OK`

```json
{
  "articles": [
    {
      "title": "Apple Reports Strong Q4 Earnings",
      "link": "https://finance.yahoo.com/...",
      "publisher": "Yahoo Finance",
      "publishedAt": 1709300000000,
      "thumbnail": "https://image.com/thumb.jpg",
      "relatedSymbols": ["AAPL"]
    }
  ]
}
```

**Error Response:** `502 Bad Gateway` - Market news unavailable

**Implementation notes (news thumbnails):**

- Thumbnail URLs are normalized server-side before returning articles:
  - Protocol-relative `//...` URLs are converted to `https://...`
  - `http://...` URLs are upgraded to `https://...`
- Backend CSP now allows remote HTTPS images via `img-src 'self' data: https:` so external Yahoo/provider thumbnails can render.
- Yahoo thumbnail arrays now select the best available resolution instead of always taking the first resolution.
- Frontend consumers render these URLs via a shared safe image component; news cards can pass `fallbackClassName="hidden"` to suppress placeholder icon boxes when fetches fail.

Code links: [[apps/node-backend/src/main.js]], [[apps/node-backend/src/routes/marketLookup.js]], [[apps/frontend/src/components/shared/RemoteNewsImage.tsx]], [[apps/frontend/src/components/portfolio/PortfolioNewsFeed.tsx]], [[apps/frontend/src/pages/MarketLookupPage.tsx]]

---

## Rate Limiting

Market lookup endpoints are subject to [[docs/security/rate-limiting]] due to external API dependencies.

## Data Source

Data is provided by Yahoo Finance via the `yahoo-finance2` library. Some data may be delayed.

## See Also

- [[docs/api/index]] - API Index
- [[docs/api/investments]] - Investments API
- [[docs/api/watchlist]] - Watchlist API

## Test Coverage Notes (2026-04-10)

Recent backend tests validate:
- `GET /api/market/quote` missing `symbols` request validation (`400`).
- Quote + summary mapping behavior when provider responses are available.
- Quote failure fallback behavior returning `{"quotes": []}` for partial failure tolerance.
- `GET /api/market/news` deduplication by title and server-side thumbnail normalization.
- News search failure tolerance returning `{"articles": []}`.

Code links: [[apps/node-backend/tests/routes/marketLookup.test.js]], [[apps/node-backend/src/routes/marketLookup.js]]
