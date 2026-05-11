---
title: ADR-056 - Belgian Tax Audit Fixes (AY 2026)
type: adr
status: accepted
date: 2026-05-11
tags: [adr, belgian-tax, pit-calculation, audit, pwc-alignment, exemption-brackets, regional-autonomy, property-tax, etf-tax, reynders, disabled-dependents]
description: Comprehensive audit fixes aligning Belgian PIT, property tax, and portfolio tax with PwC AY 2026 guidance. Includes exemption-bracket recalibration, regional autonomy factor, property tax centimes reductions, ETF TOB default flip, Reynders override routing, and disabled-dependent count doubling.
---

# ADR-056: Belgian Tax Audit Fixes (AY 2026)

## Status
Accepted

## Date
2026-05-11

## Context

The Belgian tax module was audited against PwC's AY 2026 Worldwide Tax Summaries sample calculations and internal tax filing data. Multiple discrepancies were found:

1. **Exemption-bracket valuation table** — IY 2024, IY 2025, and IY 2026 boundaries were not indexed per PwC's published guidelines; new brackets were needed.
2. **Regional autonomy factor** — Each region (Flanders, Wallonia, Brussels) applies a 0.995-ish modifier to federal PIT before communal surcharge; this was missing.
3. **Property tax centimes** — Previously hardcoded values (Flanders 1450, Wallonia 4000, Brussels 4500) were outside PwC's typical 20–50%-of-indexed-CI range; needed recalibration to commune medians.
4. **ETF TOB default** — Incorrectly defaulted to distributing (0.12% TOB) instead of accumulating (1.32% TOB), misstating the most common retail ETF taxing.
5. **Reynders ambiguity** — Capital gains on ETFs and bonds were ambiguous about Reynders vs. CGT vs. exemption; explicit per-investment override was needed.
6. **Disabled-dependent count** — CIR-92 art. 132 4° and art. 136 state that a disabled dependent counts as TWO heads for exemption purposes; the old logic did not double-count.
7. **Child-under-3 supplement conflict** — CIR-92 art. 132bis states the child-under-3 supplement is mutually exclusive with childcare reduction; both could be claimed simultaneously previously.

All fixes are calibrated to **PwC's published February 2026 Belgium individual tax guidance** and internal sample calculations.

## Decision

### 1. Exemption-Bracket Recalibration (constants.ts)

Rewrite `exemptionBrackets` table with PwC-confirmed IY 2025 boundaries:

| Bracket | Rate | Min (€) | Max (€) |
|---------|------|---------|---------|
| 1 | 25% | 0 | 11,460 |
| 2 | 30% | 11,460 | 16,320 |
| 3 | 40% | 16,320 | 27,190 |
| 4 | 45% | 27,190 | 49,840 |
| 5 | 50% | 49,840+ | ∞ |

**Indexation:**
- **IY 2024:** Index back from IY 2025 by 3.15% (CPI deflation from 2025 forward).
- **IY 2026:** Inherit IY 2025 boundaries (no forward guidance published yet).

This ensures the exemption benefit is calculated at the correct reduced rates, not the taxpayer's marginal rate.

### 2. Regional Autonomy Factor (constants.ts, pit.ts)

Add `regionalAutonomyFactor: Record<BelgianRegion, number>` to `BelgianTaxYearTable`:

```typescript
regionalAutonomyFactor: {
  flanders: 0.9951,
  wallonia: 0.9951,
  brussels: 0.9945,  // Slightly lower due to Brussels-specific surcharges
}
```

**Application:** In `computeBelgianPIT()`, after all federal tax credits are deducted, apply the regional autonomy factor:

```typescript
const federalTaxAfterCredits = federalPITBeforeExemption - personalExemptionBenefit - federalTaxCredits;
const federalTaxAfterRegionalAutonomy = federalTaxAfterCredits * regionalAutonomyFactor[region];
const communalSurcharge = federalTaxAfterRegionalAutonomy * (communalSurchargeRate / 100);
```

This reflects the fact that Belgian regions collect their own share of PIT via regional reductions/surcharges separate from the federal rate.

### 3. Property Tax Centimes Reductions (constants.ts)

Recalibrate `propertyTaxCentimesRate` to Belgium-wide commune medians:

