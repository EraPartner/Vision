---
title: API - Transactions
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/transactions
description: CRUD operations for financial transactions, including CSV and NDJSON export, bulk operations
date: 2026-04-24
updated: 2026-08-27
last_modified: 2026-06-28
tags: [api, transactions, finance, phase-5a, phase-9, phase-13, phase-q, decimal, money, export, drillthrough, filters, recipient-groups, bulk-actions, amount-filter, date-search, tag-search]
status: active
aliases: [transactions-api, transaction-crud, financial-records, income, expenses]
related_code: [[apps/node-backend/src/routes/transactions.js]], [[apps/node-backend/src/repositories/transactionRepository.js]], [[apps/node-backend/src/services/currency/currencyConversionService.js]], [[apps/node-backend/src/services/bulkSelection.js]], [[apps/node-backend/src/services/transactionExport.js]]
---

# Transactions API

## Overview

The Transactions API provides CRUD operations for managing financial transactions. Each transaction represents an income or expense with associated recipient, category, and amount.

> [!warning] Breaking bulk-filter request change (2026-08-27)
> Filter-mode calls to `bulk-delete`, `bulk-update`, and `bulk-export` now require `expected_count`. The explicit-ID shape is unchanged. This lets responses distinguish the count the user confirmed from the rows that still matched when the action began.

> [!info] Monetary Precision (Phase 9)
> All monetary values in responses (amounts, balances, totals) use **Decimal.js** for precision. Values are serialized as JSON `number` type, safe to 2 decimal places (cents). See [[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021]] for details.

## Endpoints

### GET /api/transactions

Retrieve a list of transactions with filtering and pagination.

**Query Parameters:**

| Parameter          | Type    | Default | Description                                                                                                                                                                                                                    |
| ------------------ | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| limit              | integer | 50      | Max items to return (clamped: 1–5000)                                                                                                                                                                                          |
| offset             | integer | 0       | Number of items to skip (clamped: ≥0)                                                                                                                                                                                          |
| transaction_id     | integer | null    | Filter by exact transaction ID                                                                                                                                                                                                 |
| start_date         | string  | null    | Filter by start date (YYYY-MM-DD)                                                                                                                                                                                              |
| end_date           | string  | null    | Filter by end date (YYYY-MM-DD)                                                                                                                                                                                                |
| bank_account       | string  | null    | Filter by bank account                                                                                                                                                                                                         |
| category_id        | integer | null    | Filter by category ID (single)                                                                                                                                                                                                 |
| category_ids       | string  | null    | Filter by multiple category IDs (comma-separated) — ignored if category_id is set (Phase 13)                                                                                                                                   |
| recipient_id       | integer | null    | Filter by recipient ID (matches recipient directly and aliases under it, one direction)                                                                                                                                        |
| recipient_group_id | integer | null    | Filter by full recipient group (Phase Q) — resolves the complete primary-recipient group: matches the recipient itself, all aliases under it, the recipient's own primary (if alias), and all other aliases under that primary |
| recipient_name     | string  | null    | Filter by recipient name                                                                                                                                                                                                       |
| transaction_type   | string  | null    | Filter by transaction type: `income` (amount > 0) or `expense` (amount < 0) (Phase 13)                                                                                                                                         |
| uncategorised      | boolean | false   | Show only uncategorized                                                                                                                                                                                                        |
| active             | boolean | true    | Show active/inactive                                                                                                                                                                                                           |
| search             | string  | null    | Search in memo/comment/bank_account/currency/amount/date ISO text/tag slugs (ILIKE) — **extended 2026-06-28**: now also matches `CAST(date AS TEXT)` and active tag slugs via EXISTS subquery                                  |
| amount_min         | number  | null    | Inclusive lower bound on absolute amount magnitude: `ABS(amount) >= amount_min` — sign-agnostic (2026-06-28, additive, non-breaking)                                                                                           |
| amount_max         | number  | null    | Inclusive upper bound on absolute amount magnitude: `ABS(amount) <= amount_max` — sign-agnostic (2026-06-28, additive, non-breaking)                                                                                           |
| amount_exact       | number  | null    | Shorthand for min == max; sets both bounds to the same value (2026-06-28, additive, non-breaking)                                                                                                                              |
| amount_signed      | boolean | false   | When true, `amount_min`/`amount_max` compare the SIGNED `t.amount` instead of `ABS(amount)`, so `-50`/`+50` are distinct exact matches (2026-06-28, additive, non-breaking)                                                    |
| normalize_to_eur   | boolean | false   | Convert amounts to EUR                                                                                                                                                                                                         |
| target_currency    | string  | null    | Target currency used when normalize_to_eur=true (defaults to EUR)                                                                                                                                                              |
| include_balance    | boolean | false   | Compute running balance via SQL window function                                                                                                                                                                                |
| sort_by            | string  | null    | Sort field                                                                                                                                                                                                                     |
| sort_dir           | string  | null    | Sort direction (asc/desc)                                                                                                                                                                                                      |

