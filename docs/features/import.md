---
title: Feature - CSV Import, Export, Attachments & Deduplication
type: feature
status: active
date: 2026-04-24
updated: 2026-04-26
tags: [feature, import, export, csv, json, deduplication, phase-5a, attachments, phase-c, phase-e, phase-1, phase-12, performance, concurrency, import-pipeline, component-split, error-handling]
aliases: [csv-import, bank-import, bank-statement, deduplication, data-import, streaming-import]
description: Import transactions from bank CSV files with automatic deduplication. Phase E refactor split ImportPage into self-contained feature components.
related_code: ["apps/node-backend/src/services/importPipeline/index.js", "apps/node-backend/src/services/importPipeline/stage.js", "apps/node-backend/src/services/importPipeline/validate.js", "apps/node-backend/src/services/importPipeline/match.js", "apps/node-backend/src/services/importPipeline/commit.js", "apps/node-backend/src/services/dataImportService.js", "apps/node-backend/src/services/deduplication.js", "apps/node-backend/src/services/textNormalization.js", "apps/node-backend/src/routes/importRoutes.js", "apps/node-backend/src/lib/sse.js", "apps/node-backend/src/repositories/importBatchRepository.js", "apps/frontend/src/features/imports/TransactionImportCard.tsx", "apps/frontend/src/features/imports/RecipientsImportCard.tsx", "apps/frontend/src/features/imports/CategoriesImportCard.tsx", "apps/frontend/src/features/imports/ExportCard.tsx", "apps/frontend/src/features/imports/SupportedBanksCard.tsx", "apps/frontend/src/features/imports/useAdapters.ts", "apps/frontend/src/pages/ImportPage.tsx"]
---

# Feature: CSV Import & Deduplication

## Overview

Vision provides comprehensive CSV import capabilities with support for multiple bank formats, automatic deduplication, and category detection.

## Phase E — Frontend Component Decomposition (April 2026)

**Status:** Complete  
**Impact:** 1019-line `ImportPage.tsx` refactored into 6 self-contained feature components (~914 lines total, ~35 lines remaining in orchestrator)

### Component Breakdown

The monolithic `ImportPage.tsx` was decomposed into `apps/frontend/src/features/imports/`:

| Component | Lines | Responsibility |
|-----------|-------|-----------------|
| `TransactionImportCard.tsx` | 394 | CSV transaction import with SSE progress, column mapper, export buttons |
| `RecipientsImportCard.tsx` | 155 | Bulk recipients CSV import with file upload and status |
| `CategoriesImportCard.tsx` | 140 | Categories CSV import with category format validation |
| `ExportCard.tsx` | 159 | Dual export UI (CSV + JSON) with download triggers |
| `SupportedBanksCard.tsx` | 38 | Read-only chip list of supported bank adapters |
| `useAdapters.ts` | 28 | Shared hook for fetching bank adapters (prevents duplicate API calls) |

**Orchestrator**  
`apps/frontend/src/pages/ImportPage.tsx` (35 lines):
- Imports all sub-components
- Manages `historyKey` state (passed to `ImportHistoryCard` via `onImportSuccess` callback from `TransactionImportCard`)
- Renders layout with `PageHeader` and all cards

### Architecture Decisions

**Self-Contained State:**
- Each import card owns its own form state, upload progress, and error handling
- No prop-drilling; each card is independent except for shared hooks

**Shared Adapter Hook:**
- `useAdapters.ts` exported hook prevents duplicate API calls in both `TransactionImportCard` and `SupportedBanksCard`
- Both components call `useAdapters()` independently; hook deduplicates requests via React Query

**History Refresh Pattern:**
- `historyKey` state lives in `ImportPage` (only orchestrator needs it)
- `TransactionImportCard` calls `onImportSuccess()` callback after successful import
- Callback increments `historyKey`, forcing `ImportHistoryCard` to refetch history
- Avoids exposing `setHistoryKey` to child components

**Existing Imports:**
- `ImportHistoryCard` remains in `@/components/import/ImportHistoryCard` (not moved to features folder)
- Re-imported by `ImportPage` and composed alongside feature components

### Benefits

1. **Maintainability:** Each card is 30–400 lines with focused responsibility
2. **Reusability:** Components can be imported independently in other contexts
3. **Testability:** Each card can be tested in isolation without mocking the entire page
4. **Scalability:** New import card types can be added without growing page size

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

## Import Service Architecture (Phase C Refactor)

Phase C (April 2026) unified import processing into a **single orchestrator pipeline** that manages staging, validation, matching, and commit phases. The pipeline replaces the three separate services (`importService`, `streamingImportService`, `rawTransactionImportService`) with a modular, idempotent architecture.

### Import Pipeline Orchestrator
**File:** [[apps/node-backend/src/services/importPipeline/index.js]]

**Main export:** `runImportPipeline({ filePath, adapterName, customConfig?, filename?, sizeBytes?, onProgress? })`

Runs the full import pipeline end-to-end:

```
createBatch → stageBatch → validateBatch → matchBatch → commitBatch → scheduleRefresh
```

Each phase is idempotent at its boundary. On error, the batch is marked `failed` and the error is propagated. Progress callbacks are async and propagate SSE backpressure all the way into the batch loop.

