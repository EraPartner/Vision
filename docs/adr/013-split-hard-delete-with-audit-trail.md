---
title: ADR-013 - Split Hard-Delete with split_audit Trail
type: adr
status: accepted
date: 2026-04-16
tags: [adr, splits, soft-delete, audit, database, phase-4]
description: Splits and split_payments are hard-deleted via ON DELETE CASCADE; lifecycle is preserved in an append-only split_audit table.
---

# ADR-013: Split Hard-Delete with split_audit Trail

## Status

**Accepted** — Implemented in Phase 4 of the non-portfolio refactor (2026-04-16).

## Date

2026-04-16

## Context

Phase 4 of the non-portfolio refactor consolidates split/who-owes-you logic behind the pure calc module [[apps/node-backend/src/services/calculations/splits.js]] and the trigger-maintained aggregation table `agg_split_outstanding` (migration 0026). Two open questions blocked the phase:

1. **Deletion semantics.** `DELETE /api/splits/:id` and individual split_payments removals currently issue physical DELETEs through `splitRepository`. A full move to soft-delete (add `deleted_at TIMESTAMPTZ` + filter everywhere) was considered for symmetry with some portfolio tables.
2. **Forensic trail.** Operators need to reconstruct "what happened to this split" after the fact — who created it, who recorded a payment, who settled it, who deleted it — independent of whether the row physically still exists.

The data-model constraints already in place:

- `transaction_splits` has a `is_settled BOOLEAN` flag (auto-flipped when payments cover the full amount, or manually toggled via `POST /api/splits/:id/settle`).
- `split_payments` has no tombstone column and is only produced via `POST /api/splits/:id/pay`.
- `agg_split_outstanding` is maintained by INSERT/UPDATE/DELETE triggers on both tables, so any soft-delete approach would also need to teach those triggers to treat `deleted_at IS NOT NULL` as a delete.

Introducing soft-delete across both tables would cascade into: extra `WHERE deleted_at IS NULL` in every read path, new trigger branches, new UI affordances to restore, and new integrity rules (can a payment exist against a soft-deleted split?). That cost was not justified for a feature whose only two real lifecycle events are "created" and "settled".

## Decision

Splits and split_payments are **hard-deleted**. Lifecycle events are preserved in a new append-only `split_audit` table.

### Schema

Migration [[alembic/versions/0028_split_audit_overpayment_guard.py]] creates:

```sql
CREATE TABLE split_audit (
  id          BIGSERIAL PRIMARY KEY,
  split_id    INTEGER REFERENCES transaction_splits(id) ON DELETE SET NULL,
  action      VARCHAR(32) NOT NULL,
  actor       VARCHAR(64),
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_split_audit_split_created
  ON split_audit (split_id, created_at DESC);
CREATE INDEX idx_split_audit_action_created
  ON split_audit (action, created_at DESC);
```

`ON DELETE SET NULL` on `split_id` lets us retain audit history after the underlying split is hard-deleted. The payload JSONB captures a snapshot of the pre-delete row so the trail is self-contained.

### Action vocabulary

Written by `routes/splits.js` via `splitRepository.writeAudit({ split_id, action, actor, payload })`:

| action       | payload                                                                     | emitted by                                   |
| ------------ | --------------------------------------------------------------------------- | -------------------------------------------- |
| `create`     | `{ transaction_id, recipient_id, amount, note, batch? }`                    | `POST /api/splits`, `POST /api/splits/batch` |
| `pay`        | `{ payment_id, amount, paid_at, note, auto_settled }`                       | `POST /api/splits/:id/pay`                   |
| `settle`     | `{ manual: true }`                                                          | `POST /api/splits/:id/settle`                |
| `settle_all` | `{ recipient_id, settled_count }` with `split_id = NULL`                    | `POST /api/splits/owed/:id/settle-all`       |
| `delete`     | `{ split_id, transaction_id, recipient_id, amount }` with `split_id = NULL` | `DELETE /api/splits/:id`                     |

### Actor resolution

Routes resolve actor via the `x-actor` header, falling back to `req.user?.id`, falling back to `null`. Centralized in the `resolveActor(req)` helper in [[apps/node-backend/src/routes/splits.js]].

### Defense in depth

Overpayment protection ships in three layers:

