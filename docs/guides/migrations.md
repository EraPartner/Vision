---
title: Database Migration Guide
type: guide
status: active
date: 2026-11-03
updated: 2026-11-03
tags: [guide, database, migrations, sqlite, destructive-ddl, ci]
description: How to create, run, check and roll back Vision's SQLite migrations, including the table-rebuild procedure for changes ALTER TABLE cannot make
aliases: [migration-guide, database-schema, schema-changes]
related_code:
  [
    "db/migrations/",
    "apps/node-backend/src/database/migrate.ts",
    "apps/node-backend/scripts/db-migrate.ts",
    "apps/node-backend/scripts/db-codegen.ts",
    "apps/node-backend/db-codegen.config.json",
    "apps/node-backend/tests/database/migrations.test.ts",
    "apps/node-backend/tests/database/sqlDialect.test.ts",
  ]
---

# Database Migration Guide

Vision's schema lives in numbered SQL files in `db/migrations/`. The backend applies pending files
before it listens, with the runner in `apps/node-backend/src/database/migrate.ts`
([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]). The SQL is SQLite in the dialect described in
[[docs/reference/sqlite-sql-dialect|SQLite SQL dialect]].

## Quick Reference

| Action                               | Command                                 |
| ------------------------------------ | --------------------------------------- |
| Apply pending migrations             | `bun run db:migrate`                    |
| Revert the latest migration          | `bun run db:migrate:down`               |
| Show applied and pending migrations  | `bun run db:status`                     |
| Create a migration file              | `bun run db:new -- describe_the_change` |
| Regenerate the Kysely database types | `bun run db:codegen`                    |

The commands use `VISION_DATABASE_PATH` (falling back to `config/.env.local`). Point it at a
disposable copy, never at the database the app uses.

## How migrations work

- `db/migrations/0001_baseline.sql` is the full SQLite schema at Vision 2.0.0. Never edit an
  applied migration: the ledger stores each file's SHA-256 and the runner refuses a database whose
  recorded checksum differs.
- Every later `NNNN_name.sql` is one migration, numbered without gaps. An optional
  `NNNN_name.down.sql` makes it reversible; without one, `db:migrate:down` refuses and recovery is
  a backup restore.
- `runMigrations()` runs all pending files in one `BEGIN IMMEDIATE` transaction with foreign keys
  switched off for the run. Before `COMMIT` it runs `PRAGMA foreign_key_check`; any violation, or
  any error, rolls the whole run back and the database is unchanged.
- The ledger is the `vision_migrations` table (version, name, SHA-256, applied time), and
  `PRAGMA user_version` holds the latest version. The latest version is the schema version that
  backups record.
- Before migrating a database that holds data, the runner writes a `VACUUM INTO` copy to
  `pre-migration-backups/` next to the database, named
  `<file>-v<from>-to-v<to>-<time>.sqlite3`, and keeps the newest three.

The runner refuses, and changes nothing, when the database:

- holds application tables but no ledger (not a Vision database, or one from before the ledger);
- lists a migration this build does not know (a newer Vision wrote it);
- lists a migration whose file changed after it was applied.

## Creating a migration

1. `bun run db:new -- add_recipient_notes` creates `db/migrations/NNNN_add_recipient_notes.sql`.
2. Write plain SQLite SQL in the Vision dialect: money columns are `DECIMAL_TEXT(p,s)` with their
   `<table>_<column>__vtype` CHECK, timestamps `TIMESTAMPTZ_TEXT`, dates `DATE_TEXT`, and so on
   ([[docs/reference/sqlite-sql-dialect|storage types]]). Do not add `BEGIN`, `COMMIT`, `PRAGMA`,
   `VACUUM`, `ATTACH` or `DETACH`: the runner owns the transaction and the connection.
3. Add `NNNN_add_recipient_notes.down.sql` with the rollback.
4. Run `bun run db:migrate`, `bun run db:migrate:down` and `bun run db:migrate` on a disposable
   database.
5. Run `bun run db:codegen` and commit the regenerated `schema.generated.ts` and
   `schemaMap.generated.ts` with the migration. A new money, id or currency column whose generated
   type needs a narrower TypeScript type gets an entry in
   `apps/node-backend/db-codegen.config.json`.
6. Run the backend tests. `tests/database/migrations.test.ts` applies every migration to an empty
   database and to a database at each earlier version, and requires the result to equal a fresh
   install. `tests/database/sqlDialect.test.ts` checks the migration's SQL.

## What ALTER TABLE can and cannot do

SQLite's `ALTER TABLE` can rename a table, rename a column, add a column and drop a column. It
cannot change a column's type, default, `NOT NULL` or CHECK, and cannot add or drop a constraint or
foreign key. Those changes rebuild the table:

1. `CREATE TABLE new_x (...)` with the new definition, including every CHECK and foreign key.
2. `INSERT INTO new_x (cols) SELECT cols FROM x;`
3. `-- destructive-ok: x is rebuilt as new_x with its rows copied` and `DROP TABLE x;`
4. `ALTER TABLE new_x RENAME TO x;`
5. Recreate the indexes, triggers and views that belonged to `x`.

Foreign keys are off during the run, so step 3 does not cascade. The `foreign_key_check` before
`COMMIT` refuses the run if the rebuild lost a row that another table references. The migration
test covers this procedure with a foreign key, a trigger, a view and a CHECK.

`ADD COLUMN` is cheap, with limits: a `NOT NULL` column needs a non-NULL default, the default
must be a constant (not an expression such as `(now())` or `(nextval(...))`), and the column cannot
be `PRIMARY KEY` or `UNIQUE`. Use a rebuild for anything else.

## Destructive statements

Migrations apply automatically on the next start of the app. The dialect test refuses
`DROP TABLE`, `DROP VIEW`, `DROP INDEX`, `DROP TRIGGER`, `ALTER TABLE ... DROP COLUMN` and
`DELETE` without `WHERE` in every migration after the baseline, unless the line directly above
carries `-- destructive-ok: <reason>`. `.down.sql` files are exempt. When a drop is genuinely
safe, ask first: the code that stops reading the object must ship before the migration runs on
Tor's machine. If it cannot, the drop does not belong in a migration yet.

## Cost: migrations run inside the start-up window

`main.ts` awaits `runMigrations()` before `app.listen()`, and the Electron shell shows an error
page when `/health` does not answer in time. The expensive shapes:

- **Table rebuilds** copy every row. They are fine for Vision's tables, but rebuild each table
  once per migration and build indexes after the copy.
- **Backfills.** One `UPDATE` of a large table holds the write lock for the whole run. Keep
  backfills small or move them to application code that runs after start-up.
- **Indexes** scan the table while the write lock is held.

## Related

- [[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]: SQLite replaces PostgreSQL
- [[docs/reference/sqlite-sql-dialect|SQLite SQL dialect]]
- [[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]]: the earlier Kysely migrator and squashed baseline
- [[docs/guides/setup|Setup Guide]]: local development setup
- [[docs/reference/data-model|Data Model Reference]]
