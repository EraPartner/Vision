---
title: API - Portfolio Imports
type: endpoint
method: POST, GET, PATCH, DELETE
path: /api/portfolio/import
description: CSV import of brokerage/exchange trades into portfolio_transactions; instrument matching with review step; CRUD for saved portfolio parser configs (kind=portfolio)
date: 2026-06-18
updated: 2026-08-11
last_modified: 2026-06-18
tags: [api, portfolio, import, csv, portfolio-import, portfolio-parser, brokerage, trades, review, adr-078, account-id, adr-091, migration-0057]
status: active
aliases: [portfolio-imports-api, portfolio-csv-import, brokerage-import]
related_code:
  - "apps/node-backend/src/routes/portfolioImportRoutes.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/index.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/stage.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/validate.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/matchInvestments.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/commit.js"
  - "apps/node-backend/src/services/portfolioImportBatchService.js"
  - "apps/node-backend/src/services/customParserConfigService.js"
  - "apps/node-backend/src/lib/csvUpload.js"
  - "apps/node-backend/src/services/portfolio/fxResolve.js"
  - "apps/frontend/src/pages/portfolio/PortfolioImportPage.tsx"
  - "apps/frontend/src/pages/portfolio/PortfolioImportReviewPage.tsx"
  - "apps/frontend/src/features/imports/PortfolioCsvColumnMapper.tsx"
  - "apps/frontend/src/lib/api/portfolioImports.ts"
  - "apps/frontend/src/hooks/usePortfolioParserConfigs.ts"
---

# Portfolio Imports API

## Overview

The Portfolio Imports API handles CSV import of brokerage and exchange trades into `portfolio_transactions`. It is a parallel pipeline to the budgeting import (`/api/import`) and mirrors its structure: stage → validate → matchInvestments → (review|autoCommit) → commit.

All routes are mounted at `/api/portfolio/import` with `importRateLimiter`.

> [!info] Auto-commit policy
> The pipeline auto-commits (returns 201) only when every row was matched by exact symbol and there are zero errors or unresolved rows. Any mismatch or row error puts the batch into `awaiting_review` (returns 202) and requires the review flow before committing.

---

## Upload Endpoints

### POST /api/portfolio/import/csv/custom

One-shot portfolio CSV import. Runs the full pipeline synchronously. Returns 201 if all rows committed, 202 if review is required.

**Content-Type:** multipart/form-data

**Form Data:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | CSV file (max 50 MB) |
| `adapter_name` | string | No | Display label for the import source (written as `bank_account` on portfolio_transactions) |
| `date_format` | string | No | Python strptime format; default `%Y-%m-%d` |
| `separator` | string | No | Single-character CSV delimiter; default `,` |
| `encoding` | string | No | File encoding; default `utf-8` |
| `skip_rows` | integer | No | Header rows to skip; default `0` |
| `date_column` | string | Yes | CSV header name for the trade date |
| `type_column` | string | No | CSV header name for the transaction type (buy/sell/dividend/…) |
| `symbol_column` | string | No* | CSV header name for the ticker symbol |
| `name_column` | string | No* | CSV header name for the instrument name |
| `units_column` | string | No | CSV header name for number of units |
| `price_column` | string | No | CSV header name for unit price |
| `amount_column` | string | No | CSV header name for total amount |
| `fees_column` | string | No | CSV header name for transaction fees |
| `taxes_column` | string | No | CSV header name for taxes/withholding |
| `currency_column` | string | No | CSV header name for trade currency |
| `fx_rate_column` | string | No | CSV header name for EUR FX rate |
| `note_column` | string | No | CSV header name for a free-text note |
| `default_asset_class` | string | Yes | Fallback asset class: `stock` `etf` `crypto` `metals` `real_estate` `savings` `bond` |
| `default_type` | string | No | Fallback transaction type when no `type_column` is mapped (default `buy`): `buy` `sell` `dividend` `fee` `tax` `interest` |
| `type_mapping` | string | No | JSON object mapping raw CSV type strings → canonical portfolio_txn_type values (e.g. `{"Koop":"buy","Verkoop":"sell"}`) |

> [!warning] Symbol or name required
> At least one of `symbol_column` or `name_column` must be provided. Both may be mapped simultaneously for best matching.

**201 Response — committed:**
```json
{
  "ok": true,
  "data": {
    "batch_id": "42",
    "total": 150,
    "imported": 148,
    "duplicates": 1,
    "errors": 1
  }
}
```

