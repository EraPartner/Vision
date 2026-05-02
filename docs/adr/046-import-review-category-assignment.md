---
title: ADR-046 - Import Review Category Assignment
type: adr
status: accepted
date: 2026-05-02
tags: [adr, import, categories, recipients, review, ux, schema]
description: Extend the import review step with per-group category assignment plus optional persist-as-recipient-default, eliminating the post-import "uncategorized" cleanup pass.
related: [docs/features/import, docs/features/recipients, docs/features/categories, docs/adr/015-recipient-bank-account-uniqueness]
---

# ADR-046: Import Review Category Assignment

## Status

**Accepted** — Implemented 2026-05-02.

## Date

2026-05-02

## Context

The import pipeline produces transactions whose category is **never written at insert time**. Categories are resolved lazily at read time via:

```sql
COALESCE(t.category_id, r.default_category_id) AS effective_category_id
```

(See [[apps/node-backend/src/repositories/transactionRepository.js]].)

This means a freshly-imported transaction surfaces as **uncategorized** unless its recipient already has a `default_category_id` set. The two common reasons that fails:

1. **New recipient** — `match.js` upserted a brand-new recipient row during the import; `default_category_id` is `NULL`.
2. **Existing recipient without default** — older recipients created before category defaults were rolled in, or recipients that have intentionally not had a default set yet.

The existing review flow ([[apps/frontend/src/pages/ImportReviewPage.tsx]]) groups staging rows by resolved recipient and lets the user override the recipient via [[apps/frontend/src/components/shared/RecipientCombobox.tsx]]. There is **no category surface in this flow**. Users routinely confirm recipients in the review step and then have to chase down dozens of uncategorized transactions on the transactions page afterwards.

Three options were considered:

1. **Recipient-default only** — One category per recipient, persisted to `recipients.default_category_id`. No staging-row override. Cheapest. Loses one-off override granularity.
2. **Per-row override only** — Add `override_category_id` to `import_staging_rows`. Doesn't change recipient state. Loses the "set this once and inherit forever" benefit.
3. **Hybrid** — Per-group override on the staging rows AND an opt-in checkbox to also persist that category to the recipient default. Solves both audiences.

## Decision

Adopt **Option 3 (Hybrid)**. Specifically:

1. **Schema:** add `override_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL` to `import_staging_rows` via a new alembic migration `0020_import_staging_override_category_id.py`.
2. **Match phase:** after recipient resolution, surface each row's `recipient.default_category_id` so the review payload can preselect it as the implicit category.
3. **Preview endpoint** (`GET /api/import/batches/:id/preview`): return per-group `current_category_id`, `current_category_label`, `recipient_default_category_id`, and `override_category_id` so the UI can render the correct preselect, badge state, and "set as default" checkbox state.
4. **Override endpoint** (new `POST /api/import/batches/:id/rows/:rowId/category-override`): set or clear `override_category_id` on a single staging row. Symmetrical to the existing recipient-override endpoint.
5. **Commit phase:** at INSERT, derive `effective_category_id`:
   ```js
   effectiveCategoryId =
     row.override_category_id ??
     recipient.default_category_id ??
     null;
   ```
   Write that into `transactions.category_id` directly. The runtime COALESCE in transactionRepository now becomes a defensive no-op for new rows but is preserved for legacy data.
6. **Persist-as-default:** the review UI exposes a checkbox per group ("Save as recipient default"). When checked **and** the user has set a category, the review page issues a `PATCH /api/recipients/:id` with `default_category_id`. This reuses the existing endpoint — no new route needed. The checkbox defaults to `true` when the recipient has no current default; `false` otherwise.
7. **UI:** [[apps/frontend/src/pages/ImportReviewPage.tsx]] gains a [[apps/frontend/src/components/shared/CategoryCombobox.tsx]] in the group accordion trigger row, beside the existing `RecipientCombobox`. State follows the existing `groupOverrides` map pattern.

## Consequences

### Positive

1. **No post-import cleanup pass** — categorization happens during the review step the user already does. Single mental model: "review what this batch did before it lands."
2. **Per-row granularity** — splits a recipient's transactions across categories per import without forcing a global recipient default change. Example: SUPERMARKET ABC for groceries vs. an unusual hardware run.
3. **Optional persistence** — when the category really is the recipient's stable default, the user can persist it with one click and never see uncategorized for that recipient again.
4. **Backwards-compatible reads** — `transactionRepository`'s runtime COALESCE keeps working for existing rows that pre-date this change. No data backfill required.
5. **Symmetric API surface** — the new endpoint mirrors the recipient-override one. Predictable for clients and for our own code.

### Tradeoffs

