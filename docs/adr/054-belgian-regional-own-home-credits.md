---
title: ADR-054 - Belgian Regional Own-Home Tax Credits
type: adr
status: accepted
date: 2026-05-11
tags: [adr, belgian-tax, own-home-credit, woonbonus, cheque-habitat, regional-tax]
description: Implements regional own-home tax credits (Flemish geïntegreerde woonbonus pre-2020 and Walloon chèque habitat post-2016) with mortgage tracking (interest, capital, region, start year, primary residence).
---

# ADR-054: Belgian Regional Own-Home Tax Credits

## Status
Accepted

## Date
2026-05-11

## Context

Belgium offers regional tax credits for mortgage interest on primary residences, varying by region and loan start year:

1. **Flemish `geïntegreerde woonbonus`** (pre-2020): Integrated credit covering mortgage interest and capital, with a base cap, first-10-year supplement, and 3+-child supplement. Applied at 40% rate.

2. **Walloon `chèque habitat`** (post-2016, first 10 years only): Fixed annual amount plus per-child supplement. [Note: Actual scheme has income-based phaseouts and decreasing years 11–20; simplified here.]

3. **Brussels**: Various schemes (stamp-duty rebate, others); not fully modeled.

4. **Post-2020 Flanders**: No successor regime; capital owners only.

Previously, these credits were listed as "not modeled" in the feature limitations. User feedback and tax filing requirements show they should be included for accuracy.

## Decision

1. **Add mortgage tracking to `BelgianTaxProfile`**:
   - `mortgageInterestPaid` (existing, repurposed from deductions)
   - `mortgageCapitalRepaid` (new)
   - `mortgageStartYear` (new)
   - `mortgageRegion` (new, allows override if mortgage is in different region than residence)
   - `mortgageIsPrimaryResidence` (new)

2. **Add own-home credit constants to `BelgianTaxYearTable`**:
   - Flemish: `flemishWoonbonusBaseCap`, `flemishWoonbonusRate` (40%), `flemishWoonbonusExtraFirst10y`, `flemishWoonbonusExtraChildren`
   - Walloon: `walloonChequeHabitatBase`, `walloonChequeHabitatChildSupplement`

3. **Implement `resolveMortgageRegime()`** to determine applicability:
   - Flemish woonbonus: region = flanders, startYear ∈ [1, 2019]
   - Walloon chèque habitat: region = wallonia, startYear ≥ 2016
   - Default: regime = 'none'

4. **Implement `computeOwnHomeCredit()`**:
   - Flemish: `min(interest + capital, base_cap [+ first-10y] [+ 3+ children]) × 40%`
   - Walloon: `base [+ €125 × dependentChildren]` (first 10 years only)
   - Both ignore years 11+ (simplified; actual phaseout not implemented)

5. **Output new fields**: `ownHomeCreditRegime` and `ownHomeCredit` in `BelgianTaxCalculation`.

6. **UI changes**:
   - New "Own-Home / Mortgage" section in `IncomeStep` (profile dialog) with region, start year, interest, capital, primary residence toggle.
   - Move `mortgageInterestPaid` from `ExemptionsStep` to `IncomeStep` for logical grouping.

## Consequences

### Positive
- **Compliance:** Tax calculations include significant tax credits that users should claim.
- **Transparency:** Own-home credit is explicitly calculated and visible in tax results.
- **Regional accuracy:** Differentiates between Flanders, Wallonia, and Brussels regimes.
- **Extensibility:** Constants are year-indexed; new regimes or rates can be added without code changes.

### Negative
- **Simplified Walloon model:** Phaseout and years 11–20 decreasing tail not implemented; users with loans >10 years will see inaccurate credits.
- **No marital-quotient phaseout:** Joint filers may have different credit eligibility; not modeled.
- **UI complexity:** TaxProfileDialog now has 5 steps instead of 4; mortgage section adds several fields.

### Neutral
- No database schema changes (mortgage data stored in JSON profile).
- Backward-compatible; old profiles without mortgage data default to regime = 'none'.

## Related
- [[docs/features/belgian-tax|Feature: Belgian Tax]] — Updated feature doc with own-home credit overview
- [[docs/features/belgian-tax#limitations--not-modeled|Limitations]] — Notes on phaseouts, years 11+, Brussels, post-2020 Flanders
- [[apps/frontend/src/lib/belgianTax/pit.ts|pit.ts]] — `resolveMortgageRegime()` and `computeOwnHomeCredit()`
- [[apps/frontend/src/lib/belgianTax/constants.ts|constants.ts]] — Own-home credit fields in `BelgianTaxYearTable`
- [[apps/frontend/src/lib/belgianTax/types.ts|types.ts]] — `MortgageCreditRegime` type and profile fields
- [[apps/frontend/src/components/tax/profile-steps/IncomeStep.tsx|IncomeStep.tsx]] — Mortgage UI
