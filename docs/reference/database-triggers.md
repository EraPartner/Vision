---
title: Database Triggers Reference
type: reference
status: active
date: 2026-11-03
updated: 2026-11-03
tags:
  [
    reference,
    database,
    triggers,
    sqlite,
    phase-1,
    dual-write-trigger,
    account-sync,
    split-guard,
    migration-0062,
    adr-088,
    split-payments,
    migration-0088,
    adr-112,
  ]
description: Complete reference of the SQLite triggers in the Vision database (ADR-263). Migration 0087 retires the investment inheritance compatibility view and its INSTEAD OF trigger; migration 0088 removes the legacy-only split-payment overpayment trigger.
aliases: [triggers, database triggers, trigger functions, updated_at triggers]
---

# Database Triggers Reference

> [!abstract] Overview
> The triggers in the canonical Vision database, `db/migrations/0001_baseline.sql`. Includes
> `updated_at` triggers, split guards, aggregate maintenance, and historical notes for retired
> PostgreSQL triggers.
>
> SQLite triggers are row-level (`FOR EACH ROW`), and their bodies are SQL statements, not PL/pgSQL
> functions. A PostgreSQL trigger that fired on several events became one SQLite trigger per event,
> named with a `__insert`, `__update` or `__delete` suffix. A `BEFORE` trigger that assigned
> `NEW.<column>` became an `AFTER` trigger that updates the row, because a SQLite `BEFORE` trigger
> cannot change `NEW`. `RETURNING` does not see what an `AFTER` trigger writes
> ([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]],
> [[docs/reference/sqlite-sql-dialect|SQLite SQL dialect]]). Connections run with
> `recursive_triggers` off.

## Updated At Triggers

These triggers automatically update the `updated_at` column on row modification. The baseline
has one pair for each of 27 tables. Examples:

| Trigger Name                             | Table                  | Event         | Purpose                                                 |
| ---------------------------------------- | ---------------------- | ------------- | ------------------------------------------------------- |
| `update_categories_updated_at`           | `categories`           | AFTER UPDATE  | Auto-update `updated_at` on category changes            |
| `update_investments_updated_at`          | `investments`          | AFTER UPDATE  | Auto-update `updated_at` on investment changes          |
| `update_recipients_updated_at`           | `recipients`           | AFTER UPDATE  | Auto-update `updated_at` on recipient changes           |
| `update_transactions_updated_at`         | `transactions`         | AFTER UPDATE  | Auto-update `updated_at` on transaction changes         |
| `update_pt_updated_at`                   | `planned_transactions` | AFTER UPDATE  | Auto-update `updated_at` on planned transaction changes |
| `update_watchlist_updated_at`            | `watchlist`            | AFTER UPDATE  | Auto-update `updated_at` on watchlist changes           |
| `update_saved_charts_updated_at`         | `saved_charts`         | AFTER UPDATE  | Auto-update `updated_at` on saved chart changes         |
| `update_<name>_updated_at__insert_not_null` | each of those tables | BEFORE INSERT | Refuses an explicit `NULL` `updated_at` with SQLSTATE `23502` |

The Kysely write plugin also sets `updated_at = now()` in the statement itself, so `RETURNING`
sees the same value.

## Retired INSTEAD OF trigger

Migration 0014 historically made the inheritance-backed `investments` compatibility view writable
through `update_investments_view_instead`. Migration 0087 converts that layout to the canonical
flat `investments` table and removes the function and trigger from the supported head schema.

## Migration-Managed Triggers

All triggers are managed by `db/migrations/` (the `0001_baseline.sql` schema plus later numbered files) through the SQLite migration runner ([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]). Phase 1 (2026-04-21) had deleted the legacy `schemaInit.js` in favour of Alembic ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]); migration numbers on this page are historical Alembic revisions whose result the baseline contains.

Historical note: migration `0016_add_fx_rate_to_portfolio_transactions` guarded its `ALTER TABLE`
by relation kind because installations could still have the retired compatibility view at that
point in the upgrade path. Migration 0087 later converges those installs on the flat table.

## Trigger Function

SQLite has no trigger functions. Each `updated_at` trigger carries its own body, for example:

```sql
CREATE TRIGGER update_transactions_updated_at
AFTER UPDATE ON transactions FOR EACH ROW
WHEN NEW.updated_at IS NOT now()
BEGIN
  UPDATE transactions SET updated_at = now() WHERE rowid = NEW.rowid;
END;
```

