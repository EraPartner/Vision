---
title: AI Agent Codebase Navigation Map
type: reference
status: active
date: 2026-04-24
updated: 2026-05-08
tags: [ai-agent, navigation, codebase-map, developer-tool, phase-1, phase-c, phase-e, bulk-actions]
description: Navigation map for AI agents and developers to quickly find code by feature, layer, or task. Updated for Phase C import pipeline consolidation, Phase E component decomposition, and bulk transaction actions.
aliases: [agent navigation, codebase map, file map, navigation guide]
---

# AI Agent Codebase Navigation Map

> [!abstract] Purpose
> This document provides a structured navigation map for AI agents and developers to quickly locate relevant files by feature, layer, or task. Designed to minimize exploration time and maximize accuracy.

---

## By Feature

### Transactions

| Layer | Files |
|-------|-------|
| Frontend Page | [[apps/frontend/src/pages/TransactionsPage.tsx]] |
| Hook | [[apps/frontend/src/hooks/useTransactions.ts]] |
| API Client | `apiClient.getTransactions()`, `createTransaction()`, etc. in [[apps/frontend/src/lib/api.ts]] |
| Backend Route | [[apps/node-backend/src/routes/transactions.js]] |
| Backend Service | None (direct repository calls) |
| Backend Repository | [[apps/node-backend/src/repositories/transactionRepository.js]] |
| API Doc | [[docs/api/transactions]] |
| Feature Doc | [[docs/features/transactions]] |

### Bulk Actions

| Layer | Files |
|-------|-------|
| Frontend Toolbar | [[apps/frontend/src/features/transactions/components/bulk/BulkActionsBar.tsx]] |
| Action Dialogs | [[apps/frontend/src/features/transactions/components/bulk/BulkRecategorizeDialog.tsx]], [[apps/frontend/src/features/transactions/components/bulk/BulkRecipientDialog.tsx]], [[apps/frontend/src/features/transactions/components/bulk/BulkExportDialog.tsx]], [[apps/frontend/src/features/transactions/components/bulk/BulkTagDialog.tsx]] |
| Hook | `useBulkDeleteTransactions`, `useBulkUpdateTransactions`, `useBulkExportTransactions` in [[apps/frontend/src/hooks/useTransactions.ts]] |
| API Client | `bulkDeleteTransactions()`, `bulkUpdateTransactions()`, `bulkExportTransactions()` in [[apps/frontend/src/lib/api/transactions.ts]] |
| Backend Service | [[apps/node-backend/src/services/bulkSelection.js]] (id/filter resolver), [[apps/node-backend/src/services/transactionExport.js]] (streaming export) |
| Backend Route | [[apps/node-backend/src/routes/transactions.js]] (`/bulk-delete`, `/bulk-update`, `/bulk-export`) |
| API Doc | [[docs/api/transactions#post-apitransactionsbulk-delete|Bulk Delete]], [[docs/api/transactions#post-apitransactionsbulk-update|Bulk Update]], [[docs/api/transactions#post-apitransactionsbulk-export|Bulk Export]] |
| Feature Doc | [[docs/features/bulk-actions]] |

### Categories

| Layer | Files |
|-------|-------|
| Frontend Page | [[apps/frontend/src/pages/CategoriesPage.tsx]] |
| Hook | [[apps/frontend/src/hooks/useCategories.ts]] |
| Backend Route | [[apps/node-backend/src/routes/categories.js]] |
| Backend Repository | [[apps/node-backend/src/repositories/categoryRepository.js]] |
| API Doc | [[docs/api/categories]] |

### Recipients

| Layer | Files |
|-------|-------|
| Frontend Page | [[apps/frontend/src/pages/RecipientsPage.tsx]] |
| Hook | [[apps/frontend/src/hooks/useRecipients.ts]] |
| Merge Dialog | [[apps/frontend/src/features/recipients/MergeRecipientsDialog.tsx]] |
| Backend Route | [[apps/node-backend/src/routes/recipients.js]] |
| Backend Repository | [[apps/node-backend/src/repositories/recipientRepository.js]] |
| API Doc | [[docs/api/recipients]] |

### Planned Transactions

| Layer | Files |
|-------|-------|
| Frontend Page | [[apps/frontend/src/pages/PlannedPaymentsPage.tsx]] |
| Hook | [[apps/frontend/src/hooks/usePlannedPayments.ts]] |
| Form | [[apps/frontend/src/components/planned/PlannedPaymentForm.tsx]] |
| Recurring Detection | [[apps/frontend/src/components/planned/RecurringDetectionPanel.tsx]] |
| Backend Route | [[apps/node-backend/src/routes/plannedTransactions.js]] |
| Backend Repository | [[apps/node-backend/src/repositories/plannedTransactionRepository.js]] |
| Backend Service | [[apps/node-backend/src/services/calculations/recurrence.js]], [[apps/node-backend/src/services/recurringDetectionService.js]] |
| API Doc | [[docs/api/plannedTransactions]] |
| Feature Doc | [[docs/features/plannedTransactions]] |

### Portfolio / Investments

| Layer | Files |
|-------|-------|
| Overview Page | [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]] |
| Stocks Page | [[apps/frontend/src/pages/portfolio/StocksPage.tsx]] |
| Crypto Page | [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]] |
| Metals Page | [[apps/frontend/src/pages/portfolio/MetalsPage.tsx]] |
| Real Estate Page | [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]] |
| Savings Page | [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]] |
| Performance Page | [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]] |
| Net Worth Page | [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]] |
| Watchlist Page | [[apps/frontend/src/pages/portfolio/WatchlistPage.tsx]] |
| Hook | [[apps/frontend/src/hooks/usePortfolio.ts]] |
| Dialogs | [[apps/frontend/src/components/portfolio/AddInvestmentDialog.tsx]], [[apps/frontend/src/components/portfolio/EditInvestmentDialog.tsx]], [[apps/frontend/src/components/portfolio/InvestmentDetailDialog.tsx]] |
| Backend Route | [[apps/node-backend/src/routes/investments.js]] |
| Backend Repository | [[apps/node-backend/src/repositories/investmentRepository.js]], [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]], [[apps/node-backend/src/repositories/watchlistRepository.js]] |
| Backend Services | [[apps/node-backend/src/services/priceProviderService.js]], [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js]] |
| API Doc | [[docs/api/investments]], [[docs/api/watchlist]], [[docs/api/marketLookup]] |
| Feature Doc | [[docs/features/portfolio]] |

