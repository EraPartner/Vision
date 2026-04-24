---
title: Feature - CSV Import, Export, Attachments & Deduplication
type: feature
status: active
date: 2026-04-24
tags: [feature, import, export, csv, json, deduplication, phase-5a, attachments, phase-1, performance, concurrency]
aliases: [csv-import, bank-import, bank-statement, deduplication, data-import, streaming-import]
description: Import transactions from bank CSV files with automatic deduplication
related_code: ["apps/node-backend/src/services/importService.js", "apps/node-backend/src/services/streamingImportService.js", "apps/node-backend/src/services/rawTransactionImportService.js", "apps/node-backend/src/services/dataImportService.js", "apps/node-backend/src/services/deduplication.js", "apps/node-backend/src/services/textNormalization.js", "apps/node-backend/src/routes/importRoutes.js", "apps/node-backend/src/repositories/rawTransactionRepository.js"]
---

# Feature: CSV Import & Deduplication

## Overview

Vision provides comprehensive CSV import capabilities with support for multiple bank formats, automatic deduplication, and category detection.

## Supported Banks

### Pre-configured Bank Adapters
| Bank | Format | Fields |
|------|--------|--------|
| Belfius | Belgian bank format | Date, amount, recipient, balance |
| Revolut | Multi-currency | Type, state, amount, currency |
| KBC | Belgian corporate | Counterparty, structured communication |
| SABB | Belgian bank | Posting date, description |
| Wise | Multi-currency transfers | Transfer ID, exchange rate |
| Vision | Internal format | Standard transaction fields |
| Custom | User-defined | Configurable column mapping |

## Import Service Architecture

Vision has **three** CSV import services, each serving a different purpose:

### 1. `importService.js` — Legacy Import
**File:** [[apps/node-backend/src/services/importService.js]]

The original import service. Processes CSV files sequentially, using field-based deduplication for generic banks and hash-based deduplication for known banks. Falls back to `isDuplicateByFields()` when raw tables aren't available.

**Use case:** Small files, generic bank formats, backward compatibility.

### 2. `streamingImportService.js` — Streaming Import with Progress
**File:** [[apps/node-backend/src/services/streamingImportService.js]]

Optimized for large files with real-time progress reporting via callbacks (used by SSE endpoints). Key performance features:
- **Adaptive parallel batch processing**: Rows processed in concurrent batches sized automatically from DB pool config. Calculated as `Math.max(2, Math.floor(poolMax / 2))` where `poolMax = max(DB_POOL_SIZE, DB_MAX_OVERFLOW)`. With default pool settings (poolMax=10), concurrency is 5. This ensures at least half the connection pool remains available for other requests.
- **Single-round-trip recipient upsert**: `INSERT ... ON CONFLICT DO NOTHING RETURNING id` with fallback SELECT (down from 2-4 round-trips)
- **Single-round-trip raw dedup**: `INSERT ... ON CONFLICT DO NOTHING RETURNING *` — null return means duplicate
- **Fire-and-forget non-critical writes**: Bank account linking and raw reference creation don't block import outcome
- **Promise.allSettled per batch**: One bad row doesn't stall others

Implementation note:
- Remaining dynamic dedup import in the generic/legacy streaming path was removed; the service now uses module-scoped `isRawDuplicate` with fallback to `isDuplicateByFields`, preserving duplicate-detection behavior while reducing runtime import overhead.
- Concurrency calculation moved from hardcoded `20` to adaptive `Math.max(2, Math.floor(poolMax / 2))` to respect pool ceiling and prevent connection exhaustion on non-default pool configs.

**Progress phases:** `counting` → `parsing` → `importing` → `complete`/`error`

**Use case:** Large CSV files, UI progress display, SSE streaming endpoint (`POST /api/import/csv/stream`).

### 3. `rawTransactionImportService.js` — Raw Data Preservation Import
**File:** [[apps/node-backend/src/services/rawTransactionImportService.js]]

