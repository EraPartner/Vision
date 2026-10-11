---
title: Feature - Belgian Tax
type: feature
status: active
date: 2026-10-11
updated: 2026-10-11
tags: [feature, tax, belgian, cadastral-income, deductions, phase-8, pdf-export, regional-own-home-credit, exemption-brackets, taxable-income-sources, audit-2026-05-11, disabled-dependents, regional-autonomy-factor, property-tax-centimes, etf-tob, reynders-routing, portfolio-tax-pure-module, decimal-migration, point-in-time-fx, url-state, filing-masthead, computation-flow, adr-105]
description: "Belgian tax profile management with PIT calculator using exemption-bracket method (CIR-92 art. 134 §3), regional own-home credits (Flemish woonbonus, Walloon chèque habitat), taxable income source filtering, cadastral income tracking, deduction management, PDF tax report export, and May 2026 PwC audit fixes (disabled-dependent doubling, child-under-3 forfeiture, regional autonomy factor, property-tax centimes calibration). May 2026: Portfolio-tax estimators extracted to a pure, tested module with Decimal.js accumulation."
aliases: [belgian-tax, tax-feature, cadastral, deductions, belgium]
related_code:
  - apps/frontend/src/pages/TaxOverviewPage.tsx
  - apps/frontend/src/features/tax/TaxProfileDialog.tsx
  - apps/frontend/src/features/tax/SuggestedDeductionsCard.tsx
  - apps/frontend/src/features/tax/DeductionCandidatesCard.tsx
  - apps/frontend/src/features/tax/TaxYearStatusIcon.tsx
  - apps/frontend/src/contexts/BelgianTaxProfileContext.tsx
  - apps/frontend/src/stores/belgianTaxStore.ts
  - apps/frontend/src/lib/belgianTax/householdRuntime.ts
  - apps/frontend/src/lib/belgianTax/pit.ts
  - apps/frontend/src/lib/belgianTax/constants.ts
  - apps/frontend/src/lib/belgianTax/socialSecurity.ts
  - apps/frontend/src/lib/belgianTax/propertyTax.ts
  - apps/frontend/src/lib/belgianTax/portfolioTax.ts
  - apps/frontend/src/lib/belgianTax/costBreakdown.ts
  - apps/frontend/src/lib/belgianTax/exportTaxYearCsv.ts
  - apps/frontend/src/lib/belgianTax/__tests__/portfolioTax.test.ts
  - apps/node-backend/src/services/belgianInflationService.ts
---

# Feature: Belgian Tax

## Overview

Vision includes Belgian-specific tax features to support local tax filing requirements:

- A year-aware Personal Income Tax (PIT) calculator (federal brackets, personal exemption, tax credits, communal surcharge, social security).
- Cadastral income tracking and a regional property tax (`précompte immobilier` / `onroerende voorheffing`) estimate.
- Deduction & credit suggestions matched to the user's profile.
- Inflation-adjusted portfolio returns using Statbel / Eurostat HICP data.

Transaction-derived deduction candidates use replacement semantics: applying a candidate sets the
matching annual profile field to the detected total; it does not add to the existing value. For the
current calendar year, every application first requires an explicit acknowledgement that the year
is incomplete and the candidate may cover only part of it. The confirmation shows both the current
annual profile value and its replacement. Completed tax years retain direct confirmation.

Candidate matching is conservative. `PENSION SAVINGS` and `PENSIOENSPAREN` identify pension
savings; bare `PENSION`, `RETIREMENT`, or `RETIREMENT:FUND` do not. Group pension and group life
insurance take precedence over personal pension savings or life insurance. Generic group policies
and bare `SCHENKING` remain unclassified. Explicit phrases can span general/detail segments,
such as `UNION:DUES`, `CHILD:CARE`, and `GOEDE:DOELEN`.

A failed candidate request displays an error and a retry action. It does not display an empty
success or let the user confirm cached suggestions while the latest request has failed. These
category matches remain suggestions requiring confirmation; category text does not prove eligibility.

## Module layout

Pure tax logic lives in [[apps/frontend/src/lib/belgianTax]] and is split by concern:

| Module                | Responsibility                                                              |
| --------------------- | --------------------------------------------------------------------------- |
| `types.ts`            | `BelgianTaxProfile`, `BelgianTaxCalculation`, region & employment unions    |
| `constants.ts`        | Year-keyed `BelgianTaxYearTable` (IY 2024, 2025, 2026) — brackets, caps, rates |
| `pit.ts`              | `computeBelgianPIT(profile)` — composes deductions, credits, surcharge      |
| `socialSecurity.ts`   | Employee SS + step-function special social security contribution (CSSS)     |
| `propertyTax.ts`      | Indexed cadastral × regional rate × centimes additionnels                   |
| `portfolioTax.ts`     | Pure portfolio-tax estimators (see below)                                   |
| `costBreakdown.ts`    | Shared transaction tax and fee bucketing for portfolio-tax views            |
| `exportTaxYearCsv.ts` | Pure filed/frozen tax-year CSV serialization                                |
| `personPit.ts`        | Per-person building blocks: progressive tax, exemption valuation, forfait per category, reductions, own-home and service-voucher credits, breakdown rows |
| `householdTypes.ts`   | `BelgianTaxHouseholdV2`, activities, relationship events, result and issue types |
| `assessment.ts`       | `deriveAssessment` — single / separate / joint per income year (art. 126)   |
| `exemptions.ts`       | Dependent supplements and tax-free sum allocation between partners          |
| `maritalQuotient.ts`  | Arts 87-88 quotient on professional income, IY 2026 senior cap              |
| `household.ts`        | `computeHouseholdTax`, `toBelgianTaxCalculation`                            |
| `householdMigration.ts` | v1 profile ↔ v2 household upgrade, projection and patching                |
| `householdSchema.ts`  | zod schemas for the v2 setting values                                       |
| `householdRuntime.ts` | Lazily loaded engine entry for the store: settings load/upgrade, projections, household diff |
| `index.ts`            | Explicit supported public re-exports; year-table internals stay private     |

### `portfolioTax.ts` — Pure Portfolio-Tax Estimators (2026-05-29)

`apps/frontend/src/lib/belgianTax/portfolioTax.ts` contains the portfolio-tax computation functions that were previously inlined in `PortfolioTaxPage.tsx`. Extracting them to a pure, side-effect-free module enables independent golden-fixture testing and de-duplication between pages.

**Exported functions:**