`now()` is the transaction start time, so the `WHEN` clause skips the inner update when the
statement already set `updated_at`. The PostgreSQL build used one shared
`update_updated_at_column()` function that assigned `NEW.updated_at` in a `BEFORE UPDATE` trigger.

An `AFTER` trigger runs after the row is written, so `RETURNING` would still show the old
`updated_at`. Kysely updates therefore set `updated_at = now()` through the write plugin
(`apps/node-backend/src/database/writePlugin.ts`), and hand-written SQL sets it in the statement.

## Account Dual-Write Triggers (ADR-088, migrations 0051 / 0062)

> [!note] Removed by the ADR-088 contract
> These dual-write triggers and `sync_account_id_from_bank_account()` are not in the `0001`
> baseline: the contract removed `bank_account` from both tables. The section below is history.

These triggers maintained `account_id` in sync with the denormalized `bank_account` string during the
ADR-088 dual-write phase. They fired on `transactions` and `planned_transactions`.

| Trigger Name                       | Table                  | Event                | Function                              | Purpose                                       |
| ---------------------------------- | ---------------------- | -------------------- | ------------------------------------- | --------------------------------------------- |
| `trg_sync_account_id_transactions` | `transactions`         | BEFORE INSERT/UPDATE | `sync_account_id_from_bank_account()` | Keep `account_id` in sync with `bank_account` |
| `trg_sync_account_id_planned`      | `planned_transactions` | BEFORE INSERT/UPDATE | `sync_account_id_from_bank_account()` | Keep `account_id` in sync with `bank_account` |

### `sync_account_id_from_bank_account()` — behavior after migration 0062

