---
title: Schema Initialization Reference
type: reference
status: archived
date: 2026-04-21
tags: [reference, database, schema, initialization, postgresql, startup, archived, phase-1]
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
                                    alembic upgrade head
                                         ↓
                                    refreshMaterializedViews()
```

All schema objects (tables, indexes, triggers, views) are defined in `alembic/versions/0001_initial_database_schema.py` (baseline) plus subsequent versioned migrations.

### Key Design Principles

1. **Idempotent**: All operations use `IF NOT EXISTS` or `CREATE OR REPLACE`
2. **Non-destructive**: Never drops or alters existing tables
3. **Order-dependent**: Tables are created in dependency order (referenced tables first)
4. **Compatibility**: Creates views for backward compatibility when column names change

## Table Creation Order

Tables are created in this order to respect foreign key dependencies:

1. **categories** — No dependencies
2. **recipients** — References categories (optional FK)
3. **recipient_bank_accounts** — References recipients
4. **transactions** — References categories, recipients
5. **planned_transactions** — References categories, recipients
6. **investments_base** — Base table for inheritance
7. **stocks_etfs_investments** — Inherits from investments_base
8. **crypto_investments** — Inherits from investments_base
9. **real_estate_investments** — Inherits from investments_base
10. **savings_investments** — Inherits from investments_base
11. **bonds_investments** — Inherits from investments_base
12. **metals_investments** — Inherits from investments_base
13. **portfolio_transactions** — References investments_base
14. **asset_price_history** — References investments_base
15. **watchlist** — Independent table
16. **raw_transactions** (bank-specific tables) — For audit trail
17. **manual_raw_transactions** — For manual transaction dedup
18. **transaction_splits** — References transactions
19. **split_payments** — References transaction_splits
20. **saved_charts** — Independent table
21. **settings** — JSONB key-value storage
22. **exchange_rates** — Currency exchange rates
23. **belgian_inflation_rates** — Belgian monthly inflation data
24. **portfolio_performance_snapshots** — Daily portfolio snapshots

## Trigger Setup

Triggers are created/updated using `CREATE OR REPLACE FUNCTION` and `CREATE OR REPLACE TRIGGER`:

| Trigger | Table | Purpose |
|---------|-------|---------|
| `investments_update` | investments_base | Propagates updates to child tables via inheritance |
| Various | Multiple tables | Auto-update `updated_at` timestamps |

## Compatibility Views

When column names change (e.g., `date` → `transaction_date`), compatibility views are created to maintain backward compatibility for older API clients.

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