| Function                                                                 | Inputs                                                   | Returns                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `recordedTaxesForYear(transactions, year, convert)`                      | Portfolio transactions for a year + `ConvertFn`          | `{ total, byType }` — sum of recorded taxes grouped by tax type              |
| `recordedFeesForYear(transactions, year, convert)`                       | Portfolio transactions for a year + `ConvertFn`          | `{ total, byType }` — sum of recorded fees grouped by fee type               |
| `enrichInvestmentCosts(investments, transactions, year, convert)`        | All investments + transactions + `ConvertFn`             | Per-investment cost summary (taxes, fees, realized gain)                     |
| `computeTobRecorded(transactions, year, convert)`                        | Buy-type transactions + `ConvertFn`                      | Total TOB (transaction tax on securities) recorded from buy taxes            |
| `computeTobAutoEstimate(transactions, classifications, year, convert)`   | Transactions + per-investment ETF metadata + `ConvertFn` | Auto-estimated TOB using rate-banded caps (0.12%/0.35%/1.32%)                |
| `computeTacrEstimate(portfolio, year)`                                   | Portfolio summary + income year                          | TACR (securities-account tax) estimate for accounts ≥ €1M                    |
| `computeRealizedGainSplit(transactions, classifications, year, convert)` | Sell transactions + ETF metadata + `ConvertFn`           | Realized gain split into Reynders and CGT pools                              |
| `computeReyndersEstimate(gainSplit, year)`                               | Output of `computeRealizedGainSplit`                     | Reynders tax estimate at 30% on interest-attributable portion                |
| `computeCgtEstimate(gainSplit, profile, year)`                           | Gain split + Belgian profile + year                      | Arizona CGT (10%) estimate after annual exemption                            |
| `computeDividendWht(transactions, year, convert)`                        | Dividend transactions + `ConvertFn`                      | `{ tracked, whtPaid, reclaimable, netCost }` using Belgian WHT reclaim rules |

**Currency injection:** all functions accept a `ConvertFn = (amount: number, fromCurrency?: string) => number` parameter rather than accessing exchange-rate state directly. This keeps the module dependency-free and fully testable without React context.

**Decimal accumulation:** monetary sums and products inside these functions accumulate via `decimal.js` internally and return `number`. This eliminates float-accumulation drift across many transactions while leaving the public API type-stable (`number` in, `number` out).

**De-duplication:** `recordedTaxesForYear` is now the single implementation shared by both `PortfolioTaxPage` and `TaxOverviewPage`. Each page's `useMemo` calls the shared function instead of duplicating the per-transaction accumulation loop.

**Tests:** `apps/frontend/src/lib/belgianTax/__tests__/portfolioTax.test.ts` — 13 golden-output cases locking all estimators to 8 decimal places. Integrated into the frontend Vitest suite (94 tax-unit + 88 portfolio-integration tests pass; see [[docs/testing/test-inventory|Test Inventory]]).

