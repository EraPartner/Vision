---
title: ADR-073 Shared Portfolio Math in @vision/shared-utils
type: adr
status: Accepted
date: 2026-06-11
tags: [adr, portfolio, money, architecture, shared-utils, frontend, backend, june-2026]
description: Move cost-basis accounting (weighted-avg/FIFO/LIFO), interest accrual, and the per-investment summary core into @vision/shared-utils/portfolio so backend and frontend import one implementation instead of hand-mirroring; wires the cost_basis_method setting end-to-end and adds client-side FX conversion
aliases: [adr-073, shared portfolio math, buildInvestmentSummaryCore]
---

# ADR-073: Shared Portfolio Math in @vision/shared-utils

## Status
Accepted

## Date
2026-06-11

## Context

The per-investment summary math existed twice, held in sync only by "mirrors the
backend" comments:

- `apps/node-backend/src/utils/portfolioMath.js` + `services/portfolio/portfolioSummaryService.js`
- `apps/frontend/src/hooks/portfolio/usePortfolioCalculations.ts` + `usePortfolioSummaries.ts`

Audit Round 7 (2026-06-11) found three live drift instances in that pair:

1. **R7-6** — frontend used `totalInvested.abs()` where the backend deliberately
   clamps at 0 (net-negative invested flipped to a positive figure client-side).
2. **R7-7** — frontend did no FX conversion at all while the backend pre-converts
   every monetary field; multi-currency portfolios summed USD+EUR 1:1 in
   client-computed cards and totals.
3. **R7-5** — the `cost_basis_method` setting (FIFO/LIFO/weighted-avg) was a dead
   toggle: complete FIFO/LIFO implementations existed with zero callers; both
   sides hard-called weighted-average.

The June Round-6 audit had already caught the same class (frontend missing
splits/ROC handling). `lib/money.js` solved the identical problem for rounding
modes by moving into `@vision/shared-utils` — this ADR extends that precedent to
portfolio math.

## Decision

1. **New shared module `@vision/shared-utils/portfolio`** (pure functions, no IO,
   no clock reads, no timezone dependency):
   - `calculateCostBasis` / `calculateCostBasisFIFO` / `calculateCostBasisLIFO` /
     `calculateCostBasisByMethod`
   - `calculateAccruedInterest(txns, principal, ratePct, todayYmd)` — "today" is
     an input, counted with pure-calendar `daysBetweenYmd`
   - `projectedAnnualInterest`
   - `buildInvestmentSummaryCore(inv, txns, { costBasisMethod, todayYmd })` — the
     full per-investment summary math (tx aggregation, asset-class branches,
     gainLoss/double-count rules, 0-clamp on totalInvested), returning Decimals
     in the investment's native currency.
2. **Both apps import the shared module.** `utils/portfolioMath.js` re-exports
   the calculators (call sites unchanged) and keeps only backend-specific pieces
   (toYmd, calendarDaysBetween, snapshot metrics/heatmap, spike sanitizers).
   The frontend hooks are thin wrappers: browser-local `todayYmd()` plus the
   `InvestmentSummary` shape.
3. **Callers own the edges:** FX-rate acquisition, conversion, rounding-on-emit,
   and response shaping stay in `portfolioSummaryService` (server) and
   `usePortfolioSummaries` (client). The client gets rates from a new
   `useExchangeRates` hook (`/api/info/exchange-rates?db_only=true`,
   `rate(A)/rate(B)` multiplier — same model as the backend conversion service)
   and falls back to multiplier 1 while rates are loading.
4. **`cost_basis_method` is wired end-to-end:** the server reads it from
   `user_settings` per request (invalid/missing → weighted_avg), the client from
   `appSettings.costBasisMethod`; both pass it into the shared core.
5. **Frontend summaries are now expressed in the app's display currency** with
   `currency` = target and the native code preserved as `originalCurrency`,
   mirroring the backend response shape.

## Consequences

- The drift class is structurally closed: there is one implementation of the
  summary math. A change to gainLoss rules or cost-basis accounting lands on
  both sides by construction.
- Selecting FIFO/LIFO in Settings now changes realized gains and remaining cost
  basis everywhere (backend summary endpoint, client-computed pages), covered by
  a backend test asserting fifo ≠ weighted_avg on a two-lot sell.
- Frontend portfolio cards converge to backend values for multi-currency
  portfolios once rates load; until then they degrade to unconverted values
  (previous behavior) rather than blanking.
- The hand-mirroring convention ("mirrors the backend" comments) is superseded
  for portfolio math. New shared pure math should start in
  `@vision/shared-utils`, not in an app.

## Related

- [[docs/adr/074-fx-attribution-historical-rates|ADR-074: FX attribution with purchase-date rates]] — extends the converted track introduced here; `buildInvestmentSummaryCore` gains `opts.fxMultiplierNow` and returns a `converted` block; calculators accept per-txn `fxMultiplier` and `defaultFxMultiplier`
- [[docs/adr/060-may-2026-monetary-precision-and-deduplication-audit]] — shared money helpers precedent
- Audit Round 7 findings R7-5 / R7-6 / R7-7 / R7-16 (TODO.md, docs/sessions/2026-06-11-audit-round-7)
