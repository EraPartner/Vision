---
title: Database Triggers Reference
type: reference
status: active
date: 2026-04-21
updated: 2026-08-19
tags: [reference, database, triggers, postgresql, phase-1, dual-write-trigger, account-sync, split-guard, migration-0062, adr-088, split-payments, migration-0088, adr-112]
description: Complete reference of all PostgreSQL triggers in the Vision database. 2026-06-25: sync_account_id_from_bank_account() hardened to lookup-only on UPDATE (migration 0062); trg_enforce_split_within_amount BEFORE UPDATE trigger added. 2026-08-19: migration 0088 removes the legacy-only split-payment overpayment trigger before widening its amount column.
aliases: [triggers, database triggers, trigger functions, updated_at triggers]
---

# Database Triggers Reference

> [!abstract] Overview
> All PostgreSQL triggers in the Vision database. Includes `updated_at` auto-update triggers, INSTEAD OF triggers for compatibility views, and any custom triggers.

## Updated At Triggers

These triggers automatically update the `updated_at` column on row modification.

| Trigger Name | Table | Event | Function | Purpose |
|-------------|-------|-------|----------|---------|
| `update_categories_updated_at` | `categories` | BEFORE UPDATE | `update_updated_at_column()` | Auto-update `updated_at` on category changes |
| `update_investments_updated_at` | `investments_base` | BEFORE UPDATE | `update_updated_at_column()` | Auto-update `updated_at` on investment changes |
| `update_recipients_updated_at` | `recipients` | BEFORE UPDATE | `update_updated_at_column()` | Auto-update `updated_at` on recipient changes |
| `update_transactions_updated_at` | `transactions` | BEFORE UPDATE | `update_updated_at_column()` | Auto-update `updated_at` on transaction changes |
| `update_planned_transactions_updated_at` | `planned_transactions` | BEFORE UPDATE | `update_updated_at_column()` | Auto-update `updated_at` on planned transaction changes |
| `update_watchlist_updated_at` | `watchlist` | BEFORE UPDATE | `update_updated_at_column()` | Auto-update `updated_at` on watchlist changes |
| `update_saved_charts_updated_at` | `saved_charts` | BEFORE UPDATE | `update_updated_at_column()` | Auto-update `updated_at` on saved chart changes |

## INSTEAD OF Triggers (Compatibility Views)

These triggers enable write operations on PostgreSQL views that would otherwise be read-only.

| Trigger Name | View/Table | Event | Function | Purpose |
|-------------|-----------|-------|----------|---------|
| `update_investments_view_instead` | `investments` (view) | INSTEAD OF UPDATE | `investments_view_update_trigger()` | Route UPDATE on `investments` compatibility view to `investments_base` + child tables |

> [!info] How INSTEAD OF Triggers Work
> The `investments` view is a compatibility layer that unions all child tables (`stocks_etfs_investments`, `crypto_investments`, `metals_investments`, `real_estate_investments`, `savings_investments`, `bonds_investments`). The INSTEAD OF trigger intercepts UPDATE operations and routes them to the correct underlying table based on the `asset_class` column.

## Migration-Managed Triggers

All triggers are now managed by Alembic migrations (as of Phase 1, 2026-04-21). The legacy `schemaInit.js` was deleted and replaced with Alembic-based schema management ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]).

Special note: `fx_rate_to_eur` column changes are handled by migration `0016_add_fx_rate_to_portfolio_transactions`, which guards the `ALTER TABLE` to only run when `portfolio_transactions` is a base table (not a compatibility view).

## Trigger Function

The standard `update_updated_at_column()` function:

```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';
```

## Account Dual-Write Triggers (ADR-088, migrations 0051 / 0062)

These triggers maintain `account_id` in sync with the denormalized `bank_account` string during the
ADR-088 dual-write phase. They fire on `transactions` and `planned_transactions`.

| Trigger Name | Table | Event | Function | Purpose |
|-------------|-------|-------|----------|---------|
| `trg_sync_account_id_transactions` | `transactions` | BEFORE INSERT/UPDATE | `sync_account_id_from_bank_account()` | Keep `account_id` in sync with `bank_account` |
| `trg_sync_account_id_planned` | `planned_transactions` | BEFORE INSERT/UPDATE | `sync_account_id_from_bank_account()` | Keep `account_id` in sync with `bank_account` |

### `sync_account_id_from_bank_account()` — behavior after migration 0062

