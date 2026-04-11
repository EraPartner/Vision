---
title: API - Imports
type: endpoint
method: POST, GET
path: /api/import
description: CSV import for transactions, recipients, and categories
date: 2026-04-10
tags: [api, import, csv, bank]
status: active
aliases: [imports-api, csv-import, bank-import, bank-statement, deduplication]
related_code: [[apps/node-backend/src/routes/importRoutes.js]]
---

# Imports API

## Overview

The Imports API handles CSV file imports from various banks with automatic deduplication and category detection. Supports standard bank formats and custom configurations.

## Endpoints

### POST /api/import/csv

Import transactions from a CSV file using a predefined bank adapter.

**Content-Type:** multipart/form-data

**Form Data:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | File | Yes | CSV file (max 50MB) |
| bank_name | string | Yes | Bank identifier |

**Supported Banks:**
- belfius
- revolut
- kbc
- sabb
- wise
- vision
- custom

**Response:**
```json
{
  "imported": 150,
  "duplicates_skipped": 5,
  "errors": 2,
  "status": "completed",
  "error_message": null,
  "links": []
}
```

### POST /api/import/csv/custom

Import using custom CSV configuration.

**Form Data:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | File | Yes | CSV file |
| bank_name | string | Yes | Custom bank name |
| date_format | string | Yes | Date format (e.g., DD/MM/YYYY) |
| date_column | string | Yes | Column name for date |
| recipient_column | string | Yes | Column name for recipient |
| amount_column | string | Yes | Column name for amount |
| memo_column | string | No | Column name for memo |
| separator | string | No | CSV separator (default: ,) |
| encoding | string | No | File encoding (default: utf-8) |
| skip_rows | integer | No | Rows to skip (default: 0) |

### POST /api/import/csv/stream

Streaming import with SSE progress updates.

**Content-Type:** multipart/form-data

**Form Data:** Same as POST /api/import/csv

**Response:** Server-Sent Events stream with progress events:

```javascript
// Progress event
event: progress
data: {"processed": 50, "total": 150, "status": "processing"}

// Complete event
event: complete
data: {"imported": 150, "duplicates_skipped": 5, "errors": 0, "status": "completed"}
```

SSE implementation notes:
- Client parsing (`importCSVWithProgress`) now handles SSE event blocks by blank-line delimiters and supports multi-line `data:` fields robustly.
- Client moved away from `new Promise(async ...)` anti-pattern for stream handling and now uses safer async control flow with explicit parser/error paths.
- Malformed SSE payloads and backend error events are surfaced with sanitized, user-safe error extraction.

Code link: [[apps/frontend/src/lib/api.ts]]

### GET /api/import/supported-banks

Get list of supported bank adapters.

**Response:**
```json
{
  "banks": ["Belfius", "Revolut", "Kbc", "Sabb", "Wise", "Vision", "Custom"],
  "total": 7
}
```

### POST /api/import/recipients

Bulk import recipients from CSV.

**Content-Type:** multipart/form-data

**Form Data:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | File | Yes | CSV file |
| separator | string | No | CSV separator |
| encoding | string | No | File encoding |

**CSV Format:**
```csv
name,default_category
"Supermarket ABC","FOOD:GROCERIES"
"Gas Station","TRANSPORT:GAS"
```

### POST /api/import/categories

Bulk import categories from CSV.

**CSV Format:**
```csv
general,detail,description
FOOD,GROCERIES,Supermarket purchases
FOOD,RESTAURANTS,Restaurant and cafe
TRANSPORT,GAS,Fuel purchases
```

Implementation note:
- Route temp-file cleanup now uses non-blocking async unlink (`fs.promises.unlink(...).catch(...)`) instead of synchronous filesystem calls, preserving silent-failure cleanup semantics while reducing event-loop blocking under concurrent imports ([[apps/node-backend/src/routes/importRoutes.js]]).
- Raw-import service now processes parsed rows in bounded concurrent batches (`RAW_IMPORT_BATCH_SIZE = 20`) using `Promise.allSettled`, preserving imported/duplicate/error accounting semantics while improving throughput on larger files ([[apps/node-backend/src/services/rawTransactionImportService.js]]).
- Raw-import and streaming-import fallback dedup checks now use module-scoped `isRawDuplicate` with fallback to `isDuplicateByFields`, preserving duplicate-detection behavior while removing remaining hot-path dynamic import overhead ([[apps/node-backend/src/services/rawTransactionImportService.js]], [[apps/node-backend/src/services/streamingImportService.js]]).

## Import Behavior

### Deduplication
- Uses SHA-256 hash of (date, amount, recipient, bank_account)
- Duplicate transactions are skipped automatically
- Hash stored in raw transaction tables for future detection

### Category Detection
- Imports look up recipient's default category
- Creates/categorizes transactions based on recipient settings

### Error Handling
- Returns count of errors in response
- Partial imports complete even with some errors
- Import route failures now return generic `detail: "Import failed"` style responses and avoid leaking raw internal exception strings.
- SSE error events also use sanitized generic details to keep payloads safe for frontend display.

## Rate Limits

- Standard imports: General rate limits apply
- Streaming imports: Progress callbacks are not rate-limited

> **Note:** CSV export (`GET /api/transactions/export/csv`) is on the [[docs/api/transactions|Transactions API]], not the imports API. It has a rate limit of 30 requests per minute.

## Related

- [[docs/api/transactions|Transactions API]]
- [[docs/api/recipients|Recipients API]]
- [[docs/integrations/index|Integrations]]

## Test Coverage Notes (2026-04-10)

- [[apps/node-backend/tests/routes/import.test.js]] verifies route-level error hardening, including SSE stream error behavior, recipients/categories import route handling, and multer middleware error paths.
- [[apps/node-backend/tests/dataImportService.test.js]] adds regression coverage for recipients/categories bulk import service behavior.
- [[apps/node-backend/tests/streamingImportService.test.js]] adds regression coverage for streaming import progress/error handling and result aggregation.

## Related

- [[docs/testing/testing|Testing Documentation]]
- [[docs/testing/test-inventory|Test Inventory]]
