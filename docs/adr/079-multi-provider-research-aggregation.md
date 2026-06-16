---
title: ADR-079 - Multi-Provider Research Data Aggregation with Cross-Provider Symbol Mapping
type: adr
status: accepted
date: 2026-06-16
tags: [adr, research, market-data, price-providers, aggregation, capability-map, quota-governor, token-bucket, rate-limiting, symbol-mapping, instrument-identity, isin, lazy-merge, cache-ttl, twelve-data, finnhub, fmp, alpha-vantage, yahoo, provider-health, charting, fundamentals, news, pillar-a, pillar-b, pillar-d]
related: [docs/adr/065-daily-gap-fill-dense-asset-history, docs/adr/064-net-worth-current-value-live-overlay, docs/adr/034-admin-environment, docs/integrations/price-providers, docs/features/market-lookup, docs/features/watchlist]
description: A Research section aggregates many free-tier market-data providers (Yahoo, Twelve Data, Finnhub, FMP, Alpha Vantage) behind the existing priceProviderRegistry. Three new layers — a capability map (dataType×assetClass→provider preference), a persisted quota governor (per-minute + per-day token buckets), and type-aware cache TTLs — route requests to avoid rate limits. Research data is fetched live and never persisted to asset_price_history; only the cross-provider symbol map and quota counters are stored. A user-confirmed instrument mapping (auto-proposed via provider search, anchored on ISIN where available) is the fool-proof anchor against silent wrong-instrument merges. Unlocks Research pillars A (workspace) and B (comparative analysis) strongly, D (screening/fundamentals) partially; pillar C (portfolio projection) is orthogonal and deferred.
---

# ADR-079: Multi-Provider Research Data Aggregation with Cross-Provider Symbol Mapping

## Status

**Accepted** — Design recorded 2026-06-16; implementation in progress.

## Date

2026-06-16

## Context

Vision is gaining a **Research section** with four feature pillars:

- **A — Research workspace**: a unified hub consolidating the existing [[docs/features/market-lookup|Market Lookup]] and [[docs/features/watchlist|Watchlist]] surfaces into one navigable area for researching *any* security (not only held assets).
- **B — Comparative analysis**: multi-symbol overlay charts (rebased), returns / volatility / drawdown, and cross-holding correlation — all derivable from daily closes.
- **C — Portfolio value projection**: Monte Carlo projection of portfolio value / net worth using the existing forecast engine. **Out of scope here** (see Consequences → Deferred).
- **D — Screening / fundamentals**: fundamentals comparison and screening.

### The data problem

Today the entire research-adjacent surface (`routes/marketLookup.js`) depends on a **single scraped source**, Yahoo, via `yahoo-finance2` with `validateResult: false` to survive payload drift. Yahoo is the only free source that is simultaneously global *and* carries fundamentals + analyst + news, but it is unreliable (intermittent 502s) and has no contractual feed. No single free alternative beats it on breadth: Finnhub and EODHD paywall international fundamentals; Alpha Vantage's free tier (~25/day) is exhausted in one research session; Twelve Data is reliable and global but shallow on fundamentals.

The **union** of free tiers, however, covers nearly everything Yahoo does *plus* the reliability Yahoo lacks — if requests are routed to avoid rate limits and the right provider answers each data type.

### Two hard constraints established during design

1. **Storage stays narrow.** The user's requirement: persist price points only for **held** assets, only within their **holding windows** — which is exactly what `quoteBackfillService` already does. Research must be able to cover **arbitrary** symbols *without* persisting them. Therefore research data is fetched live and cached in memory only; nothing about arbitrary symbols lands in `asset_price_history`.

2. **Symbol identity is the real risk.** International ticker reuse is rampant (the same string is a different instrument across NASDAQ / Xetra / Euronext). An automated cross-provider matcher will eventually map wrong, and the failure is *silent*: the chart shows the wrong instrument's data confidently. This is the single most dangerous failure mode of a multi-provider system.

### Existing substrate (≈70% built)

- `priceProviderRegistry` — the provider abstraction (`yahoo`, `binance`, `kinesis`, `custom`, `manual`). New providers are added as modules, not a rewrite.
- `providerHealthService` — already records `recordProviderSuccess` / `recordProviderError` per provider ([[docs/adr/034-admin-environment|ADR-034]]); the health signal a router needs to deprioritise a failing/limited provider.
- In-memory price cache with `sweepExpiredCacheEntries` (5-min sweep) and per-provider TTLs.
- `Promise.allSettled` parallel fetch, per-investment fallback chains, and the `isInternetReachable` offline guard.
- Held investments already carry `price_provider` + `price_provider_id` — a pre-seed for the research mapping.

