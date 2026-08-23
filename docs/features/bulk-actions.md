---
title: Bulk Transaction Actions
type: feature
status: active
date: 2026-05-08
updated: 2026-08-23
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
| `filter` | `{ filter: BulkTransactionFilter }` | 5000 (matched count) | Promoted from ids-mode via "Select all N matching"; the filter mirrors a subset of the list endpoint's fields, and every field is validated (see [Request body shape](#request-body-shape)) |

Resolver: [`apps/node-backend/src/services/bulkSelection.js`](apps/node-backend/src/services/bulkSelection.js) → `resolveBulkSelection({ ids, filter })`. Filter mode runs a `COUNT(*)` precheck and rejects when the match count exceeds `filterCap`.

### Backend

| File | Role |
|------|------|
| `apps/node-backend/src/services/bulkSelection.js` | Shared id/filter → ids resolver with caps |
| `apps/node-backend/src/services/transactionExport.js` | Streaming CSV / NDJSON pipeline shared with the GET export endpoints |
| `apps/node-backend/src/routes/transactions.js` | New POST routes: `/bulk-delete`, `/bulk-update`, `/bulk-export` |

Every write route runs inside `withTransaction(client => …)` and ends with `scheduleRefresh()` so materialized views catch up. `validateInt4Ids` validates every id before any SQL touches the DB — a malformed entry **rejects the whole request** (400) rather than being dropped from the batch, so a bulk action never silently operates on a subset of what the caller named. `normalizeBulkFilter` applies the same rule to the `filter` path: an unknown key or a malformed field rejects rather than being skipped, so a bulk action never silently operates on a *wider* set than the caller named either. A well-formed id whose row no longer exists is *not* malformed: it passes validation and simply matches no rows, so a stale selection still succeeds.

### Frontend

| File | Role |
|------|------|
| `apps/frontend/src/features/transactions/components/bulk/BulkActionsBar.tsx` | Self-contained toolbar: count label, `Actions ▾` dropdown, "Select all N matching" affordance, mounts every action dialog |
| `BulkRecategorizeDialog.tsx`, `BulkRecipientDialog.tsx`, `BulkExportDialog.tsx`, `BulkTagDialog.tsx` | Per-action input dialogs, each reusing the existing combobox primitives |
| `apps/frontend/src/hooks/useTransactions.ts` | New mutation hooks: `useBulkDeleteTransactions`, `useBulkUpdateTransactions`, `useBulkExportTransactions` |
| `apps/frontend/src/lib/api/transactions.ts` | Three new API client functions; `bulkExportTransactions` returns a `Blob` and the hook triggers a synthetic `<a download>` |
| `apps/frontend/src/pages/TransactionsPage.tsx` | Owns selection state and selection mode; clears selection whenever the current filter changes |

The bulk-tag toolbar that previously lived inline inside `TransactionsTable` is now folded into the same dropdown menu via `BulkTagDialog`. The existing `POST /api/transactions/bulk-tag` route is untouched.

The recategorize and recipient-reassignment dialogs show localized `Category` and `Recipient`
labels linked to their combobox triggers. This gives each dialog's only field the same visible and
screen-reader name while reusing the shared combobox controls.

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

Filter shape mirrors a subset of the existing `GET /api/transactions` query fields. The accepted set is exactly: `transaction_id`, `start_date`, `end_date`, `account_id`, `bank_account`, `bank_accounts`, `category_id`, `category_ids`, `recipient_id`, `recipient_group_id`, `recipient_name`, `search`, `active`, `transaction_type`, `amount_min`, `amount_max`, `amount_signed`, `tags` — each also accepted in camelCase, but not in both spellings at once.

> [!warning] The filter is validated, not best-effort
> An unknown key, a wrong type or a malformed value **rejects the whole request** with a 400. This is stricter than the list endpoint on purpose. `normalizeBulkFilter` used to skip any field that failed its type guard, and skipping a filter on a bulk action does not narrow it — it *widens* it. `{"category_ids": "5"}` (a string where the array is expected) emitted no category clause at all, so `bulk-delete` swept every transaction the rest of the filter matched, up to the 5000 cap, and answered 200 with a plausible count. The same shape was live on `bank_accounts`, `tags`, `transaction_type`, `amount_min`/`amount_max`, and on any unrecognised key — `{"account_ids": [7]}` reached the SQL builder as an empty filter, i.e. "every active transaction".
>
> Absent, `null` and empty (`""`, `[]`) still mean "no filter on this field" and answer 200 — that is what keeps the whole-table "select all N matching" selection working (with no filters set the page posts `{"active": true}` and nothing else, bounded by the 5000-row cap rather than by validation). `category_ids` and `bank_accounts` must be arrays; a comma-separated string is rejected. `tags` accepts either form.
>
> Two deliberate non-rejections, both narrowing rather than widening and both shared with the list endpoint: a `search` shorter than 2 characters is ignored by the SQL builder, and `bank_accounts`/`tags` are sliced to the builder's 50-element cap.

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
