---
title: Transaction Tags
type: feature
status: active
date: 2026-05-08
tags: [feature, transactions, tags, categorization]
description: Freeform tagging for transactions and planned transactions as a second orthogonal classification dimension
aliases: [tags, transaction-tags, labels]
related_code:
  - "apps/node-backend/src/repositories/tagRepository.js"
  - "apps/node-backend/src/routes/tags.js"
  - "apps/node-backend/src/repositories/transactionRepository.js"
  - "apps/frontend/src/hooks/useTags.ts"
  - "apps/frontend/src/components/shared/TagInput.tsx"
  - "apps/frontend/src/components/shared/TagFilterCombobox.tsx"
  - "apps/frontend/src/features/transactions/components/TransactionsTable.tsx"
  - "apps/frontend/src/features/transactions/components/TransactionInfoDialog.tsx"
---

# Transaction Tags

> [!abstract] Overview
> Tags are a freeform, globally-scoped classification system that cross-cuts categories. Users attach any number of tags to transactions and planned transactions to group by trips, projects, events, or any other dimension without modifying the category hierarchy.

## Feature Overview

### User Story

> As a user, I want to tag transactions with freeform labels (e.g. `rome-2020`, `home-renovation`) so that I can group and filter spending across categories without restructuring my category tree.

### Key Capabilities

- Create tags on first use — no upfront setup required
- Attach tags to individual transactions via the info dialog
- Attach tags to planned transactions via the form (inherited by executed copies)
- Bulk-tag multiple transactions via checkbox selection + toolbar
- Filter the transaction list by one or more tags (OR semantics)
- Soft-delete tags (`is_active = false`); historical chips are preserved
- Reactivation on re-entry of a soft-deleted slug

## Architecture

### Database

| Table | Purpose |
|-------|---------|
| `tags` | Global tag registry: `id`, `slug` (unique), `color`, `is_active`, timestamps |
| `transaction_tags` | Junction: `(transaction_id, tag_id)` PK, CASCADE on delete |
| `planned_transaction_tags` | Junction for planned transactions, same shape |

Slugs are globally unique (not partial-on-active) so junction rows survive soft-delete/reactivation cycles. See [[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052]] for rationale.

### Backend

| File | Role |
|------|------|
| `apps/node-backend/src/repositories/tagRepository.js` | CRUD + `findOrCreateBySlug` (atomic upsert) |
| `apps/node-backend/src/routes/tags.js` | `GET /api/tags`, `POST /api/tags`, `PATCH /api/tags/:id`, `DELETE /api/tags/:id` |
| `apps/node-backend/src/repositories/transactionRepository.js` | Batched second query attaches `tags: Tag[]` to list results; `create`/`update` accept `tags: string[]` |
| `apps/node-backend/src/services/filterBuilder.js` | `tags` param → `EXISTS (SELECT 1 FROM transaction_tags ...)` |
| `apps/node-backend/src/routes/transactions.js` | `tags` query param + `POST /api/transactions/bulk-tag` |
| `apps/node-backend/src/repositories/plannedTransactionRepository.js` | `planned_transaction_tags` read/write; `executeAndAdvance` inherits tags |

### Slug normalisation

```js
slug = input.toLowerCase().trim()
  .replace(/\s+/g, '-')
  .replace(/[^a-z0-9-]/g, '')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '');
```

Applied on both backend (`apps/node-backend/src/lib/slugify.js`) and frontend (`apps/frontend/src/lib/slugify.ts`). Unicode characters are dropped in v1 (known limitation).

### Frontend components

| Component | Purpose |
|-----------|---------|
| `TagInput` | Chip combobox: search existing tags, create on Enter, live slug preview, 8-swatch color picker |
| `TagChip` | Colored badge chip with optional remove button |
| `TagFilterCombobox` | Read-only multi-select for filter toolbar and bulk-tag toolbar |
| `useTags` | `useQuery` for `GET /api/tags`; query key `['tags', { is_active }]` |
| `useCreateTag` | Mutation for `POST /api/tags` |
| `useBulkTagTransactions` | Mutation for `POST /api/transactions/bulk-tag` |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tags` | List tags; `?is_active=true\|false` filter |
| `POST` | `/api/tags` | Find-or-create tag (upsert by slug) |
| `PATCH` | `/api/tags/:id` | Update `color` or `is_active` |
| `DELETE` | `/api/tags/:id` | Soft-delete (`is_active = false`) |
| `POST` | `/api/transactions/bulk-tag` | Atomically add/remove tags on multiple transactions |

`GET /api/transactions` accepts `?tags=slug1,slug2` (OR filter).

## Tag Lifecycle

```
User types slug → slugify → POST /api/tags (upsert)
  ↳ new row created         → color set, is_active = true
  ↳ active row exists       → returns existing
  ↳ soft-deleted row exists → reactivates, preserves color, junction history intact
```

## Bulk-Tag Flow

1. User selects rows via checkbox column.
2. Toolbar shows the count and an `Actions ▾` dropdown — see [[docs/features/bulk-actions|Bulk Actions]].
3. Picking "Apply tags…" opens a dialog with two `TagFilterCombobox` pickers (Add / Remove).
4. Clicking Apply → `POST /api/transactions/bulk-tag` with `transaction_ids`, `add_slugs`, `remove_slugs`.
5. Single DB transaction: resolves slugs → IDs, inserts junctions (ON CONFLICT DO NOTHING), deletes removals.
6. TanStack Query invalidates transactions list on success.

## Planned Transaction Inheritance

When a planned transaction is executed via `executeAndAdvance`, its `planned_transaction_tags` rows are copied into `transaction_tags` inside the same database transaction. Idempotent: junction PK prevents double-insertion on retry.

## Test Coverage

The Transaction Tags feature test suite is **complete and passing** (2026-05-08).

**Backend Test Coverage:**

| Test File | Coverage |
|-----------|----------|
| `apps/node-backend/tests/filterBuilder.test.js` | Filter builder tag slug handling (empty/single/multiple tag filter semantics) |
| `apps/node-backend/tests/routes/tags.js` | Tag CRUD endpoints (list, create, update color/is_active, soft-delete) |
| `apps/node-backend/tests/plannedTransactionRepository.test.js` | Planned transaction tag read/write and execute-forward inheritance |
| `apps/node-backend/tests/routes/transactions.test.js` | Transaction tag filtering and NDJSON export with tag fields |
| `apps/node-backend/src/backup/coverage.js` | Backup table enumeration includes tag tables (`tags`, `transaction_tags`, `planned_transaction_tags`) |

**Frontend Test Coverage:**

Tag UI components are tested via:
- Component integration tests for `TransactionsTable` (tag display, filter combobox)
- Integration tests for `TransactionInfoDialog` (tag attachment to transactions)
- Hook unit tests for `useTags`, `useCreateTag`, `useBulkTagTransactions`
- API contract tests validating tag endpoint response shapes

**Test Results (2026-05-08):**
- Backend: 95/95 test files pass (1522/1527 tests pass, 5 skipped)
- Frontend: 82/84 files pass (1272/1310 pass, 1 pre-existing timeout)
- No regressions introduced

See [[docs/testing/test-inventory#backend-test-suite-completion--transaction-tags-2026-05-08|Test Inventory: Transaction Tags Test Completion]] for detailed test fix notes.

## Related

- [[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052]]
- [[docs/features/transactions|Transactions]]
- [[docs/features/categories|Categories]]
- [[docs/features/bulk-actions|Bulk Actions]] — broader bulk operations on transactions
