---
title: API - Imports
type: endpoint
method: POST, GET
path: /api/import
description: CSV import for transactions, recipients, and categories
date: 2026-04-26
updated: 2026-04-26
tags: [api, import, csv, bank]
status: active
aliases: [imports-api, csv-import, bank-import, bank-statement, deduplication]
related_code: ["apps/node-backend/src/routes/importRoutes.js", "apps/node-backend/src/services/importPipeline/index.js", "apps/node-backend/src/lib/sse.js", "apps/node-backend/src/repositories/importBatchRepository.js"]
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

Streaming import with SSE progress updates. Uses backpressure-aware writer to prevent unbounded memory growth when client consumes events slowly.

**Content-Type:** multipart/form-data

**Form Data:** Same as POST /api/import/csv

**Response:** Server-Sent Events stream with phase-based progress events (Phase C):

```javascript
// Staging phase
event: progress
data: {"phase":"staging","current":50,"total":150}

// Validation phase
event: progress
data: {"phase":"validating","current":50,"total":150,"errors":0}

// Matching phase
event: progress
data: {"phase":"matching","current":50,"total":150}

// Commit phase
event: progress
data: {"phase":"committing","current":50,"total":150,"imported":48,"duplicates":2,"errors":0}

// Complete event
event: complete
data: {"batchId":42,"total_processed":150,"imported":148,"duplicates":2,"errors":0}
```

**Backpressure & Resilience (Phase C):**

- **SSE Writer**: Server uses `createSseWriter(req, res)` ([[apps/node-backend/src/lib/sse.js]]) to track client disconnects and propagate TCP backpressure from the HTTP socket into the import pipeline.
- **Pause on Drain**: When Node.js write buffer is full (`res.writableNeedDrain`), `await writer.write()` pauses the import loop until the kernel drains buffered events, preventing memory exhaustion on slow clients.
- **Orchestrator Integration**: The `runImportPipeline()` ([[apps/node-backend/src/services/importPipeline/index.js]]) passes an `async onProgress` callback that awaits SSE writes, turning network delays into back-pressure on processing.
- **Batch Persistence**: Each import is assigned a `batchId` and tracked in `import_batches` table for history and rollback capability.

**Client Implementation:**

- Progress parsing ([[apps/frontend/src/lib/api.ts]]) handles SSE event blocks separated by blank lines with support for multi-line `data:` fields.
- No async Promise executor anti-pattern; stream lifecycle is explicit.
- Defensive parsing tolerates malformed/partial SSE payloads with sanitized error fallback.

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

**Response:**
```json
{
  "total_processed": 25,
  "imported": 23,
  "skipped": 1,
  "errors": 0,
  "bank_account_errors": 1,
  "status": "completed"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `total_processed` | integer | Total rows in CSV file |
| `imported` | integer | Recipients successfully created |
| `skipped` | integer | Recipients already existing |
| `errors` | integer | Rows with validation errors |
| `bank_account_errors` | integer | (2026-04-26) Recipients created but bank account creation failed |
| `status` | string | `"completed"` or `"completed_with_errors"` |

**Note:** `bank_account_errors` tracks failures when adding bank account information to recipients. The recipient is still created; only the optional bank account link fails.

### POST /api/import/categories

Bulk import categories from CSV.

**CSV Format:**
```csv
general,detail,description
FOOD,GROCERIES,Supermarket purchases
FOOD,RESTAURANTS,Restaurant and cafe
TRANSPORT,GAS,Fuel purchases
```

**Implementation Notes (Phase C):**

- **Unified Pipeline**: All imports (standard, custom, and streaming) route through `runImportPipeline()` ([[apps/node-backend/src/services/importPipeline/index.js]]), which orchestrates five phases: stage → validate → match → commit → aggregation-refresh.
- **Phase Isolation**: Each phase is idempotent at its boundary; failures in any phase mark the batch as `failed` without cascading partial state.
- **Temp File Cleanup**: Route-level cleanup uses non-blocking `fs.promises.unlink(...).catch(...)` to avoid blocking the event loop under concurrent imports ([[apps/node-backend/src/routes/importRoutes.js]]).
- **Concurrent Row Processing**: Row batches are processed with adaptive concurrency calculated as `Math.max(2, Math.floor(poolMax / 2))` where `poolMax = max(DB_POOL_SIZE, DB_MAX_OVERFLOW)`. With default pool settings (poolMax=10), concurrency is 5. Batches use `Promise.allSettled` so one bad row doesn't stall others.
- **Deduplication**: SHA-256 hash-based dedup checks via raw transaction tables (Belfius, Revolut, KBC, SABB, Wise, Vision) with fallback to field-based matching for unsupported banks.
- **Error Sanitization**: Route failures return generic `"Import failed"` message without exposing internal exception details. SSE error events are also sanitized for safe frontend display.

## Test Updates (Phase C, April 2026)

Import route tests ([[apps/node-backend/tests/routes/import.test.js]]) were refactored to mock the new orchestrator:

**Key changes:**
- Old service imports (`importService`, `streamingImportService`, `rawTransactionImportService`) replaced with `runImportPipeline` mock.
- Mock now simulates progress callbacks with proper `onProgress` signature: `async (event: { phase, current, total, imported?, duplicates?, errors? }) => void`.
- SSE streaming tests verify that `createSseWriter()` is called and that progress events are forwarded correctly.
- Response envelope follows [[docs/adr/026-unified-api-response-envelope|ADR-026]] — success wraps results in `{ ok: true, data, meta }`, failures return `{ ok: false, error }`.

**Example test pattern:**
```javascript
it('should stream import with backpressure', async () => {
  runImportPipeline.mockImplementation(async ({ onProgress }) => {
    await onProgress({ phase: 'staging', current: 0, total: 100 });
    await onProgress({ phase: 'validating', current: 100, total: 100, errors: 0 });
    return { batchId: 42, total: 100, imported: 98, duplicates: 2, errors: 0 };
  });

  // SSE response handling...
  expect(createSseWriter).toHaveBeenCalledWith(expect.any(Object), expect.any(Object));
});
```

See [[docs/testing/testing|Testing Documentation]] for envelope-aware test patterns and [[docs/adr/026-unified-api-response-envelope|ADR-026]] for the response contract.

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

## Test Coverage

- **Phase C (April 2026)**: [[apps/node-backend/tests/routes/import.test.js]] covers orchestrator integration, SSE backpressure scenarios, recipients/categories bulk import, and multer error handling.
- **Removed (Phase C)**: Old service unit tests (`importService.test.js`, `streamingImportService.test.js`, `rawTransactionImportService.test.js`) superseded by pipeline integration tests.

## Related

- [[docs/features/import|Feature: CSV Import & Deduplication]]
- [[docs/testing/testing|Testing Documentation]]
- [[docs/testing/test-inventory|Test Inventory]]