1. **Pure calc** — `validatePaymentAmount` in [[apps/node-backend/src/services/calculations/splits.js]] (route returns 400 before DB write).
2. **DB trigger** — `fn_split_payment_overpayment_guard()` BEFORE INSERT/UPDATE on `split_payments` raises SQLSTATE `23514` when `SUM(payments) > split.amount + 0.005`.
3. **Audit log** — every accepted payment is recorded in `split_audit`.

The guard ensures invariant `sum(split_payments.amount) ≤ transaction_splits.amount` holds even if a future write path bypasses the calc module.

## Consequences

### Positive

- **No read-path overhead.** Every existing query over `transaction_splits` / `split_payments` stays as-is. No `deleted_at IS NULL` filter leaks into joins or aggregations.
- **Aggregation table stays simple.** `agg_split_outstanding` triggers only need to handle INSERT/UPDATE/DELETE — no "soft-delete = logical delete" branch.
- **Forensic trail survives physical deletion.** `ON DELETE SET NULL` keeps audit rows with their payload snapshot even when the parent split is gone.
- **Cheap enforcement of the core invariant.** DB-level overpayment guard means the calc validation is defense-in-depth rather than the sole line.
- **Single source of truth for lifecycle.** One table, one append-only write path, one set of indices tuned for "show me everything that happened to split X".

### Negative

- **Cannot recover a deleted split.** Physical deletion is irreversible; the payload snapshot is informational, not restorable. Consequence: UIs must treat delete as final and confirm.
- **Storage grows monotonically.** `split_audit` is append-only. For the dataset sizes Vision targets (self-hosted, single-user) this is negligible, but in the multi-tenant future it would need periodic archival — logged as a follow-up, not scoped here.
- **Actor fidelity depends on callers.** Without an authenticated session layer, the `x-actor` header is advisory; production deployments that want accountability must enforce header presence at the reverse proxy.

Implementation note (2026-08-25): the unused `req.user?.id` fallback was removed because no middleware assigns `req.user`. Routes now read the caller-supplied `x-actor` header and otherwise store `null`; the trust model above is unchanged.

Implementation note (2026-09-04): lifecycle orchestration moved from the route/repository boundary into `splitService`. The service now writes each audit row through `splitRepository.writeAudit()` inside the same database transaction as create, payment, settlement, settle-all, or delete. The accepted hard-delete and audit semantics are unchanged.

### Neutral

- **Splits and split_payments remain separate tables** — no union, no discriminator column. Keeps the calc layer thin.
- **`is_settled` retained.** Settle state is still first-class on `transaction_splits` (drives `agg_split_outstanding` filtering) but every toggle is mirrored into `split_audit`.

## Alternatives Considered

### A. Soft-delete on both tables (rejected)

Add `deleted_at TIMESTAMPTZ NULL` to `transaction_splits` and `split_payments`, filter everywhere, adjust triggers. Rejected because:

- Touches every repository read path.
- Requires UI affordances (restore, filter toggles).
- Doubles the state space of the aggregation triggers.
- The only operational need was "what happened to this split" — an audit table delivers that directly, without taxing the hot path.

### B. Logical status column (e.g., `status: 'active' | 'deleted'`) (rejected)

Same shape as soft-delete but with a richer vocabulary. Same cost, no new benefit over a dedicated audit table. Rejected.

### C. Application-level audit log in a log collector (e.g., send to stdout + aggregate externally) (rejected)

Decouples the audit trail from the DB transaction. Acceptable for observability but not for business-critical reconstruction — lost log lines would lose lifecycle context. Rejected in favor of transactional DB inserts.

## Related

- [[docs/features/splits|Splits Feature Spec]]
- [[docs/adr/010-phase1-aggregation-strategy|ADR-010: Phase 1 Aggregation Strategy]] (`agg_split_outstanding` definition)
- [[alembic/versions/0028_split_audit_overpayment_guard.py|Migration: 0028_split_audit_overpayment_guard]]
- [[apps/node-backend/src/services/calculations/splits.js|Splits calc module]]
- [[apps/node-backend/src/services/splitService.js|Split service]]
- [[apps/node-backend/src/repositories/splitRepository.js|Split repository]]
- [[apps/node-backend/src/routes/splits.js|Splits route]]
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]]

## References

- PostgreSQL error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html (23514 = check_violation, 23503 = foreign_key_violation)
- Append-only audit table pattern: https://martinfowler.com/eaaDev/EventSourcing.html (conceptual; we store state transitions, not events)
