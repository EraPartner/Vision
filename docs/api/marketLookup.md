---
title: Market Lookup API
type: endpoint
status: active
date: 2026-04-10
updated: 2026-06-16
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

Get quotes (and optionally fundamentals) for one or more symbols. Supports a `detail` mode to trade response richness for fewer upstream Yahoo Finance calls.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `symbols` | string | Yes | — | Comma-separated list of symbols (e.g., `"AAPL,MSFT"`) |
| `detail` | string | No | `"full"` | Response mode: `"basic"` or `"full"`. See below. |

**Detail modes:**

| Mode | Yahoo calls per symbol | Fields returned |
|------|------------------------|-----------------|
| `"full"` (default) | 2 — `quote()` + `quoteSummary()` | All fields: core price fields + fundamentals/analyst fields |
| `"basic"` | 1 — `quote()` only | Core price fields only (no fundamentals/analyst fields) |

Use `detail=basic` for price-only views such as benchmark strips, watchlist previews, and chart dialogs. This roughly halves outbound Yahoo Finance calls for those surfaces. The Market Lookup detail page uses the default `full` mode to render fundamentals and analyst data.

**Response — `detail=full` (default):** `200 OK`

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

**Response — `detail=basic`:** `200 OK`

Same envelope shape (`{ "quotes": [ … ] }`), but each quote object contains only the core price fields. The fundamentals/analyst fields (`marketCap`, `pe`, `forwardPE`, `dividendYield`, `eps`, `beta`, `priceToBook`, `analystConsensus`, `recentAnalystActions`) are **omitted**.

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
      "low52w": 164.08
    }
  ]
}
```

**Error Response:** `502 Bad Gateway` - Market quote unavailable

**Validation Notes:**
- The `symbols` parameter must be a non-empty string. If `symbols` is missing or not a string, returns `400 Bad Request` with `ValidationError`. If the string cannot be split (malformed), returns `502 Bad Gateway` with `AppError`.
- An unrecognised `detail` value is treated as `"full"` (permissive fallback).

**Frontend callers and detail mode:**

| Caller | Mode |
|---|---|
| Research home benchmark strip (`^GSPC`, `^STOXX50E`, `^FTSE`, `^BFX`, `BTC-USD`) | `basic` |
| Research home watchlist preview tiles | `basic` |
| Watchlist page quote rows | `basic` |
| Watchlist chart dialog | `basic` |
| Add-to-watchlist dialog | `basic` |
| Market Lookup detail page (`MarketLookupPage`) | `full` (default) |

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

All `/api/market/*` endpoints are subject to a 90 req/min route-group limiter (`marketRateLimiter`; bypassed in development). This bounds upstream Yahoo Finance API hammering. See [[docs/security/rate-limiting|Rate Limiting]] for details.

## Data Source

Data is provided by Yahoo Finance via the `yahoo-finance2` library. Some data may be delayed.

## See Also

- [[docs/api/index]] - API Index
- [[docs/api/investments]] - Investments API
- [[docs/api/watchlist]] - Watchlist API

## Test Coverage Notes

### `detail=basic` mode (2026-06-16)

`GET /api/market/quote` gained an optional `detail` query parameter (`"basic"` | `"full"`, default `"full"`). When `detail=basic`, the handler issues a single `yahooFinance.quote()` call per symbol and skips the per-symbol `quoteSummary` fetch, returning only the core price fields. This halves outbound Yahoo Finance calls for price-only views. The test suite (`apps/node-backend/tests/routes/marketLookup.test.js`) has a new basic-mode case; the suite is 22 route tests total.

### Error Handling Improvements (2026-04-22)

The `GET /api/market/quote` handler now performs safe parameter validation:
- Missing or non-string `symbols` parameter validation occurs early and throws `ValidationError` (400).
- The `symbols.split()` operation is now wrapped inside the try-catch block, so malformed string operations return `AppError(502)` instead of raw TypeErrors escaping to the error handler.
- This follows the **envelope-aware error handling** pattern documented in [[docs/adr/026-unified-api-response-envelope|ADR-026]].

### Test Migration (2026-04-22)

Backend import route tests were updated to validate the unified API response envelope (ADR-026):
- Validation errors use `.rejects.toBeInstanceOf(ValidationError)` to assert exception type.
- Success responses check `body.data.xxx` fields instead of `body.xxx` (envelope wrapping).
- Mock response helper now includes `res.ok(data, meta)` method to wrap responses in the envelope.
- This test pattern is now the canonical approach across all route test suites.

### Earlier Notes (2026-04-10)

- Quote + summary mapping behavior when provider responses are available.
- Quote failure fallback behavior returning `{"quotes": []}` for partial failure tolerance.
- `GET /api/market/news` deduplication by title and server-side thumbnail normalization.
- News search failure tolerance returning `{"articles": []}`.

Code links: [[apps/node-backend/tests/routes/marketLookup.test.js]], [[apps/node-backend/src/routes/marketLookup.js]], [[apps/node-backend/tests/routes/import.test.js]]
