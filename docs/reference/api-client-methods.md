---
title: API Client Methods Reference (ARCHIVED)
type: reference
status: archived
date: 2026-04-21
tags: [reference, api-client, frontend, typescript, http, archived, phase-1]
description: Legacy reference of monolithic api.ts — replaced by modular architecture in Phase 1
aliases: [api client, HTTP client, fetch methods, apiClient]
related_code:
  - apps/frontend/src/lib/api.ts
---

# API Client Methods Reference (ARCHIVED)

> [!warning] Archived — See Frontend API Client Architecture
> This document describes the legacy monolithic api.ts (1243 lines). As of Phase 1 (2026-04-21), the frontend HTTP client has been refactored into modular layers. See [[docs/reference/frontend-api-client|Frontend API Client Architecture]] for the current approach.

## Legacy Overview (Do Not Use)

The legacy `apiClient` singleton (`[[apps/frontend/src/lib/api.ts]]`, 1243 lines, pre-Phase 1) was the sole HTTP client for all frontend-to-backend communication.

## Core Features

### Retry with Exponential Backoff

- **Max retries**: 2 attempts
- **Retryable status codes**: 408, 429, 502, 503, 504
- **Idempotent methods only**: GET, PUT, DELETE, HEAD, OPTIONS are retried; POST/PATCH are not
- **Backoff formula**: `500ms * 2^attempt + random_jitter(0-200ms)`

### Timeout

- **Default timeout**: 30 seconds
- **AbortController**: All requests support cancellation
- **cancelAll()**: Aborts all in-flight requests (useful for logout)

### Error Handling

- **422 Validation errors**: Formatted as `Validation error: field: message; field: message`
- **429 Rate limit**: Includes retry-after information
- **Generic errors**: Falls back to `Request failed with status NNN`

## Method Reference

### Transactions

| Method | Endpoint | Return Type |
|--------|----------|-------------|
| `getTransactions(params?)` | GET /api/transactions | `TransactionsListResponse` |
| `getTransaction(id)` | GET /api/transactions/:id | `Transaction` |
| `createTransaction(data)` | POST /api/transactions | `Transaction` |
| `updateTransaction(id, data)` | PATCH /api/transactions/:id | `Transaction` |
| `deleteTransaction(id)` | DELETE /api/transactions/:id | `void` |

### Categories

| Method | Endpoint | Return Type |
|--------|----------|-------------|
| `getCategories(params?)` | GET /api/categories | `CategoriesListResponse` |
| `getCategory(id)` | GET /api/categories/:id | `Category` |
| `createCategory(data)` | POST /api/categories | `{ category, wasCreated }` |
| `updateCategory(id, data)` | PATCH /api/categories/:id | `Category` |
| `deleteCategory(id)` | DELETE /api/categories/:id | `void` |

### Recipients

| Method | Endpoint | Return Type |
|--------|----------|-------------|
| `getRecipients(params?)` | GET /api/recipients | `RecipientsListResponse` |
| `getRecipient(id)` | GET /api/recipients/:id | `Recipient` |
| `createRecipient(data)` | POST /api/recipients | `{ recipient, wasCreated }` |
| `updateRecipient(id, data)` | PATCH /api/recipients/:id | `Recipient` |
| `deleteRecipient(id)` | DELETE /api/recipients/:id | `void` |
| `mergeRecipients(primaryId, aliasIds)` | POST /api/recipients/:id/merge | `{ primary, merged_ids, aliases }` |
| `unmergeRecipient(id)` | POST /api/recipients/:id/unmerge | `Recipient` |
| `getRecipientAliases(id)` | GET /api/recipients/:id/aliases | `{ items, total }` |

### Planned Transactions

| Method | Endpoint | Return Type |
|--------|----------|-------------|
| `getPlannedTransactions(params?)` | GET /api/planned-transactions | `PlannedTransactionsListResponse` |
| `getPlannedTransaction(id)` | GET /api/planned-transactions/:id | `PlannedTransaction` |
| `createPlannedTransaction(data)` | POST /api/planned-transactions | `PlannedTransaction` |
| `updatePlannedTransaction(id, data)` | PATCH /api/planned-transactions/:id | `PlannedTransaction` |
| `deletePlannedTransaction(id)` | DELETE /api/planned-transactions/:id | `void` |
| `executePlannedTransaction(id, data)` | POST /api/planned-transactions/:id/execute | `PlannedTransaction` |

### Investments / Portfolio

