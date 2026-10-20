---
title: Schema Initialization Reference
type: reference
status: archived
date: 2026-10-19
updated: 2026-10-19
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
description: Legacy schema initialization reference — ARCHIVED. Schema is now initialized by the Kysely migrator from db/migrations/0001_baseline.sql (ADR-222).
aliases: [schema init, database initialization, table creation, startup schema]
related_code:
  - db/migrations/0001_baseline.sql
  - apps/node-backend/src/database/migrate.ts
  - apps/node-backend/src/main.ts
---

# Schema Initialization Reference (ARCHIVED)

> [!warning] Archived — See ADR-222
> This document describes the legacy `schemaInit.js` system. Phase 1 (2026-04-21) moved schema initialization to Alembic ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]). Since 2026-10-19 the Kysely migrator applies `db/migrations/`, starting with the squashed `0001_baseline.sql`. See [[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]] for the current approach.

## Overview (Legacy)

Previously, `schemaInit.js` handled idempotent database schema initialization at application startup. **This module was deleted in Phase 1.** It ensured all tables, indexes, triggers, and compatibility views existed before the API began serving requests. This responsibility now belongs to `db/migrations/`.

## Current Architecture (Since Phase 1)

Application startup now flows through the Kysely migrator:

```
Application Start → checkConnection() → runMigrations()
                                         ↓
                     Kysely Migrator: 0001_baseline.sql (empty DB, fingerprint check)
                     (an alembic_version DB is refused), then pending NNNN_*.sql files
                                         ↓
                                    refreshMaterializedViews()
```

All schema objects (tables, indexes, triggers, views) are defined in `db/migrations/0001_baseline.sql`
plus later numbered migrations. Runtime materialized views are not in the baseline; the
`materializedViewService` creates them after the backend listens.

### Key Design Principles

1. **Versioned**: Numbered `db/migrations/` files define every supported schema transition.
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

The exact schema inventory is authoritative in `db/migrations/` (the baseline plus later files).
Historical Alembic migration 0087 converted installations that used the ADR-004 inheritance shape
to these flat tables; the baseline contains only the flat shape. The per-bank `*_raw_transactions`
tables in item 10 and 11 are no longer in the baseline; exact source records live in
`transaction_source_records`.

## Trigger Setup

Triggers are created/updated using `CREATE OR REPLACE FUNCTION` and `CREATE OR REPLACE TRIGGER`:

| Trigger                         | Table           | Purpose                                      |
| ------------------------------- | --------------- | -------------------------------------------- |
| `update_investments_updated_at` | investments     | Auto-update the investment modification time |
| Various                         | Multiple tables | Auto-update `updated_at` timestamps          |

## Retired compatibility shape

Historical Alembic migrations 0013 through 0022 supported an `investments` compatibility view over
inheritance tables, and migration 0087 removed that runtime schema fork. The `0001` baseline has no
`legacy_inh_*` rollback copies; only the `adr109_legacy_cleanup_marker` reference row remains.

## Index Strategy

Indexes are created for frequently queried columns:

- **Foreign keys**: `category_id`, `recipient_id`, `investment_id`
- **Date columns**: `transaction_date`, `date` for range queries
- **Search columns**: `normalized_name` for recipient matching
- **Unique constraints**: `currency_code + rate_date` for exchange rates

## Related Documentation

- [[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222: TypeScript migrations with Kysely and one squashed baseline]] — current migration strategy
- [[docs/adr/027-alembic-single-source-of-schema|ADR-027: Alembic as Single Source of Schema Truth]] — superseded Alembic strategy
- [[docs/adr/002-database-schema|ADR-002: Database Schema]] — schema design decisions
- [[docs/guides/migrations|Database Migration Guide]] — how to create and run migrations
