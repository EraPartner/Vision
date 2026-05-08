---
title: Features Documentation Index
type: features-index
status: active
date: 2026-04-24
updated: 2026-05-08
tags: [features, index, documentation, phase-5a, phase-6, phase-7, phase-10, phase-c, phase-d, phase-e, phase-f, phase-9, statistics-refactoring, cash-flow-forecast, cost-basis, database-maintenance, sankey-flow, rolling-averages, pdf-report, admin-observability, multi-method-forecast, frontend-visualization, accuracy-persistence, materialized-cache, ensemble-methods, nightly-job, bug-hunt-2026-05-05, bug-hunt-2026-05-06, phase-c-bug-fixes, accessibility, csv-parsing, memory-safety, debounce, useCallback, bulk-actions]
description: Feature documentation for all major capabilities of the Vision application. Phase 6 complete with cash flow forecast, cost basis methods. Phase 7 adds database maintenance UI, Sankey flow visualization, rolling average overlays, and PDF report export. Phase 10 adds multi-method statistical cash flow forecast with 7 methods. Phase C adds dashboard frontend visualization. Phase D adds persisted accuracy metrics and historical trend analysis. Phase E adds nightly cache materialization for performance. Phase F adds inverse-MSE ensemble method (8th method). Phase 9 completes aggregation shadow cutover. April 2026 extends Saved Charts with recipients, variants, time buckets, and date ranges; introduces Custom Charts tab in Statistics. May 2026 bulk transaction actions enable multi-row operations (delete, recategorize, reassign, activate/deactivate, export, tag); bug hunt completes comprehensive correctness hardening across frontend, backend, and Electron: mount guards, React key stability, decimal arithmetic, date/timezone safety, queryKey fixes, pagination guards, Electron hardening (window/navigation/backup restrictions), and release workflow version sync.
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
- [[docs/features/bulk-actions\|Bulk Actions]] - Multi-row select with atomic delete, recategorize, reassign, export, tag operations
- [[docs/api/categories\|Categories API]] - REST endpoint contract
- [[docs/api/recipients\|Recipients API]] - REST endpoint contract

### Planning & Scheduling
- [[docs/features/plannedTransactions\|Planned Payments]] - Scheduled and recurring transactions, including loan support
- [[docs/features/cash-flow-forecast\|Cash Flow Forecast]] - N-month forward projection from planned transactions (Phase 6) + 8-method statistical forecast for current month (Phase 10 + F: 7 base methods + inverse-MSE ensemble) + dashboard visualization with controls and diagnostics (Phase C) + persisted accuracy metrics and trend history (Phase D) + nightly cache materialization (Phase E)

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
- [[docs/features/application-updates\|Application Updates]] - Three deployment modes (dev, source, docker) with backup-before-update, SHA256 verification, and Docker pull (April 2026)

### Administration & Maintenance (Phase 7, Phase F, Phase 9)
- [[docs/features/database-maintenance\|Database Maintenance]] - Table statistics monitoring and VACUUM operations
- [[docs/features/admin-observability\|Admin Observability]] - System health dashboards; shadow divergence monitoring removed in Phase 9, feature flags removed in Phase 9

### AI & Natural Language
- [[docs/features/ai-chat\|AI Chat]] - Local AI chat for natural-language financial queries with tool-calling (Ollama-powered)

## Phase C/D Bug Fixes — Accessibility, CSV Parsing, Memory Safety (2026-05-06)

**Medium/low severity bug fixes (commit 8c651eb)** addressing UX, data handling, and memory safety:

### UX & Accessibility
- **UpcomingPaymentsNotification** — Added `aria-label` to dismiss/dismiss-all buttons for screen reader accessibility
- **RecipientCombobox** — 300ms debounce on search input prevents per-keystroke fetches and API overload

