---
title: Bulk Transaction Actions
type: feature
status: active
date: 2026-05-08
tags: [feature, transactions, bulk, productivity]
description: Multi-row checkbox selection drives delete, recategorize, recipient reassignment, activate/deactivate, export, and tag operations across many transactions in one atomic call.
aliases: [bulk-actions, bulk-delete, bulk-update, bulk-export]
related_code:
  - "apps/node-backend/src/services/bulkSelection.js"
  - "apps/node-backend/src/services/transactionExport.js"
  - "apps/node-backend/src/routes/transactions.js"
  - "apps/frontend/src/features/transactions/components/bulk/BulkActionsBar.tsx"
  - "apps/frontend/src/features/transactions/components/bulk/BulkRecategorizeDialog.tsx"
  - "apps/frontend/src/features/transactions/components/bulk/BulkRecipientDialog.tsx"
  - "apps/frontend/src/features/transactions/components/bulk/BulkExportDialog.tsx"
  - "apps/frontend/src/features/transactions/components/bulk/BulkTagDialog.tsx"
  - "apps/frontend/src/hooks/useTransactions.ts"
  - "apps/frontend/src/lib/api/transactions.ts"
---

# Bulk Transaction Actions

> [!abstract] Overview
> The transactions list lets users select multiple rows (or every row matching the current filter) and apply a single action to the whole set in one atomic backend call: delete, recategorize, reassign recipient, activate/deactivate, export, or apply tags.

## Feature Overview

### User Story

> As a user, I want to select dozens of transactions and recategorize, deactivate, export, or delete them at once so I do not have to repeat the same edit row by row.

### Key Capabilities

- Checkbox column on every row plus a header "select all visible" tri-state checkbox
- Toolbar appears whenever ≥1 row is selected with an `Actions ▾` dropdown
- Confirmation modal before destructive ops (delete, deactivate)
- "Select all N matching filter" promotes an ids-mode selection to filter-mode so a single action can sweep the entire filtered cohort (capped at 5000 server-side)
- Atomic per-action calls: each bulk operation runs inside a single `withTransaction`
- Stats refresh once per successful call via `scheduleRefresh()`

## Architecture

### Selection model

| Mode | Wire shape | Cap | Source |
|------|-----------|-----|--------|
| `ids` | `{ ids: number[] }` | 500 | Explicit checkbox selection from the visible/loaded rows |
| `filter` | `{ filter: TransactionFilter }` | 5000 (matched count) | Promoted from ids-mode via "Select all N matching"; the filter mirrors the same fields the list endpoint accepts |

Resolver: [`apps/node-backend/src/services/bulkSelection.js`](apps/node-backend/src/services/bulkSelection.js) → `resolveBulkSelection({ ids, filter })`. Filter mode runs a `COUNT(*)` precheck and rejects when the match count exceeds `filterCap`.

### Backend

| File | Role |
|------|------|
| `apps/node-backend/src/services/bulkSelection.js` | Shared id/filter → ids resolver with caps |
| `apps/node-backend/src/services/transactionExport.js` | Streaming CSV / NDJSON pipeline shared with the GET export endpoints |
| `apps/node-backend/src/routes/transactions.js` | New POST routes: `/bulk-delete`, `/bulk-update`, `/bulk-export` |

Every write route runs inside `withTransaction(client => …)` and ends with `scheduleRefresh()` so materialized views catch up. `validateInt4Ids` strips invalid integers before any SQL touches the DB.

### Frontend

| File | Role |
|------|------|
| `apps/frontend/src/features/transactions/components/bulk/BulkActionsBar.tsx` | Self-contained toolbar: count label, `Actions ▾` dropdown, "Select all N matching" affordance, mounts every action dialog |
| `BulkRecategorizeDialog.tsx`, `BulkRecipientDialog.tsx`, `BulkExportDialog.tsx`, `BulkTagDialog.tsx` | Per-action input dialogs, each reusing the existing combobox primitives |
| `apps/frontend/src/hooks/useTransactions.ts` | New mutation hooks: `useBulkDeleteTransactions`, `useBulkUpdateTransactions`, `useBulkExportTransactions` |
| `apps/frontend/src/lib/api/transactions.ts` | Three new API client functions; `bulkExportTransactions` returns a `Blob` and the hook triggers a synthetic `<a download>` |
| `apps/frontend/src/pages/TransactionsPage.tsx` | Owns selection state and selection mode; clears selection whenever the current filter changes |

