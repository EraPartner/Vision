---
title: ADR-055 - Belgian Tax Income Source Filtering
type: adr
status: accepted
date: 2026-05-11
tags: [adr, belgian-tax, tax-overview, income-sources, category-filtering, graph-filtering]
description: Adds multi-select category picker to Tax Profile to filter which income sources are subject to tax calculations and visualizations in Tax Overview page.
---

# ADR-055: Belgian Tax Income Source Filtering

## Status
Accepted

## Date
2026-05-11

## Context

The Tax Overview page displays graphs showing estimated tax liability over time. Previously, all transaction income (salary, rental, freelance, dividends, etc.) was automatically included in tax calculations, making graphs noisy when the user has side income from non-taxable sources or wishes to simulate "what-if" scenarios excluding certain income streams.

User feedback indicates a need to:
1. Exclude non-taxable income categories (e.g., gifts, loan proceeds, transfers) from tax liability estimates.
2. Visualize tax impact of selected income streams independently.
3. Compare scenarios (e.g., "with side project" vs. "without side project").

## Decision

1. **Add `taxIncomeCategoryIds: number[]`** to `BelgianTaxProfile` to store the user's selection of income-subject categories.

2. **Add new step to `TaxProfileDialog`**: "Taxable Income Sources" (step 3 of 5) with a multi-select category picker.
   - Renders all `income`-type categories from the workspace.
   - Users can toggle each category on/off.
   - Selection is persisted to `taxIncomeCategoryIds`.

3. **Update `TaxOverviewPage` graphs**:
   - **Monthly chart**: 
     - Filter `monthlyData.income` to only rows where `categoryId ∈ taxIncomeCategoryIds`.
     - Calculate each month's taxable income as a fraction of the trailing-12-month total.
     - Prorate annual PIT across months by that fraction (instead of annualizing each month's income in isolation).
   - **Yearly chart**: 
     - Filter annual income by category.
     - Recalculate PIT using year-aware bracket table for each year.
   - **Empty state**: Display a CTA to configure income sources when `taxIncomeCategoryIds.length === 0`.

4. **Add `isApproximatedTaxYear()` helper** in `constants.ts` to detect years before EARLIEST_TAX_YEAR and trigger an "approximated" note in charts.

5. **Update `getTaxTable()` fallback**:
   - Years before EARLIEST → use EARLIEST table.
   - Years after LATEST → use LATEST table.
   - Years in between → use nearest-year fallback (no interpolation).

## Consequences

### Positive
- **User control:** Taxpayers can exclude non-taxable income or simulate scenarios.
- **Graph clarity:** Tax liability estimates reflect only the income streams the user considers.
- **Flexibility:** Multi-select design allows easy adding/removing categories without re-opening dialog.
- **Transparency:** Approximate year warning alerts users to data limitations for early years.

### Negative
- **UI complexity:** TaxProfileDialog grows from 4 to 5 steps; onboarding takes longer.
- **Category dependency:** If user deletes or renames a category, `taxIncomeCategoryIds` becomes orphaned. [Future: add cleanup logic to profile migration/category-delete handler.]
- **Proration assumptions:** Monthly PIT calculation assumes linear income distribution; real tax may vary if income spikes in specific months.

### Neutral
- No breaking changes; existing profiles without `taxIncomeCategoryIds` default to `[]` (empty-state prompt).
- Graph data fetching unchanged; filtering happens in the UI layer.

## Related
- [[docs/features/belgian-tax#taxable-income-sources|Feature: Taxable Income Sources]] — User-facing overview
- [[docs/features/belgian-tax#porrection-output-fields|Calculation Output Fields]] — `federalPITBeforeExemption` and field documentation
- [[apps/frontend/src/lib/belgianTax/constants.ts|constants.ts]] — `getTaxTable()` fallback logic, `isApproximatedTaxYear()`
- [[apps/frontend/src/components/tax/profile-steps/IncomeSourcesStep.tsx|IncomeSourcesStep.tsx]] — Multi-select UI component
- [[apps/frontend/src/pages/TaxOverviewPage.tsx|TaxOverviewPage.tsx]] — Graph filtering and proration logic
