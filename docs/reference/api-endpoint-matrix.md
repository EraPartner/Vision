---
title: API Endpoint Matrix
type: reference
status: active
date: 2026-04-24
updated: 2026-04-24
adr-reference: 026
tags: [reference, api, endpoints, matrix, overview, openapi, phase-2, phase-4, phase-5a, phase-6, phase-7, feature-flags, reconciliation, cashflow-forecast, bill-reminders, sankey, pdf-report, db-maintenance]
description: Complete matrix of all 150 API endpoints organized by resource for quick lookup; includes Phase 4 feature flags; JSON export and attachments in Phase 5A; bank reconciliation, cash flow forecast, and bill reminders in Phase 6; Sankey flow, DB maintenance, PDF reports in Phase 7; see openapi.yaml for authoritative spec
aliases: [api matrix, endpoint matrix, all endpoints, api overview, endpoint list]
---

# API Endpoint Matrix

> [!abstract] Overview
> All 150 API endpoints across 20 route files (updated Phase 7). Use this as a quick reference to find any endpoint.
> 
> **Note:** As of Phase 2.4, `openapi.yaml` is the authoritative API specification. This matrix provides a quick lookup; see the OpenAPI spec for formal schemas and examples.

## Transactions (7 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/transactions` | List with filtering/pagination | — | [[docs/api/transactions\|Transactions]] |
| GET | `/api/transactions/export/csv` | Export as CSV (streaming, chunked) | 30 req/min | [[docs/api/transactions\|Transactions]] |
| GET | `/api/transactions/export/json` | Export as NDJSON (streaming, chunked) | 30 req/min | [[docs/api/transactions\|Transactions]] |
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

## Planned Transactions (7 endpoints) — Phase 3 / Phase 6

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/planned-transactions` | List | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| POST | `/api/planned-transactions` | Create (supports loans) | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| GET | `/api/planned-transactions/:id` | Get single | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| PATCH | `/api/planned-transactions/:id` | Update | 30 req/min | [[docs/api/plannedTransactions\|Planned Transactions]] |
| POST | `/api/planned-transactions/:id/execute` | Execute (atomic, idempotent — Phase 3) | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| DELETE | `/api/planned-transactions/:id` | Hard delete | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| GET | `/api/planned-transactions/due-soon` | Upcoming bills within N days (Phase 6) | — | [[docs/api/plannedTransactions\|Planned Transactions]] |

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

## Attachments (4 endpoints) — Phase 5A

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| POST | `/api/attachments/transaction/:id` | Upload attachment | — | [[docs/api/attachments\|Attachments]] |
| GET | `/api/attachments/transaction/:id` | List attachments for transaction | — | [[docs/api/attachments\|Attachments]] |
| GET | `/api/attachments/:id/download` | Download attachment file | — | [[docs/api/attachments\|Attachments]] |
| DELETE | `/api/attachments/:id` | Delete attachment | — | [[docs/api/attachments\|Attachments]] |

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
| GET | `/api/settings` | Get all (includes app, dashboard, theme, backup, widget visibility) | — | [[docs/api/settings\|Settings]] |
| GET | `/api/settings/:key` | Get single (with defaults) | — | [[docs/api/settings\|Settings]] |
| PUT | `/api/settings/:key` | Upsert single (theme_settings validated for variant/mode/schedule) | — | [[docs/api/settings\|Settings]] |
| PUT | `/api/settings` | Bulk upsert (theme_settings validated) | — | [[docs/api/settings\|Settings]] |
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

## Reconciliation (10 endpoints) — Phase 6

Bank statement import and transaction matching with auto-match candidate scoring.

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/reconciliation/statements` | List statements | — | [[docs/api/reconciliation\|Reconciliation]] |
| POST | `/api/reconciliation/statements` | Create statement | — | [[docs/api/reconciliation\|Reconciliation]] |
| GET | `/api/reconciliation/statements/:id` | Get statement with entry summary | — | [[docs/api/reconciliation\|Reconciliation]] |
| PATCH | `/api/reconciliation/statements/:id` | Update statement header | — | [[docs/api/reconciliation\|Reconciliation]] |
| DELETE | `/api/reconciliation/statements/:id` | Delete statement (cascades entries) | — | [[docs/api/reconciliation\|Reconciliation]] |
| GET | `/api/reconciliation/statements/:id/entries` | List entries for statement | — | [[docs/api/reconciliation\|Reconciliation]] |
| POST | `/api/reconciliation/statements/:id/entries` | Add entry or bulk entries | — | [[docs/api/reconciliation\|Reconciliation]] |
| DELETE | `/api/reconciliation/statements/:id/entries/:entryId` | Delete entry | — | [[docs/api/reconciliation\|Reconciliation]] |
| GET | `/api/reconciliation/statements/:id/entries/:entryId/candidates` | Auto-match candidates with scores | — | [[docs/api/reconciliation\|Reconciliation]] |
| POST/DELETE | `/api/reconciliation/statements/:id/entries/:entryId/match` | Set/clear transaction match | — | [[docs/api/reconciliation\|Reconciliation]] |

