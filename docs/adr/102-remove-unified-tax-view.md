---
title: ADR-102 Remove the Unified Tax View
type: adr
date: 2026-06-19
tags: [adr, tax, cross-workspace, marital-quotient, removal, supersession, adr-098]
description: Retires the Unified Tax view shipped in ADR-098. The standalone cross-workspace tax surface (owner-allocated earned income + dividends + realized gains for the marital quotient) had no clear use case beyond what the two existing tax pages already cover, so it is removed end-to-end. Cash-aware rebalancing and the net-worth/FI projection cone from ADR-098 are unaffected.
aliases: [remove unified tax, retire unified tax view, unified tax removal]
---

# ADR-102: Remove the Unified Tax View

## Status
Accepted. Supersedes the **Unified Tax view** portion of [[docs/adr/098-cross-workspace-features|ADR-098]]
only. The other two ADR-098 surfaces — cash-aware rebalancing (`/portfolio/rebalance`) and the
net-worth/FI projection core (`projectNetWorth`) — remain in force and untouched.

## Date
2026-06-19

## Context
ADR-098 shipped a Unified Tax view (`/tax/unified`) that composed earned income (budgeting tax
profile) + dividend/interest income + realized gains (portfolio), each owner-allocated
(me / partner / joint → 50/50) to feed the Belgian marital quotient. It was always an *indicative
view*, not a tax re-derivation: it summed figures and split them by account owner without running
the PIT engine, and realized gains were valued at the holding's current weighted-average cost basis
rather than the basis at sale time.

In review the surface did not earn its place:

- Its only distinctive capability over the two existing tax pages is the **owner-split** axis, which
  is meaningful solely for married/legally-cohabiting couples filing jointly (`filingStatus ===
  'married_joint'`). For single filers it adds nothing.
- The two established views already answer concrete questions with real numbers: `/tax`
  (the Belgian PIT engine — brackets, regions, deductions, the marital quotient itself) and
  `/portfolio/tax` (recorded investment taxes/fees + per-investment adjustments).
- The unified view's realized-gains figure is less accurate than either, and being a non-authoritative
  roll-up it risked being mistaken for a filing-grade number.

Rather than gate it behind a couples-only flag and invest further in a surface with a narrow,
unclear payoff, we remove it. ADRs are append-only, so this is recorded as a new superseding decision.

## Decision
Remove the Unified Tax view end-to-end:

- **Frontend:** delete `pages/UnifiedTaxPage.tsx`; drop the `/tax/unified` route (`App.tsx`), the
  route preloader (`lib/routePreload.ts`), and the Budgeting → Analysis nav entry + now-unused
  `Layers` icon (`components/layout/AppSidebar.tsx`). Remove `getUnifiedTax`, `UnifiedTaxRequest`,
  and `UnifiedTaxResponse` from the cross-workspace API client and the `lib/api.ts` re-exports.
- **Backend:** remove `GET /api/cross-workspace/unified-tax` (`routes/crossWorkspace.js`), the pure
  cores `unifiedTax` + `allocateByOwner` (`services/crossWorkspaceAnalytics.js`), and the DB
  assembler `assembleUnifiedTaxItems` + its `normalizeOwner` helper
  (`services/crossWorkspaceDataService.js`). `rebalanceDeployment`, `projectNetWorth`, and
  `assembleRebalanceInputs` are kept.
- **Contracts/i18n/docs:** drop the path from `openapi.yaml` (211 → 210 operations) and regenerate
  `types/generated.ts`; remove the `unifiedTax.*` and `nav.unifiedTax` keys from `i18n/source/{en,nl}.json`
  and regenerate locales; update `docs/reference/api-endpoint-matrix.md` (Cross-Workspace group 2 → 1).
- Remove the corresponding unit tests in `crossWorkspaceAnalytics.test.js` and
  `crossWorkspaceDataService.test.js`.

## Consequences
**Positive**
- One fewer non-authoritative tax surface to maintain and explain. Tax stays in the two pages users
  already understand.
- Smaller API surface; the shared `crossWorkspaceAnalytics`/`crossWorkspaceDataService` modules now
  carry only the rebalancing path.

**Negative / cost**
- Couples who want a single owner-split income+gains roll-up for the marital quotient no longer have
  a one-glance view; they read `/tax` and `/portfolio/tax` separately. Given the view was indicative
  and narrowly applicable, this is an acceptable loss.

**Neutral**
- No data migration: the view was non-persisted and composed existing records. Nothing stored is
  affected. The feature can be reintroduced from ADR-098 + git history if a concrete couples use case
  emerges (e.g. gated behind `filingStatus === 'married_joint'`).

## Related
- [[docs/adr/098-cross-workspace-features|ADR-098]] — original cross-workspace features (this ADR supersedes its Unified Tax part only)
- [[docs/adr/index|All ADRs]]
