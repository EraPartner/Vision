---
title: Feature - CSV Import, Export, Attachments & Deduplication
type: feature
status: active
date: 2026-04-24
updated: 2026-08-10
last_modified: 2026-08-10
tags: [feature, import, export, csv, json, deduplication, phase-5a, attachments, phase-c, phase-e, phase-1, phase-12, phase-13, performance, concurrency, import-pipeline, component-split, error-handling, recipient-clusters, multi-select, export-filters, adr-046, category-review, bigserial-fix, staging-rows, tx-hash-dedup, race-safe-dedup, decimal-precision, ing, bnp, saved-custom-parsers, custom-parser-configs, named-parsers, adr-066, electron-native, csv-open-with, import-handoff, drag-drop, june-2026, file-headers-panel, csv-separator, adr-078, auto-link, planned-match, account-disclosure, wp-b6, july-2026]
aliases: [csv-import, bank-import, bank-statement, deduplication, data-import, streaming-import]
description: Import transactions from bank CSV files with automatic deduplication, fuzzy/pattern recipient matching, per-row category review (ADR-046), May 2026 BIGSERIAL fix for staging row ID validation, saved named custom CSV parsers (ADR-066), June 2026 V12 (ADR-072) window-wide CSV drag-drop + Finder/dock open-with handoff, and June 2026 always-on FileHeadersPanel (header chip preview + sample-rows table shown for all adapters in TransactionImportCard).
related_code: ["apps/node-backend/src/services/importPipeline/index.js", "apps/node-backend/src/services/importPipeline/stage.js", "apps/node-backend/src/services/importPipeline/validate.js", "apps/node-backend/src/services/importPipeline/match.js", "apps/node-backend/src/services/importPipeline/commit.js", "apps/node-backend/src/services/dataImportService.js", "apps/node-backend/src/services/deduplication.js", "apps/node-backend/src/services/textNormalization.js", "apps/node-backend/src/routes/importRoutes.js", "apps/node-backend/src/lib/sse.js", "apps/node-backend/src/repositories/importBatchRepository.js", "apps/node-backend/src/repositories/customParserConfigRepository.js", "apps/frontend/src/features/imports/TransactionImportCard.tsx", "apps/frontend/src/features/imports/FileHeadersPanel.tsx", "apps/frontend/src/features/imports/RecipientsImportCard.tsx", "apps/frontend/src/features/imports/CategoriesImportCard.tsx", "apps/frontend/src/features/imports/ExportCard.tsx", "apps/frontend/src/features/imports/SupportedBanksCard.tsx", "apps/frontend/src/features/imports/useAdapters.ts", "apps/frontend/src/hooks/useCustomParserConfigs.ts", "apps/frontend/src/lib/importHandoff.ts", "apps/frontend/src/lib/csvSeparator.ts", "apps/frontend/src/pages/ImportPage.tsx", "apps/frontend/src/pages/ImportReviewPage.tsx"]
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
| `ExportCard.tsx` | 159 | Dual export UI (CSV + JSON) with multi-select filter pickers (Phase 13) |
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

**Existing Imports (June 2026 update):**
- `ImportHistoryCard` and `CsvColumnMapper` have been moved from `@/components/import/` to `apps/frontend/src/features/imports/` to co-locate all import-related UI within the feature module.
- `ImportPage` imports both from `@/features/imports/`.
- `components/import/` no longer exists as a source directory.

### Benefits

1. **Maintainability:** Each card is 30–400 lines with focused responsibility
2. **Reusability:** Components can be imported independently in other contexts
3. **Testability:** Each card can be tested in isolation without mocking the entire page
4. **Scalability:** New import card types can be added without growing page size

## Electron CSV Import Handoff (V12, June 2026 — ADR-072)

> [!info] Added in ADR-072
> Two new paths for opening a CSV file directly from the OS into the import UI without requiring the user to navigate to `/import` first.

### Path 1 — Window-Wide Drag-and-Drop (renderer)

`ElectronBridge` (`apps/frontend/src/components/layout/ElectronBridge.tsx`) attaches a `dragover`/`drop` listener to `window`. Any file dropped anywhere on the application window is intercepted:

