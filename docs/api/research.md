---
title: Research API
type: endpoint
status: active
date: 2026-06-16
updated: 2026-06-16
tags:
  - api
  - research
  - holdings-preseed
  - market-data
  - multi-provider
  - capability-map
  - quota-governor
  - adr-079
description: Provider-agnostic research API surface (ADR-079). Six GET endpoints under /api/research expose ticker search, live quotes, historical charts, fundamentals, analyst consensus, and news — routed across providers via the capability map, quota governor, and type-aware cache. All five provider adapters (Yahoo + Twelve Data, Finnhub, FMP, Alpha Vantage) are implemented; the keyed four light up automatically when their API key is set in the root .env.
aliases:
  - research-api
  - research-endpoints
  - multi-provider-research
related_code:
  - apps/node-backend/src/routes/research.js
  - apps/node-backend/src/services/research/researchAggregator.js
  - apps/node-backend/src/services/research/capabilityMap.js
  - apps/node-backend/src/services/research/quotaGovernor.js
  - apps/node-backend/src/services/research/researchCache.js
  - apps/node-backend/src/services/research/providerKeys.js
  - apps/node-backend/src/services/research/adapters/yahooAdapter.js
  - apps/node-backend/src/repositories/providerQuotaRepository.js
---

# Research API

Provider-agnostic market research surface introduced in [[docs/adr/079-multi-provider-research-aggregation|ADR-079]]. Six GET endpoints delegate to the **research aggregation layer**, which routes each request across an ordered provider chain — checking quota, skipping unhealthy/unkeyed providers, returning the first successful response, and caching the result for its type-appropriate TTL.

## Base URL

```
/api/research
```

All endpoints are mounted under the existing `marketRateLimiter` (same limiter as `/api/market/*`).

## Response Envelope

Every endpoint returns the standard ADR-026 envelope with two additional provenance fields in `meta`:

```json
{
  "ok": true,
  "data": { /* endpoint-specific payload, or null when unavailable */ },
  "meta": {
    "provider": "yahoo",
    "source": "live"
  }
}
```

| `meta` field | Values | Meaning |
|---|---|---|
| `provider` | string or `null` | Which provider answered. `null` if all providers were skipped or unavailable. |
| `source` | `"cache"` | Response served from the in-memory TTL cache — no outbound call made, no quota spent. |
| | `"live"` | Fresh response from the winning provider. |
| | `"unavailable"` | All providers in the chain were exhausted (quota, unhealthy, or unkeyed); `data` is the stable empty shape for the type (`{ items: [] }`, `{ points: [] }`, etc.). |

> [!info] Provenance on the frontend
> When `meta.source === 'unavailable'` the UI should show a "not available" indicator rather than a loading spinner or empty state — the data genuinely could not be fetched for this session.

## Endpoints

---

### GET /api/research/search

Search for tickers or securities by name or ticker symbol.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search query (e.g., `"apple"` or `"AAPL"`) |

**Behavior:** If `q` is blank or missing, returns immediately with `{ items: [] }` and `source: 'live'` (no provider call).

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "symbol": "AAPL",
        "name": "Apple Inc.",
        "exchange": "NASDAQ",
        "type": "EQUITY"
      }
    ]
  },
  "meta": { "provider": "yahoo", "source": "live" }
}
```

**Cache TTL:** 10 minutes

---

### GET /api/research/quote

Current quote for a single symbol.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | Yes | Ticker symbol (e.g., `AAPL`) |
| `asset_class` | string | No | Asset class hint for provider routing: `stock`, `crypto`, `metals`, `etf`. Defaults to the `default` capability chain when omitted. |

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "symbol": "AAPL",
    "name": "Apple Inc.",
    "price": 213.55,
    "change": 1.24,
    "changePercent": 0.58,
    "currency": "USD",
    "exchange": "NASDAQ",
    "marketCap": 3240000000000
  },
  "meta": { "provider": "yahoo", "source": "cache" }
}
```

