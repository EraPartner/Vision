---
title: API Endpoint Matrix
type: reference
status: active
date: 2026-04-16
updated: 2026-04-19
tags: [reference, api, endpoints, matrix, overview]
description: Complete matrix of all 110 API endpoints organized by resource for quick lookup
aliases: [api matrix, endpoint matrix, all endpoints, api overview, endpoint list]
---

# API Endpoint Matrix

> [!abstract] Overview
> All 110 API endpoints across 15 route files. Use this as a quick reference to find any endpoint.

## Transactions (6 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/transactions` | List with filtering/pagination | — | [[docs/api/transactions\|Transactions]] |
| GET | `/api/transactions/export/csv` | Export as CSV (streaming, chunked) | 30 req/min | [[docs/api/transactions\|Transactions]] |
| GET | `/api/transactions/:id` | Get single | — | [[docs/api/transactions\|Transactions]] |
| POST | `/api/transactions` | Create | — | [[docs/api/transactions\|Transactions]] |
| PATCH | `/api/transactions/:id` | Update | 30 req/min | [[docs/api/transactions\|Transactions]] |
| DELETE | `/api/transactions/:id` | Hard delete | — | [[docs/api/transactions\|Transactions]] |

## Categories (7 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/categories` | List with filtering | — | [[docs/api/categories\|Categories]] |
| POST | `/api/categories` | Create or get existing | — | [[docs/api/categories\|Categories]] |
| POST | `/api/categories/assign` | Assign to recipients by name | — | [[docs/api/categories\|Categories]] |
| GET | `/api/categories/:id` | Get single | — | [[docs/api/categories\|Categories]] |
| PATCH | `/api/categories/:id` | Update | — | [[docs/api/categories\|Categories]] |
| DELETE | `/api/categories/:id` | Hard delete | — | [[docs/api/categories\|Categories]] |
| POST | `/api/categories/:id/assign` | Assign to recipients by ID | — | [[docs/api/categories\|Categories]] |

## Recipients (8 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/recipients` | List with filtering | — | [[docs/api/recipients\|Recipients]] |
| POST | `/api/recipients` | Create or get existing | — | [[docs/api/recipients\|Recipients]] |
| GET | `/api/recipients/:id` | Get single | — | [[docs/api/recipients\|Recipients]] |
| PATCH | `/api/recipients/:id` | Update | — | [[docs/api/recipients\|Recipients]] |
| DELETE | `/api/recipients/:id` | Hard delete | — | [[docs/api/recipients\|Recipients]] |
| POST | `/api/recipients/:id/merge` | Merge aliases into primary | — | [[docs/api/recipients\|Recipients]] |
| POST | `/api/recipients/:id/unmerge` | Unmerge from primary | — | [[docs/api/recipients\|Recipients]] |
| GET | `/api/recipients/:id/aliases` | Get aliases | — | [[docs/api/recipients\|Recipients]] |

## Planned Transactions (6 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/planned-transactions` | List | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| POST | `/api/planned-transactions` | Create (supports loans) | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| GET | `/api/planned-transactions/:id` | Get single | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| PATCH | `/api/planned-transactions/:id` | Update | 30 req/min | [[docs/api/plannedTransactions\|Planned Transactions]] |
| POST | `/api/planned-transactions/:id/execute` | Execute (atomic, idempotent — Phase 3) | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| DELETE | `/api/planned-transactions/:id` | Hard delete | — | [[docs/api/plannedTransactions\|Planned Transactions]] |

## Investments (14 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/investments` | List | — | [[docs/api/investments\|Investments]] |
| POST | `/api/investments` | Create | — | [[docs/api/investments\|Investments]] |
| GET | `/api/investments/providers` | List price providers | — | [[docs/api/investments\|Investments]] |
| POST | `/api/investments/refresh-prices` | Refresh all prices | — | [[docs/api/investments\|Investments]] |
| GET | `/api/investments/transactions` | Bulk portfolio transactions | — | [[docs/api/investments\|Investments]] |
| GET | `/api/investments/:id/price-history` | Historical price data | — | [[docs/api/investments\|Investments]] |
| GET | `/api/investments/:id` | Get single | — | [[docs/api/investments\|Investments]] |
| PATCH | `/api/investments/:id` | Update | — | [[docs/api/investments\|Investments]] |
| DELETE | `/api/investments/:id` | Hard delete | — | [[docs/api/investments\|Investments]] |
| GET | `/api/investments/:id/transactions` | Portfolio transactions | — | [[docs/api/investments\|Investments]] |
| POST | `/api/investments/:id/transactions` | Create portfolio transaction | — | [[docs/api/investments\|Investments]] |
| DELETE | `/api/investments/transactions/:txnId` | Delete portfolio transaction | — | [[docs/api/investments\|Investments]] |
| PATCH | `/api/investments/transactions/:txnId` | Update portfolio transaction | — | [[docs/api/investments\|Investments]] |
| GET | `/api/investments/:id/summary` | Investment summary | — | [[docs/api/investments\|Investments]] |

