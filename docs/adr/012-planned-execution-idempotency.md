---
title: ADR-012 - Planned Execution Idempotency via UNIQUE Constraint
type: adr
status: accepted
date: 2026-04-16
tags: [adr, planned-transactions, idempotency, database, phase-3]
description: Using PostgreSQL UNIQUE constraint and error 23505 to ensure idempotent planned transaction execution
---

# ADR-012: Planned Execution Idempotency via UNIQUE Constraint

## Status

**Accepted** — Implemented in Phase 3 of the non-portfolio refactor (2026-04-16).

## Date

2026-04-16

## Context

The `POST /api/planned-transactions/:id/execute` endpoint records an execution by:
1. Inserting a row into `planned_transaction_executions`
2. Updating the parent `planned_transactions` row with new dates and execution state

Without idempotency guarantees, a double-click or retry of the network request produces two execution rows pointing at the same (planned_transaction_id, executed_transaction_id) pair. This creates:
- Duplicate audit trails
- Inconsistent execution counts
- Possible confusion in analytics and reconciliation

The endpoint needed to be **safe to retry** without side effects.

## Decision

Implement idempotency using a **UNIQUE constraint** on the (planned_transaction_id, executed_transaction_id) pair combined with atomic transaction handling and explicit error detection:

1. **Database:** Add UNIQUE INDEX `uniq_pte_planned_executed` on `planned_transaction_executions (planned_transaction_id, executed_transaction_id)`.

2. **Data safety:** Migration `0027_planned_execution_idempotency` de-duplicates any pre-existing duplicate pairs before applying the constraint. The oldest row (smallest id) is kept; newer duplicates are deleted. This is additive from a schema perspective — the constraint only rejects future duplicates, so rollback is safe.

3. **Application logic:** Wrap the two-write operation in a single database transaction (`BEGIN/COMMIT`):
   - Attempt to insert the execution row
   - If Postgres error 23505 (unique_violation) occurs, roll back and signal the duplicate
   - Otherwise, update the parent row and commit
   - Return the same result (current planned state) either way

4. **HTTP response:** On duplicate, send HTTP 200 with `Idempotent-Replay: true` header to signal to the caller that the request was idempotent. No new state was created; the result is identical to the previous execution.

## Consequences

### Positive

- **Safe to retry:** Double-clicks, network timeouts, and client retries all produce the same outcome without creating duplicates.
- **Simple:** Leverages PostgreSQL's native constraint violation detection instead of application-level deduplication logic.
- **Efficient:** Database error 23505 is thrown before writing, so we avoid the cost of full rollback on every duplicate.
- **Auditable:** Single row per execution pair means audit logs are clean and counts match intent.
- **Back-compatible:** Existing code paths and API contracts remain unchanged. Callers can optionally inspect the `Idempotent-Replay` header to optimize behavior.

### Negative

- **Single constraint:** The constraint allows only one execution per (planned_id, executed_id) pair. If the business requirement ever changes (e.g., allowing multiple payments from the same planned transaction to the same executed transaction), the constraint must be dropped.
- **Migration risk (low):** De-duplication during migration assumes the oldest row is the "true" execution. If business logic stored metadata in newer rows, the migration would discard it. (In practice, execution rows are immutable audit records with no mutable fields.)

### Neutral

- **No schema change to planned_transactions table:** The constraint is on the junction table only, preserving the planned transaction record semantics.
- **Applies to execute only:** Other planned transaction mutations (create, update, delete) are not affected by this constraint.

## Related

- [[docs/features/plannedTransactions#execution-atomicity-and-idempotency-phase-3|Planned Transactions Feature: Execution Atomicity]]
- [[docs/api/plannedTransactions|API: Planned Transactions Execute Endpoint]]
- [[alembic/versions/0027_planned_execution_idempotency.py|Migration: 0027_planned_execution_idempotency]]
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]]

## References

- PostgreSQL error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html (23505 = unique_violation)
- Idempotency patterns: https://en.wikipedia.org/wiki/Idempotence (GET is naturally idempotent; POST/PATCH require explicit guarantees)
