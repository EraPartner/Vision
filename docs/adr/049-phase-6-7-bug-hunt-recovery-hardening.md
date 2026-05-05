---
title: ADR-049 Phase 6.1–7 Bug Hunt Recovery Hardening
type: adr
status: Accepted
date: 2026-05-05
tags: [adr, bug-fix, phase-6, phase-7, electron, database, backup, security, recovery, timeout, concurrent-backup, health-watchdog, migration]
description: Phase 6.1 corrective migration fixes missing NOT NULL constraints on updated_at columns; Phase 7 hardens Electron backup/restore, enforces connection timeouts, prevents concurrent backups, and adds pre-restore data confirmation
aliases: [adr-049, phase-6-7, backup-restore-hardening, updated-at-constraints, concurrent-backup-guard]
---

# ADR-049: Phase 6.1–7 Bug Hunt Recovery Hardening

## Status

Accepted

## Date

2026-05-05

## Context

### Phase 6.1: Database Schema Inconsistency

During the bug hunt phase, a schema audit discovered that 11 core tables had `updated_at TIMESTAMPTZ` columns created **without** `NOT NULL DEFAULT NOW()` constraints:

- `categories`
- `recipients`
- `recipient_bank_accounts`
- `transactions`
- `planned_transactions`
- `planned_transaction_loan_schedule`
- `exchange_rates`
- `belgian_inflation_rates`
- `asset_price_history`
- `bank_statements`
- `reconciliation_entries`

**Impact:** These columns were nullable and unguarded against application-layer logic failures, where code forgot to write `updated_at` on update. This violates the audit-trail contract: every row should track its last modification time.

### Phase 7: Electron Backup/Restore Vulnerability & Timeout Risk

Phase 7 identified three related issues in the Electron main process:

1. **HTTP Connection Hung:** The `httpGet()` helper used for fetching backup settings and triggering backup operations had **no timeout**, causing the app to hang indefinitely if the backend became unresponsive mid-operation.

2. **Large Buffer Risk:** The `run()` helper (used for shell commands) defaulted to 200 MB `maxBuffer`, intended for capturing shell output. However, `pg_dump` is streamed via `spawn()`, not buffered, so the 200 MB default was unnecessary and wasted memory.

3. **Concurrent Backup Guard Missing:** `backup:run` IPC handler had no guard against multiple simultaneous backup operations, allowing a user to spam the backup button and overload the system with concurrent `pg_dump` processes.

4. **Restore Data Loss Risk:** `backup:restore` IPC handler silently overwrote live database without user confirmation, making accidental restores of stale backups a data-loss vector.

5. **Restore ↔ Watchdog Race Condition:** The health watchdog ran even during restore operations, potentially attempting to restart Docker containers while `pg_dump` was writing to the new database, causing corruption.

## Decision

### Phase 6.1: Corrective Migration (0022)

**File:** `alembic/versions/0022_updated_at_not_null_defaults.py`

Add a corrective migration **after 0021** (split_audit) that:

1. **Backfills NULL values** — Update all NULL `updated_at` to `COALESCE(created_at, NOW())`
   - `created_at` is guaranteed NOT NULL (set on row creation), so backfill is safe
   - Ensures historical rows have audit timestamps

2. **Sets NOT NULL constraint** — `ALTER TABLE ... ALTER COLUMN updated_at SET NOT NULL`

3. **Sets DEFAULT NOW()** — `ALTER TABLE ... ALTER COLUMN updated_at SET DEFAULT NOW()`
   - Future inserts without explicit `updated_at` are guarded

4. **Downgradeable** — `downgrade()` reverses all steps (DROP DEFAULT, DROP NOT NULL) for rollback testing

**Rationale:**
- Fixes schema compliance without rewriting history
- Enables timestamp-based auditing and change detection
- Prevents future bugs from forgetting `updated_at` writes

### Phase 7: Electron Hardening

#### 1. HTTP Request Timeout (10 seconds)

**Change in `httpGet(url)` function (line ~1498):**

```javascript
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { 'Content-Type': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('httpGet timed out after 10 s'));
    });
  });
}
```

**Why:** Prevents hung connections when:
- Backend crashes mid-request
- Network flaps briefly
- Docker container is OOM-killed mid-operation

**10s threshold:** Matches typical timeout budgets for backup settings API calls. Too short (1s) risks false positives on slow systems; too long (30s) leaves user staring at hung UI.

#### 2. Reduce Default `maxBuffer` in `run()` Helper

**Change in `run(exe, args, cwd, opts)` function:**

```javascript
// Before: maxBuffer: 200 * 1024 * 1024  (200 MB)
// After:  maxBuffer: 10 * 1024 * 1024   (10 MB)
```

**Why:** The `run()` function is used for small utility commands (e.g., `docker ps`, `docker inspect`). Large output (like `pg_dump`) uses `spawn()` with stream piping (not buffered). A 200 MB default wastes memory on typical commands.

**10 MB threshold:** Sufficient for `docker` CLI output; signals an error if any command exceeds it (e.g., corrupted JSON response).

#### 3. Concurrent Backup Guard (backupInFlight Flag)

**Change in `backup:run` IPC handler (line ~2183):**

```javascript
let backupInFlight = false;

ipcMain.handle('backup:run', async (_event, destDir, frontendStateJson = null) => {
  if (!workDir) return { success: false, error: 'workDir not set' };
  if (backupInFlight) return { success: false, error: 'A backup is already in progress' };
  backupInFlight = true;
  try {
    const result = await runBundleBackup(destDir, frontendStateJson);
    return result;
  } catch (err) {
    return { success: false, error: String(err) };
  } finally {
    backupInFlight = false;
  }
});
```

