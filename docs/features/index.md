---
title: Features Documentation Index
type: features-index
status: active
date: 2026-04-24
updated: 2026-04-24
tags: [features, index, documentation, phase-5a, phase-6, phase-7, phase-10, phase-c, phase-d, phase-e, phase-f, phase-9, statistics-refactoring, bank-reconciliation, cash-flow-forecast, cost-basis, database-maintenance, sankey-flow, rolling-averages, pdf-report, admin-observability, multi-method-forecast, frontend-visualization, accuracy-persistence, materialized-cache, ensemble-methods, nightly-job]
description: Feature documentation for all major capabilities of the Vision application. Phase 6 complete with bank reconciliation, cash flow forecast, cost basis methods. Phase 7 adds database maintenance UI, Sankey flow visualization, rolling average overlays, and PDF report export. Phase 10 adds multi-method statistical cash flow forecast with 7 methods. Phase C adds dashboard frontend visualization. Phase D adds persisted accuracy metrics and historical trend analysis. Phase E adds nightly cache materialization for performance. Phase F adds inverse-MSE ensemble method (8th method). Phase 9 completes aggregation shadow cutover.
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
- [[docs/features/cash-flow-forecast\|Cash Flow Forecast]] - N-month forward projection from planned transactions (Phase 6) + 8-method statistical forecast for current month (Phase 10 + F: 7 base methods + inverse-MSE ensemble) + dashboard visualization with controls and diagnostics (Phase C) + persisted accuracy metrics and trend history (Phase D) + nightly cache materialization (Phase E)

### Bank Reconciliation (Phase 6)
- [[docs/features/bank-reconciliation\|Bank Reconciliation]] - Match bank statement entries to transactions with auto-match scoring

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
- [[docs/features/sankey-flow\|Sankey Flow]] - Income allocation visualization showing flow to spending categories (Phase 7)
- [[docs/features/rolling-averages\|Rolling Averages]] - 3-month moving average overlays on spending/income charts (Phase 7)
- [[docs/features/recipient-insights\|Recipient Insights]] - Merchant spending analytics with MoM alerts
- [[docs/features/saved-charts\|Saved Charts]] - Custom category charts that persist across sessions
- [[docs/features/pdf-report-export\|PDF Report Export]] - One-click PDF export of financial summary (Phase 7)

### User Experience
- [[docs/features/onboarding\|Onboarding]] - First-run setup wizard
- [[docs/features/settings\|Settings]] - Application preferences with JSONB storage and preload optimization
- [[docs/features/appearance\|Appearance]] - Theme variant selection with five color palettes, light/dark mode, and schedule-based transitions

### Administration & Maintenance (Phase 7, Phase F, Phase 9)
- [[docs/features/database-maintenance\|Database Maintenance]] - Table statistics monitoring and VACUUM operations
- [[docs/features/admin-observability\|Admin Observability]] - System health dashboards; shadow divergence monitoring removed in Phase 9, feature flags removed in Phase 9

### AI & Natural Language
- [[docs/features/ai-chat\|AI Chat]] - Local AI chat for natural-language financial queries with tool-calling (Ollama-powered)

## Related Documentation

- [[docs/api/index\|API Documentation]] - Endpoints that power these features
- [[docs/components/index\|Components]] - Frontend components implementing these features
- [[docs/integrations/index\|Integrations]] - External services used by features
