---
title: Database Migration Guide
type: guide
status: active
date: 2026-04-02
tags: [guide, database, migrations, alembic, postgresql]
description: How to create, run, and manage database migrations using Alembic
aliases: [migration-guide, alembic-guide, database-schema, schema-changes]
related_code: ["alembic/", "alembic/env.py", "config/alembic.ini", "docker-entrypoint.sh"]
---

# Database Migration Guide

Vision uses [Alembic](https://alembic.sqlalchemy.org/) to manage PostgreSQL schema migrations. This guide covers the full lifecycle: creating, running, and troubleshooting migrations.

## Quick Reference

| Command | Script | Description |
|---------|--------|-------------|
| `alembic upgrade head` | `bun run db:upgrade` | Run all pending migrations |
| `alembic revision -m "message"` | `bun run db:revision -- "message"` | Create a new migration |
| `alembic current` | — | Check current schema version |
| `alembic history` | — | View full migration chain |
| `alembic downgrade -1` | — | Rollback last migration |

## How Migrations Work

### Configuration

- **Config file:** `config/alembic.ini` — Alembic settings including database URL
- **Environment file:** `alembic/env.py` — Python script that configures Alembic's runtime behavior:
  - Loads database URL from environment
  - Supports SQLite batch mode for local testing
  - Handles model autogenerate (`--autogenerate` flag)
  - Configures transactional DDL for PostgreSQL
- **Migration directory:** `alembic/versions/` — All migration files live here

### Migration File Format

Each migration is a Python file with two functions:

```python
"""Migration description."""
from alembic import op
import sqlalchemy as sa

revision = '0025_your_migration_name'
down_revision = '0024_per_class_invested_columns'

def upgrade():
    # Schema changes go here
    op.execute("...")

def downgrade():
    # Rollback changes
    op.execute("...")
```

## Creating a New Migration

```bash
# Using the convenience script (recommended)
bun run db:revision -- "add_new_column_to_transactions"

# Or directly with Alembic
alembic revision -m "add_new_column_to_transactions"
```

This creates a new file in `alembic/versions/` with an auto-incrementing number prefix.

### Best Practices

1. **Always provide a downgrade** — Every migration should be reversible
2. **Test both directions** — Run `upgrade` and `downgrade` locally before committing
3. **Don't auto-execute** — Let users run migrations manually; never run them automatically in application code
4. **Use idempotent operations** — Where possible, check if changes already exist before applying
5. **Handle dependencies** — For view/trigger changes, drop dependencies before altering types, then recreate

## Running Migrations

### Local Development

```bash
# Run all pending migrations
bun run db:upgrade

# Or directly
alembic upgrade head
```

### Production (Docker)

Migrations run automatically on container startup via `docker-entrypoint.sh`:

1. Waits for PostgreSQL to be ready
2. Checks if `alembic_version` table exists
3. If exists: fixes column size if needed, then runs `alembic upgrade head`
4. If not exists (fresh DB): skips Alembic, lets `schemaInit.js` bootstrap schema
5. Starts the backend application

To run manually in production:

```bash
docker compose exec app /app/venv/bin/python3 -m alembic -c /app/config/alembic.ini upgrade head
```

### Checking Status

```bash
# Current schema version
alembic current

# Full migration history
alembic history

# Show pending migrations
alembic history --verbose
```

## Rolling Back

```bash
# Rollback one migration
alembic downgrade -1

# Rollback to specific revision
alembic downgrade <revision_id>

# Rollback all (dangerous!)
alembic downgrade base
```

> **Warning:** Downgrading in production may cause data loss. Always backup before rolling back.

## Migration Inventory

| # | Migration | Description |
|---|-----------|-------------|
| 0001 | `initial_database_schema` | Foundation: categories, recipients, transactions, planned_transactions, exchange_rates, raw transaction tables |
| 0002 | `add_url_to_planned_transactions` | Adds `url` field to planned transactions |
| 0003 | `make_recipient_nullable` | Makes recipient_id nullable on transactions |
| 0004 | `portfolio_tables` | Introduces portfolio/investment tracking tables |
| 0005 | `manual_raw_transactions` | Adds manual_raw_transactions for manual entry deduplication |
| 0006 | `price_providers` | Introduces price_provider enum for investment price feeds |
| 0007 | `recipient_merge` | Adds recipient merge capability (primary_recipient_id) |
| 0008 | `drop_custom_raw_transactions` | Drops custom_raw_transactions table |
| 0009 | `transaction_splits` | Adds transaction_splits and split_payments tables |
| 0010 | `investments_municipality_tax_fields` | Adds Belgian tax fields to real estate investments |
| 0011 | `planned_loans` | Adds loan support to planned transactions |
| 0012 | `add_indexes` | Performance indexes on frequently queried columns |
| 0013 | `investment_inheritance` | PostgreSQL table inheritance for investment types |
| 0014 | `investments_view_update_trigger` | UPDATE trigger for investments compatibility view |
| 0015 | `add_gift_portfolio_txn_type` | Adds 'gift' to portfolio_txn_type enum |
| 0016 | `add_fx_rate_to_portfolio_transactions` | Adds fx_rate_to_eur for cross-currency portfolio transactions |
| 0017 | `investment_custom_provider_history` | Custom provider latest/history URL fields, metals view/trigger |
| 0018 | `metals_transactions_inheritance_split` | Splits metals_transactions from stock_transactions inheritance |
| 0019 | `asset_price_history_cache` | Adds asset_price_history table for persisted historical quotes |
| 0020 | `drop_asset_price_history_fk` | Drops FK constraint on asset_price_history |
| 0021 | `update_price_provider_enum` | Swaps coingecko/kraken -> binance in price_provider enum |
| 0022 | `add_kinesis_price_provider_enum` | Adds 'kinesis' to price_provider enum |
| 0023 | `portfolio_performance_snapshots` | Adds portfolio_performance_snapshots table for daily performance data |
| 0024 | `per_class_invested_columns` | Adds per-class invested columns to performance snapshots |
| — | `fix_alembic_version_col` | Infrastructure fix: expands alembic_version.version_num column size |

## Troubleshooting

### Migration Fails Mid-Way

Alembic runs migrations in a transaction by default (PostgreSQL). If a migration fails, the transaction is rolled back automatically. Fix the issue and re-run.

### "Target database is not up to date"

Run `alembic upgrade head` to apply pending migrations.

### Version Conflict

If two developers create migrations with the same down_revision, use `alembic merge` to create a merge migration:

```bash
alembic merge <rev1> <rev2> -m "merge two heads"
```

### Checking What a Migration Does

```bash
# Show SQL that would be executed (dry run)
alembic upgrade head --sql
```

## Related

- [[docs/guides/setup|Setup Guide]] — Local development setup
- [[docs/guides/deployment|Deployment Guide]] — Production deployment with migrations
- [[docs/adr/002-database-schema|ADR-002]] — Database schema design decisions
- [[docs/features/portfolio|Portfolio Feature]] — Migration-heavy feature (0004, 0013-0024)
