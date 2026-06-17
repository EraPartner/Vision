---
title: "ADR-082: Macroeconomic Indicators Data Vertical (FRED + DBnomics)"
type: adr
status: Proposed
date: 2026-06-17
last_modified: 2026-06-17
updated: 2026-06-17
tags: [adr, research, macro, macroeconomic, cpi, pmi, indices, fred, dbnomics, eurostat, ecb, oecd, capability-map, provider-pinned, chart-builder, adr-079, adr-081, free-data-provider]
description: Add a macroeconomic-indicator data vertical (CPI, rates, GDP, business surveys) to the Research aggregation layer using FRED (keyed) + DBnomics (keyless). Macro series are provider-pinned, not raced like tickers — a dedicated path parallel to the fundamentals-merge precedent. Reuses the chart-point model + Chart Builder; storage boundary preserved (in-memory cache only). Proposed.
aliases: [macro data, economic indicators, CPI provider, FRED, DBnomics, macro vertical]
---

# ADR-082: Macroeconomic Indicators Data Vertical (FRED + DBnomics)

## Status

Accepted

## Date

2026-06-17

## Context

The Research section (ADR-079, deepened by ADR-081) gives strong per-instrument
analysis — quote, chart, fundamentals, analyst, news, scorecard, and a freeform
[[apps/frontend/src/pages/research/ChartBuilderPage|Chart Builder]]. Everything in
that layer is **symbol-centric**: a single ticker (`AAPL`) means the same instrument
at every provider, so the [[apps/node-backend/src/services/research/capabilityMap|capability map]]
can **race** providers for it (first to answer wins; the rest are fallbacks).

There is no support for **general macroeconomic series** — CPI/inflation, policy and
market interest rates, unemployment, GDP, money supply, business-sentiment surveys.
The user wants these chartable alongside equities in the Chart Builder.

### Why this does not fit the existing model

A macro series is identified by a **provider-specific series code**, not a universal
ticker:

- FRED: `CPIAUCSL` (US CPI, all-items), `UNRATE`, `FEDFUNDS`, `GDPC1`.
- DBnomics: a 3-part path `provider/dataset/series`, e.g.
  `Eurostat/prc_hicp_midx/M.I15.CP00.BE` (Belgian HICP).

`CPIAUCSL` is meaningless to DBnomics and the Eurostat path is meaningless to FRED.
**Race-to-first cannot work** — there is no shared key to race on. This is the same
shape of problem `fundamentals` hit in ADR-079, which is why fundamentals is *merged*
across FMP+Yahoo rather than raced. Macro needs an analogous dedicated path, but
**provider-pinned** rather than merged: each series carries its owning provider, and
observation fetches route only to that provider.

### Provider survey (free options)

| Provider | Key? | Coverage | Verdict |
|---|---|---|---|
| **FRED** (St. Louis Fed) | Free key, ~120 req/min | 800k+ US + OECD-sourced series; clean JSON | **Chosen** — deepest, most robust, generous limits |
| **DBnomics** | **None** | Unifies FRED + **Eurostat** + **ECB** + OECD + IMF + national stats | **Chosen** — keyless, European-native (HICP/ECB), one API |
| **Eurostat** | None | EU HICP, unemployment, GDP | **Chosen (thin direct adapter)** — reuses our existing JSON-stat parser; first-party EU data without a DBnomics hop |
| ECB | None | Policy/market rates, M3, HICP (SDMX) | Reach **through DBnomics** — existing ECB client is FX-only XML, wrong API to extend |
| OECD | None | CPI + Composite Leading Indicators (CLI) | Reachable through DBnomics; CLI is the free PMI proxy |
| World Bank | None | Mostly annual | Out of scope (low timeliness) |

DBnomics re-serves FRED/Eurostat/ECB/OECD through one **keyless** API (fits the repo's
keyless-first, no-secret-management leaning — see Yahoo in ADR-079), and direct FRED
adds robustness and the freshest US series. Together they cover CPI, rates, GDP,
unemployment, and survey/diffusion indices for the US **and** the euro area / Belgium.

### What we already query — and whether it is reusable

The backend already calls ECB and Eurostat, so the obvious question is whether the
macro vertical should extend those rather than add providers. Audited per source:

