---
title: Research API
type: endpoint
status: active
date: 2026-06-16
updated: 2026-09-03
tags:
  - api
  - research
  - holdings-preseed
  - market-data
  - multi-provider
  - capability-map
  - quota-governor
  - adr-079
  - adr-081
  - adr-082
  - monte-carlo
  - portfolio-projection
  - fundamentals-scorecard
  - chart-builder
  - macro
  - macroeconomic
  - fred
  - dbnomics
  - eurostat
  - provider-pinned
description: Provider-agnostic research API surface (ADR-079 + ADR-081 + ADR-082). Eighteen endpoints under /api/research — eight GET/POST data and analytics endpoints (search/quote/chart/fundamentals/analyst/news/scorecard/portfolio-forecast), two macro endpoints (macro/search and macro/series — provider-pinned, ADR-082), five symbol-mapping endpoints, and three provider-key Settings endpoints. All five equity provider adapters (Yahoo + Twelve Data, Finnhub, FMP, Alpha Vantage) plus three macro adapters (FRED keyed, Eurostat and DBnomics keyless) are implemented.
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
  - apps/node-backend/src/services/research/adapters/fredAdapter.js
  - apps/node-backend/src/services/research/adapters/eurostatAdapter.js
  - apps/node-backend/src/services/research/adapters/dbnomicsAdapter.js
  - apps/node-backend/src/services/research/adapters/macroRange.js
  - apps/node-backend/src/services/research/adapters/macroCatalog.js
  - apps/node-backend/src/services/research/projection/portfolioProjection.js
  - apps/node-backend/src/services/research/fundamentalsScorecard.js
  - apps/node-backend/src/repositories/providerQuotaRepository.js
---

# Research API

