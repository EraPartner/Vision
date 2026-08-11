---
title: API Endpoint Matrix
type: reference
status: active
date: 2026-04-27
updated: 2026-08-11
last_modified: 2026-06-19
adr-reference: 026
# Authoritative HTTP-operation count, derived from openapi.yaml and enforced by
# scripts/check-endpoint-matrix.js (CI verify-generated). Bump when routes change.
api_operation_count: 212
tags: [reference, api, endpoints, matrix, overview, openapi, phase-1, phase-2, phase-3, phase-4, phase-5a, phase-5, phase-6, phase-7, phase-8, phase-g, phase-9, phase-13, phase-c, phase-d, phase-e, phase-f, cashflow-forecast, bill-reminders, sankey, pdf-report, db-maintenance, db-data-editor, puppeteer, reports, multi-method-forecast, accuracy-persistence, materialized-cache, ensemble-methods, dependency-slim-down, backup, ipc, electron, drillthrough, export-filters, multi-select, ing, bnp, supported-adapters, portfolio-import, portfolio-csv-import, adr-078, adr-101, research, adr-079, adr-081, multi-provider, capability-map, quota-governor, monte-carlo, portfolio-projection, fundamentals-scorecard, chart-builder, auto-link, planned-match]
description: Complete matrix of all 212 HTTP API operations (authoritative count from openapi.yaml) across the route files, plus 8 Electron IPC handlers, organized by resource for quick lookup. 2026-07-22 (WP-C1 / ADR-108): removed POST /api/investments/{id}/move (moveHoldingService deleted — in-specie moves become bulk re-tags in a later WP) and GET /api/info/net-worth/by-account (snapshot per-account split deleted; per-broker history returns later on a persisted side table); api_operation_count 214 → 212; Investments group now 14 endpoints, Info group now 13. 2026-07-22 (WP-A3): Accounts add the read-only merge preview — GET /api/accounts/{id}/merge-preview?into= (row counts to move, projected post-merge computed balance over the union, stampsInterleaved guard flag); api_operation_count 213 → 214; Accounts group now 9 endpoints. 2026-07-10 (ADR-094): Accounts add the opening-balance anchor and reconcile flows — POST /api/accounts/{id}/opening-balance and POST /api/accounts/{id}/reconcile; api_operation_count 211 → 213; Accounts group now 8 endpoints. 2026-06-26 (ranked + all-sources): saved-charts endpoints gain ranked chart_variant and all_categories/all_recipients/all_tags boolean fields (migration 0064); GET /api/aggregations/tag-pivot gains all=true param for dynamic all-tags mode; no new routes — count unchanged at 211. 2026-06-26: Custom-chart tag series add GET /api/aggregations/tag-pivot (per-tag spending pivot for saved custom charts; ADR-052) and the saved_charts.tag_ids column (migration 0063); api_operation_count 210 → 211; Aggregations group now 15 endpoints. 2026-06-19: removed GET /api/cross-workspace/unified-tax (Unified Tax view retired — feature removed end-to-end across page, route, pure cores, types, and i18n; ADR-102 supersedes the unified-tax part of ADR-098); api_operation_count 211 → 210; Cross-Workspace group now 1 endpoint. 2026-06-19: openapi.yaml reconciled to the implemented routes — documented GET /api/info/net-worth/by-account (Σ-accounts, ADR-100) and the 3 DB Data Editor admin endpoints (ADR-101: tables/:table/schema, /rows, /mutate), and corrected the accounts merge operation that was mis-pathed under POST /api/accounts/{id} to POST /api/accounts/{id}/merge; api_operation_count 208 → 209. 2026-06-18 (ADR-101): DB Data Editor adds 3 admin endpoints — GET /api/admin/database/tables/:table/schema, GET /api/admin/database/tables/:table/rows, POST /api/admin/database/tables/:table/mutate; Admin group total: 17 endpoints. 2026-06-18 (ADR-088): Account entity adds 6 endpoints under /api/accounts (GET list, POST create, GET/PATCH/DELETE by id, POST :id/merge); Accounts group total: 6 endpoints. 2026-06-17 (ADR-082): Macroeconomic Indicators data vertical adds 2 endpoints to the Research group — GET /api/research/macro/search (fan-out catalog search across FRED/Eurostat/DBnomics) and GET /api/research/macro/series (provider-pinned observations: CPI, rates, unemployment, …); Research group total: 18 endpoints. 2026-06-17: Auto-link planned payments on match adds GET /api/planned-transactions/match-suggestions; Planned Transactions total: 8 endpoints. 2026-06-16 (ADR-081): Research Analytics & Forecasting Expansion adds 2 endpoints to the Research group — GET /api/research/scorecard (heuristic fundamentals scorecard, 0-100 grade, per-metric flags) and POST /api/research/portfolio-forecast (Monte Carlo portfolio value projection, parametric/block-bootstrap, P10–P90 bands, non-persisted); also adds optional provider query param to GET /api/research/chart. Research group total: 16 endpoints. 2026-06-16 (ADR-079): Research aggregation layer adds 14 endpoints under /api/research — 6 data (search, quote, chart, fundamentals, analyst, news) with provider-agnostic envelope (meta.provider, meta.source) + 5 cross-provider symbol-mapping (GET/POST/DELETE /api/research/mappings, POST /mappings/resolve, POST /mappings/audit) + 3 provider-key Settings endpoints (GET /provider-keys, PUT/DELETE /provider-keys/:provider). 2026-06-15 (ADR-078): Portfolio CSV Import adds 12 endpoints under /api/portfolio/import (2 upload, 2 SSE, 4 parser CRUD, 4 batch/review). 2026-06-01 (ADR-066): Saved Named Custom CSV Parsers adds 4 Import endpoints (GET/POST /api/import/parsers, PATCH/DELETE /api/import/parsers/:id). Phase 1+2 adds 8 IPC handlers for bundle-based backup/restore with AES-256-CBC encryption and schema-safe restore. Phase 3 adds three new POST report endpoints with Puppeteer rendering. Phase 5A adds JSON export and attachments. Phase 6 adds cash flow forecast. Phase 7 adds Sankey flow and DB maintenance. Phase 8 completes portfolio and tax report generation (6 + 7 sections respectively). Phase F adds 4 admin endpoints. Phase 10 adds multi-method cash flow forecast. Phase C adds dashboard frontend visualization for Phase 10 forecast. Phase D adds persisted accuracy metrics endpoint. Phase E adds cache-aware forecast endpoint with materialized MC cache. Phase H adds rolling-window forecast with rolling-specific MC defaults (500 paths, P25/P75) and lazy-loaded diagnostics. Phase G removes 6 overlapping info endpoints in favor of aggregations. Phase 9 completes aggregation shadow cutover. Phase 13 adds multi-select export filters (`bank_accounts`, `category_ids` params); May 12 2026: ING and BNP Paribas Fortis adapters added (8 banks total); see openapi.yaml for authoritative spec.
aliases: [api matrix, endpoint matrix, all endpoints, api overview, endpoint list]
---

