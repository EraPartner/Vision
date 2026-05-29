---
title: API Endpoint Matrix
type: reference
status: active
date: 2026-04-27
updated: 2026-05-29
last_modified: 2026-05-29
adr-reference: 026
# Authoritative HTTP-operation count, derived from openapi.yaml and enforced by
# scripts/check-endpoint-matrix.js (CI verify-generated). Bump when routes change.
api_operation_count: 158
tags: [reference, api, endpoints, matrix, overview, openapi, phase-1, phase-2, phase-3, phase-4, phase-5a, phase-5, phase-6, phase-7, phase-8, phase-g, phase-9, phase-13, phase-c, phase-d, phase-e, phase-f, cashflow-forecast, bill-reminders, sankey, pdf-report, db-maintenance, puppeteer, reports, multi-method-forecast, accuracy-persistence, materialized-cache, ensemble-methods, dependency-slim-down, backup, ipc, electron, drillthrough, export-filters, multi-select, ing, bnp, supported-adapters]
description: Complete matrix of all 158 HTTP API operations (authoritative count from openapi.yaml) across the route files, plus 8 Electron IPC handlers, organized by resource for quick lookup. Phase 1+2 adds 8 IPC handlers for bundle-based backup/restore with AES-256-CBC encryption and schema-safe restore. Phase 3 adds three new POST report endpoints with Puppeteer rendering. Phase 5A adds JSON export and attachments. Phase 6 adds cash flow forecast. Phase 7 adds Sankey flow and DB maintenance. Phase 8 completes portfolio and tax report generation (6 + 7 sections respectively). Phase F adds 4 admin endpoints. Phase 10 adds multi-method cash flow forecast. Phase C adds dashboard frontend visualization for Phase 10 forecast. Phase D adds persisted accuracy metrics endpoint. Phase E adds cache-aware forecast endpoint with materialized MC cache. Phase H adds rolling-window forecast with rolling-specific MC defaults (500 paths, P25/P75) and lazy-loaded diagnostics. Phase G removes 6 overlapping info endpoints in favor of aggregations. Phase 9 completes aggregation shadow cutover. Phase 13 adds multi-select export filters (`bank_accounts`, `category_ids` params); May 12 2026: ING and BNP Paribas Fortis adapters added (8 banks total); see openapi.yaml for authoritative spec.
aliases: [api matrix, endpoint matrix, all endpoints, api overview, endpoint list]
---

# API Endpoint Matrix