## Decision

Add a **research aggregation layer** on top of `priceProviderRegistry` composed of three new mechanisms plus a user-confirmed symbol map. Wire **five providers** at once: Yahoo (existing), Twelve Data, Finnhub, FMP, Alpha Vantage.

### 1. Capability map (static)

A table `(dataType, assetClass) → ordered provider preference`, e.g.:

```
quote/chart,  stock/etf → [twelveData, yahoo, finnhub, alphaVantage]
quote/chart,  crypto    → [binance, twelveData, yahoo]
fundamentals, stock     → [fmp, finnhub, yahoo]
news                    → [finnhub, yahoo]
metals                  → [kinesis, yahoo]
```

The router walks the preference list, skips any provider the quota governor reports as tapped out or that `providerHealthService` reports unhealthy, and falls through to the next — reusing the existing fallback-chain pattern.

### 2. Quota governor (persisted token buckets)

Per-provider token buckets tracking **both** windows where applicable (Finnhub 60/min; Twelve Data 8/min *and* 800/day; Alpha Vantage ~25/day; FMP 250/day). `canSpend(provider)` is checked before every outbound call; on `false` the router moves to the next provider instead of incurring a 429.

**Per-day counters are persisted** in a new `provider_quota` table — in-memory buckets reset on restart, which would let a frequently-restarted backend blow a 25/day cap. Per-minute buckets remain in-memory (cheap, self-healing).

### 3. Type-aware cache TTLs (the quota multiplier)

Research tolerates staleness, so caching — not scheduling — is the primary rate-limit defence. The existing in-memory cache gains research-scoped TTLs by data type:

| Data type | TTL |
|---|---|
| Live quote | 5–15 min |
| Daily chart / history | 12–24 h |
| Fundamentals | 24 h+ |
| Analyst targets | 24 h |
| News | 1–4 h |

With a 12 h fundamentals TTL and 10-min quote TTL, a single free tier (e.g. Twelve Data 800/day) comfortably covers a personal research session over dozens of symbols.

### 4. Lazy field-merge, per user intent

"Best information" means composing one record from several providers (price from one, P/E from another, news from a third). Eager-merging every symbol is what drains quotas, so merging is **lazy and per research tab**: opening a symbol overview costs one quote call; clicking Fundamentals costs one FMP call (then cached 24 h); clicking News costs one Finnhub call. The composite is only assembled for data the user actually viewed.

### 5. Cross-provider symbol mapping (the fool-proof anchor)

A user-confirmed mapping is the only reliable defence against silent wrong-instrument merges. The flow:

1. **Auto-propose, don't blank-prompt.** On adding a research subject, run each provider's symbol-search endpoint and pre-fill a best-guess per provider.
2. **Confirm the resolved instrument, not the string.** The mapping UI shows each provider's resolved **name + exchange + currency** so the user catches collisions (`APLE` Apple Hospitality REIT vs `AAPL` Apple Inc.) that a bare ticker would hide.
3. **Anchor on ISIN where available** (stocks / ETFs / bonds — especially European); crypto and metals fall back to a Vision-internal instrument id + per-provider symbol. The mapping row is reusable: an instrument is mapped once.
4. **Pre-seed from holdings.** A held asset already has one provider mapped (`price_provider` + `price_provider_id`); only the *other* providers are prompted.
5. **Degrade visibly when unmapped.** A provider with no symbol for a subject is simply not used for that subject's data — but the UI shows *"News unavailable — Finnhub not mapped [+ map]"* rather than silently omitting it (silent omission misreads as "no data exists").
6. **Self-audit mappings.** Once two+ providers are mapped, cross-check currency match and last-price agreement within tolerance; flag likely mismatches; stamp `verified_at`.

### 6. Persistence boundary

- **Persisted:** the `instrument_provider_map` table (the mappings) and the `provider_quota` table (per-day counters). Both via a new Alembic migration with rollback ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]).
- **Not persisted:** all research market data for arbitrary symbols. It lives in the in-memory cache only and is never written to `asset_price_history`. The held-asset holding-window persistence of [[docs/adr/065-daily-gap-fill-dense-asset-history|ADR-065]] is unchanged.

### 7. Provider keys

Twelve Data / Finnhub / FMP / Alpha Vantage API keys live in `.env.local` (gitignored), documented in `docs/reference/environment-variables.md`. A provider with no configured key is treated as permanently unavailable by the capability router and dropped from preference lists — the system degrades to whichever providers are keyed (Yahoo needs no key).