| Existing client | What it actually speaks | Reusable for macro charting? |
|---|---|---|
| [[apps/node-backend/src/services/currency/rateFetcher|currency/rateFetcher.js]] (ECB) | ECB **`eurofxref`** XML feeds — **FX reference rates only** (`<Cube currency rate/>`, EUR→X) | **No.** ECB macro series (policy rate, M3, HICP) live in the ECB Data Portal **SDMX** API — different endpoint, different format (SDMX-JSON). The XML `<Cube>` parser cannot read it; "extending" it means a new SDMX client. Reach ECB macro **through DBnomics** (it already wraps ECB SDMX). |
| [[apps/node-backend/src/services/belgianInflationService|belgianInflationService.js]] (Eurostat) | Real Eurostat dissemination API; a working **JSON-stat parser** (`dimension.time.category.index` + `value`), but hard-wired to `prc_hicp_midx?geo=BE&coicop=CP00` and converts index → MoM rate, discarding levels | **Yes (parser).** The JSON-stat reader generalizes to *any* Eurostat dataset. A thin first-party Eurostat adapter can reuse an extracted `parseJsonStat()` helper to chart arbitrary EU series (HICP by COICOP/geo, `une_rt_m` unemployment, GDP). |
| belgianInflationService.js (Statbel) | One hard-wired Belgian CPI view (`bestat … views/86586e27-…`) | **No.** Hyper-specific; leave it serving the inflation-adjusted-return pipeline (snapshotBuilder → real return). |

**Conclusion:** extend **Eurostat** (reuse the parser), do **not** extend the **ECB FX
client** (wrong API surface — DBnomics covers ECB macro for free).

> [!warning] Firewall: do not entangle charting with the inflation-rate pipeline
> `belgianInflationService` persists into `belgian_inflation_rates`, which is read by
> `snapshotBuilder` to compute each snapshot's `inflation_adjusted_value` →
> `portfolioMath.realReturnPct` — i.e. **inflation-adjusted (real) portfolio return** on
> the Performance page (and `/api/info/inflation-rates`). It does **not** feed the
> Belgian tax engine. The macro charting vertical must reuse only the **pure parse
> helper**, never that service's fetch/persist path, and must stay
> **in-memory-cache-only** (ADR-079 storage boundary). Extracting `parseJsonStat()` is a
> pure-function refactor; the inflation service's rate-derivation and persistence are
> **out of scope** for this ADR and left untouched.

### The PMI caveat (explicit non-goal)

Real **PMI is proprietary** — both S&P Global (ex-Markit) and the US ISM license their
indices; ISM withdrew its series from FRED years ago. There is no clean free PMI API,
so headline PMI is **out of scope**. The same surface *does* reach free purpose-built
**proxies** with no extra code:

- **OECD Composite Leading Indicators (CLI)** — via DBnomics.
- **Regional Fed manufacturing surveys** (Philly Fed, NY Empire State, Richmond, Dallas)
  — diffusion indices on FRED.

This must be surfaced in the UI copy so a user searching "PMI" understands why CPI is
rich but PMI is thin, and what the proxies are.

### Market indices are already covered

S&P 500 (`^GSPC`), EURO STOXX 50 (`^STOXX50E`), BEL 20 (`^BFX`) etc. are chartable
**today** via the existing Yahoo adapter. The genuinely new need is *macroeconomic
indicators*, not index levels.

## Decision

Add a **macro data vertical** to the existing research aggregation layer rather than a
new subsystem. It reuses the cache, quota governor, provider-key gating, and the
`ResearchChartPoint` chart-rendering model, but introduces a **provider-pinned** fetch
path that sits beside the capability-map race (not inside it).

### 1. Three new adapters, registered like the rest

- `fred` — **keyed** (`FRED_API_KEY`); add to `ENV_VAR_BY_PROVIDER` in
  [[apps/node-backend/src/services/research/providerKeys|providerKeys.js]] so it gates on
  key presence and appears in the Settings *Provider keys* UI (reuses `provider_api_keys`,
  migration 0043 — no new migration).
- `dbnomics` — **keyless** (always usable, like Yahoo). Also the path to **ECB macro**
  (policy rate, M3, HICP) via its SDMX wrapping — the existing ECB FX client is *not*
  extended (see audit above).