**Error Responses:**
- `400 Bad Request` — `symbol` parameter missing

**Cache TTL:** 10 minutes

---

### GET /api/research/chart

Historical price chart points for a symbol.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `symbol` | string | Yes | — | Ticker symbol |
| `asset_class` | string | No | — | Asset class hint for provider routing |
| `range` | string | No | `1mo` | Time range: `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `max` |

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "points": [
      { "time": 1748304000000, "close": 211.12, "high": 213.00, "low": 209.50, "volume": 52000000 }
    ]
  },
  "meta": { "provider": "yahoo", "source": "live" }
}
```

**Error Responses:**
- `400 Bad Request` — `symbol` parameter missing

**Cache TTL:** 12 hours

---

### GET /api/research/fundamentals

Fundamentals snapshot for a symbol (P/E, EPS, market cap, book value, dividend yield, etc.).

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | Yes | Ticker symbol |
| `asset_class` | string | No | Asset class hint for provider routing |

**Capability chain:** `[fmp, finnhub, yahoo]` for stocks/ETFs. FMP and Finnhub require their API keys to be present in `.env.local`; without keys those providers are skipped and Yahoo is the fallback.

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "pe": 32.5,
    "forwardPE": 27.8,
    "eps": 6.56,
    "priceToBook": 48.2,
    "dividendYield": 0.0051,
    "beta": 1.28,
    "marketCap": 3240000000000
  },
  "meta": { "provider": "yahoo", "source": "live" }
}
```

**Error Responses:**
- `400 Bad Request` — `symbol` parameter missing

**Cache TTL:** 24 hours

---

### GET /api/research/analyst

Analyst consensus ratings, price targets, and recent rating actions for a symbol.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | Yes | Ticker symbol |
| `asset_class` | string | No | Asset class hint for provider routing |

**Capability chain:** `[yahoo, finnhub, fmp]` for stocks/ETFs.

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "consensus": {
      "strongBuy": 14,
      "buy": 22,
      "hold": 6,
      "sell": 1,
      "strongSell": 0
    },
    "priceTarget": { "mean": 240.0, "low": 210.0, "high": 280.0 },
    "recentActions": [
      {
        "date": 1748390400000,
        "firm": "Morgan Stanley",
        "toGrade": "Overweight",
        "fromGrade": "Equal-Weight",
        "action": "upgrade",
        "priceTarget": 250.0
      }
    ]
  },
  "meta": { "provider": "yahoo", "source": "live" }
}
```

**Error Responses:**
- `400 Bad Request` — `symbol` parameter missing

**Cache TTL:** 24 hours

---

### GET /api/research/news

News articles for a symbol.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | Yes | Ticker symbol |

