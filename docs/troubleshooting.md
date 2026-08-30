---
title: Troubleshooting & FAQ
type: reference
status: active
date: 2026-08-30
updated: 2026-08-30
tags:
  [
    troubleshooting,
    faq,
    reference,
    debugging,
    phase-1,
    electron,
    app-naming,
    password-mismatch,
    keychain,
    safe-storage,
    macOS,
    backup-passphrase,
    compose-project-name,
    data-loss,
    down-v,
    volume-isolation,
    backup-restore,
    docker,
    architecture,
    migrations,
    adr-109,
    adr-111,
    migration-0088,
    adr-112,
  ]
description: Common Vision errors and recovery steps, including database migration failures, Electron authentication failures, macOS Keychain prompts, and Docker volume safety.
aliases: [troubleshooting, FAQ, common issues, errors, debugging, problems]
---

# Troubleshooting & FAQ

> [!abstract] Purpose
> Common issues, error messages, and their solutions. Organized by area for quick lookup.

## Setup & Development

### PostgreSQL won't start

**Native symptom:** Vision reports a missing/corrupt runtime, a PostgreSQL port collision, or a
private database that did not become ready.

**Native actions:**

1. Open Vision logs from the recovery screen and inspect `postgres.log` and `backend.log`.
2. Check whether another process owns loopback port `54329`; Vision will not connect to it.
3. Reinstall the same Vision release when payload verification fails. The durable native database
   and attachments are outside `Vision.app` and must not be deleted.