**202 Response — awaiting review:**
```json
{
  "ok": true,
  "data": {
    "batch_id": "43",
    "requires_review": true,
    "match_source_counts": {
      "symbol_exact": 120,
      "name_exact": 15,
      "unresolved": 10,
      "error": 5
    }
  }
}
```

---

### POST /api/portfolio/import/csv/stream

SSE-streaming portfolio CSV import. Same request body as the custom endpoint. Useful for large files or when progress feedback is needed.

**Response:** `text/event-stream`

```
event: progress
data: {"phase":"staging","current":50,"total":150,"percent":13}

event: progress
data: {"phase":"validating","current":150,"total":150,"errors":0,"percent":55}

event: review_required
data: {"batch_id":"43","requires_review":true,"match_source_counts":{"unresolved":10}}

event: complete
data: {"batch_id":"42","total":150,"imported":148,"duplicates":1,"errors":1}

event: error
data: {"message":"date_column is required"}
```

Progress percent mapping:
- `staging` → 0–40 %
- `validating` → 40–55 %
- `matching` → 55–70 %
- `committing` → 70–100 %

---

## Saved Parser Endpoints

Portfolio parser configs reuse the `custom_parser_configs` table with `kind = 'portfolio'`. The uniqueness constraint is `(name, kind)`, so a transaction parser and a portfolio parser may share the same name.

### GET /api/portfolio/import/parsers

List all saved portfolio parser configurations. Collection GETs use the
canonical `{items, total}` body; this list is unpaginated, so `total` is the
row count.

