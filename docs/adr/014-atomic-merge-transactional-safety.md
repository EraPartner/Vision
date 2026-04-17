---
title: ADR-014 - Atomic Merge Transactional Safety
type: adr
status: accepted
date: 2026-04-16
tags: [adr, recipients, merge, transactions, atomicity, database, phase-6]
description: Recipient merge uses single database transaction with row-level locking and race-safe conflict deduplication for atomicity.
---

# ADR-014: Atomic Merge Transactional Safety

## Status

**Accepted** — Implemented in Phase 6 of the non-portfolio refactor (2026-04-16).

## Date

2026-04-16

## Context

Previously, merging recipients only stamped `primary_recipient_id` on the alias rows, leaving all downstream foreign keys (transactions, splits, planned transactions, bank accounts) still pointing at the alias. This created downstream consistency problems:

1. **Stale reads** — Reports and analytics had to walk the `primary_recipient_id` chain on every read to find the actual primary.
2. **Inconsistent state** — If the merge process crashed mid-way, some FKs might be reassigned and others not, leaving the database in an inconsistent state.
3. **Race conditions** — Concurrent merges into the same primary could create duplicate bank accounts (same account number for the same recipient).
4. **Audit trail loss** — There was no transactional boundary, making it impossible to roll back if errors occurred partway through.

## Decision

Implement atomic merges within a single PostgreSQL transaction, using the following strategy:

### Transaction Boundaries

Wrap all merge steps in `BEGIN ... COMMIT`:

```javascript
const client = await getClient();
try {
  await client.query('BEGIN');
  // All steps below execute in a single transaction
  // On error, ROLLBACK clears all partial changes
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
}
```

### Row-Level Locking

Lock the primary recipient with `FOR UPDATE` to serialize concurrent merges into the same primary:

```sql
SELECT id FROM recipients WHERE id = $1 FOR UPDATE
```

This ensures that if two clients attempt to merge different aliases into the same primary simultaneously, the second merge waits for the first to COMMIT before proceeding. This prevents interleaved updates that could leave the database inconsistent.

### Reassignment Order

Reassign foreign keys in dependency order to avoid FK violation:

1. `transactions.recipient_id` → primary
2. `transaction_splits.recipient_id` → primary
3. `planned_transactions.recipient_id` → primary (guarded: column may not exist on very old schemas)
4. `recipient_bank_accounts.recipient_id` → primary
5. `recipients.primary_recipient_id` → primary (alias now officially points to primary)

### Race-Safe Bank Account Deduplication

Bank accounts for the same recipient must have unique account numbers. When reassigning a bank account from an alias to the primary, the primary may already have an account with the same account number. Use `INSERT ... ON CONFLICT DO NOTHING` with a fallback lookup to deduplicate race-safely:

```sql
INSERT INTO recipient_bank_accounts (recipient_id, account_number, bank_name, ...)
VALUES ($1, $2, $3, ...)
ON CONFLICT (recipient_id, account_number) DO NOTHING
RETURNING id
```

This guarantees that:
- If the account already exists on the primary, it is NOT re-inserted (idempotent).
- If two clients try to reassign the same account simultaneously, exactly one row is inserted.
- The result gives us the ID of the existing or inserted row.

## Consequences

### Positive

1. **Atomicity**: Merge is all-or-nothing; no partial state.
2. **Consistency**: All FKs pointing to an alias are instantly reassigned to the primary.
3. **Serializability**: Concurrent merges into the same primary serialize cleanly via `FOR UPDATE`.
4. **Race-safety**: Bank account deduplication is guaranteed to produce exactly one account per (recipient, account_number) pair.
5. **Rollback**: If any step fails, the entire merge rolls back; callers get an error and can retry without side effects.
6. **Audit trail**: The merge is instantaneous from the caller's perspective; there is no window where the DB is partially updated.

### Negative

1. **Blocking**: `FOR UPDATE` on the primary recipient blocks other merges into the same primary. For very high-throughput merge scenarios, this could introduce contention. However, merges are typically infrequent operations; the trade-off is acceptable.
2. **Transaction overhead**: Each merge now requires a full transaction with multiple round-trips to the database. For single merges, the overhead is negligible; for bulk merges (though rare), the caller may need to batch them.

### Neutral

1. **Agg table self-maintenance**: The `agg_recipient_totals` materialized view self-maintains via triggers on `transactions`, so reassignments automatically cascade into aggregation without explicit intervention.
2. **Backward compatibility**: The merge endpoint response shape is unchanged; only the internal implementation is atomic now.

## Implementation

**Service**: [[apps/node-backend/src/services/recipientMergeService.js|recipientMergeService.js]]

The service exports a single function `mergeRecipients(primaryId, aliasIds)` that handles all steps internally. The route layer simply calls this function and returns the result.

## Related Decisions

- [[docs/adr/015-recipient-bank-account-uniqueness|ADR-015]] — Database-level UNIQUE constraints that underpin atomic merge safety (recipient.normalized_name, recipient_bank_accounts.account_number, categories (general, detail)).

## Related Code

- [[apps/node-backend/src/services/recipientMergeService.js|recipientMergeService.js]] — Atomic merge implementation
- [[apps/node-backend/src/routes/recipients.js|recipients.js]] — Route that calls the merge service
- [[docs/api/recipients|Recipients API]] — Endpoint contract