| `TG_OP` | Behaviour |
|---------|-----------|
| `INSERT` | Resolve-or-create: inserts a new account row if the label is not found, then sets `NEW.account_id`. Import pipeline relies on this for first-seen accounts. |
| `UPDATE` | **Lookup-only (changed in migration 0062):** resolves `account_id` against an existing account by name. If no account matches the new `bank_account` string, `account_id` is left unchanged. **Never creates a new account on UPDATE.** |

> [!warning] Migration 0062 narrows the UPDATE path
> Before migration 0062 (`0062_trigger_lookup_only_on_update`), UPDATE also ran a resolve-or-create,
> meaning editing a row's `bank_account` to a stale or renamed label silently spawned a phantom
> account. Migration 0062 changes this to lookup-only for UPDATE. Apply with `bun run db:upgrade`.
> See [[docs/adr/088-account-entity|ADR-088 addendum (2026-06-25)]].

## Transaction Split-Guard Trigger (migration 0062)

Prevents a transaction's `amount` from being reduced below the sum of its splits at the DB level,
covering both `PATCH /api/transactions/:id` and direct SQL (e.g., via the DB data editor ADR-101).

| Trigger Name | Table | Event | Function | When fires |
|-------------|-------|-------|----------|-----------|
| `trg_enforce_split_within_amount` | `transactions` | BEFORE UPDATE | `enforce_split_within_amount()` | Only when `NEW.amount IS DISTINCT FROM OLD.amount` |

**Logic:** sums `transaction_splits.amount` for the parent row; raises a PostgreSQL
`check_violation` (`SQLSTATE 23514`) if `split_sum > ABS(NEW.amount) + 0.005` (0.5 cent
tolerance for rounding). The message names the transaction ID, the proposed amount, and the split
total for easy diagnostics.

**Downgrade:** drops `trg_enforce_split_within_amount` and `enforce_split_within_amount()`;
restores the prior resolve-or-create-on-update `sync_account_id_from_bank_account()` function.

**Related code:** [[alembic/versions/0062_trigger_lookup_only_on_update.py]]

## Split-Payment Overpayment Enforcement (migration 0088)

The canonical schema has **no** `trg_split_payment_overpayment_guard` trigger. Fresh databases on
the consolidated migration chain never created it. Older databases can retain it from the
pre-squash migration `0028_split_audit_overpayment_guard`; migration 0088 drops that trigger and
its function before widening `split_payments.amount` to `NUMERIC(18,4)`.

The authoritative cap is `splitRepository.addPayment`: it locks the parent split with
`SELECT ... FOR UPDATE`, recomputes existing payments, compares at four-decimal storage precision,
and inserts, auto-settles, and audits in one transaction. Direct SQL does not receive this guard.
See [[docs/adr/112-retire-legacy-split-overpayment-trigger|ADR-112]].

This does not affect the aggregate-maintenance trigger
`trg_split_payment_outstanding_sync`, which continues to update `agg_split_outstanding` after
payment inserts, updates, and deletes.

## Migration References

| Migration | Trigger Changes |
|-----------|----------------|
| `0001_initial_database_schema` | Creates all initial triggers on base tables |
| `0013_investment_inheritance` | Creates `update_investments_updated_at` on `investments_base` |
| `0014_investments_view_update_trigger` | Creates `update_investments_view_instead` INSTEAD OF trigger |
| `0016_add_fx_rate_to_portfolio_transactions` | Adds `fx_rate_to_eur` column with migration-safe guards |
| `0051_account_id_dual_write_trigger` | Creates `sync_account_id_from_bank_account()` and binds it to `transactions` and `planned_transactions` (ADR-088) |
| `0062_trigger_lookup_only_on_update` | Replaces `sync_account_id_from_bank_account()` with lookup-only-on-UPDATE variant; adds `trg_enforce_split_within_amount` (ADR-088 addendum) |
| `0088_money_precision_alignment` | Removes the pre-squash `trg_split_payment_overpayment_guard`; aggregate-maintenance triggers remain (ADR-112) |

## Related

- [[docs/adr/002-database-schema\|Database Schema ADR]] - Table definitions
- [[docs/adr/027-alembic-single-source-of-schema\|ADR-027: Alembic as Single Source of Schema Truth]] - Migration strategy
- [[docs/adr/088-account-entity\|ADR-088: Account Entity]] - Dual-write trigger rationale
- [[docs/adr/112-retire-legacy-split-overpayment-trigger\|ADR-112: Retire legacy split-payment overpayment trigger]] - Canonical payment-cap enforcement
- [[docs/guides/migrations\|Migration Guide]] - How schema changes are managed
