---
title: Database Migration Guide
type: guide
status: active
date: 2026-04-21
updated: 2026-08-09
tags: [guide, database, migrations, alembic, postgresql, phase-1, destructive-ddl, ci, performance]
description: How to create, run, and manage database migrations using Alembic
aliases: [migration-guide, alembic-guide, database-schema, schema-changes]
related_code: ["alembic/", "alembic/env.py", "alembic/manual/", "alembic/script.py.mako", "config/alembic.ini", "docker-entrypoint.sh", "scripts/check-destructive-migrations.py", "apps/node-backend/src/database/migrate.js"]
---

# Database Migration Guide

Vision uses [Alembic](https://alembic.sqlalchemy.org/) to manage PostgreSQL schema migrations. This guide covers the full lifecycle: creating, running, and troubleshooting migrations.

## Quick Reference

| Command | Script | Description |
|---------|--------|-------------|
| `alembic upgrade head` | `bun run db:upgrade` | Run all pending migrations |
| `alembic revision -m "message"` | `bun run db:revision -- "message"` | Create a new migration |
| `alembic current` | `bun run db:current` | Check current schema version |
| `alembic history` | `bun run db:history` | View full migration chain |
| `alembic downgrade -1` | `bun run db:downgrade` | Rollback last migration |

> [!warning] Don't invoke bare `alembic` for anything that writes the version table
> Alembic auto-creates `alembic_version.version_num` as `VARCHAR(32)`, which is too narrow for this chain's revision ids — a fresh database dies on revision 3 with `value too long for type character varying(32)`. The `db:migrate`/`db:upgrade`/`db:downgrade`/`db:stamp`/`db:reset` scripts route through `apps/node-backend/scripts/db-migrate.js`, which runs the boot-path `VARCHAR(64)` preflight first. See [[docs/reference/scripts|Scripts Reference]].

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
3. **Assume it runs unattended** — `docker-entrypoint.sh` runs `alembic upgrade head` on every container start, so anything in `alembic/versions/` applies to every installation on the next restart, before the coupled code necessarily ships. Never write a migration whose safety depends on someone choosing when to run it; application code must not trigger migrations either
4. **Use idempotent operations** — Where possible, check if changes already exist before applying
5. **Handle dependencies** — For view/trigger changes, drop dependencies before altering types, then recreate
6. **Mark destructive DDL** — Anything that drops or retypes needs a `destructive-ok:` marker, or it belongs out-of-band; see [[#destructive-ddl-and-the-destructive-ok-marker|below]]
7. **Bound the cost** — The upgrade runs inside the boot window, before the backend listens. Anything O(table) on `transactions` or `asset_price_history` needs the shapes in [[#cost-migrations-run-inside-the-boot-window|Cost]] below

## Destructive DDL and the `destructive-ok` marker

> [!danger] Migrations in `alembic/versions/` auto-apply on boot
> `docker-entrypoint.sh` runs `alembic upgrade head` **unconditionally on every container start**. A migration is therefore not "shipped when someone runs it" — it reaches every self-hosted database on the next restart, *whether or not the application code that depends on it has been deployed*. There is no soak window, no staging tier, and no DBA in the loop.

This is not hypothetical. `0055_drop_bank_account_string` was written as a "gated, apply-after-soak" contract-phase migration and dropped `transactions.bank_account`, `planned_transactions.bank_account`, the dual-write trigger and `mv_bank_balances`. Because it sat in the chain, it applied immediately — without the coupled read/write code — and **crashed startup**. `0055` is now a no-op, `0056_restore_bank_account_after_premature_drop` is its recovery, and the doctrine is recorded in [[docs/adr/088-account-entity|ADR-088]].

### The rule

Destructive DDL inside `upgrade()` must carry a marker on (or within a few lines above) the statement:

```python
def upgrade() -> None:
    # destructive-ok: mv is derived-only and rebuilt by materializedViewService on the
    # same boot; its last reader was removed in this release (ADR-094).
    op.execute("DROP MATERIALIZED VIEW IF EXISTS mv_example CASCADE;")
```

Inside a raw-SQL string, use the SQL comment form — both are accepted:

```python
    op.execute("""
        -- destructive-ok: feature removed app-wide in the same release; no readers remain.
        DROP TABLE legacy_thing;
    """)
```

The reason is free text (minimum 10 characters, so `# destructive-ok: ok` does not count) and should cite an ADR, a runbook, or the migration that made the drop safe. The marker is **not** a rubber stamp — it exists to force one question at authoring time:

> Does the code that stops reading this ship **before** this migration auto-applies on a user's machine?

If the answer is no, **do not add a marker** — the change does not belong in the chain at all.

### The escape hatch: `alembic/manual/`

A destructive change whose safety depends on code being deployed first goes in `alembic/manual/<name>/` as `up.sql` + `down.sql` + a `README.md` stating the preconditions. Alembic never sees that directory (it is not in `version_locations`), so nothing auto-applies it; the user or maintainer runs it by hand in lockstep with the code. `alembic/manual/contract_drop_bank_account/` is the worked example — it is the ADR-088 contract phase that `0055` should have been.

### What is flagged

The checker is `scripts/check-destructive-migrations.py`, enforced by the `verify-destructive-migrations` CI job (parallel to `verify-compose-sync`) and runnable locally with `bun run db:check-destructive`.

| Flagged | Not flagged |
|---------|-------------|
| `op.drop_table` / `DROP TABLE` (always — recreating still loses rows) | `DROP INDEX` / `op.drop_index` — rebuildable, holds no data |
| `op.drop_column` / `DROP COLUMN` (always) | `DROP CONSTRAINT` / `op.drop_constraint` — loosens the schema, destroys nothing |
| `DROP MATERIALIZED VIEW` / `VIEW` / `TRIGGER` / `FUNCTION` / `TYPE` — *unless the same `upgrade()` recreates an object of that name* (DROP-then-CREATE is a replace, not a destruction) | `DROP DEFAULT` / `DROP NOT NULL` |
| `op.alter_column(..., type_=...)` and raw `ALTER COLUMN ... TYPE` — **always**, widening or not | anything inside `downgrade()` — the rollback path is destructive by definition |
| | `alembic/legacy_versions/` and `alembic/manual/` — neither auto-applies |

Type changes are flagged unconditionally because static analysis cannot tell `NUMERIC(15,2) → NUMERIC(18,4)` (safe) from `NUMERIC(18,4) → NUMERIC(8,2)` (silent truncation). Writing the marker is cheaper than the checker guessing wrong.

Migrations that shipped before this gate existed carry retroactive markers recording *why they were safe at the time* — they are annotations, not new permissions. The marker binds to a statement, not to a file, so adding a new drop to an old migration is still caught.

Self-test the checker with `python3 scripts/check-destructive-migrations.py --self-test`; list current findings without failing with `--list`.

## Cost: migrations run inside the boot window

There is no checker for this one — the cost of a statement is not visible to static analysis, and a full-table rewrite that is instant on the demo corpus is minutes on a real install. It is on the author.

> [!warning] The upgrade is on the critical path to a usable app
> `main.js` awaits `runMigrations()` **before** `app.listen()`, so nothing answers `/health` until the whole pending chain has applied. The packaged Electron shell polls that endpoint with a 60 s budget and shows an error page when it runs out ([[packaging/electron/main.js|main.js]] `pollReady`). A cold or big-jump upgrade stacks every pending migration into that one window.

The costs are paid **once**, on the first boot after an update (`migrate.js` caches "already at head" keyed on revision + a fingerprint of `alembic/versions/`, and skips the alembic invocation entirely on every later boot). That is not a reason to ignore them: the one boot that pays is the one the user is watching.

### What the runner already gives you

- **Per-migration transactions.** `alembic/env.py` passes `transaction_per_migration=True` on PostgreSQL, so each migration commits on its own. A kill mid-chain loses only the in-flight migration; the next boot resumes from the last committed revision instead of re-running everything.
- **A 10-minute execFile budget, overridable.** `migrate.js` defaults to `600_000` ms and honours `VISION_MIGRATE_TIMEOUT_MS` (`0` disables it). Because progress is durable per-migration, a timeout mid-chain is a pause, not a rollback.
- **`autocommit_block()`.** Since each migration owns its transaction, `op.get_context().autocommit_block()` can suspend it for statements PostgreSQL refuses to run transactionally — `CREATE INDEX CONCURRENTLY` above all. Everything inside such a block must be individually idempotent: it is already committed if a later statement fails.
- **A post-migration `ANALYZE`.** After a real (non-cached) upgrade, `migrate.js` ANALYZEs `transactions` and `asset_price_history`, so a migration that rewrote either one does not hand the planner stale statistics. Any *other* table you rewrite in full is yours to `ANALYZE`.

### The expensive shapes, and what to write instead

**Adding a CHECK or FK constraint.** `ADD CONSTRAINT ... CHECK (...)` validates against every existing row under `ACCESS EXCLUSIVE` — a full scan that blocks all access, paid even when the constraint only widens an allowed-value list. Add it `NOT VALID` (new and updated rows are enforced immediately, existing rows are not scanned), then `VALIDATE CONSTRAINT` separately: validation takes only `SHARE UPDATE EXCLUSIVE`, so writers keep running.

```python
op.execute("""
    ALTER TABLE transactions
        ADD CONSTRAINT chk_transactions_currency_iso
        CHECK (currency ~ '^[A-Z]{3}$') NOT VALID
""")
# …later, ideally in a follow-up migration:
op.execute("ALTER TABLE transactions VALIDATE CONSTRAINT chk_transactions_currency_iso")
```

`0046_currency_integrity` + `0049_validate_currency_checks` is the worked pair. Note what 0049 also does: it wraps the `VALIDATE` in a `DO` block that catches `check_violation`, because a bare failure would abort boot and strand an end user at the Electron error page with psql-only recovery. A validation that can legitimately fail on real data belongs inside that guard.

**`SET NOT NULL`.** On its own this is a full verification scan under `ACCESS EXCLUSIVE`. PostgreSQL will skip that scan if an *already-validated* `CHECK (col IS NOT NULL)` exists on the table, so on a big table the cheap route is: add `CHECK (col IS NOT NULL) NOT VALID` → `VALIDATE CONSTRAINT` (non-blocking) → `SET NOT NULL` (instant) → drop the now-redundant CHECK. `0022_updated_at_not_null_defaults` is the counter-example: nine tables, a full-row `UPDATE` backfill followed by a bare `SET NOT NULL`, and it is the single heaviest touch of `asset_price_history` in the chain.

**Backfilling a column.** A single `UPDATE` over a large table rewrites every row into a new tuple version, writes the whole table to WAL, maintains every index on it, and holds one long transaction the whole time. Batch it over id ranges inside an `autocommit_block()`, with a guard that makes each batch idempotent so an interrupted run resumes:

```python
with op.get_context().autocommit_block():
    bind = op.get_bind()
    bounds = bind.execute(sa.text("SELECT min(id) AS lo, max(id) AS hi FROM transactions")).one()
    if bounds.lo is not None:
        lo = bounds.lo
        while lo <= bounds.hi:
            hi = lo + BACKFILL_BATCH_SIZE - 1
            bind.execute(sa.text("""
                UPDATE transactions t SET account_id = ...
                 WHERE t.id BETWEEN :lo AND :hi
                   AND t.account_id IS NULL     -- resume guard
            """), {"lo": lo, "hi": hi})
            lo = hi + 1
```

`0050_add_accounts_entity` is the worked example (50 000-row id ranges; the `IS NULL` guard makes an interrupted backfill resume where it stopped on the next boot, and the range keying keeps every batch a cheap PK range scan however sparse the id space is).

**Building an index.** A plain `CREATE INDEX` scans the heap under a `SHARE` lock that blocks writes for the duration — true even for a tiny partial index, because the *heap* scan is what costs (`0036`, `0044`, `0053` all pay this). Use `CREATE INDEX CONCURRENTLY` inside an `autocommit_block()`. Note the caveat `IF NOT EXISTS` does not cover: an interrupted concurrent build leaves an **INVALID** index behind that `IF NOT EXISTS` would happily keep forever. Copy `_create_index_concurrently()` from `0050_add_accounts_entity`, which checks `pg_index.indisvalid`, keeps a valid index, drops an invalid one, and only then rebuilds. Also: build indexes *after* a backfill, never before — otherwise every batch pays index maintenance.

**Changing a column type.** `ALTER COLUMN ... TYPE` rewrites the table *and* every index on it under `ACCESS EXCLUSIVE`, and drops dependent views first (`0025_fix_numeric_precision` retypes `transactions.amount` and has to drop and recreate the materialized views around it). There is no cheap in-place variant. If the change is avoidable, avoid it; if it is not, expect the rewrite and `ANALYZE` afterwards.

**Materialized views.** Do not rebuild them from a migration. `DROP MATERIALIZED VIEW` alone is metadata-only; the runtime service (`materializedViewService.js`) recreates and populates any missing view from the **post-listen** warmup, off the boot critical path, and reads fall back to live queries in the meantime. `0084` and `0085` are the pattern: drop only, let the app rebuild. A migration that recreates a view instead puts a full aggregation scan of `transactions` back in front of `/health`.

**Anti-join deletes.** `DELETE ... WHERE x NOT IN (SELECT ...)` before adding an FK (as `0026_asset_price_history_fk` does) is O(table) on both sides. Fine when the migration is guarded to fresh-baseline installs where the table is small — say so in the docstring when it is, so the next reader does not have to re-derive it.

### Nothing to do for migrations already in the chain

`alembic/versions/` is append-only history: an applied migration must never be edited, and the costs above have already been paid by every install past them. This section is for the next migration.

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
2. Runs `alembic upgrade head` unconditionally (bootstraps fresh DB via baseline migration 0001, or applies pending migrations to existing DB)
3. Starts the backend application

**Note:** As of Phase 1 (2026-04-21), `schemaInit.js` has been removed. Alembic is now the single source of schema DDL ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]).

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

## Baseline (0001) Schema Scope

The `0001_initial_database_schema` baseline includes the complete foundational schema from the legacy monolithic initialization:

- **Core transaction tables:** categories, recipients, transactions, planned_transactions, transaction_raw_references
- **Planned transaction support:** planned_transaction_executions, planned_transaction_loan_schedule
- **Raw bank import tables:** belfius, revolut, kbc, sabb, wise, vision, custom, manual (PostgreSQL table inheritance hierarchy)
- **Portfolio & investment:** investments (base table with stock, etf, metals, crypto, real_estate, bond, savings child tables via inheritance), asset_price_history, portfolio_transactions, watchlist
- **Financial data:** exchange_rates, belgian_inflation_rates
- **User configuration:** user_settings, saved_charts
- **AI conversation:** ai_conversations, ai_messages
- **Import pipeline staging:** **import_batches, import_staging_rows** (ported from legacy 0030)
- **Support:** All enums, indexes, triggers, helper functions, and extensions

**Note:** As of 2026-04-27, the 0001 baseline includes import pipeline staging tables (`import_batches`, `import_staging_rows`) to fix migration ordering bugs. This ensures migrations 0003 and 0015+ have required FK targets on fresh DB installs.

**Note on alembic_version column:** The `alembic_version` table is preflight-created at `VARCHAR(64)` to accommodate modern revision names (e.g., `0003_import_batch_id_on_transactions` = 38 chars). See [[docs/adr/027-alembic-single-source-of-schema#follow-up-migration-ordering-bugs-fixed-2026-04-27|ADR-027 follow-up]].

## Migration Inventory

The ordered migration chain changes whenever a schema revision lands. Treat
[`alembic/versions/`](../../alembic/versions/) and `alembic history` as the current inventory rather
than copying a partial list into this guide. Migration `0001_initial_database_schema.py` remains the
baseline described above; every later revision declares its predecessor through `down_revision`.

## Troubleshooting

### Migration Fails Mid-Way

On PostgreSQL each migration runs in its **own** transaction (`env.py` sets `transaction_per_migration=True`), so a failure rolls back only the migration that failed — everything before it stays committed and `alembic_version` records the last good revision. Fix the issue and re-run; the chain resumes from there rather than restarting. The exception is anything inside an `autocommit_block()`, which has already committed by definition — that is why every statement in such a block must be idempotent.

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
