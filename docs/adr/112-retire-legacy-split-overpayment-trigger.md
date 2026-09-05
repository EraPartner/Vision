---
title: ADR-112 Retire the legacy split-payment overpayment trigger
type: adr
status: accepted
date: 2026-08-19
tags:
  [
    adr,
    database,
    migrations,
    splits,
    payments,
    concurrency,
    monetary-precision,
    adr-013,
    adr-060,
  ]
description: Migration 0088 removes the pre-squash split-payment overpayment trigger before widening amount columns, converging upgraded databases on the fresh-install schema and keeping the locked repository transaction as the authoritative payment cap.
aliases:
  [
    legacy split overpayment trigger,
    split payment guard,
    migration 0088 trigger cleanup,
  ]
---

# ADR-112: Retire the legacy split-payment overpayment trigger

## Status

Accepted — 2026-08-19. This supersedes only the database-trigger part of
[[docs/adr/013-split-hard-delete-with-audit-trail|ADR-013]]. Its hard-delete and audit-trail
decisions remain unchanged.

## Context

The pre-squash migration `0028_split_audit_overpayment_guard` created
`trg_split_payment_overpayment_guard` on `split_payments`. When the migration history was
consolidated under [[docs/adr/027-alembic-single-source-of-schema|ADR-027]], the replacement
split migrations created the split tables, aggregate triggers, positive-amount checks, and audit
table, but not this guard. Fresh databases therefore do not have it, while older databases that
were stamped onto the consolidated baseline can retain it.

The historical trigger is also tied to the former precision contract:

- it declares `NUMERIC(15,2)` local variables;
- it permits payment totals up to `split.amount + 0.005`;
- its `UPDATE OF amount, split_id` clause creates a catalog dependency on
  `split_payments.amount`.

That dependency makes PostgreSQL reject migration `0088_money_precision_alignment` when it tries
to widen `split_payments.amount` to `NUMERIC(18,4)`. Merely recreating the old trigger after the
retype would preserve fresh-versus-upgraded schema drift and a weaker cent-tolerance rule.

The application already has one concurrency-safe enforcement path. `splitRepository.addPayment`
locks the parent split with `SELECT ... FOR UPDATE`, sums committed payments, normalizes the new
amount to four decimal places, rejects an exact overpayment, and inserts, auto-settles, and audits
inside the same transaction. The row lock serializes concurrent application payments.

## Decision

Migration 0088 drops `trg_split_payment_overpayment_guard` and
`fn_split_payment_overpayment_guard()` before retyping money columns. Both `DROP` operations are
idempotent and avoid `CASCADE`, so an unexpected third-party dependency still fails loudly.

The trigger is not recreated. Fresh and upgraded databases converge on the same enforcement
model:

1. The route calculation rejects invalid payments early and returns the API error.
2. `splitRepository.addPayment` is the authoritative payment-cap check. It repeats validation
   under a split-row lock at `NUMERIC(18,4)` storage precision.
3. The accepted payment and any auto-settlement are committed with the audit row in one
   transaction.

The cleanup remains in place on downgrade. Recreating a legacy-only trigger after narrowing back
to `NUMERIC(15,2)` would reintroduce shape drift. A future database-level payment guard, if
required, must be introduced by a new migration for every install shape and must define its
concurrency behavior explicitly.

## Consequences

Implementation note (2026-09-04): the concurrency-safe application guard now lives in `splitService.addPayment()`. It uses transaction-client repository primitives for the row lock, paid-total read, insert, conditional settlement, and audit write. The trigger decision and four-decimal rule are unchanged.

**Positive**

- Databases that ran the old migration can pass 0088 instead of boot-looping.
- Fresh and upgraded databases have the same trigger inventory.
- Payment validation uses the same exact four-decimal rule as storage.
- The service-owned transaction and repository row lock close the concurrent application-payment race.

**Negative**

- Direct SQL writes to `split_payments` can bypass the payment cap. This was already true on fresh
  consolidated-chain databases; callers must use the split API or service path.
- The legacy trigger is not restored by an 0088 downgrade.

**Neutral**

- `trg_enforce_split_within_amount` remains on `transactions`; it protects a different invariant:
  reducing a parent transaction below its allocated splits.
- The aggregate-maintenance triggers on `transaction_splits` and `split_payments` remain in place.
- No API route or response shape changes.

## Rollback

Migration 0088 still narrows the aligned money columns with `USING round(column, 2)` after its
sub-cent preflight and restores the `NUMERIC(15,2)` aggregate sync helper. It deliberately leaves
the legacy overpayment trigger absent. Restoring that historical object requires an explicit,
separately reviewed migration rather than an install-shape-dependent downgrade side effect.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/013-split-hard-delete-with-audit-trail|ADR-013: Split hard-delete and audit trail]]
- [[docs/adr/060-may-2026-monetary-precision-and-deduplication-audit|ADR-060: Monetary precision]]
- [[docs/features/splits|Splits Feature]]
- [[docs/api/splits|Splits API]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/reference/database-triggers|Database Triggers Reference]]
- [[alembic/versions/0088_money_precision_alignment.py|Migration 0088]]
- [[apps/node-backend/src/repositories/splitRepository.js|Split repository]]
- [[apps/node-backend/src/services/splitService.js|Split service]]
