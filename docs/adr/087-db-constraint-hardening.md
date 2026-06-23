---
title: ADR-087 - DB Constraint Hardening (One Primary Bank Account + Category FK ON DELETE SET NULL)
type: adr
status: accepted
date: 2026-06-18
tags: [adr, database, constraints, migrations, category, recipient-bank-accounts, fk, on-delete-set-null, integrity]
description: Two DB invariants moved from application enforcement to the schema — a partial unique index for one-primary-bank-account per recipient, and ON DELETE SET NULL for the three optional category FKs. Migrations 0047 and 0048 authored, pending apply.
aliases: [adr-087, db-constraint-hardening, category-fk-on-delete-set-null, one-primary-bank-account]
---

# ADR-087: DB Constraint Hardening (One Primary Bank Account + Category FK ON DELETE SET NULL)

## Status
Accepted

## Date
2026-06-18

## Context

Two invariants were enforced at the application level only, leaving the schema silent:

**1. One primary bank account per recipient (`recipient_bank_accounts.is_primary`).**
The field is documented as "enforced at application level" but nothing in the schema prevented a recipient from having two `is_primary = true` rows simultaneously. An ambiguous primary account means any read that selects "the primary account" is undefined when duplicates exist.

**2. Category FK delete behavior.**
`transactions.category_id`, `recipients.default_category_id`, and `planned_transactions.category_id` are nullable optional fields by design. Their FKs to `categories(id)` had no explicit `ON DELETE` clause, so they defaulted to `NO ACTION` (RESTRICT). `categoryRepository.hardDelete` issues a bare `DELETE` with no pre-check, so deleting a category in use raised a raw PostgreSQL error 23503 that surfaced to the client as a 500 Internal Server Error — a poor failure mode for an optional tag-like field.

## Decision

### Migration 0047 — One primary bank account per recipient

1. Demote duplicate primaries: for any recipient that has more than one `is_primary = true` row, set all but the lowest `id` to `false`.
2. Create partial unique index: `CREATE UNIQUE INDEX IF NOT EXISTS uq_recipient_primary_account ON recipient_bank_accounts (recipient_id) WHERE is_primary`.

No application change is required — the app already tried to enforce single-primary; the migration guarantees it. Downgrade drops the index but does not re-promote any demoted rows.

### Migration 0048 — Category FK ON DELETE SET NULL

Drop the existing FK (looked up dynamically by `pg_constraint` so the auto-generated constraint name is not assumed) and recreate it with `ON DELETE SET NULL` on:
- `transactions.category_id`
- `recipients.default_category_id`
- `planned_transactions.category_id`

Deleting a category now silently un-categorizes affected rows, which matches the column already being nullable. History-protecting FKs (`transactions.recipient_id`, `transactions.transfer_peer_id`, etc.) are deliberately left as RESTRICT.

> [!warning] Migration status: AUTHORED, NOT YET APPLIED
> `alembic/versions/0047_one_primary_bank_account_per_recipient.py` and `alembic/versions/0048_category_fk_on_delete_set_null.py` exist in the repository but have not been run against any database. Apply in order: 0047 then 0048 (they are independent but both depend on 0046). Use `bun run db:upgrade`.

## Consequences

**Positive:**
- The "one primary account per recipient" invariant is now enforced by the DB; application code cannot accidentally create a second primary without getting a constraint error.
- Deleting a category no longer crashes with 500; it silently un-categorizes rows, consistent with the field being optional.
- Both changes are blast-radius-minimal: 0047 is a dedup UPDATE + index build on a small table; 0048 is a constraint swap with no row rewrite.

**Negative:**
- The demotion in 0047 is not reversible — the downgrade keeps rows in their demoted state (prior state was invalid).
- ON DELETE SET NULL in 0048 means deleted categories leave `category_id = NULL` without an audit trail. If strict data-integrity semantics are required (preserve the category association history), the alternative RESTRICT+409 path is safer.

**Alternative considered (category FK):** Keep `RESTRICT` explicitly and have `routes/categories.js` translate PostgreSQL error 23503 into a 409 Conflict (`"category in use"`). This preserves the data relationship but requires an app change and may be surprising behavior for an optional field. `SET NULL` was chosen because the reference is optional by design and silently unblocking the delete is less surprising.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/reference/migration-dependencies|Migration Dependencies]] — migrations 0047, 0048 in Group 7
- [[docs/reference/data-model|Data Model Reference]] — RecipientBankAccount, Transaction, Recipient, PlannedTransaction
- [[docs/reference/database-query-patterns|Database Query Patterns]] — Constraint and Index Conventions section
- [[alembic/versions/0047_one_primary_bank_account_per_recipient.py]]
- [[alembic/versions/0048_category_fk_on_delete_set_null.py]]
