---
title: ADR-081 - Research Analytics & Forecasting Expansion (Pillars B/C/D Deepening)
type: adr
status: accepted
date: 2026-06-16
tags:
  - adr
  - research
  - pillar-c
  - pillar-b
  - pillar-d
  - monte-carlo
  - portfolio-projection
  - fundamentals-scorecard
  - chart-builder
  - technical-indicators
  - adr-079
  - adr-081
description: >
  Delivers the three previously deferred or partial Research pillars on top of ADR-079.
  Pillar C (portfolio forecast) ships for the first time via a Monte Carlo projection engine
  that decouples RISK estimation (aggregate portfolio daily-return history → realized covariance)
  from DRIFT estimation (per-holding weighted blend of historical mean and forward-looking provider
  inputs). Pillar B is deepened with a freeform custom Chart Builder (multi-symbol, dual-axis,
  candlesticks, overlays, oscillators, presets, localStorage layout persistence). Pillar D is
  deepened with extended fundamentals fields across all three fundamentals-capable adapters and a
  heuristic scorecard engine that grades 0-100 without penalizing missing fields.
---

# ADR-081: Research Analytics & Forecasting Expansion (Pillars B/C/D Deepening)

## Status

**Accepted** — Implemented 2026-06-16. Supersedes the *Deferred* designation of Pillar C in [[docs/adr/079-multi-provider-research-aggregation|ADR-079]]; ADR-079 otherwise remains in effect.

## Date

2026-06-16

## Context

[[docs/adr/079-multi-provider-research-aggregation|ADR-079]] shipped the research aggregation layer (Pillars A and B core, D partial) and explicitly deferred Pillar C (portfolio projection) as "orthogonal to this work." Three pillars were left in a partial or deferred state:

- **Pillar C — Portfolio value projection**: entirely deferred. ADR-079 noted the marginal tie-in of forward-looking analyst inputs as "a v2 enrichment, not core."
- **Pillar B — Comparative analysis**: shipped the compare page (rebased overlay, return/volatility/drawdown, Pearson correlation) but had no freeform per-symbol chart builder and no technical indicator overlays.
- **Pillar D — Screening / fundamentals**: shipped a selected-symbol fundamentals comparison tab but the underlying adapter normalization was shallow (core P/E, EPS, beta, marketCap, dividendYield only), and no heuristic evaluation layer existed — users saw raw numbers with no interpretation.

Two decisions from prior ADRs constrain the shape of this work:

1. **Storage boundary (ADR-079 §6 / ADR-065):** Research data for arbitrary symbols must never be persisted to `asset_price_history`. All projection outputs are on-demand, non-persisted, returned in the API response only.
2. **Shared portfolio math (ADR-073):** The `@vision/shared-utils/portfolio` package holds canonical cost-basis calculators. The projection engine must not re-implement portfolio math; it must source RISK and DRIFT from the existing snapshot and aggregator services.

### What makes Pillar C tractable now

ADR-079 noted that Pillar C "runs on the holding-window return history already in `asset_price_history` plus the `forecast/` engine." Two inputs now available that were not when ADR-079 was written:

1. `portfolioPerformanceSnapshotService.getSnapshots()` returns the full daily NAV history for the aggregate portfolio — the aggregate daily-return series embeds realized cross-holding covariance without requiring a covariance matrix computation.
2. The keyed provider adapters (Twelve Data, Finnhub, FMP, Alpha Vantage, shipped in ADR-079) now normalize analyst 12-month price targets and dividend yields — the forward-looking inputs needed for drift blending.

### Why heuristic scoring for Pillar D

Universe screening on free tiers is infeasible (ADR-079 §Consequences). A per-symbol scorecard converting normalized fundamentals to a grade is the highest-value Pillar D addition achievable within the free-tier constraint: it requires no universe scan, costs one fundamentals call per symbol (already cached 24 h), and gives users an interpreted signal rather than raw numbers.

## Decision

### Pillar C — Portfolio Projection Engine

Ship a **Monte Carlo projection of aggregate portfolio value** via two new backend modules:

**`services/research/projection/portfolioProjection.js`** — orchestration and public API.
**`services/research/projection/stats.js`** — statistical primitives (sample moments, PRNG, block-bootstrap resampling).

#### Drift / Risk decoupling

The key design choice is to decouple the two Monte Carlo parameters:

- **RISK** (volatility / fat-tail shape) is estimated from the **aggregate portfolio daily-return series** via `portfolioPerformanceSnapshotService.getSnapshots()`. Using the aggregate series embeds realized cross-holding covariance for free — no per-asset covariance matrix required. Returns are **flow-adjusted (Modified Dietz)**: each day's market return is `(Vₜ − Vₜ₋₁ − ΔInvestedₜ) / Vₜ₋₁`, i.e. the day's market P&L over start-of-day capital. This is critical — the raw `value` series rises on deposits as well as market moves, so using it directly would read every contribution as investment return and inflate both drift and projected value (and double-count future contributions, which are added on top during simulation). Days whose magnitude exceeds ±50% are treated as residual flow artifacts (e.g. a sell whose proceeds leave the tracked portfolio) and dropped, surfaced as `flowArtifactDays`. Flow-adjusted log-returns → sample mean (μ) and sample standard deviation (σ) over the full available history.