## Watchlist (5 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/watchlist` | List | — | [[docs/api/watchlist\|Watchlist]] |
| GET | `/api/watchlist/:id` | Get single | — | [[docs/api/watchlist\|Watchlist]] |
| POST | `/api/watchlist` | Create | — | [[docs/api/watchlist\|Watchlist]] |
| PATCH | `/api/watchlist/:id` | Update | — | [[docs/api/watchlist\|Watchlist]] |
| DELETE | `/api/watchlist/:id` | Delete | — | [[docs/api/watchlist\|Watchlist]] |

## Market Lookup (4 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/market/search` | Search tickers | — | [[docs/api/marketLookup\|Market Lookup]] |
| GET | `/api/market/quote` | Get quotes | — | [[docs/api/marketLookup\|Market Lookup]] |
| GET | `/api/market/chart` | Historical chart data | — | [[docs/api/marketLookup\|Market Lookup]] |
| GET | `/api/market/news` | News articles | — | [[docs/api/marketLookup\|Market Lookup]] |

## Import (6 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| POST | `/api/import/csv` | Import CSV | — | [[docs/api/imports\|Imports]] |
| POST | `/api/import/csv/custom` | Import with custom mapping | — | [[docs/api/imports\|Imports]] |
| POST | `/api/import/csv/stream` | SSE streaming import | — | [[docs/api/imports\|Imports]] |
| GET | `/api/import/supported-banks` | List supported banks | — | [[docs/api/imports\|Imports]] |
| POST | `/api/import/recipients` | Bulk import recipients | — | [[docs/api/imports\|Imports]] |
| POST | `/api/import/categories` | Bulk import categories | — | [[docs/api/imports\|Imports]] |

## Saved Charts (4 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/saved-charts` | List all | — | [[docs/api/savedCharts\|Saved Charts]] |
| POST | `/api/saved-charts` | Create | — | [[docs/api/savedCharts\|Saved Charts]] |
| PATCH | `/api/saved-charts/:id` | Update | — | [[docs/api/savedCharts\|Saved Charts]] |
| DELETE | `/api/saved-charts/:id` | Delete | — | [[docs/api/savedCharts\|Saved Charts]] |

## Settings (5 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/settings` | Get all | — | [[docs/api/settings\|Settings]] |
| GET | `/api/settings/:key` | Get single (with defaults) | — | [[docs/api/settings\|Settings]] |
| PUT | `/api/settings/:key` | Upsert single | — | [[docs/api/settings\|Settings]] |
| PUT | `/api/settings` | Bulk upsert | — | [[docs/api/settings\|Settings]] |
| DELETE | `/api/settings/:key` | Delete | — | [[docs/api/settings\|Settings]] |

## Recipient Bank Accounts (5 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/recipients/:id/bank-accounts` | List | — | [[docs/api/recipientBankAccounts\|Bank Accounts]] |
| POST | `/api/recipients/:id/bank-accounts` | Create or get existing | — | [[docs/api/recipientBankAccounts\|Bank Accounts]] |
| PATCH | `/api/recipients/:id/bank-accounts/:accountId` | Update | — | [[docs/api/recipientBankAccounts\|Bank Accounts]] |
| DELETE | `/api/recipients/:id/bank-accounts/:accountId` | Soft delete | — | [[docs/api/recipientBankAccounts\|Bank Accounts]] |
| POST | `/api/recipients/:id/bank-accounts/:accountId/set-primary` | Set primary | — | [[docs/api/recipientBankAccounts\|Bank Accounts]] |

## Splits (11 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/splits/owed` | Owed summary | — | [[docs/api/splits\|Splits]] |
| GET | `/api/splits/owed/:id` | Owed by recipient | — | [[docs/api/splits\|Splits]] |
| GET | `/api/splits/owed/:id/export/csv` | Export owed CSV | — | [[docs/api/splits\|Splits]] |
| GET | `/api/splits/transaction/:id` | Splits for transaction | — | [[docs/api/splits\|Splits]] |
| POST | `/api/splits` | Create split | — | [[docs/api/splits\|Splits]] |
| POST | `/api/splits/batch` | Create multiple splits | — | [[docs/api/splits\|Splits]] |
| POST | `/api/splits/:id/pay` | Record payment | — | [[docs/api/splits\|Splits]] |
| GET | `/api/splits/:id/payments` | Get payments | — | [[docs/api/splits\|Splits]] |
| POST | `/api/splits/:id/settle` | Mark settled | — | [[docs/api/splits\|Splits]] |
| POST | `/api/splits/owed/:id/settle-all` | Settle all for recipient | — | [[docs/api/splits\|Splits]] |
| DELETE | `/api/splits/:id` | Delete split | — | [[docs/api/splits\|Splits]] |

