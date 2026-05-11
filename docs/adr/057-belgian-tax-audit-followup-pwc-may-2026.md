---
title: ADR-057 - Belgian Tax Audit Follow-up (PwC, May 2026)
type: adr
status: accepted
date: 2026-05-11
tags: [adr, belgian-tax, audit, pwc-alignment, tob-cap, capital-gains-tax, reynders, direct-bonds, suggested-deductions, property-tax-centimes]
description: Second-pass Belgian tax audit follow-up to ADR-056. Six fixes aligning portfolio and budgeting tax calculations with PwC AY 2026 plus EY/Loyens/Curvo guidance on the Arizona CGT reform — TOB shares cap from €4,000 to €1,600, CGT effective date corrected to 1 January 2026, direct bonds routed through CGT from IY 2026, Reynders interest-portion split with CGT remainder, year-aware rates in SuggestedDeductionsCard, per-residence centimes override.
---

# ADR-057: Belgian Tax Audit Follow-up (PwC, May 2026)

## Status
Accepted

## Date
2026-05-11

## Context

A targeted re-audit of Belgian PIT, portfolio tax, and adjacent calculations against PwC Worldwide Tax Summaries AY 2026, EY tax alerts (Arizona CGT reform), Loyens & Loeff, Curvo, tob.tax, and PwC Belgium news surfaced six issues that were not covered by ADR-056. The PwC worked sample for AY 2026 (€7,171.55 final tax due, married single-earner, 2 children, €50k after-SS income) is reproduced within €0.30 by `computeBelgianPIT`, so the core PIT engine is correct. The remaining gaps were:

1. **TOB shares cap was set to €4,000.** Statutory cap for the 0.35% rate is **€1,600** (Curvo *Taxes for Belgian Investors 2026*, tob.tax, multi-source). The €4,000 cap is specific to the 1.32% rate (accumulating funds). Code over-stated TOB on share trades above ~€457k.
2. **CGT effective-date wording said "1 June 2026".** EY, Loyens & Loeff, PwC Belgium news, Curvo, BDO and KPMG all confirm the tax applies to gains realized from **1 January 2026**; the 1 June 2026 date is only when broker withholding starts. The engine already taxes the full year, so this was a documentation bug, but the comments led readers astray.
3. **Direct bonds were treated as exempt for IY 2026.** The new CGT explicitly covers direct bonds. The portfolio-tax page had a "fall through both pools → exempt" branch for `assetClass='bond'` with `subjectToReynders=false`, which is correct only pre-2026.
4. **Reynders calculation taxed the entire fund gain at 30%.** Statutorily, Reynders is 30% on the *interest portion* only. For IY 2026+ the non-interest remainder falls under the 10% CGT (EY: *"the remaining capital gains will fall under the 10% capital gains tax"*). The implementation conflated the two and offered no way to model mixed funds.
5. **`SuggestedDeductionsCard` hardcoded `0.30`, `0.25`, `0.80` rates and the deprecated `CHILDCARE_DAILY_CAP_2025` constant.** Numerically harmless today (IY 2024/2025/2026 share these rates), but stale the moment any rate changes in a future year.
6. **Property-tax centimes had no per-residence override.** Regional medians are reasonable defaults but can be ±50% off for individual communes (e.g. Knokke-Heist ≪ regional median). Users with accurate cadastral data had no way to refine the estimate.

## Decision

### 1. TOB shares cap fix (constants.ts)

For IY 2024, 2025, 2026:

```typescript
tob: {
    bonds:             { rate: 0.0012, cap: 1_300 },
    sharesAndOther:    { rate: 0.0035, cap: 1_600 },  // was 4_000 (wrong)
    accumulatingFunds: { rate: 0.0132, cap: 4_000 },
    distributingFunds: { rate: 0.0012, cap: 1_300 },
},
```

