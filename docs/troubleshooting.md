---
title: Troubleshooting & FAQ
type: reference
status: active
date: 2026-09-08
tags:
  [
    troubleshooting,
    faq,
    native-runtime,
    electron,
    postgresql,
    migrations,
    backup,
    keychain,
  ]
description: Recovery steps for native Vision startup, database, migration, frontend, backend, and macOS integration failures.
aliases: [troubleshooting, FAQ, common issues, errors, debugging, problems]
---

# Troubleshooting & FAQ

## Native startup

### PostgreSQL does not start

1. Open logs from the recovery screen and inspect `postgres.log` and `backend.log`.
2. Check whether another process owns the configured loopback PostgreSQL port. Vision will not
   connect to an unknown listener.
3. If payload verification fails, reinstall the same Vision release. Runtime data and attachments
   live outside `Vision.app` and must not be deleted.
4. From a prepared checkout, run `bun run native:db-smoke` and
   `bun run native:isolated-smoke`.

Do not reset the database merely to make startup succeed.

### Legacy runtime marker blocks startup

The native-only release fails with `LEGACY_RUNTIME_MIGRATION_REQUIRED` when saved state identifies
the retired product runtime. Migrate with Vision 1.0.2 before upgrading. Do not delete the legacy
database or attachments; they may be the only recoverable copy. See
[[docs/adr/133-native-only-runtime-and-delivery|ADR-133]].

### Database connection refused

- For Electron, inspect `native/vision/logs/postgres.log` and do not print `runtime.env`.
- For source development, stop the launcher cleanly, check port ownership, then rerun `bun run dev`.
- For a backend-only source run, supply explicit `DATABASE_URL` and
  `DATABASE_URL_MIGRATIONS` values through the documented environment layering.

## Migrations

### Upgrade fails

```bash
bun run db:current
bun run db:history
bun run db:check
```

Read the first failing migration and database error. Do not stamp past a failure or run a bare
Alembic write. Use the guarded `bun run db:*` commands. A destructive downgrade requires a verified
backup and explicit review.

### Target database is not up to date

Stop application writers, run `bun run db:upgrade` with the owner connection, and verify
`bun run db:current`. Do not point migration commands at the real Vision database when diagnosing
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

Wait for the returned window to reset. Do not add broad trusted-proxy rules to hide the symptom.
When a reverse proxy is intentional, configure `TRUSTED_PROXIES` narrowly and verify the direct
socket address.

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
canonical name before resolving paths and migrating the old directory. Do not generate replacement
credentials over an existing private cluster. Inspect the canonical application-data directory and
ADR-045 before changing files.

### Repeated “Vision Safe Storage” prompt

Ad-hoc unsigned builds can have an unstable Keychain identity. Options are:

1. choose **Always Allow** for the expected Vision entry;
2. use `VISION_BACKUP_PASSPHRASE` for an automation-only launch; or
3. clear the stored backup passphrase in Settings when encryption is not wanted.

Never print the passphrase. A signed and notarized production build provides the stable identity.

## Common error messages

| Error                               | Meaning                                          | Action                                                                 |
| ----------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- |
| `LEGACY_RUNTIME_MIGRATION_REQUIRED` | Saved state belongs to the retired runtime       | Migrate with Vision 1.0.2 before upgrading                             |
| `INVALID_PASSPHRASE`                | Encrypted backup authentication failed           | Re-enter the passphrase; do not modify the bundle                      |
| `BUNDLE_SCHEMA_NEWER`               | Backup was created by a newer schema             | Upgrade Vision before restoring                                        |
| `PORT_IN_USE`                       | An unknown process owns a required loopback port | Identify and stop the exact process or choose a valid development port |
| `APP_ERROR`                         | Sanitized backend failure                        | Correlate the request ID with structured logs                          |

## Related

- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
- [[docs/guides/debugging|Debugging Guide]]
- [[docs/guides/migrations|Migration Guide]]
- [[docs/reference/environment-variables|Environment Variables]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
