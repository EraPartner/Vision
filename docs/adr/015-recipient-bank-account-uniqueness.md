---
title: ADR-015 - Recipient, Bank Account, and Category Uniqueness Constraints
type: adr
status: accepted
date: 2026-04-16
tags: [adr, database, constraints, uniqueness, migration, phase-6]
description: Database-level UNIQUE constraints on recipients.normalized_name, recipient_bank_accounts.account_number, and categories(general, detail) to enforce data integrity and enable efficient merge deduplication.
---

# ADR-015: Recipient, Bank Account, and Category Uniqueness Constraints

## Status

**Accepted** — Implemented in Phase 6 via Alembic migration 0029 (2026-04-16).

## Date

2026-04-16

## Context

Previously, the application relied on application-layer logic to ensure uniqueness of recipient names, bank account numbers, and category pairs. This created several problems:

1. **Race conditions** — Two concurrent requests could both check for existence and both create duplicates if the check and insert were not atomic.
2. **Stale reads** — Normalization of recipient names for matching required complex fuzzy-search logic without a canonical unique identifier for exact matches.
3. **Merge complexity** — Bank account deduplication during merge had to be handled at the application layer with explicit duplicate detection, risking partial failures.
4. **Inconsistent state** — Orphaned duplicates could accumulate if errors occurred mid-process.

## Decision

Enforce uniqueness at the database level using UNIQUE constraints:

### 1. recipients.normalized_name UNIQUE

Each recipient's `normalized_name` (lowercase, trimmed, punctuation removed) must be unique within the workspace.

```sql
ALTER TABLE recipients
ADD CONSTRAINT unique_normalized_name
UNIQUE (workspace_id, normalized_name);
```

**Rationale:**
- Enables O(1) exact-match lookups on normalized names (no full-table scans).
- Prevents duplicate normalized names (e.g., "ABC supermarket" and "abc supermarket").
- Works with the `pg_trgm` GIN index for fuzzy matching as a fallback when exact match fails.

### 2. recipient_bank_accounts.account_number UNIQUE

Each recipient's bank accounts must have unique account numbers.

```sql
ALTER TABLE recipient_bank_accounts
ADD CONSTRAINT unique_account_number_per_recipient
UNIQUE (recipient_id, account_number);
```

**Rationale:**
- Prevents duplicate bank accounts for the same recipient.
- Makes merge deduplication race-safe via `INSERT ... ON CONFLICT DO NOTHING` with fallback lookup.

### 3. categories(general, detail) UNIQUE

Each category pair must be unique (e.g., "FOOD:GROCERIES" exists exactly once).

```sql
ALTER TABLE categories
ADD CONSTRAINT unique_category_pair
UNIQUE (workspace_id, general, detail);
```

**Rationale:**
- Enables idempotent create-or-get operations on categories.
- Prevents accidental duplicate category definitions.
- Simplifies category assignment logic.

## Conflict Resolution During Migration

Alembic migration 0029 handles existing duplicate data gracefully:

1. **Recipient duplicates** — Retain the oldest record by `created_at`; soft-delete (set `is_active = false`) newer duplicates to preserve FK references.
2. **Bank account duplicates** — Retain the primary account (or oldest by `created_at`); soft-delete others.
3. **Category duplicates** — Retain the oldest; soft-delete others.

This ensures that:
- No data is permanently lost (soft-delete preserves audit trail).
- Foreign keys continue to point at valid rows.
- Transactions linked to soft-deleted recipients are reassigned to the retained primary recipient via merge logic (handled separately).

## Migration Steps (Alembic 0029)

1. Identify and log duplicate recipients, bank accounts, and categories.
2. For each duplicate set, mark the newer records as `is_active = false`.
3. Reassign any transactions from soft-deleted recipients to the retained primary via a separate merge operation.
4. Add UNIQUE constraints.
5. Verify constraint creation succeeds (raises error if duplicates remain).

## Consequences

### Positive

1. **Database-enforced integrity** — The database rejects duplicate insertions; no application-layer logic needed.
2. **Race-safe operations** — Concurrent requests can safely use `INSERT ... ON CONFLICT` patterns without application-layer synchronization.
3. **Efficient matching** — Exact-match lookups on `normalized_name` are O(1); fuzzy fallback is O(log N) via GIN index.
4. **Simplified merge** — Bank account deduplication during merge is handled entirely by the database.
5. **Backward compatibility** — Existing queries on recipients and categories continue to work; only insertion logic changes.

### Negative

1. **Migration complexity** — Existing databases with duplicates require careful migration. The Alembic migration handles this but requires testing in production-like environments.
2. **Soft-delete burden** — Soft-deleted records remain in the table, increasing table size and query complexity (must filter by `is_active`). This is a trade-off for data preservation.
3. **Workspace isolation** — If the application becomes multi-tenant in the future, the UNIQUE constraint must include `workspace_id` to isolate tenants. The migration already includes this foresight.

### Neutral

1. **Performance** — UNIQUE constraints have minimal performance impact on reads and writes. INSERT performance on recipient/category/bank_account tables may marginally improve due to fewer duplicates and more efficient query plans.

## Implementation Details

**Constraints added by migration 0029:**

```sql
-- In recipients table
ALTER TABLE recipients
ADD CONSTRAINT unique_normalized_name 
UNIQUE (workspace_id, normalized_name);

-- In recipient_bank_accounts table
ALTER TABLE recipient_bank_accounts
ADD CONSTRAINT unique_account_number_per_recipient 
UNIQUE (recipient_id, account_number);

-- In categories table
ALTER TABLE categories
ADD CONSTRAINT unique_category_pair 
UNIQUE (workspace_id, general, detail);
```

**Application-layer adaptations:**

- [[apps/node-backend/src/repositories/recipientRepository.js|recipientRepository.js]] — `createOrGet` uses `INSERT ... ON CONFLICT (normalized_name) DO NOTHING RETURNING *` with fallback lookup.
- [[apps/node-backend/src/repositories/categoryRepository.js|categoryRepository.js]] — `createOrGet` uses `INSERT ... ON CONFLICT (general, detail) DO NOTHING RETURNING *` with fallback lookup.
- [[apps/node-backend/src/services/recipientMergeService.js|recipientMergeService.js]] — Bank account reassignment uses `INSERT ... ON CONFLICT (recipient_id, account_number) DO NOTHING` for deduplication.

## Rollback Plan

If the migration causes issues:

1. **Remove constraints** — Issue `ALTER TABLE recipients DROP CONSTRAINT unique_normalized_name;` etc. (no data loss).
2. **Restore soft-deleted records** — Set `is_active = true` on records that were soft-deleted during migration.
3. **Revert merge operations** — Undo any recipient merges performed as part of conflict resolution (requires audit trail review).

## Related Decisions

- [[docs/adr/014-atomic-merge-transactional-safety|ADR-014]] — Atomic merge relies on these constraints for race-safe deduplication.
- [[docs/adr/002-database-schema|ADR-002]] — Database schema design principles.

## Related Code

- `alembic/versions/0029_*.py` — Migration that adds UNIQUE constraints and handles conflict resolution.
- [[docs/guides/migrations|Migration Guide]] — How to manage schema changes safely.