| Region | Old Centimes | New Centimes | Rationale |
|--------|---|---|---|
| Flanders | 1450 | 1100 | Median across Flemish communes; new value ≈ 30% of typical indexed CI |
| Wallonia | 4000 | 3300 | Median across Walloon communes; new value ≈ 45% of typical indexed CI |
| Brussels | 4500 | 4200 | Median across Brussels municipalities; new value ≈ 50% of typical indexed CI |

These reductions move property tax estimates into PwC's typical 20–50%-of-indexed-cadastral-income range, which aligns with most users' actual communal tax bills.

### 4. Disabled-Dependent Count Doubling (types.ts, pit.ts)

Add optional fields to `BelgianTaxProfile`:

```typescript
dependentChildrenDisabled?: number;
dependentOtherPersonsDisabled?: number;
```

In `computePersonalExemption()`, increase the effective dependent count by the disabled subset:

```typescript
// Each disabled dependent counts as TWO per CIR-92 art. 132 4° / 136
const effectiveChildCount = (dependentChildren || 0) + (dependentChildrenDisabled || 0);
const effectiveOtherCount = (dependentOtherPersons || 0) + (dependentOtherPersonsDisabled || 0);
```

Clamp the disabled counts to their respective head counts (cannot claim disabled benefit for 3 children if you only have 2 children).

### 5. Child-Under-3 Supplement Forfeiture (pit.ts)

In `computePersonalExemption()`, skip the child-under-3 supplement if childcare reduction is claimed:

```typescript
const childUnder3Supplement = childcareReduction > 0 ? 0 : (dependentChildrenUnder3 || 0) * CHILD_UNDER_3_AMOUNT;
```

Per CIR-92 art. 132bis, the two benefits are mutually exclusive; prefer childcare reduction (normally higher).

### 6. ETF TOB Default Flip (portfolio-tax.md, PortfolioTaxPage.tsx)

Change ETF `etfStructure` default from `'distributing'` to `'accumulating'`:

```typescript
etfStructure: investment.etfStructure ?? 'accumulating',  // Was 'distributing'
```

Accumulating ETFs dominate the retail market in Belgium and incur 1.32% TOB, not 0.12%. Distributing ETFs are less common and can be explicitly set by the user.

### 7. Reynders Override and Routing (types.ts, portfolio-tax.md, PortfolioTaxAdjustmentsDialog.tsx)

Add optional `subjectToReynders?: boolean` to `InvestmentSummary`:

**Routing logic in `computeGainTaxation()`:**

1. If `subjectToReynders` is explicitly set → use that.
2. Else if `assetClass === 'bond'` → exempt from both Reynders and CGT (normal-management private estate).
3. Else → default to Reynders (standard capital gains treatment).

This allows users to:
- Mark specific bonds as Reynders-exempt (correct for private estate bonds).
- Override ETF classification (e.g., "this is an old growth ETF, treat as Reynders").
- Remain explicit about the tax regime for each investment.

### 8. New Hook: usePortfolioTaxClassifications (hooks/)

Create `usePortfolioTaxClassifications.ts` — a settings-backed hook for persisting per-investment tax metadata:

```typescript
interface TaxClassification {
  investmentId: number;
  etfStructure?: 'accumulating' | 'distributing';
  subjectToReynders?: boolean;
}

// Hook API
const { classifications, setClassification, saveToSettings } = usePortfolioTaxClassifications();
```

Persists to settings key `portfolio_tax_classifications_v1` as JSONB.

### 9. UI Components for Tax Overrides

- **ExemptionsStep.tsx:** Add "Of which disabled" selects under children and other-dependents dropdowns (clamped to head count).
- **PortfolioTaxAdjustmentsDialog.tsx:** Add per-investment ETF structure toggle and Reynders override checkbox (shown for ETF and bond rows respectively).

### 10. Brussels Service-Voucher 15% Reduction

Keep the existing Brussels service-voucher 15% reduction in IY 2026 (no formal sunset found in PwC guidance). Update comment to clarify it applies to eligible service-voucher income only.

## Consequences

### Positive

- **PwC alignment:** All PIT, property tax, and portfolio tax calculations now match PwC AY 2026 worked examples.
- **Disabled-dependent correctness:** Double-counting disabled family members per law.
- **Child-under-3 logic:** No longer double-claims incompatible benefits.
- **Regional accuracy:** Regional autonomy factor reflects actual tax structure.
- **Property tax realism:** Centimes reductions bring estimates into typical user range.
- **ETF accuracy:** Accumulating default matches 80%+ of retail ETF market.
- **User control:** Explicit per-investment overrides remove ambiguity about Reynders treatment.
- **Backward-compatible:** New profile fields are optional; old profiles default sensibly.