> [!abstract] Overview
> **158 HTTP API operations** (authoritative count = operations in `openapi.yaml`, enforced by `scripts/check-endpoint-matrix.js` in CI) plus 8 Electron IPC handlers, across the route files. The per-resource tables below are a navigational index — `openapi.yaml` is the source of truth. (updated 2026-05-16 — Bulk Actions feature adds `POST /api/transactions/bulk-delete`, `POST /api/transactions/bulk-update`, and `POST /api/transactions/bulk-export`; Tags feature adds `GET/POST /api/tags`, `PATCH/DELETE /api/tags/:id`, `POST /api/transactions/bulk-tag`, and `tags` query param on `GET /api/transactions` and both export endpoints; prior: 2026-04-29 — Phase 14 adds portfolio-summary realtime totals endpoint; Phase 13 adds `category_ids` and `transaction_type` query params to `GET /api/transactions` for pivot table drillthrough; unifies export endpoint filters with `GET /api/transactions` by delegating to shared `buildTransactionWhere`, enabling `transaction_id`, `recipient_id`, `recipient_name`, `search`, and `transaction_type` on export endpoints; adds `bank_accounts` and `category_ids` multi-select params to both list and export for flexible filtering via UI pickers; Phase 7 adds filter exclusions (`excludedCategoryIds`, `excludedRecipientIds`) to report endpoints with filter impact comparison view; adds `GET /api/recipients/clusters` for merge candidate identification; Phase E adds cache-aware forecast endpoint with 6-hour TTL materialized cache; Phase D adds persisted accuracy metrics endpoint; Phase 9 — aggregation shadow cutover complete; Phase F adds 4 admin endpoints for provider health, endpoint liveness, and metrics; Phase 10 adds multi-method cash flow forecast endpoint; Phase C adds dashboard frontend visualization for Phase 10 forecast; Phase 5 slim-down removes legacy GET `/api/reports/financial` endpoint; bank reconciliation removed). Use this as a quick reference to find any endpoint.
> 
> **Note:** As of Phase 2.4, `openapi.yaml` is the authoritative API specification. This matrix provides a quick lookup; see the OpenAPI spec for formal schemas and examples.
>
> **Phase 3 Update (April 2026):** PDF report generation redesigned with Puppeteer rendering, modular section renderers, and theme-aware styling. Three new POST endpoints: `/api/reports/financial`, `/api/reports/portfolio`, `/api/reports/tax`. Legacy GET endpoint (PDFKit-based) kept for backward compatibility.
>
> **Phase 5 Update (April 2026):** Dependency slim-down removes `pdfkit` and related legacy GET `/api/reports/financial` endpoint (ADR-038). All PDF generation now uses POST endpoints with Puppeteer rendering.
>
> **Phase G Update (April 2026):** Six legacy `/api/info/*` endpoints removed in favor of `/api/aggregations/*` alternatives. See [[#phase-g-endpoint-consolidation|Phase G Endpoint Consolidation]] below.
>
> **Phase 9 Update (April 2026):** Aggregation shadow mode validation complete. Shadow divergence admin endpoints (`GET /api/admin/shadow-divergences/summary`, `GET /api/admin/shadow-divergences`) removed. `/api/aggregations/*` is now the sole aggregation path. Legacy `/api/info/*` aggregation routes removed from wiring (see [[docs/adr/011-phase2-aggregation-envelope-standard|ADR-011]]), though `info.js` persists for unrelated endpoints (portfolio-performance, net-worth, exchange-rates, inflation-rates).
>
> **2026-04-29 Security Update:** CodeQL + Dependabot remediation (ADR-042): `attachmentRateLimiter` (60 req/min) added to all attachment endpoints; `spaRateLimiter` (600 req/min) added to SPA fallback route. See [[docs/adr/042-codeql-dependabot-remediation-2026-04|ADR-042]] for full details.

## Transactions (11 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/transactions` | List with filtering/pagination (Phase 13: supports `transaction_id`, `recipient_id`, `recipient_name`, `search`, `transaction_type`, `category_ids`, `bank_accounts`) | — | [[docs/api/transactions\|Transactions]] |
| GET | `/api/transactions/export/csv` | Export as CSV (streaming, chunked); accepts same filters as `GET /api/transactions` (Phase 13) | 30 req/min | [[docs/api/transactions\|Transactions]] |
| GET | `/api/transactions/export/json` | Export as NDJSON (streaming, chunked); accepts same filters as `GET /api/transactions` (Phase 13) | 30 req/min | [[docs/api/transactions\|Transactions]] |
| GET | `/api/transactions/:id` | Get single | — | [[docs/api/transactions\|Transactions]] |
| POST | `/api/transactions` | Create | — | [[docs/api/transactions\|Transactions]] |
| PATCH | `/api/transactions/:id` | Update | 30 req/min | [[docs/api/transactions\|Transactions]] |
| DELETE | `/api/transactions/:id` | Hard delete | — | [[docs/api/transactions\|Transactions]] |
| POST | `/api/transactions/bulk-tag` | Atomically add/remove tags on 1–500 transactions | 30 req/min | [[docs/features/tags\|Tags]] |
| POST | `/api/transactions/bulk-delete` | Hard-delete by `ids` (≤500) or `filter` (≤5000 matches) | 30 req/min | [[docs/features/bulk-actions\|Bulk Actions]] |
| POST | `/api/transactions/bulk-update` | Apply category/recipient/active update to a selection | 30 req/min | [[docs/features/bulk-actions\|Bulk Actions]] |
| POST | `/api/transactions/bulk-export` | Stream CSV/NDJSON for an ids- or filter-resolved selection | 30 req/min | [[docs/features/bulk-actions\|Bulk Actions]] |
| GET | `/api/tags` | List tags; `?is_active=true\|false` | — | [[docs/features/tags\|Tags]] |
| POST | `/api/tags` | Find-or-create tag by slug (upsert) | — | [[docs/features/tags\|Tags]] |
| PATCH | `/api/tags/:id` | Update tag color or is_active | — | [[docs/features/tags\|Tags]] |
| DELETE | `/api/tags/:id` | Soft-delete tag (`is_active=false`) | — | [[docs/features/tags\|Tags]] |

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

## Recipients (9 endpoints)

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
| GET | `/api/recipients/clusters` | Identify merge-candidate clusters | — | [[docs/api/recipients\|Recipients]] |

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
| GET | `/api/investments/:id/price-history` | Historical price data (db_only=true by default for offline safety) | — | [[docs/api/investments\|Investments]] |
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
| GET | `/api/import/batches` | List import batches | — | [[docs/api/imports\|Imports]] |
| GET | `/api/import/batches/:id` | Get import batch | — | [[docs/api/imports\|Imports]] |
| DELETE | `/api/import/batches/:id` | Rollback import batch | — | [[docs/api/imports\|Imports]] |
| GET | `/api/import/batches/:id/preview` | Review preview (groups + categories) | ADR-046 | [[docs/api/imports\|Imports]] |
| POST | `/api/import/batches/:id/rows/:rowId/override` | Override recipient on staged row | — | [[docs/api/imports\|Imports]] |
| POST | `/api/import/batches/:id/rows/:rowId/category-override` | Override category on staged row | ADR-046 | [[docs/api/imports\|Imports]] |
| POST | `/api/import/batches/:id/commit` | Commit reviewed batch | — | [[docs/api/imports\|Imports]] |

## Attachments (4 endpoints) — Phase 5A

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| POST | `/api/attachments/transaction/:id` | Upload attachment | 60 req/min | [[docs/api/attachments\|Attachments]] |
| GET | `/api/attachments/transaction/:id` | List attachments for transaction | 60 req/min | [[docs/api/attachments\|Attachments]] |
| GET | `/api/attachments/:id/download` | Download attachment file | 60 req/min | [[docs/api/attachments\|Attachments]] |
| DELETE | `/api/attachments/:id` | Delete attachment | 60 req/min | [[docs/api/attachments\|Attachments]] |

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

## Health (2 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/health` | Health check (backend ready) | — | [[docs/api/health\|Health]] |
| GET | `/health/detailed` | Detailed health with cache warmup status | — | [[docs/api/health\|Health]] |

## Admin (13 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/admin` | Admin status | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/database/init` | Verify DB connection | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/database/reset` | Reset database | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/update/check` | Check for updates | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/update/apply` | Acknowledge update | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/update/apply-and-restart` | Apply and restart | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/investments/kinesis/sanitize-history` | Sanitize Kinesis spikes | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/db/stats` | Per-table live/dead row counts and size (Phase 7) | admin | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/db/vacuum` | Run VACUUM ANALYZE on one or all tables (Phase 7) | admin | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/providers/health` | List all provider health records | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/providers/:provider/probe` | Active on-demand probe for one provider | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/metrics/requests` | Rolling request metrics per route (in-memory, 15 min) | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/endpoints` | Static endpoint manifest from Express router | — | [[docs/api/admin\|Admin]] |

## Reports (3 endpoints) — Phase 3 / Phase 5 / Phase 7

Server-side PDF generation via Puppeteer headless Chrome (Phase 3). Modular section architecture with theme-aware styling and period filtering. Theme tokens (HSL) and section selections passed in POST body. Phase 5 adds paginated footers. Phase 7 adds filter exclusions with impact comparison. Returns binary stream (`application/pdf`).

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| POST | `/api/reports/financial` | Generate financial PDF (7 sections: executive summary, cashflow, categories, recipients, bank balances, rolling averages, planned outlook); supports `excludedCategoryIds` and `excludedRecipientIds` for filter impact comparison | — | [[docs/features/pdf-report-export\|PDF Report Export]] |
| POST | `/api/reports/portfolio` | Generate portfolio PDF (6 sections: executive summary, allocation, top holdings, performance trend, asset class detail, dividend income); Phase 8 complete | — | [[docs/features/pdf-report-export\|PDF Report Export]] |
| POST | `/api/reports/tax` | Generate tax PDF (7 sections: executive summary, type breakdown, by asset class, monthly trend, top investments, fee breakdown, Belgian rules); accepts optional `taxProfile` and `precomputedPIT`; Phase 8 complete | — | [[docs/features/pdf-report-export\|PDF Report Export]] |

## Aggregations (10 endpoints) — Phase 2 / Phase 6 / Phase 7 / Phase 10 / Phase D / Phase E / Phase 9 / Phase C / Phase G

Server-computed aggregations with materialized-view/live/cache distinction. Production path as of Phase 9 (shadow mode validation complete). Cash flow forecast added in Phase 6. Sankey flow added in Phase 7. Multi-method forecast added in Phase 10. Phase C adds dashboard frontend visualization with controls and diagnostics panel. Phase D adds persisted accuracy metrics and trend analysis. Phase E adds 6-hour TTL cache materialization with nightly job precompute. Phase G adds per-category breakdown with hierarchical reconciliation.

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
| GET | `/api/aggregations/cashflow-forecast-methods` | Multi-method cash flow forecast for current month (Phase 10 + F, 8 forecasting methods: 7 base + inverse-MSE ensemble + walk-forward backtest; Phase G adds `include_breakdown` param for per-category breakdown) | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/cashflow-forecast-rolling` | Rolling-window forecast: past `days_back` days actuals + next `days_forward` days statistical projection on a date axis (defaults 90/90, max 365 each, sum ≤ 730). Reuses 8-method engine with date-keyed payload, window-relative cumulative anchor; rolling-specific MC defaults (500 paths, P25/P75 percentiles) lower cost for broad horizons; accepts `include_backtest` param for lazy-loaded walk-forward backtest diagnostics (only enabled when user opens diagnostics sheet); uses MC rolling cache with 6-hour TTL. | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/cashflow-forecast-accuracy` | Persisted monthly backtest accuracy per method, with trend history (Phase D) | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/recipient-pivot` | Per-recipient spending keyed by period (monthly/yearly), supports date-range filter; powers custom saved-chart recipient series | — | [[docs/api/aggregations\|Aggregations]] |

## Info/Statistics (15 endpoints — Phase 9 Aggregation Cutover, Phase 14+ Portfolio Totals)

Aggregation routes removed in Phase 9 as migration to `/api/aggregations/*` is complete. These endpoints remain for non-aggregation queries only: portfolio-performance, portfolio-summary (realtime totals, Phase 14), net-worth, exchange-rates, inflation-rates, and supporting refresh endpoints. Portfolio-summary endpoint added 2026-04-29 as single source of truth for dashboard and performance page headline metrics.

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/info` | General statistics | — | [[docs/api/info\|Info]] |
| GET | `/api/info/banks` | List bank accounts | — | [[docs/api/info\|Info]] |
| GET | `/api/info/supported-adapters` | List supported banks | — | [[docs/api/info\|Info]] |
| GET | `/api/info/transaction-count` | Total count | — | [[docs/api/info\|Info]] |
| GET | `/api/info/transaction-summary` | Summary with filters | — | [[docs/api/info\|Info]] |
| GET | `/api/info/planned-expenses-next-month` | Next month expenses | — | [[docs/api/info\|Info]] |
| GET | `/api/info/recurring-patterns` | Recurring detection | — | [[docs/api/info\|Info]] |
| GET | `/api/info/net-worth` | Net worth (optional `limit`/`offset` paginate snapshots newest-first; omit both for full history) | 30 req/min | [[docs/api/info\|Info]] |
| GET | `/api/info/exchange-rates` | Exchange rates | 30 req/min | [[docs/api/info\|Info]] |
| POST | `/api/info/exchange-rates/refresh` | Refresh exchange rates | admin | [[docs/api/info\|Info]] |
| GET | `/api/info/inflation-rates` | Inflation rates | 30 req/min | [[docs/api/info\|Info]] |
| POST | `/api/info/inflation-rates/refresh` | Refresh inflation | admin | [[docs/api/info\|Info]] |
| POST | `/api/info/refresh-views` | Refresh materialized views | — | [[docs/api/info\|Info]] |
| GET | `/api/info/portfolio-performance` | Performance snapshots, metrics, heatmap | 30 req/min | [[docs/api/info\|Info]] |
| GET | `/api/info/portfolio-summary` | Realtime portfolio totals (single source of truth for dashboard + performance) | 60 req/min | [[docs/api/portfolio-summary\|Portfolio Summary]] |

## AI Chat (9 endpoints + 30 tool-calling tools)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/ai/status` | Ollama reachability + default model | — | [[docs/api/ai\|AI Chat]] |
| GET | `/api/ai/models` | Installed Ollama models (pass-through) | — | [[docs/api/ai\|AI Chat]] |
| GET | `/api/ai/conversations` | List conversations (newest first) | — | [[docs/api/ai\|AI Chat]] |
| POST | `/api/ai/conversations` | Create empty conversation (pre-created before streaming to avoid PENDING bookkeeping) | — | [[docs/api/ai\|AI Chat]] |
| GET | `/api/ai/conversations/:id` | Conversation with messages | — | [[docs/api/ai\|AI Chat]] |
| PATCH | `/api/ai/conversations/:id` | Rename | — | [[docs/api/ai\|AI Chat]] |
| DELETE | `/api/ai/conversations/:id` | Delete (cascades messages) | — | [[docs/api/ai\|AI Chat]] |
| POST | `/api/ai/chat` | Chat turn (JSON); invokes 30 read-only tools | 30 req/min | [[docs/api/ai\|AI Chat]] |
| POST | `/api/ai/chat/stream` | Chat turn (SSE stream); invokes 30 read-only tools; stream runs in background store and survives navigation | 30 req/min | [[docs/api/ai\|AI Chat]] |

**Tool Categories (30 total):** Expenses (11), Portfolio (6), Planned (4), Belgian Tax (3), Insights (6). See [[docs/features/ai-chat#tool-registry-30-tools-across-6-domains\|AI Chat Feature]] for full reference.

**Streaming Lifecycle:** Frontend pre-creates conversation via POST `/api/ai/conversations`, then streams via POST `/api/ai/chat/stream`. Stream lives in module-level `aiChatStreamStore`; user can navigate away and stream continues. On completion, TanStack Query cache invalidates to hydrate persisted messages. Sidebar shows pulsing indicator for active streams via `useStreamingConversationIds()`.

## IPC Handlers — Electron Desktop (8 handlers — Phase 1+2)

Electron-specific inter-process communication for desktop features (backup, restore, file dialogs):

| Handler | Arguments | Returns | Description |
|---------|-----------|---------|-------------|
| `backup:run` | `(destDir: string, frontendStateJson?: string)` | `Promise<{ success: boolean; file?: string; encrypted?: boolean; cleanupRemoved?: number; warning?: string; error?: string }>` | Create `.visionbak` bundle; optionally encrypt to `.visionbak.enc`. Includes DB dump, attachments tree, and serialized frontend state (theme, dismissed toasts, etc.). |
| `backup:restore` | `(bundlePath: string)` | `Promise<{ success: boolean; file?: string; frontendState?: { keys: Record<string, string> }; error?: string }>` | Restore from `.visionbak` or `.visionbak.enc` bundle. Validates schema head, drops DB, loads SQL, atomically swaps attachments, returns frontend state for localStorage hydration. Blocks if bundle schema is newer (user must upgrade Vision first). |
| `backup:select-file` | `()` | `Promise<string>` | Show native file picker dialog; returns selected `.visionbak` or `.visionbak.enc` file path. |
| `backup:select-dir` | `()` | `Promise<string>` | Show native folder picker dialog; returns selected directory for backup destination. |
| `backup:save-settings` | `({ backupDir, backupOnQuit })` | `Promise<void>` | Persist backup settings (directory path, auto-backup-on-quit flag) to `settings.json`. |
| `backup:load-settings` | `()` | `Promise<{ backupDir: string; backupOnQuit: boolean }>` | Load backup settings from `settings.json` with fallback to default `~/Vision/backups`. |
| `backup:get-encryption-status` | `()` | `Promise<{ hasStoredPassphrase: boolean }>` | Check if user has stored a backup encryption passphrase. |
| `backup:set-passphrase` | `(passphrase: string)` | `Promise<void>` | Set or update backup encryption passphrase (stored encrypted in `settings.json` via `safeStorage`). Empty string clears passphrase. |

**Frontend Wrappers:** `apps/frontend/src/lib/api/electron.ts` provides TypeScript signatures and async wrappers for all IPC handlers.

**Integration:** `apps/frontend/src/components/settings/tabs/BackupTab.tsx` uses these handlers for UI-driven backup/restore, directory/file selection, and passphrase management.

**Documentation:** See [[docs/features/backup-coverage-audit|Backup Coverage Audit]] for bundle format, coverage matrix, and restoration process.

## Summary

| Resource | Endpoints | Rate-Limited |
|----------|-----------|--------------|
| Transactions | 7 | 2 |
| Categories | 7 | 0 |
| Recipients | 9 | 0 |
| Planned Transactions | 7 | 1 |
| Investments | 14 | 0 |
| Watchlist | 5 | 0 |
| Market Lookup | 4 | 0 |
| Import | 6 | 0 |
| Attachments (Phase 5A) | 4 | 0 |
| Saved Charts | 4 | 0 |
| Settings | 5 | 0 |
| Recipient Bank Accounts | 5 | 0 |
| Admin | 13 | 0 |
| Splits | 11 | 0 |
| Health | 2 | 0 |
| Aggregations (Phase 2/6/10/D) | 10 | 0 |
| Reports (Phase 3/7) | 3 | 0 |
| Info/Statistics (Phase 14) | 15 | 5 |
| AI Chat | 9 | 2 |
| IPC Handlers (Phase 1+2) | 8 | 0 |
| **Total** | **150** | **10** |

## Phase G Endpoint Consolidation (April 2026)

Six `/api/info/*` endpoints were removed as they are now superseded by `/api/aggregations/*` equivalents. The backend routes no longer handle these paths. Frontend method signatures are preserved through proxy wrappers in `apiClient`.

| Removed Endpoint | Replacement | Frontend Method | Status |
|------------------|------------|-----------------|--------|
| `GET /api/info/monthly-summary` | `GET /api/aggregations/monthly-summary` | `apiClient.getMonthlyFinancialSummary()` | Unwrapped |
| `GET /api/info/average-vs-current-spending` | `GET /api/aggregations/average-vs-current` | _(internal)_ | Aggregations only |
| `GET /api/info/cashflow-comparison` | `GET /api/aggregations/cashflow-comparison` | `apiClient.getCashflowComparison()` | Unwrapped |
| `GET /api/info/category-breakdown` | `GET /api/aggregations/category-breakdown` | _(internal)_ | Aggregations only |
| `GET /api/info/bank-balances` | `GET /api/aggregations/bank-balances` | `apiClient.getBankBalances()` | Unwrapped |
| `GET /api/info/recipient-insights` | `GET /api/aggregations/recipient-insights` | `apiClient.getRecipientInsights()` | Unwrapped |

**Unwrapped methods:** Frontend methods proxy to aggregations and unwrap the [[docs/adr/026-unified-api-response-envelope|unified response envelope]] to preserve backward-compatible signatures for call sites. See [[docs/reference/api-client-methods#info--statistics-phase-g-aggregation-migration|API Client Methods]] for details.

**Aggregations-only:** Some removed endpoints have no direct frontend method and are consumed only via aggregation API internals (e.g., `average-vs-current`, `category-breakdown`).

See [[docs/api/info.md|Info & Analytics API]] for deprecation notes on the removed routes.

## Related

- [[docs/reference/error-codes\|Error Codes Reference]]
- [[docs/reference/code-patterns\|Code Patterns Reference]]
- [[docs/security/rate-limiting\|Rate Limiting]]
- [[docs/common-tasks\|Common Tasks Quick Reference]]