- `eurostat` — **keyless**, first-party. Reuses a `parseJsonStat()` helper extracted from
  `belgianInflationService` to chart arbitrary Eurostat datasets without a DBnomics hop.
  *Optional but recommended* — DBnomics already serves Eurostat, so this is a
  reduce-a-hop optimisation for the most relevant (EU/Belgian) data, not a hard
  dependency. Ships behind the same adapter contract, so it can land in a later pass.

Each implements two methods (a new method set, distinct from the symbol-centric ones):

```js
macroSearch(query) -> { items: MacroSeriesItem[] }
macroSeries(seriesId, { range }) -> { provider, seriesId, title, units, frequency, points }
```

`MacroSeriesItem = { provider, seriesId, title, frequency, units, region?, source? }`.
`points` are `ResearchChartPoint[]` with the observation value mapped to `close` and
`high`/`low`/`volume` left `undefined` — so a macro series drops straight into the
existing `ComposedChart` and Chart Builder with zero rendering changes.

Provider endpoint shapes (fixed hosts — see SSRF note):

- FRED search: `GET https://api.stlouisfed.org/fred/series/search?search_text=…&api_key=…&file_type=json`
- FRED observations: `GET …/fred/series/observations?series_id=…&observation_start=…&api_key=…&file_type=json`
  (`value` is a string; `"."` = missing → skip).
- DBnomics search: `GET https://api.db.nomics.world/v22/search?q=…` (returns `provider_code`/`dataset_code`/`series_code`; `seriesId = "{provider}/{dataset}/{series}"`).
- DBnomics observations: `GET https://api.db.nomics.world/v22/series/{provider}/{dataset}/{series}?observations=1`
  (parallel `period[]` + `value[]` arrays).

### 2. Provider-pinned aggregator path (NOT raced)

Add two functions to [[apps/node-backend/src/services/research/researchAggregator|researchAggregator]],
mirroring the dedicated `fetchFundamentals` precedent:

- `searchMacro(query)` — **fan-out** to every usable macro adapter (FRED + DBnomics, plus
  Eurostat once added) in parallel, concatenate results into one catalog list, tag each
  item with its provider. (Union, like a catalog merge — not a race, not a field-merge.)
  A provider that errors or has no key is simply absent from the union.
- `fetchMacroSeries(provider, seriesId, range)` — route to **that one provider's**
  adapter. No fallback chain (a series exists at exactly one provider). Records
  health/quota/cache exactly like `fetch`.

The capability map's `DATA_TYPES` gains `macro_search` and `macro_series` for cache-key
and TTL purposes, but **no CAPABILITY chain entries** — these types never race, so they
have no ordered-provider table. This keeps the race model untouched for tickers.

### 3. Two new endpoints (`/api/research/macro/*`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/research/macro/search?q=…` | Fan-out catalog search across FRED + DBnomics; `{ items: MacroSeriesItem[] }` |
| GET | `/api/research/macro/series?provider=fred&series_id=CPIAUCSL&range=5y` | Provider-pinned observations; `{ provider, seriesId, title, units, frequency, points }` |

Both carry the ADR-079 `meta.provider` / `meta.source` provenance envelope. Research
group grows **16 → 18** endpoints (update the matrix + `openapi.yaml`). Mounted under
the existing `marketRateLimiter`.

### 4. Caching, quota, storage boundary

- **Storage boundary preserved (ADR-079):** macro observations are cached **in memory
  only**, never written to `asset_price_history`. Macro updates monthly/quarterly, so a
  long TTL is appropriate — `ttlForType('macro_series')` ≈ 6–24 h; `macro_search` ≈ 1 h.
- **Quota:** FRED added to `PROVIDER_LIMITS` as `{ perMinute: 120 }` (generous; mostly
  cache-served). DBnomics left **unmetered** (cache-governed, like Yahoo). Reuses the
  existing `provider_quota` table — no migration.

### 5. Chart Builder integration

- `BuilderSeries` gains optional `macro?: { provider; seriesId; title }`. When set, the
  series is fetched via `getMacroSeries(provider, seriesId, range)` keyed by
  `${provider}:${seriesId}` instead of `getResearchChart`.
