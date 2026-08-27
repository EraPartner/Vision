---
title: Research Feature
type: feature
status: active
date: 2026-06-16
updated: 2026-08-26
tags:
  - url-state
  - feature
  - research
  - market-data
  - multi-provider
  - capability-map
  - quota-governor
  - cache-ttl
  - adr-079
  - adr-081
  - adr-082
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
  - macro
  - macroeconomic
  - fred
  - dbnomics
  - eurostat
  - provider-pinned
description: Research section (ADR-079 + ADR-081 + ADR-082) — a provider-agnostic market research surface backed by a capability map, quota governor, and type-aware in-memory cache. All five equity provider adapters (Yahoo + Twelve Data, Finnhub, FMP, Alpha Vantage) are implemented; the keyed four activate automatically when their API key is set in the root .env (ADR-080). A macroeconomic data vertical (ADR-082) adds FRED, Eurostat, and DBnomics for CPI, rates, GDP, and employment series — provider-pinned, never raced. The `/research` frontend workspace ships all four pillars: A (workspace), B (comparative analysis + freeform chart builder with macro series), C (Monte Carlo portfolio forecast), and D (fundamentals comparison + heuristic scorecard).
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
  - apps/node-backend/src/services/research/adapters/fredAdapter.js
  - apps/node-backend/src/services/research/adapters/eurostatAdapter.js
  - apps/node-backend/src/services/research/adapters/dbnomicsAdapter.js
  - apps/node-backend/src/services/research/adapters/macroRange.js
  - apps/node-backend/src/services/research/adapters/macroCatalog.js
  - apps/node-backend/src/services/research/projection/portfolioProjection.js
  - apps/node-backend/src/services/research/projection/stats.js
  - apps/node-backend/src/services/research/fundamentalsScorecard.js
  - apps/node-backend/src/repositories/providerQuotaRepository.js
  - apps/frontend/src/pages/research/PortfolioForecastPage.tsx
  - apps/frontend/src/pages/research/ChartBuilderPage.tsx
  - apps/frontend/src/pages/research/MarketOverviewPage.tsx
  - apps/frontend/src/pages/research/marketViews.ts
  - apps/frontend/src/features/research/ResearchScorecard.tsx
  - apps/frontend/src/lib/research/indicators.ts
  - apps/frontend/src/types/research.ts
  - apps/frontend/src/lib/api/research.ts
  - alembic/versions/0042_add_research_provider_mapping_and_quota.py
---

# Research Feature

## Overview

The Research section gives users a unified hub to investigate any security — not only held assets — across multiple free-tier market data providers. It is designed around four pillars:

