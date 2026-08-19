---
title: Troubleshooting & FAQ
type: reference
status: active
date: 2026-04-21
updated: 2026-08-19
tags: [troubleshooting, faq, reference, debugging, phase-1, electron, app-naming, password-mismatch, keychain, safe-storage, macOS, backup-passphrase, compose-project-name, data-loss, down-v, volume-isolation, backup-restore, docker, architecture, migrations, adr-109, adr-111, migration-0088, adr-112]
description: Common Vision errors and recovery steps, including database migration failures, Electron authentication failures, macOS Keychain prompts, and Docker volume safety.
aliases: [troubleshooting, FAQ, common issues, errors, debugging, problems]
---

# Troubleshooting & FAQ

> [!abstract] Purpose
> Common issues, error messages, and their solutions. Organized by area for quick lookup.

## Setup & Development

### PostgreSQL won't start

**Symptom:** `bun run docker:dev` fails because the database service does not become healthy.

**Solutions:**
1. Check db container logs: `docker compose -f docker-compose.yml -f docker-compose.dev.yml logs db`
2. Verify container status: `docker compose -f docker-compose.yml -f docker-compose.dev.yml ps`
3. If state is corrupted, reset dev volumes: `bun run docker:clean:reset`
4. Ensure Docker Desktop is running and has enough disk space

### Containers fail with entrypoint or architecture errors

**Symptoms:** The database logs `docker-entrypoint.sh: exec format error`, or the app logs
`/bin/sh: can't open '/entrypoint.sh': Permission denied`.

Run `bun run docker:dev:rebuild`. The current official `postgres:18-alpine` ARM64 image can contain
empty entrypoint scripts, producing the database error; see
[docker-library/postgres#1378](https://github.com/docker-library/postgres/issues/1378). The dev
override temporarily runs only Postgres as `linux/amd64` under Docker Desktop emulation. The app
image still builds for the Docker host's native platform.

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
1. Verify PostgreSQL container is running: `docker compose -f docker-compose.yml -f docker-compose.dev.yml ps db`
2. Check `DATABASE_URL` in `.env.local` matches the actual connection string
3. Default local backend URL: `postgresql://ftm_user:ftm_password@localhost:5432/financial_transactions`

### Migration fails

**Symptom:** `bun run db:upgrade` throws an error.

**Solutions:**
1. Check current version: `alembic current`
2. View pending migrations: `alembic history --verbose`
3. If stuck mid-migration, Alembic auto-rolls back (PostgreSQL transactional DDL)
4. For manual recovery: `alembic downgrade -1` then retry

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

**Symptom:** `EADDRINUSE` on port 3002 (backend) or 5173 (frontend).

**Solutions:**
1. Find the process: `lsof -i :3002` or `lsof -i :5173`
2. Kill it: `kill <PID>`
3. Or change the port in `.env.local`

## Database

### Schema mismatch after migration

**Symptom:** App errors about missing columns or tables.

**Solutions:**
1. Run `alembic upgrade head` to apply all pending migrations
2. Check `alembic_version` table for current schema version
3. Alembic is the authoritative source of schema DDL ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]]) — `schemaInit.js` was deleted in Phase 1

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

**Recovery for already-broken installs:**

If you're seeing this error and cannot wait for an app update:

1. **Delete the corrupted docker volume:**
   ```bash
   docker volume rm embedded_compose_db_data   # or vision_postgres_data if in repo mode
   ```

2. **Restore from your most recent backup** (if available):
   - Open Settings → Backup
   - Select a recent backup file and click "Restore"
   - Follow the passphrase prompt if the backup is encrypted

3. **Relaunch Vision.app**
   - The app will recreate the docker volume with fresh credentials
   - Backend authentication should now succeed

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
1. The `docker-entrypoint.sh` runs `alembic upgrade head` on startup (both fresh DB and migration cases)
2. Check entrypoint logs for migration errors
3. On a fresh DB, the baseline migration `0001_initial_database_schema.py` creates all 27 tables, enums, indexes, and triggers ([[docs/adr/027-alembic-single-source-of-schema|ADR-027]])

### App opens with an empty database (real data gone)

**Symptom:** The app starts cleanly but every page is empty — 0 transactions/accounts. `docker volume inspect vision_postgres_data --format '{{.CreatedAt}}'` shows a recent timestamp, and all three `vision_*` named volumes share that exact create time.

**Cause:** `docker-compose.yml` sets no `name:`, so the compose project defaults to this directory's basename → **`vision`**, whose `postgres_data` volume holds the **real** database — and it's shared by the packaged Vision.app, the dev stack, *and* anyone running the CI/e2e compose commands from the repo. A `docker compose down -v` (or `docker volume rm vision_postgres_data`, or a mis-scoped `bun run docker:clean:reset`) run from this directory destroys it; the next `up` recreates it empty. This wiped real data on 2026-07-06.

**Recovery:**
1. Restore the latest real-data `.visionbak` bundle (Settings → Backup → Restore). Real-data bundles are ~1 MB+; an empty-DB backup is ~28 KB, so pick by size/date. Requires `backupOnQuit`/periodic backups to have been enabled.
2. No migration is needed if the bundle's `schemaHead` (in `metadata.json`) equals the current alembic head.

**Prevention:**
1. Never run `down -v` / `volume rm` against project `vision` from the repo dir.
2. For e2e/CI/clean-slate stacks use an isolated project so their volumes are separate: `COMPOSE_PROJECT_NAME=vision_e2e docker compose … up -d` (baked into `.github/workflows/{ci,e2e}.yml`), or `docker-compose.clean.yml` (separate `vision_postgres_data_clean` volume).
3. Keep `backupOnQuit` on and back up off-machine (the iCloud copy is what enabled recovery).

## Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `VALIDATION_ERROR` | Request body failed validation | Check required fields and types in API docs |
| `DUPLICATE_ENTRY` | Trying to create a duplicate record | Check deduplication logic or use update instead |
| `NOT_FOUND` | Resource doesn't exist | Verify ID and check if soft-deleted |
| `RATE_LIMITED` | Too many requests | Wait and retry, check rate limits |
| `INTERNAL_ERROR` | Server-side bug | Check server logs, report with reproduction steps |

## Related

- [[docs/guides/setup\|Setup Guide]] - Full setup instructions
- [[docs/guides/deployment\|Deployment Guide]] - Production deployment
- [[docs/api/index\|API Documentation]] - Endpoint reference
- [[docs/guides/migrations\|Migration Guide]] - Database migration management