- **One unified search box — no toggle, no second box.** The existing add-series
  `SymbolSearchBox` fires the ticker search **and** `searchMacro` together (both
  debounced 300 ms, both cached), concatenates the results into one dropdown, and renders
  a **kind badge** per row ("Economic" / "Index" / the instrument type). Picking a macro
  row adds a macro series; picking a ticker adds a normal series. The two fetches stay
  separate on the backend (instrument search races the capability map; macro fans out) —
  that difference is invisible to the user. If a broad term ever returns both kinds
  noisily, group under "Markets" / "Economic" subheaders; the badge alone is the v1
  default. (Cost: 2 extra keyless/cheap calls per debounced keystroke — negligible.)
- The per-series **provider dropdown is hidden/read-only** for macro rows (they are
  provider-pinned). Everything else — rebase-to-100, dual axis, line/area — works
  unchanged. **Rebase is especially useful** for overlaying a macro index on a price
  series. Technical indicators (RSI/MACD/Bollinger) remain available but are
  semantically odd on monthly macro data; left enabled (harmless), not surfaced as
  presets for macro.
- **Frequency alignment:** the builder already unions all series' timestamps. A monthly
  macro series plotted with daily equities simply has points on month boundaries and
  `null` between — acceptable for line rendering; no resampling in v1.

## Consequences

**Positive**

- CPI, inflation, policy/market rates, GDP, unemployment, money supply become chartable
  for the **US and euro area / Belgium** from two free sources, one keyless.
- Reuses the entire ADR-079/081 spine (cache, quota, keys, provenance, chart model,
  Chart Builder) — net-new surface is the macro adapters, two aggregator functions, two
  endpoints, and a kind badge in the existing unified search.
- No DB migration; no new persisted data; offline-first posture unchanged (cache/empty
  fallback like the rest of research).
- DBnomics transitively unlocks Eurostat, ECB, OECD (incl. CLI) and national stats
  without per-source adapters.

**Negative / trade-offs**

- Macro **breaks the uniform symbol model**: `macro_series` requires `(provider,
  series_id)`, not a bare symbol. This is a second exception to the race model (after
  fundamentals-merge) and must be documented so the asymmetry isn't mistaken for a bug.
- **No headline PMI** (licensed). Mitigated by surfacing OECD CLI + regional-Fed survey
  proxies and explaining the gap in UI copy.
- DBnomics can lag upstream releases by a short window vs. hitting Eurostat/ECB directly;
  acceptable for charting, and FRED covers the freshest US series.
- Series discovery is provider-flavored (FRED IDs vs DBnomics paths); the unified search
  hides most of this but power users will still see provider-native codes.

**Neutral**

- **SSRF:** both adapters call **fixed, hard-coded provider hosts**
  (`api.stlouisfed.org`, `api.db.nomics.world`) with only the query/series-id
  parameterized — no user-supplied base URL, so this carries none of the custom-provider
  SSRF surface (contrast the price-provider custom-URL guard). Standard input validation
  (Zod on `q`, `provider` enum, `series_id` shape, `range` enum) still applies.
- FRED key is optional: with no key, the macro surface degrades to **DBnomics-only**
  (still covers CPI/rates/GDP for US + EU) — graceful, like the keyed equity providers.

## Implementation outline

1. **Backend adapters** — `adapters/fredAdapter.js`, `adapters/dbnomicsAdapter.js`
   (`macroSearch` + `macroSeries`), reusing `httpClient.js`. Then `adapters/eurostatAdapter.js`
   built on a `parseJsonStat()` helper **extracted** from `belgianInflationService`
   (pure-function refactor; the inflation service's persist/rate-derivation path is left
   untouched per the firewall).
2. **Wiring** — register adapters in `providerRegistry.js`; add `fred` →`FRED_API_KEY` in
   `providerKeys.js` (`dbnomics`/`eurostat` keyless); add FRED to `PROVIDER_LIMITS`; add
   `macro_search`/`macro_series` to `DATA_TYPES` + `ttlForType`.
3. **Aggregator** — `searchMacro` (fan-out union) + `fetchMacroSeries` (provider-pinned).
4. **Routes** — `GET /api/research/macro/search`, `GET /api/research/macro/series`;
   update `openapi.yaml` + endpoint matrix (16→18).