## Health (2 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/health` | Health check (backend ready) | — | [[docs/api/health\|Health]] |
| GET | `/health/detailed` | Detailed health with cache warmup status | — | [[docs/api/health\|Health]] |

## Admin (7 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/admin` | Admin status | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/database/init` | Verify DB connection | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/database/reset` | Reset database | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/update/check` | Check for updates | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/update/apply` | Acknowledge update | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/update/apply-and-restart` | Apply and restart | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/investments/kinesis/sanitize-history` | Sanitize Kinesis spikes | — | [[docs/api/admin\|Admin]] |

## Aggregations (6 endpoints) — Phase 2

Server-computed aggregations with materialized-view/live distinction. Behind `AGGREGATIONS_V2_ENABLED` feature flag.

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/aggregations/monthly-summary` | Monthly income/spending totals | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/category-breakdown` | Spending by category | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/recipient-insights` | Top merchants and month-over-month | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/cashflow-comparison` | Current vs. historical daily flow | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/average-vs-current` | Average vs. current period metrics | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/bank-balances` | Account balances and history | — | [[docs/api/aggregations\|Aggregations]] |

## Info/Statistics (20 endpoints)

Legacy endpoints. Coexist with `/api/aggregations/*` through Phase 8; removed in Phase 9.

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/info` | General statistics | — | [[docs/api/info\|Info]] |
| GET | `/api/info/banks` | List bank accounts | — | [[docs/api/info\|Info]] |
| GET | `/api/info/supported-adapters` | List supported banks | — | [[docs/api/info\|Info]] |
| GET | `/api/info/transaction-count` | Total count | — | [[docs/api/info\|Info]] |
| GET | `/api/info/transaction-summary` | Summary with filters | — | [[docs/api/info\|Info]] |
| GET | `/api/info/monthly-summary` | Monthly summary | — | [[docs/api/info\|Info]] |
| GET | `/api/info/planned-expenses-next-month` | Next month expenses | — | [[docs/api/info\|Info]] |
| GET | `/api/info/average-vs-current-spending` | Spending comparison | — | [[docs/api/info\|Info]] |
| GET | `/api/info/cashflow-comparison` | Cashflow over time | — | [[docs/api/info\|Info]] |
| GET | `/api/info/category-breakdown` | Category breakdown | — | [[docs/api/info\|Info]] |
| GET | `/api/info/bank-balances` | Bank balances | — | [[docs/api/info\|Info]] |
| GET | `/api/info/recurring-patterns` | Recurring detection | — | [[docs/api/info\|Info]] |
| GET | `/api/info/net-worth` | Net worth (optional `limit`/`offset` paginate snapshots newest-first; omit both for full history) | 30 req/min | [[docs/api/info\|Info]] |
| GET | `/api/info/recipient-insights` | Recipient insights | — | [[docs/api/info\|Info]] |
| GET | `/api/info/exchange-rates` | Exchange rates | 30 req/min | [[docs/api/info\|Info]] |
| POST | `/api/info/exchange-rates/refresh` | Refresh exchange rates | admin | [[docs/api/info\|Info]] |
| GET | `/api/info/inflation-rates` | Inflation rates | 30 req/min | [[docs/api/info\|Info]] |
| POST | `/api/info/inflation-rates/refresh` | Refresh inflation | admin | [[docs/api/info\|Info]] |
| POST | `/api/info/refresh-views` | Refresh materialized views | — | [[docs/api/info\|Info]] |
| GET | `/api/info/portfolio-performance` | Performance snapshots, metrics, heatmap | 30 req/min | [[docs/api/info\|Info]] |

## Summary

| Resource | Endpoints | Rate-Limited |
|----------|-----------|--------------|
| Transactions | 6 | 1 |
| Categories | 7 | 0 |
| Recipients | 8 | 0 |
| Planned Transactions | 6 | 1 |
| Investments | 14 | 0 |
| Watchlist | 5 | 0 |
| Market Lookup | 4 | 0 |
| Import | 6 | 0 |
| Saved Charts | 4 | 0 |
| Settings | 5 | 0 |
| Recipient Bank Accounts | 5 | 0 |
| Splits | 11 | 0 |
| Health | 2 | 0 |
| Admin | 7 | 0 |
| Aggregations (Phase 2) | 6 | 0 |
| Info/Statistics | 20 | 5 |
| **Total** | **110** | **7** |

## Related

- [[docs/reference/error-codes\|Error Codes Reference]]
- [[docs/reference/code-patterns\|Code Patterns Reference]]
- [[docs/security/rate-limiting\|Rate Limiting]]
- [[docs/common-tasks\|Common Tasks Quick Reference]]