**Return value:**
```typescript
{
  batchId: number,
  total: number,         // total rows parsed
  imported: number,      // rows committed
  duplicates: number,    // rows skipped (existing)
  errors: number         // rows failed during validation/commit
}
```

### Pipeline Phases

#### 1. **Staging** (`stageBatch`)
- Parse CSV via bank adapter (Belfius, Revolut, KBC, SABB, Wise, Vision, or custom)
- Store raw rows in `import_staging` table
- Emit progress events: `{ phase: 'staging', current, total }`

#### 2. **Validation** (`validateBatch`)
- Check required fields (date, recipient, amount)
- Parse amounts and dates to canonical form
- Detect deduplication hash collisions (if raw table exists for bank)
- Mark invalid rows with error details
- Emit progress events: `{ phase: 'validating', current, total, errors }`

#### 3. **Matching** (`matchBatch`)
- Look up or create recipients
- Look up or create categories (via recipient default or explicit mapping)
- Resolve recipient aliases
- Emit progress events: `{ phase: 'matching', current, total }`

#### 4. **Commit** (`commitBatch`)
- Insert canonical transactions
- Insert raw references (link transaction to raw bank data)
- Return final counts: `{ imported, duplicates, errors }`
- Emit progress events: `{ phase: 'committing', current, total, imported, duplicates, errors }`

#### 5. **Aggregation Refresh** (post-pipeline)
- Synchronously refresh materialized views (as of Phase 12 Bugfix Sweep)
- Awaits aggregation refresh before import response is sent
- Ensures `/api/aggregations/*` endpoints see new data immediately in the response
- Previously fire-and-forget; now blocking to guarantee consistency

### Legacy Services (Deprecated)

> [!warning] Deprecated
> The following services are no longer used by routes as of Phase C:
> - `importService.js`
> - `streamingImportService.js`
> - `rawTransactionImportService.js`
> 
> Routes now call `runImportPipeline()` directly. Legacy services remain in codebase for backwards compatibility but are not part of the active code path.

### Data Import Service (Recipients & Categories)
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

## Streaming Import with Server-Sent Events (SSE)

For large files, use streaming import with real-time progress:

```
POST /api/import/csv/stream
Content-Type: multipart/form-data

file: <CSV file>
bank_name: belfius
```

Returns Server-Sent Events with progress updates keyed on phase:

```
event: progress
data: {"phase":"staging","current":50,"total":150}

event: progress
data: {"phase":"validating","current":50,"total":150,"errors":0}

event: progress
data: {"phase":"matching","current":50,"total":150}

event: progress
data: {"phase":"committing","current":50,"total":150,"imported":48,"duplicates":2,"errors":0}

event: complete
data: {"batchId":42,"total":150,"imported":148,"duplicates":2,"errors":0}
```

### Backpressure & Resource Management (Phase C)

The streaming endpoint uses `createSseWriter(req, res)` ([[apps/node-backend/src/lib/sse.js]]) to propagate backpressure from the HTTP client into the import pipeline:

- **SSE Write Promises:** Progress callbacks in the pipeline are `async` and `await` the SSE writer's `write()` call
- **Drain Pausing:** When client consumes events slower than the server produces them, `drainIfNeeded()` pauses the write buffer, preventing unbounded memory growth in Node.js TCP buffers
- **Connection Monitoring:** Server detects client disconnection and stops processing to conserve resources
- **Error Handling (2026-04-26):** `emitProgress` callback errors are caught and logged via `logger.warn('onProgress callback failed', { error: err?.message })` instead of being silently swallowed, ensuring visibility into callback failures while not blocking the import pipeline

### Frontend SSE Integration

[[apps/frontend/src/lib/api.ts]] handles streaming:

- **Blank-line delimited:** Parses event blocks separated by blank lines
- **Multi-line data:** Supports `data:` fields spanning multiple lines
- **Defensive parsing:** Tolerates malformed/partial SSE payloads with sanitized fallback errors
- **Error propagation:** Explicit error handling without async Promise executor anti-pattern

### Error Handling

Import routes sanitize error details to prevent exposure of internal exception messages:

- JSON responses return generic `"Import failed"` message
- SSE error events also sanitized (see [[apps/node-backend/src/routes/importRoutes.js]])
- Batch status marked as `'failed'` with truncated error summary (2000 chars max) stored in database

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

## Testing References

### Phase C (April 2026)

- [[apps/node-backend/tests/routes/import.test.js]]: Updated to mock `runImportPipeline` from the new orchestrator. Covers SSE stream behavior, recipients/categories route handling, multer middleware error paths, and backpressure scenarios.
- Removed: `importService.test.js`, `streamingImportService.test.js`, `rawTransactionImportService.test.js` — superseded by pipeline integration tests.

### Phase 5A (April 2026)

- CSV column mapper integration in [[apps/frontend/src/hooks/useCsvPreview.ts]]
- Dual export (CSV + JSON) in [[apps/frontend/src/pages/ImportPage.tsx]]
- Streaming import progress tracking via SSE in [[apps/frontend/src/lib/api.ts]]

### Phase F (April 2026)

Admin observability for aggregation shadow divergences added. See [[docs/adr/016-aggregation-shadow-mode|ADR-016: Aggregation Shadow Mode]] for decision context and [[docs/api/admin|Admin API]] for monitoring endpoints.

Related testing docs: [[docs/testing/testing|Testing Documentation]], [[docs/testing/test-inventory|Test Inventory]].
