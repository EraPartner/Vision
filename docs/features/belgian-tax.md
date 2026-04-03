---
title: Feature - Belgian Tax
type: feature
status: active
date: 2026-04-02
tags: [feature, tax, belgian, cadastral-income, deductions]
description: Belgian tax profile management, cadastral income tracking, and deduction management
aliases: [belgian-tax, tax-feature, cadastral, deductions, belgium]
related_code: ["apps/frontend/src/pages/TaxOverviewPage.tsx", "apps/frontend/src/components/tax/TaxProfileDialog.tsx", "apps/frontend/src/components/tax/SuggestedDeductionsCard.tsx", "apps/frontend/src/contexts/BelgianTaxProfileContext.tsx", "apps/node-backend/src/services/belgianInflationService.js"]
---

# Feature: Belgian Tax

## Overview

Vision includes Belgian-specific tax features to support local tax filing requirements, including cadastral income tracking for real estate, tax-deductible expense management, and inflation-adjusted portfolio returns.

---

## Tax Profile

### Data Tracked

| Field | Description |
|-------|-------------|
| Municipality name | Belgian municipality of residence |
| Municipality tax rate | Local tax rate (varies by municipality) |
| Cadastral income | Estimated rental value of real estate (kadastraal inkomen) |
| Property details | Address, type, ownership percentage |

### Context

`BelgianTaxProfileContext.tsx` provides tax profile data throughout the application.

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

## Portfolio Tax Page (`/portfolio/tax`)

### Features

- **Tax-adjusted returns**: Portfolio returns adjusted for Belgian tax rates
- **Inflation-adjusted values**: Real returns using Belgian inflation data
- **Tax deductions tracking**: Track tax-deductible investment expenses

### Cross-Currency Normalization

All monetary displays on the Portfolio Tax page are converted to `appSettings.defaultCurrency` using live exchange rates from `/api/info/exchange-rates`.

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

---

## Related

- [[docs/features/portfolio#belgian-tax-features]] — Tax fields in portfolio
- [[docs/features/portfolio#belgian-inflation-data-flow]] — Inflation data flow
- [[docs/adr/002-database-schema#belgian-inflation-rates]] — Database schema
- [[docs/integrations/index#government-data]] — Government data integrations
