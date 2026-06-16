---
title: Research Feature
type: feature
status: active
date: 2026-06-16
updated: 2026-06-16
tags:
  - feature
  - research
  - market-data
  - multi-provider
  - capability-map
  - quota-governor
  - cache-ttl
  - adr-079
  - adr-081
  - yahoo
  - pillar-a
  - pillar-b
  - pillar-c
  - pillar-d
  - monte-carlo
  - portfolio-projection
  - fundamentals-scorecard
  - chart-builder
  - technical-indicators
description: Research section (ADR-079 + ADR-081) — a provider-agnostic market research surface backed by a capability map, quota governor, and type-aware in-memory cache. All five provider adapters (Yahoo + Twelve Data, Finnhub, FMP, Alpha Vantage) are implemented; the keyed four activate automatically when their API key is set in the root .env (ADR-080). The `/research` frontend workspace ships all four pillars: A (workspace), B (comparative analysis + freeform chart builder), C (Monte Carlo portfolio forecast), and D (fundamentals comparison + heuristic scorecard).
aliases:
  - research
  - research section
  - multi-provider research
related_code:
  - apps/node-backend/src/routes/research.js
  - apps/node-backend/src/services/research/researchAggregator.js
  - apps/node-backend/src/services/research/capabilityMap.js
  - apps/node-backend/src/services/research/quotaGovernor.js
  - apps/node-backend/src/services/research/researchCache.js
  - apps/node-backend/src/services/research/providerKeys.js
  - apps/node-backend/src/services/research/adapters/yahooAdapter.js
  - apps/node-backend/src/services/research/projection/portfolioProjection.js
  - apps/node-backend/src/services/research/projection/stats.js
  - apps/node-backend/src/services/research/fundamentalsScorecard.js
  - apps/node-backend/src/repositories/providerQuotaRepository.js
  - apps/frontend/src/pages/research/PortfolioForecastPage.tsx
  - apps/frontend/src/pages/research/ChartBuilderPage.tsx
  - apps/frontend/src/components/research/ResearchScorecard.tsx
  - apps/frontend/src/lib/research/indicators.ts
  - alembic/versions/0042_add_research_provider_mapping_and_quota.py
---

# Research Feature

## Overview

The Research section gives users a unified hub to investigate any security — not only held assets — across multiple free-tier market data providers. It is designed around four pillars:

