---
title: Schema Initialization Reference
type: reference
status: archived
date: 2026-08-30
updated: 2026-09-04
tags:
  [
    reference,
    database,
    schema,
    initialization,
    postgresql,
    startup,
    archived,
    phase-1,
  ]
description: Legacy schema initialization reference — ARCHIVED. Schema is now initialized by Alembic migrations (ADR-027).
aliases: [schema init, database initialization, table creation, startup schema]
related_code:
  - alembic/versions/0001_initial_database_schema.py
  - apps/node-backend/src/database/migrate.js
  - apps/node-backend/src/main.js
---

# Schema Initialization Reference (ARCHIVED)

> [!warning] Archived — See ADR-027
> This document describes the legacy `schemaInit.js` system. As of Phase 1 (2026-04-21), schema initialization is managed entirely by Alembic. See [[docs/adr/027-alembic-single-source-of-schema|ADR-027]] for the current approach.

## Overview (Legacy)

Previously, `schemaInit.js` handled idempotent database schema initialization at application startup. **This module was deleted in Phase 1.** It ensured all tables, indexes, triggers, and compatibility views existed before the API began serving requests. This responsibility now belongs to Alembic migrations.

## Current Architecture (Since Phase 1)

Application startup now flows through Alembic:

```
Application Start → checkConnection() → runMigrations()
                                         ↓
                              guarded Alembic upgrade to head
                                         ↓
                                    refreshMaterializedViews()
```

All schema objects (tables, indexes, triggers, views) are defined in `alembic/versions/0001_initial_database_schema.py` (baseline) plus subsequent versioned migrations.

### Key Design Principles

1. **Versioned**: Alembic revisions define every supported schema transition.
2. **Guarded**: Destructive or shape-changing revisions validate their preconditions before writing.
3. **Order-dependent**: Tables are created in dependency order (referenced tables first).
4. **Canonical at head**: The migration chain converges every supported install on one schema shape.

## Table Creation Order

Tables are created in this order to respect foreign key dependencies:

1. **categories** — No dependencies
2. **recipients** — References categories (optional FK)
3. **recipient_bank_accounts** — References recipients
4. **transactions** — References categories, recipients
5. **planned_transactions** — References categories, recipients
6. **investments** — Canonical flat investment table for every asset class
7. **portfolio_transactions** — Canonical flat lot and cash-event table; references investments
8. **asset_price_history** — References investments by identifier
9. **watchlist** — Independent table
10. **raw_transactions** (bank-specific tables) — For audit trail
11. **manual_raw_transactions** — For manual transaction dedup
12. **transaction_splits** — References transactions
13. **split_payments** — References transaction_splits
14. **saved_charts** — Independent table
15. **settings** — JSONB key-value storage
16. **exchange_rates** — Currency exchange rates
17. **belgian_inflation_rates** — Belgian monthly inflation data
18. **portfolio_performance_snapshots** — Daily portfolio snapshots

The exact head-schema inventory is authoritative in the Alembic migration chain. Migration 0087
converts installations that previously used the ADR-004 inheritance shape to these flat tables.

## Trigger Setup

Triggers are created/updated using `CREATE OR REPLACE FUNCTION` and `CREATE OR REPLACE TRIGGER`:

| Trigger                         | Table           | Purpose                                      |
| ------------------------------- | --------------- | -------------------------------------------- |
| `update_investments_updated_at` | investments     | Auto-update the investment modification time |
| Various                         | Multiple tables | Auto-update `updated_at` timestamps          |

## Retired compatibility shape

Migrations 0013 through 0022 contain historical support for an `investments` compatibility view
over inheritance tables. Migration 0087 removes that runtime schema fork. The old relations may
remain under `legacy_inh_*` names only as rollback copies until the operator runs the guarded
cleanup in `alembic/manual/drop_adr109_legacy_relations/` after verifying a restorable backup.

## Index Strategy

Indexes are created for frequently queried columns:

- **Foreign keys**: `category_id`, `recipient_id`, `investment_id`
- **Date columns**: `transaction_date`, `date` for range queries
- **Search columns**: `normalized_name` for recipient matching
- **Unique constraints**: `currency_code + rate_date` for exchange rates

## Related Documentation

- [[docs/adr/027-alembic-single-source-of-schema|ADR-027: Alembic as Single Source of Schema Truth]] — current migration strategy
- [[docs/adr/002-database-schema|ADR-002: Database Schema]] — schema design decisions
- [[docs/guides/migrations|Database Migration Guide]] — how to create and run migrations
