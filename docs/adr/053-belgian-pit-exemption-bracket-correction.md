---
title: ADR-053 - Belgian PIT Exemption Bracket Correction
type: adr
status: accepted
date: 2026-05-11
tags: [adr, belgian-tax, pit-calculation, exemption-brackets, correctness]
description: Corrects personal exemption calculation in Belgian PIT to apply exemption at lowest brackets first using dedicated exemption-bracket rate table (CIR-92 art. 134 §3), validated against PwC Worldwide Tax Summaries.
---

# ADR-053: Belgian PIT Exemption Bracket Correction

## Status
Accepted

## Date
2026-05-11

## Context

The Belgian Personal Income Tax (PIT) calculator previously applied the personal exemption ("quotité du revenu exempté") by subtracting the total exemption amount from taxable income before computing brackets. This caused the exemption to be valued at the taxpayer's marginal rate, which is **incorrect per Belgian tax law (CIR-92 art. 134 §3)**.

Under Belgian law, the personal exemption must be applied at the **lowest brackets first**, meaning the exemption itself is taxed using a special reduced rate schedule. Per PwC's sample calculation for IY 2025:
- 25% tax on the portion of exemption sitting in bracket 1 (€0–€15,820)
- 30% tax on the portion overflowing into bracket 2 (€15,820–€27,920) — reduced from the main 40% bracket rate
- Main bracket rates (45%, 50%) for overflow into brackets 3 and 4

The old approach incorrectly applied the exemption at the taxpayer's marginal rate, which would be 50% or higher, undercalculating the tax benefit.

**Source:** PwC Worldwide Tax Summaries — Belgium — Individual, sample personal income tax calculation (Feb 2026).

## Decision

1. **Add `exemptionBrackets` table** to `BelgianTaxYearTable` (in `constants.ts`), defining the special bracket rates (25%, 30%, 45%, 50%) used to value the exemption.

2. **Replace exemption subtraction with bracket-based calculation** in `computeExemptionBenefit()`:
   - Tax the exemption amount from bracket 1 upward using the exemption-bracket rates.
   - Subtract the resulting `personalExemptionBenefit` from `federalPITBeforeExemption`.
   - No change to exemption amount calculation itself (basic + dependents + supplements); only the valuation method changes.

3. **Rename `federalPITTotal` → `federalPITBeforeExemption`** for clarity (the new name reflects that exemption is subtracted later). Keep `federalPITTotal` as a back-compat alias.

4. **Clamp tax credits** so the total cannot reduce federal PIT below zero (preventing negative federal PIT contributions from stacking).

5. **No database migrations required** — all changes are to frontend tax logic; existing profile data continues to work.

## Consequences

### Positive
- **Correctness:** PIT calculations now match Belgian law (CIR-92 art. 134 §3) and PwC's worked examples.
- **Transparency:** Dedicated `exemptionBrackets` table documents the reduced rates explicitly in code, making the method auditable.
- **Back-compat:** Old field name `federalPITTotal` aliased, so existing consumers see no breaking change.

### Negative
- Taxpayers using older calculations will see slightly higher reported PIT (closer to actual liability); this is a correctness fix, not a regression.
- Any external tools or advisors relying on the old (incorrect) method will need revalidation.

### Neutral
- Test suite updated to validate against PwC sample; all 1292 vitest tests pass.

## Related
- [[docs/features/belgian-tax|Feature: Belgian Tax]] — Updated feature spec with exemption-bracket explanation
- [[apps/frontend/src/lib/belgianTax/pit.ts|pit.ts]] — Implementation with new `computeExemptionBenefit()` function
- [[apps/frontend/src/lib/belgianTax/constants.ts|constants.ts]] — New `exemptionBrackets` tables for each year
- [[apps/frontend/src/lib/belgianTax/__tests__/pit.test.ts|pit.test.ts]] — Test coverage including PwC sample case