### Data Handling & Security
- **CategoriesPage** — Fixed plural key using `activeCount` instead of `items.length`
- **OwesPage** — Sanitized recipient name before CSV filename usage (prevents path traversal)
- **api/helpers.ts** — `buildQuery` now filters `false` and empty-string values (not just `null`/`undefined`)
- **useCsvPreview** — Quote-aware CSV record splitter replaces naive `split('\n')` for multi-line field support

### Memory & Performance
- **api/client.ts** — Fixed AbortError conflation (timeout vs caller abort) and abort listener leak
- **useRestoreBackup** — Reload timer tracked in ref for unmount cleanup; i18n template `replace()` → `replaceAll()`
- **usePortfolio** — Module-level `EMPTY_TRANSACTIONS` constant prevents fresh array ref per render
- **VirtualDataTable** — `cancelEditing` wrapped in `useCallback` with proper dependencies
- **MarketLookupPage** — Stable key for analyst actions (date+firm vs index)
- **snapshotBuilder.js** — Defensive sort on `priceHistorySortedDays` for deterministic ordering

See [[docs/reference/code-patterns|Code Patterns]], [[docs/components/shared-components|Shared Components]], [[docs/features/import|Import Feature]], [[docs/security/data-protection|Data Protection]]

## May 2026 Bug Hunt Sweep: Correctness Hardening

**Comprehensive bug hunt (commit bc28c66, 2026-05-05)** addressing correctness issues across frontend, backend, Electron, and CI:

### Frontend Fixes
- **Mount guards** — Added `mountedRef` to `usePlannedPayments` to prevent setState after unmount
- **React keys** — Changed from array index to `crypto.randomUUID()` in `SplitTransactionDialog`, `TaxProfileDialog` for stable reconciliation
- **QueryKey fixes** — `usePortfolioPrefetch` queryKey now includes period (`["portfolio-performance", currency, "all"]`) to match Performance page query
- **Date handling** — Introduced UTC-safe date parsing in `dateUtils`: date-only strings (YYYY-MM-DD) now parse as local midnight, not UTC midnight
- **Pagination guards** — `RecipientsPage` loadMore now uses `generationRef` to prevent stale results after filter changes
- **UpdateNotification** — Removed redundant `schedule()` wrapper; fixed interval setup with `mountedRef`
- **Chart data** — `forecastMerge.ts` uses local midnight for Recharts x-axis consistency

### Backend Fixes
- **Decimal arithmetic** — New `decimal.test.ts` test coverage and correctness fixes in `portfolioMath.js`
- **Service robustness** — Improvements to `recipientPatternService` (stale-redo detection), `recurringDetectionService`, `portfolioSummaryService`, `belgianInflationService`
- **Pagination bounds** — Query limits/offsets clamped to valid ranges (1–max for limit, ≥0 for offset)
- **CSV imports** — Fixed CRLF handling, EU decimal support, dedup memo inclusion
- **Currency conversion** — `rateFetcher.js` retry/timeout hardening; `belgianInflationService` error handling improvements

### Electron Hardening
- **Window denial** — `setWindowOpenHandler(() => ({ action: 'deny' }))` prevents renderer `window.open()` spawning new windows
- **Navigation whitelist** — `will-navigate` whitelists only `file:`, `localhost`, `127.0.0.1`; denies external navigation
- **Installer verification** — Release update flow now requires cryptographic checksum verification; missing checksum aborts update
- **Backup path restrictions** — `BLOCKED_BACKUP_PREFIXES` validation prevents restore to system directories

### Release Workflow
- **Version sync check** — Three-way version match enforced: git tag, root `package.json`, `packaging/electron/package.json`
- **Concurrency serialization** — Releases for same ref do not cancel in-progress uploads

See [[docs/security/data-protection|Data Protection]], [[docs/components/hooks|Custom Hooks]], [[docs/components/shared-components|Shared Components]], [[docs/reference/code-patterns|Code Patterns]] for detailed fixes and patterns.

## Related Documentation

- [[docs/api/index\|API Documentation]] - Endpoints that power these features
- [[docs/components/index\|Components]] - Frontend components implementing these features
- [[docs/integrations/index\|Integrations]] - External services used by features
