---
title: Database Triggers Reference
type: reference
status: active
date: 2026-03-31
tags: [reference, database, triggers, postgresql]
description: Complete reference of all PostgreSQL triggers in the Vision database
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

## Schema-Init Triggers

Triggers created by `schemaInit.js` during application startup (not Alembic migrations):

| Trigger | Table | Purpose | Code |
|---------|-------|---------|------|
| `fx_rate_to_eur` column addition | `portfolio_transactions_base` | Adds FX rate column for cross-currency transactions | [[apps/node-backend/src/database/schemaInit.js\|schemaInit.js]] |

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

## Migration References

| Migration | Trigger Changes |
|-----------|----------------|
| `0001_initial_database_schema` | Creates initial triggers on categories, recipients, transactions |
| `0013_investment_inheritance` | Creates `update_investments_updated_at` on `investments_base` |
| `0014_investments_view_update_trigger` | Creates `update_investments_view_instead` INSTEAD OF trigger |
| `0016_add_fx_rate_to_portfolio_transactions` | Adds `fx_rate_to_eur` column via schemaInit.js |

## Related

- [[docs/adr/002-database-schema\|Database Schema ADR]] - Table definitions
- [[docs/guides/migrations\|Migration Guide]] - How schema changes are managed
- [[apps/node-backend/src/database/schemaInit.js\|schemaInit.js]] - Startup trigger creation