| Pillar | Description | Status |
|---|---|---|
| **A — Research workspace** | A consolidated area combining [[docs/features/market-lookup\|Market Lookup]] and [[docs/features/watchlist\|Watchlist]] into a single navigable research surface for any symbol | **Shipped** — `/research` workspace (3rd workspace alongside Budget + Portfolio); Market Lookup + Watchlist moved here from `/portfolio/*` |
| **B — Comparative analysis + Chart Builder** | Multi-symbol overlay charts (rebased), return/volatility/drawdown comparisons, cross-holding correlation; freeform custom chart builder with per-symbol type/axis/provider, technical overlays (SMA/EMA/Bollinger), oscillators (RSI/MACD), log scale, presets, and localStorage layout persistence | **Shipped** — `/research/compare` (Performance + Fundamentals tabs); `/research/charts` (freeform Chart Builder) |
| **C — Portfolio value projection** | Monte Carlo projection of aggregate portfolio value using a drift/risk-decoupled engine: RISK from aggregate NAV history (embedded covariance), DRIFT from per-holding blend of historical mean and forward-looking analyst inputs (ADR-081) | **Shipped** — `/research/forecast` (`PortfolioForecastPage`); `POST /api/research/portfolio-forecast`; two methods (parametric Gaussian, block bootstrap); confidence bands P10/P25/P50/P75/P90; not persisted |
| **D — Screening / fundamentals** | Side-by-side fundamentals comparison; per-symbol heuristic scorecard (0–100 grade); extended fundamentals fields across all three capable adapters; screening is *selected-symbol* only (no universe scan; free-tier quotas can't support one) | **Shipped** — backend + per-symbol fundamentals tab with scorecard panel + the Compare page's **Fundamentals** tab (Health column + debtToEquity/currentRatio/revenueGrowth/fcfYield, with each metric cell tinted green/amber/red by its scorecard severity); `GET /api/research/scorecard` |

> [!info] What shipped (ADR-079 + ADR-081)
> **Backend:** 16 endpoints under `/api/research` — 6 data (search/quote/chart/fundamentals/analyst/news) + 2 analytics (scorecard + portfolio-forecast) + 5 cross-provider symbol-mapping + 3 provider-key Settings. Full aggregation layer (capability map, quota governor, type-aware cache), all five provider adapters with extended fundamentals normalization (Yahoo/Finnhub/FMP), the symbol-mapping service + self-audit (including the holdings pre-seed on resolve), the projection engine (parametric + block-bootstrap Monte Carlo), the fundamentals scorecard engine, and the DB migrations creating `instrument_provider_map`, `provider_quota`, and `provider_api_keys` tables.
> **Frontend:** the `/research` workspace — home (`ResearchHomePage`: bento live-market hub matching the Budgeting Dashboard and Portfolio Overview home pages; top-to-bottom: (1) prominent symbol search bar; (2) **market snapshot strip** — five live benchmark tiles, S&P 500 `^GSPC`, Euro Stoxx 50 `^STOXX50E`, FTSE 100 `^FTSE`, BEL 20 `^BFX`, Bitcoin `BTC-USD`, each showing price + absolute/percent change, polled every 60 s via the existing `GET /api/market/quote` batch endpoint; index prices rendered as locale-formatted points, not currency; each tile degrades to an em-dash when the quote is unavailable; (3) **five-tool grid** covering all research tools including the two previously unlinked from the home — Chart Builder at `/research/charts` and Portfolio Forecast at `/research/forecast` — alongside Market Lookup, Compare, and Watchlist; (4) **live watchlist tiles** replacing the old plain chips — each shows symbol, name, live price in the item's currency, and percent change via the shared `["watchlist-quotes", symbols]` React Query cache key; empty state shows a "Go to watchlist" CTA; (5) **market news feed** via the existing `PortfolioNewsFeed` component, seeded from watchlist symbols with a fallback to general market headlines when the watchlist is empty), moved Market Lookup + Watchlist, symbol detail (`ResearchSymbolPage`: quote header + visx chart + lazy per-tab Fundamentals/Analyst/News), comparison (`ResearchComparePage`: Performance tab with rebased overlay + stats + correlation matrix, Fundamentals tab with side-by-side comparison + Health column + extended metrics, each metric cell tinted green/amber/red by the scorecard's per-metric severity verdict), portfolio forecast page (`PortfolioForecastPage` at `/research/forecast`: horizon/contribution/blend/model controls, confidence-band LineChart, summary cards, forward-input provenance), freeform chart builder (`ChartBuilderPage` at `/research/charts`: multi-symbol, dual-axis, candlesticks, SMA/EMA/Bollinger/RSI/MACD, presets, localStorage layout), and the symbol-mapping confirm dialog (`ResearchMappingDialog`). Scorecard UI: `ResearchScorecard.tsx` (grade badge + panel); `ResearchFundamentalsTab` uses the scorecard endpoint. Routing/sidebar (Analysis group: Chart Builder, Forecast)/CommandPalette/go-to shortcuts updated; old `/portfolio/market` + `/portfolio/watchlist` redirect (preserving query params). **Settings → App** gains a *Research providers* section. i18n en/nl added including new keys `research.marketSnapshot`, `research.entry.charts`, `research.entry.forecast`, `research.watchlistEmpty`, and `research.watchlistEmptyCta` (note: scorecard `reason` sentences are English-only — tracked follow-up).
> **Provider keys:** all five adapters are implemented; the keyed four (Twelve Data, Finnhub, FMP, Alpha Vantage) activate when their key is set via the Settings UI or the root `.env` (ADR-080). Adapter normalization is unit-tested with mocks — **live verification per provider/tier is still recommended**. Universe screening remains out of scope — there is no universe-scan endpoint and free-tier quotas can't support one (Pillar D ships as a *selected-symbol* fundamentals comparison + per-symbol scorecard instead).

## API Surface

Sixteen endpoints at `/api/research`, all under `marketRateLimiter`: six GET data endpoints (search/quote/chart/fundamentals/analyst/news), two analytics endpoints (scorecard, portfolio-forecast), five symbol-mapping endpoints (`GET/POST/DELETE /mappings`, `POST /mappings/resolve`, `POST /mappings/audit`), and three provider-key Settings endpoints. Full endpoint reference: [[docs/api/research|Research API]].

| Endpoint | Data type | Cache / Notes |
|---|---|---|
| `GET /api/research/search?q=` | Ticker/security search | 10 min |
| `GET /api/research/quote?symbol=&asset_class=` | Live quote | 10 min |
| `GET /api/research/chart?symbol=&asset_class=&range=&provider=` | Historical chart points | 12 h; `provider` pins preferred provider (fallthrough still applies) |
| `GET /api/research/fundamentals?symbol=` | Fundamentals snapshot (extended fields: sector, pegRatio, payoutRatio, grossMargin, operatingMargin, revenueGrowth, earningsGrowth, debtToEquity, currentRatio, quickRatio, interestCoverage, freeCashFlow, fcfYield) | 24 h |
| `GET /api/research/analyst?symbol=` | Analyst consensus + targets + recent actions | 24 h |
| `GET /api/research/news?symbol=` | News articles | 2 h |
| `GET /api/research/scorecard?symbol=&asset_class=` | Heuristic fundamentals scorecard (0–100 score, A–F grade, per-metric flags with severity) | reuses fundamentals 24 h cache |
| `POST /api/research/portfolio-forecast` | Monte Carlo projection of aggregate portfolio value; returns P10/P25/P50/P75/P90 bands + summary + forward-input provenance | on-demand, not persisted |

Each data endpoint response carries `meta.provider` (the provider that answered, or `null`) and `meta.source` (`'cache'` | `'live'` | `'unavailable'`). Symbol-mapping and provider-key endpoints documented in [[docs/api/research|Research API]].

## Aggregation Layer

The aggregation layer sits in `apps/node-backend/src/services/research/` and is composed of three independent mechanisms:

### 1. Capability Map

`capabilityMap.js` is a static, pure routing table: `(dataType, assetClass) → ordered provider preference`. The aggregator walks this chain and skips any provider that is unkeyed, quota-exhausted, or `providerHealthService`-unhealthy. Example chains:

| Data type | Default chain | Crypto override | Metals override |
|---|---|---|---|
| `quote` | twelve_data → yahoo → finnhub → fmp → alpha_vantage | binance → twelve_data → yahoo | kinesis → yahoo → twelve_data |
| `fundamentals` | fmp → finnhub → yahoo | — | — |
| `news` | finnhub → yahoo | — | — |

The map is unit-testable in isolation (no I/O, no env reads; `isUsable` is injected).

### 2. Quota Governor

`quotaGovernor.js` tracks two token-bucket windows per provider:

- **Per-minute (in-memory):** self-healing on restart.
- **Per-day (persisted):** mirrored in memory, backed by the `provider_quota` PostgreSQL table via `providerQuotaRepository.js`. Per-day persistence prevents a frequently-restarted backend from blowing a small daily cap (e.g. Alpha Vantage's ~25/day).

`PROVIDER_LIMITS` (as shipped):

| Provider | per-minute | per-day |
|---|---|---|
| `twelve_data` | 8 | 800 |
| `finnhub` | 60 | — |
| `fmp` | — | 250 |
| `alpha_vantage` | 5 | 25 |
| `yahoo`, `binance`, `kinesis` | unmetered (governed by cache TTLs + health service) | — |

`canSpend(provider)` is checked before every outbound call; `false` routes to the next provider in the chain rather than issuing a 429.

### 3. Type-Aware Cache (`researchCache.js`)

In-memory TTL cache with type-specific expiry. Caching — not scheduling — is the primary rate-limit defence (research tolerates staleness). A cache hit returns `source: 'cache'` with zero quota spend. The cache sweeps expired entries every 5 minutes.

| Type | TTL |
|---|---|
| `search`, `quote` | 10 min |
| `chart` | 12 h |
| `fundamentals`, `analyst` | 24 h |
| `news` | 2 h |

### 4. Provider Key Gating (`providerKeys.js`)

Providers requiring an API key are dropped from every capability chain when their key is absent from `.env.local`. Yahoo, Binance, and Kinesis are keyless and always available if their adapter exists.

| Provider | Env var |
|---|---|
| Twelve Data | `TWELVE_DATA_API_KEY` |
| Finnhub | `FINNHUB_API_KEY` |
| FMP | `FMP_API_KEY` |
| Alpha Vantage | `ALPHA_VANTAGE_API_KEY` |

## Storage Boundary

Research data for arbitrary symbols is **never persisted** to `asset_price_history`. It lives in the in-memory cache only and is evicted when the TTL expires or the process restarts. This keeps the storage model narrow: `asset_price_history` holds only held-asset data within holding windows ([[docs/adr/065-daily-gap-fill-dense-asset-history|ADR-065]]).

Two tables are created by migration `0042_add_research_provider_mapping_and_quota`:

| Table | Persists | Purpose |
|---|---|---|
| `provider_quota` | Per-day request counts per provider | Daily quota governor so budgets survive restarts |
| `instrument_provider_map` | User-confirmed cross-provider symbol mappings (ISIN-anchored) | Shipped — `/api/research/mappings*` + frontend `ResearchMappingDialog` |

## ISIN-Anchored Symbol Mapping

International ticker reuse is rampant (the same string is a different instrument on different exchanges). The `instrument_provider_map` table is the fool-proof anchor against silent wrong-instrument merges. The flow:

1. On adding a research subject, `POST /mappings/resolve` auto-proposes a mapping per provider via each provider's symbol search.
2. The confirm UI (frontend, pending) shows each provider's resolved **name + exchange + currency** so the user can catch collisions before `POST /mappings` persists them.
3. ISIN anchors mappings for stocks/ETFs/bonds (`key_type=isin`); crypto/metals use a Vision-internal id (`key_type=internal`).
4. **Holdings pre-seed (shipped):** when `POST /mappings/resolve` is called with an `investment_id`, the held investment's already-configured provider (`price_provider` + `price_provider_id`) is injected as a `confirmed` proposal flagged `fromHolding: true`, and that provider's live search is skipped — the user already mapped it on the investment, so there's nothing to re-map. A stored `confirmed` mapping still wins; providers are de-duplicated. The frontend passes `investment_id` from the symbol page when it was opened from a holding (`?investmentId=`), and the confirm dialog renders pre-seeded providers as already-confirmed.
5. `POST /mappings/audit` cross-checks currency match and last-price agreement (>5% from median flagged) across mapped providers and stamps `verified_at`.

> [!info] Shipped (incl. holdings pre-seed)
> The symbol-mapping endpoints (resolve / save / list / delete over `instrument_provider_map`), the cross-provider self-audit, and the holdings pre-seed on resolve are **implemented** ([[apps/node-backend/src/services/research/researchMappingService.js]]), and the frontend confirm dialog (`ResearchMappingDialog`) consumes them (resolve → confirm/deselect → save, with an audit action, surfacing held-provider proposals as already-confirmed).

## Provider Adapters

All five adapters live in `apps/node-backend/src/services/research/adapters/`: `yahooAdapter` (no key) plus `twelveDataAdapter`, `finnhubAdapter`, `fmpAdapter`, and `alphaVantageAdapter`. The keyed four read their key via `providerKeys.js` and self-throw when it is absent, so the aggregator's `isProviderKeyed` gate drops them from the capability chain until their key is set in the root `.env` (ADR-080) — at which point they activate automatically. Each adapter is implemented against its provider's documented API and normalized to the shared response shapes; the normalization is unit-tested with mocked responses, but **live verification per provider/tier is still required** (some endpoints — e.g. Finnhub candles — are tier-gated and fall through gracefully when unavailable).

### FMP adapter — stable API migration (2026-06-16)

FMP retired its legacy `/api/v3` base URL for accounts not subscribed before 2025-08-31. The adapter was migrated to FMP's current **stable API** (`https://financialmodelingprep.com/stable`). Key changes:

- Symbol is now a query param (`?symbol=AAPL`) rather than a path segment.
- `search` is split into `search-symbol` + `search-name` (queried in parallel, merged/deduped by symbol).
- Field renames on `ratios-ttm`: `peRatioTTM` → `priceToEarningsRatioTTM`, `priceEarningsToGrowthRatioTTM` → `priceToEarningsGrowthRatioTTM`, `debtEquityRatioTTM` → `debtToEquityRatioTTM`, `interestCoverageTTM` → `interestCoverageRatioTTM`; payout now from `dividendPayoutRatioTTM`.
- Field renames on `quote`: `changesPercentage` → `changePercentage`, `mktCap` → `marketCap` (on profile).
- `returnOnEquity` is now sourced from `key-metrics-ttm` (`returnOnEquityTTM`), because stable moved ROE out of `ratios-ttm`.
- `grade/{sym}` → `grades?symbol=`; the `action` field on recent analyst actions is now populated.
- **Analyst consensus now populated**: `analyst()` calls `grades-consensus?symbol=` to fill the `strongBuy / buy / hold / sell / strongSell` bucket counts and `numberOfAnalysts`. These were previously always `null` on the FMP free (v3) tier.
- Thrown errors from `fundamentals()` now include the underlying HTTP status, e.g. `"fmp: no fundamentals (HTTP 403)"`, so the admin health row is self-diagnosing.

Field mappings were verified against live AAPL responses on 2026-06-16.

## Relation to Existing Surfaces

- **[[docs/features/market-lookup|Market Lookup]]** (`/api/market/*`) — the existing Yahoo-only single-provider surface for portfolio add-from-search. The Research API coexists with it; they share the `marketRateLimiter` but are distinct routes. The future Research workspace (Pillar A) will consolidate both.
- **[[docs/features/watchlist|Watchlist]]** — tracks securities not yet in the portfolio. The future Research workspace (Pillar A) will surface watchlist items alongside research data.
- **[[docs/integrations/price-providers|Price Providers]]** — `priceProviderRegistry` and `providerHealthService` are reused by the research layer; Yahoo, Binance, and Kinesis are the existing providers.

## Related

- [[docs/adr/081-research-analytics-forecasting|ADR-081]] — architecture decision for Pillars B/C/D deepening (portfolio projection engine, scorecard, chart builder)
- [[docs/adr/079-multi-provider-research-aggregation|ADR-079]] — foundation ADR (aggregation layer, capability map, quota governor, symbol mapping, Pillars A/B/D initial)
- [[docs/api/research|Research API]] — endpoint reference (all 16 endpoints)
- [[docs/integrations/price-providers|Price Providers Integration]] — provider registry and health service this layer builds on
- [[docs/features/market-lookup|Market Lookup]] — existing Yahoo surface
- [[docs/features/watchlist|Watchlist]] — watchlist surface
- [[docs/adr/073-shared-portfolio-math-package|ADR-073]] — shared portfolio math used by the projection engine
- [[docs/adr/065-daily-gap-fill-dense-asset-history|ADR-065]] — held-asset storage model (unchanged; storage boundary preserved)
- [[docs/adr/034-admin-environment|ADR-034]] — `providerHealthService` used for capability routing