1. **One more column on `import_staging_rows`** — minor, the table is bounded in size (rows are committed to `transactions` and the staging payload is short-lived).
2. **More frontend state in the review group** — `groupOverrides` now tracks recipient + category + persistDefault. Manageable; same shape, three fields.
3. **Persist-default writes during review, not commit** — the recipient update lands when the checkbox toggles, not at commit. That means a user who navigates away mid-review can leave a recipient with a default set even though no transaction was committed. Acceptable: the recipient-default change is independently sensible and reversible, and users explicitly opted in via the checkbox.
4. **No retroactive categorization** — committing this batch only affects this batch's transactions. Pre-existing uncategorized transactions are not touched. Out of scope.
5. **New rows freeze category at commit time** — previously, a transaction's effective category followed the recipient's current `default_category_id` via runtime COALESCE. Now, freshly-committed rows have `transactions.category_id` written explicitly. Changing the recipient default afterwards no longer retroactively recategorizes them. This is the correct semantic — a transaction belongs to the category it had when the user reviewed it — but it is a behavior change for recipients whose defaults change frequently. Pre-existing rows with `category_id = NULL` keep using the runtime COALESCE.

## Rejected Alternatives

### 1. Recipient-default only

Add a category combobox to the review group that always writes to `recipients.default_category_id` (no per-row override).

**Rationale for rejection:**
- Forces global category per recipient. ✗
- Hostile to legitimately split-category recipients (rare but real). ✗
- Skips the cleaner separation between "this batch's behavior" and "this recipient's policy". ✗

### 2. Per-row override only

Add the override column but skip the persist-default checkbox.

**Rationale for rejection:**
- User must reassign the same category every import for stable recipients. ✗
- Defeats half the value: the typical case is "this recipient is always groceries, just set it." ✗

### 3. Schema-level join from staging to category at insert

Resolve category in a JOIN at commit time without a column.

**Rationale for rejection:**
- Loses the per-row override knob entirely. ✗
- Mixes the override semantics into SQL. Harder to reason about and test. ✗

## Schema Change

```sql
-- alembic/versions/0020_import_staging_override_category_id.py
ALTER TABLE import_staging_rows
  ADD COLUMN IF NOT EXISTS override_category_id INTEGER
  REFERENCES categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_staging_override_category
  ON import_staging_rows (override_category_id)
  WHERE override_category_id IS NOT NULL;
```

Downgrade drops the column and index.

## API Changes

### Preview response (extended)

```jsonc
{
  "batch_id": 42,
  "groups": [
    {
      "recipient_id": 7,
      "recipient_name": "SUPERMARKET ABC",
      "recipient_default_category_id": null,         // NEW
      "recipient_default_category_label": null,      // NEW
      "current_category_id": 12,                     // NEW — effective category for the group (override > default)
      "current_category_label": "groceries: food",   // NEW
      "override_category_id": 12,                    // NEW — null when no per-row override set
      "matched_pattern_id": null,
      "matched_pattern_text": null,
      "matched_pattern_kind": null,
      "row_count": 4,
      "rows": [ /* unchanged shape */ ]
    }
  ],
  "totals": { "exact": 0, "fuzzy": 0, "pattern": 0, "new": 1, "unresolved": 0 }
}
```

The existing per-row shape is unchanged.

### New endpoint: category override

```
POST /api/import/batches/:id/rows/:rowId/category-override
Body: { "category_id": 12 | null }
```

Sets or clears `override_category_id`. Returns:

```json
{ "row_id": 87, "override_category_id": 12 }
```

Validation: `category_id` must be `null` or a positive integer; the row must exist in the named batch and be in `status = 'matched'`.

### Reused: recipient default

```
PATCH /api/recipients/:id
Body: { "default_category_id": 12 }
```

Already exists. The review page uses it when the persist-default checkbox is on.

## Commit Behavior

```js
// apps/node-backend/src/services/importPipeline/commit.js (excerpt)
const effectiveRecipientId =
  row.user_override_recipient_id ?? row.resolved_recipient_id ?? null;

const effectiveCategoryId =
  row.override_category_id ??
  row.recipient_default_category_id ??
  null;

// INSERT now writes category_id explicitly
INSERT INTO transactions
  (date, bank_account, recipient_id, category_id, amount, memo, ...)
  VALUES ($1, $2, $3, $4, $5, $6, ...);
```

`row.recipient_default_category_id` is sourced from a JOIN against `recipients` in the matched-rows SELECT inside `commit.js`. No extra round-trips.

## Implementation Checklist

- [x] ADR-046 (this document)
- [x] Migration `0020_import_staging_override_category_id.py`
- [x] `match.js` — no logic change (the join is in commit, which has the latest recipient data)
- [x] `commit.js` — JOIN recipient default, COALESCE override > default, write `category_id`
- [x] Preview endpoint — extended JOIN + per-group fields
- [x] New endpoint `POST /api/import/batches/:id/rows/:rowId/category-override`
- [x] Frontend types — `ImportPreviewGroup` extended with category fields
- [x] Frontend api client — `overrideImportRowCategory()` + reuse `updateRecipient()` for persist-default
- [x] [[apps/frontend/src/pages/ImportReviewPage.tsx]] — `CategoryCombobox` + persist-default checkbox per group
- [x] Backend tests — new endpoint, commit precedence, persistence
- [x] KB updates — `docs/features/import.md`, `docs/api/imports.md`, `docs/reference/api-endpoint-matrix.md`

## Related Documents

- [[docs/features/import|Import Feature]]
- [[docs/features/recipients|Recipients Feature]]
- [[docs/features/categories|Categories Feature]]
- [[docs/adr/015-recipient-bank-account-uniqueness|ADR-015: Recipient Uniqueness]]
- [[docs/adr/index|All ADRs]]