- **Non-CSV files** are silently discarded.
- **CSV files** are read as text via the `File` API (no filesystem permission required in the sandboxed renderer) and pushed into `lib/importHandoff.ts`. The app then navigates to `/import`.
- **`[data-dropzone]` ancestors** are exempted: the in-card dropzone on `TransactionImportCard` has `data-dropzone` on its root element, so drops inside the card still reach the card's own handler normally.
- This also closes the Chromium default behavior of *navigating to* a dropped file, which would have produced a blank page.

### Path 2 — Finder "Open With" / Dock Drop (main process)

When the OS fires `app.on('open-file')` (macOS Finder "Open With" or dock drop):

1. Main process validates the file extension (`.csv` only) and size (≤ 25 MB).
2. Main reads the file itself — the renderer is sandboxed and **never receives the filesystem path**.
3. Main forwards `{name: string, content: string}` over IPC channel `app:csv-opened`.
4. `ElectronBridge` receives the payload, reconstructs a `File` object, and pushes it into `lib/importHandoff.ts`. The app navigates to `/import`.

### `lib/importHandoff.ts` — One-Slot TTL Registry

**File:** `apps/frontend/src/lib/importHandoff.ts`

Provides two functions:

| Function | Description |
|----------|-------------|
| `registerPendingImportFile(file: File)` | Stores the file in a module-level slot with a 30-second TTL. Overwrites any previous pending slot. |
| `consumePendingImportFile(): File \| undefined` | Returns and clears the pending slot. Returns `undefined` if empty or expired. |

Pattern mirrors `lib/undo.ts` (same one-slot, TTL design). `TransactionImportCard` calls `consumePendingImportFile()` on mount; if a slot is waiting, the card pre-fills its dropzone with that file and begins the import flow automatically.

The 30-second TTL prevents a stale file from being auto-applied if the user navigates to `/import` later for a different reason.

### `data-dropzone` Convention

The root element of the dropzone region in `TransactionImportCard` carries the attribute `data-dropzone`. `ElectronBridge`'s window-level drop handler walks `event.target` ancestors and skips interception when a `[data-dropzone]` ancestor is found, so in-card drops are not double-handled.

---

## Recipient Match Patterns and Cluster Analysis

After merging recipients via the `POST /api/recipients/:id/merge` endpoint, the frontend may receive a `patternSuggestion` in the response. This suggestion identifies common prefixes and categorization patterns among related recipients.

### Pattern Suggestion Toast (Frontend)

When a merge response includes a `patternSuggestion`, the `useMergeRecipients` hook displays a second toast notification (duration 10 seconds with action button):
- **Title:** `recipients.createRuleSuggestion` (i18n key)
- **Action Button:** `recipients.createRule` (i18n key)
- **Purpose:** Suggest pattern-based rules for automating future merges

### Recipient Clusters Endpoint

**Route:** `GET /api/recipients/clusters` (Phase H — April 2026)  
**Backend Service:** [[apps/node-backend/src/services/recipientClusterService.js]]

Analyzes active primary recipients and identifies clusters with:
- Longest common prefix (LCP) of 8+ characters
- Shared or similar categories
- Confidence scoring (0.0–1.0)
- Suggested pattern kind (`"prefix"` for `LCCPREFIX%` matching)

**Response Example:**
```json
{
  "items": [
    {
      "lcp": "SUPER",
      "confidence": 0.95,
      "recipientIds": [1, 5, 7],
      "recipientNames": ["Supermarket ABC", "Supermarket XYZ", "Super Convenience"],
      "categoryId": 5,
      "suggestedPattern": "super%",
      "suggestedKind": "prefix"
    }
  ],
  "total": 1
}
```

### Use Cases

1. **Post-Merge Suggestion:** After manually merging two similar recipients, the frontend offers to create a reusable pattern rule
2. **Bulk Cleanup:** Shows a "Cleanup Card" that lists all identified clusters, allowing batch rule creation
3. **Conflict Prevention:** Rules prevent future mistaken splits by auto-merging lookalike recipients

