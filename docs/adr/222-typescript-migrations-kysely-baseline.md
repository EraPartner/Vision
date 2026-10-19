---
title: "ADR-222: TypeScript migrations with Kysely and one squashed baseline"
type: adr
status: accepted
date: 2026-10-19
tags: [adr, database, migrations, kysely, alembic, python, baseline, backup, ci, packaging]
description: "Accepted on 2026-10-19. Vision drops Python. Alembic, its 128 revisions, the PyInstaller migration runner and every Python script are removed. db/migrations/0001_baseline.sql holds the complete schema at the former head 0128; Kysely's Migrator applies numbered SQL files in-process. The single existing database is adopted only when it is at Alembic 0128 and its catalog fingerprint equals the baseline's. Only backups taken after the switch restore. kysely-codegen generates the DB types. Supersedes ADR-027, ADR-165, ADR-166 and ADR-184."
aliases: [adr-222, kysely migrations, squashed baseline, remove python, drop alembic]
---

# ADR-222: TypeScript migrations with Kysely and one squashed baseline

## Status

Accepted on 2026-10-19. Tor decided to move all Python to TypeScript, adopt Kysely's migrator,
squash every migration into one, and restore only backups taken after the switch.

It supersedes [[docs/adr/027-alembic-single-source-of-schema|ADR-027]] (Alembic as the schema
source), [[docs/adr/165-reviewed-fresh-database-baseline|ADR-165]] and
[[docs/adr/166-maintained-database-canonical-conversion|ADR-166]] (the `0119` baseline, bridge and
conversion) and [[docs/adr/184-strict-python-type-checking|ADR-184]] (mypy for Python).

## Date

2026-10-19

## Context

The backend, scripts and Electron shell are TypeScript, but schema changes ran through Alembic.
That needed Python 3, SQLAlchemy and psycopg2 in development and CI, a PyInstaller-built
`vision-alembic` executable inside the Mac app, `mypy --strict` and `pip-audit` CI jobs, and a
Python destructive-DDL checker. Boot spawned the Alembic process. 128 revisions plus a `0119`
baseline, bridge and conversion tooling existed to upgrade installations that no longer exist:
Tor's database is the only one, and it is at `0128_category_path_on_legacy_rename`.

## Decision

- **Baseline.** `db/migrations/0001_baseline.sql` is the complete PostgreSQL 18 schema of a
  disposable database built by the last Alembic chain (`0119` fresh install, then `0120`–`0128`),
  dumped with `pg_dump 18.6 --inserts --no-owner --no-privileges --quote-all-identifiers`. It
  omits `alembic_version`, keeps the reference rows (`adr109_legacy_cleanup_marker`,
  `insight_digest_state`) and starts the audit chain with one `baseline_installed` event for
  revision `0001_baseline`. Session settings are transaction-local so the file runs inside the
  migrator's transaction. The schema is unchanged: the baseline and the Alembic-built database
  have the same catalog fingerprint.
- **Migrator.** `apps/node-backend/src/database/migrate.ts` runs Kysely's `Migrator` in-process
  as the owner role (`DATABASE_URL_MIGRATIONS`, else `DATABASE_URL`). Each
  `db/migrations/NNNN_name.sql` is one migration; an optional `NNNN_name.down.sql` makes it
  reversible. All pending migrations run in one transaction under Kysely's lock table. Each
  applied migration appends a `schema_migration` audit event in that transaction. Bookkeeping
  lives in `kysely_migration` and `kysely_migration_lock`; the schema revision of a database is
  the highest migration name there.
- **Fresh install.** An empty PostgreSQL 18 database receives the baseline, then its normalized
  catalog fingerprint (`db/schema-inventory.sql`, excluding bookkeeping tables, column order and
  one equivalent CHECK spelling) must equal `BASELINE_SCHEMA_FINGERPRINT`, or the transaction
  rolls back. A database with objects but no marker is refused.
- **Adoption of the existing database.** A database with `alembic_version` is accepted only at
  exactly `0128_category_path_on_legacy_rename` with the baseline fingerprint. Adoption drops
  `alembic_version`, records `0001_baseline` and appends a `version_changed`/`stamp` audit event,
  all in one transaction. Any other revision or any schema drift fails closed and changes
  nothing. `bun run db:drift-check` reports the same comparison read-only, with the names of
  differing objects, before the switch.
- **Backups.** Only backups taken after the switch restore. A backup that carries Alembic
  revision metadata is refused with an explicit error.
- **Types.** `kysely-codegen` generates `apps/node-backend/src/database/schema.generated.ts` from
  a migrated database (`bun run db:codegen`). Queries may adopt Kysely incrementally next to raw
  `pg`; PL/pgSQL functions and triggers stay SQL.
- **Python removed.** The Alembic tree, `alembic.ini`, the PyInstaller runner, `config/requirements*`,
  `config/mypy.ini` and all Python scripts are deleted; scripts still in use are ported to Bun
  TypeScript. The Python CI jobs (type check, dependency audit, destructive-migration check) are
  removed; migration SQL is linted by squawk inside an existing job.

> [!note] Amended by [[docs/adr/223-adopt-alembic-0126-through-bridge|ADR-223]] (2026-10-19)
> The installed database was at `0126`, not `0128`. Adoption also accepts `0126` and `0127` by
> applying the frozen `0127` and `0128` SQL first, then requiring the baseline fingerprint.

> [!note] Adoption removed by [[docs/adr/224-remove-alembic-adoption|ADR-224]] (2026-10-19)
> A database still on Alembic is now refused; `db:drift-check` is gone.

## Consequences

- Development, CI and the Mac build need no Python. The app bundle no longer ships a PyInstaller
  executable, and boot no longer spawns a process to check migrations.
- Upgrade history before `0001_baseline` is gone from the tree; Git keeps it. Downgrades below the
  baseline are impossible; recovery is a backup restore.
- Backups taken before the switch cannot be restored by the new app. Tor takes a fresh backup
  right after the switch.
- Editing an applied migration file has no effect on databases that already ran it; a change
  always needs a new numbered file.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/guides/migrations|Database Migration Guide]]
- [[docs/adr/215-behaviour-boundary-tests|ADR-215]]