| Method | Endpoint | Return Type |
|--------|----------|-------------|
| `getInvestments(params?)` | GET /api/investments | `InvestmentsListResponse` |
| `getInvestment(id)` | GET /api/investments/:id | `Investment` |
| `createInvestment(data)` | POST /api/investments | `Investment` |
| `updateInvestment(id, data)` | PATCH /api/investments/:id | `Investment` |
| `deleteInvestment(id)` | DELETE /api/investments/:id | `void` |
| `refreshInvestmentPrices()` | POST /api/investments/refresh-prices | `{ updated, total, prices, priceSources }` |
| `getPriceProviders()` | GET /api/investments/providers | `{ providers }` |
| `getInvestmentPriceHistory(id, params?)` | GET /api/investments/:id/price-history | `{ investment_id, provider, points }` |
| `getPortfolioTransactions(id, params?)` | GET /api/investments/:id/transactions | `PortfolioTransactionsListResponse` |
| `getPortfolioTransactionsBulk(params)` | GET /api/investments/transactions | `PortfolioTransactionsListResponse` |
| `createPortfolioTransaction(id, data)` | POST /api/investments/:id/transactions | `PortfolioTransaction` |
| `updatePortfolioTransaction(txnId, data)` | PATCH /api/investments/transactions/:txnId | `PortfolioTransaction` |
| `deletePortfolioTransaction(txnId)` | DELETE /api/investments/transactions/:txnId | `void` |

### Watchlist (Phase 3.6)

| Method | Endpoint | Return Type |
|--------|----------|-------------|
| `getWatchlist(params?)` | GET /api/watchlist | `WatchlistListResponse` |
| `createWatchlistItem(data)` | POST /api/watchlist | `WatchlistItem` |
| `updateWatchlistItem(id, data)` | PATCH /api/watchlist/:id | `WatchlistItem` |
| `deleteWatchlistItem(id)` | DELETE /api/watchlist/:id | `void` |
| `getMarketQuotes(symbols)` | GET /api/market/quote | `Array<{symbol, price, change, changePercent}>` (unwrapped from the `{ items, total }` body) |

**Phase 3.6 Enhancement**: WatchlistPage refactored to use typed `apiClient` watchlist methods instead of scattered raw `fetch()` calls. Enables shared retry logic, timeout handling, and React Query integration. `getMarketQuotes()` fetches live quotes for multiple symbols via comma-separated list.

### Import

| Method | Endpoint | Return Type |
|--------|----------|-------------|
| `importCSV(file, bankName)` | POST /api/import/csv | `{ batch_id, imported, duplicates, total_processed }` |
| `importCSVWithProgress(file, bankName, onProgress)` | POST /api/import/csv/stream (SSE) | `{ abort, result }` |
| `importCSVCustom(file, bankName, ...config)` | POST /api/import/csv/custom | `{ batch_id, imported, duplicates, total_processed }` |
| `importRecipients(file)` | POST /api/import/recipients | `{ total_processed, imported, skipped, errors }` |
| `importCategories(file)` | POST /api/import/categories | `{ total_processed, imported, skipped, errors }` |

### Settings

| Method | Endpoint | Return Type |
|--------|----------|-------------|
| `getSettings()` | GET /api/settings | `Record<string, any>` |
| `getSetting(key)` | GET /api/settings/:key | `{ key, value }` |
| `saveSetting(key, value)` | PUT /api/settings/:key | `{ key, value }` |
| `saveSettingsBulk(settings)` | PUT /api/settings | `{ saved }` |

### Info / Statistics (Phase G: Aggregation Migration)

> [!warning] Phase G Migration (April 2026)
> Four methods now proxy through `/api/aggregations/*` endpoints with envelope unwrapping. See [[docs/api/aggregations|Aggregations API]].

| Method | Backend Route | Return Type | Notes |
|--------|----------|-------------|-------|
| `getStatistics(params?)` | GET /api/info | Statistics summary | Direct |
| `getSupportedParsers()` | GET /api/info/supported-adapters | `SupportedAdapter[]` (unwrapped from the `{ items, total }` body) | Direct |
| `getTransactionSummary(params?)` | GET /api/info/transaction-summary | Summary stats | Direct |
| `getTransactionCount()` | GET /api/info/transaction-count | `{ total_transactions }` | Direct |
| `getMonthlyFinancialSummary(params?)` | GET /api/aggregations/monthly-summary | Monthly data | Phase G: Envelope unwrapped |
| `getCashflowComparison(params?)` | GET /api/aggregations/cashflow-comparison | Daily cashflow | Phase G: Envelope unwrapped |
| `getBankBalances(params?)` | GET /api/aggregations/bank-balances | Bank balances | Phase G: Envelope unwrapped |
| `getBelgianInflationRates(params?)` | GET /api/info/inflation-rates | Inflation rates | Direct |
| `getRecurringPatterns()` | GET /api/info/recurring-patterns | Recurring patterns | Direct |
| `getNetWorth(params?)` | GET /api/info/net-worth | `NetWorthResponse` | Direct |
| `getPortfolioPerformance(params?)` | GET /api/info/portfolio-performance | Performance snapshots | Direct |
| `getRecipientInsights(params?)` | GET /api/aggregations/recipient-insights | Recipient insights | Phase G: Envelope unwrapped |
| `refreshMaterializedViews()` | POST /api/info/refresh-views | `{ message, duration_ms }` | Direct |

