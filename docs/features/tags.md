---
title: Transaction Tags
type: feature
status: active
date: 2026-06-26
updated: 2026-06-26
tags: [feature, transactions, tags, categorization, saved-charts, analytics, i18n, combobox-tags, bug-fix]
description: Freeform tagging for transactions and planned transactions as a second orthogonal classification dimension; tags can also drive spending series in Custom Charts. 2026-06-26: 3 combobox.tags.* i18n keys added for TagFilterCombobox; TransactionInfoDialog tag-editing state bug fixed (last-tag removal chip stayed on screen after PATCH succeeded).
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

### i18n Keys (2026-06-26)

`TagFilterCombobox` uses three `combobox.tags.*` translation keys. These were missing from the locale files until 2026-06-26, causing the component to render raw key strings as fallback text:

| Key | EN | NL | Surface |
|-----|----|----|---------|
| `combobox.tags.empty` | "No tags found" | "Geen tags gevonden" | Empty-state label |
| `combobox.tags.nSelected` | "{n} tags" | "{n} tags" | Summary chip when multiple tags selected |
| `combobox.tags.search` | "Search tags..." | "Tags zoeken..." | Search input placeholder |

See [[docs/i18n/translations#tagfiltercombobox-i18n--bulk-tag-and-filter-toolbar-combobox-keys-2026-06-26|Translations changelog — 2026-06-26 batch]] for the full key-count context.

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

## TransactionInfoDialog — Tag Editing State Fix (2026-06-26)

**Root cause:** `TransactionInfoDialog` rendered `TagInput` with `value` bound directly to `infoTransaction.tags`, where `infoTransaction` is a frozen snapshot held in `TransactionsPage` state. The `applyInfoFieldLocally` path that propagates inline edits back to that snapshot handled `date`, `memo`, `amount`, `currency`, `bank_account`, and `comment` but not `tags`. As a result, after clicking a chip's remove (×) button, the `PATCH {tags:[]}` request succeeded on the backend and the transactions table refreshed correctly (it reads from the React Query cache, not the snapshot), but the dialog's chip stayed on screen because the snapshot never updated. The problem was most visible when removing the last/only tag — the list should have visibly emptied.

**Fix:** The dialog now tracks tag slugs in local component state (`tagSlugs`), seeded via `useEffect` keyed on `infoTransaction?.tags`. `TagInput`'s `onChange` updates `tagSlugs` optimistically; on mutation error the state is rolled back to the pre-edit value. This makes the dialog's tag display self-contained and independent of the frozen snapshot.

**Scope:** Only the dialog's in-flight display was stale. The backend (`transactionRepository.update` / `setTransactionTags` / the `PATCH` route) was already correct for empty-array payloads; the transactions list was always correct via the `onSettled` invalidation. No backend or API change was needed.

**Files changed:** `apps/frontend/src/features/transactions/components/TransactionInfoDialog.tsx` (local `tagSlugs` state + `useEffect` + rollback).

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

**Regression test added (2026-06-26):**

`apps/frontend/src/features/transactions/__tests__/TransactionInfoDialog.test.tsx` — test case "removing the only tag clears the chip and PATCHes empty tags". Verifies that removing the last tag chip from the info dialog immediately removes it from the display and sends `PATCH {tags:[]}`. The test was confirmed to fail on the old snapshot-binding code and pass on the local-state fix. Full file: 21 tests pass; lint + typecheck clean.

**Test Results (2026-05-08):**
- Backend: 95/95 test files pass (1522/1527 tests pass, 5 skipped)
- Frontend: 82/84 files pass (1272/1310 pass, 1 pre-existing timeout)
- No regressions introduced

See [[docs/testing/test-inventory#backend-test-suite-completion--transaction-tags-2026-05-08|Test Inventory: Transaction Tags Test Completion]] for detailed test fix notes.

## Custom Chart Integration

Tags are a first-class series dimension in the **Custom Charts / Saved Charts** feature. When one or more tags are selected in the chart builder, `CustomChart.tsx` calls `useTagPivot` which fetches `GET /api/aggregations/tag-pivot`. Each tag renders as an independent spending series labelled `#<slug>`.

**Multi-tag overlap caveat:** a transaction carrying multiple selected tags contributes to each matching tag's total. Per-tag lines can legitimately overlap and their combined sum may exceed the period's actual total spending. This is the same OR semantics used in the transaction-list tag filter.

See [[docs/features/saved-charts|Saved Charts Feature]] and [[docs/api/aggregations|Aggregations API]] (`tag-pivot` section) for full details.

## Related

- [[docs/adr/052-transaction-tags-orthogonal-dimension|ADR-052]]
- [[docs/features/transactions|Transactions]]
- [[docs/features/categories|Categories]]
- [[docs/features/bulk-actions|Bulk Actions]] — broader bulk operations on transactions
- [[docs/features/saved-charts|Saved Charts Feature]] — tags as a third chart series dimension
- [[docs/api/aggregations|Aggregations API]] — `GET /api/aggregations/tag-pivot` contract
