---
title: Portfolio Tax Feature
type: feature
status: active
date: 2026-05-11
tags: [feature, portfolio, tax, belgian, frontend, investments, audit-2026-05-11, etf-structure, reynders-override, tax-classifications]
description: Portfolio-level tax tracking with recorded taxes, manual adjustments, per-investment breakdowns, and Belgian tax rule integration. May 2026: Added per-investment ETF structure (accumulating/distributing) and Reynders routing override metadata.
aliases: [portfolio taxation, investment tax, capital gains tax, TOB]
related_code:
  - apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx
  - apps/frontend/src/hooks/usePortfolioTaxAdjustments.ts
  - apps/frontend/src/components/portfolio/PortfolioTaxAdjustmentsDialog.tsx
  - apps/frontend/src/contexts/BelgianTaxProfileContext.tsx
---

# Portfolio Tax Feature

## Overview

The Portfolio Tax page (`/portfolio/tax`) tracks taxes and fees associated with investment transactions. It combines automatically recorded taxes from portfolio transactions with manual adjustments, providing a comprehensive view of investment-related tax costs for a given tax year.

## Architecture

### Tax Sources

The feature aggregates taxes from multiple sources:

1. **Recorded Taxes**: Extracted from portfolio transaction `taxes` and `fees` fields
   - Capital gains tax (sell transactions with taxes)
   - Dividend withholding (dividend transactions with taxes)
   - Transaction tax/TOB (buy transactions with taxes)
   - Explicit tax/fee transactions

2. **Manual Adjustments**: User-entered overrides stored in settings
   - Per-investment, per-year tax adjustments
   - Per-investment, per-year fee adjustments
   - Persisted via the Settings API under key `portfolio_tax_adjustments_v1`

### Total Calculation

```
totalTaxes = recordedTaxes + manualTaxes
totalFees = recordedFees + manualFees
totalCosts = totalTaxes + totalFees
```

## Frontend Page

Located at `[[apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx]]` (636 lines).

### Widgets

Uses `useWidgetVisibility` with 7 configurable widgets:

| Widget ID | Label Key | Default | Description |
|-----------|-----------|---------|-------------|
| `summaryCards` | `tax.widget.summaryCards` | Visible | 6 KPI cards (taxes, fees, costs, effective rate, total with PIT, manual adjustments) |
| `taxByAssetClass` | `tax.widget.taxByAssetClass` | Visible | Bar chart of taxes/fees by asset class |
| `taxTypes` | `tax.widget.taxTypes` | Visible | Breakdown by tax type (capital gains, dividend withholding, transaction tax, other) |
| `yearlyTaxFeeTrend` | `tax.widget.yearlyTaxFeeTrend` | Visible | Monthly stacked bar chart of taxes + fees |
| `investmentBreakdown` | `tax.widget.investmentBreakdown` | Visible | Per-investment detail cards |
| `profileInputs` | `tax.widget.profileInputs` | Visible | Current Belgian tax profile inputs |
| `belgianRules` | `tax.widget.belgianRules` | Visible | Belgian-specific tax rules and estimates |

### Summary Cards

1. **Total Taxes Paid**: Across all investments for the tax year
2. **Total Fees Paid**: Broker and management fees
3. **Total Costs**: Combined taxes and fees
4. **Effective Tax Rate**: Taxes as percentage of realized gains
5. **Total with PIT**: Portfolio taxes + Personal Income Tax from Belgian profile
6. **Manual Adjustments**: Total manually entered adjustments

## Tax Classification Metadata (May 2026 Audit)

Per-investment tax classification metadata is now persisted via `usePortfolioTaxClassifications` hook:

| Field | Type | Purpose |
|-------|------|---------|
| `etfStructure` | `'accumulating' \| 'distributing'` | Determines TOB rate (1.32% for accumulating, 0.12% for distributing). Default: `'accumulating'` (May 2026: flipped from distributing to match 80%+ retail market). |
| `subjectToReynders` | `boolean \| undefined` | Explicit override. `true` → bond / mixed-bond fund (Reynders applies). `false` → direct bond (exempt pre-2026; subject to 10% CGT from IY 2026 onwards). `undefined` → fall back to assetClass-based default. |
| `reyndersInterestPortion` | `number \| undefined` | Share of realised gain attributable to interest (0–1), taxed at 30% under Reynders. Default 1.0 (pure accumulating bond fund). Remainder routes to 10% CGT from IY 2026 onwards. Stored only when ≠ 1.0 to keep persisted state tidy. |

Storage: Settings API key `portfolio_tax_classifications_v1` (JSONB).

## Manual Tax Adjustments

### Hook: usePortfolioTaxAdjustments

Located at `[[apps/frontend/src/hooks/usePortfolioTaxAdjustments.ts]]`:

```typescript
type AdjustmentEntry = { taxes: number; fees: number };
type PortfolioTaxAdjustmentMap = Record<string, AdjustmentEntry>;
// Key format: "taxYear:investmentId"
```

**API**:
- `getAdjustment(taxYear, investmentId)` — Get adjustment for a specific investment/year
- `setAdjustment(taxYear, investmentId, entry)` — Set a single adjustment
- `setManyForYear(taxYear, values)` — Set multiple adjustments for a year
- `saveManyForYear(taxYear, values)` — Set and persist to backend
- `saveAdjustments(next?)` — Persist current state
- `byYear(taxYear)` — Get all adjustments for a year

### Storage

Adjustments are stored as a JSONB value in the `settings` table under key `portfolio_tax_adjustments_v1`. The hook uses `SettingsPreloadContext` for initial load and the Settings API for persistence.

## Belgian Tax Integration

The page integrates with the `BelgianTaxProfileContext` to:

1. **Display profile inputs**: Employment type, gross income, dependents, etc.
2. **Calculate total tax burden**: Portfolio taxes + Personal Income Tax (PIT)
3. **Estimate dividend withholding tax**:
   - Belgian dividend exemption: €859
   - Estimated WHT: 30% on amount above exemption
4. **Track TOB (Transaction Tax on Securities)**: Recorded from buy transaction taxes

### Belgian Rules Widget

Shows the year-aware dividend WHT picture (using the active year's `dividendExemption` and `dividendWHTRate` from `getTaxTable`):

| Field | Calculation |
|-------|---------|
| Dividend income tracked | Sum of all `dividend` transaction `amount` fields for the tax year, currency-converted |
| WHT paid (gross) | Sum of all `dividend` transaction `taxes` fields for the tax year (actual recorded WHT, not estimated) |
| Gross dividend base | `totalDividendIncome + dividendWhtRecorded` — works for both net-in-amount and gross-in-amount recording conventions |
| WHT reclaimable | `min(dividendWhtRecorded, min(grossDividendBase, €859) × 30%)` — capped by both recorded WHT and the exemption threshold |
| Net WHT cost | `max(grossDividendWht − dividendWhtReclaim, 0)` — after reclaim |

Plus:
- Total TOB recorded from buy-transaction taxes (currency-converted).

### Capital Gains Estimation (Arizona Reform / CGT)

The portfolio tax page estimates two types of modern capital gains taxation:

1. **Reynders tax (30%)** — Applied to the *interest-attributable* portion of gains on bond and mixed-bond funds. Resolution order: explicit `subjectToReynders` override, else `assetClass === 'bond'` falls back to true (bond-fund proxy). The interest share is configured per-investment via `reyndersInterestPortion` (range 0–1, default 1.0). For IY 2026+, the *non-interest remainder* (1 − portion) is taxed at 10% under the Arizona CGT — see point 2.

2. **Arizona CGT (10%)** — Applied to:
   - Equity and equity-ETF realised gains,
   - Reynders non-interest remainder (post-2026 split, per EY guidance),
   - **Direct bonds** when held in IY 2026+ (pre-2026 they remain exempt under normal-management private estate).
   
   Annual exemptions: €10,000 (single) / €20,000 (married).

> [!warning] CGT Modeling Limitations
> The 10% capital-gains tax (Arizona reform, effective **1 January 2026**) is estimated here using simplified assumptions. Broker-level withholding only starts 1 June 2026, but the taxable event covers the full year. The calculator does **not** model: (a) the 31 Dec 2025 step-up basis that shields historical gains (the page uses the existing `realizedGain`, which assumes original cost basis), (b) the 5-year +€1k/year carryforward of unused exemption (cumulative cap €5k single / €10k married), (c) the 33% rate on gains outside normal-management private estate. For detailed information on these limitations, see [[docs/features/belgian-tax#limitations-not-modeled|Belgian Tax Limitations]].

### TOB (Stock Exchange Tax) caps

TOB is rate-banded with statutory per-transaction caps:

| Rate | Instrument | Cap per tx |
|------|------------|-----------|
| 0.12% | Bonds, distributing funds | €1,300 |
| 0.35% | Shares / other equities | €1,600 |
| 1.32% | Accumulating funds | €4,000 |

The cap is a function of the rate, not the instrument. A €1M share buy at 0.35% caps at **€1,600**, not €3,500.

## Tax Breakdown Categories

### Tax Types
- **Capital Gains Tax**: From sell transactions with taxes
- **Dividend Withholding**: From dividend transactions with taxes
- **Transaction Tax (TOB)**: From buy transactions with taxes
- **Other Taxes**: From explicit tax-type transactions
- **Manual Tax Adjustments**: User-entered overrides

### Fee Types
- **Broker Fees**: From buy/sell transaction fees
- **Management Fees**: From explicit fee-type transactions
- **Other Fees**: Other recorded fees
- **Manual Fee Adjustments**: User-entered overrides

## Currency Handling

All amounts are converted to the target currency (`appSettings.defaultCurrency`) using exchange rates fetched from the Exchange Rates API:

```typescript
function convertToTarget(amount: number, fromCurrency?: string) {
  const rateFrom = ratesToEur[from];
  const rateTo = ratesToEur[to];
  return (amount * rateFrom) / rateTo;
}
```

**Conversion coverage (2026-04-26 fix):** the per-investment summary, tax/fee type breakdown, monthly tax/fee trend, total realized & unrealized gain, total dividend income, and TOB total all run through `convertToTarget`. An earlier implementation skipped conversion in the monthly trend chart and on `realizedGain`, which mixed native transaction currencies into the displayed totals.

## Query Configuration

```typescript
useQuery({
  queryKey: ['exchange-rates', targetCurrency],
  queryFn: () => apiClient.request('/api/info/exchange-rates'),
  staleTime: 60_000,
})
```

The page relies on `usePortfolio()` for investment summaries rather than a dedicated API endpoint.

## Related Features

- [[docs/features/belgian-tax|Belgian Tax]] — Budget-side tax tracking (personal income tax)
- [[docs/features/portfolio|Portfolio]] — Investment management and tracking
- [[docs/features/exchange-rates|Exchange Rates]] — Currency conversion for multi-currency investments
- [[docs/adr/056-belgian-tax-audit-fixes-ay2026|ADR-056]] — Comprehensive audit fixes (ETF TOB defaults, Reynders routing, property tax, regional autonomy)
- [[docs/adr/057-belgian-tax-audit-followup-pwc-may-2026|ADR-057]] — Follow-up audit: TOB shares cap fix, CGT date docs, direct-bond CGT routing, Reynders interest-portion split, year-aware suggestions, per-residence centimes override