### Splits & Owes

| Layer | Files |
|-------|-------|
| Frontend Page | [[apps/frontend/src/pages/OwesPage.tsx]] |
| Dialog | [[apps/frontend/src/components/splits/SplitTransactionDialog.tsx]] |
| Hook | [[apps/frontend/src/hooks/useSplits.ts]] |
| Backend Route | [[apps/node-backend/src/routes/splits.js]] |
| Backend Repository | [[apps/node-backend/src/repositories/splitRepository.js]] |
| API Doc | [[docs/api/splits]] |
| Feature Doc | [[docs/features/splits]] |

### Import (Phase E — Component Decomposition)

**Orchestrator Page:** [[apps/frontend/src/pages/ImportPage.tsx]] (35 lines, manages history refresh)

**Feature Components** (apps/frontend/src/features/imports/):

| Component | Lines | Responsibility |
|-----------|-------|-----------------|
| [[apps/frontend/src/features/imports/TransactionImportCard.tsx]] | 394 | Transaction CSV import, SSE progress, column mapper, export buttons |
| [[apps/frontend/src/features/imports/RecipientsImportCard.tsx]] | 155 | Bulk recipients CSV import |
| [[apps/frontend/src/features/imports/CategoriesImportCard.tsx]] | 140 | Categories CSV import |
| [[apps/frontend/src/features/imports/ExportCard.tsx]] | 159 | CSV/JSON export UI |
| [[apps/frontend/src/features/imports/SupportedBanksCard.tsx]] | 38 | Supported banks chip list (read-only) |
| [[apps/frontend/src/features/imports/useAdapters.ts]] | 28 | Shared hook: fetch bank adapters (prevents duplicate API calls) |

**Related Components:**
| Component | Purpose |
|-----------|---------|
| [[apps/frontend/src/components/import/ImportHistoryCard.tsx]] | Import history view (composed in ImportPage) |
| [[apps/frontend/src/components/import/CsvColumnMapper.tsx]] | CSV column mapping UI (used by TransactionImportCard) |

**Backend Route** | [[apps/node-backend/src/routes/importRoutes.js]] |
**Backend Services** | [[apps/node-backend/src/services/importPipeline/index.js|importPipeline]] (orchestrator), [[apps/node-backend/src/services/bankAdapters.js]], [[apps/node-backend/src/services/deduplication.js]], [[apps/node-backend/src/services/textNormalization.js]] |
| API Doc | [[docs/api/imports]] |
| Feature Doc | [[docs/features/import]] |