## Health (2 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/health` | Health check (backend ready) | — | [[docs/api/health\|Health]] |
| GET | `/health/detailed` | Detailed health with cache warmup status | — | [[docs/api/health\|Health]] |

## Admin (10 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/admin` | Admin status | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/database/init` | Verify DB connection | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/database/reset` | Reset database | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/update/check` | Check for updates | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/update/apply` | Acknowledge update | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/update/apply-and-restart` | Apply and restart | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/investments/kinesis/sanitize-history` | Sanitize Kinesis spikes | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/feature-flags` | List all feature flags (Phase 4) | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/feature-flags/:key` | Get single feature flag (Phase 4) | — | [[docs/api/admin\|Admin]] |
| PATCH | `/api/admin/feature-flags/:key` | Toggle feature flag (Phase 4) | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/db/stats` | Per-table live/dead row counts and size (Phase 7) | admin | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/db/vacuum` | Run VACUUM ANALYZE on one or all tables (Phase 7) | admin | [[docs/api/admin\|Admin]] |

## Reports (1 endpoint) — Phase 7

Server-side PDF generation via PDFKit. Returns binary stream (`application/pdf`).

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/reports/financial` | Export full financial PDF report (monthly + categories) | — | — |

## Aggregations (8 endpoints) — Phase 2 / Phase 6 / Phase 7

Server-computed aggregations with materialized-view/live distinction. Behind `AGGREGATIONS_V2_ENABLED` feature flag. Cash flow forecast added in Phase 6. Sankey flow added in Phase 7.

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/aggregations/monthly-summary` | Monthly income/spending totals | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/category-breakdown` | Spending by category | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/recipient-insights` | Top merchants and month-over-month | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/cashflow-comparison` | Current vs. historical daily flow | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/average-vs-current` | Average vs. current period metrics | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/bank-balances` | Account balances and history | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/cashflow-forecast` | N-month forward cash flow from planned transactions (Phase 6) | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/sankey` | Directed income→category flow graph for d3-sankey (Phase 7) | — | [[docs/api/aggregations\|Aggregations]] |

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

## AI Chat (9 endpoints + 30 tool-calling tools)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/ai/status` | Ollama reachability + default model | — | [[docs/api/ai\|AI Chat]] |
| GET | `/api/ai/models` | Installed Ollama models (pass-through) | — | [[docs/api/ai\|AI Chat]] |
| GET | `/api/ai/conversations` | List conversations (newest first) | — | [[docs/api/ai\|AI Chat]] |
| POST | `/api/ai/conversations` | Create empty conversation | — | [[docs/api/ai\|AI Chat]] |
| GET | `/api/ai/conversations/:id` | Conversation with messages | — | [[docs/api/ai\|AI Chat]] |
| PATCH | `/api/ai/conversations/:id` | Rename | — | [[docs/api/ai\|AI Chat]] |
| DELETE | `/api/ai/conversations/:id` | Delete (cascades messages) | — | [[docs/api/ai\|AI Chat]] |
| POST | `/api/ai/chat` | Chat turn (JSON); invokes 30 read-only tools | 30 req/min | [[docs/api/ai\|AI Chat]] |
| POST | `/api/ai/chat/stream` | Chat turn (SSE stream); invokes 30 read-only tools | 30 req/min | [[docs/api/ai\|AI Chat]] |

**Tool Categories (30 total):** Expenses (11), Portfolio (6), Planned (4), Belgian Tax (3), Insights (6). See [[docs/features/ai-chat#tool-registry-30-tools-across-6-domains\|AI Chat Feature]] for full reference.

## Summary

| Resource | Endpoints | Rate-Limited |
|----------|-----------|--------------|
| Transactions | 7 | 2 |
| Categories | 7 | 0 |
| Recipients | 8 | 0 |
| Planned Transactions | 7 | 1 |
| Investments | 14 | 0 |
| Watchlist | 5 | 0 |
| Market Lookup | 4 | 0 |
| Import | 6 | 0 |
| Attachments (Phase 5A) | 4 | 0 |
| Saved Charts | 4 | 0 |
| Settings | 5 | 0 |
| Recipient Bank Accounts | 5 | 0 |
| Reconciliation (Phase 6) | 10 | 0 |
| Admin | 10 | 0 |
| Splits | 11 | 0 |
| Health | 2 | 0 |
| Aggregations (Phase 2/6) | 7 | 0 |
| Info/Statistics | 20 | 5 |
| AI Chat | 9 | 2 |
| **Total** | **144** | **10** |

## Related

- [[docs/reference/error-codes\|Error Codes Reference]]
- [[docs/reference/code-patterns\|Code Patterns Reference]]
- [[docs/security/rate-limiting\|Rate Limiting]]
- [[docs/common-tasks\|Common Tasks Quick Reference]]