Orchestrates CSV import with full raw data preservation. Architecture:
1. Parse CSV via bank adapter
2. Check raw table deduplication (hash-based per bank)
3. Store raw data in bank-specific table
4. Create normalized transaction record
5. Link transaction to raw data via `transaction_raw_references`

Falls back to `importService.js` for generic/unsupported bank types.

Implementation notes:
- Raw import processing uses adaptive bounded concurrent batching (same formula as streaming import: `Math.max(2, Math.floor(poolMax / 2))`) with `Promise.allSettled`, preserving imported/duplicate/error accounting semantics while reducing end-to-end latency on larger files.
- Hot-path dynamic imports were replaced with module-scoped imports (`importCSV`, `isDuplicateByFields`, `normalizeForMatching`) to remove per-row/per-request import resolution overhead.
- Raw duplicate checking now prefers repository-level `isRawDuplicate(...)` with fallback to field-based dedup when repository/raw-table paths fail, preserving fallback semantics.

**Use case:** Audit trail requirements, re-import capability, supported banks (Belfius, Revolut, KBC, SABB, Wise, Vision).

### 4. `dataImportService.js` — Recipients & Categories Bulk Import
**File:** [[apps/node-backend/src/services/dataImportService.js]]

Handles bulk CSV import for **recipients** and **categories** (not transactions).

**Recipient CSV format:**
| Column | Required | Notes |
|--------|----------|-------|
| name | Yes | Recipient name |
| bank_account | No | IBAN or account number |
| address | No | Stored in `notes` field |
| category | No | Format: `GENERAL:DETAIL` |

**Category CSV format:**
| Column | Required | Notes |
|--------|----------|-------|
| category | Yes | Format: `GENERAL:DETAIL` (falls back to first column) |

Both use `createOrGet` pattern — existing records are skipped, not overwritten.

---

## Supporting Services

### `textNormalization.js`
**File:** [[apps/node-backend/src/services/textNormalization.js]]

Text processing utilities for import and recipient matching:

| Function | Purpose |
|----------|---------|
| `cleanRecipientName()` | Strips common prefixes ("Payment from", "Transfer to", etc.) |
| `cleanKbcRecipientName()` | KBC-specific parsing (handles Dutch/French transaction types and separators) |
| `normalizeToUppercase()` | Uppercase + trim validation |
| `normalizeForMatching()` | Canonical form for recipient matching — filters initials, sorts tokens alphabetically, removes punctuation. E.g., "John F Doe" → "DOE JOHN" |
| `formatAmountString()` | Handles European decimal formats (comma as decimal separator) |
| `extractCurrencyCode()` | Extracts 3-letter currency code from strings |

### `deduplication.js`
**File:** [[apps/node-backend/src/services/deduplication.js]]

Field-based deduplication for transactions. Uses SHA-256 hash of `date|amount|recipient|memo|bank_account` for raw table dedup, and direct field matching for the legacy path.

---

## Import Process

### 1. File Upload
- Maximum file size: 50MB
- Supported format: CSV
- Encoding: UTF-8 (configurable)

### 2. Parsing & Normalization
- CSV parsed with configurable separator
- Date formats converted to YYYY-MM-DD
- Amounts normalized (handle different decimal separators)
- Text normalized (trimming, encoding)
- Temporary upload-file cleanup in import routes now uses non-blocking async unlink to avoid request-path synchronous filesystem blocking while keeping ignore-on-missing behavior ([[apps/node-backend/src/routes/importRoutes.js]]).

### 3. Deduplication
Uses SHA-256 hash of:
```
date|amount|recipient|memo|bank_account
```

Duplicate detection checks:
1. Hash comparison with existing raw transactions
2. Date + Amount + Recipient field matching
3. Bank-specific deduplication strategies

### 4. Category Detection
- Looks up recipient's default category
- Applies category if found
- Falls back to uncategorized if not

### 5. Transaction Creation
- Creates transactions in main table
- Links to raw source for audit trail
- **Phase 0+**: Triggers fire-and-forget materialized view refresh (post-commit) to keep aggregations warm

## Deduplication Strategies