- **DRIFT** is a **per-holding weighted-blend** of:
  1. Historical mean log-return (from the aggregate series — a portfolio-level proxy).
  2. Forward-looking provider inputs: analyst 12-month price target implied annualized growth + dividend yield per holding, fetched via `researchAggregator.fundamentals()` for the top 25 holdings by current weight, capped at ±50% to exclude outlier targets. Controlled by `forwardBlend` ∈ [0, 1] (0 = pure historical, 1 = pure forward).

This decoupling means RISK always comes from observed data while DRIFT can optionally incorporate provider views, with full transparency via forward-input provenance in the response.

#### Two simulation methods

- **`parametric`** (default): Gaussian monthly steps — `return ~ N(μ_monthly, σ_monthly)` applied to the current portfolio value plus any `monthly_contribution`. Simple, fast, fully deterministic given seed.
- **`block_bootstrap`**: stationary Politis–Romano resample of de-meaned daily residuals, aggregated to monthly blocks. Preserves autocorrelation structure and fat tails from the actual return distribution without assuming Gaussianity.

Both simulators reuse the seeded PRNG from `services/calculations/forecast/prng.js` (the same deterministic generator used by the cash-flow forecast engine), ensuring reproducibility per seed.

#### Output shape

```
{
  bands: [ { month: "2026-07", p10, p25, p50, p75, p90 } ... ],   // per-month percentile bands
  summary: {
    projectedP10, projectedP25, projectedP50, projectedP75, projectedP90,  // terminal values
    expectedAnnualReturn,   // annualized μ used in simulation (median/geometric CAGR; the
                            //   simulated MEAN path runs higher by σ²/2 — this is the conservative figure)
    annualVolatility,       // annualized σ used in simulation
    probBelowInvested,      // P(terminal < net invested capital) — baseline is cost basis
                            //   (totals.totalInvested + future contributions), NOT current market value
    probTarget              // P(terminal >= target_value), omitted if no target
  },
  forwardInputs: [ { symbol, weight, targetGrowth, dividendYield, provider, skipped } ]
}
```

#### Storage boundary

No output is persisted. The endpoint is `POST /api/research/portfolio-forecast` (idempotent, body-driven, seed-deterministic); the caller re-submits with the same seed to reproduce. This preserves the ADR-079 / ADR-065 storage constraint.

### Pillar D — Fundamentals Scorecard

Ship a **pure heuristic scoring engine** at `services/research/fundamentalsScorecard.js`.

`scoreFundamentals(f)` → `{ score: 0-100, grade: A/B/C/D/F, evaluated: n, counts: {ok, caution, warn, risk}, flags: [...] }`

Each flag: `{ metric, category, better, value, severity: ok|caution|warn|risk, code: '<metric>.<severity>', reason, benchmark }`.

Design invariants:
- **Missing fields are skipped, never penalized.** A provider that does not expose `interestCoverage` does not drag the score down — the engine only evaluates fields that are present. This is essential because different providers expose different subsets.
- **Well-known thresholds only.** No machine-learning, no market-relative scoring. Thresholds are hardcoded industry heuristics (e.g. `currentRatio < 1.0 → risk`, `debtToEquity > 2.0 → risk`, `interestCoverage < 1.5 → risk`, negative FCF/margins, `payoutRatio > 1.0 → risk`, `pegRatio > 2.0 → caution`).
- **Grade mapping:** 80–100 → A, 60–79 → B, 40–59 → C, 20–39 → D, 0–19 → F.

#### Extended fundamentals fields

All three fundamentals-capable adapters (`yahooAdapter.js`, `finnhubAdapter.js`, `fmpAdapter.js`) now normalize additional fields (each `undefined` when the provider does not expose it):

`sector`, `pegRatio`, `payoutRatio`, `grossMargin`, `operatingMargin`, `revenueGrowth`, `earningsGrowth`, `debtToEquity`, `currentRatio`, `quickRatio`, `interestCoverage`, `freeCashFlow`, `fcfYield`

Adapter-specific notes:
- `yahooAdapter`: added `assetProfile` module to the `quoteSummary` call; `debtToEquity` normalized from percentage to ratio (÷100).
- `finnhubAdapter`: switched to `metric=all`; percentage fields normalized to fractions.
- `fmpAdapter`: added best-effort `key-metrics-ttm` + `financial-growth` calls (tier-gated; graceful fallback when unavailable).
- Twelve Data and Alpha Vantage have no `fundamentals()` method; unchanged.

### Pillar B — Freeform Chart Builder

Ship `ChartBuilderPage.tsx` at `/research/charts` (accessible from sidebar Analysis group and CommandPalette).