Per-transaction cap is a function of the *rate*, not the instrument: 0.12% → €1,300; 0.35% → €1,600; 1.32% → €4,000. Regression test in `pit.test.ts` asserts a €1M share buy caps at €1,600 (was €3,500 / capped at €4,000 with the wrong table).

### 2. CGT effective-date docstring (constants.ts, PortfolioTaxPage.tsx)

Rewrite all CGT effective-date comments to say "1 January 2026" with a note that broker withholding starts 1 June 2026 but the taxable event covers the full year. Tighten the carryforward docstring: annual exemption can be uplifted by max €1,000/year when used <10%, cumulative cap **€5,000** (single) so the annual exemption can grow to €15,000 after five unused years (€30,000 married, indexed). Document the 33% rate on gains outside normal-management private estate.

### 3. Direct bonds → CGT from IY 2026 (PortfolioTaxPage.tsx)

Add `cgtActive = taxTable.capitalGainsTaxRate > 0` and route direct bonds (`assetClass === 'bond'` AND `subjectToReynders === false`) into the CGT pool when `cgtActive` is true:

```typescript
} else if (inv.assetClass !== "bond") {
    cgtGains += gain;
} else if (cgtActive) {
    // Direct bonds in scope from IY 2026 (EY/Curvo).
    cgtGains += gain;
}
```

Pre-2026 keeps the existing exempt branch.

### 4. Reynders interest-portion split + CGT remainder

Add a new optional `reyndersInterestPortion: number` field (range [0, 1], default 1.0) to:
- `InvestmentSummary` (`src/types/portfolio.ts`)
- `TaxClassificationEntry` (`src/hooks/usePortfolioTaxClassifications.ts`) — also strips at save time when value equals 1.0 to keep storage tidy.

Update the realised-gain split in `PortfolioTaxPage`:

```typescript
if (subjectToReynders) {
    const portion = clamp(investment.reyndersInterestPortion ?? 1, 0, 1);
    reyndersInterest += gain * portion;
    // Remainder routed to CGT pool from IY 2026 onwards (EY guidance on the
    // post-reform Reynders + CGT split). Pre-2026 it drops out (exempt).
    if (cgtActive) cgtGains += gain * (1 - portion);
}
```

Reynders estimate now multiplies the *interest pool* by 30% (was: full gain pool). UI: `PortfolioTaxAdjustmentsDialog` shows an "Interest portion (%)" input below the Reynders toggle when Reynders is yes/auto-bond, accepting 0–100; saved as a fraction. New i18n keys `tax.reyndersInterestPortion` / `tax.reyndersInterestPortion.desc` in EN/NL across source, frontend, and Electron locale files.

### 5. Year-aware `SuggestedDeductionsCard` (components/tax)

Remove all hardcoded `0.30` / `0.25` / `0.80` literals and the deprecated `CHILDCARE_DAILY_CAP_2025` import. Resolve every rate / cap from `getTaxTable(profile.taxYear)`:

- `pensionSavingsRateStandard` / `pensionSavingsRateAlternative` / `pensionSavingsCapStandard` / `pensionSavingsCapAlternative`
- `lifeInsuranceRate` / `lifeInsuranceCap`
- `groupInsuranceRate`
- `charitableDonationRate`
- `childcareRate` / `childcareDailyCap`
- `domesticHelpRate`
- `alimonyDeductibleFraction`

This is a hygiene fix — no numerical change for IY 2024–2026 — but it prevents regressions when a future year diverges.

### 6. Per-residence centimes override (types.ts, propertyTax.ts)

Add two optional fields:

```typescript
// On BelgianTaxProfile:
cadastralCentimesOverride?: number;
additionalResidences?: {
    /* ... */
    centimesOverride?: number;
}[];
```

`computePropertyTaxEstimate` uses the override when present and finite ≥ 0; otherwise falls back to the regional median. Invalid overrides (e.g. negative) fall back silently. Tests added for: main override lowering total tax, additional-residence override applied per-residence, invalid override falling back to baseline.

## Consequences