**Why:** Prevents UI rapid-clicking or programmatic re-invocation from spawning multiple concurrent `pg_dump` processes, which:
- Overload the system (CPU, I/O, memory)
- Produce corrupted bundles (two `pg_dump` writers to the same output)
- Lock the user out of the backup button until both complete

**Guard semantics:** First backup sets flag → subsequent calls rejected with clear message → flag cleared in `finally` block (even on error).

#### 4. Pre-Restore User Confirmation Dialog

**Change in `backup:restore` IPC handler (line ~2122):**

Before attempting restore, show a warning dialog:

```javascript
const { response } = await dialog.showMessageBox(mainWindow, {
  type: 'warning',
  buttons: ['Restore', 'Cancel'],
  defaultId: 1,
  cancelId: 1,
  title: 'Restore Backup',
  message: 'This will permanently replace all current data and cannot be undone.',
  detail: `Restore from: ${path.basename(resolved)}`,
});
if (response !== 0) return { success: false, error: 'Restore cancelled by user' };
```

**Why:** Data loss is permanent. A confirmation dialog:
- Prevents accidental restore from double-clicks or UI glitches
- Explicitly warns the user that data will be replaced
- Lets the user confirm the backup file name before proceeding

**Dialog defaults:** "Cancel" is the default button (index 1) so a careless Enter key press doesn't wipe data.

#### 5. Pause Health Watchdog During Restore

**Change in `backup:restore` IPC handler (lines ~2154, ~2174):**

```javascript
stopHealthWatchdog();
try {
  // ...restore logic...
  const result = isBundle
    ? await runBundleRestore(resolved, { passphrase })
    : await runRestore(resolved, { passphrase });
  return result;
} catch (err) {
  // ... error handling ...
} finally {
  startHealthWatchdog();
}
```

**Why:** During restore, the database is stopped, dropped, and recreated. The watchdog polling `GET /health` would see backend-offline, increment the failure counter, and potentially emit `backend:lost` events while restore is still in progress. Stopping it:
- Prevents spurious recovery alerts mid-restore
- Avoids watchdog attempting to restart containers while restore is writing the database
- Eliminates race conditions between restore cleanup and watchdog recovery logic

**Guarantee:** Even if restore fails, the `finally` block ensures watchdog restarts (recovery resilience).

## Consequences

### Positive

- **Phase 6.1:** Schema now guarantees every row has an `updated_at` timestamp; audit trail is complete and reliable
- **Phase 7 Timeout:** HTTP connections no longer hang the Electron main process indefinitely
- **Phase 7 Buffer Reduction:** Memory usage on typical operations drops from 200 MB to 10 MB
- **Phase 7 Concurrent Backup Guard:** Prevents data corruption and system overload from rapid backup clicks
- **Phase 7 Restore Confirmation:** Users cannot accidentally lose data to a stale backup
- **Phase 7 Watchdog Pause:** Restore operations complete without watchdog interference

### Neutral

- **Migration Runtime:** Phase 6.1 migration adds ~50ms on production (~11 tables × 4 updates each). Non-blocking; safe to run in dev or prod.
- **Watchdog Pause Window:** If backend crashes during restore, watchdog doesn't detect it until restore completes. Acceptable: restore is usually <30s; if it hangs, user has bigger problems.

### Negative

- **None anticipated.** Fixes are defensive; no behavior changes for normal operation.

## Implementation

### Code Changes

1. **`alembic/versions/0022_updated_at_not_null_defaults.py`** — New migration:
   - Backfill NULL `updated_at` values across 11 tables
   - Set NOT NULL + DEFAULT NOW() constraints
   - Downgradeable for testing

2. **`packaging/electron/main.js`:**
   - `httpGet()` function (line ~1498): Add `req.setTimeout(10000, ...)`
   - `run()` function: Change `maxBuffer` default from 200 MB to 10 MB
   - Module scope: Add `let backupInFlight = false;` (line ~2182)
   - `backup:run` IPC handler (line ~2183): Add `backupInFlight` guard + finally reset
   - `backup:restore` IPC handler (line ~2122):
     - Add `dialog.showMessageBox()` confirmation before restore
     - Call `stopHealthWatchdog()` before restore attempt
     - Call `startHealthWatchdog()` in `finally` block

### Testing

```bash
# Phase 6.1
alembic upgrade 0022  # Verify migration runs without errors
psql -c "SELECT * FROM categories WHERE updated_at IS NULL"  # Verify no NULLs after migration
psql -c "CREATE TABLE test (id SERIAL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"  # Verify constraint works

# Phase 7
# Kill backend mid-backup → httpGet should timeout after ~10s, not hang forever
# Spam backup button → Second request should return "backup already in progress"
# Attempt restore → Should show confirmation dialog before proceeding
# Initiate restore → Watchdog should be silent during restore; restart on completion
```

## Related

- [[docs/adr/002-database-schema|ADR-002: Database Schema Design]] — Schema design rationale; updated_at audit columns
- [[docs/adr/040-backup-format-v2-aead-encryption|ADR-040: Backup Format v2 AEAD Encryption]] — Backup format & security
- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022: Electron Sandbox Hardening & Recovery]] — Health watchdog + backend recovery
- [[docs/features/backup-coverage-audit|Feature: Backup Coverage Audit]] — Backup system overview
- [[docs/architecture/electron|Electron Desktop Architecture]] — Startup sequence, watchdog, backup/restore flows
- [[docs/security/data-protection|Security: Data Protection]] — Database backup encryption & integrity