Features:
- Multiple symbols, each independently configurable: chart type (line / area / candlestick), axis assignment (L/R), provider override.
- Technical indicator overlays: SMA, EMA, Bollinger Bands (pure client-side computation via `lib/research/indicators.ts` — zero extra provider quota).
- Oscillator panel: RSI and MACD (also client-side).
- Log scale toggle and rebase-to-100 toggle.
- Popular presets: Price+Volume, SMA 50/200, Bollinger, RSI, MACD, Rebased.
- Layout persistence in `localStorage`.

Chart primitives added: `components/charts/ComposedChart.tsx` (dual-axis, multi-type including candlesticks) and `CandlestickChart.tsx` wrapper.

#### `provider` override on `GET /api/research/chart`

A new optional `provider` query parameter pins a preferred provider to the front of the chart capability chain for that request. The aggregator still falls through to the next provider if the pinned one is unkeyed or failing — the override is a preference, not a hard requirement.

### New Routes

Two new endpoints added to `apps/node-backend/src/routes/research.js`:

**`GET /api/research/scorecard?symbol=&asset_class=`**
- Fetches fundamentals via the aggregator (24 h cache hit where warm), passes the result to `scoreFundamentals`, returns `{ symbol, fundamentals, scorecard, meta }`. When no provider can supply fundamentals, returns `{ unavailable: true }` with 200.

**`POST /api/research/portfolio-forecast`**
- Body: `{ horizon_months, monthly_contribution?, paths?, forward_blend?, method?, target_value?, currency?, seed? }`.
- Returns projection bands, summary, and forward-input provenance.
- 400 on validation failure; 422 if insufficient snapshot history (< 60 days).

`openapi.yaml` is already updated to reflect both operations (192 total operations).

## Consequences

### Positive

1. **Pillar C fully landed.** Portfolio projection was the most-requested deferred item from ADR-079. Users can now model long-horizon portfolio scenarios with confidence-band visualizations.
2. **Drift/risk decoupling is transparent.** `forwardBlend=0` gives a pure-historical projection; `forwardBlend=1` gives a pure-analyst-consensus view. The `forwardInputs` provenance array tells users exactly which provider supplied each symbol's forward inputs.
3. **Scorecard degrades gracefully.** The skip-not-penalize invariant means the scorecard is valid even with Yahoo as the sole provider (which exposes a narrower fundamentals set than FMP/Finnhub). The grade reflects what *is* known, not what's missing.
4. **Client-side indicator math.** All technical overlay computation (`lib/research/indicators.ts`) runs in the browser — no new provider calls, no quota spend.
5. **Provider override on chart.** `?provider=` lets the frontend offer a per-chart provider selector (e.g. "use Finnhub for this symbol") without bypassing the fallback safety net.

### Negative / Tradeoffs

1. **Forward drift depends on provider availability.** Analyst 12-month targets are only available when FMP or Finnhub keys are configured. When neither is keyed, `forwardBlend` > 0 silently falls back to historical-only drift (labeled as such in `forwardInputs[].skipped`). Users must understand that "blended" ≠ "has analyst data" unless their provider keys are configured.
2. **Scorecard `reason` strings are English-only.** The scorecard's structured fields (`metric`, `code`, `severity`, `grade`, `benchmark`) are fully localized. The human-readable `reason` sentence strings are English only in this release. This is a known gap — tracked as a follow-up i18n task.
3. **Aggregate-return RISK estimation.** Using the aggregate NAV series for RISK means the simulation reflects the *portfolio's* historical volatility, not a bottom-up per-asset covariance. This is appropriate for projecting aggregate portfolio value (the use case) but would be wrong for projecting individual holding values. The endpoint is intentionally named `/portfolio-forecast`, not `/asset-forecast`.
4. **Block-bootstrap requires ≥ 60 days of snapshot history.** Portfolios with fewer snapshots are rejected with 422 and directed to the parametric method.
5. **192 openapi.yaml operations.** The matrix and `check-endpoint-matrix.js` must stay synchronized; the script enforces this in CI.

### Known i18n gap (follow-up)

Scorecard flag `reason` sentences render in English regardless of the user's locale. All other scorecard fields (metric names, severity labels, grade, benchmark values) are localized. The English-only `reason` strings are acceptable for initial release and should be addressed in a subsequent i18n pass.

## Related

- [[docs/adr/079-multi-provider-research-aggregation|ADR-079]] — the research aggregation foundation this ADR builds upon; Pillar C deferred designation superseded here
- [[docs/adr/073-shared-portfolio-math-package|ADR-073]] — shared cost-basis calculators in `@vision/shared-utils/portfolio`; projection engine sources portfolio totals from the same service layer
- [[docs/adr/065-daily-gap-fill-dense-asset-history|ADR-065]] — storage boundary (held-asset only); preserved by this ADR
- [[docs/features/research|Research Feature]] — feature spec tracking all four pillar statuses
- [[docs/api/research|Research API]] — endpoint reference including the two new operations
- [[docs/adr/index|All ADRs]]
