---
title: Schema Initialization Reference
type: reference
status: active
date: 2026-04-02
tags: [reference, database, schema, initialization, postgresql, startup]
description: Reference for the database schema initialization process at application startup
aliases: [schema init, database initialization, table creation, startup schema]
related_code:
  - apps/node-backend/src/database/schemaInit.js
  - apps/node-backend/src/database/connection.js
  - apps/node-backend/src/database/postgresManager.js
---

# Schema Initialization Reference

## Overview

The `schemaInit.js` module handles idempotent database schema initialization at application startup. It ensures all tables, indexes, triggers, and compatibility views exist before the API begins serving requests.

## Architecture

### Initialization Flow

```
Application Start → postgresManager.init() → schemaInit.js
                                              ↓
                                    1. Core tables (CREATE TABLE IF NOT EXISTS)
                                    2. Indexes (CREATE INDEX IF NOT EXISTS)
                                    3. Triggers (CREATE OR REPLACE)
                                    4. Compatibility views
                                    5. Materialized views (via service)
```

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

## Relationship to Alembic Migrations

| Aspect | Schema Init | Alembic Migrations |
|--------|------------|-------------------|
| **Purpose** | Ensure tables exist at startup | Evolve schema over time |
| **When run** | Every application start | Manually via `bun run db:upgrade` |
| **Operations** | CREATE IF NOT EXISTS only | ALTER, DROP, ADD COLUMN, etc. |
| **Idempotent** | Yes | No (forward-only) |
| **Rollback** | N/A (always safe) | Via `bun run db:downgrade` |

**Important**: Schema init does NOT replace migrations. Migrations handle schema evolution (adding columns, changing types, creating indexes). Schema init ensures the baseline tables exist for fresh installations.

## Error Handling

- Missing tables are created silently
- Existing tables are skipped
- Trigger replacements are idempotent
- Failures are logged but do not crash the application (graceful degradation)

## Related Documentation

- [[docs/adr/002-database-schema|Database Schema ADR]] — Schema design decisions
- [[docs/reference/migration-dependencies|Migration Dependencies]] — Migration chain and groups
- [[docs/reference/database-query-patterns|Database Query Patterns]] — PostgreSQL query patterns and optimization