5. **Frontend** — `MacroSeriesItem`/responses in `types/research.ts`; `searchMacro` +
   `getMacroSeries` in `lib/api/research.ts`; Chart Builder macro source + `macro`
   branch in series fetch/labeling; hide provider dropdown for macro rows.
6. **i18n** — en + nl keys (Economic source label, units/frequency, PMI-proxy note,
   empty states); `bun run validate-locales`.
7. **Docs** — `docs/integrations/price-providers.md` (new macro section), feature doc,
   matrix; bump frontmatter dates (via `vision-kb-updater`).
8. **Tests** — adapter normalization (FRED `"."` → skip; DBnomics period/value zip),
   aggregator fan-out + provider-pin routing, route validation.

Environment: document `FRED_API_KEY` in `docs/reference/environment-variables.md`
(optional; free at <https://fredaccount.stlouisfed.org/apikeys>). DBnomics needs none.

## Follow-up note — implementation reality (2026-06-17)

Verifying the live APIs during implementation refined the plan. Recorded here so
intent (this ADR) matches truth (the code):

- **DBnomics has no FRED provider** (`Could not find storage directory for provider 'FRED'`).
  FRED data is fetched only from FRED directly (keyed). DBnomics covers ECB / OECD /
  IMF / Eurostat-hosted series.
- **DBnomics `/v22/search` returns datasets, not chartable series** (cryptic dataset
  codes over 600k-series corpora). So DBnomics is **fetch-by-id only in v1**; open-ended
  discovery is FRED's job, and the keyless EU indicators are made discoverable via a
  **curated Eurostat catalog** (`macroCatalog.js`: BE/EA HICP, BE/EU unemployment).
  DBnomics carries no catalog entries in v1 (extensible).
- **ECB policy rates** are reachable via FRED (`ECBMRRFR`, `ECBDFR`); euro-area **market**
  rates via Eurostat datasets. Neither needs the ECB FX client (unchanged) nor a new SDMX
  client — matching the audit's "reach ECB macro through DBnomics/FRED, don't extend the
  FX client" conclusion.
- **`une_rt_m` publishes no euro-area (`EA*`) aggregate** under the chosen dimensions —
  only `EU27_2020` carries values, so the EU-wide unemployment series is curated instead
  of euro-area.
- **Range trimming anchors on the last available observation, not the wall clock**
  (`macroRange.trimToRange`). Macro data lags publication; anchoring on "now" produced
  empty charts for short ranges (caught in smoke testing).
- **`parseJsonStat` lives in `eurostatAdapter`**, modeled on belgianInflationService's
  proven JSON-stat handling but kept separate — the inflation service (which feeds
  real-return math) is **not** modified, honoring the firewall.
- **Packaging gotcha:** `FRED_API_KEY` had to be added to `PROVIDER_KEY_VARS` in
  `packaging/electron/main.js`. The `.app`'s `ensureEnv` canonicalises the repo-root
  `.env` to a known schema (postgres + allowlisted provider keys) and writes it back, so
  an unlisted key is **silently stripped on every launch** — observed as "the FRED key
  disappears from `.env` but the others survive". That list MUST stay in sync with
  `ENV_VAR_BY_PROVIDER` whenever a keyed provider is added.

## Related

- [[docs/adr/079-multi-provider-research-aggregation|ADR-079]] — research aggregation layer (capability map, quota governor, cache, storage boundary) this extends
- [[docs/adr/081-research-analytics-forecasting|ADR-081]] — Chart Builder + analytics this plugs macro series into
- [[docs/adr/080-layered-env-loading-shared-secrets|ADR-080]] — root `.env` secret loading (FRED key)
- [[docs/integrations/price-providers|Integration: Price Providers]] — provider infrastructure + research aggregation section
- [[docs/integrations/belgian-inflation|Integration: Belgian Inflation Service]] — source of the reusable Eurostat JSON-stat parser (and the persistence firewall)
- [[docs/integrations/currency-conversion|Integration: Currency Conversion]] — the ECB FX client that is **not** extended here
- [[docs/features/research|Research Feature]]
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]]
- [[docs/adr/index|All ADRs]]
