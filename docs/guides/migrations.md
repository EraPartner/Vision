---
title: Database Migration Guide
type: guide
status: active
date: 2026-10-19
updated: 2026-10-19
tags: [guide, database, migrations, kysely, postgresql, destructive-ddl, ci, performance]
description: How to create, run, lint and roll back Vision's PostgreSQL migrations with the Kysely migrator and the squashed 0001 baseline
aliases: [migration-guide, database-schema, schema-changes]
related_code:
  [
    "db/migrations/",
    "db/alembic-bridge/",
    "db/baseline-inventory.json",
    "db/schema-inventory.sql",
    "apps/node-backend/src/database/migrate.ts",
    "apps/node-backend/src/database/schemaInventory.ts",
    "apps/node-backend/src/database/schema.generated.ts",
    "apps/node-backend/scripts/db-migrate.ts",
    "apps/node-backend/scripts/db-drift-check.ts",
  ]
---

# Database Migration Guide

Vision's schema lives in numbered SQL files in `db/migrations/`. The backend applies pending files
with Kysely's `Migrator` before it listens ([[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]]).
There is no Python toolchain.

## Quick Reference

| Action                                 | Command                                |
| -------------------------------------- | -------------------------------------- |
| Apply pending migrations               | `bun run db:migrate`                   |
| Revert the latest migration            | `bun run db:migrate:down`              |
| Show applied and pending migrations    | `bun run db:status`                    |
| Create a migration file                | `bun run db:new -- describe_the_change` |
| Lint migration SQL (squawk)            | `bun run db:lint`                      |
| Regenerate the Kysely database types   | `bun run db:codegen`                   |
| Compare a database with the baseline   | `bun run db:drift-check`               |

All commands use `DATABASE_URL` (falling back to `config/.env.local`); `DATABASE_URL_MIGRATIONS`,
when set, is the owner role that runs DDL.

## How migrations work

- `db/migrations/0001_baseline.sql` is the full PostgreSQL 18 schema at the former Alembic head
  `0128_category_path_on_legacy_rename`, with reference rows and one `baseline_installed` audit
  event. Never edit it.
- Every later `NNNN_name.sql` is one migration. An optional `NNNN_name.down.sql` makes it
  reversible; without one, `db:migrate:down` refuses and recovery is a backup restore.
- `runMigrations()` in `apps/node-backend/src/database/migrate.ts` runs all pending files in one
  transaction under Kysely's `kysely_migration_lock`. A failure rolls back the whole run. Each file
  appends a `schema_migration` audit event in the same transaction.
- Applied migrations are recorded in `public.kysely_migration`. The highest name is the schema
  revision that backups record.
- After a run that applied something, the migrator ANALYZEs `transactions` and
  `asset_price_history`. `VISION_MIGRATE_TIMEOUT_MS` (default 10 minutes, `0` disables) is the
  statement timeout of the migration connection.

### Fresh install and adoption

An empty PostgreSQL 18 database receives the baseline. Its normalized catalog fingerprint
(`db/schema-inventory.sql` through `schemaInventory.ts`, ignoring bookkeeping tables, column order
and one equivalent CHECK spelling) must equal `BASELINE_SCHEMA_FINGERPRINT`, or the install rolls
back. A database with application objects but no migration marker is refused.

A database still carrying `alembic_version` is adopted when it is at
`0126_income_recognition_check_name`, `0127_bank_chronology` or
`0128_category_path_on_legacy_rename`. Below `0128`, the missing steps run first from the frozen
SQL in `db/alembic-bridge/`, each with a `revision_applied` audit event
([[docs/adr/223-adopt-alembic-0126-through-bridge|ADR-223]]). The catalog fingerprint must then
equal the baseline's. Adoption drops `alembic_version`, records `0001_baseline` and appends a
`version_changed`/`stamp` audit event, all in one transaction. Anything else fails closed.

Run `bun run db:drift-check` first. It reads the database URL from Vision's `runtime.env`
(default `~/Library/Application Support/Vision/native/vision/runtime.env`, or `--env-file <path>`),
so Vision must be running; `--from-env` uses `DATABASE_URL_MIGRATIONS`/`DATABASE_URL` instead
(Bun loads a checkout's `.env` automatically, so this is opt-in). It runs any bridge steps in a
transaction it rolls back, prints the revision and both fingerprints, and on a mismatch lists the
names of the differing objects against `db/baseline-inventory.json`, the baseline's hashed
catalog inventory (no `CREATEDB` privilege needed; a DB test keeps it equal to a fresh baseline
install). The checked database does not change.

## Creating a migration

1. `bun run db:new -- add_recipient_notes` creates `db/migrations/NNNN_add_recipient_notes.sql`.
2. Write plain SQL. It runs inside the migrator's transaction, so do not add `BEGIN`/`COMMIT`
   and do not use statements PostgreSQL refuses inside a transaction (`CREATE INDEX
   CONCURRENTLY`, `VACUUM`).
3. Add `NNNN_add_recipient_notes.down.sql` with the rollback.
4. Run `bun run db:migrate`, then `bun run db:migrate:down` and `bun run db:migrate` again on a
   disposable database.
5. Run `bun run db:codegen` and commit the regenerated `schema.generated.ts` with the migration.
6. Run `bun run db:lint` and the relevant backend tests.

## Destructive DDL

Migrations auto-apply on the next boot of the app. Squawk (`bun run db:lint`, also in CI) rejects
dropping tables or columns and other unsafe operations in every file except the baseline. When a
drop is genuinely safe, ask first: the code that stops reading the object must ship before the
migration runs on Tor's machine. If it cannot, the drop does not belong in a migration yet.
An intended destructive statement carries a `-- squawk-ignore <rule>` comment directly above it
(rules and exclusions live in `config/squawk.toml`). Squawk has no rule for `DROP SCHEMA`, `DROP VIEW`,
`DROP FUNCTION`, `DROP TYPE` or `DROP TRIGGER`, so review those statements by hand.

## Cost: migrations run inside the boot window

`main.ts` awaits `runMigrations()` before `app.listen()`, and the Electron shell shows an error
page when `/health` does not answer in time. The expensive shapes and their cheap forms:

- **CHECK or FK constraints.** Add them `NOT VALID`, then `VALIDATE CONSTRAINT` in a later
  migration; validation takes only `SHARE UPDATE EXCLUSIVE`.
- **`SET NOT NULL`.** Add `CHECK (col IS NOT NULL) NOT VALID`, validate it, then `SET NOT NULL`
  (instant) and drop the CHECK.
- **Backfills.** A single `UPDATE` of a large table rewrites every row in one long transaction.
  Keep backfills small or move them to application code that runs after boot.
- **Indexes.** A plain `CREATE INDEX` blocks writes while it scans. The migrator's transaction
  rules out `CONCURRENTLY`; build large indexes after any backfill.
- **Column type changes** rewrite the table and its indexes under `ACCESS EXCLUSIVE`. Avoid them.
- **Materialized views.** Drop only; the runtime `materializedViewService` recreates missing views
  after the backend listens.

## Related

- [[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]] — Kysely migrator and squashed baseline
- [[docs/guides/setup|Setup Guide]] — Local development setup
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/adr/002-database-schema|ADR-002]] — Database schema design decisions