Notes:

- `target_currency` is only applied when `normalize_to_eur=true`.
- If `target_currency` is invalid or unsupported, conversion falls back to EUR behavior.
- `amount_min`, `amount_max`, `amount_exact` filter on `ABS(t.amount)` by default — magnitude-based, so they do not distinguish income from expenses. Use `transaction_type=income|expense` to restrict by sign, OR pass `amount_signed=true` to compare the signed amount directly (2026-06-28, additive, non-breaking — [[apps/node-backend/src/lib/filterBuilder.js]]).
- `amount_signed=true` switches the comparison column from `ABS(t.amount)` to `t.amount`, so the bounds may be negative and `+50` vs `-50` match exactly. It is orthogonal to `transaction_type` (both can be combined). The frontend search-suggestion UI sends it automatically when the user prefixes the amount with `+` or `-`.
- `amount_exact` sets both bounds to the same value and takes precedence when `amount_min`/`amount_max` are also supplied.
- `search` now additionally matches `CAST(t.date AS TEXT)` (e.g., typing `2026-01` surfaces all January 2026 rows) and active tag slugs on the row via an EXISTS subquery over `transaction_tags`/`tags` (2026-06-28, [[apps/node-backend/src/lib/filterBuilder.js]]).
- `recipient_id` matches the transaction recipient directly and any aliases under it (single direction). Use `recipient_group_id` to include the full primary-recipient group (Phase Q) ([[apps/node-backend/src/lib/filterBuilder.js]]).
- `recipient_group_id` resolves the complete primary-recipient group via an indexable semi-join on `recipients`: matches the recipient itself, any aliases under it, the recipient's own primary (if it is an alias), and all other aliases under that primary. Ignores `recipient_id` when both are provided (Phase Q) ([[apps/node-backend/src/lib/filterBuilder.js]]).
- `category_ids` accepts comma-separated integers (e.g., `category_ids=5,7,12`). Ignored if `category_id` is set. Enables pivot table drillthrough to multiple category groups (Phase 13) ([[apps/node-backend/src/lib/filterBuilder.js]]).
- **Id params are strict (changed 2026-08-11, breaking for malformed ids).** `transaction_id`, `category_id`, `recipient_id`, `recipient_group_id` and `account_id` accept only a plain base-10 integer in 1..2,147,483,647; every element of `category_ids` must satisfy the same rule. Anything else — `12abc`, `12.5`, `1e3`, `0x10`, `+5`, `-4`, `0`, `5`, `NaN` — returns `400 VALIDATION_ERROR`. Absent and empty (`?category_id=`, `?category_ids=`) still mean _no filter_ and answer `200`. See the warning under [[docs/api/transactions#GET /api/transactions/export/csv|the export endpoints]] and [[docs/security/input-validation#Comma-separated ID Query Params (transactions list + export)|Input Validation]].
- `transaction_type` filters by amount sign: `income` (positive amounts) or `expense` (negative amounts). Used by pivot table drillthrough to isolate income-only or expense-only views (Phase 13) ([[apps/node-backend/src/lib/filterBuilder.js]]).
- `include_balance=true` computes a `balance` field via SQL window function `SUM(amount) OVER (ORDER BY date ASC)` instead of JavaScript post-processing ([[apps/node-backend/src/routes/transactions.js]]).
- Route query parsing was refactored into a shared helper (`parseTransactionListQuery`) to reduce duplication while preserving default values, clamping rules, and sort-direction constraints ([[apps/node-backend/src/routes/transactions.js]]).
- Non-`uncategorised` list requests now use repository one-query pagination (`getAllWithCount`) instead of separate list/count round-trips; filters, totals, and response shape remain unchanged ([[apps/node-backend/src/routes/transactions.js]], [[apps/node-backend/src/repositories/transactionRepository.js]]).
- `uncategorised=true` list requests now use a dedicated single-round-trip repository path (`getUncategorisedWithCount`) instead of route-level dual queries; uncategorised row filtering and historical total-count semantics are preserved ([[apps/node-backend/src/routes/transactions.js]], [[apps/node-backend/src/repositories/transactionRepository.js]]).
- **`uncategorised=true` honours the full row-compatible filter set (fixed 2026-08-13 and 2026-08-21).** `recipient_group_id`, `tags`, `transaction_type`, `amount_min`, `amount_max` (and `amount_signed`) were parsed by the route but dropped by `getUncategorisedWithCount`, so both the listed rows and `total` were computed over a wider set than the request named — a tag- or amount-filtered queue answered with every uncategorised row and an unfiltered count. Those row-compatible filters now narrow **both** halves, built by the same `buildTransactionWhere` the main list uses; `category_ids`, which was dropped at the same boundary, narrows `total` only. `search` and `transaction_id`, which previously narrowed only `total`, now also narrow the returned queue rows. Two consequences worth knowing: `recipient_id` now resolves aliases on the rows as it always did on the total (the queue and its count can no longer disagree), while only `category_id` and `category_ids` remain total-only because a category filter cannot narrow a set defined by having no effective category. The queue itself is unchanged: active rows whose 3-level effective category is NULL, regardless of `active=false` ([[apps/node-backend/src/repositories/transactionRepository.js]]).
- The same uncategorised path honours `sort_by`, `sort_dir`, and `include_balance`; custom ordering keeps the date/id tie-breakers used by the main list, and running balances remain partitioned by account. The plain repository query used by the AI expenses tool now shares the same filter builder instead of maintaining a narrower predicate copy ([[apps/node-backend/src/repositories/transactionRepository.js]]).

**Response:**

```json
{
  "items": [
    {
      "id": 123,
      "transaction_date": "2026-01-15",
      "date": "2026-01-15",
      "bank_account": "BE12 3456...",
      "recipient_id": 1,
      "recipient_name": "Supermarket",
      "memo": "Weekly shopping",
      "amount": -75.5,
      "amount_eur": -75.5,
      "currency": "EUR",
      "balance": 1500.0,
      "category_id": 5,
      "category_name": "FOOD:GROCERIES",
      "comment": null,
      "is_active": true,
      "created_at": "2026-01-15T10:00:00Z",
      "updated_at": "2026-01-15T10:00:00Z",
      "links": []
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0,
  "links": []
}
```

### GET /api/transactions/export/csv

Export transactions to CSV format using chunked streaming.

**Query Parameters:**

| Parameter          | Type    | Default | Description                                                                                                                                                                         |
| ------------------ | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transaction_id     | integer | null    | Filter by exact transaction ID (Phase 13)                                                                                                                                           |
| start_date         | string  | null    | Filter by start date (YYYY-MM-DD)                                                                                                                                                   |
| end_date           | string  | null    | Filter by end date (YYYY-MM-DD)                                                                                                                                                     |
| bank_account       | string  | null    | Filter by single bank account (legacy; ignored if `bank_accounts` is set)                                                                                                           |
| bank_accounts      | string  | null    | Filter by multiple bank accounts (comma-separated IBANs, e.g., `BE12...,BE34...`). Takes precedence over `bank_account` (Phase 13)                                                  |
| account_id         | integer | null    | Preferred single-account filter (exact FK match, ADR-088); `bank_account` is the legacy substring escape hatch                                                                      |
| account_ids        | string  | null    | Preferred multi-account filter (comma-separated ids, e.g., `3,9`). Ignored when `account_id` is set; takes precedence over `bank_accounts`                                          |
| category_id        | integer | null    | Filter by single category ID (legacy; ignored if `category_ids` is set)                                                                                                             |
| category_ids       | string  | null    | Filter by multiple category IDs (comma-separated integers, e.g., `5,7,12`). Takes precedence over `category_id`. Throws `ValidationError` if any value is not an integer (Phase 13) |
| recipient_id       | integer | null    | Filter by recipient ID (matches recipient directly and aliases under it, one direction) (Phase 13)                                                                                  |
| recipient_group_id | integer | null    | Filter by full recipient group (Phase Q)                                                                                                                                            |
| recipient_name     | string  | null    | Filter by recipient name (Phase 13)                                                                                                                                                 |
| transaction_type   | string  | null    | Filter by transaction type: `income` (amount > 0) or `expense` (amount < 0) (Phase 13)                                                                                              |
| search             | string  | null    | Filter by memo/comment/date/tag text (Phase 13 + 2026-06-28 extension)                                                                                                              |
| amount_min         | number  | null    | Inclusive lower bound on `ABS(amount)` (2026-06-28, additive, non-breaking)                                                                                                         |
| amount_max         | number  | null    | Inclusive upper bound on `ABS(amount)` (2026-06-28, additive, non-breaking)                                                                                                         |
| include_balance    | boolean | false   | Add a "Running Balance" column computed via JavaScript accumulator across chunks                                                                                                    |

**Filter Capping (Phase 13):**

- `bank_accounts` and `account_ids` are capped at 50 entries; excess entries are silently ignored. `account_ids` is validated in full _before_ the cap applies, so a malformed id past the 50th still rejects
- `category_ids` is **not** capped (the "capped at 50" claim here was wrong: neither the route nor `buildTransactionWhere` slices it — only `bank_accounts`, `account_ids` and `tagSlugs` are capped)
- Trailing/leading whitespace is trimmed from bank accounts before filtering. It is **not** trimmed from ids — ` 5` is a malformed id

> [!warning] Id params are strict (changed 2026-08-11 — breaking for malformed ids, wire-visible on this endpoint)
> `account_ids`, `category_ids`, `transaction_id`, `category_id`, `recipient_id`, `recipient_group_id` and `account_id` accept only plain base-10 integers in 1..2,147,483,647. Anything else returns `400 VALIDATION_ERROR` before a single row is read.
>
> This was `parseInt(...).filter(isFinite && > 0)`, and both of its failure modes reached the exported file. **Retarget:** `?account_ids=12abc` exported account **12** — a record nobody named — and `?account_ids=3,12abc,9` exported accounts 3, 12 and 9. **Widen:** `?account_ids=abc` produced an empty list, which the caller mapped back to "no filter", so the endpoint emitted _no account predicate at all_ and streamed **every account's transactions** into the downloaded file, with a 200 and a plausible-looking CSV. Nothing was logged either way, and the user keeps the file.
>
> Absent and empty (`?account_ids=`) still mean _no account filter_ and answer 200 — unchanged. Non-breaking for shipped callers: the Transactions page and the Imports Export card build these params with `ids.join(',')` from `number[]` state and omit the param when the list is empty; nothing in the frontend sends `account_ids` at all.

**Response:** CSV file download with headers (default):

```
Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
```

With `include_balance=true`:

```
Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Running Balance
```

**Streaming Behavior (Phase 5):**

- CSV is streamed in chunks of 1000 rows via `res.write()` to support large exports without memory overhead.
- Stable `ORDER BY (date ASC, id ASC)` ensures no gaps/duplicates across chunk boundaries.
- Running balance accumulates in JavaScript so it remains consistent with the sort order when `include_balance=true`.
- 404 probe query runs before streaming starts; error responses return JSON if no rows match filters.

**Rate Limited:** 30 requests per minute

Implementation note:

- CSV/JSON export filter construction (`buildExportFilters`) now delegates to the shared `buildTransactionWhere` from `filterBuilder.js` after parsing the query with `parseTransactionListQuery`. Result: both export endpoints accept the same filter set as `GET /api/transactions` (Phase 13) ([[apps/node-backend/src/routes/transactions.js]]).
- Export filters include newly supported params: `transaction_id`, `recipient_id`, `recipient_name`, `search`, `transaction_type` (Phase 13). Existing params (`start_date`, `end_date`, `bank_account`, `bank_accounts`, `category_id`, `category_ids`) continue to work as before.
- CSV/JSON export filter construction supports both singular (`bank_account`, `category_id`) and plural (`bank_accounts`, `category_ids`) parameters. Plural parameters take precedence when both are provided (Phase 13) ([[apps/node-backend/src/routes/transactions.js]]).
- Shared `EXPORT_JOINS_SQL` constant and `buildExportProbeSql()` ensure existence-probe queries join `recipients`/`categories` exactly like the chunk query — fixes a latent bug where `recipient_name`/`search` filters would crash the probe (Phase 13) ([[apps/node-backend/src/routes/transactions.js]]).
- CSV export row escaping/assembly and filename creation are handled by dedicated helpers (`escapeCsvValue`, `buildTransactionCsvRow`, `buildTransactionExportFilename`) with unchanged CSV header/content semantics and error responses ([[apps/node-backend/src/routes/transactions.js]]).
- CSV export neutralizes formula-like cell prefixes (`=`, `+`, `-`, `@`) before writing values to reduce spreadsheet formula-injection risk when opening exports in Excel/Sheets ([[apps/node-backend/src/routes/transactions.js]]).
- Export route errors are sanitized to generic error details (no internal exception leakage) while preserving status semantics; if headers have already been sent, connection is closed cleanly ([[apps/node-backend/src/routes/transactions.js]]).

### GET /api/transactions/export/json

Export transactions to NDJSON (newline-delimited JSON) format using chunked streaming (Phase 5A).

**Query Parameters:**

| Parameter          | Type    | Default | Description                                                                                                                                                         |
| ------------------ | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transaction_id     | integer | null    | Filter by exact transaction ID (Phase 13)                                                                                                                           |
| start_date         | string  | null    | Filter by start date (YYYY-MM-DD)                                                                                                                                   |
| end_date           | string  | null    | Filter by end date (YYYY-MM-DD)                                                                                                                                     |
| bank_account       | string  | null    | Filter by single bank account (legacy; ignored if `bank_accounts` is set)                                                                                           |
| bank_accounts      | string  | null    | Filter by multiple bank accounts (comma-separated IBANs). Takes precedence over `bank_account` (Phase 13)                                                           |
| account_id         | integer | null    | Preferred single-account filter (exact FK match, ADR-088)                                                                                                           |
| account_ids        | string  | null    | Preferred multi-account filter (comma-separated ids). Ignored when `account_id` is set; takes precedence over `bank_accounts`                                       |
| category_id        | integer | null    | Filter by single category ID (legacy; ignored if `category_ids` is set)                                                                                             |
| category_ids       | string  | null    | Filter by multiple category IDs (comma-separated integers). Takes precedence over `category_id`. Throws `ValidationError` if any value is not an integer (Phase 13) |
| recipient_id       | integer | null    | Filter by recipient ID (matches recipient directly and aliases under it, one direction) (Phase 13)                                                                  |
| recipient_group_id | integer | null    | Filter by full recipient group (Phase Q)                                                                                                                            |
| recipient_name     | string  | null    | Filter by recipient name (Phase 13)                                                                                                                                 |
| transaction_type   | string  | null    | Filter by transaction type: `income` (amount > 0) or `expense` (amount < 0) (Phase 13)                                                                              |
| search             | string  | null    | Filter by memo/comment/date/tag text (Phase 13 + 2026-06-28 extension)                                                                                              |
| amount_min         | number  | null    | Inclusive lower bound on `ABS(amount)` (2026-06-28, additive, non-breaking)                                                                                         |
| amount_max         | number  | null    | Inclusive upper bound on `ABS(amount)` (2026-06-28, additive, non-breaking)                                                                                         |

**Filter Capping (Phase 13):**

- `bank_accounts` and `account_ids` are capped at 50 entries; excess entries are silently ignored (`account_ids` is validated in full first)
- `category_ids` is **not** capped — see the CSV section above
- Trailing/leading whitespace is trimmed from bank accounts before filtering, but never from ids

Both export endpoints share `buildExportFilters`, so the strict id-param contract described under [[docs/api/transactions#GET /api/transactions/export/csv|GET /export/csv]] applies here identically.

**Response:** NDJSON file download (one JSON object per line):

```
{"id":123,"date":"2026-01-15","bank_account":"BE12 3456...","recipient":"Supermarket","memo":"Weekly shopping","amount":-75.50,"currency":"EUR","balance":1500.00,"category":"FOOD:GROCERIES","comment":null}
{"id":124,"date":"2026-01-16","bank_account":"BE12 3456...","recipient":"Gas Station","memo":"Fuel","amount":-45.00,"currency":"EUR","balance":1455.00,"category":"TRANSPORT:GAS","comment":null}
```

**Streaming Behavior (Phase 5A):**

- NDJSON is streamed in chunks of 1000 rows via `res.write()` to support large exports without memory overhead.
- Stable `ORDER BY (date ASC, id ASC)` ensures no gaps/duplicates across chunk boundaries.
- Each row is serialized as a complete JSON object followed by a newline character.
- 404 probe query runs before streaming starts; error responses return JSON if no rows match filters.
- Content-Type is `application/x-ndjson` with standard `Content-Disposition: attachment` header.

**Rate Limited:** 30 requests per minute

Implementation note:

- JSON export uses shared filter-building and chunk-SQL helpers (`buildExportFilters`, `buildExportChunkSql`, `buildTransactionExportJsonFilename`) for consistency with CSV export. `buildExportFilters` constructs precise SQL filters delegating to `buildTransactionWhere` with a 50-entry cap and whitespace trimming on `bank_accounts` (Phase 13) ([[apps/node-backend/src/routes/transactions.js]]).
- Export route errors are sanitized to generic error details (no internal exception leakage) while preserving status semantics; if headers have already been sent, connection is closed cleanly ([[apps/node-backend/src/routes/transactions.js]]).

### GET /api/transactions/:id

Retrieve a single transaction by ID.

**Response:**

```json
{
  "id": 123,
  "transaction_date": "2026-01-15",
  "bank_account": "BE12 3456...",
  "recipient_id": 1,
  "recipient_name": "Supermarket",
  "memo": "Weekly shopping",
  "amount": -75.5,
  "amount_eur": -75.5,
  "currency": "EUR",
  "balance": 1500.0,
  "category_id": 5,
  "category_name": "FOOD:GROCERIES",
  "comment": null,
  "is_active": true,
  "created_at": "2026-01-15T10:00:00Z",
  "updated_at": "2026-01-15T10:00:00Z",
  "links": []
}
```

### POST /api/transactions

Create a new transaction.

**Request Body:**

```json
{
  "date": "2026-01-15",
  "bank_account": "BE12 3456...",
  "recipient_id": 1,
  "amount": -75.5,
  "memo": "Weekly shopping",
  "currency": "EUR",
  "balance": 1500.0,
  "category_id": 5,
  "comment": "Optional comment"
}
```

**Required Fields:** date, bank_account, recipient_id, amount

**Body FK ids are strict (changed 2026-08-11, breaking for malformed ids).** `recipient_id` and `category_id` must each be a plain base-10 integer in 1..2,147,483,647 — the same rule the id path/query params follow. `0`, negatives and `''` are rejected too. See [[docs/security/input-validation#FK ids in write bodies (`parseOverrideId` and the zod FK fields)|Input Validation]].

- `recipient_id` used to be checked with `Number.isInteger(Number(value))`, which rejects `12abc` but reads `1e3` as 1000, `0x10` as 16 and `true` as 1, so a malformed id booked the transaction against a recipient the caller never named.
- `category_id` had **no guard at all** on this operation — the create schema validated `recipient_id` and `amount` and forwarded the rest raw. `12abc`, `1e3`, `true`, `[7]` and `''` reached Postgres as a 22P02 cast error and `0`/negatives as an FK violation, so the create path for the app's core entity answered **500** rather than 400; `0x10` was worse, landing on category 16 wherever that row exists (Postgres reads hex integer literals). It now uses the same validator as the PATCH body.
- **`null` and an absent `category_id` both mean "uncategorized" and still answer 201** — unchanged, and pinned.

**Duplicate Detection:** Automatically checks for duplicate transactions based on date, amount, recipient, and bank account. Returns 409 if duplicate found.

**Response:** Created transaction with 201 status.

### PATCH /api/transactions/:id

Update an existing transaction.

**Request Body:**

```json
{
  "category_id": 6,
  "comment": "Updated comment",
  "category_name": "FOOD:BEVERAGES"
}
```

**Special Handling:**

- `recipient_name`: Resolves to recipient_id automatically
- `category_name`: Resolves to category_id using "GENERAL:DETAIL" format
- `recipient_id` / `category_id`: `null` clears the column (both are nullable) and an absent key leaves it unchanged, but a present value must be a plain base-10 integer in 1..2,147,483,647 (changed 2026-08-11, breaking for malformed ids — `1e3` used to re-attribute the transaction to recipient 1000 rather than 400)

Implementation notes:

- Internal PATCH flow now delegates to extracted helpers for payload normalization and name→id resolution (`normalizeTransactionPatchFields`, `resolveRecipientNameToId`, `resolveCategoryNameToId`, `parseRouteId`) while preserving status codes and response messages.
- Recipient/category name-resolution and CSV export DB access now use module-scoped imports (`dbQuery`, `normalizeForMatching`) instead of per-request dynamic imports; endpoint behavior, payloads, and validation messages remain unchanged ([[apps/node-backend/src/routes/transactions.js]]).
- Recipient/category name-resolution checks in PATCH now run concurrently and preserve existing recipient-first then category error precedence in responses, reducing avoidable sequential lookup latency without changing validation outcomes ([[apps/node-backend/src/routes/transactions.js]]).
- Repository update path now returns the enriched updated row in a single CTE query (`WITH updated ... SELECT ...`) instead of `UPDATE` + follow-up `getById` round-trip; response shape and not-found semantics are unchanged ([[apps/node-backend/src/repositories/transactionRepository.js]]).
- PATCH route internal errors now return sanitized generic details instead of leaking backend exception strings ([[apps/node-backend/src/routes/transactions.js]]).

**Rate Limited:** 30 requests per minute

### DELETE /api/transactions/:id

Permanently delete a transaction (hard delete).

**Response:** `204 No Content` — empty body, no envelope (see [[docs/reference/code-patterns#DELETE Response Pattern|DELETE Response Pattern]]).

**Error Response:** `404 Not Found` when the transaction does not exist.

### POST /api/transactions/bulk-delete

Permanently delete a set of transactions selected by explicit IDs or by filter criteria.

**Request Body:**

```json
{
  "ids": [123, 124, 125]
}
```

or

```json
{
  "filter": {
    "start_date": "2026-01-01",
    "end_date": "2026-01-31",
    "category_id": 5
  },
  "expected_count": 42
}
```

**Request Parameters:**

- `ids` (optional): Array of transaction IDs to delete. Max 500 entries. Exactly one of `ids` / `filter` must be given — sending both, or neither, is a `400`. Every element must be a plain base-10 integer in 1..2,147,483,647; one malformed element rejects the whole request.
- `filter` (optional): Transaction filter object. Matched row count capped at 5000. See [[#Bulk filter selector]] for the accepted fields and the validation rules.
- `expected_count` (required with `filter`): Integer from 1 to 5000. This is the matching count the user confirmed before the request.

**Response:**

```json
{
  "deleted": 40,
  "requested": 42,
  "matched": 41
}
```

**Rate Limited:** 30 requests per minute

Implementation note:

- Resolves `ids | filter` via `[[apps/node-backend/src/services/bulkSelection.js]]` with caps enforced up front.
- Runs inside a `withTransaction()` to guarantee atomicity; `scheduleRefresh()` signals materialized-view refresh on success.
- Ids and filter fields are validated before any SQL runs: a malformed id or filter field rejects the whole request (400) rather than being stripped, so the delete never covers a narrower _or wider_ set than the caller named. All resolved rows are deleted in a single `DELETE` statement.

### Bulk filter selector

The `filter` object accepted by `bulk-delete`, `bulk-update` and `bulk-export` (all three share one
normaliser, `normalizeBulkFilter` in `[[apps/node-backend/src/services/bulkSelection.js]]`).

Accepted fields — this list is closed, and each may also be given in camelCase, but not in both
spellings at once:

`transaction_id`, `start_date`, `end_date`, `account_id`, `bank_account`, `bank_accounts`,
`category_id`, `category_ids`, `recipient_id`, `recipient_group_id`, `recipient_name`, `search`,
`active`, `transaction_type`, `amount_min`, `amount_max`, `amount_signed`, `tags`.

Field semantics match [[#GET /api/transactions]], with these wire-shape differences: `category_ids`
and `bank_accounts` must be **arrays** (the list endpoint takes comma strings; here a string is a
`400`), `tags` accepts an array or a comma string, and `active`/`amount_signed` accept a real
boolean as well as `'true'`/`'false'`.

> [!warning] Breaking change (2026-08-11) — the filter is validated, not best-effort
> An unknown key, a wrong type or a malformed value now returns `400 VALIDATION_ERROR`. This is
> stricter than the list endpoint deliberately. A filter field that failed its type guard used to be
> **skipped**, and skipping a filter on a bulk action does not narrow it — it _widens_ it.
> `{"category_ids": "5"}` emitted no category clause at all, so `bulk-delete` swept every
> transaction the rest of the filter matched (up to the 5000 cap) and answered `200` with a
> plausible `deleted` count. The same shape was live on `bank_accounts`, `tags`,
> `transaction_type`, `amount_min`/`amount_max`, `active`, and on any unrecognised key —
> `{"account_ids": [7]}` reached the SQL builder as an empty filter, i.e. _every active
> transaction_. The five scalar filter ids and the two dates were passed into `$n` unvalidated and
> reached Postgres as **22P02 / 22007 500s**; they are `400`s now.
>
> Absent, `null` and empty (`""`, `[]`) still mean _no filter on this field_ and answer `200`, so
> the whole-table "select all N matching" selection (`{"active": true}` with no other keys) keeps
> working — it is bounded by the 5000-row cap, not by validation. Non-breaking for shipped callers:
> the frontend's `BulkTransactionFilter` types every field correctly and sends only keys in the
> accept-list. See [[docs/security/input-validation#Bulk-action filter selector (`normalizeBulkFilter`)|Input Validation]].

### POST /api/transactions/bulk-update

Atomically update a set of transactions with new category, recipient, or active status.

**Request Body:**

```json
{
  "ids": [123, 124, 125],
  "fields": {
    "category_id": 6,
    "recipient_id": 10,
    "is_active": false
  }
}
```

or

```json
{
  "filter": {
    "start_date": "2026-01-01",
    "recipient_name": "Supermarket"
  },
  "expected_count": 42,
  "fields": {
    "category_id": 5
  }
}
```

**Request Parameters:**

- `ids` (optional): Array of transaction IDs to update. Max 500 entries. Exactly one of `ids` / `filter` must be given — sending both, or neither, is a `400`. Every element must be a plain base-10 integer in 1..2,147,483,647; one malformed element rejects the whole request.
- `filter` (optional): Transaction filter object. Matched row count capped at 5000. See [[#Bulk filter selector]] for the accepted fields and the validation rules.
- `expected_count` (required with `filter`): Integer from 1 to 5000. This is the matching count the user confirmed before the request.
- `fields`: Object with one or more of:
  - `category_id` (integer): New category ID
  - `recipient_id` (integer): New recipient ID
  - `is_active` (boolean): Activate or deactivate

**Validation:**

- FK targets (`category_id`, `recipient_id`) are validated up front; the entire batch fails if any reference is invalid.
- At least one field must be provided; request with empty `fields` object returns 400.

**Response:**

```json
{
  "updated": 40,
  "requested": 42,
  "matched": 41
}
```

**Rate Limited:** 30 requests per minute

Implementation note:

- Resolves `ids | filter` via `[[apps/node-backend/src/services/bulkSelection.js]]`.
- `category_id` and `recipient_id` are validated against the database in parallel before any `UPDATE` executes.
- Runs inside a `withTransaction()` to guarantee atomicity; `scheduleRefresh()` signals materialized-view refresh on success.

### POST /api/transactions/bulk-export

Stream transactions as CSV or NDJSON using selection by IDs or filter.

**Request Body:**

```json
{
  "ids": [123, 124, 125],
  "format": "csv",
  "include_balance": true
}
```

or

```json
{
  "filter": {
    "start_date": "2026-01-01",
    "end_date": "2026-01-31",
    "category_id": 5
  },
  "expected_count": 42,
  "format": "json"
}
```

**Request Parameters:**

- `ids` (optional): Array of transaction IDs to export. Max 500 entries. Exactly one of `ids` / `filter` must be given — sending both, or neither, is a `400`. Every element must be a plain base-10 integer in 1..2,147,483,647; one malformed element rejects the whole request.
- `filter` (optional): Transaction filter object. Matched row count capped at 5000. See [[#Bulk filter selector]] for the accepted fields and the validation rules.
- `expected_count` (required with `filter`): Integer from 1 to 5000. This is the matching count the user confirmed before the request.
- `format` (required): `"csv"` or `"json"` (NDJSON).
- `include_balance` (optional, CSV only): If `true`, adds a "Running Balance" column. Ignored for JSON.

**Response:** Streamed file download. Selection resolution, the exact row count, and all streamed chunks share one repeatable-read, read-only database snapshot, so `X-Exported-Count` equals the number of rows in the completed file. CORS exposes it to the frontend. A failure after headers are sent destroys the response so a partial stream is not reported as a successful download.

- **CSV**: `text/csv; charset=utf-8` with headers
- **NDJSON**: `application/x-ndjson` with one JSON object per line

**Filename Pattern:**

- CSV: `transactions_<label>_<YYYY-MM-DD>.csv`
- JSON: `transactions_<label>_<YYYY-MM-DD>.ndjson`

**Rate Limited:** 30 requests per minute

Implementation note:

- Resolves `ids | filter` via `[[apps/node-backend/src/services/bulkSelection.js]]`.
- CSV/NDJSON streaming and balance computation delegate to `[[apps/node-backend/src/services/transactionExport.js]]` (shared with GET export endpoints).
- CSV escape, formula-neutralization, and filename generation reuse the same helpers as `GET /api/transactions/export/csv`.
- Streaming behavior, chunk size (1000 rows), and error handling are identical to GET export endpoints.

## Examples

### List Transactions

**curl:**

```bash
curl "http://localhost:3002/api/transactions?limit=10&active=true"
```

**apiClient:**

```ts
const { data } = await apiClient.getTransactions({ limit: 10, active: true });
```

### Create Transaction

**curl:**

```bash
curl -X POST http://localhost:3002/api/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2026-01-15",
    "bank_account": "BE12 3456 7890 1234",
    "recipient_id": 1,
    "amount": -75.50,
    "memo": "Weekly shopping",
    "currency": "EUR"
  }'
```

**apiClient:**

```ts
const txn = await apiClient.createTransaction({
  date: "2026-01-15",
  bank_account: "BE12 3456 7890 1234",
  recipient_id: 1,
  amount: -75.5,
  memo: "Weekly shopping",
  currency: "EUR",
});
```

### Update Transaction

**curl:**

```bash
curl -X PATCH http://localhost:3002/api/transactions/123 \
  -H "Content-Type: application/json" \
  -d '{
    "category_id": 6,
    "comment": "Updated comment"
  }'
```

**apiClient:**

```ts
const updated = await apiClient.updateTransaction(123, {
  category_id: 6,
  comment: "Updated comment",
});
```

### Delete Transaction

**curl:**

```bash
curl -X DELETE http://localhost:3002/api/transactions/123
```

**apiClient:**

```ts
await apiClient.deleteTransaction(123);
```

## Transaction Amounts

- **Negative amounts**: Expenses (money leaving)
- **Positive amounts**: Income (money entering)

## Related

- [[docs/api/categories|Categories API]]
- [[docs/api/recipients|Recipients API]]
- [[docs/api/imports|Imports API]]
- [[docs/api/attachments|Attachments API]] (Phase 5A)

## Testing Coverage Note (2026-04-16 Phase 5)

Recent coverage in [[apps/node-backend/tests/routes/transactions.test.js]] verifies:

- CSV streaming chunked export via `res.write()` calls and accumulated running balance
- Formula-neutralization of dangerous prefixes (`=`, `+`, `-`, `@`)
- 404 probe behavior before streaming starts
- `include_balance` query param control of running-balance column
- `normalize_to_eur` conversion path behavior
- duplicate detection returning `409`
- unresolved `recipient_name`/`category_name` validation branches in patch flow

Related services:

- [[apps/node-backend/src/services/currency/currencyConversionService.js]]
- [[apps/node-backend/src/lib/filterBuilder.js]] (shared filter construction)