### SHA-256 Hash
Each raw transaction gets a unique hash stored in its respective bank-specific table:
- `belfius_raw_transactions.deduplication_hash`
- `revolut_raw_transactions.deduplication_hash`
- `kbc_raw_transactions.deduplication_hash`
- `sabb_raw_transactions.deduplication_hash`
- `wise_raw_transactions.deduplication_hash`
- `vision_raw_transactions.deduplication_hash`
- `manual_raw_transactions.deduplication_hash` - Manual entry deduplication

> **Note:** `custom_raw_transactions` was dropped by migration `0008_drop_custom_raw_transactions.py`. Custom CSV imports now use the generic import path without a dedicated raw table.

### Field-based Matching
For manual transactions, checks:
```sql
SELECT id FROM transactions 
WHERE date = $1 AND amount = $2 AND recipient_id = $3
AND is_active = true
```

### Duplicate Handling
- **Skipped**: Duplicate transactions are counted but not imported
- **Status**: Import result includes `duplicates_skipped` count

## Custom CSV Configuration

For unsupported banks, use custom import:

```
POST /api/import/csv/custom
```

**Storage**: Custom imports use the generic import path with field-based deduplication (no dedicated raw table since migration `0008`).

Parameters:
- `bank_name`: Custom identifier
- `date_format`: e.g., "DD/MM/YYYY", "MM/DD/YYYY"
- `date_column`: Column name containing date
- `recipient_column`: Column name for recipient
- `amount_column`: Column name for amount
- `memo_column`: Optional memo/description column

## Visual CSV Column Mapper (Phase 5A)

The Import Page now features an interactive visual CSV column mapper for flexible bank format support.

### Features
- **Client-side header detection**: Reads first 16 KB of CSV via FileReader to extract headers automatically
- **Preview table**: Shows up to 5 rows of data with mapped columns highlighted
- **Configurable separators**: Auto-detect or manually select `;`, `,`, `\t`
- **Dropdown mapping**: Each required field (date, recipient, amount) maps to a CSV column via dropdown
- **Text input fallback**: For unmapped fields, optional text input for defaults or overrides
- **Validation**: Prevents import until required fields are mapped

### Implementation
- **Hook**: [[apps/frontend/src/hooks/useCsvPreview.ts]] — handles CSV parsing, header extraction, preview row generation
- **Component**: [[apps/frontend/src/components/import/CsvColumnMapper.tsx]] — UI for dropdown mapping and preview display
- **Integration**: Replaces 4 inline text inputs in [[apps/frontend/src/pages/ImportPage.tsx]]; separator field moved above mapper
- **i18n**: New keys: `csvParsing`, `csvParseError`, `csvPreviewTitle`, `noMapping` (en + nl translations)

### Usage
1. Select CSV file or drag-and-drop
2. Choose separator (auto-detected by default)
3. Preview table shows detected headers and sample data
4. Map each required field using dropdown
5. Click import when ready

## Streaming Import

For large files, use streaming import with progress:

```
POST /api/import/csv/stream
```

Returns Server-Sent Events with progress:
```javascript
event: progress
data: {"processed": 50, "total": 150, "status": "processing"}

event: complete  
data: {"imported": 145, "duplicates_skipped": 5, "errors": 0}
```

**Backpressure Handling (Phase 3.2, 2026-04-23):**
- Streaming import now uses `createSseWriter(req, res)` [[apps/node-backend/src/lib/sse.js]] to propagate backpressure from the HTTP client all the way into the import batch loop. When the client consumes events slower than they are produced, `drainIfNeeded()` pauses the server's write buffer, preventing unbounded memory growth in Node.js TCP buffers.
- Import progress callbacks are now `async` and await the SSE writer's `write()` promise.

Frontend SSE robustness updates:
- Stream parsing in [[apps/frontend/src/lib/api.ts]] now consumes blank-line-delimited event blocks correctly and supports multi-line `data:` fields.
- Import progress handling no longer uses the async Promise executor anti-pattern; stream lifecycle/error propagation is now explicit and safer.
- Malformed/partial SSE payloads are tolerated with defensive parsing and sanitized fallback errors.

