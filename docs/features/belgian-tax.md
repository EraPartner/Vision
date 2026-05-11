---
title: Feature - Belgian Tax
type: feature
status: active
date: 2026-05-11
tags: [feature, tax, belgian, cadastral-income, deductions, phase-8, pdf-export, regional-own-home-credit, exemption-brackets, taxable-income-sources, audit-2026-05-11, disabled-dependents, regional-autonomy-factor, property-tax-centimes, etf-tob, reynders-routing]
description: Belgian tax profile management with PIT calculator using exemption-bracket method (CIR-92 art. 134 §3), regional own-home credits (Flemish woonbonus, Walloon chèque habitat), taxable income source filtering, cadastral income tracking, deduction management, PDF tax report export, and May 2026 PwC audit fixes (disabled-dependent doubling, child-under-3 forfeiture, regional autonomy factor, property-tax centimes calibration)
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

- PwC *Worldwide Tax Summaries — Belgium — Individual* (cross-checked Feb 2026; AY 2026 audit completed May 2026).
- FOD Financiën / SPF Finances published indexed amounts (Moniteur belge / Belgisch Staatsblad).
- Federal personenbelasting / impôt des personnes physiques indexation tables.
- Internal sample calculations validating exemption-bracket valuation, regional autonomy factors, and property-tax centimes.

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

| Field | Description |
|-------|-------------|
| Employment type | `employee` / `civil_servant` / `self_employed` / `director` / `retired` / `other` |
| Gross annual income | Salary / pension / freelance gross |
| Other taxable income | Rental, additional freelance, etc. |
| Region | Flanders / Wallonia / Brussels |
| Communal surcharge % | Local surcharge on federal PIT |
| Dependent children | Total count |
| Dependent children (disabled) | Sub-count of disabled children — each counts as TWO per CIR-92 art. 132 4° (optional, clamped to total children) |
| Other dependents | Other persons ten laste / à charge |
| Other dependents (disabled) | Sub-count of disabled other dependents — each counts as TWO per CIR-92 art. 136 (optional, clamped to total) |
| Dependents under 3 | Sub-count of children under 3 (forfeited if childcare reduction claimed per CIR-92 art. 132bis) |
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
5. Personal exemption (`quotité du revenu exempté`): basic + dependents (with disabled count doubling per CIR-92 art. 132 4° / 136) + under-3 (forfeited if childcare claimed per CIR-92 art. 132bis) + other dependents + disability + single-parent supplements; applied at the **lowest brackets first** via a dedicated exemption-bracket rate table (CIR-92 art. 134 §3). The exemption amount is taxed from bracket 1 upward using reduced rates (25% on bracket-1 portion, 30% on bracket-2 overflow, then main rates above), and the result is subtracted from gross PIT and reported as `personalExemptionBenefit`. Disabled dependents count as TWO heads each; `dependentChildrenDisabled` and `dependentOtherPersonsDisabled` are clamped to their respective head counts.
6. Regional own-home credit (optional): Applies to mortgages on the taxpayer's primary residence.
   - **Flemish woonbonus (pre-2020 loans)** — two sub-regimes by origination year:
     - *Pre-2016 "ordinary" woonbonus*: base cap €2,280 (IY 2025).
     - *2016-2019 "geïntegreerde" woonbonus*: base cap €1,520 (IY 2025; the 2016 reform merged the ordinary and housing credits into a single, reduced-cap scheme).
     - Both share the same +€760 first-10-year supplement, +€80 3+-children supplement, and 40% rate.
     - Credit = min(interest + capital repaid, base cap + supplements) × 40%.
   - **Walloon `chèque habitat` (post-2016 loans, first 10 years)**: Credit = base annual amount + (dependent children × €125/child). [Note: Actual scheme has income-based phaseouts and years 11–20 tail; simplified here.]
   - **Brussels & post-2020 Flanders**: Not modeled (regime = 'none', credit = 0).