### Belgian Tax

| Layer | Files |
|-------|-------|
| Frontend Page | [[apps/frontend/src/pages/TaxOverviewPage.tsx]] |
| Components | [[apps/frontend/src/components/tax/TaxProfileDialog.tsx]], [[apps/frontend/src/components/tax/SuggestedDeductionsCard.tsx]] |
| Context | [[apps/frontend/src/contexts/BelgianTaxProfileContext.tsx]] |
| Backend Service | [[apps/node-backend/src/services/belgianInflationService.js]], [[apps/node-backend/src/services/calculations/loanSchedule.js]] |
| Feature Doc | [[docs/features/belgian-tax]] |
| Integration Doc | [[docs/integrations/belgian-inflation]], [[docs/integrations/loan-repayment-service]] |

### Dashboard

| Layer | Files |
|-------|-------|
| Frontend Page | [[apps/frontend/src/pages/DashboardPage.tsx]] |
| Components | [[apps/frontend/src/components/dashboard/StatCard.tsx]], [[apps/frontend/src/components/dashboard/MonthlySpendingChart.tsx]], [[apps/frontend/src/components/dashboard/MonthlyTrendsChart.tsx]], [[apps/frontend/src/components/dashboard/CategoryPieChart.tsx]], [[apps/frontend/src/components/dashboard/CashFlowComparisonChart.tsx]], [[apps/frontend/src/components/dashboard/BankBalancesWidget.tsx]] |
| Settings Dialog | [[apps/frontend/src/components/settings/DashboardSettingsDialog.tsx]] |
| Hook | [[apps/frontend/src/hooks/useFilteredDashboardStats.ts]] |
| Backend Service | [[apps/node-backend/src/services/materializedViewService.js]] |

### Onboarding

| Layer | Files |
|-------|-------|
| Component | [[apps/frontend/src/components/onboarding/OnboardingWizard.tsx]] |
| Feature Doc | [[docs/features/onboarding]] |

---

## By Layer

### Frontend Entry Points

| File | Purpose |
|------|---------|
| [[apps/frontend/src/main.tsx]] | Application entry point (ReactDOM render) |
| [[apps/frontend/src/App.tsx]] | Root component: providers, router, lazy-loaded pages |
| [[apps/frontend/src/index.css]] | Global styles, Tailwind imports |
| [[apps/frontend/src/theme-flash.ts]] | Theme flash prevention |

### Frontend Pages (23 total)

| Route | File |
|-------|------|
| `/` | [[apps/frontend/src/pages/DashboardPage.tsx]] |
| `/transactions` | [[apps/frontend/src/pages/TransactionsPage.tsx]] |
| `/categories` | [[apps/frontend/src/pages/CategoriesPage.tsx]] |
| `/recipients` | [[apps/frontend/src/pages/RecipientsPage.tsx]] |
| `/planned` | [[apps/frontend/src/pages/PlannedPaymentsPage.tsx]] |
| `/statistics` | [[apps/frontend/src/pages/StatisticsPage.tsx]] |
| `/import` | [[apps/frontend/src/pages/ImportPage.tsx]] |
| `/owes` | [[apps/frontend/src/pages/OwesPage.tsx]] |
| `/tax` | [[apps/frontend/src/pages/TaxOverviewPage.tsx]] |
| `/portfolio` | [[apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx]] |
| `/portfolio/stocks` | [[apps/frontend/src/pages/portfolio/StocksPage.tsx]] |
| `/portfolio/crypto` | [[apps/frontend/src/pages/portfolio/CryptoPage.tsx]] |
| `/portfolio/metals` | [[apps/frontend/src/pages/portfolio/MetalsPage.tsx]] |
| `/portfolio/real-estate` | [[apps/frontend/src/pages/portfolio/RealEstatePage.tsx]] |
| `/portfolio/savings` | [[apps/frontend/src/pages/portfolio/SavingsPage.tsx]] |
| `/portfolio/performance` | [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]] |
| `/portfolio/net-worth` | [[apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx]] |
| `/portfolio/exchange-rates` | [[apps/frontend/src/pages/portfolio/ExchangeRatesPage.tsx]] |
| `/portfolio/watchlist` | [[apps/frontend/src/pages/portfolio/WatchlistPage.tsx]] |
| `/portfolio/tax` | [[apps/frontend/src/pages/portfolio/tax/PortfolioTaxPage.tsx]] |
| `/portfolio/market` | [[apps/frontend/src/pages/MarketLookupPage.tsx]] |
| `*` (404) | [[apps/frontend/src/pages/NotFound.tsx]] |