## Supported Banks

### Pre-configured Bank Adapters

**9 Supported Banks (May 2026):**

| Bank | Format | Columns | Detection |
|------|--------|---------|-----------|
| Belfius | Belgian format, semicolon-delimited | Date, amount, recipient, balance | `Rekeningnummer` + `Boekingsdatum` |
| Revolut | Multi-currency, ISO 8601 dates | Completed date, amount, fee, currency | `Completed Date` + `Currency` |
| ING | Dutch-language export, semicolon-delimited | Booking date, counterparty IBAN, description | `Omzetnummer` + `Detail van de omzet` |
| KBC | Belgian corporate, semicolon-delimited | Counterparty, structured communication | `Rekeningnummer` + `Datum` |
| BNP Paribas Fortis | Dutch-language export, semicolon-delimited | Sequence, execution date, transaction type, counterparty | `Volgnummer` + `Uitvoeringsdatum` + `Valuta rekening` |
| SABB | Belgian bank format, semicolon-delimited | Posting date, description, amount | `Rekeningnummer` + `Datum` |
| Wise | Multi-currency transfers, ISO 8601 | Finished date, exchange rate, fee | `Finished On` + `Currency` |
| Vision | Internal format | Standard transaction fields | Explicit selection |
| Custom | User-defined via mapper | Configurable column mapping | Manual column picker |

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
- Store parsed rows in the `import_staging_rows` table (the original CSV line is retained in the
  `raw_data` column)
- Emit progress events: `{ phase: 'staging', current, total }`

#### 2. **Validation** (`validateBatch`)
- Check required fields (date, recipient, amount)
- Parse amounts and dates to canonical form
- Compute each row's `tx_hash` and flag rows whose hash already exists in the canonical
  `transactions` table or collides with an earlier row in the same batch (see *Deduplication* below;
  there are no per-bank raw tables in this path)
- Mark invalid rows with error details
- Emit progress events: `{ phase: 'validating', current, total, errors }`

#### 3. **Matching** (`matchBatch`)
- Look up or create recipients
- Look up or create categories (via recipient default or explicit mapping)
- Resolve recipient aliases
- **Unresolved rows stay `'matched'` (2026-08-09):** a row whose `recipient_raw` is blank or unnormalizable gets `status='matched'` with a NULL `resolved_recipient_id` — deliberately, because `'matched'` is the only staging status the review preview (`getPreviewRows`) and the recipient/category override endpoints accept, so it is what keeps the row visible and fixable on `ImportReviewPage`. `prepareImport` forces `awaiting_review` whenever `unresolved > 0`; commit decides any row still lacking a recipient into `'error'` (see phase 4).
- Emit progress events: `{ phase: 'matching', current, total }`

#### 4. **Commit** (`commitBatch`)
- Insert canonical transactions with per-row SAVEPOINT protection (if insert fails, transaction stays usable for remaining rows)
- **BIGSERIAL Validation (2026-05-12):** [[apps/node-backend/src/services/importPipeline/commit.js]] (lines 101–105) validates staging row IDs via regex `/^\d+$/` instead of `Number.isInteger()`. Root cause: `import_staging_rows.id` is BIGSERIAL; the `pg` driver returns BIGINT values as strings to preserve int64 precision. The old `Number.isInteger("123")` check failed silently, counting all rows as errors before any INSERT. New regex accepts string-form bigints and is injection-safe for SAVEPOINT identifiers.
- **Transaction Hash Deduplication (2026-05-14):** Transaction INSERT statements now include a `tx_hash` column and use `ON CONFLICT (tx_hash) WHERE tx_hash IS NOT NULL DO NOTHING RETURNING id` for race-safe deduplication. The `tx_hash` is computed from `date|amount|recipient|memo|bank_account` and stored in the canonical `transactions` table (via migration [[alembic/versions/0036_add_transactions_tx_hash.py]]). Intra-batch deduplication tracks committed hashes in a Set; a second row with an identical `tx_hash` in the same batch is marked `duplicate`.
- Errors are captured and logged per row (the current pipeline does **not** write per-bank raw
  tables — the original CSV line stays in `import_staging_rows.raw_data`)