| `TG_OP`  | Behaviour                                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSERT` | Resolve-or-create: inserts a new account row if the label is not found, then sets `NEW.account_id`. Import pipeline relies on this for first-seen accounts.                                                                             |
| `UPDATE` | **Lookup-only (changed in migration 0062):** resolves `account_id` against an existing account by name. If no account matches the new `bank_account` string, `account_id` is left unchanged. **Never creates a new account on UPDATE.** |

> [!warning] Migration 0062 narrows the UPDATE path
> Before migration 0062 (`0062_trigger_lookup_only_on_update`), UPDATE also ran a resolve-or-create,
> meaning editing a row's `bank_account` to a stale or renamed label silently spawned a phantom
> account. Migration 0062 changed this to lookup-only for UPDATE.
> See [[docs/adr/088-account-entity|ADR-088 addendum (2026-06-25)]].

## Transaction Split-Guard Trigger (migration 0062)

Prevents a transaction's `amount` from being reduced below the sum of its splits at the DB level,
covering both `PATCH /api/transactions/:id` and direct SQL (e.g., via the DB data editor ADR-101).

| Trigger Name                      | Table          | Event         | Function                        | When fires                                         |
| --------------------------------- | -------------- | ------------- | ------------------------------- | -------------------------------------------------- |
| `trg_enforce_split_within_amount` | `transactions` | BEFORE UPDATE | (trigger body) | Only when `dec_ne(NEW.amount, OLD.amount)` |

**Logic:** sums `transaction_splits.amount` for the parent row with `dec_sum`; raises
`SQLSTATE 23514` (`check_violation`) through `vision_raise` if
`dec_gt(split_sum, dec_add(dec_abs(NEW.amount), '0.005'))` (0.5 cent tolerance for rounding).
It stays a `BEFORE` trigger because it only refuses the row. The message names the transaction ID, the proposed amount, and the split
total for easy diagnostics.

**Downgrade:** drops `trg_enforce_split_within_amount` and `enforce_split_within_amount()`;
restores the prior resolve-or-create-on-update `sync_account_id_from_bank_account()` function.

**Related code:** `0062_trigger_lookup_only_on_update`

## Split-Payment Overpayment Enforcement (migration 0088)

The canonical schema has **no** `trg_split_payment_overpayment_guard` trigger. Fresh databases on
the consolidated migration chain never created it. Older databases can retain it from the
pre-squash migration `0028_split_audit_overpayment_guard`; migration 0088 drops that trigger and
its function before widening `split_payments.amount` to `NUMERIC(18,4)`.

The authoritative cap is `splitService.addPayment`: inside one `BEGIN IMMEDIATE` write transaction
on the single writer it reads the parent split, recomputes existing payments, compares at
four-decimal storage precision, and inserts and auto-settles. No other writer can run between the
check and the insert. Direct SQL does not receive this guard.
See [[docs/adr/112-retire-legacy-split-overpayment-trigger|ADR-112]].

This does not affect the aggregate-maintenance triggers
`trg_split_payment_outstanding_sync__insert`, `__update` and `__delete`, which continue to update
`agg_split_outstanding` after payment inserts, updates, and deletes. The matching
`trg_split_outstanding_sync__insert`, `__update` and `__delete` on `transaction_splits` keep it in
step with split changes.

## Portfolio history receipt, custody, and adjustment guards (0120–0123)

| Trigger | Table / event | Contract |
| ------- | ------------- | -------- |
| `portfolio_asset_transfers_immutable` | Custody ledger, BEFORE UPDATE | Rejects editing canonical custody; application rollback can delete only after projected-history validation |
| `portfolio_asset_adjustments_immutable` | Adjustment ledger, BEFORE UPDATE | Rejects editing canonical unit removals; application rollback validates remaining history before removal |
| `portfolio_asset_adjustment_sources_immutable` | Adjustment source links, BEFORE UPDATE/DELETE | Rejects updates and direct deletes; permits deletion only by cascade after parent adjustment removal |
| `portfolio_income_active_pair_guard` | `portfolio_transactions`, BEFORE UPDATE/DELETE | Rejects changing or deleting a transaction named by an active paired-income record |

The receipt triggers `portfolio_import_reconciliation_immutable`,
`portfolio_import_reconciliation_valid_receipt` and `portfolio_duplicate_repair_receipt_guard`
were dropped by Vision 2.0 migration `0005_simplify_portfolio_reconciliation`
([[docs/adr/236-simplify-portfolio-import-reconciliation|ADR-236]]) and are not in the SQLite
baseline. The guards in the table raise SQLSTATE `P0001` with `RAISE(ABORT, ...)`.

The journal retains the financial ID without a financial foreign key. Its source batch/staging
foreign keys restrict pruning. These guards preserve domain receipts. See [[docs/reference/data-model]],
[[docs/features/portfolio-import]], and
[[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger]] for application compare-and-set,
source retention, and downgrade limits.

## Migration References

| Migration                                    | Trigger Changes                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_initial_database_schema`               | Creates all initial triggers on base tables                                                                                                  |
| `0013_investment_inheritance`                | Historical: moved `update_investments_updated_at` to `investments_base`                                                                      |
| `0014_investments_view_update_trigger`       | Historical: created the `update_investments_view_instead` INSTEAD OF trigger                                                                 |
| `0016_add_fx_rate_to_portfolio_transactions` | Adds `fx_rate_to_eur` column with migration-safe guards                                                                                      |
| `0051_account_id_dual_write_trigger`         | Creates `sync_account_id_from_bank_account()` and binds it to `transactions` and `planned_transactions` (ADR-088)                            |
| `0062_trigger_lookup_only_on_update`         | Replaces `sync_account_id_from_bank_account()` with lookup-only-on-UPDATE variant; adds `trg_enforce_split_within_amount` (ADR-088 addendum) |
| `0087_flat_investments_conversion`           | Restores the timestamp trigger on flat `investments`; removes the inheritance-view trigger and function (ADR-109)                            |
| `0088_money_precision_alignment`             | Removes the pre-squash `trg_split_payment_overpayment_guard`; aggregate-maintenance triggers remain (ADR-112)                                |
| `0004_remove_audit_history`                  | Drops the audit-chain tables with their append-only triggers and `audit_chain_reject_mutation()` ([[docs/adr/231-remove-audit-history\|ADR-231]]) |

## Related

- [[docs/adr/002-database-schema\|Database Schema ADR]] - Table definitions
- [[docs/adr/263-sqlite-replaces-postgresql\|ADR-263: SQLite replaces PostgreSQL]] - Current database and migration runner
- [[docs/adr/222-typescript-migrations-kysely-baseline\|ADR-222: TypeScript migrations with Kysely]] - Earlier migration strategy
- [[docs/adr/027-alembic-single-source-of-schema\|ADR-027: Alembic as Single Source of Schema Truth]] - Superseded migration strategy
- [[docs/adr/088-account-entity\|ADR-088: Account Entity]] - Dual-write trigger rationale
- [[docs/adr/112-retire-legacy-split-overpayment-trigger\|ADR-112: Retire legacy split-payment overpayment trigger]] - Canonical payment-cap enforcement
- [[docs/guides/migrations\|Migration Guide]] - How schema changes are managed
