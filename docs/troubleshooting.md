---
title: Troubleshooting & FAQ
type: reference
status: active
date: 2026-11-03
tags:
  [
    troubleshooting,
    faq,
    native-runtime,
    electron,
    sqlite,
    migrations,
    backup,
    keychain,
  ]
description: Recovery steps for native Vision startup, database, migration, frontend, backend, and macOS integration failures.
aliases: [troubleshooting, FAQ, common issues, errors, debugging, problems]
---

# Troubleshooting & FAQ

## Native startup

### The database does not open

Vision has no database server. The backend opens `<userData>/database/vision.sqlite3` itself
([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]).

1. Open logs from the recovery screen and inspect `backend.log`
   (`native/<runtime id>/logs/backend.log`).
2. If the dialog says Vision found data from Vision 2.0 (`LEGACY_POSTGRES_DATA`), the old
   PostgreSQL data is still in `native/vision/postgres/data` and nothing was changed. Follow
   [[docs/guides/sqlite-transition|Moving Vision 2.0 data to SQLite]].
3. If the log says the SQLite library is too old, the Mac needs macOS 13 or later (SQLite 3.39.0
   or later).
4. If payload verification fails, reinstall the same Vision release. Runtime data and attachments
   live outside `Vision.app` and must not be deleted.
5. From a prepared checkout, run `bun run native:isolated-smoke`.

Do not reset the database merely to make startup succeed.

### Database connection refused

- For Electron, inspect `native/vision/logs/backend.log` and do not print `runtime.env`.
- For source development, stop the launcher cleanly, check that no other process owns the backend
  port, then rerun `bun run dev`.
- For a backend-only source run, set `VISION_DATABASE_PATH` to the SQLite file through the
  documented environment layering. Outside development and test the backend refuses to start
  without it.

## Migrations

### Upgrade fails

```bash
bun run db:status
```

All pending migrations run in one `BEGIN IMMEDIATE` transaction, so a failure rolls the whole run
back and the log says "Nothing was changed". Read the first failing migration and database error
and fix it in a new or corrected unapplied file. The runner also refuses, without changing
anything, a database that holds tables but no migration ledger, a database a newer Vision migrated,
and a migration whose checksum changed after it was applied. Before it migrates a database that
holds data, the backend writes a copy to `database/pre-migration-backups/`; if that copy fails,
the launch dialog shows `PRE_MIGRATION_BACKUP_FAILED` and nothing is migrated. If the app stays on "Almost ready…" or shows "Failed to
start Vision.", read `~/Library/Application Support/Vision/native/vision/logs/backend.log`. A
destructive `db:migrate:down` requires a verified backup and explicit review.
See [[docs/guides/migrations|Database Migration Guide]].

### Target database is not up to date

Stop application writers, run `bun run db:migrate` with `VISION_DATABASE_PATH` set to the target
file, and verify `bun run db:status`. Do not point migration commands at the real Vision database when diagnosing
with a disposable test database.

## Frontend

### Charts do not render

Charts render lazily. Scroll the chart into the viewport before treating an empty capture as a
failure. Check the browser console, API response, date range, and reduced-motion settings.

### A virtual table does not update

Check the React Query mutation invalidation key, the virtualizer row identity, and any active
filter. Prefer the shared table and query-key contracts over a local refresh workaround.

## Backend

### Rate limit exceeded

Wait for the returned window to reset. Buckets are keyed by the socket peer address only;
`X-Forwarded-For` is ignored and no proxy configuration exists ([[docs/adr/233-loopback-only-backend|ADR-233]]).

### Import fails on a large file

Inspect the structured request log and import batch status. Validate the adapter, delimiter,
encoding, and configured upload limit. Do not log account numbers or transaction contents.

### Price data is stale

Check provider configuration and provider-health state, then use the relevant admin probe or update
operation. For Kinesis history anomalies, use the dedicated sanitize operation rather than editing
stored prices directly.

## Electron and macOS

### Backend authentication fails after reinstall

Current Vision fixes the historical application-name and user-data mismatch by setting the
canonical name before resolving paths and migrating the old directory. Do not create a new
database over an existing one. Inspect the canonical application-data directory and ADR-045 before
changing files.

### Repeated “Vision Safe Storage” prompt

Ad-hoc unsigned builds can have an unstable Keychain identity. Options are:

1. choose **Always Allow** for the expected Vision entry;
2. use `VISION_BACKUP_PASSPHRASE` for an automation-only launch; or
3. clear the stored backup passphrase in Settings when encryption is not wanted.

Never print the passphrase. A signed and notarized production build provides the stable identity.

## Common error messages

| Error                               | Meaning                                           | Action                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_PASSPHRASE`                | Encrypted backup authentication failed            | Re-enter the passphrase; do not modify the bundle                                                                                             |
| `BUNDLE_SCHEMA_NEWER`               | Backup was created by a newer schema              | Upgrade Vision before restoring                                                                                                               |
| `BACKUP_POSTGRESQL_V2`              | Backup is a Vision 2.0 PostgreSQL backup          | Convert it once with `bun run transition:v2 -- <backup> --to-backup <new.visionbak>` ([[docs/guides/sqlite-transition\|Moving Vision 2.0 data to SQLite]]) |
| `LEGACY_POSTGRES_DATA`              | Vision 2.0 data exists and no SQLite database yet | Follow [[docs/guides/sqlite-transition\|Moving Vision 2.0 data to SQLite]]; do not delete the old data directory |
| `PRE_MIGRATION_BACKUP_FAILED`       | The copy before a migration could not be written  | Free disk space or fix permissions in `database/`, then start Vision again; nothing was migrated                                              |
| `PORT_COLLISION`                    | An unknown process owns the backend loopback port | Identify and stop the exact process or choose a valid development port                                                                        |
| `APP_ERROR`                         | Sanitized backend failure                         | Correlate the request ID with structured logs                                                                                                 |

## Related

- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
- [[docs/guides/debugging|Debugging Guide]]
- [[docs/guides/migrations|Migration Guide]]
- [[docs/reference/environment-variables|Environment Variables]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