- **Unresolved-recipient decision (2026-08-09):** before any chunk is planned, `commitBatch` marks every drained row whose effective recipient (`user_override_recipient_id ?? resolved_recipient_id`) is missing as `status='error'` with `error_message` `"unresolved recipient — no recipient was matched or assigned in review"`, and counts it into `rows_error`. Previously such rows were attempted against `transactions.recipient_id NOT NULL`, surfacing as a 23502 constraint error — and, post-batching (#142), demoting the row's whole chunk from the bulk-INSERT path to the per-row replay.
- Return final counts: `{ imported, duplicates, errors }`
- Emit progress events: `{ phase: 'committing', current, total, imported, duplicates, errors }`
- **Post-commit navigation (Aug 2026):** on success, `ImportReviewPage` navigates to `/import` with `{ replace: true }` instead of a normal push — the reviewed batch is consumed, so Back now skips the review URL entirely rather than re-inviting a commit of an already-committed batch. Same fix applied to `PortfolioImportReviewPage` → `/portfolio` (see [[docs/features/portfolio-import#5-commit|Portfolio CSV Import: Commit]]).

#### 5. **Aggregation Refresh** (post-pipeline)
- Synchronously refresh materialized views (as of Phase 12 Bugfix Sweep)
- Awaits aggregation refresh before import response is sent
- Ensures `/api/aggregations/*` endpoints see new data immediately in the response
- Previously fire-and-forget; now blocking to guarantee consistency

#### 6. **Auto-Link Planned Payments** (post-commit, June 2026)

After committed rows are inserted and aggregations refreshed, `commit.js` calls `autoLinkTransactions(insertedRows)` from [[apps/node-backend/src/services/plannedMatchService.js]]:

- Runs only when `app_settings.autoClearPlannedOnMatch` is `true` (default).
- Checks each newly committed transaction against active, unexecuted planned payments using the moderate tolerance rule (same recipient cluster, same sign, ±5 % amount, ±5 calendar days). See [[docs/features/plannedTransactions#auto-link--auto-clear-on-ingest-june-2026|Auto-Link on Ingest]] for the full matching spec.
- **Never fails the import**: any error in the auto-link step is caught and logged; the import result is still returned as successful.
- **Mutually-unambiguous rule**: if two imported rows match the same planned payment, or one row matches two planned payments, neither is auto-linked.
- The commit result and the upload summary both include `auto_linked_count` (integer, 0 when none matched or when the setting is off).
- `ImportReviewPage` shows a toast when `auto_linked_count > 0` (i18n key `importReview.toast.autoLinked`) and invalidates the `["plannedMatchSuggestions"]` React Query cache so the suggestions banner on `PlannedPaymentsPage` refreshes.

### Legacy Services (Removed)

> [!warning] Deleted (2026-05-29)
> The following services were removed from the codebase (zero importers after Phase C consolidation):
> - `streamingImportService.js` — deleted
> - `rawTransactionImportService.js` — deleted
>
> `importService.js` was superseded by routes calling `runImportPipeline()` directly.

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

**Memo inclusion (2026-04-28):** All deduplication checks now include trimmed `memo` field:
- `isDuplicate()` — Hash-based check includes memo
- `isDuplicateByFields()` — Field-based check includes memo
- `isManualDuplicate()` — Field-fallback path includes `COALESCE(TRIM(memo), '')` matching
- **Impact:** Two same-day same-amount same-recipient purchases with different memos are no longer falsely deduped. Example: "SUPERMARKET ABC" on 2026-04-28 for €50 + memo "Groceries" vs. the same transaction with memo "Household" are now distinct.
- **Database:** Per-row dedup query in `services/importPipeline/commit.js` updated to match memo via `COALESCE(TRIM(t.memo), '')` against `(row.memo ?? '').trim()`

---

## Import Process

### 1. File Upload
- Maximum file size: 50MB
- Supported format: CSV
- Encoding: UTF-8 (configurable)

### 2. Parsing & Normalization
- CSV parsed with configurable separator
- **UTF-8 BOM stripping (Bug-Hunt Sweep 2026-05-08):** `splitCsvLines()` in [[apps/node-backend/src/services/importPipeline/adapters/_shared.js]] strips the UTF-8 BOM character (U+FEFF) that Excel and Windows tools prepend to CSV exports. Without stripping, the first header field becomes `﻿field_name` (invalid key), breaking the column mapping. Implementation: Regex `^﻿` applied before line split.
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

### 4. Category Detection (ADR-046)
- At review time, each group surfaces its `recipient_default_category_id` plus any per-row `override_category_id`.
- The user can change the category in the review accordion. Changes apply to all rows in the group via `POST /api/import/batches/:id/rows/:rowId/category-override`.
- **Recipient picker as `trailing` (Aug 2026):** the per-group recipient-override combobox on the review accordion is a real `<button>`-based combobox, so it renders via `AccordionTrigger`'s `trailing` prop — a sibling of the trigger button — rather than nested inside it with a `stopPropagation()` click guard (invalid HTML previously; unreachable for assistive tech). Its accessible name is `t('importReview.recipientPickerLabel', { name })`. See [[docs/components/ui-components#trailing--headerclassname-props-aug-2026|UI Components: Accordion trailing]].
- A "Save as recipient default" checkbox (defaults `true` when the recipient has no current default) persists the chosen category to `recipients.default_category_id` via `PATCH /api/recipients/:id`.
- At commit, the category written into `transactions.category_id` is `COALESCE(staging.override_category_id, recipient.default_category_id, NULL)`.
- The runtime fallback `COALESCE(t.category_id, r.default_category_id)` in `transactionRepository` is preserved for backwards compatibility with rows committed before ADR-046 (which carry `category_id = NULL`).
- See [[docs/adr/046-import-review-category-assignment|ADR-046]] for full decision context.

### Account Disclosure (WP-B6, July 2026)

The review page (`ImportReviewPage`) discloses, before commit, which accounts the batch will write to:

- The preview endpoint (`GET /api/import/batches/:id/preview`) now returns each staged row's `bank_account` label (the account label parsed from the CSV; already stored by `stage.js`, previously not exposed).
- The page groups staged rows by that label and renders a per-account summary line — "{n} transactions → **{account}**" — near the match-source totals. Rows without a label are bucketed under a muted "unspecified account" line.
- Each distinct label is cross-referenced against the existing accounts list (`GET /api/accounts?active=all`) under the D1 normalized identity (`lower(btrim(name))`). A label matching no existing account gets a "new account will be created" badge — committing such rows auto-creates the account via the DB trigger from migration `0056`.
- **Read-only**: the disclosure has no account override/picker; it only states where the batch will land.
- **Post-commit nudge**: when the committed batch created ≥1 new account, a follow-up success toast ("This import created {n} new account(s)") carries a "Review accounts" action that navigates to the accounts hub (`/accounts`) so the user can classify/name the new accounts. Account-derived query caches are invalidated so the hub shows them immediately.
- i18n keys: `importReview.accounts.*` (line, newBadge, unspecified) and `importReview.toast.newAccounts` / `importReview.toast.reviewAccounts` (en + nl).

### 5. Transaction Creation
- Creates transactions in main table
- Links to raw source for audit trail
- **Phase 0+**: Triggers fire-and-forget materialized view refresh (post-commit) to keep aggregations warm

## Deduplication Strategies

### Transaction Hash (Canonical Table, May 2026)

As of 2026-05-14, all transactions are deduplicated via a `tx_hash` column in the canonical `transactions` table:

```sql
ALTER TABLE transactions ADD COLUMN tx_hash TEXT;
CREATE UNIQUE INDEX uq_transactions_tx_hash 
  ON transactions (tx_hash) WHERE tx_hash IS NOT NULL;
```

**Hash computation:** SHA-256 of `date|amount|recipient|memo|bank_account` (same as legacy bank-specific dedup).

**Conflict handling:**
- `INSERT ... ON CONFLICT (tx_hash) WHERE tx_hash IS NOT NULL DO NOTHING RETURNING id` (race-safe)
- If insert fails with UNIQUE violation, the existing transaction's `id` is returned (idempotent)
- Enables safe concurrent imports without cross-import duplicate checking

### Bank-Specific Raw Table Hashes (Legacy — write-orphaned)

The per-bank `*_raw_transactions` tables each carry a `deduplication_hash` column and historically
provided bank-specific duplicate detection:
- `belfius_raw_transactions.deduplication_hash`
- `revolut_raw_transactions.deduplication_hash`
- `kbc_raw_transactions.deduplication_hash`
- `sabb_raw_transactions.deduplication_hash`
- `wise_raw_transactions.deduplication_hash`
- `vision_raw_transactions.deduplication_hash`
- `manual_raw_transactions.deduplication_hash`

> [!warning] These tables are no longer written by the import pipeline
> The current pipeline stages into `import_staging_rows` and dedups via the canonical
> `transactions.tx_hash` (above); it never inserts into the `*_raw_transactions` tables. Their
> repository (`repositories/rawTransactionRepository.js`) has **zero importers** in `src/`, and only
> historical rows remain in the tables that still exist. `custom_raw_transactions` was dropped by
> migration `0008_drop_custom_raw_transactions.py`.

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

## Saved Named Custom CSV Parsers (ADR-066)

**Status:** Complete (June 2026)

Users can now save a custom CSV column-mapping configuration under a unique name and reuse it across import sessions without re-entering the column mapping each time. Saved parsers appear in the bank-source dropdown alongside pre-configured bank adapters, marked with a Bookmark icon.

### Database Storage

Saved parsers are persisted in the `custom_parser_configs` table (migration `0037_add_custom_parser_configs`):

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PK | |
| `name` | TEXT NOT NULL | Unique (index `uq_custom_parser_configs_name`); also used as `bank_account` label on imported transactions |
| `config_json` | JSONB NOT NULL | Column mapping: `{ dateColumn, dateFormat, recipientColumn, amountColumn, memoColumn, separator, encoding, skipRows }` |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | Maintained by the shared `update_updated_at_column()` trigger |

**Repository**: [[apps/node-backend/src/repositories/customParserConfigRepository.js]] — `getAll`, `getById`, `getByName`, `create`, `update`, `delete`; maps `config_json` → `config` for callers.

**Backup**: `custom_parser_configs` is registered in `apps/node-backend/src/backup/coverage.js` and travels with `.visionbak` exports.

### CRUD Endpoints

Four new endpoints under `/api/import/parsers` (see [[docs/api/imports|Imports API]] for full contracts):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/import/parsers` | List all saved parsers |
| POST | `/api/import/parsers` | Create; 409 on duplicate name; 400 if required columns missing |
| PATCH | `/api/import/parsers/:id` | Update name and/or config; 404 if missing; 409 on name conflict |
| DELETE | `/api/import/parsers/:id` | Delete; 204 on success; 404 if missing |

### Parser Name as Bank/Account Label

The name the user assigns (e.g. `"My Savings Bank"`) is used as `adapterName` in the import pipeline. It is stored as the `bank_account` field on every imported transaction, providing the same stable label that a pre-configured adapter (e.g. `"belfius"`) provides. This ensures consistent grouping in Analytics, filters, and exports.

> [!warning] Rename impact
> Renaming a saved parser via PATCH does not retroactively update `bank_account` on existing transactions. Users who rename a parser will see a split in bank-account groupings between old and new imports.

### Frontend UX

- **Dropdown**: Saved parsers appear in the bank-source dropdown with a Bookmark icon; selecting one loads its config automatically.
- **Read-only summary**: Shows the loaded parser's name and config with Edit and "Delete this parser" (confirmation dialog) buttons.
- **Create**: In custom-config mode a name field and "Save parser" button create a new saved parser.
- **Edit**: Editing a saved parser shows "Save changes" / "Cancel".
- **Hook**: [[apps/frontend/src/hooks/useCustomParserConfigs.ts]] — React Query list + mutations under cache key `['custom-parser-configs']`.
- **API client**: [[apps/frontend/src/lib/api/imports.ts]] — `listCustomParserConfigs`, `createCustomParserConfig`, `updateCustomParserConfig`, `deleteCustomParserConfig`; types `SavedParserConfig`, `CustomParserConfigPayload`.
- **i18n**: `importPage.customParser.*` keys added to `en.json` / `nl.json`.

### `stageBatch` Generic-Adapter Fallback (Latent Bug Fix)

`apps/node-backend/src/services/importPipeline/stage.js` previously threw `Unknown adapter` when `adapterName` was not in the static adapter registry, even when a `customConfig` was present. The fix mirrors `createAdapter()` in `adapters/index.js`: if `getAdapter(adapterName)` returns `null` and `customConfig` is present, fall back to the `generic` adapter. Callers with an unrecognised name but no `customConfig` still receive the error (intentional — a missing mapping is a programming error).

This fix applies to all callers, not only the saved-parser path, and closes a latent failure mode for any typed free-form bank name passed with a custom config.

See [[docs/adr/066-saved-named-custom-csv-parsers|ADR-066]] for full decision context.

---

## Custom CSV Configuration (Ad-hoc, Non-Saved)

For a one-off import from an unsupported bank without saving the configuration:

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
- **Component**: [[apps/frontend/src/features/imports/CsvColumnMapper.tsx]] — UI for dropdown mapping and preview display (moved from `components/import/` in June 2026)
- **Integration**: Replaces 4 inline text inputs in [[apps/frontend/src/pages/ImportPage.tsx]]; separator field moved above mapper
- **i18n**: New keys: `csvParsing`, `csvParseError`, `csvPreviewTitle`, `noMapping` (en + nl translations)

### Usage
1. Select CSV file or drag-and-drop
2. Choose separator (auto-detected by default)
3. Preview table shows detected headers and sample data
4. Map each required field using dropdown
5. Click import when ready

## File Headers Preview Panel (June 2026) {#file-headers-preview-panel}

**Component:** [[apps/frontend/src/features/imports/FileHeadersPanel.tsx]]  
**Helper:** [[apps/frontend/src/lib/csvSeparator.ts]] — `detectSeparator(rawText: string): string`

The `FileHeadersPanel` is a shared component that renders a column-name chip row and a collapsible sample-rows table as soon as a file is selected, regardless of which bank adapter is chosen. It is independent of the column-mapper UI and appears under the dropzone in both the budgeting and portfolio import paths.

### Behaviour

- **Triggers on file selection**: The panel renders immediately when the user selects (or drops) a CSV file, before any import action.
- **Separator auto-detection**: `detectSeparator` scans the first line of the raw file text for common delimiters (`;`, `,`, `\t`) and picks the one that produces the most fields. Falls back to `,`.
- **Header chips**: Each detected column name is shown as a chip. Non-CSV files produce no chips (graceful degradation).
- **Sample rows table**: Up to 5 data rows displayed in a collapsible `<details>` element, matching the column order from the header chip row.
- **Built on `useCsvPreview`**: Reuses the existing hook ([[apps/frontend/src/hooks/useCsvPreview.ts]]) — no new CSV-parsing logic.

### Retrofit into TransactionImportCard

Before this change, column-name previews appeared only in the custom-parser path (inside `CsvColumnMapper`). The `FileHeadersPanel` is now placed under the dropzone in [[apps/frontend/src/features/imports/TransactionImportCard.tsx]], so all adapter imports (Belfius, Revolut, ING, KBC, BNP, SABB, Wise, Vision, Custom) show a header preview as soon as a file is chosen.

### i18n

New `csvHeaders.*` keys added to `i18n/source/en.json` and `i18n/source/nl.json`.

### Also used in Portfolio Import

`PortfolioCsvColumnMapper` embeds the same `FileHeadersPanel`. See [[docs/features/portfolio-import#fileheaderspanel-integration|Portfolio Import — FileHeadersPanel Integration]].

---

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
data: {"batchId":42,"total_processed":150,"imported":148,"duplicates":2,"errors":0}
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
- Download helper: [[apps/frontend/src/lib/downloadBlob.ts]] (shared utility centralizing createObjectURL → anchor.click → revokeObjectURL pattern, used by `ExportCard` and `OwesPage`)

## Multi-Select Export Filters (Phase 13)

**Status:** Complete (April 2026)

The `ExportCard` component now provides multi-select pickers for bank accounts and categories, enabling bulk export filtering without manual comma-separated input.

### Frontend Components

#### CategoryMultiCombobox
**Path:** `[[apps/frontend/src/components/shared/CategoryMultiCombobox.tsx]]`

- **Purpose:** Select multiple categories for export filtering
- **Display:** "{n} categories" when multiple selected, "All categories" when none
- **Integration:** Replaces raw text input in `ExportCard`

#### BankAccountMultiCombobox
**Path:** `[[apps/frontend/src/components/shared/BankAccountMultiCombobox.tsx]]`

- **Purpose:** Select multiple bank accounts (real IBANs) for export filtering
- **Data source:** `useBankAccounts` hook (calls `GET /api/info/banks`)
- **Display:** "{n} accounts" when multiple selected, "All accounts" when none
- **Note:** Returns real bank account IBANs, not legacy adapter keys

#### useBankAccounts Hook
**Path:** `[[apps/frontend/src/hooks/useBankAccounts.ts]]`

- **Purpose:** React Query hook wrapping `apiClient.getDistinctBankAccounts()`
- **Cache:** 2-minute staleTime
- **Deduplication:** Shared across BankAccountMultiCombobox usage sites

### Backend Filter Building

#### buildExportFilters
**File:** `[[apps/node-backend/src/routes/transactions.js]]`

- **Purpose:** Construct precise SQL filters for `bank_accounts` and `category_ids` query params
- **Precedence:** Plural params (`bank_accounts`, `category_ids`) take precedence over singular params (`bank_account`, `category_id`)
- **Parsing:** Comma-separated values trimmed for whitespace
- **Capping:** Both filters capped at 50 entries; excess silently ignored
- **Validation:** `category_ids` throws `ValidationError` if any value is not an integer

#### filterBuilder.buildTransactionWhere
**File:** `[[apps/node-backend/src/services/filterBuilder.js]]`

- **Purpose:** Build WHERE clause for transaction queries
- **Support:** Now accepts `bankAccounts` (plural, exact IN clause) and `categoryIds` (plural, IN clause)
- **Precedence:** `bankAccount` (singular ILIKE) still takes precedence when set, but plural `bankAccounts` is preferred by routes
- **Whitespace handling:** Bank account IBANs trimmed; blank entries filtered out

### Query Parameter Contracts

#### CSV Export
```
GET /api/transactions/export/csv?bank_accounts=BE12...,BE34...&category_ids=5,7,12
```

#### JSON Export
```
GET /api/transactions/export/json?bank_accounts=BE12...,BE34...&category_ids=5,7,12
```

Both endpoints use `buildExportFilters()` to convert comma-separated strings into precise SQL IN clauses.

### i18n Keys
New keys added in Phase 13:
- `combobox.bankAccount.label` - "Bank Account"
- `combobox.bankAccount.placeholder` - "Select account..."
- `combobox.bankAccount.searchPlaceholder` - "Search accounts..."
- `combobox.bankAccount.empty` - "No accounts found"
- `combobox.categoryMulti.label` - "Categories"
- `combobox.categoryMulti.placeholder` - "Select categories..."
- `combobox.categoryMulti.searchPlaceholder` - "Search categories..."
- `importPage.bankAccounts` - "Bank Accounts"
- `importPage.categories` - "Categories"

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
- [[docs/adr/066-saved-named-custom-csv-parsers|ADR-066: Saved Named Custom CSV Parsers]]
- [[docs/adr/046-import-review-category-assignment|ADR-046: Import Review Category Assignment]]

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