### Frontend Contexts (7 total)

| Context | File |
|---------|------|
| AppSettings | [[apps/frontend/src/contexts/AppSettingsContext.tsx]] |
| Settings | [[apps/frontend/src/contexts/SettingsContext.tsx]] |
| Settings Preload | [[apps/frontend/src/contexts/SettingsPreloadContext.tsx]] |
| Theme | [[apps/frontend/src/contexts/ThemeContext.tsx]] |
| Language | [[apps/frontend/src/contexts/LanguageContext.tsx]] |
| Belgian Tax Profile | [[apps/frontend/src/contexts/BelgianTaxProfileContext.tsx]] |
| Workspace | [[apps/frontend/src/contexts/WorkspaceContext.tsx]] |

### Frontend Types (4 files)

| File | Contents |
|------|----------|
| [[apps/frontend/src/types/api.ts]] | API request/response types |
| [[apps/frontend/src/types/portfolio.ts]] | Portfolio/investment types |
| [[apps/frontend/src/types/watchlist.ts]] | Watchlist types |
| [[apps/frontend/src/types/splits.ts]] | Split transaction types |

### Backend Entry Point

| File | Purpose |
|------|---------|
| [[apps/node-backend/src/main.js]] | Express server setup, middleware, routes, CSP headers |

### Backend Routes (14 files)

| Route | File |
|-------|------|
| `/api/transactions` | [[apps/node-backend/src/routes/transactions.js]] |
| `/api/categories` | [[apps/node-backend/src/routes/categories.js]] |
| `/api/recipients` | [[apps/node-backend/src/routes/recipients.js]] |
| `/api/planned-transactions` | [[apps/node-backend/src/routes/plannedTransactions.js]] |
| `/api/investments` | [[apps/node-backend/src/routes/investments.js]] |
| `/api/watchlist` | [[apps/node-backend/src/routes/watchlist.js]] |
| `/api/market` | [[apps/node-backend/src/routes/marketLookup.js]] |
| `/api/import` | [[apps/node-backend/src/routes/importRoutes.js]] |
| `/api/settings` | [[apps/node-backend/src/routes/settings.js]] |
| `/api/saved-charts` | [[apps/node-backend/src/routes/savedCharts.js]] |
| `/api/splits` | [[apps/node-backend/src/routes/splits.js]] |
| `/api/info` | [[apps/node-backend/src/routes/info.js]] |
| `/api/admin` | [[apps/node-backend/src/routes/admin.js]] |
| `/api/recipient-bank-accounts` | [[apps/node-backend/src/routes/recipientBankAccounts.js]] |

### Backend Repositories (13 files)

| Repository | File |
|------------|------|
| Transaction | [[apps/node-backend/src/repositories/transactionRepository.js]] |
| Category | [[apps/node-backend/src/repositories/categoryRepository.js]] |
| Recipient | [[apps/node-backend/src/repositories/recipientRepository.js]] |
| Planned Transaction | [[apps/node-backend/src/repositories/plannedTransactionRepository.js]] |
| Investment | [[apps/node-backend/src/repositories/investmentRepository.js]] |
| Portfolio Transaction | [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]] |
| Watchlist | [[apps/node-backend/src/repositories/watchlistRepository.js]] |
| Split | [[apps/node-backend/src/repositories/splitRepository.js]] |
| Raw Transaction | [[apps/node-backend/src/repositories/rawTransactionRepository.js]] |
| Recipient Bank Account | [[apps/node-backend/src/repositories/recipientBankAccountRepository.js]] |
| Saved Charts | [[apps/node-backend/src/repositories/savedChartsRepository.js]] |
| Settings | [[apps/node-backend/src/repositories/settingsRepository.js]] |
| Info | [[apps/node-backend/src/repositories/infoRepository.js]] |

### Backend Services (18 files)

Full reference: [[docs/reference/service-layer|Service Layer Reference]]