| Pillar | Description | Status |
|---|---|---|
| **A — Research workspace** | A consolidated area combining [[docs/features/market-lookup\|Market Lookup]] and [[docs/features/watchlist\|Watchlist]] into a single navigable research surface for any symbol | **Shipped** — `/research` workspace (3rd workspace alongside Budget + Portfolio); Market Lookup + Watchlist moved here from `/portfolio/*`; Markets Overview (`/research/markets`) added as the 7th route — **Region** and **Sector** are two orthogonal, independent axes each with its own state; Region options: Worldwide (default), USA, Europe, China/Asia, Japan, Latin America (Japan is split out of the broader Asia bucket; Latin America is its own region); Sector options: **Overview** (default) + eighteen sectors (Semiconductors, AI, Quantum, Software, Space, Defense, Industrials, Real Estate, Energy, Utilities, Financials, Payments, Crypto, Healthcare, Automotive, Consumer, Telecom, Airlines); when Sector = Overview the page shows the selected region's Indices + Top stocks grids; when a specific sector is selected the page shows that sector's basket filtered to the selected region (Worldwide shows all members; a region shows only members tagged with that region via an in-config `region` field — `'usa' | 'europe' | 'asia' | 'japan' | 'latam'`; members without a region tag, e.g. Enbridge and Saudi Aramco, appear only in the Worldwide view); sector baskets are enriched with European and Asian large-caps so all region views are populated; Halliburton (HAL) added to the Energy sector (region `usa`) and to the USA region Top stocks list; an empty-state message renders when a (sector, region) combination has no tracked names; all tiles are a **heat-map**: each shows the symbol label + large `changePercent` — price and currency are not displayed — and the card background is a red→green linear-gradient tinted by move magnitude (±3 % saturates, flat ≈ neutral); tiles click through to `/research/market?symbol=<symbol>` (Market Lookup is the single security-detail surface; the old `/research/symbol/:symbol` route redirects there); missing quotes degrade to a neutral em-dash tile; tiles for symbols the user holds (matched against `useInvestmentsQuery` by symbol + Yahoo `price_provider_id`, with a `-USD` crypto-base fallback) get an accent ring + corner star — gold in the default theme, the active theme's `accent` token elsewhere |
| **B — Comparative analysis + Chart Builder** | Multi-symbol overlay charts (rebased), return/volatility/drawdown comparisons, cross-holding correlation; freeform custom chart builder with per-symbol type/axis/provider, technical overlays (SMA/EMA/Bollinger), oscillators (RSI/MACD), log scale, presets, and localStorage layout persistence. Oscillator panels use a loading skeleton only while data is pending and show a real empty state once a no-data response settles. | **Shipped** — `/research/compare` (Performance + Fundamentals tabs); `/research/charts` (freeform Chart Builder) |
| **C — Portfolio value projection** | Monte Carlo projection of aggregate portfolio value using a drift/risk-decoupled engine: RISK from aggregate NAV history (embedded covariance), DRIFT from per-holding blend of historical mean and forward-looking analyst inputs (ADR-081) | **Shipped** — `/research/forecast` (`PortfolioForecastPage`); `POST /api/research/portfolio-forecast`; two methods (parametric Gaussian, block bootstrap); confidence bands P10/P25/P50/P75/P90; not persisted |
| **D — Screening / fundamentals** | Side-by-side fundamentals comparison; per-symbol heuristic scorecard (0–100 grade); extended fundamentals fields across all three capable adapters; screening is *selected-symbol* only (no universe scan; free-tier quotas can't support one) | **Shipped** — backend + per-symbol fundamentals tab with scorecard panel + the Compare page's **Fundamentals** tab (Health column + debtToEquity/currentRatio/revenueGrowth/fcfYield, with each metric cell tinted green/amber/red by its scorecard severity); `GET /api/research/scorecard` |

> [!info] What shipped (ADR-079 + ADR-081)
> **Backend:** 18 endpoints under `/api/research` — 6 data (search/quote/chart/fundamentals/analyst/news) + 2 analytics (scorecard + portfolio-forecast) + 2 macro (macro/search + macro/series — ADR-082, provider-pinned) + 5 cross-provider symbol-mapping + 3 provider-key Settings. Full aggregation layer (capability map, quota governor, type-aware cache), all five provider adapters with extended fundamentals normalization (Yahoo/Finnhub/FMP), the symbol-mapping service + self-audit (including the holdings pre-seed on resolve), the projection engine (parametric + block-bootstrap Monte Carlo), the fundamentals scorecard engine, and the DB migrations creating `instrument_provider_map`, `provider_quota`, and `provider_api_keys` tables.
> **Frontend:** the `/research` workspace — home (`ResearchHomePage`: bento live-market hub matching the Budgeting Dashboard and Portfolio Overview home pages; top-to-bottom: (1) prominent symbol search bar; (2) **market snapshot strip** — five live benchmark tiles, S&P 500 `^GSPC`, Euro Stoxx 50 `^STOXX50E`, FTSE 100 `^FTSE`, BEL 20 `^BFX`, Bitcoin `BTC-USD`, each showing price + absolute/percent change, polled every 60 s via the existing `GET /api/market/quote` batch endpoint with `detail=basic` (price-only fields; skips the `quoteSummary` fetch to halve Yahoo calls); index prices rendered as locale-formatted points, not currency; each tile degrades to an em-dash when the quote is unavailable; (3) **six-tool grid** covering all research tools including the two previously unlinked from the home — Chart Builder at `/research/charts` and Portfolio Forecast at `/research/forecast` — alongside Market Lookup, Compare, Watchlist, and the new Markets Overview at `/research/markets`; (4) **live watchlist tiles** replacing the old plain chips — each shows symbol, name, live price in the item's currency, and percent change via the shared `["watchlist-quotes", symbols]` React Query cache key (fetched with `detail=basic`); empty state shows a "Go to watchlist" CTA; (5) **market news feed** via the existing `PortfolioNewsFeed` component, seeded from watchlist symbols with a fallback to general market headlines when the watchlist is empty), moved Market Lookup + Watchlist, symbol detail — now served by Market Lookup (`MarketLookupPage`): quote header + price chart + tabbed Details card (Fundamentals/Analyst/News via `ResearchFundamentalsTab` / `ResearchAnalystTab` / `ResearchNewsTab`) + Map-provider dialog; the standalone `ResearchSymbolPage` is retired and `/research/symbol/:symbol` redirects to `/research/market?symbol=`, comparison (`ResearchComparePage`: Performance tab with rebased overlay + stats + correlation matrix, Fundamentals tab with side-by-side comparison + Health column + extended metrics, each metric cell tinted green/amber/red by the scorecard's per-metric severity verdict), portfolio forecast page (`PortfolioForecastPage` at `/research/forecast`: horizon/contribution/blend/model controls, confidence-band LineChart, summary cards, forward-input provenance), freeform chart builder (`ChartBuilderPage` at `/research/charts`: multi-symbol, dual-axis, candlesticks, SMA/EMA/Bollinger/RSI/MACD, presets, localStorage layout), markets overview (`MarketOverviewPage` at `/research/markets`: **Region** and **Sector** are two orthogonal, independent axes each with its own state; Region options: Worldwide (default), USA, Europe, China/Asia, Japan, Latin America (Japan is split out of the broader Asia bucket; Latin America is its own region); Sector options: **Overview** (default) + eighteen sectors (Semiconductors, AI, Quantum, Software, Space, Defense, Industrials, Real Estate, Energy, Utilities, Financials, Payments, Crypto, Healthcare, Automotive, Consumer, Telecom, Airlines); when Sector = Overview the page renders the selected region's curated static symbol lists in two sections — "Indices" (Yahoo index tickers) and "Top stocks" (large-cap stocks) — defined in the adjacent `marketViews.ts` data module; when a specific sector is selected the page renders that sector's basket filtered to the selected region — Worldwide shows every member, a region shows only members whose in-config `region` field matches (`'usa' | 'europe' | 'asia' | 'japan' | 'latam'`); members with no `region` tag (e.g. Enbridge, Saudi Aramco) appear only in Worldwide; sector baskets are enriched with European and Asian large-caps so USA/Europe/Asia views are populated; Halliburton (HAL) added to the Energy sector (region `usa`) and to the USA region Top stocks list; an empty-state message (`research.markets.empty`) renders when a (sector, region) combination has no tracked names; **all tiles are a heat-map** — price and currency are dropped; each tile shows the symbol label + a large `changePercent` value (`text-foreground` for contrast in both themes; sign is the color-blind-safe cue); the card background is a red→green linear-gradient tinted by move magnitude (±3 % saturates, flat ≈ neutral); missing quotes degrade to a neutral em-dash tile; **held-position tiles** (symbols matched against `useInvestmentsQuery` by symbol + Yahoo `price_provider_id`, with a `-USD` crypto-base fallback) get an accent ring + corner star — gold in the default theme, the active theme's `accent` token in others; clicking a tile navigates to `/research/market?symbol=<symbol>` (Market Lookup); data source unchanged: `GET /api/market/quote?symbols=…&detail=basic` — only `changePercent` is read; React Query key changed from `["market-overview", view.key]` to `["market-overview", region, sector]`; query is gated on `symbols.length > 0`; 60 s `refetchInterval`, online-gated; added to the Research sidebar Overview group with a `Globe` icon, the CommandPalette research go-to list, and a 6th `EntryCard` on `ResearchHomePage`; i18n: new keys `research.markets.regions`, `research.markets.sectors`, `research.markets.sector.{semiconductors,ai,quantum,software,space,defense,industrials,realEstate,energy,utilities,financials,payments,crypto,healthcare,automotive,consumer,telecom,airlines}`, `research.markets.region.{japan,latam}`, `research.markets.held` ("In your portfolio" / "In je portefeuille"), **`research.markets.sector.overview`** ("Overview" / "Overzicht"), **`research.markets.empty`** (empty-state text); `research.markets.subtitle` and `research.entry.markets` reworded for the heat-map/sectors framing; en + nl, regenerated, validate-locales clean), and the symbol-mapping confirm dialog (`ResearchMappingDialog`). Scorecard UI: `ResearchScorecard.tsx` (grade badge + panel); `ResearchFundamentalsTab` uses the scorecard endpoint. Routing/sidebar (Analysis group: Chart Builder, Forecast)/CommandPalette/go-to shortcuts updated; old `/portfolio/market` + `/portfolio/watchlist` redirect (preserving query params). **Settings → App** gains a *Research providers* section. i18n en/nl added including new keys `research.marketSnapshot`, `research.entry.charts`, `research.entry.forecast`, `research.watchlistEmpty`, and `research.watchlistEmptyCta`; Markets Overview added keys `nav.markets`, `research.markets.title`, `research.markets.subtitle`, `research.markets.indices`, `research.markets.stocks`, `research.markets.region.{usa,europe,asia,worldwide}`, and `research.entry.markets` (note: scorecard `reason` sentences are English-only — tracked follow-up).
> **Provider keys:** all five adapters are implemented; the keyed four (Twelve Data, Finnhub, FMP, Alpha Vantage) activate when their key is set via the Settings UI or the root `.env` (ADR-080). Adapter normalization is unit-tested with mocks — **live verification per provider/tier is still recommended**. Universe screening remains out of scope — there is no universe-scan endpoint and free-tier quotas can't support one (Pillar D ships as a *selected-symbol* fundamentals comparison + per-symbol scorecard instead).

## API Surface

Eighteen endpoints at `/api/research`, all under `marketRateLimiter`: six GET data endpoints (search/quote/chart/fundamentals/analyst/news), two analytics endpoints (scorecard, portfolio-forecast), two macro endpoints (macro/search, macro/series — ADR-082), five symbol-mapping endpoints (`GET/POST/DELETE /mappings`, `POST /mappings/resolve`, `POST /mappings/audit`), and three provider-key Settings endpoints. Full endpoint reference: [[docs/api/research|Research API]].

| Endpoint | Data type | Cache / Notes |
|---|---|---|
| `GET /api/research/search?q=` | Ticker/security search | 10 min |
| `GET /api/research/quote?symbol=&asset_class=` | Live quote | 10 min |
| `GET /api/research/chart?symbol=&asset_class=&range=&provider=` | Historical chart points | 12 h; `provider` pins preferred provider (fallthrough still applies) |
| `GET /api/research/fundamentals?symbol=` | Fundamentals snapshot merged from FMP + Yahoo in parallel (FMP preferred per field, Yahoo fills gaps); extended fields include sector, pegRatio, payoutRatio, grossMargin, operatingMargin, revenueGrowth, earningsGrowth, debtToEquity, currentRatio, quickRatio, interestCoverage, freeCashFlow, fcfYield; `meta.provider` may be `"fmp+yahoo"` | 12 h |
| `GET /api/research/analyst?symbol=` | Analyst consensus + targets + recent actions | 24 h |
| `GET /api/research/news?symbol=` | News articles | 2 h |
| `GET /api/research/scorecard?symbol=&asset_class=` | Heuristic fundamentals scorecard (0–100 score, A–F grade, per-metric flags with severity); fundamentals sourced via merged FMP + Yahoo (same as `/fundamentals`) | reuses fundamentals 12 h merged cache |
| `POST /api/research/portfolio-forecast` | Monte Carlo projection of aggregate portfolio value; returns P10/P25/P50/P75/P90 bands + summary + forward-input provenance | on-demand, not persisted |
| `GET /api/research/macro/search?q=` | **Macro indicator catalog search** — fan-out across FRED + keyless Eurostat catalog; returns `MacroSeriesItem[]` tagged by provider | 1 h (ADR-082) |
| `GET /api/research/macro/series?provider=&series_id=&range=` | **Macro series observations** — provider-pinned fetch (no fallback chain); returns `ResearchChartPoint[]` mapped to `close` | 12 h (ADR-082) |

Each data endpoint response carries `meta.provider` (the provider that answered, or `null`) and `meta.source` (`'cache'` | `'live'` | `'unavailable'`). Symbol-mapping and provider-key endpoints documented in [[docs/api/research|Research API]].

## Aggregation Layer

The aggregation layer sits in `apps/node-backend/src/services/research/` and is composed of three independent mechanisms:

### 1. Capability Map

`capabilityMap.js` is a static, pure routing table: `(dataType, assetClass) → ordered provider preference`. The aggregator walks this chain and skips any provider that is unkeyed, quota-exhausted, or `providerHealthService`-unhealthy. Example chains:

| Data type | Default chain | Crypto override | Metals override |
|---|---|---|---|
| `quote` | yahoo → twelve_data → finnhub → fmp → alpha_vantage | binance → twelve_data → yahoo | kinesis → yahoo → twelve_data |
| `chart` | yahoo → twelve_data → finnhub → alpha_vantage | binance → twelve_data → yahoo | kinesis → yahoo → twelve_data |
| `fundamentals` | fmp → finnhub → yahoo | — | — |
| `news` | yahoo → finnhub | — | — |

> [!info] Yahoo-first for quote / chart / news (2026-06-16)
> The `quote`, `chart`, and `news` default chains were reordered to place Yahoo first, demoting paid providers (Twelve Data, Finnhub, FMP, Alpha Vantage) to fallback positions. Yahoo is keyless and unmetered, so it does not consume any paid-tier daily quota. The fall-through semantics are unchanged — a Yahoo failure still routes to the next provider in the chain. `fundamentals.default` deliberately remains FMP-first (Yahoo's fundamentals depth is shallower). See [[docs/adr/079-multi-provider-research-aggregation#follow-up-note--yahoo-first-provider-ordering-for-quote--chart--news-2026-06-16|ADR-079 follow-up note (2026-06-16)]] for the full rationale.

> [!info] Fundamentals: merged FMP + Yahoo, not raced (2026-06-16)
> `GET /api/research/fundamentals` and `GET /api/research/scorecard` do **not** race through the `fundamentals.default` chain. They call `researchAggregator.fetchFundamentals()`, which fetches **FMP and Yahoo in parallel** and merges results **field-by-field** (FMP preferred; Yahoo fills gaps). This gives the union of both providers: FMP-only fields (e.g. `interestCoverage`) and Yahoo-only fields (e.g. `forwardPE`, `revenue`, `freeCashFlow`) both appear in every response. Finnhub is retained in `fundamentals.default` in `capabilityMap.js` for documentation and the generic `fetch('fundamentals')` path, but is not called by these routes. `meta.provider` is `"fmp+yahoo"` when both contribute, or the single provider name when only one responds. Cache key `fundamentals:merged:<assetClass>:<symbol>`, TTL 12 h. See [[docs/adr/079-multi-provider-research-aggregation#follow-up-note--fundamentals-merged-across-fmp--yahoo-2026-06-16|ADR-079 follow-up note (2026-06-16)]].
>
> **Surfaces that render merged fundamentals:** Market Lookup (`MarketLookupPage.tsx` tabbed Details card — `ResearchFundamentalsTab` pulls the graded scorecard + grouped fundamentals via `/scorecard`; per-field fallback to Yahoo quote for indices/ETFs FMP does not cover), Compare page (Fundamentals tab). Both surfaces show the same merged composite.

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
| `fundamentals` | 12 h (merged cache key `fundamentals:merged:<assetClass>:<symbol>`) |
| `analyst` | 12 h |
| `news` | 2 h |
| `macro_search` | 1 h |
| `macro_series` | 12 h |

### 4. Provider Key Gating (`providerKeys.js`)

Providers requiring an API key are dropped from every capability chain when their key is absent from `.env.local`. Yahoo, Binance, and Kinesis are keyless and always available if their adapter exists.

| Provider | Env var |
|---|---|
| Twelve Data | `TWELVE_DATA_API_KEY` |
| Finnhub | `FINNHUB_API_KEY` |
| FMP | `FMP_API_KEY` |
| Alpha Vantage | `ALPHA_VANTAGE_API_KEY` |
| FRED (economic data) | `FRED_API_KEY` |

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
2. The confirm UI shows each provider's resolved **name + exchange + currency** so the user can catch collisions before `POST /mappings` persists them. A failed resolve is shown as a retryable error; it is not presented as a successful empty result.
3. ISIN anchors mappings for stocks/ETFs/bonds (`key_type=isin`); crypto/metals use a Vision-internal id (`key_type=internal`).
4. **Holdings pre-seed (shipped):** when `POST /mappings/resolve` is called with an `investment_id`, the held investment's already-configured provider (`price_provider` + `price_provider_id`) is injected as a `confirmed` proposal flagged `fromHolding: true`, and that provider's live search is skipped — the user already mapped it on the investment, so there's nothing to re-map. A stored `confirmed` mapping still wins; providers are de-duplicated. The frontend passes `investment_id` from the symbol page when it was opened from a holding (`?investmentId=`), and the confirm dialog renders pre-seeded providers as already-confirmed.
5. `POST /mappings/audit` cross-checks currency match and last-price agreement (>5% from median flagged) across mapped providers and stamps `verified_at`.

> [!info] Shipped (incl. holdings pre-seed)
> The symbol-mapping endpoints (resolve / save / list / delete over `instrument_provider_map`), the cross-provider self-audit, and the holdings pre-seed on resolve are **implemented** ([[apps/node-backend/src/services/research/researchMappingService.js]]), and the frontend confirm dialog (`ResearchMappingDialog`) consumes them (resolve → confirm/deselect → save, with an audit action, surfacing held-provider proposals as already-confirmed). Deleting a saved mapping (`DELETE /mappings/:id`) is irreversible and silently breaks price resolution for the asset, so it now goes through a `useConfirmDialog` destructive confirm (Aug 2026) before the row is removed — matching every other destructive surface in the app.

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

## Macroeconomic Indicators (ADR-082)

> [!info] Provider-pinned vertical — not raced like tickers (ADR-082, 2026-06-17)
> Macro series carry a **provider-specific series code** (`CPIAUCSL` on FRED, `Eurostat/prc_hicp_midx/M.I15.CP00.BE` on DBnomics) that is meaningless to other providers. Race-to-first cannot work. The macro vertical adds a **dedicated provider-pinned path** alongside the capability-map race — the same shape as the `fundamentals`-merge exception, but pinned rather than merged.

### Macro Providers

Three new adapters live alongside the existing five in `apps/node-backend/src/services/research/adapters/`:

| Adapter | Key? | Coverage |
|---|---|---|
| `fredAdapter.js` | **Keyed** (`FRED_API_KEY`; free at [fredaccount.stlouisfed.org](https://fredaccount.stlouisfed.org/apikeys)) | 800k+ US and OECD-sourced series: CPI (`CPIAUCSL`), Fed Funds rate (`FEDFUNDS`), GDP (`GDPC1`), unemployment (`UNRATE`), ECB policy rates via FRED codes (`ECBMRRFR`, `ECBDFR`), regional-Fed manufacturing surveys (Philly, NY Empire State, Richmond, Dallas) as PMI proxies |
| `eurostatAdapter.js` | **Keyless** (first-party EU data) | Eurostat dissemination API; `parseJsonStat` modeled on `belgianInflationService`'s proven JSON-stat handling but kept in a **separate module** — the inflation service's fetch/persist path is not touched (ADR-082 firewall). Curated via `macroCatalog.js`: BE/EA HICP, BE/EU27 unemployment |
| `dbnomicsAdapter.js` | **Keyless** | Fetch-by-id for ECB, OECD, and IMF SDMX series via `api.db.nomics.world`; open-ended search is FRED's role in v1 — DBnomics is used when a specific 3-part series path (`provider/dataset/series`) is known |

Two helpers support these adapters:

- `macroRange.js` — `periodToMs(period, range)` + `trimToRange(points, range)`. Range anchoring is on the **last available observation, not the wall clock** — macro data lags publication, so anchoring on "now" produced empty charts for short ranges.
- `macroCatalog.js` — curated keyless EU catalog (BE/EA HICP, BE/EU27 unemployment) with per-provider `isValidSeriesId` shape guards; makes common EU indicators discoverable without a FRED key.

> [!warning] PMI is out of scope
> Real PMI is proprietary (S&P Global / ISM). Free proxies reachable through this surface: **OECD Composite Leading Indicators** (via DBnomics) and **regional-Fed manufacturing surveys** (Philly Fed, NY Empire State, Richmond, Dallas) on FRED. The Chart Builder UI copy explains the gap.

### Aggregator Path

`researchAggregator.js` gained two new functions (distinct from the capability-map race):

- **`searchMacro(query)`** — fan-out across all usable macro adapters in parallel; UNIONs results into one `MacroSeriesItem[]` list tagged by provider. A provider that errors or is unkeyed is simply absent. Cached 1 h (`macro_search`).
- **`fetchMacroSeries({ provider, seriesId, range })`** — routes to **exactly one provider's** adapter. No fallback chain (a series exists at exactly one provider). Cached 12 h (`macro_series`). FRED is quota-governed (`{ perMinute: 120 }`); Eurostat and DBnomics are unmetered.

The capability map's `DATA_TYPES` gains `macro_search` and `macro_series` for cache-key and TTL purposes, but **no capability chain entries** — these types never race, so they have no ordered-provider table.

### Storage Boundary

Macro observations are **never persisted to `asset_price_history`** (ADR-079 storage boundary preserved). In-memory cache only; evicted on process restart or TTL expiry.

### Keyless Degradation

With no `FRED_API_KEY`, the macro surface degrades gracefully to the keyless **Eurostat catalog** (curated via `macroCatalog.js`) plus DBnomics fetch-by-id. FRED is absent; common EU indicators (HICP, unemployment) remain available. This mirrors how the keyed equity providers degrade when their keys are absent.

### Chart Builder Integration

`ChartBuilderPage.tsx` now has a **single unified search box** that fires both ticker search and macro search simultaneously (both debounced 300 ms), merging results into one dropdown. Results are grouped under **"Markets"** (ticker results) and **"Economic data"** (macro results) headers, with a source badge per macro row. A macro series renders as another line in the existing chart (`value → close`); its row hides the provider dropdown (provider-pinned) and shows a provider badge; candlestick mode is disabled for macro series. The `BuilderSeries` type gained an optional `macro?: { provider; seriesId; title }` field.

New i18n keys: `research.builder.groupMarkets`, `research.builder.groupEconomic`, `research.builder.economicHint` (PMI-proxy note), `research.builder.addSeries` updated (en + nl, validated).

## Relation to Existing Surfaces

- **[[docs/features/market-lookup|Market Lookup]]** (`/api/market/*`) — the consolidated security-detail surface at `/research/market`. The Research API and the market routes share the `marketRateLimiter` but remain distinct route files. Market Lookup now hosts the tabbed Details card (Fundamentals / Analyst / News via the research aggregator endpoints) and the Map-provider dialog, and is the deep-link target from all in-app navigation (heat-map tiles, home search, watchlist tiles). The standalone `ResearchSymbolPage` was retired; `/research/symbol/:symbol` redirects here. The ⌘K command palette also routes here: typing a bare ticker or `$`-cashtag shows an inline price card (symbol + price + percent change) as the first palette result, and pressing Enter opens `/research/market?symbol=<symbol>`.
- **[[docs/features/watchlist|Watchlist]]** — tracks securities not yet in the portfolio. Watchlist items are surfaced on `ResearchHomePage` as live-price tiles deep-linking to Market Lookup.
- **[[docs/integrations/price-providers|Price Providers]]** — `priceProviderRegistry` and `providerHealthService` are reused by the research layer; Yahoo, Binance, and Kinesis are the existing providers.

## Shared UI Components

All four symbol-picker pages in the Research section (`ResearchHomePage`, `MarketLookupPage`, `ResearchComparePage`, `ChartBuilderPage`) share two components from `apps/frontend/src/components/shared/` that guarantee visual consistency across the section:

- **`SymbolSearchBox`** — the tall glass input (`h-14 glass-regular`) with a leading `Search` icon, optional trailing loading spinner, and the `glass-thick` floating results dropdown (changed from `glass-elevated` in the June 2026 glass-consistency pass — floating dropdowns now uniformly use glass-thick). It exposes an ARIA combobox/listbox relationship; Arrow Up/Down visibly move the active result while input focus stays in place, Enter activates it, and Escape dismisses the popup. Home/End retain their normal text-caret behavior.
- **`SymbolSearchResultItem`** — the canonical result row (monospaced ticker, company name, asset-type badge, exchange label). Also used by `AddToWatchlistDialog` (inline scrollable list inside a modal, not a floating dropdown).

Each page owns its own query logic and passes result rows as `children` to `SymbolSearchBox`. Full props reference: [[docs/components/shared-components#SymbolSearchBox|Shared Components — SymbolSearchBox]].

### Research Workspace Card Material

All content `<Card>` elements on the four Research detail pages use `glass-regular` (added in the June 2026 glass-consistency pass that completed the ADR-070 card-glass rollout for the Research workspace):

| Page | Cards |
|---|---|
| `MarketLookupPage` | quote header, price chart + volume, tabbed Details (Fundamentals/Analyst/News), Trading info, and actions — the consolidated security-detail surface (formerly split with the retired `ResearchSymbolPage`) |
| `ResearchComparePage` | 5 content cards |
| `ChartBuilderPage` | 5 content cards |
| `PortfolioForecastPage` | 6 content cards |

`WatchlistPage` deliberately stays opaque — it is a dense data grid and is the explicit table exception documented in ADR-070.

## Related

- [[docs/adr/082-macroeconomic-indicators-data-vertical|ADR-082]] — architecture decision for the macro data vertical (FRED + Eurostat + DBnomics, provider-pinned, ADR-082)
- [[docs/adr/081-research-analytics-forecasting|ADR-081]] — architecture decision for Pillars B/C/D deepening (portfolio projection engine, scorecard, chart builder)
- [[docs/adr/079-multi-provider-research-aggregation|ADR-079]] — foundation ADR (aggregation layer, capability map, quota governor, symbol mapping, Pillars A/B/D initial)
- [[docs/api/research|Research API]] — endpoint reference (all 18 endpoints)
- [[docs/integrations/price-providers|Price Providers Integration]] — provider registry and health service this layer builds on
- [[docs/features/market-lookup|Market Lookup]] — existing Yahoo surface
- [[docs/features/watchlist|Watchlist]] — watchlist surface
- [[docs/components/shared-components|Shared Components]] — `SymbolSearchBox` and `SymbolSearchResultItem` canonical chrome components
- [[docs/adr/073-shared-portfolio-math-package|ADR-073]] — shared portfolio math used by the projection engine
- [[docs/adr/065-daily-gap-fill-dense-asset-history|ADR-065]] — held-asset storage model (unchanged; storage boundary preserved)
- [[docs/adr/034-admin-environment|ADR-034]] — `providerHealthService` used for capability routing
- [[docs/integrations/belgian-inflation|Integration: Belgian Inflation Service]] — the existing Eurostat JSON-stat parser that informed the `eurostatAdapter` design (firewall: the inflation service itself is not modified)
- [[docs/reference/data-model#provider_api_keys (June 2026, ADR-079, migration 0043)|Data Model — provider_api_keys, instrument_provider_map, provider_quota]] — schema reference for the three persistence tables backing this feature
