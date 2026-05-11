---
title: Feature - Belgian Tax
type: feature
status: active
date: 2026-05-11
tags: [feature, tax, belgian, cadastral-income, deductions, phase-8, pdf-export, regional-own-home-credit, exemption-brackets, taxable-income-sources]
description: Belgian tax profile management with PIT calculator using exemption-bracket method (CIR-92 art. 134 §3), regional own-home credits (Flemish woonbonus, Walloon chèque habitat), taxable income source filtering, cadastral income tracking, deduction management, and PDF tax report export
aliases: [belgian-tax, tax-feature, cadastral, deductions, belgium]
related_code:
  - apps/frontend/src/pages/TaxOverviewPage.tsx
  - apps/frontend/src/components/tax/TaxProfileDialog.tsx
  - apps/frontend/src/components/tax/SuggestedDeductionsCard.tsx
  - apps/frontend/src/contexts/BelgianTaxProfileContext.tsx
  - apps/frontend/src/lib/belgianTax/pit.ts
  - apps/frontend/src/lib/belgianTax/constants.ts
  - apps/frontend/src/lib/belgianTax/socialSecurity.ts
  - apps/frontend/src/lib/belgianTax/propertyTax.ts
  - apps/node-backend/src/services/belgianInflationService.js
---

# Feature: Belgian Tax

## Overview

Vision includes Belgian-specific tax features to support local tax filing requirements:

- A year-aware Personal Income Tax (PIT) calculator (federal brackets, personal exemption, tax credits, communal surcharge, social security).
- Cadastral income tracking and a regional property tax (`précompte immobilier` / `onroerende voorheffing`) estimate.
- Deduction & credit suggestions matched to the user's profile.
- Inflation-adjusted portfolio returns using Statbel / Eurostat HICP data.

## Module layout

Pure tax logic lives in [[apps/frontend/src/lib/belgianTax]] and is split by concern:

| Module | Responsibility |
|--------|---------------|
| `types.ts` | `BelgianTaxProfile`, `BelgianTaxCalculation`, region & employment unions |
| `constants.ts` | Year-keyed `BelgianTaxYearTable` (IY 2024, IY 2025) — brackets, caps, rates |
| `pit.ts` | `computeBelgianPIT(profile)` — composes deductions, credits, surcharge |
| `socialSecurity.ts` | Employee SS + step-function special social security contribution (CSSS) |
| `propertyTax.ts` | Indexed cadastral × regional rate × centimes additionnels |
| `index.ts` | Public re-exports |

The React provider [[apps/frontend/src/contexts/BelgianTaxProfileContext]] only owns persistence + state; it re-exports the public surface so existing consumers keep working.

## Sources of truth

The reference tables (`getTaxTable(year)`) are populated from:

- PwC *Worldwide Tax Summaries — Belgium — Individual* (cross-checked Feb 2026).
- FOD Financiën / SPF Finances published indexed amounts (Moniteur belge / Belgisch Staatsblad).
- Federal personenbelasting / impôt des personnes physiques indexation tables.

`SUPPORTED_TAX_YEARS` (sorted numerically) lists the years with a complete table; `LATEST_TAX_YEAR` is the default.

**Tax table fallback:** The `getTaxTable(year)` function uses a nearest-year fallback:
- Years on or after the latest supported year → use LATEST table.
- Years between EARLIEST and LATEST → use the nearest supported year (no interpolation).
- Years before EARLIEST → use EARLIEST table, and `isApproximatedTaxYear(year)` returns `true` (triggering an "approximated" note in the UI).

New years are added by appending a `BelgianTaxYearTable` entry — no calculator changes required.

---

## Tax Profile

### Data tracked

| Field | Description |
|-------|-------------|
| Employment type | `employee` / `civil_servant` / `self_employed` / `director` / `retired` / `other` |
| Gross annual income | Salary / pension / freelance gross |
| Other taxable income | Rental, additional freelance, etc. |
| Region | Flanders / Wallonia / Brussels |
| Communal surcharge % | Local surcharge on federal PIT |
| Dependent children | Total + sub-count for under-3 supplement |
| Other dependents | Other persons ten laste / à charge |
| Disability flags | Self / spouse — each adds €1,980 to personal exemption |
| Single-parent flag | `isIsolatedParent` adds the single-parent supplement |
| Cadastral income + additional residences | For property tax estimate |
| Mortgage details | Interest, capital repaid, region, start year, primary residence status |
| Taxable income source categories | Filter for income categories included in tax calculations; used for graph filtering |
| Alimony / pension savings / life insurance / donations / childcare / domestic help | With per-item eligibility flags |
| Annual dividend income | Drives WHT reclaim estimate |
| Annual savings interest | Drives 15% above-exemption tax estimate |
| Tax year | Income year — selects the corresponding bracket table |

