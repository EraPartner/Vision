---
title: Features Documentation Index
type: features-index
status: active
date: 2026-04-16
tags: [features, index, documentation, phase-6]
description: Feature documentation for all major capabilities of the Vision application
aliases: [features, capabilities]
---

# Features Documentation

> [!abstract] Overview
> Documentation for all major features in Vision, from core transaction management to portfolio tracking and Belgian tax support.

## All Features

```dataview
TABLE WITHOUT FILE title AS "Feature", description AS "Description", date AS "Updated"
FROM "docs/features"
WHERE type = "feature"
SORT title ASC
```

## Feature Categories

### Core Features
- [[docs/features/views\|Views & Pages]] - Complete overview of all views and pages
- [[docs/features/transactions\|Transactions]] - Core financial transaction management
- [[docs/features/import\|Imports]] - CSV import with deduplication

### Organization
- [[docs/features/categories\|Categories]] - Transaction categorization with GENERAL:DETAIL format and atomic assignment (Phase 6)
- [[docs/features/recipients\|Recipients]] - Payee/payer management with atomic merge and fuzzy matching (Phase 6)
- [[docs/api/categories\|Categories API]] - REST endpoint contract
- [[docs/api/recipients\|Recipients API]] - REST endpoint contract

### Planning & Scheduling
- [[docs/features/plannedTransactions\|Planned Payments]] - Scheduled and recurring transactions, including loan support

### Portfolio & Investments
- [[docs/features/portfolio\|Portfolio]] - Investment tracking (stocks, ETFs, crypto, metals, real estate, savings, bonds)
- [[docs/features/net-worth\|Net Worth]] - Daily net worth tracking with zoomable charts and LTTB downsampling
- [[docs/features/exchange-rates\|Exchange Rates]] - Live ECB rates, fallback rates, and manual refresh
- [[docs/features/watchlist\|Watchlist]] - Security tracking with target price alerts
- [[docs/features/market-lookup\|Market Lookup]] - Search and add securities to portfolio
- [[docs/features/portfolio-tax\|Portfolio Tax]] - Investment tax tracking with manual adjustments

### Tax
- [[docs/features/belgian-tax\|Belgian Tax]] - Tax profile, cadastral income, deductions, inflation

### Shared Expenses
- [[docs/features/splits\|Splits & Owes]] - Transaction splitting and debt tracking

### Analytics & Reporting
- [[docs/features/statistics\|Statistics]] - Comprehensive analytics with charts, pivot tables, and exclusions
- [[docs/features/recipient-insights\|Recipient Insights]] - Merchant spending analytics with MoM alerts
- [[docs/features/saved-charts\|Saved Charts]] - Custom category charts that persist across sessions

### User Experience
- [[docs/features/onboarding\|Onboarding]] - First-run setup wizard
- [[docs/features/settings\|Settings]] - Application preferences with JSONB storage and preload optimization

## Related Documentation

- [[docs/api/index\|API Documentation]] - Endpoints that power these features
- [[docs/components/index\|Components]] - Frontend components implementing these features
- [[docs/integrations/index\|Integrations]] - External services used by features