The bulk-tag toolbar that previously lived inline inside `TransactionsTable` is now folded into the same dropdown menu via `BulkTagDialog`. The existing `POST /api/transactions/bulk-tag` route is untouched.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/transactions/bulk-delete` | Hard-deletes a set of transactions selected by `ids` or `filter`. |
| `POST` | `/api/transactions/bulk-update` | Applies an update (`category_id` / `recipient_id` / `is_active`) to a set of transactions. FK targets are validated up front so the batch fails atomically on the first invalid reference. |
| `POST` | `/api/transactions/bulk-export` | Streams CSV (`format: 'csv'`) or NDJSON (`format: 'json'`) for the resolved selection. Reuses the same chunk SQL as the GET export endpoints. |
| `POST` | `/api/transactions/bulk-tag` | Existing — atomically adds/removes tags on `transaction_ids`. |

All four are rate-limited to 30 req/min per client, mirroring the existing bulk-tag route.

### Request body shape

```jsonc
// Selection (one of)
{ "ids": [1, 2, 3] }
{ "filter": { "search": "cafe", "start_date": "2026-01-01" } }

// bulk-update appends:
{ "fields": { "category_id": 7, "recipient_id": 99, "is_active": false } }

// bulk-export appends:
{ "format": "csv", "include_balance": false }
```

Filter shape mirrors the existing `GET /api/transactions` query fields (`transaction_id`, `start_date`, `end_date`, `bank_account`, `category_id(s)`, `recipient_id`, `recipient_group_id`, `recipient_name`, `search`, `active`, `transaction_type`, `tags`).

### Response shape

```jsonc
// bulk-delete
{ "deleted": 3 }

// bulk-update
{ "updated": 5 }

// bulk-export → streamed CSV/NDJSON body (no JSON envelope)
```

## Cascade Behaviour for Bulk Delete

`POST /bulk-delete` performs `DELETE FROM transactions WHERE id = ANY($1::int[])`. Foreign-key cascades cover dependent rows:

| Table | FK action |
|-------|-----------|
| `transaction_tags` | `ON DELETE CASCADE` |
| `transaction_splits` | `ON DELETE CASCADE` |
| `attachments` | `ON DELETE CASCADE` |
| `executed_planned_transactions` | `ON DELETE CASCADE` |
| `raw_transactions` | `ON DELETE SET NULL` |
| `import_batches` | `ON DELETE SET NULL` |

No orphan rows remain after a successful bulk delete.

## Bulk Update Validation Rules

- Body must include a non-empty `fields` object with at least one of `category_id`, `recipient_id`, `is_active`.
- `category_id` accepts a positive integer or `null` (uncategorize).
- `recipient_id` requires a positive integer (`recipient_id` is `NOT NULL` on the column).
- `is_active` requires a boolean.
- FK existence is verified before the resolver counts selection rows so the call cheaply fails on bad references.

## Filter-mode Selection Flow

1. User toggles "select all visible" in the table header → `selectedIds = Set(visibleIds)`.
2. If `totalMatching > visibleItemCount`, the bar surfaces `Select all {n} matching filter`.
3. Clicking promotes `selectionMode = 'filter'`. The id list is no longer authoritative; the request body becomes `{ filter, fields|format }`.
4. Backend `resolveBulkSelection({ filter })` runs a `COUNT(*)` and rejects with `ValidationError` if the matched row count exceeds 5 000.

## Test Coverage

| Layer | File | Scope |
|-------|------|-------|
| Service unit | `apps/node-backend/tests/services/bulkSelection.test.js` | Resolver caps, both/neither rejection, filter-mode count enforcement |
| Route | `apps/node-backend/tests/routes/transactionsBulkDelete.test.js` | Validation, id-mode + filter-mode, atomicity rollback |
| Route | `apps/node-backend/tests/routes/transactionsBulkUpdate.test.js` | Field validation, FK pre-checks, multi-field SET clause, atomicity |
| Route | `apps/node-backend/tests/routes/transactionsBulkExport.test.js` | Format gating, CSV header + row, NDJSON line shape, filter cap |
| Frontend hooks | `apps/frontend/src/hooks/__tests__/useBulkTransactions.test.tsx` | Mutation success + error paths for delete / update / export |

## Related

- [[docs/features/transactions|Transactions]]
- [[docs/features/tags|Tags]] — `bulk-tag` shares the same toolbar and atomicity pattern
- [[docs/reference/api-endpoint-matrix|API endpoint matrix]]