### Employment type → professional expense forfait

Per PwC, only employees / civil servants get the 30% forfait (cap €5,930 IY 2025). Remunerated company directors get the 3% forfait (cap €3,130 IY 2025). Self-employed / freelancers get **no** statutory forfait — only actual professional expenses are deductible. This is enforced in `computeProfessionalExpenses` in [pit.ts](apps/frontend/src/lib/belgianTax/pit.ts).

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

| Field | Type | Description |
|-------|------|-------------|
| municipality | VARCHAR(200) | Belgian municipality |
| cadastral_income | NUMERIC(12,2) | Kadastraal inkomen |
| municipality_tax_rate | NUMERIC(8,4) | Municipal tax rate |

**Migration:** `0010_investments_municipality_tax_fields.py`

---

## PIT calculation pipeline (`computeBelgianPIT`)

1. Gross = salary + other taxable income.
2. Employee social security: 13.07% (employee) / 11.07% (civil servant), salary only.
3. Professional expenses: lump-sum forfait (employee/director) or actual.
4. Deductions from taxable basis: alimony 80%, union dues, medical expenses.
5. Personal exemption (`quotité du revenu exempté`): basic + dependents + under-3 + other dependents + disability + single-parent supplements; applied at the **lowest brackets first** via a dedicated exemption-bracket rate table (CIR-92 art. 134 §3). The exemption amount is taxed from bracket 1 upward using reduced rates (25% on bracket-1 portion, 30% on bracket-2 overflow, then main rates above), and the result is subtracted from gross PIT and reported as `personalExemptionBenefit`.
6. Regional own-home credit (optional): Applies to mortgages on the taxpayer's primary residence.
   - **Flemish `geïntegreerde woonbonus` (pre-2020 loans)**: Credit = min(interest + capital repaid, base cap + first-10-year supplement + 3+-children supplement) × 40%.
   - **Walloon `chèque habitat` (post-2016 loans, first 10 years)**: Credit = base annual amount + (dependent children × €125/child). [Note: Actual scheme has income-based phaseouts and years 11–20 tail; simplified here.]
   - **Brussels & post-2020 Flanders**: Not modeled (regime = 'none', credit = 0).
7. Tax credits ("réductions d'impôt"): pension savings (€1,050 @30% or €1,350 @25%), life insurance (€2,530 @30%), employee group insurance (30%), donations (45%, ≥€40), childcare (45%, €16.90/day cap), domestic help (30%, €8,290 wage cap). All require an explicit eligibility flag in the profile. Tax credits are clamped so the total cannot reduce federal PIT below zero.
8. Communal surcharge applied to federal PIT after credits.
9. Special social security contribution: CSSS is a step function of net taxable income (€0 below €18,592 → flat tiers → cap €731.28).
10. Property tax (informational, not part of PIT): `nominalCI × indexationCoefficient × regionalBaseRate × (1 + centimes/100)`, summed across main + additional residences.
11. Investment side calc:
    - `dividendWhtReclaim = min(recordedWHT, min(grossDividendBase, exemption) × WHT_rate)` — Belgian dividend withholding is taken at source; reclaim is capped by both the recorded WHT and the exemption. Gross base = dividend amount + recorded WHT, which handles both net and gross recording conventions. The €859 (IY 2025) exemption applies to the gross base and is reclaimed via the tax return.
    - `savingsInterestTax = max(savingsInterest − €1,050, 0) × 15%` — Reynders / savings deposit excess.

### Calculation output fields

The `BelgianTaxCalculation` result object includes:

| Field | Definition |
|-------|-----------|
| `federalPITBeforeExemption` | Federal PIT before personal exemption deduction (formerly `federalPITTotal`; aliased for back-compat) |
| `personalExemptionBenefit` | Tax benefit from applying personal exemption via exemption-bracket table |
| `federalTaxCredits` | Total tax credits (pension savings, life insurance, donations, childcare, domestic help, etc.), clamped so sum ≤ `federalPITBeforeExemption` |
| `ownHomeCreditRegime` | Applicable regime: `'flemish_woonbonus'`, `'walloon_cheque_habitat'`, or `'none'` |
| `ownHomeCredit` | Regional own-home credit amount (0 if regime is `'none'`) |
| `totalPIT` | Federal PIT after exemption, credits, and communal surcharge (income tax only) |
| `totalTaxBurden` | `totalPIT` + employee SS + special SS + property tax estimate (no double-counting) |

