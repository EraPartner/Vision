---
title: Feature - Belgian Tax
type: feature
status: active
date: 2026-04-27
tags: [feature, tax, belgian, cadastral-income, deductions, phase-8, pdf-export]
description: Belgian tax profile management, year-aware PIT calculator, cadastral income tracking, deduction management, and PDF tax report export (Phase 8)
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

`SUPPORTED_TAX_YEARS` lists the years with a complete table; `LATEST_TAX_YEAR` is the default. New years are added by appending a `BelgianTaxYearTable` entry — no calculator changes required.

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
| Alimony / pension savings / life insurance / donations / childcare / domestic help | With per-item eligibility flags |
| Annual dividend income | Drives WHT reclaim estimate |
| Annual savings interest | Drives 15% above-exemption tax estimate |
| Tax year | Income year — selects the corresponding bracket table |

### Employment type → professional expense forfait

Per PwC, only employees / civil servants get the 30% forfait (cap €5,930 IY 2025). Remunerated company directors get the 3% forfait (cap €3,130 IY 2025). Self-employed / freelancers get **no** statutory forfait — only actual professional expenses are deductible. This is enforced in `computeProfessionalExpenses` in [pit.ts](apps/frontend/src/lib/belgianTax/pit.ts).

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
5. Personal exemption (`quotité du revenu exempté`): basic + dependents + under-3 + other dependents + disability + single-parent supplements; applied at the **lowest brackets first** by computing tax on income with and without the exemption and reporting the difference as `personalExemptionBenefit`.
6. Tax credits ("réductions d'impôt"): pension savings (€1,050 @30% or €1,350 @25%), life insurance (€2,530 @30%), employee group insurance (30%), donations (45%, ≥€40), childcare (45%, €16.90/day cap), domestic help (30%, €8,290 wage cap). All require an explicit eligibility flag in the profile.
7. Communal surcharge applied to federal PIT after credits.
8. Special social security contribution: CSSS is a step function of net taxable income (€0 below €18,592 → flat tiers → cap €731.28).
9. Property tax (informational, not part of PIT): `nominalCI × indexationCoefficient × regionalBaseRate × (1 + centimes/100)`, summed across main + additional residences.
10. Investment side calc:
    - `dividendWhtReclaim = min(dividendIncome, exemption) × WHT_rate` — Belgian dividend withholding is taken at source on the **full** gross dividend; the €859 (IY 2025) exemption is reclaimed via the tax return.
    - `savingsInterestTax = max(savingsInterest − €1,050, 0) × 15%` — Reynders / savings deposit excess.

### Aggregate metrics (no double-counting)

- `totalPIT` = federal PIT after reductions + communal surcharge (income tax only).
- `totalTaxBurden` = `totalPIT` + employee SS + special SS + property tax estimate.

> **Regression note (2026-04-26):** an earlier implementation added the communal surcharge twice into `totalTaxBurden`. Covered now by [`pit.test.ts`](apps/frontend/src/lib/belgianTax/__tests__/pit.test.ts).

## Portfolio Tax Page (`/portfolio/tax`)

### Features

- **Tax-adjusted returns**: Portfolio returns adjusted for Belgian tax rates.
- **Inflation-adjusted values**: Real returns using Belgian inflation data.
- **Tax deductions tracking**: Track tax-deductible investment expenses.

### Dividend WHT widget (Belgian rules)

Replaces the prior single "Estimated dividend WHT" tile with three explicit values:

| Tile | Definition |
|------|------------|
| `WHT paid (gross)` | `totalDividendIncome × 30%` — withheld at source by the broker / paying agent |
| `WHT reclaimable` | `min(totalDividendIncome, exemption) × 30%` — credited via the personal income tax return |
| `Net WHT cost` | `gross WHT − reclaim` — the unrecoverable portion |

This corrects the earlier label which presented the unrecoverable portion as the gross WHT.

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
- Regional own-home credits (Flemish `geïntegreerde woonbonus`, Brussels abattement, etc.).
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

- [[docs/features/portfolio#belgian-tax-features]] — Tax fields in portfolio
- [[docs/features/portfolio#belgian-inflation-data-flow]] — Inflation data flow
- [[docs/features/pdf-report-export|PDF Report Export]] — Tax report generation with Phase 8 completion
- [[docs/adr/002-database-schema#belgian-inflation-rates]] — Database schema
- [[docs/integrations/index#government-data]] — Government data integrations