| Service | File |
|---------|------|
| AI Chat | [[apps/node-backend/src/services/aiChatService.js]] |
| Bank Adapters | [[apps/node-backend/src/services/bankAdapters.js]] |
| Belgian Inflation | [[apps/node-backend/src/services/belgianInflationService.js]] |
| Currency Conversion | [[apps/node-backend/src/services/currency/currencyConversionService.js]] |
| Data Import | [[apps/node-backend/src/services/dataImportService.js]] |
| Deduplication | [[apps/node-backend/src/services/deduplication.js]] |
| IBAN | [[apps/node-backend/src/services/iban.js]] |
| Import Pipeline | [[apps/node-backend/src/services/importPipeline/index.js]] (Phase C) |
| Loan Repayment | [[apps/node-backend/src/services/calculations/loanSchedule.js]] |
| Materialized Views | [[apps/node-backend/src/services/materializedViewService.js]] |
| Portfolio Performance | [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js]] |
| Price Provider | [[apps/node-backend/src/services/priceProviderService.js]] |
| Quote Backfill | [[apps/node-backend/src/services/quoteBackfillService.js]] |
| Recurrence | [[apps/node-backend/src/services/calculations/recurrence.js]] |
| Recurring Detection | [[apps/node-backend/src/services/recurringDetectionService.js]] |
| Text Normalization | [[apps/node-backend/src/services/textNormalization.js]] |

### Database

| File | Purpose |
|------|---------|
| [[apps/node-backend/src/database/connection.js]] | Database connection setup |
| [[apps/node-backend/src/main.js]] | DB readiness retry loop + server startup |
| [[apps/node-backend/src/database/migrate.js]] | Alembic migrations (schema initialization) |

### Migrations

Full list: [[docs/reference/migration-dependencies|Migration Dependencies]]

Directory: `alembic/versions/` — 24 numbered migrations from `0001_initial_database_schema.py` to `0024_per_class_invested_columns.py`

---

## By Task

### "I want to add a new API endpoint"

1. Read [[docs/guides/how-to-add-api-endpoint|How to Add an API Endpoint]]
2. Add route file in `apps/node-backend/src/routes/`
3. Add repository method in `apps/node-backend/src/repositories/`
4. Register route in [[apps/node-backend/src/main.js]]
5. Add API client method in [[apps/frontend/src/lib/api.ts]]
6. Create/update API doc in `docs/api/`

### "I want to add a new page"

1. Read [[docs/guides/how-to-add-new-page|How to Add a New Page]]
2. Create page component in `apps/frontend/src/pages/`
3. Add route in [[apps/frontend/src/App.tsx]]
4. Add sidebar link in [[apps/frontend/src/components/layout/AppSidebar.tsx]]
5. Add i18n keys in `i18n/locales/en.ts` and `nl.ts`

### "I want to add a new React component"

1. Read [[docs/guides/how-to-add-react-component|How to Add a React Component]]
2. Create component in appropriate `apps/frontend/src/components/` subdirectory
3. Use shadcn/radix primitives from `components/ui/`
4. Follow Tailwind CSS styling conventions

### "I need to add a database column"

1. Read [[docs/guides/migrations|Migration Guide]]
2. Create migration: `bun run db:revision -- "add column to table"`
3. Run migration: `bun run db:upgrade`
4. Update repository queries
5. Update [[docs/adr/002-database-schema|Database Schema ADR]]

### "I want to understand how imports work"

1. Read [[docs/features/import|Import Feature]]
2. Read [[docs/integrations/bank-adapters|Bank Adapters]]
3. Trace: `importRoutes.js` → `importPipeline/index.js` (orchestrator) → stages: stage/validate/match/commit → `bankAdapters.js` → `deduplication.js`
4. See [[docs/api/imports|Imports API]] for endpoint contracts (standard, custom, streaming)

### "I want to understand how prices are fetched"

1. Read [[docs/integrations/price-providers|Price Providers]]
2. Trace: `investments.js` route → `priceProviderService.js` → Yahoo/Binance/Kinesis APIs
3. Read [[docs/integrations/kinesis-price-provider|Kinesis Price Provider]] for metals

---

## Related Documentation

- [[docs/index|Knowledge Base Home]]
- [[docs/reference/service-layer|Service Layer Reference]]
- [[docs/reference/typescript-types|TypeScript Types Reference]]
- [[docs/reference/algorithms|Algorithms Reference]]
- [[docs/reference/react-query-keys|React Query Keys]]
- [[docs/reference/database-query-patterns|Database Query Patterns]]
- [[docs/guides/debugging|Debugging Guide]]
