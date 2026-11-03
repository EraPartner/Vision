---
title: "ADR-265: Retire the Vision 2.0 compatibility code"
type: adr
status: accepted
date: 2026-11-03
tags: [adr, database, sqlite, backup, transition, adr-263]
description: "Vision 2.1.0 drops the code that existed only for Vision 2.0's PostgreSQL data: the transition script, the startup refusal over 2.0 data, the 2.0 backup refusal, the 'needs review' flag for PostgreSQL custom SQL and the PostgreSQL-only database stats fields. The script stays in Git history at dd4cc71."
aliases: [adr-265, retire vision 2.0 compatibility, remove transition script]
related_code:
  [
    "packaging/electron/runtime/native.ts",
    "packaging/electron/backup/bundle.ts",
    "packaging/electron/backup/restore.ts",
    "apps/node-backend/src/services/savedAnalysisService.ts",
    "apps/node-backend/src/routes/admin.ts",
  ]
---

# ADR-265: Retire the Vision 2.0 compatibility code

## Status

Accepted on 2026-11-03. Supersedes the transition, startup-refusal, backup-refusal and
"needs review" parts of [[docs/adr/263-sqlite-replaces-postgresql|ADR-263]].

## Context

- [[docs/adr/263-sqlite-replaces-postgresql|ADR-263]] kept code whose only job was Vision 2.0's
  PostgreSQL data: a standalone transition script (`bun run transition:v2`), a startup refusal
  when 2.0 data existed without a SQLite database (`LEGACY_POSTGRES_DATA`), a restore refusal for
  2.0 backups (`BACKUP_POSTGRESQL_V2`), a "needs review" flag for custom SQL saved in the
  PostgreSQL dialect, and PostgreSQL-shaped fields in `GET /api/admin/database/stats`.
- On 2026-11-03 Tor converted his live data with that script, reported converting the 2.0
  backups he keeps (`--to-backup`), and asked for all PostgreSQL-specific code to go before 2.1.0
  ships. He chose to remove the startup refusal too.

## Decision

- Remove `scripts/vision-v2-to-sqlite.ts`, `apps/node-backend/scripts/transition/`, its tests and
  fixtures, and the `transition:v2` script. The last commit with the script is `dd4cc71`; a 2.0
  backup is converted from a checkout of that commit.
- Remove the startup refusal. A Mac with only Vision 2.0 data starts with an empty SQLite
  database; Vision never reads, changes or deletes `<userData>/native/vision/postgres/data`.
  Vision 2.0's database credentials in `runtime.env` join the retired keys and are stripped.
- Restore refuses a bundle of an older format by its declared `bundleVersion`
  (`BACKUP_FORMAT_UNSUPPORTED`) and any non-SQLite bare file with `BACKUP_UNRECOGNIZED`. The
  restore picker no longer offers `.sql`.
- Custom SQL runs as SQLite SQL. `needsReview` and `reviewReason` leave the saved-analysis
  contract, `ANALYSIS_SQL_NEEDS_REVIEW` and the `analysis-needs-review` monitor reason go, and the
  definition schema accepts and ignores a stored `source.dialect` because versions are immutable.
- `GET /api/admin/database/stats` drops `schemaname`, `dead_rows`, `last_autovacuum` and
  `last_autoanalyze`, which SQLite cannot report.
- Names that came from node-postgres change without changing behaviour: the `pg*` row-schema
  primitives become `db*`, `PgQueryResult` becomes `DbQueryResult`, `PgPoolClient` becomes
  `DbClient`, and `sqlite/pgTime.ts` becomes `sqlite/timestamps.ts`.

## Consequences

- A Vision 2.0 user who installs 2.1.0 without converting first sees an empty Vision; the old
  data stays untouched and converts with the script at `dd4cc71`.
- PostgreSQL-dialect SQL saved by Vision 2.0 fails at run time where the dialects differ instead
  of being blocked with a review message.
- Kept on purpose: the SQLite dialect's PostgreSQL-compatible value forms, functions and error
  codes ([[docs/reference/sqlite-sql-dialect|SQLite SQL dialect]]). They are the storage contract
  of the SQLite database, not compatibility code, and the golden tests that compare them with
  PostgreSQL's output stay.

## Related

- [[docs/adr/263-sqlite-replaces-postgresql|ADR-263: SQLite replaces PostgreSQL]]
- [[docs/guides/native-macos-runtime|Native macOS runtime]]