### Positive
- **TOB accuracy for large equity trades.** Investors moving >€457k of shares in a single transaction now see the correct €1,600 cap instead of an inflated €4,000 estimate (or worse — uncapped at €4,000).
- **CGT documentation correctness.** Future maintainers won't confuse the "1 June 2026 broker withholding" date with "1 January 2026 taxable event".
- **Direct-bond CGT in scope.** Users holding direct bonds in 2026+ now see the 10% CGT estimate, matching the reform's broader instrument scope (EY/Curvo).
- **Reynders split realism.** Mixed-bond funds and accumulating bond ETFs with non-100% interest portions can now be modeled correctly; the 10% CGT applies to the equity-attributable remainder.
- **Forward-compatible suggestions.** When IY 2027+ rates differ, `SuggestedDeductionsCard` automatically tracks them.
- **Per-commune accuracy.** Users in communes far from the regional median can refine their property-tax estimate without waiting for a Vision update.

### Negative
- New `reyndersInterestPortion` field expands the per-investment settings shape; old persisted records remain valid (undefined → 1.0).
- UI gains one extra input (Reynders interest portion), shown conditionally to keep noise low.

### Neutral
- No schema migration (all new fields live in the JSONB settings blobs).
- 1,331 frontend tests pass (was 1,331 before, +10 new regression tests, -10 stale assertions). Typecheck clean.
- ADR-056 remains the canonical exemption-bracket / regional-autonomy / disabled-dependent record; this ADR supplements it.

## Related

- [[docs/adr/056-belgian-tax-audit-fixes-ay2026|ADR-056]] — Primary AY 2026 audit; this ADR is a follow-up.
- [[docs/adr/053-belgian-pit-exemption-bracket-correction|ADR-053]] — Exemption-bracket precedent.
- [[docs/features/belgian-tax|Feature: Belgian Tax]] — Updated for year-aware suggestions + CGT date correction.
- [[docs/features/portfolio-tax|Feature: Portfolio Tax]] — Updated for TOB cap, Reynders split, direct-bond CGT routing.
- [[apps/frontend/src/lib/belgianTax/constants.ts|constants.ts]] — TOB caps + CGT docstrings.
- [[apps/frontend/src/lib/belgianTax/propertyTax.ts|propertyTax.ts]] — Centimes override resolution.
- [[apps/frontend/src/lib/belgianTax/types.ts|types.ts]] — New optional override fields.
- [[apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx|PortfolioTaxPage.tsx]] — Gain-split rewrite (Reynders interest + CGT remainder, direct-bond routing).
- [[apps/frontend/src/components/portfolio/PortfolioTaxAdjustmentsDialog.tsx|PortfolioTaxAdjustmentsDialog.tsx]] — New interest-portion input.
- [[apps/frontend/src/hooks/usePortfolioTaxClassifications.ts|usePortfolioTaxClassifications.ts]] — Extended classification shape.
- [[apps/frontend/src/components/tax/SuggestedDeductionsCard.tsx|SuggestedDeductionsCard.tsx]] — Year-aware lookups.
- PwC Belgium — [Sample Personal Income Tax Calculation](https://taxsummaries.pwc.com/belgium/individual/sample-personal-income-tax-calculation)
- EY Belgium — [Arizona's New CGT: Final Details](https://www.ey.com/en_be/technical/tax/tax-alerts/2025/arizonas-new-capital-gains-tax-final-details-disclosed)
- Loyens & Loeff — [Belgian CGT 2026 Reality Check](https://www.loyensloeff.com/insights/news--events/news/capital-gains-tax-in-belgium-becomes-reality-as-from-1-january-2026/)
- Curvo — [TOB Stock-Exchange Tax](https://curvo.eu/article/tob) and [Belgium Capital Gains Tax 2026](https://curvo.eu/article/belgium-capital-gains-tax)
- PwC Belgium news — [Stock Exchange Tax Update](https://news.pwc.be/update-belgian-stock-exchange-tax-tob-beurstaks/)