Provider-agnostic market research surface introduced in [[docs/adr/079-multi-provider-research-aggregation|ADR-079]], deepened in [[docs/adr/081-research-analytics-forecasting|ADR-081]], and extended with a macroeconomic data vertical in [[docs/adr/082-macroeconomic-indicators-data-vertical|ADR-082]]. Eighteen endpoints under `/api/research`: six GET data endpoints delegate to the **research aggregation layer** (capability map → quota governor → cache → race-to-first provider, except `fundamentals` which uses a parallel merge — see below); two analytics endpoints (`scorecard`, `portfolio-forecast`) compute derived outputs from aggregated data; **two macro endpoints** (`macro/search`, `macro/series`) route to provider-pinned macro adapters (never raced — see [Macro Endpoints](#macro-endpoints-adr-082) below); five symbol-mapping endpoints manage cross-provider instrument identity; and three provider-key Settings endpoints manage keyed-provider API keys.

## Base URL

```
/api/research
```

All endpoints are mounted under the existing `marketRateLimiter` (same limiter as `/api/market/*`).

## Response Envelope

The nine provider-backed data endpoints return the standard ADR-026 envelope
with two additional provenance fields in `meta`: search, quote, chart,
fundamentals, analyst, news, macro search, macro series, and scorecard. The
portfolio forecast, mapping, and provider-key endpoints use the ordinary
ADR-026 envelope and do not claim provider provenance.

```json
{
  "ok": true,
  "data": {/* endpoint-specific payload, or null when unavailable */},
  "meta": {
    "provider": "yahoo",
    "source": "live"
  }
}
```

| `meta` field | Values           | Meaning                                                                                                                                                            |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider`   | string or `null` | Which provider answered. `null` if all providers were skipped or unavailable.                                                                                      |
| `source`     | `"cache"`        | Response served from the in-memory TTL cache — no outbound call made, no quota spent.                                                                              |
|              | `"live"`         | Fresh response from the winning provider.                                                                                                                          |
|              | `"unavailable"`  | All providers in the chain were exhausted (quota, unhealthy, or unkeyed); `data` is the stable empty shape for the type (`{ items: [] }`, `{ points: [] }`, etc.). |

> [!info] Provenance on the frontend
> When `meta.source === 'unavailable'` the UI should show a "not available" indicator rather than a loading spinner or empty state — the data genuinely could not be fetched for this session.

Successful responses now have endpoint-specific schemas in `openapi.yaml`.
Provider-dependent fields remain optional where adapters cannot guarantee
them. Quote, fundamentals, analyst, and scorecard responses use explicit
`null` data when unavailable; collection endpoints use stable empty arrays.
`POST /mappings/resolve` exposes snake-case `instrument_key` and `key_type` at
the HTTP boundary while proposal fields remain camel-case domain fields.

## Endpoints

---

### GET /api/research/search

Search for tickers or securities by name or ticker symbol.

**Query Parameters:**

| Parameter | Type   | Required | Description                                |
| --------- | ------ | -------- | ------------------------------------------ |
| `q`       | string | Yes      | Search query (e.g., `"apple"` or `"AAPL"`) |

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

| Parameter     | Type   | Required | Description                                                                                                                         |
| ------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `symbol`      | string | Yes      | Ticker symbol (e.g., `AAPL`)                                                                                                        |
| `asset_class` | string | No       | Asset class hint for provider routing: `stock`, `crypto`, `metals`, `etf`. Defaults to the `default` capability chain when omitted. |

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

| Parameter     | Type   | Required | Default | Description                                                                                                                                                                                                                                              |
| ------------- | ------ | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `symbol`      | string | Yes      | —       | Ticker symbol                                                                                                                                                                                                                                            |
| `asset_class` | string | No       | —       | Asset class hint for provider routing                                                                                                                                                                                                                    |
| `range`       | string | No       | `1mo`   | Time range: `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `max`                                                                                                                                                                                     |
| `provider`    | string | No       | —       | Pin a preferred provider to the front of the chart capability chain (e.g. `"finnhub"`, `"twelve_data"`). The aggregator still falls through to the next provider if the pinned one is unkeyed or failing — this is a preference, not a hard requirement. |

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "points": [
      {
        "time": 1748304000000,
        "close": 211.12,
        "high": 213.0,
        "low": 209.5,
        "volume": 52000000
      }
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

| Parameter     | Type   | Required | Description                           |
| ------------- | ------ | -------- | ------------------------------------- |
| `symbol`      | string | Yes      | Ticker symbol                         |
| `asset_class` | string | No       | Asset class hint for provider routing |

**Data sourcing — merged FMP + Yahoo (2026-06-16):** This endpoint does **not** race through the capability map chain. It calls `researchAggregator.fetchFundamentals()`, which fetches **FMP and Yahoo in parallel** and merges the results **field-by-field with FMP preferred**: a field from FMP wins when present and non-null/non-NaN; Yahoo fills every gap. This yields the union of both providers — FMP-only fields (e.g. `interestCoverage`) and Yahoo-only fields (e.g. `forwardPE`, `revenue`, `freeCashFlow`) both appear. Finnhub is not called by this route (it remains in `capabilityMap.fundamentals.default` for the generic `fetch()` path only). FMP requires `FMP_API_KEY` in `.env.local`; without it Yahoo is the sole provider. Cache key: `fundamentals:merged:<assetClass>:<symbol>`. See [[docs/adr/079-multi-provider-research-aggregation#follow-up-note--fundamentals-merged-across-fmp--yahoo-2026-06-16|ADR-079 follow-up note (2026-06-16)]].

**Extended fields (ADR-081):** The response includes the following fields when available from either provider. Each field is `undefined` (omitted from the response object) when neither provider exposes it.

| Field              | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `sector`           | Sector classification string                                 |
| `pegRatio`         | Price/Earnings-to-Growth ratio                               |
| `payoutRatio`      | Dividend payout as a fraction of earnings (0–1+)             |
| `grossMargin`      | Gross profit margin as a fraction (0–1)                      |
| `operatingMargin`  | Operating profit margin as a fraction                        |
| `revenueGrowth`    | YoY revenue growth as a fraction                             |
| `earningsGrowth`   | YoY earnings growth as a fraction                            |
| `debtToEquity`     | Total debt / total equity ratio (normalized to ratio, not %) |
| `currentRatio`     | Current assets / current liabilities                         |
| `quickRatio`       | (Current assets − inventory) / current liabilities           |
| `interestCoverage` | EBIT / interest expense                                      |
| `freeCashFlow`     | Free cash flow in the reporting currency                     |
| `fcfYield`         | Free cash flow yield as a fraction of market cap             |

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
    "marketCap": 3240000000000,
    "sector": "Technology",
    "pegRatio": 2.1,
    "payoutRatio": 0.16,
    "grossMargin": 0.46,
    "operatingMargin": 0.31,
    "debtToEquity": 1.87,
    "currentRatio": 0.95,
    "revenueGrowth": 0.05,
    "freeCashFlow": 108000000000,
    "fcfYield": 0.033
  },
  "meta": { "provider": "fmp+yahoo", "source": "live" }
}
```

> [!info] `meta.provider` values for fundamentals
>
> - `"fmp+yahoo"` — both providers contributed at least one field (typical when both are keyed and healthy).
> - `"fmp"` — only FMP responded (Yahoo unavailable or returned no fields).
> - `"yahoo"` — only Yahoo responded (FMP unkeyed or failing).
> - `null` with `source: "unavailable"` — both failed.

**Error Responses:**

- `400 Bad Request` — `symbol` parameter missing

**Cache TTL:** 12 hours (`fundamentals:merged:<assetClass>:<symbol>`)

---

### GET /api/research/analyst

Analyst consensus ratings, price targets, and recent rating actions for a symbol.

**Query Parameters:**

| Parameter     | Type   | Required | Description                           |
| ------------- | ------ | -------- | ------------------------------------- |
| `symbol`      | string | Yes      | Ticker symbol                         |
| `asset_class` | string | No       | Asset class hint for provider routing |

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

| Parameter | Type   | Required | Description   |
| --------- | ------ | -------- | ------------- |
| `symbol`  | string | Yes      | Ticker symbol |

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

### GET /api/research/scorecard

Heuristic fundamentals scorecard for a symbol. Fetches fundamentals via `researchAggregator.fetchFundamentals()` (merged FMP + Yahoo, 12 h cache respected — the same call as `GET /api/research/fundamentals`), then evaluates them through the pure `fundamentalsScorecard.js` engine. Requires no additional provider calls beyond what `GET /api/research/fundamentals` already makes. `meta.provider` follows the same composite provenance rules as `/fundamentals` (e.g. `"fmp+yahoo"`).

**Query Parameters:**

| Parameter     | Type   | Required | Description                           |
| ------------- | ------ | -------- | ------------------------------------- |
| `symbol`      | string | Yes      | Ticker symbol                         |
| `asset_class` | string | No       | Asset class hint for provider routing |

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "symbol": "AAPL",
    "fundamentals": {/* same shape as GET /api/research/fundamentals */},
    "scorecard": {
      "score": 72,
      "grade": "B",
      "evaluated": 9,
      "counts": { "ok": 5, "caution": 3, "warn": 1, "risk": 0 },
      "flags": [
        {
          "metric": "currentRatio",
          "category": "Leverage & Liquidity",
          "better": "higher",
          "value": 0.95,
          "severity": "warn",
          "code": "currentRatio.warn",
          "reason": "Current ratio below 1.0 — current liabilities exceed current assets",
          "benchmark": 1.0
        }
      ]
    }
  },
  "meta": { "provider": "fmp+yahoo", "source": "cache" }
}
```

When fundamentals are unavailable from all providers:

```json
{
  "ok": true,
  "data": null,
  "meta": { "provider": null, "source": "unavailable" }
}
```

> [!info] Scorecard design invariants
> Missing fields are **skipped, never penalized** — a provider that does not expose `interestCoverage` does not reduce the score. Grade mapping: 80–100 → A, 60–79 → B, 40–59 → C, 20–39 → D, 0–19 → F. Thresholds are hardcoded industry heuristics; no machine learning or market-relative scoring.
>
> **i18n note:** The `reason` field in each flag is an English sentence. Structured fields (`metric`, `severity`, `code`, `grade`, `benchmark`) are localized. The English-only `reason` is a known gap tracked as a follow-up.

**Error Responses:**

- `400 Bad Request` — `symbol` parameter missing

---

### POST /api/research/portfolio-forecast

Monte Carlo projection of aggregate portfolio value. Non-persisted; re-submit with the same seed to reproduce results.

**Request Body:**

| Field                  | Type    | Required | Default        | Description                                                                                                                               |
| ---------------------- | ------- | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `horizon_months`       | integer | Yes      | —              | Projection horizon in months (1–360)                                                                                                      |
| `monthly_contribution` | number  | No       | `0`            | Fixed monthly cash contribution in `currency`                                                                                             |
| `paths`                | integer | No       | `1000`         | Number of simulation paths (10–10000)                                                                                                     |
| `forward_blend`        | number  | No       | `0`            | Fraction of drift from forward-looking provider inputs (0 = pure historical, 1 = pure analyst consensus)                                  |
| `method`               | string  | No       | `"parametric"` | Simulation method: `"parametric"` (Gaussian monthly steps) or `"block_bootstrap"` (stationary Politis–Romano resample of daily residuals) |
| `target_value`         | number  | No       | —              | Optional target portfolio value — enables `probTarget` in summary                                                                         |
| `currency`             | string  | No       | app default    | Display currency for output values                                                                                                        |
| `seed`                 | integer | No       | random         | PRNG seed for deterministic reproduction                                                                                                  |

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "bands": [
      {
        "month": "2026-07",
        "p10": 98000,
        "p25": 101000,
        "p50": 105000,
        "p75": 110000,
        "p90": 116000
      }
    ],
    "summary": {
      "projectedP10": 115000,
      "projectedP25": 130000,
      "projectedP50": 148000,
      "projectedP75": 170000,
      "projectedP90": 198000,
      "expectedAnnualReturn": 0.082,
      "annualVolatility": 0.154,
      "probBelowInvested": 0.12,
      "probTarget": 0.43
    },
    "forwardInputs": [
      {
        "symbol": "AAPL",
        "weight": 0.18,
        "targetGrowth": 0.14,
        "dividendYield": 0.005,
        "provider": "finnhub",
        "skipped": false
      },
      {
        "symbol": "MSFT",
        "weight": 0.15,
        "targetGrowth": null,
        "dividendYield": null,
        "provider": null,
        "skipped": true
      }
    ],
    "seed": 42
  },
  "meta": { "source": "live" }
}
```

**Error Responses:**

- `400 Bad Request` — missing or invalid body fields
- `422 Unprocessable Entity` — insufficient portfolio snapshot history (< 60 days); response: `{ "error": "insufficient_history", "message": "..." }`

> [!info] Drift / Risk decoupling
> **RISK** (σ) is always estimated from the aggregate portfolio **flow-adjusted** daily-return history via `portfolioPerformanceSnapshotService.getSnapshots()` — embedded realized cross-holding covariance, no covariance matrix required. Returns use Modified Dietz (`(Vₜ − Vₜ₋₁ − ΔInvestedₜ) / Vₜ₋₁`) so deposits/withdrawals are not mistaken for market return; gross flow artifacts (>±50% daily) are dropped and reported as `flowArtifactDays`. **DRIFT** (μ) is a per-holding weighted blend of the historical mean (weight = `1 - forward_blend`) and forward-looking analyst inputs (analyst 12m target-implied growth + dividend yield, fetched through `researchAggregator`, capped ±50%, top-25 holdings by weight). Forward inputs that are unavailable (no keyed provider, quota exhausted) appear in `forwardInputs` with `skipped: true` and fall back to historical drift for that holding.
>
> `expectedAnnualReturn` is the **median/geometric** CAGR (the simulated mean path runs higher by σ²/2 — the median is the conservative figure shown). `probBelowInvested` compares the terminal value against **net invested capital** (`totals.totalInvested` cost basis + future contributions), not current market value, so existing unrealized gains don't inflate the break-even line.

---

## Macro Endpoints (ADR-082)

Macroeconomic series are **provider-pinned** — a series code (`CPIAUCSL`, `Eurostat/prc_hicp_midx/M.I15.CP00.BE`) identifies exactly one provider. The race-to-first capability-map chain does not apply here. Three adapters serve these endpoints: `fredAdapter` (keyed, `FRED_API_KEY`), `eurostatAdapter` (keyless), `dbnomicsAdapter` (keyless). With no FRED key the surface degrades to the keyless Eurostat catalog and DBnomics fetch-by-id.

> [!info] Storage boundary preserved (ADR-079)
> Macro observations are cached in memory only and are **never written to `asset_price_history`**. The `macro_search` TTL is 1 h; `macro_series` TTL is 12 h.

> [!warning] PMI is out of scope
> Real PMI data (S&P Global / ISM) is proprietary. Free proxies reachable through this surface: OECD CLI via DBnomics, and regional-Fed manufacturing surveys (Philly, NY Empire State, Richmond, Dallas) via FRED.

---

### GET /api/research/macro/search

Catalog search for macroeconomic series. Fans out across all usable macro adapters in parallel (FRED if keyed, plus the curated keyless Eurostat catalog), concatenating results into one list. A provider that errors or is unkeyed is simply absent from the union.

**Query Parameters:**

| Parameter | Type   | Required | Description                                                    |
| --------- | ------ | -------- | -------------------------------------------------------------- |
| `q`       | string | Yes      | Search query (e.g. `"cpi"`, `"unemployment"`, `"policy rate"`) |

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "provider": "fred",
        "seriesId": "CPIAUCSL",
        "title": "Consumer Price Index for All Urban Consumers: All Items in U.S. City Average",
        "frequency": "Monthly",
        "units": "Index 1982-1984=100",
        "region": "US"
      },
      {
        "provider": "eurostat",
        "seriesId": "Eurostat/prc_hicp_midx/M.I15.CP00.BE",
        "title": "HICP (2015=100) — Belgium, all-items",
        "frequency": "Monthly",
        "units": "Index 2015=100",
        "region": "BE"
      }
    ]
  },
  "meta": { "provider": null, "source": "live" }
}
```

`MacroSeriesItem` shape: `{ provider, seriesId, title, frequency, units, region?, source? }`.

`meta.provider` is `null` for fan-out responses (multiple providers contributed). `meta.source` is `"cache"` when served from the 1 h TTL cache.

**Cache TTL:** 1 hour

**Error Responses:**

- `400 Bad Request` — `q` missing or blank

---

### GET /api/research/macro/series

Fetch observations for a specific macro series from a specific provider (no fallback chain).

**Query Parameters:**

| Parameter   | Type   | Required | Default | Description                                                                                                                |
| ----------- | ------ | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `provider`  | string | Yes      | —       | Macro provider: `fred`, `eurostat`, or `dbnomics`                                                                          |
| `series_id` | string | Yes      | —       | Provider-native series identifier (e.g. `CPIAUCSL` for FRED; `Eurostat/prc_hicp_midx/M.I15.CP00.BE` for DBnomics/Eurostat) |
| `range`     | string | No       | `5y`    | Time range: `1y`, `2y`, `5y`, `10y`, `max`                                                                                 |

> [!info] Range anchoring on last observation, not wall clock
> `macroRange.trimToRange` anchors the window on the **last available observation**, not today. Macro data lags publication; anchoring on "now" produced empty charts for short ranges when a series had not yet published its most recent point.

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "provider": "fred",
    "seriesId": "CPIAUCSL",
    "title": "Consumer Price Index for All Urban Consumers: All Items in U.S. City Average",
    "units": "Index 1982-1984=100",
    "frequency": "Monthly",
    "points": [
      { "time": 1704067200000, "close": 308.417 },
      { "time": 1706745600000, "close": 308.822 }
    ]
  },
  "meta": { "provider": "fred", "source": "live" }
}
```

`points` are `ResearchChartPoint[]` with the observation value mapped to `close`; `high`, `low`, and `volume` are `undefined` — so macro series drop directly into the Chart Builder's existing `ComposedChart` renderer. Missing observations (FRED returns `"."` for unreleased values) are skipped.

**Error Responses:**

- `400 Bad Request` — `provider` or `series_id` missing; `provider` not in `[fred, eurostat, dbnomics]`; `series_id` fails the adapter's shape guard (`isValidSeriesId`)
- `503 Service Unavailable` — provider unkeyed (FRED without `FRED_API_KEY`) or adapter error

**Cache TTL:** 12 hours

---

## Symbol Mapping Endpoints (ADR-079)

The cross-provider symbol map is the fool-proof anchor against silent wrong-instrument merges: a provider's data is only used for an instrument when a mapping records which symbol on that provider backs it. Mappings are stored in `instrument_provider_map`, anchored on ISIN (`key_type=isin`) where available or a Vision-internal id (`key_type=internal`) for crypto/metals. See [[apps/node-backend/src/services/research/researchMappingService.js]].

### GET /api/research/mappings

List stored mappings for an instrument. **Query:** `instrument_key` (required), `key_type` (`isin` | `internal`, default `isin`).

**Response:** canonical collection body `{ items: [ { id, instrument_key, key_type, provider, provider_symbol, resolved_name, exchange, currency, status, verified_at } ], total }` — `status` ∈ `confirmed` | `auto` | `failed`.

### POST /api/research/mappings/resolve

Auto-propose a per-provider symbol by running each search-capable, keyed provider's search. **Does not persist** — the user confirms before saving. Each proposal carries the resolved `name`/`exchange` so ticker collisions (e.g. `APLE` vs `AAPL`) are caught at confirm time.

**Body:** `{ instrument_key, key_type?, asset_class?, query, investment_id? }` (`query` required).

`investment_id` (optional, positive integer) **pre-seeds from a held investment**: when the id resolves to an investment that already has both `price_provider` and `price_provider_id`, that provider is injected as a `confirmed` proposal carrying `fromHolding: true` (with the holding's `name` as `resolvedName` and its `currency`), and its **live search is skipped** — the holding already mapped it, so there is nothing to re-map. A stored `confirmed` mapping for that provider still wins, and providers are de-duplicated so none appears twice. An absent id (missing, `null` or `""`) is ignored, but a **malformed** one is now a `400 VALIDATION_ERROR` (changed 2026-08-11, breaking for malformed ids): `investment_id` accepts only a plain base-10 integer in 1..2,147,483,647. It was `Number.parseInt` with an `undefined` fallback, which had both failure modes — `'12abc'` parsed to **12** and pre-seeded from a holding nobody named, while `'abc'` silently became "no holding" and returned a 200 the caller could not tell from a correct one. The frontend passes it when the symbol page is opened from a holding (`?investmentId=`).

**Response:** `{ instrument_key, key_type, proposals: [ { provider, status, providerSymbol?, resolvedName?, exchange?, candidates?, fromStore?, fromHolding? } ], existing: [...] }`. Proposal `status` ∈ `auto` (proposed) | `confirmed` (kept from store or pre-seeded from a holding) | `skipped` (quota) | `none` (no hit) | `unavailable` (no adapter/key) | `error`.

### POST /api/research/mappings

Persist user-confirmed mappings (upsert one row per provider, default `status=confirmed`).

**Body:** `{ instrument_key, key_type?, mappings: [ { provider, providerSymbol, resolvedName?, exchange?, currency? } ] }` (non-empty array). **Response:** canonical collection body `{ items: [...], total }` — the full stored set after upsert.

### DELETE /api/research/mappings/:id

Delete one stored mapping. **Response:** `204 No Content` — empty body, and idempotent: an id with
no stored mapping is not an error.

`:id` must be a plain positive integer; anything else is `400 VALIDATION_ERROR` (`"id must be a
positive integer"`). Idempotency covers _unknown_ ids, not _malformed_ ones. **Changed 2026-08-11:**
`DELETE /mappings/12abc` used to coerce to id 12 and delete that mapping — it now rejects. See
[[docs/security/input-validation#ID Validation|Input Validation]].

### POST /api/research/mappings/audit

Cross-provider self-audit: fetches a quote from each mapped provider and flags `currency_mismatch` or `price_outlier` (>5% from the median) discrepancies, then stamps `verified_at` on the instrument's rows.

**Body:** `{ instrument_key, key_type? }`. **Response:** `{ ok: boolean, quotes: [ { provider, currency?, price?, skipped?/error? } ], discrepancies: [ { type, ... } ] }`.

---

## Provider API Keys (Settings)

Manage the keyed providers' API keys from the app (or via the root `.env`, ADR-080). Keys are stored in `provider_api_keys` (migration 0043), masked in responses (never returned in full), and a Settings value **overrides** the env var. Changes take effect immediately (the in-memory override map is updated and is hydrated at startup).

### GET /api/research/provider-keys

Returns the canonical collection body `{ items: [{ provider, label, envVar, configured, source, masked }], total }` — `source` ∈ `settings` | `env` | `none`; `masked` shows only the last 4 characters.

### PUT /api/research/provider-keys/:provider

Body `{ api_key }`. Stores/replaces the key for `provider` (one of `twelve_data` / `finnhub` / `fmp` / `alpha_vantage` / `fred`) and returns the updated masked statuses in the same `{ items, total }` body as the GET. `400` on unknown provider or empty key.

### DELETE /api/research/provider-keys/:provider

Clears the stored key (the env var, if set, then applies again). **Response:** `204 No Content` —
refetch `GET /api/research/provider-keys` for the updated statuses. Idempotent: clearing an unset
key is not an error. `400` on unknown provider.

## Aggregation Layer Architecture

The six data endpoints are thin wrappers over the `researchAggregator` singleton in [[apps/node-backend/src/services/research/researchAggregator.js]]. The orchestration steps on every request are:

1. **Cache check** — `researchCache.get(key)` keyed by `dataType:assetClass:symbol:range`. A hit returns `source: 'cache'` immediately; no quota is spent.
2. **Capability chain** — `resolveProviderChain(dataType, assetClass)` from [[apps/node-backend/src/services/research/capabilityMap.js]] returns the ordered provider preference for that data type and asset class. Providers absent an adapter method or API key are filtered out by `isProviderKeyed` ([[apps/node-backend/src/services/research/providerKeys.js]]).
3. **Quota gate** — `governor.canSpend(provider)` checks per-minute (in-memory) and per-day (persisted to `provider_quota` table via [[apps/node-backend/src/repositories/providerQuotaRepository.js]]) token buckets. A full bucket moves to the next provider instead of issuing a 429.
4. **Race-to-first** — The first provider that returns successfully wins. `governor.spend()` records the token, `providerHealthService.recordSuccess()` updates health, the result is cached with the type TTL. **Exception: `fundamentals`** — `GET /api/research/fundamentals` and `GET /api/research/scorecard` bypass this step and call `researchAggregator.fetchFundamentals()`, which fetches FMP and Yahoo **in parallel** and merges field-by-field (FMP preferred). See the `/fundamentals` endpoint doc above.
5. **Provider error** — `providerHealthService.recordError()` is called, the error is noted in `attempted[]`, and the next provider is tried.
6. **Unavailable** — If all providers are skipped/errored, `source: 'unavailable'` is returned with a stable empty shape.

### Type-Aware Cache TTLs

| Data type      | TTL                                                                 |
| -------------- | ------------------------------------------------------------------- |
| `search`       | 10 min                                                              |
| `quote`        | 10 min                                                              |
| `chart`        | 12 h                                                                |
| `fundamentals` | 12 h (merged cache key `fundamentals:merged:<assetClass>:<symbol>`) |
| `analyst`      | 12 h                                                                |
| `news`         | 2 h                                                                 |
| `macro_search` | 1 h                                                                 |
| `macro_series` | 12 h                                                                |

The cache sweeps expired entries every 5 minutes (`setInterval` with `.unref()`).

### Capability Map (as shipped)

| Data type      | Default chain                                                                                                                                         | Crypto                        | Metals                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------- |
| `search`       | yahoo → twelve_data → finnhub → fmp                                                                                                                   | —                             | —                             |
| `quote`        | twelve_data → yahoo → finnhub → fmp → alpha_vantage                                                                                                   | binance → twelve_data → yahoo | kinesis → yahoo → twelve_data |
| `chart`        | twelve_data → yahoo → finnhub → alpha_vantage                                                                                                         | binance → twelve_data → yahoo | kinesis → yahoo → twelve_data |
| `fundamentals` | fmp → finnhub → yahoo _(capability map — used by generic `fetch()` only; `/fundamentals` + `/scorecard` routes use parallel FMP+Yahoo merge instead)_ | —                             | —                             |
| `analyst`      | yahoo → finnhub → fmp                                                                                                                                 | —                             | —                             |
| `news`         | finnhub → yahoo                                                                                                                                       | —                             | —                             |

> [!info] Provider key gating
> Providers requiring an API key (`twelve_data`, `finnhub`, `fmp`, `alpha_vantage`) are treated as permanently unavailable when their key is absent from `.env.local`. Yahoo, Binance, and Kinesis need no key and are always included if the relevant adapter is present.

### Provider Keys (`.env.local`)

| Provider             | Environment variable    |
| -------------------- | ----------------------- |
| Twelve Data          | `TWELVE_DATA_API_KEY`   |
| Finnhub              | `FINNHUB_API_KEY`       |
| FMP                  | `FMP_API_KEY`           |
| Alpha Vantage        | `ALPHA_VANTAGE_API_KEY` |
| FRED (economic data) | `FRED_API_KEY`          |

### DB Tables Created by Migrations 0042–0043

| Table                     | Purpose                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_quota`          | Per-provider, per-UTC-day request counters persisted so daily budgets survive restarts                                                                   |
| `instrument_provider_map` | User-confirmed cross-provider symbol mappings (ISIN-anchored where available); exposed via the `/api/research/mappings*` endpoints documented above      |
| `provider_api_keys`       | Settings-managed keyed-provider API keys (migration 0043); masked in responses, env-overriding; exposed via the `/api/research/provider-keys*` endpoints |

## Rate Limiting

All `/api/research/*` endpoints share the `marketRateLimiter` (same as `/api/market/*`). Bypassed in development.

## Related

- [[docs/adr/082-macroeconomic-indicators-data-vertical|ADR-082]] — architecture decision for the macro data vertical (FRED + Eurostat + DBnomics, provider-pinned)
- [[docs/adr/081-research-analytics-forecasting|ADR-081]] — architecture decision for the scorecard, portfolio projection engine, and chart builder (Pillars B/C/D deepening)
- [[docs/adr/079-multi-provider-research-aggregation|ADR-079]] — architectural decision record with full design rationale for the aggregation layer
- [[docs/features/research|Research Feature]] — feature spec with all four pillar statuses, macro section, and API surface overview
- [[docs/integrations/price-providers|Price Providers Integration]] — the provider registry this layer extends
- [[docs/api/marketLookup|Market Lookup API]] — the existing Yahoo-only surface that research coexists with
- [[docs/api/watchlist|Watchlist API]] — watchlist surface consolidated into the Research workspace
