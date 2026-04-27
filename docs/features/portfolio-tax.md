---
title: Portfolio Tax Feature
type: feature
status: active
date: 2026-04-02
tags: [feature, portfolio, tax, belgian, frontend, investments]
description: Portfolio-level tax tracking with recorded taxes, manual adjustments, per-investment breakdowns, and Belgian tax rule integration
aliases: [portfolio taxation, investment tax, capital gains tax, TOB]
related_code:
  - apps/frontend/src/pages/portfolio/PortfolioTaxPage.tsx
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

Located at `[[apps/frontend/src/pages/portfolio/PortfolioTaxPage.tsx]]` (708 lines).

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

| Field | Meaning |
|-------|---------|
| Dividend income tracked | Sum of all `dividend` transactions for the tax year, currency-converted |
| WHT paid (gross) | `totalDividendIncome × WHT rate` — withheld at source |
| WHT reclaimable | `min(totalDividendIncome, exemption) × WHT rate` — credited via tax return |
| Net WHT cost | Gross WHT − reclaim |

Plus:
- Total TOB recorded from buy-transaction taxes (currency-converted).

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
