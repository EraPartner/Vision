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
  - yahoo
  - pillar-a
  - pillar-b
  - pillar-d
description: Research section (ADR-079) — a provider-agnostic market research surface backed by a capability map, quota governor, and type-aware in-memory cache. Yahoo Finance is the only adapter wired today; Twelve Data, Finnhub, FMP, and Alpha Vantage are defined in the capability map and activate when their API keys are provisioned. The `/research` frontend workspace (home, moved Market Lookup + Watchlist, symbol detail with lazy tabs, compare, and the symbol-mapping confirm dialog) is shipped.
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
  - apps/node-backend/src/repositories/providerQuotaRepository.js
  - alembic/versions/0042_add_research_provider_mapping_and_quota.py
---

# Research Feature

## Overview

The Research section gives users a unified hub to investigate any security — not only held assets — across multiple free-tier market data providers. It is designed around four pillars:

| Pillar | Description | Status |
|---|---|---|
| **A — Research workspace** | A consolidated area combining [[docs/features/market-lookup\|Market Lookup]] and [[docs/features/watchlist\|Watchlist]] into a single navigable research surface for any symbol | **Shipped** — `/research` workspace (3rd workspace alongside Budget + Portfolio); Market Lookup + Watchlist moved here from `/portfolio/*` |
| **B — Comparative analysis** | Multi-symbol overlay charts (rebased), return/volatility/drawdown comparisons, cross-holding correlation — all computable from daily closes | **Shipped** — `/research/compare` (rebased overlay + return/volatility/max-drawdown table); correlation matrix deferred |
| **D — Screening / fundamentals** | Side-by-side fundamentals comparison; screening partially unlocked via free tiers (FMP/Finnhub for US; EU fundamentals depth limited without a paid source) | Backend + per-symbol fundamentals tab shipped; multi-symbol screening UI not yet built |
| **C — Portfolio value projection** | Monte Carlo projection of portfolio value / net worth using the existing forecast engine | Deferred — orthogonal to this work; tracked separately |

> [!info] What shipped
> **Backend:** the API surface (11 endpoints under `/api/research` — 6 data + 5 cross-provider symbol-mapping), the full aggregation layer (capability map, quota governor, type-aware cache), the Yahoo adapter, the symbol-mapping service + self-audit, and the DB migration creating `instrument_provider_map` and `provider_quota` tables.
> **Frontend:** the `/research` workspace — home (`ResearchHomePage`), moved Market Lookup + Watchlist, symbol detail (`ResearchSymbolPage`: quote header + visx chart + lazy per-tab Fundamentals/Analyst/News), comparison (`ResearchComparePage`), and the symbol-mapping confirm dialog (`ResearchMappingDialog`: resolve → confirm → save + audit). Routing/sidebar/CommandPalette/go-to shortcuts updated; old `/portfolio/market` + `/portfolio/watchlist` redirect (preserving query params). i18n en/nl added.
> **Not yet:** the four keyed provider adapters (Twelve Data, Finnhub, FMP, Alpha Vantage activate once their `.env.local` key + adapter module exist), multi-symbol screening UI, correlation matrix, and the holdings pre-seed for mappings.

## API Surface

Eleven endpoints at `/api/research`, all under `marketRateLimiter`: six GET data endpoints (search/quote/chart/fundamentals/analyst/news) and five symbol-mapping endpoints (`GET/POST/DELETE /mappings`, `POST /mappings/resolve`, `POST /mappings/audit`). Full endpoint reference: [[docs/api/research|Research API]].

| Endpoint | Data type | Cache TTL |
|---|---|---|
| `GET /api/research/search?q=` | Ticker/security search | 10 min |
| `GET /api/research/quote?symbol=&asset_class=` | Live quote | 10 min |
| `GET /api/research/chart?symbol=&asset_class=&range=` | Historical chart points | 12 h |
| `GET /api/research/fundamentals?symbol=` | Fundamentals snapshot | 24 h |
| `GET /api/research/analyst?symbol=` | Analyst consensus + targets + recent actions | 24 h |
| `GET /api/research/news?symbol=` | News articles | 2 h |

Each response carries `meta.provider` (the provider that answered, or `null`) and `meta.source` (`'cache'` | `'live'` | `'unavailable'`).

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
4. Holdings pre-seed the map from `price_provider` + `price_provider_id` already stored on `investments` *(planned — not yet wired)*.
5. `POST /mappings/audit` cross-checks currency match and last-price agreement (>5% from median flagged) across mapped providers and stamps `verified_at`.

> [!info] Shipped; holdings pre-seed pending
> The symbol-mapping endpoints (resolve / save / list / delete over `instrument_provider_map`) and the cross-provider self-audit are **implemented** ([[apps/node-backend/src/services/research/researchMappingService.js]]), and the frontend confirm dialog (`ResearchMappingDialog`) consumes them (resolve → confirm/deselect → save, with an audit action). The **holdings pre-seed** step (step 4 above) is not yet wired.

## Planned: Additional Provider Adapters

The capability map already lists Twelve Data, Finnhub, FMP, and Alpha Vantage as preferred providers for various data types. The adapters are **not yet implemented**. Each adapter module will be added to `apps/node-backend/src/services/research/adapters/` and will automatically become active in the capability chain once the corresponding API key is provisioned.

## Relation to Existing Surfaces

- **[[docs/features/market-lookup|Market Lookup]]** (`/api/market/*`) — the existing Yahoo-only single-provider surface for portfolio add-from-search. The Research API coexists with it; they share the `marketRateLimiter` but are distinct routes. The future Research workspace (Pillar A) will consolidate both.
- **[[docs/features/watchlist|Watchlist]]** — tracks securities not yet in the portfolio. The future Research workspace (Pillar A) will surface watchlist items alongside research data.
- **[[docs/integrations/price-providers|Price Providers]]** — `priceProviderRegistry` and `providerHealthService` are reused by the research layer; Yahoo, Binance, and Kinesis are the existing providers.

## Related

- [[docs/adr/079-multi-provider-research-aggregation|ADR-079]] — full architectural decision record (context, design alternatives, consequences, deferred items)
- [[docs/api/research|Research API]] — endpoint reference
- [[docs/integrations/price-providers|Price Providers Integration]] — provider registry and health service this layer builds on
- [[docs/features/market-lookup|Market Lookup]] — existing Yahoo surface
- [[docs/features/watchlist|Watchlist]] — watchlist surface
- [[docs/adr/065-daily-gap-fill-dense-asset-history|ADR-065]] — held-asset storage model (unchanged by this feature)
- [[docs/adr/034-admin-environment|ADR-034]] — `providerHealthService` used for capability routing
