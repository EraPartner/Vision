---
title: "ADR-216: Domain calculations run on the server; the browser only previews input"
type: adr
status: Accepted
date: 2026-10-19
tags: [adr, architecture, frontend, backend, calculations, money, fx, portfolio, planned, forecast, server-computed]
description: "Accepted 2026-10-19. Financial and domain figures shown to the user (totals, FX conversion, cost basis, gains, recurrence-based amounts, forecast weights) are computed by the backend and read by the browser. The browser may compute only previews of unsaved input and pure presentation. Applied to planned totals (new GET /api/planned-transactions/totals), forecast ensemble weights (diagnostics.ensemble_weights) and archived portfolio holdings (portfolio-summary active=false)."
aliases: [adr-216, server-owned calculations, server-computed figures]
---

# ADR-216: Domain calculations run on the server; the browser only previews input

## Status

Accepted

## Date

2026-10-19

## Context

[[docs/adr/008-performance-page-server-computed-response|ADR-008]] moved performance figures to
the server and [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044]] made the
portfolio summary the single source of truth for active totals.
[[docs/adr/073-shared-portfolio-math-package|ADR-073]] reduced drift between the remaining browser
and server copies by sharing the portfolio math package, but kept two call sites. Several browser
copies of domain calculations remained and had drifted from the server:

- The Home hero summed up to 200 raw planned rows from today to month end. Each recurring rule
  counted once whatever its cadence, and amounts in different currencies were added without
  conversion.
- The planned page's "Est. monthly" used hard-coded multipliers (weekly 4.33, biweekly 2.17,
  daily 30) that differed from the recurrence grammar the forecast uses.
- The forecast diagnostics sheet recomputed the ensemble weights from backtest rows with its own
  copy of `computeWeights`, labelled as a preview. It could differ from the weights the ensemble
  applied.
- Archived portfolio holdings were rebuilt in the browser at today's FX rate, while active
  holdings used dated FX and the configured cost-basis method on the server. A browser EUR-pool
  replay (`useFxAwarePnl`) produced the FX-aware gains.

Each copy is a second implementation of a financial rule, and it is tested less thoroughly than
the server path.

## Decision

1. Figures shown to the user that depend on domain rules are computed by the backend: money
   totals, FX conversion, cost basis and gains, recurrence expansion and cadence factors, and
   forecast weights. The browser reads them from an endpoint.
2. The browser may compute previews of input the user has not saved yet, and pure presentation
   (formatting, sorting, percentages of server values, chart scaling).
3. When a figure is missing from the API, add it to an endpoint, `openapi.yaml` and the shared
   contract rather than computing it in the browser.

Applied in the same change:

- New `GET /api/planned-transactions/totals?currency=` (`plannedTotalsService.ts`) returns
  `rest_of_month` (every occurrence to month end, bounded by end date and maximum occurrences)
  and `monthly_equivalent` (factor from `monthlyOccurrenceFactor` in the shared recurrence
  grammar). Both use the latest stored exchange rates and count rows without a rate. See
  [[docs/api/plannedTransactions#GET /api/planned-transactions/totals]].
- Forecast responses carry `diagnostics.ensemble_weights` from `ensemble.effectiveWeights`;
  the browser copy of `computeWeights` was removed. See [[docs/features/cash-flow-forecast]].
- Archived holdings come from `GET /api/info/portfolio-summary?active=false`. The frontend
  deleted `usePortfolioCalculations.ts`, `localPortfolioCurrency.ts` and `useFxAwarePnl.ts`;
  `holdingPnl.ts` reads the server gains. See [[docs/api/portfolio-summary]].

This ADR does not rewrite ADR-073: `@vision/shared-utils/portfolio` stays the backend's portfolio
math, but the web summaries no longer call it. The `archivedInKindIncome` projection from
[[docs/adr/188-proved-in-kind-income-recognition|ADR-188]] stays in the response, but the web
portfolio no longer needs it: archived holdings, including `totalInKindIncome`, come from the
canonical summaries. The Belgian tax dashboard still reads `archivedPresentation`.

## Consequences

- One implementation per financial rule. Boundary tests at the API and PostgreSQL level cover
  it ([[docs/adr/215-behaviour-boundary-tests|ADR-215]]), for example
  `apps/node-backend/tests/plannedTotals.db.test.ts`.
- Archived holdings now show dated-FX gains with the configured cost-basis method. Their figures
  can differ from the earlier today's-FX display, and from the Belgian tax dashboard, which still
  uses `archivedPresentation`.
- The planned hero and "Est. monthly" figures change for users with weekly, biweekly, daily or
  multi-currency recurring rows, and for months where a recurring row occurs more than once.
- Screens wait for an extra request (planned totals, archived summaries) instead of rendering
  browser results immediately.
- New UI work must check for a server figure before adding arithmetic in a component.

## Related

- [[docs/adr/008-performance-page-server-computed-response|ADR-008]]
- [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044]]
- [[docs/adr/073-shared-portfolio-math-package|ADR-073]]
- [[docs/adr/188-proved-in-kind-income-recognition|ADR-188]]
- [[docs/adr/215-behaviour-boundary-tests|ADR-215]]
- [[docs/features/plannedTransactions]]
- [[docs/features/portfolio]]
- [[docs/adr/index|All ADRs]]