**Response:**
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 5,
        "name": "Degiro Trades",
        "config": {
          "date_format": "%d-%m-%Y",
          "separator": ",",
          "encoding": "utf-8",
          "skip_rows": 0,
          "default_asset_class": "stock",
          "default_type": "buy",
          "type_mapping": {},
          "column_mapping": {
            "date": "Date",
            "symbol": "Symbol",
            "units": "Quantity",
            "price": "Price",
            "amount": "Value",
            "fees": "Transaction and/or third party costs"
          }
        },
        "created_at": "2026-06-15T10:00:00Z",
        "updated_at": "2026-06-15T10:00:00Z"
      }
    ],
    "total": 1
  }
}
```

---

### POST /api/portfolio/import/parsers

Create a new saved portfolio parser configuration.

**Request Body:**
```json
{
  "name": "Degiro Trades",
  "config": {
    "date_format": "%d-%m-%Y",
    "separator": ",",
    "default_asset_class": "stock",
    "column_mapping": {
      "date": "Date",
      "symbol": "Symbol",
      "units": "Quantity"
    }
  }
}
```

**Responses:**

| Status | Meaning |
|--------|---------|
| `201 Created` | Parser created; body contains the record |
| `409 Conflict` | A portfolio parser with that name already exists |

---

### PATCH /api/portfolio/import/parsers/:id

Update an existing saved portfolio parser. Both `name` and `config` are optional.

**Responses:**

| Status | Meaning |
|--------|---------|
| `200 OK` | Parser updated |
| `404 Not Found` | No portfolio parser with that id |
| `409 Conflict` | Another portfolio parser already uses the requested `name` |

---

### DELETE /api/portfolio/import/parsers/:id

Delete a saved portfolio parser.

**Responses:**

| Status | Meaning |
|--------|---------|
| `204 No Content` | Deleted successfully |
| `404 Not Found` | No portfolio parser with that id |

---

## Batch Endpoints

### GET /api/portfolio/import/batches

List portfolio import batches, newest first.

**Query Parameters:**
- `limit` (integer, optional) — max rows to return (default 50, clamped to 200)
- `offset` (integer, optional) — pagination offset (default 0)

**Response:** canonical paginated collection body — `{ items, total, limit, offset }`.

---

### GET /api/portfolio/import/batches/:id

Get a single portfolio import batch with full status and row counts.

---

### DELETE /api/portfolio/import/batches/:id

Rollback a batch. Deletes all `portfolio_transactions` committed by this batch and marks the batch status as `aborted`. Only committed batches can be rolled back; `awaiting_review` batches can be aborted without effect on portfolio_transactions.

---

## Review Endpoints

When the pipeline detects unresolved instruments (symbol not found in `investments`) it leaves the batch in `awaiting_review` and the SSE stream emits a `review_required` event. These endpoints let the client inspect, assign instruments, and commit.

> [!warning] Batch/row id contract (2026-08-11 — breaking for malformed ids)
> Every `:id` and `:rowId` on `/api/portfolio/import/batches/*` accepts **only** a plain base-10 integer in 1..9,007,199,254,740,991 (`portfolio_import_batches.id` and `portfolio_import_staging_rows.id` are `BIGSERIAL`, so the ceiling is *not* `int32`). Anything else returns `400 VALIDATION_ERROR`.
>
> These ids were parsed with a bare `Number()`, which silently addressed a **different batch** on `"0x10"` → 16, `"1e3"` → 1000 and `"9007199254740993"` → …992, and additionally accepted `"+5"`, `" 12 "` and `"12.0"`. The parser now delegates to the shared `validateId` (`lib/importBatchIds.js`, shared with the transaction import router). Clients sending plain integers are unaffected. Full accept set: [[docs/security/input-validation#coercedIdSchema (import batch/row ids)|Input Validation]].

### GET /api/portfolio/import/batches/:id/preview

Returns staging rows grouped by investment (or by distinct raw symbol/name for unresolved rows).

**Response envelope `data`:**

| Field | Type | Description |
|-------|------|-------------|
| `batch_id` | string | Batch identifier |
| `groups[]` | array | One entry per resolved investment or per distinct unresolved symbol+name combination |
| `groups[].investment_id` | `number \| null` | Matched or overridden investment. `null` = unresolved. |
| `groups[].symbol` | string | Raw CSV symbol for the group |
| `groups[].name_exact` | boolean | Whether the group was resolved by exact name (vs. symbol) |
| `groups[].unresolved` | boolean | `true` if no investment has been matched yet |
| `groups[].error` | boolean | `true` if this group contains rows with validation errors |
| `groups[].row_count` | integer | Number of staging rows in the group |
| `groups[].rows[]` | array | Per-row detail: date, units, price, amount, currency, match_source, error_detail |
| `totals` | object | `{symbol_exact, name_exact, unresolved, error}` counts across all groups |

---

### POST /api/portfolio/import/batches/:id/rows/:rowId/investment-override

Resolve an unmatched staging row by linking it to an existing investment or requesting that a new investment be created.

**Request Body:**
```json
{ "investment_id": 12 }
```
or
```json
{ "create_new": true }
```

When `create_new: true`, a new investment record is created from the row's `symbol` / `name` / `default_asset_class` and linked to the row. All other rows with the same raw symbol/name in this batch are also resolved to the new investment.

**Responses:**

| Status | Meaning |
|--------|---------|
| `200 OK` | Override applied; body contains the updated row |
| `400 Bad Request` | Neither `investment_id` nor `create_new` supplied, or `create_new` validation failed |
| `404 Not Found` | Batch or staging row not found |

---

### POST /api/portfolio/import/batches/:id/commit

Commit a reviewed batch. Honours all investment overrides. Runs FX resolution for non-EUR rows without an explicit rate (ADR-074 semantics). Per-row errors (oversell, unresolved) are recorded without aborting the batch.

**Optional request body:**

```json
{ "account_id": 7 }
```

When `account_id` is provided, all committed `portfolio_transactions` inherit it — they belong to
the specified brokerage account. Omit to leave lots unassigned (legacy behaviour).
Requires migration 0057 (`portfolio_import_batches.account_id`; authored, not yet applied).

> [!warning] Unresolved rows are skipped
> Any row still unresolved at commit time is recorded as an error row and is not inserted into `portfolio_transactions`. The batch completes with non-zero `rows_error`.

**Response:**
```json
{
  "ok": true,
  "data": {
    "batch_id": "43",
    "imported": 148,
    "duplicates": 1,
    "errors": 1
  }
}
```

**Responses:**

| Status | Meaning |
|--------|---------|
| `200 OK` | Commit completed (check `errors` field) |
| `409 Conflict` | Batch is not in `awaiting_review` or `matched` status |

---

## Rate Limits

Upload endpoints (`/csv/custom` and `/csv/stream`) use `importRateLimiter` (same as budgeting import). Batch, review, and parser endpoints use the global default rate limit.

---

## Related

- [[docs/features/portfolio-import|Portfolio Import Feature]]
- [[docs/api/imports|Imports API]] — budgeting CSV import (parallel pipeline)
- [[docs/adr/078-portfolio-csv-import|ADR-078: Portfolio CSV Import Architecture]]
- [[docs/reference/data-model|Data Model Reference]] — `portfolio_import_batches`, `portfolio_import_staging_rows`
- [[docs/features/portfolio|Portfolio Feature]]