**Implementation detail (Phase G):** Four legacy endpoints were removed from `/api/info/*`. The corresponding `apiClient` methods now wrap calls to the aggregation equivalents, unwrapping the [[docs/adr/026-unified-api-response-envelope|unified response envelope]] to maintain backward-compatible signatures for call sites.

### Splits / Owes

| Method | Endpoint | Return Type |
|--------|----------|-------------|
| `getOwedSummary()` | GET /api/splits/owed | `{ items }` |
| `getOwedByRecipient(recipientId)` | GET /api/splits/owed/:id | `{ items }` |
| `exportOwedByRecipientCsv(recipientId)` | GET /api/splits/owed/:id/export/csv | `Blob` |
| `getSplitsByTransaction(txnId)` | GET /api/splits/transaction/:id | `{ items }` |
| `createSplitsBatch(txnId, splits)` | POST /api/splits/batch | `{ items }` |
| `recordSplitPayment(splitId, amount, note?, paid_at?)` | POST /api/splits/:id/pay | Split payment |
| `settleSplit(splitId)` | POST /api/splits/:id/settle | Settled split |
| `settleAllSplitsByRecipient(recipientId)` | POST /api/splits/owed/:id/settle-all | `{ settled_count }` |
| `deleteSplit(splitId)` | DELETE /api/splits/:id | `void` |

### Saved Charts

| Method | Endpoint | Return Type |
|--------|----------|-------------|
| `getSavedCharts()` | GET /api/saved-charts | `SavedChart[]` |
| `createSavedChart(payload)` | POST /api/saved-charts | `SavedChart` |
| `updateSavedChart(id, payload)` | PATCH /api/saved-charts/:id | `SavedChart` |
| `deleteSavedChart(id)` | DELETE /api/saved-charts/:id | `void` |

### Market

| Method | Endpoint | Return Type |
|--------|----------|-------------|
| `getMarketNews(symbols?, count?)` | GET /api/market/news | `MarketNewsArticle[]` (unwrapped from the `{ items, total }` body) |

### Electron (Desktop Only)

All Electron methods return `null` when called from a browser context.

| Method | Purpose |
|--------|---------|
| `checkForUpdates()` | Check for app updates |
| `triggerDockerUpdate()` | Pull latest Docker image and hot-swap |
| `installShellUpdate()` | Install shell-based update |
| `isElectron()` | Check if running in Electron |
| `runBackup(destDir)` | Run pg_dump backup |
| `selectBackupFile()` | Open file picker for backup restore |
| `restoreBackup(sqlFilePath)` | Restore from SQL backup |
| `selectBackupDir()` | Open folder picker for backup directory |
| `saveBackupSettings(settings)` | Persist backup settings to DB |
| `loadBackupSettings()` | Load backup settings from DB |
| `getBackupEncryptionStatus()` | Check backup encryption status |
| `setBackupPassphrase(passphrase)` | Set backup encryption passphrase |

## Internal Architecture

### Request Pipeline

```
apiClient.method() → request() → rawFetch() → fetch()
                         ↓           ↓
                    retry logic   AbortController
                    backoff       timeout
```

### Key Implementation Details

- **`rawFetch()`**: Low-level fetch with AbortController and timeout
- **`request()`**: High-level method with retry, error parsing, and JSON response handling
- **`buildQuery()`**: Converts params object to URL query string
- **`requestWithQuery()`**: Shared GET helper that composes `buildQuery()` + conditional query append to eliminate repeated URL assembly in read methods
- **`buildExclusionQuery()`**: Shared query builder for analytics endpoints that accept repeated `excluded_category_ids` / `excluded_recipient_ids` and optional `currency`
- **`createWithStatus()`**: Shared POST helper used by create-style methods that return `{ data, wasCreated }` based on `201 Created`
- **`postMultipartImport()`**: Shared multipart/form-data import helper used by CSV/recipient/category import endpoints
- **`getElectronUpdater()` / `getElectronBackup()`**: Centralized Electron bridge accessors to remove repeated window casting/message chains
- **`activeControllers`**: Set of all active AbortControllers for `cancelAll()`

Internal refactor note (2026-04-09): helper extraction reduced duplication in `api.ts` (including shared query-request composition via `requestWithQuery()`) without changing public method signatures, endpoint paths, request semantics, or return payload shapes ([[apps/frontend/src/lib/api.ts]]).