The Belgian-tax slice in [[apps/frontend/src/stores/belgianTaxStore]] owns household, snapshot,
audit, viewed-year, and calculation state; `profile` and `snapshots` are v1 projections of the
household (see [Household taxation](#household-taxation)). The compatibility provider in
[[apps/frontend/src/contexts/BelgianTaxProfileContext]] only hydrates and persists that slice.
Consumers use narrow selectors, and pure tax symbols come directly from `lib/belgianTax`.
Boot-path modules import the library by file path, not through the barrel, so the household
engine stays in the lazily loaded `householdRuntime.ts` chunk.

## Sources of truth

Every rule and amount in the reference tables (`getTaxTable(year)`) is traced to a primary source
in [[docs/reference/belgian-tax-rule-matrix]] (one row per rule, per income year 2024-2026), as
decided in [[docs/adr/199-belgian-tax-source-verification|ADR-199]]. The primary sources are:

- FPS Finance _Avis relatif à l'indexation automatique_ for assessment years 2025, 2026 and 2027 (Fisconetplus) — every indexed amount.
- FPS Finance consumer pages on fin.belgium.be (tax rates, marriage and cohabitation, dependents, professional income, dividends, savings, reductions, previous-years amounts).
- The law of 18 December 2025 (indexation freeze, donations 30%, alimony 70/60/50%, domestic-help reduction abolished), the law of 15 July 2026 (PIT reform from AY 2027) and the law of 30 March 1994 (special social security contribution).
- PwC _Worldwide Tax Summaries — Belgium — Individual_ remains a secondary cross-check only; its IY 2025 dividend, savings and life-insurance figures ignore the freeze and are not used.

- For the regional layer (2026-10-11): the regional versions of WIB 92 on Fisconetplus (woonbonus, chèque habitat, service vouchers, property tax), the Vlaamse Codex Fiscaliteit on Justel, the FPS circulars 2026/C/63, 2026/C/18, 2025/C/20, 2026/C/34 and 2026/C/74, the Royal Decree of 19 December 2017 and the special finance law (state/regional factor), and Royal Decree no. 38 with its yearly art. 14 decrees (self-employed contributions).

Rows the matrix marks `unverified` (the communal property-tax centimes) keep their earlier values until their primary page is reached.

`SUPPORTED_TAX_YEARS` (sorted numerically) lists the years with a complete table; `LATEST_TAX_YEAR` is the default.

**Exemption-bracket table (May 2026 audit):** IY 2025 boundaries confirmed as 25% (€0–€11,460), 30% (€11,460–€16,320), 40% (€16,320–€27,190), 45% (€27,190–€49,840), 50% (€49,840+). IY 2024 indexed back from IY 2025 by 3.15%; IY 2026 inherits IY 2025 (no forward guidance published).

**Tax table fallback:** The `getTaxTable(year)` function uses a nearest-year fallback:

- Years on or after the latest supported year → use LATEST table.
- Years between EARLIEST and LATEST → use the nearest supported year (no interpolation).
- Years before EARLIEST → use EARLIEST table, and `isApproximatedTaxYear(year)` returns `true` (triggering an "approximated" note in the UI).

New years are added by appending a `BelgianTaxYearTable` entry — no calculator changes required.

---

## Tax Profile

### Data tracked

| Field                                                                              | Description                                                                                                      |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Employment type                                                                    | `employee` / `civil_servant` / `self_employed` / `director` / `retired` / `other`                                |
| Gross annual income                                                                | Salary / pension / freelance gross                                                                               |
| Other taxable income                                                               | Rental, additional freelance, etc.                                                                               |
| Region                                                                             | Flanders / Wallonia / Brussels                                                                                   |
| Communal surcharge %                                                               | Local surcharge on federal PIT                                                                                   |
| Dependent children                                                                 | Total count                                                                                                      |
| Dependent children (disabled)                                                      | Sub-count of disabled children — each counts as TWO per CIR-92 art. 132 4° (optional, clamped to total children) |
| Other dependents                                                                   | Other persons ten laste / à charge                                                                               |
| Other dependents (disabled)                                                        | Sub-count of disabled other dependents — each counts as TWO per CIR-92 art. 136 (optional, clamped to total)     |
| Dependents under 3                                                                 | Sub-count of children under 3 (forfeited if childcare reduction claimed per CIR-92 art. 132bis)                  |
| Disability flags                                                                   | Self / spouse — each adds €1,980 to personal exemption                                                           |
| Single-parent flag                                                                 | `isIsolatedParent` adds the single-parent supplement                                                             |
| Cadastral income + additional residences                                           | For property tax estimate                                                                                        |
| Mortgage details                                                                   | Interest, capital repaid, region, start year, primary residence status                                           |
| Taxable income source categories                                                   | Filter for income categories included in tax calculations; used for graph filtering                              |
| Alimony / pension savings / life insurance / donations / childcare / domestic help | With per-item eligibility flags                                                                                  |
| Service vouchers                                                                   | `serviceVoucherSpend` (EUR, optional, takes precedence) or the legacy `serviceVoucherCount`, with eligibility flag |
| Annual dividend income                                                             | Drives WHT reclaim estimate                                                                                      |
| Annual savings interest                                                            | Drives 15% above-exemption tax estimate                                                                          |
| Tax year                                                                           | Income year — selects the corresponding bracket table                                                            |

### Employment type → professional expense forfait

WIB 92 art. 51 (amounts from the FPS Finance indexation notice per assessment year, see [[docs/reference/belgian-tax-rule-matrix]]): employees, civil servants and self-employed **trading profits** (winsten) get the 30% forfait (cap €5,930 IY 2025, €6,070 IY 2026). Remunerated company directors get the 3% forfait (cap €3,130 IY 2025). Self-employed **fees** (baten, liberal professions) get the degressive 28.7% / 10% / 5% / 3% scale with its own cap (€5,210 IY 2025). The optional profile field `selfEmployedIncomeKind` (`profits` by default, `fees`) selects the scale; pensions and other replacement income get no forfait. Per art. 51 al. 1 the percentages apply to the gross income after the employee social-security contribution, so for employees and civil servants the 13.07% / 11.05% contribution comes off before the 30% (this matters below the cap, about €22,700 gross in IY 2025). This is enforced in `computeProfessionalExpenses` in [pit.ts](apps/frontend/src/lib/belgianTax/pit.ts). (Until 2026-10-11 the engine gave self-employed taxpayers no forfait at all.)

### Taxable Income Sources

The Tax Profile now includes a step to select which transaction categories are subject to tax. The `taxIncomeCategoryIds: number[]` array is persisted in the profile and used by the **Tax Overview** page to:

1. Filter the monthly and yearly charts to show only income from selected categories.
2. In the **monthly chart**: calculate each month's share of the trailing-12-month taxable income total, then prorate the annual PIT across months by that share (instead of annualizing each month's income in isolation).
3. In the **yearly chart**: thread each year's own bracket table for year-aware PIT recalculation.
4. Display an **empty-state CTA** when no income sources are configured, prompting the user to select categories.
5. Show an **"approximated year" note** for years before the earliest supported tax year (EARLIEST_TAX_YEAR).

The selector is presented as a new step in `TaxProfileDialog` (step 3 of 5: `Income → Income sources → Exemptions → Deductions → Submit`).

---

## Real Estate Tax Fields

Investments of type `real_estate` include Belgian-specific fields:

| Field                 | Type          | Description          |
| --------------------- | ------------- | -------------------- |
| municipality          | VARCHAR(200)  | Belgian municipality |
| cadastral_income      | NUMERIC(12,2) | Kadastraal inkomen   |
| municipality_tax_rate | NUMERIC(8,4)  | Municipal tax rate   |

**Migration:** `0010_investments_municipality_tax_fields.py`

---

## PIT calculation pipeline (`computeBelgianPIT`)

1. Gross = salary + other taxable income.
2. Employee social security: 13.07% (employee) / 11.05% (statutory civil servant: 3.55% health care + 7.5% survivors' pension; 11.07% until 2026-10-11), salary only.
3. Professional expenses: lump-sum forfait (employee / director / self-employed profits or fees, see above) or actual.
4. Deductions from taxable basis: alimony at the art. 104 share for the income year (80% up to 2024, 70% in 2025, 60% in 2026 — law of 18 December 2025). (2026-06-11 correction: union dues now deduct only inside the _actual_ professional-expense method — they are professional expenses, not a separate deduction — and medical expenses no longer deduct at all; Belgian PIT has no general medical deduction. The breakdown also gained a 'Property Tax (estimate)' row so the visible rows reconcile to Net Take-Home.)
5. Personal exemption (`quotité du revenu exempté`): basic + dependents (with disabled count doubling per CIR-92 art. 132 4° / 136) + under-3 (forfeited if childcare claimed per CIR-92 art. 132bis) + other dependents + disability + single-parent supplements; applied at the **lowest brackets first** via a dedicated exemption-bracket rate table (CIR-92 art. 134 §3). The exemption amount is taxed from bracket 1 upward using reduced rates (25% on bracket-1 portion, 30% on bracket-2 overflow, then main rates above), and the result is subtracted from gross PIT and reported as `personalExemptionBenefit`. Disabled dependents count as TWO heads each; `dependentChildrenDisabled` and `dependentOtherPersonsDisabled` are clamped to their respective head counts.
5b. Marital quotient under `married_joint` (arts 87-88): the spouse's own professional income is taxed in their own name with the basic exemption (art. 126 §1 al. 2, décumul); up to 30% of the household professional income is transferred to the spouse so that own income plus transfer reaches the indexed cap (art. 88), and the transfer is kept only when the two spouses' combined tax is lower than without it (art. 88 al. 2). In the household engine that comparison is made on the final tax (after each partner's reductions, the state/regional factor and the communal surcharge), so a partner's reductions cannot make an automatic transfer costly; the quotient benefit is that saving. Until 2026-10-11 the no-quotient baseline omitted the spouse's own tax.
6. Regional own-home credit (optional): applies to mortgages on the taxpayer's primary residence. The claimant's taxable income before the marital quotient sets the woonbonus marginal rate and the chèque habitat income limits (both engines; in the household engine the claimant is `mortgageCreditPartnerId`). Corrected on 2026-10-11 against the regional WIB 92 texts; amounts are not indexed.
   - **Flemish woonbonus (loans signed before 2020)**, credit = min(interest + capital repaid, base + increases) × rate:
     - _Loans before 2015_ (art. 145/37 §2): base €2,280 at the taxpayer's highest art. 130 rate, minimum 30%.
     - _Loans signed in 2015_ (art. 145/37 §3): base €1,520 at 40%.
     - _2016-2019 "geïntegreerde" woonbonus_ (art. 145/38/2): base €1,520 at 40%.
     - In the first ten taxable periods the base rises by €760, and by a further €80 with three or more dependent children; after year ten neither applies.
   - **Walloon `chèque habitat` (loans signed 2016-2024)**, art. 145/46ter as coordinated in FPS circular 2026/C/18: €1,520 when the taxable income is at or below the lower limit; €1,520 − 1.275% × (income − lower limit) between the limits; nothing above the upper limit (IY 2024 26,394 / 101,805; IY 2025 27,353 / 105,503; IY 2026 28,024 / 108,093). Plus €125 per dependent child (disabled children count twice) except above the upper limit. Halved from the eleventh taxable period, granted for twenty assessment years at most (art. 145/46quinquies), and never more than the interest and capital paid; the loan age is counted from the income year being computed. Loans signed from 1 January 2025 no longer qualify. The halving for a second home is not modelled.
   - **Brussels & post-2020 Flanders**: Not modeled (regime = 'none', credit = 0).
7. Tax credits ("réductions d'impôt", IY 2025 amounts): pension savings (€1,050 @30% or €1,350 @25%), life insurance (€2,450 @30%, frozen by the law of 18 December 2025), employee group insurance (30%), donations (30% since 2025, 45% in 2024, ≥€40, capped at 10% of net income and €408,130), childcare (45%, €16.90/day cap). The domestic-personnel reduction (art. 145/34) was abolished from income year 2025; the IY 2024 table keeps it (30%, €8,160 wage cap). All require an explicit eligibility flag in the profile. Tax credits are clamped so the total cannot reduce federal PIT below zero.
   - **Service vouchers** (regional art. 145/21): reduction = rate × min(spend, cap per taxpayer). Flanders 20% up to €1,790 (IY 2024), abolished from IY 2025; Wallonia 30% up to €1,790 / €1,850 / €1,890; Brussels 15% up to €1,790 / €1,850, abolished from IY 2026. The spend is the optional `serviceVoucherSpend` field; when it is absent the legacy `serviceVoucherCount` is converted with the year table's voucher price (€9 or €10). Until 2026-10-11 the engine used voucher counts (€0.90 × 150 in Wallonia, 15% × 172 × €10 in Brussels).
8. **State + regional factor**: federal PIT after credits × (reduced state tax 75.043%) × (1 + regional opcentiemen) = 1.0000 for Flanders and Wallonia (33.257%) and 0.9950 for Brussels (32.591%), for IY 2024-2026. Until 2026-10-11 the engine used 0.9951 / 0.9951 / 0.9945, calibrated on a PwC sample whose factor matches Brussels; no Flemish 2% reduction exists in the sources read.
9. Communal surcharge applied to federal PIT after the state + regional factor.
10. Special social security contribution (law of 30 March 1994 arts 106-109): a step function of the household income (€0 up to €18,592.02, then the single or joint scale, cap €731.28). Under a joint assessment the base is the earner's net professional income plus the spouse's professional income (art. 107, 2°), and the joint scale applies.
11. Property tax (informational, not part of PIT): `nominalCI × indexationCoefficient × regionalBaseRate × (1 + centimes/100)`, summed across main + additional residences. **May 2026 audit:** centimes reductions calibrated to Belgium-wide commune medians (Flanders 1450→1100, Wallonia 4000→3300, Brussels 4500→4200) to align estimates with typical 20–50%-of-indexed-CI range.
12. Investment side calc:
    - `dividendWhtReclaim = min(recordedWHT, min(grossDividendBase, exemption) × WHT_rate)` — Belgian dividend withholding is taken at source; reclaim is capped by both the recorded WHT and the exemption. Gross base = dividend amount + recorded WHT, which handles both net and gross recording conventions. The €833 exemption (IY 2024-2026, frozen by the law of 18 December 2025) applies to the gross base and is reclaimed via the tax return.
    - `savingsInterestTax = max(savingsInterest − €1,020, 0) × 15%` — savings deposit excess (art. 21, 5°; €1,020 for IY 2024-2026).

### Calculation output fields

The `BelgianTaxCalculation` result object includes:

| Field                       | Definition                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `federalPITBeforeExemption` | Federal PIT before personal exemption deduction                                                                                              |
| `personalExemptionBenefit`  | Tax benefit from applying personal exemption via exemption-bracket table                                                                     |
| `federalTaxCredits`         | Total tax credits (pension savings, life insurance, donations, childcare, domestic help, etc.), clamped so sum ≤ `federalPITBeforeExemption` |
| `ownHomeCreditRegime`       | Applicable regime: `'flemish_woonbonus'`, `'walloon_cheque_habitat'`, or `'none'`                                                            |
| `ownHomeCredit`             | Regional own-home credit amount (0 if regime is `'none'`)                                                                                    |
| `totalPIT`                  | Federal PIT after exemption, credits, and communal surcharge (income tax only)                                                               |
| `totalTaxBurden`            | `totalPIT` + employee SS + special SS + property tax estimate (no double-counting)                                                           |

> **Compatibility cutoff (2026-09-11):** `federalPITTotal` is no longer emitted or accepted in frozen calculations. Migration 0106 removes it only when its numeric value equals `federalPITBeforeExemption`; alias-only, malformed, or divergent stored values stop the migration for operator review. The affected `user_settings` row is included in normal database backups. See [[docs/adr/135-compatibility-cutoff-for-september-retirements|ADR-135]].
>
> **Regression note (2026-04-26):** an earlier implementation added the communal surcharge twice into `totalTaxBurden`. Covered now by [`pit.test.ts`](apps/frontend/src/lib/belgianTax/__tests__/pit.test.ts).

## Portfolio Tax Page (`/portfolio/tax`)

### Features

- **Tax-adjusted returns**: Portfolio returns adjusted for Belgian tax rates.
- **Inflation-adjusted values**: Real returns using Belgian inflation data.
- **Tax deductions tracking**: Track tax-deductible investment expenses.

### Dividend WHT widget (Belgian rules)

Shows four explicit values for dividend taxation:

| Tile                      | Definition                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Dividend income tracked` | Sum of all `dividend` transaction amounts for the tax year                                                                         |
| `WHT paid (gross)`        | Sum of all recorded WHT from `dividend` transactions — actual withheld amount, not estimated                                       |
| `WHT reclaimable`         | `min(recordedWHT, min(grossDividendBase, €833) × 30%)` — available only when every included dividend has a known amount convention |
| `Net WHT cost`            | `max(recordedWHT − reclaimable, 0)` — the unrecoverable portion                                                                    |

Each dividend row explicitly records whether its amount is `gross`, `net`, or `unknown` (ADR-126).
Gross rows contribute `amount`; net rows contribute `amount + recordedWHT`. Existing and
unclassified rows are `unknown`. Recorded amounts and taxes still display, but convention-dependent
reclaim and net-cost estimates are marked incomplete until every included row is classified.

### Cross-Currency Normalization

All monetary displays on the Portfolio Tax page are converted to `appSettings.defaultCurrency` using live exchange rates from `/api/info/exchange-rates`. The yearly cost trend, total realized / unrealized gain, and tax/fee breakdowns now consistently apply the conversion (an earlier path mixed transaction-native currencies into the chart).

---

## Belgian Inflation Integration

### Data Sources

| Source            | Priority    | Description                         |
| ----------------- | ----------- | ----------------------------------- |
| **Statbel**       | Primary     | Belgian statistics office           |
| **Eurostat HICP** | Fallback    | Harmonised Index of Consumer Prices |
| **Persisted DB**  | Last resort | Previously fetched data             |

### Storage

Inflation data is persisted to `belgian_inflation_rates` table:

| Column       | Type          | Description            |
| ------------ | ------------- | ---------------------- |
| month_date   | DATE          | First of month         |
| monthly_rate | NUMERIC(10,8) | Monthly inflation rate |
| source       | VARCHAR(50)   | statbel or eurostat    |
| fetched_at   | TIMESTAMPTZ   | Fetch timestamp        |

### Usage

- **Performance calculations**: Real returns = nominal return - inflation
- **Net worth**: Inflation-adjusted portfolio values
- **Monthly compounding**: Rates compounded month-by-month using backend month keys

### API

| Method | Path                                     | Description                        |
| ------ | ---------------------------------------- | ---------------------------------- |
| GET    | `/api/info/inflation-rates`              | Get inflation rates                |
| GET    | `/api/info/inflation-rates?db_only=true` | Get from DB only (no remote fetch) |
| POST   | `/api/info/inflation-rates/refresh`      | Refresh from remote sources        |

**Migration:** `0023_portfolio_performance_snapshots.py`

---

## Suggested Deductions

The tax overview page includes a `SuggestedDeductionsCard` component that suggests common Belgian tax deductions:

- Mortgage interest
- Pension savings
- Service vouchers
- Donations

## Household taxation

> [!info] Phase B2 (2026-10-11, [[docs/adr/200-belgian-tax-household-model|ADR-200]])
> The store computes the live tax from the household. Editors still use the v1 profile shape
> through the compatibility helpers; household screens and the partner-to-account-owner link
> follow in phase C.

A household (`BelgianTaxHouseholdV2`) has one or two partners. Each partner has income
activities (employee, civil servant, director, self-employed profits or fees, helping spouse,
pension, other professional income, or an already-net amount), an expense choice per art. 51
forfait category, personal deductions and reductions. Relationship events (marriage, legal
cohabitation and its end, factual cohabitation, factual separation, divorce, death) are dated.

`computeHouseholdTax(household)` runs this pipeline; each step has a row in the
[[docs/reference/belgian-tax-rule-matrix|rule matrix]]:

1. **Assessment** (`deriveAssessment`, art. 126): one partner → single; no marriage or legal
   cohabitation → separate; the year of the marriage or declaration → separate, unless legal
   cohabitants marry (joint); the year of divorce or end of legal cohabitation → separate; the
   year of a factual separation → joint, later years separate; the year of a death → separate
   unless the survivor elects joint (art. 126 §3), later years → the survivor alone;
   treaty-exempt professional income above the threshold → separate.
2. **Activities**: 13.07% employee and 11.05% civil-servant contributions per activity;
   self-employed contributions entered for profits, fees and helping-spouse activities are
   deducted before the forfait (art. 52, 7°). The engine deducts the amount entered
   (`socialContributionsPaid`); `estimateSelfEmployedContributions(netProfessionalIncome, table)`
   in `socialSecurity.ts` estimates the RSVZ main-occupation contributions (20.50% up to the
   first threshold on at least the minimum income, 14.16% up to the second, per-year thresholds
   in `selfEmployedContributions`) for the phase B2 UI and is not used by the engine.
3. **Forfait per category and partner** (art. 51 al. 3): two part-time jobs share one capped
   forfait; trading profits form their own category (open item); helping spouses get 5%.
   Union dues count only inside an actual remuneration claim. A category never goes below 0.
4. **Alimony** at the year's deductible share, charged on the payer first and, under a joint
   assessment, on the other spouse for the balance (art. 105, 3°).
5. **Marital quotient** (joint only) on net professional income; the lower earner is topped up to
   30% of the total, capped (12,790 in IY 2026 when both spouses are 66 or older).
6. **Tax-free sum** per partner: basic amount and own disability supplement; dependent
   supplements to the higher taxable income under a joint assessment (to the claimant
   otherwise); the unused balance of one spouse moves to the other (art. 134).
7. **Tax per partner**, then reductions capped at that partner's tax, regional factor and
   communal surcharge.
8. **CSSS**: under a joint assessment the joint scale applies to both partners' net professional
   income (pensions excluded); otherwise the single scale per partner who is an employee.
9. Property tax for the home and the investment side calculation per partner.

The result lists per-partner and per-activity figures, the assessment decision with its legal
basis, totals and `issues`. An issue with severity `needs_source` marks a stated default that has
no verified source yet; each one is an open item in the matrix.

`toBelgianTaxCalculation(result, household)` returns the v1 `BelgianTaxCalculation` shape with
the same breakdown rows: income lines cover partners whose income is itemised, tax lines are
household totals. For one partner with one activity it equals `computeBelgianPIT`. A
`married_joint` v1 profile can differ after the upgrade where the household engine applies a rule
the v1 engine omits (the spouse's own exemption, disability and reductions, the art. 134 balance
transfer, the quotient on professional income only); the list is in
`__tests__/householdParity.ts`.

### Storage and upgrade

The household is stored under `belgian_tax_household_v2`, snapshots under
`belgian_tax_household_snapshots_v2`, whose year keys must equal the stored household's
`taxYear` (see [[docs/api/settings|Settings API]]). The frontend
upgrades v1 data automatically on first load with `upgradeProfileV1ToHousehold` and
`upgradeSnapshotsV1ToV2` (deterministic and idempotent; no confirmation step). The v1 fields map
to partner A and activity `act_A_1`; a `married_joint` profile adds partner B with a
`net_professional_amount` activity `act_B_1` and is assumed joint until relationship dates are
entered. Spouse fields on a single profile and unknown keys are kept under
`migratedFrom.unmappedFields`. `projectHouseholdToProfileV1` and
`applyProfileV1PatchToHousehold` serve v1-shaped editors during the transition. Frozen
snapshot meta may carry `frozenHouseholdResult`.

**Load (phase B2).** `BelgianTaxProfileProvider` loads `lib/belgianTax/householdRuntime.ts` with a
dynamic import, so the engine and its zod schemas stay out of the boot bundle, and resolves the
stored values with `loadHouseholdSettings`:

- A v2 value that passes `parseHouseholdV2` / `parseHouseholdSnapshotsV2` is used as stored and
  never rewritten on load.
- An absent v2 key is upgraded from the matching v1 key (or built from the v1 defaults when the
  v1 key is absent too). The v1 settings schema accepts `null` fields, so the upgrade treats
  `null` as absent and fills the v1 defaults into the live profile and into each v1 snapshot
  (a v1 snapshot without `region` takes the default region). When the v1 key exists, the
  upgraded v2 value is written immediately, but only if it passes `parseHouseholdV2` /
  `parseHouseholdSnapshotsV2`; otherwise it stays in memory unsaved and a console warning is
  logged, because the settings API would reject that write and every later save of the key.
- An invalid v2 value logs a console warning with the validation issues and the stored raw
  value, and falls back to the v1 upgrade or the defaults; it is not overwritten until the user
  edits. The store sets `storedHouseholdUnreadable`, and the tax overview's disclaimer banner
  then says that the saved household could not be read and that the next change replaces it.

The v1 keys are kept but no longer written: no backend code reads `belgian_tax_profile` or
`belgian_tax_profile_snapshots_v1` (reports receive the projected profile in the request body).

**Store.** `household` and `householdSnapshots` are the source of truth; `householdResult` holds
the raw `HouseholdTaxResult` (per partner, quotient, CSSS, issues). `calculation` is
`toBelgianTaxCalculation(computeHouseholdTax(household), household)`, and `calculationForYear`,
`displayCalculationForYear` and `resolveBelgianTaxCalculation` compute through the household of
that year. `profile`, `snapshots` and `profileForYear` are `projectHouseholdToProfileV1`
projections (filled with the v1 defaults), and `updateProfile` / `updateSnapshot` apply their v1
patches with `applyProfileV1PatchToHousehold`. A one-partner household gives the same calculation
as `computeBelgianPIT` on its projection. Freezing and filing store `frozenHouseholdResult` next
to `frozenCalculation`; unfreezing clears both. A `'patched'` audit entry records the v1
`changes` and the top-level `householdChanges`.

**Issues.** Each `HouseholdTaxIssueCode` and severity has an EN/NL string under
`tax.household.issue.*`. The tax overview lists the live year's issues, one line per code, in its
disclaimer banner.

**Demo.** The native Demo seeds `belgian_tax_household_v2` (partner A with the v1 figures, partner
B with an employee job of 22,000 gross, a marriage before the income year) next to the v1 row,
whose figures equal the household's v1 projection.

## Limitations / not modeled

- Brussels stamp-duty rebate (one-time, not annual).
- Flemish post-2020 mortgages (no successor regime — capital owners only).
- Walloon chèque habitat: the halving when the taxpayer acquires a second home, and the free split of the per-child increase between spouses (the household engine gives the whole credit to `mortgageCreditPartnerId`).
- Foreign tax credit on foreign dividends (DBI-RDT regime).
- Speculative capital gains (article 90, 1°).
- Securities account tax (TACR) for accounts ≥ €1M — values exposed in `BelgianTaxYearTable.securitiesAccountTaxRate` for future UI use.
- "Truly isolated" low-income single-parent additional supplement and its refundable-credit conversion: only the base €1,980 isolated-parent supplement is applied; the income-tested extra is not modeled.
- Reynders on mixed funds (post-ADR-057): the interest-attributable share is now configurable per investment via `reyndersInterestPortion` (range 0–1, default 1.0). For pure accumulating bond funds the default 100% portion matches reality; mixed funds need a manual lower value. The non-interest remainder routes to the 10% CGT pool from IY 2026 onwards.
- Capital gains tax (IY 2026, law of 6 April 2026, numac 2026002780; FPS circular 2026/C/74): the rate (10%) and the exemption of €10,000 **per taxpayer** (€20,000 for two spouses) are modeled. The tax applies to gains realized from **1 January 2026** (broker withholding starts 1 June 2026 but the full year is in scope). **Not** modeled: (a) the **31 Dec 2025 step-up basis** that shields pre-2026 historical gains — the calculator uses `realizedGain` against the original cost basis; (b) the per-taxpayer **carry-forward** of art. 96/2, 3° (an extra slice of base €480, set at €1,000 for AY 2028, per year without realised gains; at most base €2,426 used per period — there is no €20,000 carry-forward); (c) the **33% rate** on gains realized outside normal-management private estate; (d) direct-bond capital gains pre-2026 (correctly exempt under normal management — only the IY 2026+ inclusion is modeled, see ADR-057).

---

## Historical Year Viewer (ADR-058)

The Belgian Tax Overview and Portfolio Tax pages share a year switcher that lets the user view past income years without disturbing the live profile.

### Storage

- `belgian_tax_household_v2` — live, active household (always represents the user's current income year). Until phase B2 this was `belgian_tax_profile`, which is now only read once for the upgrade (see [Storage and upgrade](#storage-and-upgrade)).
- `belgian_tax_household_snapshots_v2` — JSONB `Record<incomeYear, BelgianTaxHouseholdV2>` of frozen snapshots (formerly `belgian_tax_profile_snapshots_v1`). Created automatically when the live household's `taxYear` advances; can also be seeded retroactively for years that show up in the year list only because of transaction data.

### Store and compatibility hook surface

| Member                         | Purpose                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `viewedYear` / `setViewedYear` | Transient UI year. Defaults to the live profile's `taxYear`; never persisted.               |
| `snapshots`                    | v1 projection of `householdSnapshots` (loaded from preload).                                |
| `profileForYear(y)`            | Returns snapshot when present, else live profile with `taxYear` overridden (estimate mode). |
| `calculationForYear(y)`        | Household engine on that year's household — live recompute.                                 |
| `snapshotExistsForYear(y)`     | Boolean.                                                                                    |
| `createSnapshotFromLive(y)`    | Seeds `snapshots[y]` from the live profile (no-op if one already exists).                   |
| `updateSnapshot(y, updates)`   | Patches a snapshot; strips `taxYear` from patches so the year stays pinned.                 |
| `isViewingHistorical`          | `viewedYear !== profile.taxYear`.                                                           |

### Year list (`useAvailableTaxYears`)

Sorted descending union of:

- the live year (always flagged `isCurrent`),
- snapshot years (`hasSnapshot: true`),
- years with portfolio transactions carrying `taxes`/`fees` (or `type === 'tax' | 'fee'`),
- years with transactions in user-configured taxable-income categories.

Each entry exposes `{ year, isCurrent, hasSnapshot, hasTransactions }` for the switcher chips.

### UI surfaces

- `TaxYearSwitcher` — dropdown trigger replacing the static "Tax year" badge on both `/tax` and `/portfolio/tax`. Each item shows a chip: **Current**, **Saved**, or **Data only**. Compact filed/frozen markers in this switcher and the comparison surfaces share `TaxYearStatusIcon`, with filed status taking precedence. A footer action "Create profile for {year}" appears when the viewed year is historical and has no snapshot yet.
- `HistoricalYearBanner` — shown above the page body when `isViewingHistorical` (via `HistoricalYearBannerSection`, still the composition used by `/portfolio/tax`). Two modes: `snapshot` (reconstructed from the saved profile) and `estimate` (live profile applied to that year's tax tables); the estimate mode exposes a primary CTA to seed the snapshot. On `/tax` this banner is no longer a separate element — `TaxFilingMasthead` renders the same modes and actions inline (see below).
- `TaxProfileDialog` is a right-hand `Sheet` with a segmented step picker (see [[docs/components/form-dialogs#TaxProfileDialog]]) and accepts an optional `targetYear` prop. When that year has a snapshot, the dialog reads/writes the snapshot and renders an amber warning banner; the snapshot's `taxYear` is locked.

### Overview-page composition — filing-year masthead + computation flow (Aug 2026)

`/tax` is composed as the document it models — a Belgian assessment notice (_aanslagbiljet_) — rather than as a generic KPI dashboard:

- **`TaxFilingMasthead`** (`features/tax/TaxFilingMasthead.tsx`) is the page's document head. It states the income year once, large (Fraunces, `glass-elevated` per ADR-105), with the filing status beside it (`live` / `estimate` / `snapshot` / `frozen` / `filed`, resolved by the same `resolveHistoricalBannerMode`), the region and marginal rate as meta, and the **effective burden as the single hero figure**. It absorbs the three outline badges the page used to render (`tax.overview.badge.*`, removed) and, on historical years, the `HistoricalYearBanner` text plus its "Create profile for {year}" / "Back to {year}" actions. `TaxYearSwitcher` and `YearActionsMenu` live inside it, so the year's identity reads as one thing.
- **`TaxComputationFlow`** (`features/tax/TaxComputationFlow.tsx`) replaces the seven same-weight stat tiles (`TaxOverviewSummaryCards`, removed) with one connected downward ledger: gross income → deductions → taxable income → federal PIT after reductions → municipal surcharge → total PIT → social security & property tax → total burden → net take-home, closed by a "beyond personal income tax" coda (portfolio taxes, total incl. portfolio, total incl. property estimate). Signed operation rows only restate relations `computeBelgianPIT` holds exactly; the bracket/exemption step is prose, because the regional autonomy factor makes it not a plain subtraction — `PitBreakdownCard` itemises it directly below.

Both components are pure presentation over `useTaxOverviewData`'s output: every figure is a pass-through read of `BelgianTaxCalculation`, and no value changed with the recomposition. The `summaryCards` widget id is unchanged (persisted visibility survives); only its label moved to "Computation Flow".

### URL State (year param, Aug 2026)

[[docs/components/hooks#usetaxyearparam-aug-2026|useTaxYearParam]] is mounted on both `TaxOverviewPage` and `PortfolioTaxPage` and mirrors `viewedYear` into `?year=`, replacing the previous behavior where reloading either route while viewing a historical year silently snapped back to the live year (easy to miss behind `HistoricalYearBanner`, and the figures differ). On mount, an incoming `?year=` is adopted into `viewedYear` when it has a stored snapshot or falls within ±30 years of the live year; otherwise it falls back to the live year. This makes "taxes 2023" shareable/bookmarkable across both tax routes.

### Page integration notes

- The yearly chart's `pitForGross` resolves each bar's base profile via `profileForYear(y.year)` so historical bars use the snapshot's inputs when available.
- The monthly tax-reserve chart is scoped to months _within_ the viewed year when historical; otherwise it keeps the trailing-12-month behavior.
- Both pages keep a `liveProfile` alias for the empty-state / "is the user set up at all" guard so historical viewing never re-triggers the setup wizard.

### Known limits

- **Engine drift.** When no calculation is frozen for a year (see ADR-059), past displayed numbers reflect today's `computeBelgianPIT` — engine bug fixes propagate retroactively. Freezing or filing a year captures the calculation verbatim and blocks drift for that year.
- **Exchange rates.** The tax report (`dataFetcherTax.js`) converts foreign-currency tax, fee, and dividend amounts at the exchange rate **on each transaction's date** (point-in-time), not today's rate — matching the Belgian rules for the TOB ("ECB rate of the day the transaction took place") and for foreign movable income (taxable at its date of collection). See ADR-085. The frontend tax-overview's live portfolio figures still display at current rates (a current-value concern, not the tax computation).
- **Soft lock.** Past snapshots remain editable behind a warning banner; filing upgrades the warning to an explicit "Amend this filed year" confirmation (ADR-059) but does not hard-freeze.

## Historical Year Extensions (ADR-059)

Layered on top of ADR-058. Adds engine-drift protection, a filed soft-lock, an audit log, multi-year comparison, a trend strip, and a CSV export.

### Storage

- `belgian_tax_profile_snapshot_meta_v1` — JSONB sparse `Record<incomeYear, BelgianTaxProfileSnapshotMeta>` sidecar. Meta entries are created lazily on first freeze / file / amendment; years without meta behave exactly as in ADR-058.

```ts
type BelgianTaxProfileSnapshotMeta = {
  frozenCalculation?: BelgianTaxCalculation; // "as-filed" calc, byte-stable
  frozenHouseholdResult?: HouseholdTaxResult; // household result frozen with it (ADR-200)
  filing?: { filedAt: string; reference?: string }; // present iff year is filed
  history?: SnapshotAuditEntry[]; // append-only, bounded
};
```

### Store and compatibility hook additions

| Member                                              | Purpose                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `snapshotMetas`                                     | Sparse per-year meta map.                                                                                                  |
| `metaForYear(y)`                                    | Returns the meta entry or `null`.                                                                                          |
| `isYearFiled(y)`                                    | Boolean — true iff `meta.filing` is set.                                                                                   |
| `getFrozenCalculation(y)`                           | Returns `meta.frozenCalculation` or `null`.                                                                                |
| `displayCalculationForYear(y)`                      | Frozen calc when present, else `calculationForYear(y)`. Use this on read sites.                                            |
| `getSnapshotHistory(y)`                             | Audit log entries (newest last).                                                                                           |
| `freezeCalculation(y)` / `unfreezeCalculation(y)`   | Capture / clear the as-filed calc.                                                                                         |
| `markYearAsFiled(y, ref?)` / `unmarkYearAsFiled(y)` | Toggle the filing record. Filing implies freezing (preserves an existing frozen calc); unfiling preserves the frozen calc. |

`createSnapshotFromLive` and `updateSnapshot` now also append `'created'` / `'patched'` entries to the meta history. Patches store only the diff (capped at 200 entries per year).

### UI surfaces

- **`MultiYearTrendStrip`** — compact clickable year tiles (ghost `Button`s with `aria-pressed`) in the page header showing PIT, effective rate, and a normalized bar. Clicking switches `viewedYear`.
- **`YearComparisonCard`** — side-by-side delta table comparing the viewed year against another year (picker; defaults to the immediately preceding tracked year). Surfaces gross income, total PIT, effective rate, net take-home.
- **`YearActionsMenu`** — the ••• "More actions" menu next to `TaxYearSwitcher` with freeze/unfreeze, mark/unmark filed, view history, export year as CSV. Pages pass their own items through `pageItems`: `/tax` adds Export PDF… and Customize…; `/portfolio/tax` adds Set up / Edit tax profile… and Customize…. On `/tax` the primary header button is _Set up tax profile_ or _Edit tax profile_; if the overview query errors, the header renders without these actions ([[docs/adr/187-completeness-sweep|ADR-187]]).
- **`MarkAsFiledDialog`** — collects an optional free-text filing reference (Tax-on-Web id, paper return code) before marking a year as filed.
- **`SnapshotHistoryDialog`** — read-only chronological list of audit entries with kind badge, timestamp, one-line patch summary, and the filing reference where applicable.
- **`HistoricalYearBanner`** extended with `filed` and `frozen` modes; priority order centralized in `resolveHistoricalBannerMode` and shared between `/tax` and `/portfolio/tax`.
- **`TaxProfileDialog`** upgrades the amber warning to an explicit "Amend this filed year" confirmation when editing a filed year; updates are blocked until the user opts in.

### CSV export

`exportTaxYearCsv` (in `apps/frontend/src/lib/belgianTax/exportTaxYearCsv.ts`) is a pure module that serialises a year's profile + calculation into a three-section CSV (metadata header, profile inputs, calculation breakdown). Values flow through `displayCalculationForYear` so filed/frozen years export their frozen numbers verbatim. Triggered from `YearActionsMenu` via the shared `downloadBlob` helper — no backend involvement.

### Behavioral rules

- **Filing implies freezing.** Marking a year filed captures the calculation if it isn't already frozen.
- **Pre-existing freezes win.** If a user deliberately froze a calc and _then_ filed, the deliberate freeze point is preserved.
- **Unfiling does _not_ unfreeze.** Unfiling is a clerical correction; the frozen calc is kept for the user's reference.
- **Banner priority.** `filed > frozen > snapshot > estimate`.
- **PIT-for-gross scaling.** The yearly chart's `pitForGross(gross, year)` helper scales the frozen PIT proportionally to the bar's gross income when a frozen calc exists, so historical filed bars stay aligned with the as-filed total.

## PDF Report Export

Tax data including Belgian tax profile and Personal Income Tax calculations can be exported as a comprehensive PDF report via the [[docs/features/pdf-report-export|PDF Report Export]] feature. The tax report (Phase 8, April 2026) includes:

- **Tax Executive Summary** — KPI grid with total taxes, fees, and effective rates
- **Tax Type Breakdown** — Horizontal bars of tax components (TOB, dividend WHT, capital gains, fees)
- **Tax by Asset Class** — Grouped bars showing taxes and fees per asset class
- **Monthly Tax Trend** — Stacked monthly bar chart of taxes and fees
- **Top Investments by Cost** — Ranked investments by total taxes and fees paid
- **Fee Breakdown** — Fee aggregation by asset class
- **Belgian Tax Rules Summary** — Static bracket/exemption tables + PIT summary when Belgian tax profile is active

See [[docs/api/reports#post-apireportstax|Reports API: Tax Endpoint]] for request/response details.

### Browser print layout

Printing `/tax` uses the current on-screen report rather than the server PDF endpoint. Print media
hides application chrome and interactive header controls, switches the report to a light paper
surface, removes glass blur and shadows, and avoids breaking cards, tables, and charts where the
browser can keep them together. The route scope prevents those rules from changing ordinary pages.

## Income included in acquired units

Proved Kinesis `included_in_units` income retains its literal amount and accounting role in source
history. It is excluded from ordinary dividend withholding estimates and dividend income totals;
this role does not establish a legal tax classification. The portfolio tax view discloses the
separate unclassified source income for the selected year. Tax report data keeps the role-aware
ordinary dividend exclusion; the executive summary adds no in-kind income paragraph. Explicit recorded source taxes and
fees remain recorded facts. See [[docs/adr/188-proved-in-kind-income-recognition|ADR-188]],
[[docs/features/portfolio]] and [[docs/features/pdf-report-export]].

## Related

- [[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021]] — Decimal.js adoption for monetary arithmetic (Phase 9); `portfolioTax.ts` follows the same pattern for frontend accumulation
- [[docs/adr/060-may-2026-monetary-precision-and-deduplication-audit|ADR-060]] — May 2026 audit that established the `apps/frontend/src/lib/decimal.ts` frontend Decimal module; `portfolioTax.ts` Decimal accumulation is consistent with this pattern
- [[docs/adr/053-belgian-pit-exemption-bracket-correction|ADR-053]] — Exemption-bracket calculation correction (May 2026)
- [[docs/adr/054-belgian-regional-own-home-credits|ADR-054]] — Regional own-home credits implementation (May 2026)
- [[docs/adr/055-belgian-tax-income-source-filtering|ADR-055]] — Taxable income source filtering (May 2026)
- [[docs/adr/056-belgian-tax-audit-fixes-ay2026|ADR-056]] — Comprehensive audit fixes (disabled-dependent doubling, child-under-3 forfeiture, regional autonomy factor, property-tax centimes, ETF TOB defaults, Reynders routing) (May 2026)
- [[docs/adr/057-belgian-tax-audit-followup-pwc-may-2026|ADR-057]] — Follow-up audit (TOB shares cap €4,000 → €1,600, CGT effective date 1 Jan 2026, direct-bond CGT routing, Reynders interest-portion split, year-aware `SuggestedDeductionsCard`, per-residence centimes override) (May 2026)
- [[docs/adr/058-belgian-tax-historical-year-snapshots|ADR-058]] — Historical year viewer with frozen per-year profile snapshots, shared switcher across `/tax` and `/portfolio/tax`, soft-lock past-edit mode (May 2026)
- [[docs/adr/059-belgian-tax-historical-year-extensions|ADR-059]] — As-filed frozen calculations, filed soft-lock, snapshot audit log, year-over-year comparison, multi-year trend strip, single-year CSV export (May 2026)
- [[docs/adr/199-belgian-tax-source-verification|ADR-199]] — Source-verified rule matrix; self-employed forfait, art. 88 quotient cap, CSSS scale and household base, frozen IY 2025 amounts, post-reform IY 2026 table (October 2026)
- [[docs/adr/200-belgian-tax-household-model|ADR-200]] — Household of one or two partners with income activities, date-derived assessment, v2 setting keys (October 2026)
- [[docs/reference/belgian-tax-rule-matrix|Belgian tax rule coverage matrix]] — per-rule sources, code and test locations
- [[docs/features/portfolio#belgian-tax-features]] — Tax fields in portfolio
- [[docs/features/portfolio#belgian-inflation-data-flow]] — Inflation data flow
- [[docs/features/pdf-report-export|PDF Report Export]] — Tax report generation with Phase 8 completion
- [[docs/adr/002-database-schema#belgian-inflation-rates]] — Database schema
- [[docs/integrations/index#government-data]] — Government data integrations

## Summary and supporting detail

The personal income tax breakdown starts collapsed beneath the summary, with its explanation and
full calculation table available on expansion. Reference rules also use a disclosure. Summary cards
size independently so explanatory text does not stretch neighbouring totals. These presentation
changes do not change tax calculations or profile inputs.