Backend error-hardening updates:
- Import routes now return generic error details (`Import failed`) and avoid exposing internal exception messages in JSON and SSE error events ([[apps/node-backend/src/routes/importRoutes.js]]).

## Raw Transaction Storage

Imported transactions are stored in raw tables:
- Original CSV line preserved
- Deduplication hash for future imports
- Links to normalized transactions

This allows:
- Re-import without duplicates
- Audit trail of original data
- Multiple bank account management

## Export Formats

Vision supports transaction export in two formats:

### CSV Export
- Streaming CSV with columns: Date, Bank Account, Recipient, Memo, Amount, Currency, Balance, Category, Comment
- Optional running balance computation via JavaScript accumulator
- Formula-injection protection (neutralizes `=`, `+`, `-`, `@` prefixes)
- Endpoint: `GET /api/transactions/export/csv` (30 req/min rate limit)

### JSON Export (Phase 5A)
- Streaming NDJSON (newline-delimited JSON) format for programmatic processing
- One complete JSON object per line with fields: id, date, bank_account, recipient, memo, amount, currency, balance, category, comment
- No balance computation (direct field passthrough)
- Endpoint: `GET /api/transactions/export/json` (30 req/min rate limit)
- See [[docs/api/transactions#get-apitransactionsexportjson|Transactions API]] for full spec

### Frontend Support
- [[apps/frontend/src/pages/ImportPage.tsx]]: Dual export buttons (CSV + JSON) with `exportingFormat` state management
- i18n: `importPage.exportBtn` ("Export CSV") and `importPage.exportJsonBtn` ("Export JSON")

## Attachments (Phase 5A)

Vision supports receipt and document attachments for transactions via the attachment service.

### Features
- **File upload**: Attach receipts, invoices, and supporting documents to transactions
- **Image preview**: Automatic thumbnail generation for image attachments
- **File management**: Upload, download, and delete attachments
- **Storage**: Files stored in `{ATTACHMENTS_DIR}/{txId}/{uuid}.ext` structure with relative path tracking in database
- **Size limits**: Configurable via `ATTACHMENT_MAX_SIZE_MB` environment variable (default 10 MB)
- **MIME types**: Supports PDF, JPEG, PNG, and other standard document formats

### Backend Services
- [[apps/node-backend/src/services/attachmentService.js]]: Core attachment lifecycle (upload, store, remove)
- [[apps/node-backend/src/repositories/attachmentRepository.js]]: Database operations (CRUD)
- [[apps/node-backend/src/routes/attachments.js]]: Four REST endpoints for attachment management
- Database migration `0004_attachments.py`: Schema with transaction FK, stored_path, mime_type, size_bytes

### Frontend Components
- [[apps/frontend/src/components/shared/AttachmentPanel.tsx]]: React Query-integrated upload/list/delete UI with thumbnail preview and hover-reveal delete button
- [[apps/frontend/src/lib/api/attachments.ts]]: Typed API client for attachment operations
- [[apps/frontend/src/features/transactions/components/TransactionInfoDialog.tsx]]: AttachmentPanel integrated into transaction detail view

### API
See [[docs/api/attachments|Attachments API]] for endpoint contracts and examples.

## Related

- [[docs/api/imports|API: Imports]]
- [[docs/api/transactions|API: Transactions]]
- [[docs/api/recipients|API: Recipients]]
- [[docs/api/attachments|API: Attachments]]

## Testing references (2026-04-10)

- [[apps/node-backend/tests/routes/import.test.js]] extends route-level import coverage for SSE stream behavior, recipients/categories route handling, and multer middleware error paths.
- [[apps/node-backend/tests/dataImportService.test.js]] adds recipients/categories bulk import service coverage.
- [[apps/node-backend/tests/streamingImportService.test.js]] adds streaming import progress/error and result aggregation coverage.

Related testing docs: [[docs/testing/testing|Testing Documentation]], [[docs/testing/test-inventory|Test Inventory]].