7. Tax credits ("réductions d'impôt"): pension savings (€1,050 @30% or €1,350 @25%), life insurance (€2,530 @30%), employee group insurance (30%), donations (45%, ≥€40), childcare (45%, €16.90/day cap), domestic help (30%, €8,290 wage cap). All require an explicit eligibility flag in the profile. Tax credits are clamped so the total cannot reduce federal PIT below zero.
8. **Regional autonomy factor** (May 2026 audit): Multiply federal PIT after credits by region-specific factor (Flanders: 0.9951, Wallonia: 0.9951, Brussels: 0.9945) to reflect region's own tax adjustments before communal surcharge.
9. Communal surcharge applied to federal PIT after regional autonomy factor.
10. Special social security contribution: CSSS is a step function of net taxable income (€0 below €18,592 → flat tiers → cap €731.28).
11. Property tax (informational, not part of PIT): `nominalCI × indexationCoefficient × regionalBaseRate × (1 + centimes/100)`, summed across main + additional residences. **May 2026 audit:** centimes reductions calibrated to Belgium-wide commune medians (Flanders 1450→1100, Wallonia 4000→3300, Brussels 4500→4200) to align estimates with typical 20–50%-of-indexed-CI range.
12. Investment side calc:
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

- Brussels stamp-duty rebate (one-time, not annual).
- Flemish post-2020 mortgages (no successor regime — capital owners only).
- Regional own-home credit income-based phaseouts and year-11–20 decreasing tail (Walloon chèque habitat especially).
- Foreign tax credit on foreign dividends (DBI-RDT regime).
- Speculative capital gains (article 90, 1°).
- Securities account tax (TACR) for accounts ≥ €1M — values exposed in `BelgianTaxYearTable.securitiesAccountTaxRate` for future UI use.
- "Truly isolated" low-income single-parent additional supplement and its refundable-credit conversion: only the base €1,980 isolated-parent supplement is applied; the income-tested extra is not modeled.
- Reynders on mixed funds (post-ADR-057): the interest-attributable share is now configurable per investment via `reyndersInterestPortion` (range 0–1, default 1.0). For pure accumulating bond funds the default 100% portion matches reality; mixed funds need a manual lower value. The non-interest remainder routes to the 10% CGT pool from IY 2026 onwards.
- Arizona capital gains tax (IY 2026): the rate (10%) and exemption (€10,000 single / €20,000 married) are modeled. The tax applies to gains realized from **1 January 2026** (broker withholding starts 1 June 2026 but the full year is in scope). **Not** modeled: (a) the **31 Dec 2025 step-up basis** that shields pre-2026 historical gains — the calculator uses `realizedGain` against the original cost basis; (b) the **5-year +€1k/year carryforward** of unused exemption (cumulative cap €5k single / €10k married, so the annual exemption can grow to €15k / €30k after five unused years); (c) the **33% rate** on gains realized outside normal-management private estate; (d) direct-bond capital gains pre-2026 (correctly exempt under normal management — only the IY 2026+ inclusion is modeled, see ADR-057).

---

## Historical Year Viewer (ADR-058)

The Belgian Tax Overview and Portfolio Tax pages share a year switcher that lets the user view past income years without disturbing the live profile.

### Storage