4. From a prepared source checkout, run the synthetic native smoke commands in
   [[docs/guides/native-macos-runtime#lifecycle-and-diagnostics|Native macOS Runtime Guide]].

Do not reset the native database or switch to Docker to bypass a failed verification.

**Docker symptom:** `bun run docker:dev` fails because the database service does not become
healthy.

**Docker actions:**

1. Check db container logs: `docker compose -f docker-compose.yml -f docker-compose.dev.yml logs db`.
2. Verify container status: `docker compose -f docker-compose.yml -f docker-compose.dev.yml ps`.
3. Ensure Docker Desktop is running and has enough disk space.

Do not remove or reset volumes from an existing installation. A disposable clean-development
database may be recreated only when its exact synthetic data boundary is known.

### Containers fail with entrypoint or architecture errors

**Symptoms:** The database logs `docker-entrypoint.sh: exec format error`, or the app logs
`/bin/sh: can't open '/entrypoint.sh': Permission denied`.

The current official `postgres:18-alpine` ARM64 image can contain empty entrypoint scripts,
producing the database error; see
[docker-library/postgres#1378](https://github.com/docker-library/postgres/issues/1378).

This issue applies only to the explicitly selected Docker provider and the Docker command-line
stack. Native Vision.app does not pull or start a PostgreSQL container. In Docker mode, Vision
runs PostgreSQL as `linux/amd64` under Docker Desktop emulation while the app image remains native.
It pulls and smoke-tests that exact database platform in a disposable container before recreating
a database container that failed the check. The named database volume is preserved. If the
replacement also fails, startup stops with the Docker error. Docker mode also writes a redacted
`docker compose ps` and bounded `app`/`db` log snapshot when readiness times out.

For the command-line development stack, run `bun run docker:dev:rebuild`.

Before stopping the current stack, the command pulls the amd64 Postgres image and runs
`postgres --version` in a disposable container. If that entrypoint test fails, the command stops.
If it succeeds, the command rebuilds the app with an explicit executable entrypoint mode and starts
both services. The image test does not mount or remove the named database or attachment volumes.
The amd64 workaround may make local database operations slightly slower and can be removed after a
fixed upstream ARM64 image is published.

Do not delete or reset a data volume for either error; neither error indicates database corruption.

### Database connection refused

**Symptom:** `DATABASE_URL` connection fails.

**Solutions:**

1. Native mode: inspect the recovery screen and `native/vision/logs/postgres.log`. Do not copy or
   print `native/vision/runtime.env`.
2. Native source development: stop the launcher cleanly, confirm port `54329` is free, then rerun
   `bun run dev`.
3. Docker mode: verify the optional service with
   `docker compose -f docker-compose.yml -f docker-compose.dev.yml ps db`.
4. A backend-only source run must receive an explicit connection through the documented
   environment layering. Do not guess a URL or password.

### Migration fails

**Symptom:** `bun run db:upgrade` throws an error.

**Solutions:**

1. Check current version: `bun run db:current`
2. View pending migrations: `bun run db:history`
3. If stuck mid-migration, Alembic auto-rolls back (PostgreSQL transactional DDL)
4. Preserve a logical backup and run pending writes through `bun run db:upgrade` only.

Do not use a bare Alembic write, downgrade, stamp, reset, or manual version-table change to bypass
the failure. Vision's migration runner performs a required `VARCHAR(64)` version-table preflight.

### ADR-109 conversion reports transactions for missing investments

**Symptom:** Container startup repeats an `0087_flat_investments_conversion` error saying that one
or more portfolio transactions reference investments that do not exist.

**Cause:** On the former inheritance schema, deleting an investment removed its base and
asset-class rows, but the transaction child tables had no enforceable foreign key and could retain
the deleted investment's transactions. The original 0087 guard treated those predictable leftovers
as unknown corruption and stopped the upgrade.

**Recovery:**

1. Keep or create a database backup before upgrading.
2. Update or rebuild the Vision app image so it contains the patched migration 0087.
3. Restart the app. The migration warns with the affected transaction IDs, omits those detached
   rows from the canonical flat table, and keeps the originals in the renamed legacy rollback
   tables.
4. Confirm that Alembic reaches the current head and `/health` answers.

Do not delete the database volume or manually remove the listed rows to make startup pass. If a
different 0087 guard fails after updating, follow that guard's exact message because the automatic
repair applies only to transactions left behind by a deleted investment. See
[[docs/adr/111-complete-legacy-investment-delete-cascades|ADR-111]] for the decision and rollback
behavior.

### Migration 0088 cannot alter split_payments.amount because of a trigger

**Symptom:** Container startup repeats an `0088_money_precision_alignment` failure with:

```text
cannot alter type of a column used in a trigger definition
trigger trg_split_payment_overpayment_guard on table split_payments depends on column amount
```

**Cause:** The database previously ran the pre-squash split-audit migration and retained its
cent-scale payment trigger. Fresh databases on the consolidated chain do not have that trigger.
PostgreSQL records the trigger's `UPDATE OF amount` dependency and refuses to widen the column.

**Recovery:**

1. Keep or create a database backup before upgrading.
2. Update or rebuild the Vision app image so it contains the patched migration 0088.
3. Restart the app. Migration 0088 removes the legacy trigger and function, widens the money
   columns, then continues through 0089 and 0090.
4. Confirm that Alembic reports `0090_constraint_index_naming` and `/health` answers.

Do not delete the database volume or manually change the trigger while the app is boot-looping.
The failed attempt is transactionally rolled back. The canonical payment cap is the locked,
four-decimal validation in `splitRepository.addPayment`; see
[[docs/adr/112-retire-legacy-split-overpayment-trigger|ADR-112]].

### Port already in use

**Symptom:** `EADDRINUSE` on port 3002 (backend), 54329 (native PostgreSQL), or 8080 (frontend).

**Solutions:**

1. Find the process: `lsof -i :3002`, `lsof -i :54329`, or `lsof -i :8080`.
2. Stop the owning application cleanly. Use `kill <PID>` only for a known development process.
3. Or use the documented development-only port override. Packaged Vision fails closed instead of
   connecting to an unknown listener.

## Database

### Schema mismatch after migration

**Symptom:** App errors about missing columns or tables.

**Solutions:**

1. Create or verify a logical backup before recovery.
2. Run `bun run db:upgrade` so the guarded migration preflight is applied.
3. Check `alembic_version` read-only for the current schema revision.
4. Alembic is the authoritative source of schema DDL ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]) — `schemaInit.js` was deleted in Phase 1.

### Sequence drift on portfolio transactions

**Symptom:** Duplicate key error on `portfolio_transactions_base_id_seq`.

**Solutions:**

1. The repository auto-heals this by resyncing the sequence
2. If it persists: `SELECT setval('portfolio_transactions_base_id_seq', (SELECT MAX(id) FROM portfolio_transactions_base) + 1);`

## Frontend

### Charts not rendering

**Symptom:** Dashboard or portfolio charts show empty.

**Solutions:**

1. Check browser console for errors
2. Verify API is running and returning data
3. Check widget visibility settings (user may have hidden the widget)
4. Clear React Query cache: dev tools → "Clear Cache"

### Virtual table not updating after mutation

**Symptom:** Added/deleted transaction doesn't appear in table.

**Solutions:**

1. Ensure React Query invalidation includes the correct query key:
   - `transactions` for standard table
   - `transactions-virtual` for virtual table
2. Check network tab for failed API responses

### Search not working in virtual table

**Symptom:** Typing in search box doesn't filter results.

**Solutions:**

1. Check if `onSearchChange` callback is properly wired
2. Verify search query is being sent to the API
3. Check for 300ms debounce delay (`SEARCH_DEBOUNCE_MS` from `@/hooks/useDebounce`) — search is not instant

## Backend

### Rate limit exceeded

**Symptom:** `429 Too Many Requests` responses.

**Solutions:**

1. Standard limit: 100 req/min, export/patch: 30 req/min
2. Check `X-RateLimit-*` headers for current usage
3. Increase limits in middleware config if needed (development only)

### Import fails on large files

**Symptom:** CSV import times out or fails for large files.

**Solutions:**

1. Use the streaming import endpoint: `POST /api/import/csv/stream`
2. Streaming import processes in batches of 20 rows
3. Check server memory limits for very large files (>100K rows)

### Price provider returns stale data

**Symptom:** Investment prices not updating.

**Solutions:**

1. Price cache TTL: 5 minutes for live prices
2. Force refresh: call `POST /api/admin/investments/update-prices`
3. Check provider configuration in `priceProviderService.js`
4. For Kinesis spikes: use `POST /api/admin/investments/kinesis/sanitize-history`

## Electron Desktop App

### Backend authentication fails after app restart (macOS)

**Symptom:** After updating or reinstalling Vision, the app launches but all API calls return `FATAL: password authentication failed for user "ftm_user"`. Frontend loads but displays empty (no transactions, portfolio blank). TCC ("Vision would like to access data from other apps") prompt appeared during first use.

**Root cause:** Electron's `app.getName()` was returning `"vision-desktop"` (from `package.json` `name` field) instead of the bundle name `"Vision"`, causing `app.getPath('userData')` to resolve to `~/Library/Application Support/vision-desktop/` instead of the canonical `Vision/`. Rename or reinstall landed in a different userData directory, generating a fresh `embedded_compose/.env` with a new `POSTGRES_PASSWORD`, while the shared docker volume `embedded_compose_db_data` retained the old password from the first init. Postgres honors `POSTGRES_PASSWORD` only on first init, so authentication fails.

**Solution:** This is **fixed in version 2026-05-02+**. The app now calls `app.setName('Vision')` at startup and automatically migrates legacy userData. See [[docs/adr/045-electron-app-name-userData-migration|ADR-045]] for details.

**Recovery for already-broken Docker installs:** stop the application writer but leave PostgreSQL
available. Create a final custom-format logical dump and attachment export before changing any
configuration. Repair the credential mismatch against the preserved database or restore a verified
`.visionbak` into a separate database. Do not remove the Docker volume: it is the rollback source.
Native Vision uses a different private cluster and the explicit cutover importer described in
[[docs/guides/native-macos-runtime|Native macOS Runtime Guide]].

**Prevention:** Ensure you update to version 2026-05-02 or later. The migration helper automatically detects and renames legacy userData directories on first launch.

### macOS repeatedly asks for a password for "Vision Safe Storage"

**Symptom:** A macOS login-password dialog appears on Vision launch asking to allow access to "Vision Safe Storage" in the Keychain. Clicking Allow still prompts on subsequent launches.

**Root cause:** Vision ships ad-hoc unsigned (no Developer ID certificate — see [[docs/architecture/electron#code-signing-status|Code Signing Status]]). macOS treats the code identity as unstable and re-challenges Electron's `safeStorage` API every time, because the stored Keychain entry appears to belong to a different identity after each launch. `safeStorage` stores the backup encryption passphrase in the Keychain; Vision only touches it when a passphrase is configured.

**Workarounds (in order of preference):**

1. **Always Allow** — In the Keychain dialog, click **Always Allow** instead of Allow. This creates a permanent Keychain access exception for Vision Safe Storage and suppresses future prompts.

2. **Use the `VISION_BACKUP_PASSPHRASE` environment variable** — Set the passphrase as an env var instead of storing it in the Keychain. Vision reads this variable first and skips `safeStorage` entirely:

   ```bash
   # In a launcher script or launchd plist:
   export VISION_BACKUP_PASSPHRASE="your-passphrase-here"
   ```

   This is especially useful for automation or when the unsigned-app prompt is unacceptable.

3. **Remove the stored passphrase** — Open Settings → Backup, clear the encryption passphrase. Vision's lazy safeStorage access means it will not touch the Keychain at all when no passphrase is stored.

> [!note]
> If you never configured a backup passphrase, you should not see this prompt. The fix in Vision 2026-05-23 ensures `safeStorage` is only accessed when a passphrase blob exists in `settings.json`. If you're seeing this without having set a passphrase, try clearing the stored passphrase in Settings → Backup and restarting.

**For developers:** A signed/notarized build eliminates this entirely. See [[docs/architecture/electron#code-signing-status|Code Signing Status]] for how to configure a Developer ID build.

## Docker & Deployment

### Container won't start

**Symptom:** `docker compose up` fails.

**Solutions:**

1. Check logs: `docker compose logs app`
2. Verify `.env` file exists with required variables
3. Check container state and restarts: `docker compose ps`
4. Check port conflicts on host: `lsof -i :3002` and `lsof -i :5432`

### Database not initialized in Docker

**Symptom:** App starts but tables are missing.

**Solutions:**

1. `docker-entrypoint.sh` starts the Bun backend, whose guarded migration runner upgrades the schema
   on startup (both fresh DB and migration cases).
2. Check entrypoint logs for migration errors
3. On a fresh DB, the baseline migration `0001_initial_database_schema.py` creates all 27 tables, enums, indexes, and triggers ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]])

### App opens with an empty database (real data gone)

**Symptom:** The app starts cleanly but every page is empty — 0 transactions/accounts. `docker volume inspect vision_postgres_data --format '{{.CreatedAt}}'` shows a recent timestamp, and all three `vision_*` named volumes share that exact create time.

**Cause:** In the legacy Docker-backed desktop design, `docker-compose.yml` defaulted the Compose
project to this directory's basename, **`vision`**. Its `postgres_data` volume could therefore be
shared by the old packaged Docker provider, the Docker dev stack, and a mis-scoped local Compose
command. Removing those volumes recreated an empty database. This wiped real data on 2026-07-06.
Native Vision now uses a separate private PostgreSQL cluster and never mounts this volume, but the
preserved Docker volume remains irreplaceable rollback data during migration.

**Recovery:**

1. Restore the latest real-data `.visionbak` bundle (Settings → Backup → Restore). Real-data bundles are ~1 MB+; an empty-DB backup is ~28 KB, so pick by size/date. Requires `backupOnQuit`/periodic backups to have been enabled.
2. No migration is needed if the bundle's `schemaHead` (in `metadata.json`) equals the current alembic head.

**Prevention:**

1. Never run `down -v` / `volume rm` against project `vision` from the repo dir.
2. For e2e/CI/clean-slate stacks use an isolated project so their volumes are separate: `COMPOSE_PROJECT_NAME=vision_e2e docker compose … up -d` (baked into `.github/workflows/{ci,e2e}.yml`), or `docker-compose.clean.yml` (separate `vision_postgres_data_clean` volume).
3. Keep `backupOnQuit` on and back up off-machine (the iCloud copy is what enabled recovery).

## Common Error Messages

| Error              | Cause                               | Solution                                          |
| ------------------ | ----------------------------------- | ------------------------------------------------- |
| `VALIDATION_ERROR` | Request body failed validation      | Check required fields and types in API docs       |
| `DUPLICATE_ENTRY`  | Trying to create a duplicate record | Check deduplication logic or use update instead   |
| `NOT_FOUND`        | Resource doesn't exist              | Verify ID and check if soft-deleted               |
| `RATE_LIMITED`     | Too many requests                   | Wait and retry, check rate limits                 |
| `INTERNAL_ERROR`   | Server-side bug                     | Check server logs, report with reproduction steps |

## Related

- [[docs/guides/setup\|Setup Guide]] - Full setup instructions
- [[docs/guides/deployment\|Deployment Guide]] - Production deployment
- [[docs/api/index\|API Documentation]] - Endpoint reference
- [[docs/guides/migrations\|Migration Guide]] - Database migration management
