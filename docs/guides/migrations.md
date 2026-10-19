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

A database still carrying `alembic_version` is adopted only when it is at exactly
`0128_category_path_on_legacy_rename` and has the baseline fingerprint. Adoption drops
`alembic_version`, records `0001_baseline` and appends a `version_changed`/`stamp` audit event.
Anything else fails closed. Run `bun run db:drift-check` first: it is read-only against the
checked database, prints the revision and both fingerprints, and on a mismatch lists the names of
the differing objects (it builds the baseline in a temporary database on the same server and
drops it).

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