- `belgian_tax_profile` — live, active profile (always represents the user's current income year).
- `belgian_tax_profile_snapshots_v1` — JSONB `Record<incomeYear, BelgianTaxProfile>` of frozen snapshots. Created automatically when the live profile's `taxYear` advances; can also be seeded retroactively for years that show up in the year list only because of transaction data.

### Provider surface (`BelgianTaxProfileContext`)

| Member | Purpose |
|---|---|
| `viewedYear` / `setViewedYear` | Transient UI year. Defaults to the live profile's `taxYear`; never persisted. |
| `snapshots` | Loaded from preload. |
| `profileForYear(y)` | Returns snapshot when present, else live profile with `taxYear` overridden (estimate mode). |
| `calculationForYear(y)` | `computeBelgianPIT(profileForYear(y))` — live recompute. |
| `snapshotExistsForYear(y)` | Boolean. |
| `createSnapshotFromLive(y)` | Seeds `snapshots[y]` from the live profile (no-op if one already exists). |
| `updateSnapshot(y, updates)` | Patches a snapshot; strips `taxYear` from patches so the year stays pinned. |
| `isViewingHistorical` | `viewedYear !== profile.taxYear`. |

### Year list (`useAvailableTaxYears`)

Sorted descending union of:
- the live year (always flagged `isCurrent`),
- snapshot years (`hasSnapshot: true`),
- years with portfolio transactions carrying `taxes`/`fees` (or `type === 'tax' | 'fee'`),
- years with transactions in user-configured taxable-income categories.

Each entry exposes `{ year, isCurrent, hasSnapshot, hasTransactions }` for the switcher chips.

### UI surfaces

- `TaxYearSwitcher` — dropdown trigger replacing the static "Tax year" badge on both `/tax` and `/portfolio/tax`. Each item shows a chip: **Current**, **Saved**, or **Data only**. A footer action "Create profile for {year}" appears when the viewed year is historical and has no snapshot yet.
- `HistoricalYearBanner` — shown above the page body when `isViewingHistorical`. Two modes: `snapshot` (reconstructed from the saved profile) and `estimate` (live profile applied to that year's tax tables); the estimate mode exposes a primary CTA to seed the snapshot.
- `TaxProfileDialog` accepts an optional `targetYear` prop. When that year has a snapshot, the dialog reads/writes the snapshot and renders an amber warning banner; the snapshot's `taxYear` is locked.

### Page integration notes

- The yearly chart's `pitForGross` resolves each bar's base profile via `profileForYear(y.year)` so historical bars use the snapshot's inputs when available.
- The monthly tax-reserve chart is scoped to months *within* the viewed year when historical; otherwise it keeps the trailing-12-month behavior.
- Both pages keep a `liveProfile` alias for the empty-state / "is the user set up at all" guard so historical viewing never re-triggers the setup wizard.

### Known limits

- **Engine drift.** Past displayed numbers reflect today's `computeBelgianPIT`; engine bug fixes propagate retroactively (by design — no calc snapshot).
- **Exchange rates.** Multi-currency conversion still uses today's rates, not point-in-time rates. Out of scope for ADR-058.
- **Soft lock.** Past snapshots remain editable behind a warning banner rather than being hard-frozen.

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
- [[docs/adr/056-belgian-tax-audit-fixes-ay2026|ADR-056]] — Comprehensive audit fixes (disabled-dependent doubling, child-under-3 forfeiture, regional autonomy factor, property-tax centimes, ETF TOB defaults, Reynders routing) (May 2026)
- [[docs/adr/057-belgian-tax-audit-followup-pwc-may-2026|ADR-057]] — Follow-up audit (TOB shares cap €4,000 → €1,600, CGT effective date 1 Jan 2026, direct-bond CGT routing, Reynders interest-portion split, year-aware `SuggestedDeductionsCard`, per-residence centimes override) (May 2026)
- [[docs/adr/058-belgian-tax-historical-year-snapshots|ADR-058]] — Historical year viewer with frozen per-year profile snapshots, shared switcher across `/tax` and `/portfolio/tax`, soft-lock past-edit mode (May 2026)
- [[docs/features/portfolio#belgian-tax-features]] — Tax fields in portfolio
- [[docs/features/portfolio#belgian-inflation-data-flow]] — Inflation data flow
- [[docs/features/pdf-report-export|PDF Report Export]] — Tax report generation with Phase 8 completion
- [[docs/adr/002-database-schema#belgian-inflation-rates]] — Database schema
- [[docs/integrations/index#government-data]] — Government data integrations