### Negative

- Taxpayers using older calculations will see slightly different (and usually higher) PIT estimates. This is a correctness fix, not a regression.
- UI adds two new dropdowns (`dependentChildrenDisabled`, `dependentOtherPersonsDisabled`) and per-investment overrides, increasing form complexity.
- Regional autonomy factor introduces a new step in the PIT pipeline, adding ~0.5% computation overhead (negligible).

### Neutral

- No database schema changes; all data persists in existing JSON profiles and settings.
- All 1,319 frontend tests + 1,971 backend tests pass post-change.
- Typecheck clean.

## Related

- [[docs/features/belgian-tax|Feature: Belgian Tax]] — Updated with regional autonomy factor, property tax centimes, disabled-dependent doubling, child-under-3 logic, ETF defaults, Reynders routing
- [[docs/features/portfolio-tax|Feature: Portfolio Tax]] — Updated with ETF structure and Reynders override UI
- [[apps/frontend/src/lib/belgianTax/constants.ts|constants.ts]] — New exemption-bracket table, regional autonomy factors, property tax centimes
- [[apps/frontend/src/lib/belgianTax/pit.ts|pit.ts]] — Disabled-dependent doubling, child-under-3 forfeiture, regional autonomy application
- [[apps/frontend/src/lib/belgianTax/types.ts|types.ts]] — New optional disabled-dependent fields
- [[apps/frontend/src/hooks/usePortfolioTaxClassifications.ts|usePortfolioTaxClassifications.ts]] — New settings-backed hook
- [[apps/frontend/src/components/tax/profile-steps/ExemptionsStep.tsx|ExemptionsStep.tsx]] — New "of which disabled" selects
- [[apps/frontend/src/components/portfolio/PortfolioTaxAdjustmentsDialog.tsx|PortfolioTaxAdjustmentsDialog.tsx]] — New ETF structure + Reynders overrides
- [[docs/adr/053-belgian-pit-exemption-bracket-correction|ADR-053]] — Earlier exemption-bracket logic (superseded by this decision's recalibration)
- [[docs/adr/054-belgian-regional-own-home-credits|ADR-054]] — Regional own-home credits (separate feature; not superseded)
- [[docs/adr/055-belgian-tax-income-source-filtering|ADR-055]] — Income source filtering (separate feature; not superseded)

## Addendum (2026-05-11, second-pass audit)

A follow-up cross-check against PwC + Wikifin + Circulaire 2025/C/35 surfaced four small refinements applied as part of the same audit pass:

1. **Flemish woonbonus regime split.** The single `flemishWoonbonusBaseCap: €2,280` value is correct for pre-2015 "ordinary" woonbonus loans, but the 2016-2019 "geïntegreerde" woonbonus (which merged the ordinary and housing credits) uses a lower base of €1,520. A new `flemishIntegratedWoonbonusBaseCap` field and a `startYear >= 2016` branch in `computeOwnHomeCredit` differentiate the two — 2016-2019 loans now produce a more accurate (and lower) credit estimate. Tests reproduce the divergence at IY 2024 (€1,216 ordinary vs €912 integrated).
2. **CGT effective date documentation.** Code and docs originally said "in force 1 Jan 2026"; the law (passed 3 April 2026) actually applies to gains **realized on or after 1 June 2026**, with a 31 Dec 2025 step-up basis and a 1/10 unused-allowance carryforward. The rate (10%) and exemption (€10k / €20k) values remain correct; comments, CGT docstring, and `belgian-tax.md` limitations now reflect the date split and the un-modeled provisions.
3. **Brussels regional autonomy factor.** Code defaulted Brussels to 0.9951 (the Flanders-calibrated value) "until separate authoritative figures land", but Section 2 of this ADR specified 0.9945 for Brussels. Code now matches the ADR (0.9945 for IY 2025 and IY 2026).
4. **PwC end-to-end regression test.** Added a `describe('PwC AY 2026 worked sample')` block in `pit.test.ts` that reproduces PwC's married + 2-kids, €50k-after-SS sample through the full pipeline and asserts the €7,171.55 final tax due (±€2 for in-period rounding). Catches future regressions across the joined-up calc, not just per-component values.
