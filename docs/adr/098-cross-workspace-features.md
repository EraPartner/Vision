---
title: ADR-098 Cross-Workspace Features — NW Projection, Cash-Aware Rebalancing, Unified Tax
type: adr
date: 2026-06-18
tags: [adr, net-worth, projection, rebalancing, tax, marital-quotient, cross-workspace, adr-081, adr-085, adr-089]
description: Three features that compose all three workspaces — a net-worth/FI projection cone (cash-flow forecast + holdings + research forecast), cash-aware rebalancing (research targets + actual weights + available budgeting cash), and a unified tax view (earned income + realized gains + dividend income, owner-allocated for the marital quotient).
aliases: [net worth projection, FI projection, cash-aware rebalancing, unified tax view]
---

# ADR-098: Cross-Workspace Features

## Status
Accepted — partially implemented 2026-06-19. Cash-aware rebalancing and the unified tax view are
wired end-to-end (routes + pages + nav); the net-worth/FI projection cone remains a pure, unwired
core (`projectNetWorth`). See the 2026-06-19 implementation note below.

## Date
2026-06-18 (proposed) · 2026-06-19 (rebalancing + unified tax implemented)

## Context

The account spine (ADR-088…097) now lets the three workspaces be composed. Three features sit on
top, each pulling from Budgeting + Portfolio + Research at once.

## Decision

Three composed surfaces, each a pure computation over inputs the workspaces already produce:

- **Net-worth / FI projection.** Compose current net worth (Σ accounts, ADR-093) + the cash-flow
  forecast contribution rate (budgeting) + a return assumption (research forecast / ADR-081) into
  a projected net-worth **cone** (median + P10/P90 bands) over N months. The median path is exact
  compounding (`balance·(1+r/12) + contribution` each month); bands widen parametrically with
  volatility·√t. Non-persisted, like ADR-081.
- **Cash-aware rebalancing.** Given target weights (research), actual sleeve values (portfolio),
  and **available budgeting cash** (Σ spendable/liquid account balances — ADR-089 flags), compute
  how much cash to deploy into each **underweight** sleeve to move toward target without selling.
  Deploys exactly the available cash, weighted by shortfall.
- **Unified tax view.** One surface aggregating earned income (budgeting) + realized gains
  (portfolio) + dividend income (the cash sleeve), each converted at point-in-time FX (ADR-085)
  and **allocated by the account owner** (ADR-089: me / partner / joint → 50/50) to feed the
  Belgian marital quotient.

## Consequences

**Positive**
- The payoff of the account spine: net worth you can project, rebalancing that knows your cash,
  and a tax view that spans income + gains + dividends with owner allocation.
- Pure cores reuse existing engines (ADR-081 forecast, ADR-085 FX, ADR-093 net worth).

**Negative / cost**
- Projection bands are assumptions, not guarantees — must be presented as a cone, never a single
  number.
- Unified tax is a *view*; it composes the existing Belgian tax calculations, not a re-derivation.

**Risks / mitigations**
- *Over-precise projection* → always show P10–P90 bands + the assumptions; non-persisted.
- *Rebalancing suggests selling* → cash-aware = deploy cash into underweights only; never proposes
  sells (a separate concern).
- *Owner mis-allocation* → joint = 50/50 by rule; default owner `me` so single filers are
  unaffected.

## Implementation note (2026-06-19)

Two of the three surfaces are now reachable in the app; the third stays a tested pure core.

- **Cash-aware rebalancing** — `POST /api/cross-workspace/rebalance` (`routes/crossWorkspace.js`)
  composes actual sleeve values (portfolio summary grouped by asset class) + available cash
  (Σ `spendable` account ledger balances, FX-converted, in `services/crossWorkspaceDataService.js`)
  and runs the pure `rebalanceDeployment`. UI: `/portfolio/rebalance` (`pages/portfolio/RebalancePage.tsx`),
  nav under Portfolio → Analysis.
- **Unified tax view** — `GET /api/cross-workspace/unified-tax?year=` composes the client-supplied
  earned income (tax-profile gross) with owner-allocated portfolio dividends/interest + realized
  gains for the year, via the pure `unifiedTax`. Realized gains are **indicative** — each in-year
  sale is valued at the holding's current weighted-average cost basis, not the basis at sale time
  (consistent with this ADR: a composed *view*, not a tax re-derivation). UI: `/tax/unified`
  (`pages/UnifiedTaxPage.tsx`), nav under Budgeting → Analysis.
- **Net-worth / FI projection cone** — `projectNetWorth` remains pure + unit-tested but is not yet
  wired to a route/page. Follow-up.

Tested by `crossWorkspaceAnalytics.test.js` (cores) + `crossWorkspaceDataService.test.js` (assembly,
mocked DB/FX). Endpoints registered in `openapi.yaml` + the endpoint matrix (count 209 → 211).

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/093-net-worth-sum-of-accounts|ADR-093: Net worth]]
- [[docs/adr/081-research-analytics-forecasting|ADR-081: Forecast engine]]
- [[docs/adr/085-belgian-tax-point-in-time-fx|ADR-085: Point-in-time FX]]
- [[docs/adr/089-account-typed-model|ADR-089: Owner dimension + liquidity flags]]