**Capability chain:** `[finnhub, yahoo]`. Finnhub requires `FINNHUB_API_KEY` in `.env.local`; without the key Yahoo is the sole provider.

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "articles": [
      {
        "title": "Apple raises dividend by 4%",
        "link": "https://finance.yahoo.com/...",
        "publisher": "Reuters",
        "publishedAt": 1748390400000,
        "thumbnail": "https://cdn.example.com/img.jpg"
      }
    ]
  },
  "meta": { "provider": "yahoo", "source": "cache" }
}
```

**Error Responses:**
- `400 Bad Request` — `symbol` parameter missing

**Cache TTL:** 2 hours

---

## Symbol Mapping Endpoints (ADR-079)

The cross-provider symbol map is the fool-proof anchor against silent wrong-instrument merges: a provider's data is only used for an instrument when a mapping records which symbol on that provider backs it. Mappings are stored in `instrument_provider_map`, anchored on ISIN (`key_type=isin`) where available or a Vision-internal id (`key_type=internal`) for crypto/metals. See [[apps/node-backend/src/services/research/researchMappingService.js]].

### GET /api/research/mappings

List stored mappings for an instrument. **Query:** `instrument_key` (required), `key_type` (`isin` | `internal`, default `isin`).

**Response:** `{ mappings: [ { id, instrument_key, key_type, provider, provider_symbol, resolved_name, exchange, currency, status, verified_at } ] }` — `status` ∈ `confirmed` | `auto` | `failed`.

### POST /api/research/mappings/resolve

Auto-propose a per-provider symbol by running each search-capable, keyed provider's search. **Does not persist** — the user confirms before saving. Each proposal carries the resolved `name`/`exchange` so ticker collisions (e.g. `APLE` vs `AAPL`) are caught at confirm time.

**Body:** `{ instrument_key, key_type?, asset_class?, query, investment_id? }` (`query` required).

`investment_id` (optional, positive integer) **pre-seeds from a held investment**: when the id resolves to an investment that already has both `price_provider` and `price_provider_id`, that provider is injected as a `confirmed` proposal carrying `fromHolding: true` (with the holding's `name` as `resolvedName` and its `currency`), and its **live search is skipped** — the holding already mapped it, so there is nothing to re-map. A stored `confirmed` mapping for that provider still wins, and providers are de-duplicated so none appears twice. Invalid/absent ids are ignored (behavior unchanged). The frontend passes it when the symbol page is opened from a holding (`?investmentId=`).

**Response:** `{ instrument_key, key_type, proposals: [ { provider, status, providerSymbol?, resolvedName?, exchange?, candidates?, fromStore?, fromHolding? } ], existing: [...] }`. Proposal `status` ∈ `auto` (proposed) | `confirmed` (kept from store or pre-seeded from a holding) | `skipped` (quota) | `none` (no hit) | `unavailable` (no adapter/key) | `error`.

### POST /api/research/mappings

Persist user-confirmed mappings (upsert one row per provider, default `status=confirmed`).

**Body:** `{ instrument_key, key_type?, mappings: [ { provider, providerSymbol, resolvedName?, exchange?, currency? } ] }` (non-empty array). **Response:** `{ mappings: [...] }` — the full stored set after upsert.

### DELETE /api/research/mappings/:id

Delete one stored mapping. **Response:** `{ removed: boolean }`.

### POST /api/research/mappings/audit

Cross-provider self-audit: fetches a quote from each mapped provider and flags `currency_mismatch` or `price_outlier` (>5% from the median) discrepancies, then stamps `verified_at` on the instrument's rows.

**Body:** `{ instrument_key, key_type? }`. **Response:** `{ ok: boolean, quotes: [ { provider, currency?, price?, skipped?/error? } ], discrepancies: [ { type, ... } ] }`.

---

## Provider API Keys (Settings)

Manage the keyed providers' API keys from the app (or via the root `.env`, ADR-080). Keys are stored in `provider_api_keys` (migration 0043), masked in responses (never returned in full), and a Settings value **overrides** the env var. Changes take effect immediately (the in-memory override map is updated and is hydrated at startup).

### GET /api/research/provider-keys

Returns `{ providers: [{ provider, label, envVar, configured, source, masked }] }` — `source` ∈ `settings` | `env` | `none`; `masked` shows only the last 4 characters.

### PUT /api/research/provider-keys/:provider

Body `{ api_key }`. Stores/replaces the key for `provider` (one of `twelve_data` / `finnhub` / `fmp` / `alpha_vantage`) and returns the updated masked statuses. `400` on unknown provider or empty key.

### DELETE /api/research/provider-keys/:provider

Clears the stored key (the env var, if set, then applies again). Returns `{ removed, providers }`.

## Aggregation Layer Architecture

The six data endpoints are thin wrappers over the `researchAggregator` singleton in [[apps/node-backend/src/services/research/researchAggregator.js]]. The orchestration steps on every request are:

1. **Cache check** — `researchCache.get(key)` keyed by `dataType:assetClass:symbol:range`. A hit returns `source: 'cache'` immediately; no quota is spent.
2. **Capability chain** — `resolveProviderChain(dataType, assetClass)` from [[apps/node-backend/src/services/research/capabilityMap.js]] returns the ordered provider preference for that data type and asset class. Providers absent an adapter method or API key are filtered out by `isProviderKeyed` ([[apps/node-backend/src/services/research/providerKeys.js]]).
3. **Quota gate** — `governor.canSpend(provider)` checks per-minute (in-memory) and per-day (persisted to `provider_quota` table via [[apps/node-backend/src/repositories/providerQuotaRepository.js]]) token buckets. A full bucket moves to the next provider instead of issuing a 429.
4. **Race-to-first** — The first provider that returns successfully wins. `governor.spend()` records the token, `providerHealthService.recordSuccess()` updates health, the result is cached with the type TTL.
5. **Provider error** — `providerHealthService.recordError()` is called, the error is noted in `attempted[]`, and the next provider is tried.
6. **Unavailable** — If all providers are skipped/errored, `source: 'unavailable'` is returned with a stable empty shape.

### Type-Aware Cache TTLs

| Data type | TTL |
|---|---|
| `search` | 10 min |
| `quote` | 10 min |
| `chart` | 12 h |
| `fundamentals` | 24 h |
| `analyst` | 24 h |
| `news` | 2 h |

The cache sweeps expired entries every 5 minutes (`setInterval` with `.unref()`).

### Capability Map (as shipped)

| Data type | Default chain | Crypto | Metals |
|---|---|---|---|
| `search` | yahoo → twelve_data → finnhub → fmp | — | — |
| `quote` | twelve_data → yahoo → finnhub → fmp → alpha_vantage | binance → twelve_data → yahoo | kinesis → yahoo → twelve_data |
| `chart` | twelve_data → yahoo → finnhub → alpha_vantage | binance → twelve_data → yahoo | kinesis → yahoo → twelve_data |
| `fundamentals` | fmp → finnhub → yahoo | — | — |
| `analyst` | yahoo → finnhub → fmp | — | — |
| `news` | finnhub → yahoo | — | — |

> [!info] Provider key gating
> Providers requiring an API key (`twelve_data`, `finnhub`, `fmp`, `alpha_vantage`) are treated as permanently unavailable when their key is absent from `.env.local`. Yahoo, Binance, and Kinesis need no key and are always included if the relevant adapter is present.

### Provider Keys (`.env.local`)

| Provider | Environment variable |
|---|---|
| Twelve Data | `TWELVE_DATA_API_KEY` |
| Finnhub | `FINNHUB_API_KEY` |
| FMP | `FMP_API_KEY` |
| Alpha Vantage | `ALPHA_VANTAGE_API_KEY` |

### DB Tables Created by Migrations 0042–0043

| Table | Purpose |
|---|---|
| `provider_quota` | Per-provider, per-UTC-day request counters persisted so daily budgets survive restarts |
| `instrument_provider_map` | User-confirmed cross-provider symbol mappings (ISIN-anchored where available); exposed via the `/api/research/mappings*` endpoints documented above |
| `provider_api_keys` | Settings-managed keyed-provider API keys (migration 0043); masked in responses, env-overriding; exposed via the `/api/research/provider-keys*` endpoints |

## Rate Limiting

All `/api/research/*` endpoints share the `marketRateLimiter` (same as `/api/market/*`). Bypassed in development.

## Related

- [[docs/adr/079-multi-provider-research-aggregation|ADR-079]] — architectural decision record with full design rationale
- [[docs/features/research|Research Feature]] — feature spec with the four pillars and aggregation summary
- [[docs/integrations/price-providers|Price Providers Integration]] — the provider registry this layer extends
- [[docs/api/marketLookup|Market Lookup API]] — the existing Yahoo-only surface that research coexists with
- [[docs/api/watchlist|Watchlist API]] — watchlist surface that the future Research workspace will consolidate