# API Endpoint Matrix

> [!abstract] Overview
> **212 HTTP API operations** (authoritative count = operations in `openapi.yaml`, enforced by `scripts/check-endpoint-matrix.js` in CI) plus 2 unversioned `/health` endpoints and 8 Electron IPC handlers, across the route files. The per-resource tables below are a navigational index — `openapi.yaml` is the source of truth. (updated 2026-07-22 — WP-C1 / ADR-108 removes `POST /api/investments/:id/move` and `GET /api/info/net-worth/by-account`; count 214 → 212; Investments total: 14; Info total: 13; updated 2026-07-22 — WP-A3 adds `GET /api/accounts/:id/merge-preview` (read-only dry-run: reassigned row counts, projected union balance, `stampsInterleaved`); count 213 → 214; Accounts total: 9; updated 2026-06-19 — reconciled `openapi.yaml` to the implemented routes: documented `GET /api/info/net-worth/by-account` (Σ-accounts, ADR-100) and the 3 DB Data Editor admin endpoints (ADR-101), and moved the accounts merge operation from the mis-pathed `POST /api/accounts/{id}` to `POST /api/accounts/{id}/merge`; count 208 → 209; updated 2026-06-18 — DB Data Editor (ADR-101) adds 3 admin endpoints: `GET /api/admin/database/tables/:table/schema`, `GET /api/admin/database/tables/:table/rows`, `POST /api/admin/database/tables/:table/mutate` (Admin total: 14→17); Account entity (ADR-088) adds 6 endpoints under `/api/accounts`: `GET/POST /api/accounts`, `GET/PATCH/DELETE /api/accounts/:id`, `POST /api/accounts/:id/merge` (Accounts total: 6); 2026-06-17 — Macroeconomic Indicators (ADR-082) add `GET /api/research/macro/search` + `GET /api/research/macro/series` (Research total: 18); Auto-link planned payments on match adds `GET /api/planned-transactions/match-suggestions` (Planned total: 8); 2026-06-16 — Research Analytics & Forecasting Expansion (ADR-081) adds 2 endpoints to the Research group: `GET /api/research/scorecard` and `POST /api/research/portfolio-forecast` (Research total: 16→18); also adds optional `provider` param to `GET /api/research/chart`; 2026-06-16 — Research aggregation (ADR-079) adds 14 endpoints under `/api/research` (6 data + 5 symbol-mapping + 3 provider-key); 2026-06-15 — Portfolio CSV Import (ADR-078) adds 12 endpoints under `/api/portfolio/import`; 2026-06-01 — Saved Named Custom CSV Parsers (ADR-066) adds 4 endpoints: `GET/POST /api/import/parsers` and `PATCH/DELETE /api/import/parsers/:id`; prior: 2026-05-16 — Bulk Actions feature adds `POST /api/transactions/bulk-delete`, `POST /api/transactions/bulk-update`, and `POST /api/transactions/bulk-export`; Tags feature adds `GET/POST /api/tags`, `PATCH/DELETE /api/tags/:id`, `POST /api/transactions/bulk-tag`, and `tags` query param on `GET /api/transactions` and both export endpoints; prior: 2026-04-29 — Phase 14 adds portfolio-summary realtime totals endpoint; Phase 13 adds `category_ids` and `transaction_type` query params to `GET /api/transactions` for pivot table drillthrough; unifies export endpoint filters with `GET /api/transactions` by delegating to shared `buildTransactionWhere`, enabling `transaction_id`, `recipient_id`, `recipient_name`, `search`, and `transaction_type` on export endpoints; adds `bank_accounts` and `category_ids` multi-select params to both list and export for flexible filtering via UI pickers; Phase 7 adds filter exclusions (`excludedCategoryIds`, `excludedRecipientIds`) to report endpoints with filter impact comparison view; adds `GET /api/recipients/clusters` for merge candidate identification; Phase E adds cache-aware forecast endpoint with 6-hour TTL materialized cache; Phase D adds persisted accuracy metrics endpoint; Phase 9 — aggregation shadow cutover complete; Phase F adds 4 admin endpoints for provider health, endpoint liveness, and metrics; Phase 10 adds multi-method cash flow forecast endpoint; Phase C adds dashboard frontend visualization for Phase 10 forecast; Phase 5 slim-down removes legacy GET `/api/reports/financial` endpoint; bank reconciliation removed). Use this as a quick reference to find any endpoint.
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
>
> **2026-08-11 — path-param id validation tightened (BREAKING, no route changes; operation count unchanged at 212):** every integer `:id` / `:patternId` / `:accountId` / `:txnId` path param now accepts **only** a plain base-10 integer in 1..2³¹−1. Previously `validateId` used `parseInt`, so `"12abc"` and `"12.5"` resolved to id **12** and `"1e3"` to id **1** — a malformed id silently addressed a record the client never named (e.g. `DELETE /api/research/mappings/12abc` deleted mapping 12). Such requests now return **400 `VALIDATION_ERROR`** (`"<field> must be a positive integer"`) instead of acting on a coerced id. Affects the 13 routers on `validateIdParam`/`validateIntParam`: Accounts, Attachments, Categories, Investments, Planned Transactions, Recipients (+ Recipient Bank Accounts), Research (`DELETE /mappings/:id`), Saved Charts, Splits, Tags, Transactions, Watchlist. Breaking **only** for clients that were sending malformed ids — a plain integer behaves exactly as before, and `openapi.yaml` already typed these params `integer` (now annotated `format: int32, minimum: 1`), so the implementation moved *onto* the published contract rather than away from it. Import batch/row ids (`/api/import/batches/*`, `/api/portfolio/import/batches/*`) were unaffected by *this* change — they used a separate validator that already rejected `"12abc"` — but see the follow-up below, which converged them.
>
> **2026-08-11 — id-array and import batch/row id validation converged on `validateId` (BREAKING, no route changes; operation count unchanged at 212):** follow-up to the entry above, closing the two residues it left.
> 1. **`validateIntArray`** carried the same `parseInt` truncation for **body id arrays**: `["12abc"]` was silently accepted as `[12]`. Because these feed exclusion and filter sets rather than a record lookup, a truncated element did not 404 — it quietly changed which rows an aggregation or saved chart covered, with no error surfaced. Affects `POST`/`PATCH /api/saved-charts` (`categoryIds`, `recipientIds`, `tagIds`) and `PUT /api/settings/:key` + the bulk upsert (`dashboard_settings.excludedCategoryIds` / `.excludedRecipientIds`). Each element now goes through `validateId`; one bad element rejects the whole request with **400 `VALIDATION_ERROR`**.
> 2. **`coercedIdSchema`** (`lib/importBatchIds.js`, the batch/row ids on the 11 `/api/import/batches/*` and `/api/portfolio/import/batches/*` sites) was a bare `Number()` coercion and now delegates to `validateId`, so the repo has **one** definition of a valid id instead of two kept in step by hand. It previously addressed a *different batch* on `"0x10"` → 16, `"1e3"` → 1000, `"0o17"` → 15, `"0b11"` → 3 and `"9007199254740993"` → …992, and additionally took `"+5"`, `" 12 "` and `"12.0"`; all now **400**. The bound is deliberately `Number.MAX_SAFE_INTEGER`, not `int32`, because `import_batches.id` and `import_staging_rows.id` (and the portfolio pair) are `BIGSERIAL` — an integral id above `int32` is a legal row and still reaches the repository, 404ing if absent. `"1e300"`, previously let through to that same 404, is now a 400.
>
> Breaking **only** for clients sending malformed ids; plain integers behave exactly as before, and no shipped frontend caller emits an affected shape (all four array fields are typed `number[]`, and `batchId`/`rowId` are `number`). No `openapi.yaml` operation, path or schema changed. See [[docs/security/input-validation#ID Validation|Input Validation]].
>
> **2026-08-11 — id-array *query* params and the AI-chat tool parser converged too (BREAKING for malformed ids, no route changes; operation count unchanged at 212):** the last two id parsers, closing the class.
> 1. **`parseNumericArrayQueryParam`** (`routes/aggregations.js`) was `.map(Number).filter(Number.isFinite)`, so it **dropped** a bad element instead of rejecting it — worse than the body case above, which at least refused the request. `?excluded_category_ids=12abc` yielded `[]`, switching the exclusion **off entirely** and answering with a different dataset than the user asked for, with nothing surfaced; `"0x10"` decoded to 16 and `"1e3"` to 1000, excluding a category nobody named. Id params now go through `parseIdArrayQueryParam` → `validateIntArray` → `validateId` and a bad element is a **400 `VALIDATION_ERROR`** (`"<field> contains invalid value: <value>"`). Affects `excluded_category_ids` / `excluded_recipient_ids` on `GET /api/aggregations/{monthly-summary, recipient-insights, cashflow-comparison, cashflow-forecast-methods, cashflow-forecast-rolling, sankey, category-pivot, recipient-by-year}`, plus `recipient_ids` on `recipient-pivot` and `tag_ids` on `tag-pivot`. **An absent or empty param is unchanged** — `?excluded_category_ids=` still means "no exclusions" and answers 200, which is what every shipped caller sends when its list is empty. `mc_percentiles` deliberately keeps the lenient numeric parser (percentiles are not ids).
> 2. **`parsePositiveInt`** (`services/aiChat/tools/_validate.js`) was still `parseInt`-based, so the AI-chat tools' `categoryId`/`recipientId`/`plannedId` took `"12abc"` as 12 — a model emitting a malformed id operated on the wrong record and got a plausible answer instead of an error it could correct. It now delegates to `validateId` for shape, keeping each call site's own `min`/`max`, and returns a `VALIDATION_ERROR` naming the field and the received value.
>
> Non-breaking for every shipped caller: the frontend builds these query params from `number[]` state with `String(id)` and omits the param entirely when the list is empty. No `openapi.yaml` operation, path or schema changed. See [[docs/security/input-validation#Repeatable ID Query Params (aggregations)|Input Validation]].
>
> **2026-08-11 — the transactions list/export id query params, the fifth and last set (BREAKING for malformed ids, no route changes; operation count unchanged at 212):** these sat **upstream** of `validateInt4Ids`, so the SQL-build convergence above did not close them — the truncated value was already a clean integer by the time the builder saw it.
> 1. **Comma-separated id lists** — `category_ids` on `GET /api/transactions` and both export endpoints, `account_ids` on both export endpoints — were `.split(',').map(parseInt).filter(isFinite && > 0)` and had *both* failure modes. **Retarget:** `?category_ids=5,12abc` filtered by categories 5 **and 12**; `?account_ids=12abc` exported account **12**. **Widen:** an all-bad list parsed to `[]`, which the caller mapped back to "no filter", so `?account_ids=abc` emitted no account predicate at all and `GET /export/csv` streamed **every account's transactions** into the downloaded file, 200 and all. They now go through `parseIdListQueryParam` → `validateIntArray` → `validateId`; a bad element is **400 `VALIDATION_ERROR`** (`"<field> contains invalid value: <value>"`). `account_ids` is validated in full *before* `EXPORT_MAX_LIST_SIZE` caps it.
> 2. **Scalar id filters** — `transaction_id`, `category_id`, `recipient_id`, `recipient_group_id` on the list and both exports — were bare `parseInt`, so `?category_id=12abc` filtered by category 12 and `?recipient_group_id=1e3` by group 1. They now use `assertOptionalId`, joining `account_id`, which already did. A `NaN` (what the Transactions page sends for a hand-edited URL) previously passed the builder's `!= null` guard and 500'd at Postgres as 22P02; it is now a 400.
> 3. **`POST /api/transactions/transfers`** (`aId`/`bId`) was bare `parseInt` guarded only by `Number.isInteger`, so `"12abc"` stamped transaction **12** as one leg of a transfer pair — a wrong-record *write* — and an id past `int4` passed the guard and 500'd at the column. Both now go through `validateId`.
>
> **Absent and empty are unchanged** — `?category_ids=`, `?category_id=` still mean "no filter" and answer 200. Non-breaking for shipped callers: the Transactions page and the Imports Export card build these with `ids.join(',')` from `number[]` state and omit empty values; nothing in the frontend sends `account_ids`. `openapi.yaml` already typed the four scalars `integer` (now annotated `format: int32, minimum: 1`, and the two comma lists carry a documented `pattern`), so the implementation moved *onto* the published contract. See [[docs/security/input-validation#Comma-separated ID Query Params (transactions list + export)|Input Validation]].

## Accounts (9 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/accounts` | List accounts (`?active=true\|false\|all`, default true; optional `limit`/`offset` — omit both for the full list) (ADR-088) | — | [[docs/api/accounts\|Accounts]] |
| POST | `/api/accounts` | Create account | — | [[docs/api/accounts\|Accounts]] |
| GET | `/api/accounts/:id` | Get single account | — | [[docs/api/accounts\|Accounts]] |
| PATCH | `/api/accounts/:id` | Update account (partial) | — | [[docs/api/accounts\|Accounts]] |
| DELETE | `/api/accounts/:id` | Delete account (409 if still referenced — archive instead) | — | [[docs/api/accounts\|Accounts]] |
| GET | `/api/accounts/:id/merge-preview` | Read-only dry-run of merging `:id` into `?into=`: reassigned row counts, projected post-merge computed balance over the union, `stampsInterleaved` (§1 F2 guard) | — | [[docs/api/accounts\|Accounts]] |
| POST | `/api/accounts/:id/merge` | Merge source accounts into this survivor; repoints all references + deletes sources (ADR-088) | — | [[docs/api/accounts\|Accounts]] |
| POST | `/api/accounts/:id/opening-balance` | Set the opening-balance anchor (one system row per account+currency; ADR-094 D4) | — | [[docs/api/accounts\|Accounts]] |
| POST | `/api/accounts/:id/reconcile` | Resolve the drift: accept the computed balance or add an adjustment transaction (ADR-094 Phase C) | — | [[docs/api/accounts\|Accounts]] |

## Cross-Workspace (1 endpoint — ADR-098)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| POST | `/api/cross-workspace/rebalance` | Cash-aware rebalancing: deploy spendable cash into underweight sleeves toward a target allocation, no sells (ADR-098) | — | — |

## Transactions (18 endpoints — incl. 4 Tags endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/transactions` | List with filtering/pagination (Phase 13: supports `transaction_id`, `recipient_id`, `recipient_name`, `search`, `transaction_type`, `category_ids`, `bank_accounts`; also single `bank_account` — used by the accounts-hub double-click deep link, 2026-06-19; 2026-06-28 additive: `amount_min`, `amount_max`, `amount_exact` filter on ABS magnitude, plus `amount_signed=true` to compare the signed `t.amount` instead; `search` now also matches ISO date text and active tag slugs) | — | [[docs/api/transactions\|Transactions]] |
| GET | `/api/transactions/export/csv` | Export as CSV (streaming, chunked); accepts same filters as `GET /api/transactions` (Phase 13); 2026-06-28: `amount_min`/`amount_max` added | 30 req/min | [[docs/api/transactions\|Transactions]] |
| GET | `/api/transactions/export/json` | Export as NDJSON (streaming, chunked); accepts same filters as `GET /api/transactions` (Phase 13); 2026-06-28: `amount_min`/`amount_max` added | 30 req/min | [[docs/api/transactions\|Transactions]] |
| GET | `/api/transactions/:id` | Get single | — | [[docs/api/transactions\|Transactions]] |
| POST | `/api/transactions` | Create | — | [[docs/api/transactions\|Transactions]] |
| PATCH | `/api/transactions/:id` | Update | 30 req/min | [[docs/api/transactions\|Transactions]] |
| DELETE | `/api/transactions/:id` | Hard delete | — | [[docs/api/transactions\|Transactions]] |
| POST | `/api/transactions/bulk-tag` | Atomically add/remove tags on 1–500 transactions | 30 req/min | [[docs/features/tags\|Tags]] |
| POST | `/api/transactions/bulk-delete` | Hard-delete by `ids` (≤500) or `filter` (≤5000 matches) | 30 req/min | [[docs/features/bulk-actions\|Bulk Actions]] |
| POST | `/api/transactions/bulk-update` | Apply category/recipient/active update to a selection | 30 req/min | [[docs/features/bulk-actions\|Bulk Actions]] |
| POST | `/api/transactions/bulk-export` | Stream CSV/NDJSON for an ids- or filter-resolved selection | 30 req/min | [[docs/features/bulk-actions\|Bulk Actions]] |
| GET | `/api/transactions/transfer-suggestions` | Ambiguous internal-transfer matches awaiting confirmation (ADR-083) | — | [[docs/features/transfers\|Transfers]] |
| POST | `/api/transactions/transfers` | Manually confirm a transfer pair `{aId,bId}` | — | [[docs/features/transfers\|Transfers]] |
| DELETE | `/api/transactions/transfers/:id` | Clear a transfer mark (and its peer) | — | [[docs/features/transfers\|Transfers]] |
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

## Recipients (14 endpoints)

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
| GET | `/api/recipients/:id/patterns` | List matching patterns for recipient | — | [[docs/api/recipients\|Recipients]] |
| POST | `/api/recipients/:id/patterns` | Create matching pattern | — | [[docs/api/recipients\|Recipients]] |
| POST | `/api/recipients/:id/patterns/preview` | Preview transactions matched by a pattern | — | [[docs/api/recipients\|Recipients]] |
| PATCH | `/api/recipients/:id/patterns/:patternId` | Update pattern | — | [[docs/api/recipients\|Recipients]] |
| DELETE | `/api/recipients/:id/patterns/:patternId` | Delete pattern | — | [[docs/api/recipients\|Recipients]] |

## Planned Transactions (8 endpoints) — Phase 3 / Phase 6 / June 2026

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/planned-transactions` | List | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| POST | `/api/planned-transactions` | Create (supports loans) | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| GET | `/api/planned-transactions/:id` | Get single | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| PATCH | `/api/planned-transactions/:id` | Update | 30 req/min | [[docs/api/plannedTransactions\|Planned Transactions]] |
| POST | `/api/planned-transactions/:id/execute` | Execute (atomic, idempotent — Phase 3) | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| DELETE | `/api/planned-transactions/:id` | Hard delete | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| GET | `/api/planned-transactions/due-soon` | Upcoming bills within N days (Phase 6) | — | [[docs/api/plannedTransactions\|Planned Transactions]] |
| GET | `/api/planned-transactions/match-suggestions` | Ambiguous auto-link candidates for user confirmation (June 2026; registered before `/:id`) | — | [[docs/api/plannedTransactions\|Planned Transactions]] |

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
| GET | `/api/market/quote` | Get quotes; optional `detail=basic\|full` (default `full`) — `basic` skips `quoteSummary` fetch, returns price-only fields, halves Yahoo calls for benchmark strip / watchlist / chart-dialog callers | — | [[docs/api/marketLookup\|Market Lookup]] |
| GET | `/api/market/chart` | Historical chart data | — | [[docs/api/marketLookup\|Market Lookup]] |
| GET | `/api/market/news` | News articles | — | [[docs/api/marketLookup\|Market Lookup]] |

## Research (18 endpoints) — ADR-079, ADR-081, ADR-082

Provider-agnostic research surface mounted at `/api/research` under `marketRateLimiter`. Six data endpoints route through the capability map → quota governor → cache → race-to-first provider, **except `fundamentals`** which fetches FMP + Yahoo in parallel and merges field-by-field (FMP preferred) via `researchAggregator.fetchFundamentals()`. Two analytics endpoints (`scorecard`, `portfolio-forecast`) compute derived outputs from aggregated data; the projection endpoint is non-persisted (ADR-079 / ADR-065 storage boundary). All data-endpoint responses carry `meta.provider` (which provider answered, or `null`; may be `"fmp+yahoo"` composite for fundamentals/scorecard) and `meta.source` (`'cache'` | `'live'` | `'unavailable'`). All five symbol adapters are wired; the keyed four (Twelve Data / Finnhub / FMP / Alpha Vantage) light up when their API key is set via Settings (`/provider-keys`) or the root `.env` (ADR-080). The **macro vertical** (ADR-082) adds three more adapters — FRED (keyed `FRED_API_KEY`), Eurostat and DBnomics (keyless) — behind two **provider-pinned** endpoints (`macro/search` fans out + unions a catalog; `macro/series` fetches one provider's observations); macro data is never raced and never persisted to `asset_price_history`. See [[docs/api/research|Research API]] and [[docs/features/research|Research Feature]].

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/research/search` | Search tickers / securities by name or symbol; returns `{ items: [] }` when query is blank | — | [[docs/api/research\|Research]] |
| GET | `/api/research/quote` | Current quote for `symbol` (+ optional `asset_class` hint for provider routing) | — | [[docs/api/research\|Research]] |
| GET | `/api/research/chart` | Historical chart points; `range` default `1mo` (1d/5d/1mo/3mo/6mo/1y/2y/5y/max); optional `provider` param pins preferred provider (ADR-081) | — | [[docs/api/research\|Research]] |
| GET | `/api/research/fundamentals` | Extended fundamentals snapshot merged from FMP + Yahoo in parallel (FMP preferred per field, Yahoo fills gaps; `meta.provider` may be `"fmp+yahoo"`); fields: P/E, EPS, market cap + ADR-081: sector, pegRatio, payoutRatio, grossMargin, operatingMargin, debtToEquity, currentRatio, revenueGrowth, freeCashFlow, fcfYield, …; 12 h cache | — | [[docs/api/research\|Research]] |
| GET | `/api/research/analyst` | Analyst consensus + price targets + recent rating actions; 24 h cache | — | [[docs/api/research\|Research]] |
| GET | `/api/research/news` | News articles for a symbol; 2 h cache | — | [[docs/api/research\|Research]] |
| GET | `/api/research/macro/search` | Search macroeconomic series (CPI, rates, unemployment, …); fan-out union across FRED (open) + Eurostat/DBnomics (curated catalog); items carry `{ provider, seriesId, title, region, units, source }` (ADR-082); 1 h cache | — | [[docs/api/research\|Research]] |
| GET | `/api/research/macro/series` | Observations for one provider-pinned macro series; params `provider` (fred/eurostat/dbnomics), `series_id`, `range`; value→close chart points (ADR-082); 12 h cache | — | [[docs/api/research\|Research]] |
| GET | `/api/research/scorecard` | Heuristic fundamentals scorecard: 0–100 score, A–F grade, per-metric flags with severity (ok/caution/warn/risk); missing fields skipped not penalized (ADR-081); fundamentals sourced via merged FMP + Yahoo (same as `/fundamentals`); `meta.provider` may be `"fmp+yahoo"` | — | [[docs/api/research\|Research]] |
| POST | `/api/research/portfolio-forecast` | Monte Carlo projection of aggregate portfolio value; body: horizon_months, monthly_contribution, paths, forward_blend, method (parametric/block_bootstrap), target_value, currency, seed; returns P10–P90 bands + summary + forward-input provenance; non-persisted (ADR-081) | — | [[docs/api/research\|Research]] |
| GET | `/api/research/mappings` | List stored cross-provider mappings for `instrument_key`/`key_type` | — | [[docs/api/research\|Research]] |
| POST | `/api/research/mappings/resolve` | Auto-propose per-provider symbols (provider searches; user confirms resolved instrument) | — | [[docs/api/research\|Research]] |
| POST | `/api/research/mappings` | Persist user-confirmed mappings (upsert per provider) | — | [[docs/api/research\|Research]] |
| DELETE | `/api/research/mappings/:id` | Delete a stored mapping | — | [[docs/api/research\|Research]] |
| POST | `/api/research/mappings/audit` | Cross-provider self-audit (currency/price agreement); stamps `verified_at` | — | [[docs/api/research\|Research]] |
| GET | `/api/research/provider-keys` | List keyed-provider API-key statuses (masked) | — | [[docs/api/research\|Research]] |
| PUT | `/api/research/provider-keys/:provider` | Set/replace a provider's API key (Settings) | — | [[docs/api/research\|Research]] |
| DELETE | `/api/research/provider-keys/:provider` | Clear a provider's stored API key | — | [[docs/api/research\|Research]] |

## Import (16 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| POST | `/api/import/csv` | Import CSV | — | [[docs/api/imports\|Imports]] |
| POST | `/api/import/csv/custom` | Import with custom mapping | — | [[docs/api/imports\|Imports]] |
| POST | `/api/import/csv/stream` | SSE streaming import | — | [[docs/api/imports\|Imports]] |
| POST | `/api/import/recipients` | Bulk import recipients | — | [[docs/api/imports\|Imports]] |
| POST | `/api/import/categories` | Bulk import categories | — | [[docs/api/imports\|Imports]] |
| GET | `/api/import/batches` | List import batches | — | [[docs/api/imports\|Imports]] |
| GET | `/api/import/batches/:id` | Get import batch | — | [[docs/api/imports\|Imports]] |
| DELETE | `/api/import/batches/:id` | Rollback import batch | — | [[docs/api/imports\|Imports]] |
| GET | `/api/import/batches/:id/preview` | Review preview (groups + categories) | ADR-046 | [[docs/api/imports\|Imports]] |
| POST | `/api/import/batches/:id/rows/:rowId/override` | Override recipient on staged row | — | [[docs/api/imports\|Imports]] |
| POST | `/api/import/batches/:id/rows/:rowId/category-override` | Override category on staged row | ADR-046 | [[docs/api/imports\|Imports]] |
| POST | `/api/import/batches/:id/commit` | Commit reviewed batch | — | [[docs/api/imports\|Imports]] |
| GET | `/api/import/parsers` | List saved custom parser configs (ADR-066) | — | [[docs/api/imports\|Imports]] |
| POST | `/api/import/parsers` | Create saved parser; 409 on duplicate name; 400 if required columns missing | — | [[docs/api/imports\|Imports]] |
| PATCH | `/api/import/parsers/:id` | Update saved parser name and/or config; 404 if missing; 409 on name conflict | — | [[docs/api/imports\|Imports]] |
| DELETE | `/api/import/parsers/:id` | Delete saved parser; 204 on success; 404 if missing | — | [[docs/api/imports\|Imports]] |

## Portfolio Import (12 endpoints) — ADR-078

All routes mounted at `/api/portfolio/import` with `importRateLimiter`. Parallel pipeline to the budgeting import: stage → validate → matchInvestments → (review|autoCommit) → commit. Auto-commit only when all rows matched by exact symbol with zero errors; otherwise batch goes to `awaiting_review`. See [[docs/api/portfolio-imports|Portfolio Imports API]] and [[docs/features/portfolio-import|Portfolio Import Feature]].

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| POST | `/api/portfolio/import/csv/custom` | One-shot portfolio CSV import; returns 201 (committed) or 202 (awaiting_review) | importRateLimiter | [[docs/api/portfolio-imports\|Portfolio Imports]] |
| POST | `/api/portfolio/import/csv/stream` | SSE-streaming portfolio CSV import; events: progress / review_required / complete / error | importRateLimiter | [[docs/api/portfolio-imports\|Portfolio Imports]] |
| GET | `/api/portfolio/import/parsers` | List saved portfolio parser configs (kind=portfolio) | — | [[docs/api/portfolio-imports\|Portfolio Imports]] |
| POST | `/api/portfolio/import/parsers` | Create saved portfolio parser; 409 on duplicate name | — | [[docs/api/portfolio-imports\|Portfolio Imports]] |
| PATCH | `/api/portfolio/import/parsers/:id` | Update saved portfolio parser name/config | — | [[docs/api/portfolio-imports\|Portfolio Imports]] |
| DELETE | `/api/portfolio/import/parsers/:id` | Delete saved portfolio parser; 204 on success | — | [[docs/api/portfolio-imports\|Portfolio Imports]] |
| GET | `/api/portfolio/import/batches` | List portfolio import batches (limit/offset) | — | [[docs/api/portfolio-imports\|Portfolio Imports]] |
| GET | `/api/portfolio/import/batches/:id` | Get portfolio import batch detail | — | [[docs/api/portfolio-imports\|Portfolio Imports]] |
| DELETE | `/api/portfolio/import/batches/:id` | Rollback batch (deletes committed portfolio_transactions, marks aborted) | — | [[docs/api/portfolio-imports\|Portfolio Imports]] |
| GET | `/api/portfolio/import/batches/:id/preview` | Rows grouped by investment; unresolved rows per distinct raw symbol/name | — | [[docs/api/portfolio-imports\|Portfolio Imports]] |
| POST | `/api/portfolio/import/batches/:id/rows/:rowId/investment-override` | Resolve unmatched row: pick existing investment or create new | — | [[docs/api/portfolio-imports\|Portfolio Imports]] |
| POST | `/api/portfolio/import/batches/:id/commit` | Commit reviewed batch to portfolio_transactions | — | [[docs/api/portfolio-imports\|Portfolio Imports]] |

## Attachments (4 endpoints) — Phase 5A

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| POST | `/api/attachments/transaction/:id` | Upload attachment | 60 req/min | [[docs/api/attachments\|Attachments]] |
| GET | `/api/attachments/transaction/:id` | List attachments for transaction (optional `limit`/`offset`; omit both for all) | 60 req/min | [[docs/api/attachments\|Attachments]] |
| GET | `/api/attachments/:id/download` | Download attachment file | 60 req/min | [[docs/api/attachments\|Attachments]] |
| DELETE | `/api/attachments/:id` | Delete attachment | 60 req/min | [[docs/api/attachments\|Attachments]] |

## Saved Charts (4 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/saved-charts` | List all (optional `limit`/`offset`; omit both for all) | — | [[docs/api/savedCharts\|Saved Charts]] |
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
| GET | `/api/splits/owed` | Owed summary (optional `limit`/`offset`; omit both for all) | — | [[docs/api/splits\|Splits]] |
| GET | `/api/splits/owed/:id` | Owed by recipient (optional `limit`/`offset`; omit both for all) | — | [[docs/api/splits\|Splits]] |
| GET | `/api/splits/owed/:id/export/csv` | Export owed CSV | — | [[docs/api/splits\|Splits]] |
| GET | `/api/splits/transaction/:id` | Splits for transaction (optional `limit`/`offset`; omit both for all) | — | [[docs/api/splits\|Splits]] |
| POST | `/api/splits` | Create split | — | [[docs/api/splits\|Splits]] |
| POST | `/api/splits/batch` | Create multiple splits | — | [[docs/api/splits\|Splits]] |
| POST | `/api/splits/:id/pay` | Record payment | — | [[docs/api/splits\|Splits]] |
| GET | `/api/splits/:id/payments` | Get payments (optional `limit`/`offset`; omit both for all) | — | [[docs/api/splits\|Splits]] |
| POST | `/api/splits/:id/settle` | Mark settled | — | [[docs/api/splits\|Splits]] |
| POST | `/api/splits/owed/:id/settle-all` | Settle all for recipient | — | [[docs/api/splits\|Splits]] |
| DELETE | `/api/splits/:id` | Delete split | — | [[docs/api/splits\|Splits]] |

## Health (2 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/health` | Health check (backend ready) | — | [[docs/api/health\|Health]] |
| GET | `/health/detailed` | Detailed health with cache warmup status | — | [[docs/api/health\|Health]] |

## Admin (17 endpoints)

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/admin` | Admin status | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/database/init` | Verify DB connection | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/database/reset` | Reset database | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/update/check` | Check for updates | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/update/apply` | Acknowledge update | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/update/apply-and-restart` | Apply and restart | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/investments/kinesis/sanitize-history` | Sanitize Kinesis spikes | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/database/stats` | Per-table live/dead row counts and size (Phase 7) | admin | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/database/vacuum` | Run VACUUM ANALYZE on one or all tables (Phase 7) | admin | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/database/tables/:table/schema` | Table column schema + primary key discovery; composite-PK aware (ADR-101) | adminRateLimiter | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/database/tables/:table/rows` | Paginated/filtered/sorted table read; runs inside READ ONLY transaction with statement timeout (ADR-101) | adminRateLimiter | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/database/tables/:table/mutate` | Batch insert/update/delete with xmin optimistic concurrency, dry-run preview, audit trail, matview auto-refresh (ADR-101) | adminMutateLimiter | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/providers/health` | List all provider health records | — | [[docs/api/admin\|Admin]] |
| POST | `/api/admin/providers/:provider/probe` | Active on-demand probe for one provider | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/metrics/requests` | Rolling request metrics per route (in-memory, 15 min) | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/endpoints` | Static endpoint manifest from Express router | — | [[docs/api/admin\|Admin]] |
| GET | `/api/admin/endpoint-liveness` | Route manifest annotated with `live: true` per entry | — | [[docs/api/admin\|Admin]] |

## Reports (3 endpoints) — Phase 3 / Phase 5 / Phase 7

Server-side PDF generation via Puppeteer headless Chrome (Phase 3). Modular section architecture with theme-aware styling and period filtering. Theme tokens (HSL) and section selections passed in POST body. Phase 5 adds paginated footers. Phase 7 adds filter exclusions with impact comparison. Returns binary stream (`application/pdf`).

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| POST | `/api/reports/financial` | Generate financial PDF (7 sections: executive summary, cashflow, categories, recipients, bank balances, rolling averages, planned outlook); supports `excludedCategoryIds` and `excludedRecipientIds` for filter impact comparison | — | [[docs/features/pdf-report-export\|PDF Report Export]] |
| POST | `/api/reports/portfolio` | Generate portfolio PDF (6 sections: executive summary, allocation, top holdings, performance trend, asset class detail, dividend income); Phase 8 complete | — | [[docs/features/pdf-report-export\|PDF Report Export]] |
| POST | `/api/reports/tax` | Generate tax PDF (7 sections: executive summary, type breakdown, by asset class, monthly trend, top investments, fee breakdown, Belgian rules); accepts optional `taxProfile` and `precomputedPIT`; Phase 8 complete | — | [[docs/features/pdf-report-export\|PDF Report Export]] |

## Aggregations (15 endpoints) — Phase 2 / Phase 6 / Phase 7 / Phase 10 / Phase D / Phase E / Phase 9 / Phase C / Phase G

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
| GET | `/api/aggregations/tag-pivot` | Per-tag spending keyed by period (monthly/yearly), requires explicit `tag_ids` or `all=true` (dynamic all-tags mode, 2026-06-26); supports date-range filter; powers custom saved-chart tag series (ADR-052, ADR-106) | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/category-pivot` | Spending by category with exclusion filter support | — | [[docs/api/aggregations\|Aggregations]] |
| GET | `/api/aggregations/recipient-by-year` | Per-recipient spending broken out by calendar year with exclusion filter support | — | [[docs/api/aggregations\|Aggregations]] |

## Info/Statistics (13 endpoints — Phase 9 Aggregation Cutover, Phase 14+ Portfolio Totals)

Aggregation routes removed in Phase 9 as migration to `/api/aggregations/*` is complete. These endpoints remain for non-aggregation queries only: portfolio-performance, portfolio-summary (realtime totals, Phase 14), net-worth, exchange-rates, inflation-rates, and supporting refresh endpoints. Portfolio-summary endpoint added 2026-04-29 as single source of truth for dashboard and performance page headline metrics. 2026-06-11 (ADR-074): both portfolio-performance and portfolio-summary gain FX attribution fields (assetGain, fxGain, nativeCurrentValue, usedFallbackRate); flows now converted at transaction-date FX rates; no new endpoints added. Phase 9 cutover also removed `GET /api/info` (general statistics) and `GET /api/info/transaction-summary` (summary with filters).

| Method | Path | Description | Rate Limit | Doc |
|--------|------|-------------|------------|-----|
| GET | `/api/info/banks` | List bank accounts | — | [[docs/api/info\|Info]] |
| GET | `/api/info/supported-adapters` | List supported banks | — | [[docs/api/info\|Info]] |
| GET | `/api/info/transaction-count` | Total count | — | [[docs/api/info\|Info]] |
| GET | `/api/info/planned-expenses-next-month` | Next month expenses | — | [[docs/api/info\|Info]] |
| GET | `/api/info/recurring-patterns` | Recurring detection | — | [[docs/api/info\|Info]] |
| GET | `/api/info/net-worth` | Net worth (optional `limit`/`offset` paginate snapshots newest-first; omit both for full history) | 30 req/min | [[docs/api/info\|Info]] |
| GET | `/api/info/exchange-rates` | Exchange rates | 30 req/min | [[docs/api/info\|Info]] |
| POST | `/api/info/exchange-rates/refresh` | Refresh exchange rates | admin | [[docs/api/info\|Info]] |
| GET | `/api/info/inflation-rates` | Inflation rates | 30 req/min | [[docs/api/info\|Info]] |
| POST | `/api/info/inflation-rates/refresh` | Refresh inflation | admin | [[docs/api/info\|Info]] |
| POST | `/api/info/refresh-views` | Refresh materialized views | — | [[docs/api/info\|Info]] |
| GET | `/api/info/portfolio-performance` | Performance snapshots, metrics, heatmap, breakdownSummary. 2026-06-11 (ADR-074): snapshots gain optional `value_fx_neutral`; breakdownSummary entries gain `assetGain`, `fxGain`, `nativeCurrentValue`, `usedFallbackRate` | 30 req/min | [[docs/api/info\|Info]] |
| GET | `/api/info/portfolio-summary` | Realtime portfolio totals (single source of truth for dashboard + performance). 2026-06-11 (ADR-074): flows converted at transaction-date FX; new `totalAssetGain`, `totalFxGain`, `usedFallbackRate` totals; per-investment `assetGain`, `fxGain`, `nativeCurrentValue`, `usedFallbackRate`; gainLoss = assetGain + fxGain | 60 req/min | [[docs/api/portfolio-summary\|Portfolio Summary]] |

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
| Accounts (ADR-088) | 9 | 0 |
| Cross-Workspace (ADR-098) | 1 | 0 |
| Transactions (incl. Tags) | 18 | 2 |
| Categories | 7 | 0 |
| Recipients | 14 | 0 |
| Planned Transactions | 8 | 1 |
| Investments | 14 | 0 |
| Watchlist | 5 | 0 |
| Market Lookup | 4 | 0 |
| Research (ADR-079/081/082) | 18 | 0 |
| Import | 16 | 0 |
| Portfolio Import (ADR-078) | 12 | 2 |
| Attachments (Phase 5A) | 4 | 0 |
| Saved Charts | 4 | 0 |
| Settings | 5 | 0 |
| Recipient Bank Accounts | 5 | 0 |
| Admin (incl. DB Data Editor ADR-101) | 17 | 3 |
| Splits | 11 | 0 |
| Health | 2 | 0 |
| Aggregations (Phase 2/6/10/D) | 15 | 0 |
| Reports (Phase 3/7) | 3 | 0 |
| Info/Statistics (Phase 14) | 13 | 4 |
| AI Chat | 9 | 2 |
| IPC Handlers (Phase 1+2) | 8 | 0 |
| **Total** | **222** | **14** |

> **212** of these are versioned `/api` HTTP operations — the authoritative count enforced against `openapi.yaml` by `scripts/check-endpoint-matrix.js`. The remaining 10 are 2 unversioned `/health` endpoints and 8 Electron IPC handlers, which sit outside the OpenAPI spec. (The Rate-Limited column is an approximate per-section tally, not gate-checked.)

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