## Consequences

### Positive

1. **Reliability.** Yahoo's 502s are backstopped: when Yahoo fails or a provider is rate-limited, the capability router + health service route around it.
2. **Breadth.** The union of free tiers covers quotes/charts (Twelve Data), news (Finnhub), and US fundamentals (FMP) better than Yahoo alone.
3. **Rate-limit safety by construction.** The quota governor never knowingly issues a call that would 429; persisted day-counters survive restarts.
4. **Fool-proof identity.** User-confirmed, ISIN-anchored mappings eliminate silent wrong-instrument data; the self-audit catches fat-finger errors.
5. **Additive.** Everything slots behind `priceProviderRegistry` and reuses `providerHealthService` + the existing cache. Yahoo is not removed.
6. **Pillar impact:** A (workspace) **strongly unlocked**; B (comparative analysis) **fully unlocked — biggest direct beneficiary**, all computable from daily closes; D (screening/fundamentals) **partially unlocked**.

### Negative / Tradeoffs

1. **N adapters, N keys, N ToS.** Five providers = five response shapes to normalise, five keys to manage, five terms-of-service to honour (incl. caching/redistribution clauses — to review per provider before leaning on aggressive caching). "All at once" front-loads this cost before the pattern is proven on one provider — an accepted tradeoff per the product decision.
2. **Symbol identity is the hard part.** The mapping model and cross-provider resolution carry the project's main correctness risk; underbuilding it surfaces as confidently-wrong data.
3. **Free-tier churn.** Free tiers shrink or vanish (IEX Cloud shut down Aug 2024; Alpha Vantage cut 500→25/day). The capability map + health service make losing one provider a graceful degradation rather than a broken pillar.
4. **Screening (D) never fully arrives on free tiers.** Screening is inherently quota-heavy (many symbols at once) and EU fundamentals depth stays weak without a paid source (EODHD ≈ $20–100/mo). This layer raises D's ceiling but does not remove that wall.
5. **Eager merge avoided deliberately.** Lazy per-tab merge is a UX constraint, not just an optimisation; assembling a full composite per symbol up front would exhaust quotas.

### Deferred / Out of scope

- **Pillar C (portfolio projection)** is **orthogonal** to this work: projecting *your* portfolio value runs on the holding-window return history already in `asset_price_history` plus the `forecast/` engine — more market-data providers do not advance it. C is a separate workstream (repoint the forecast engine at portfolio value). One marginal future tie-in: feeding forward-looking inputs (analyst growth, dividend yields from Finnhub/FMP) into expected-return assumptions — a v2 enrichment, not core.
- **Paid EU-fundamentals provider (EODHD)** is the escape hatch if pillar D's free-tier ceiling proves too low.

## Implementation

- **Migration:** `instrument_provider_map` (instrument_key, key_type[isin|internal], provider, provider_symbol, resolved_name, currency, status[confirmed|auto|failed], verified_at) + `provider_quota` (provider, window_date, count) — new Alembic revision with rollback.
- **Capability map + quota governor:** new pure modules under `apps/node-backend/src/services/research/` with unit tests (testable without live keys).
- **Provider adapters:** new modules behind `priceProviderRegistry`; Yahoo wraps existing `marketLookup.js` paths; Twelve Data / Finnhub / FMP / Alpha Vantage are new (gated on `.env.local` keys for live testing).
- **Research routes:** new `/api/research/*` surface (search/resolve/quote/chart/fundamentals/news) — update `docs/reference/api-endpoint-matrix.md` + `docs/api/`.
- **Frontend:** symbol-mapping confirm dialog + research workspace pages; i18n en/nl.

## Related Decisions

- [[docs/adr/065-daily-gap-fill-dense-asset-history|ADR-065]] — held-asset holding-window persistence (unchanged by this ADR; the storage boundary kept narrow here).
- [[docs/adr/064-net-worth-current-value-live-overlay|ADR-064]] — live-overlay pattern this layer's caching mirrors.
- [[docs/adr/034-admin-environment|ADR-034]] — `providerHealthService` passive tracking reused for capability routing.
- [[docs/adr/027-alembic-single-source-of-schema|ADR-027]] — schema changes ship as Alembic revisions with rollback.

## Related Docs

- [[docs/integrations/price-providers|Price Providers Integration]] — provider registry this layer extends.
- [[docs/features/market-lookup|Market Lookup]] / [[docs/features/watchlist|Watchlist]] — surfaces the Research workspace consolidates.
- [[docs/adr/index|All ADRs]]