> **Back-compat:** `federalPITTotal` is aliased to `federalPITBeforeExemption` for consumers expecting the old name.
> 
> **Regression note (2026-04-26):** an earlier implementation added the communal surcharge twice into `totalTaxBurden`. Covered now by [`pit.test.ts`](apps/frontend/src/lib/belgianTax/__tests__/pit.test.ts).

## Portfolio Tax Page (`/portfolio/tax`)

### Features

- **Tax-adjusted returns**: Portfolio returns adjusted for Belgian tax rates.
- **Inflation-adjusted values**: Real returns using Belgian inflation data.
- **Tax deductions tracking**: Track tax-deductible investment expenses.

### Dividend WHT widget (Belgian rules)

Shows four explicit values for dividend taxation:

| Tile | Definition |
|------|------------|
| `Dividend income tracked` | Sum of all `dividend` transaction amounts for the tax year |
| `WHT paid (gross)` | Sum of all recorded WHT from `dividend` transactions — actual withheld amount, not estimated |
| `WHT reclaimable` | `min(recordedWHT, min(totalDividendIncome + recordedWHT, €859) × 30%)` — capped by both recorded WHT and the exemption threshold applied to gross dividend base |
| `Net WHT cost` | `max(recordedWHT − reclaimable, 0)` — the unrecoverable portion |

The gross dividend base (`totalDividendIncome + recordedWHT`) works for both net-in-amount and gross-in-amount dividend recording conventions.

### Cross-Currency Normalization

All monetary displays on the Portfolio Tax page are converted to `appSettings.defaultCurrency` using live exchange rates from `/api/info/exchange-rates`. The yearly cost trend, total realized / unrealized gain, and tax/fee breakdowns now consistently apply the conversion (an earlier path mixed transaction-native currencies into the chart).

---

## Belgian Inflation Integration

### Data Sources

| Source | Priority | Description |
|--------|----------|-------------|
| **Statbel** | Primary | Belgian statistics office |
| **Eurostat HICP** | Fallback | Harmonised Index of Consumer Prices |
| **Persisted DB** | Last resort | Previously fetched data |

### Storage

Inflation data is persisted to `belgian_inflation_rates` table:

| Column | Type | Description |
|--------|------|-------------|
| month_date | DATE | First of month |
| monthly_rate | NUMERIC(10,8) | Monthly inflation rate |
| source | VARCHAR(50) | statbel or eurostat |
| fetched_at | TIMESTAMPTZ | Fetch timestamp |

### Usage

- **Performance calculations**: Real returns = nominal return - inflation
- **Net worth**: Inflation-adjusted portfolio values
- **Monthly compounding**: Rates compounded month-by-month using backend month keys

### API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/info/inflation-rates` | Get inflation rates |
| GET | `/api/info/inflation-rates?db_only=true` | Get from DB only (no remote fetch) |
| POST | `/api/info/inflation-rates/refresh` | Refresh from remote sources |

**Migration:** `0023_portfolio_performance_snapshots.py`

---

## Suggested Deductions

The tax overview page includes a `SuggestedDeductionsCard` component that suggests common Belgian tax deductions:
- Mortgage interest
- Pension savings
- Service vouchers
- Donations

## Limitations / not modeled

- Marital quotient and married/cohabiting joint-filing income split.
- Brussels stamp-duty rebate (one-time, not annual).
- Flemish post-2020 mortgages (no successor regime — capital owners only).
- Regional own-home credit income-based phaseouts and year-11–20 decreasing tail (Walloon chèque habitat especially).
- Reynders tax on accumulating bond fund redemptions (article 19bis).
- Foreign tax credit on foreign dividends (DBI-RDT regime).
- Speculative capital gains (article 90, 1°) — and the new 10% solidarity contribution that takes effect for income year 2026 onward.
- Securities account tax (TACR) for accounts ≥ €1M — values exposed in `BelgianTaxYearTable.securitiesAccountTaxRate` for future UI use.

---

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

## Related

- [[docs/adr/053-belgian-pit-exemption-bracket-correction|ADR-053]] — Exemption-bracket calculation correction (May 2026)
- [[docs/adr/054-belgian-regional-own-home-credits|ADR-054]] — Regional own-home credits implementation (May 2026)
- [[docs/adr/055-belgian-tax-income-source-filtering|ADR-055]] — Taxable income source filtering (May 2026)
- [[docs/features/portfolio#belgian-tax-features]] — Tax fields in portfolio
- [[docs/features/portfolio#belgian-inflation-data-flow]] — Inflation data flow
- [[docs/features/pdf-report-export|PDF Report Export]] — Tax report generation with Phase 8 completion
- [[docs/adr/002-database-schema#belgian-inflation-rates]] — Database schema
- [[docs/integrations/index#government-data]] — Government data integrations
