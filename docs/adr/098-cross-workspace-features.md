---
title: ADR-098 Cross-Workspace Features — NW Projection, Cash-Aware Rebalancing, Unified Tax
type: adr
date: 2026-06-19
tags: [adr, net-worth, projection, rebalancing, tax, marital-quotient, cross-workspace, adr-081, adr-085, adr-089, saved-plans, rebalance-plans]
description: Three features that compose all three workspaces — a net-worth/FI projection cone (cash-flow forecast + holdings + research forecast), cash-aware rebalancing (research targets + actual weights + available budgeting cash), and a unified tax view (earned income + realized gains + dividend income, owner-allocated for the marital quotient).
aliases: [net worth projection, FI projection, cash-aware rebalancing, unified tax view]
---

# ADR-098: Cross-Workspace Features

## Status
Accepted — partially implemented 2026-06-19. Cash-aware rebalancing is wired end-to-end
(routes + pages + nav). The unified tax view was wired then **removed** by ADR-102 (see the
superseded note below). The net-worth/FI projection cone remains a pure, unwired core
(`projectNetWorth`). See the 2026-06-19 implementation note below.

**Superseded in part (2026-06-19):** the **Unified Tax view** described below was removed end-to-end
by [[docs/adr/102-remove-unified-tax-view|ADR-102]] (no clear use case beyond the two existing tax
pages). Cash-aware rebalancing and `projectNetWorth` are unaffected and remain in force.

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

## Implementation note (2026-06-19) — Custom saved plans + cash cap for rebalancing

Extends the 2026-06-19 rebalancing implementation above. No new API operations were added; all changes
use existing infrastructure.

### What changed

**Custom target allocations (UI-exposed `targetWeights`)**

`RebalancePage.tsx` now renders a three-mode source picker:
- **Presets** — the three original hard-coded plans (`sixty_forty`, `all_weather`, `three_fund`)
- **Saved plans** — user-named custom allocations loaded from the `rebalance_plans` settings key
- **Custom (new)** — an editable per-sleeve target-% table; weights need not sum to 100% because
  the existing `normalizeWeights` function on the server normalises them before deployment math runs

The custom allocation is sent as the existing `targetWeights` field on `POST /api/cross-workspace/rebalance`
— the route accepted it from day one but the UI never surfaced it.

Sleeve vocabulary matches `crossWorkspaceDataService.js` `SLEEVE_ROLLUP`:
`stocks`, `intl_stocks`, `bonds`, `gold`, `commodities`, `crypto`, `real_estate`, `savings`.

**Optional cash cap (UI-exposed `availableCash` override)**

A numeric input lets the user cap how much spendable cash to deploy (blank = deploy all). The value
is clamped to `[0, availableCash]` client-side before being sent as the existing `availableCash`
override parameter on the route.

**Saved named plans (`rebalance_plans` settings key)**

Custom allocations can be named, saved, updated, and deleted. They persist across sessions without
a DB migration: the backend stores them as a JSON array under the new key `rebalance_plans` in the
existing key-value settings store (`GET/PUT /api/settings/:key`) — the same mechanism `backup_settings`
uses.

Backend validation (`apps/node-backend/src/routes/settings.js`):
- Key default: `[]`
- Max 50 plans per array
- Each plan: `{ id: string, name: string (1–80 chars), targetWeights: Record<string, number≥0>, cashCap?: number≥0 }`
- Enforced by a new `assertRebalancePlansValue` helper and a `validateSettingValue` branch

Frontend hook: `apps/frontend/src/hooks/useRebalancePlans.ts` — React Query wrapper over
`getSetting` / `saveSetting('rebalance_plans')`.

Frontend type: `RebalancePlan` interface in `apps/frontend/src/lib/api/crossWorkspace.ts`.

**i18n** — new keys under `rebalance.*` namespace (en + nl validated). Renamed
`rebalance.plan` → `rebalance.deploymentPlan`; added `rebalance.plan.*` (saved-plan management),
`rebalance.editor.*` (custom editor), `rebalance.sleeve.*` (sleeve labels),
`rebalance.customNew`, `rebalance.presets`, `rebalance.savedPlans`.

**Tests** — `apps/node-backend/tests/settingsStorage.test.js` has new cases covering
`rebalance_plans` validation and the `[]` default.

### Endpoint matrix

No rows changed. `POST /api/cross-workspace/rebalance` and `GET/PUT /api/settings/:key` already existed;
the only change is that `rebalance_plans` is now a recognized settings key with server-side validation.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/093-net-worth-sum-of-accounts|ADR-093: Net worth]]
- [[docs/adr/081-research-analytics-forecasting|ADR-081: Forecast engine]]
- [[docs/adr/085-belgian-tax-point-in-time-fx|ADR-085: Point-in-time FX]]
- [[docs/adr/089-account-typed-model|ADR-089: Owner dimension + liquidity flags]]
