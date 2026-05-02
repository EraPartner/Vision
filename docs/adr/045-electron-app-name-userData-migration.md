---
title: ADR-045 Electron app.setName() and userData Directory Migration
type: adr
status: Accepted
date: 2026-05-02
tags: [adr, electron, macos, tcc, security, app-naming, docker-compose, password-mismatch, migration, phase-0, bug-fix]
description: Fix macOS TCC userData prompt mismatch and prevent password authentication failures by aligning app.getName() with CFBundleName via app.setName(), plus legacy userData directory migration helper to preserve docker-compose state.
aliases: [adr-045, app naming, userData, TCC, macOS Sonoma, docker volume, password mismatch]
---

# ADR-045: Electron app.setName() and userData Directory Migration

## Status
Accepted

## Date
2026-05-02

## Context

Vision.app bundles as a macOS application with:
- **Bundle name (CFBundleName):** "Vision" (set in `packaging/electron/package.json` `productName`)
- **Package name (`package.json` `name` field):** "vision-desktop"

Electron's `app.getName()` defaults to the `package.json` `name` field, not the bundle's CFBundleName.

### The macOS Sonoma+ TCC Prompt Problem

macOS Sonoma and later use **Transparency, Consent, and Control (TCC)** to audit filesystem access. When an app (identified by its bundle name) reads/writes a folder with a **different name**, macOS flags it as cross-app data access and fires the prompt:

```
"Vision would like to access data from other apps."
```

In Vision's case:
- App bundle name: `Vision.app`
- `app.getPath('userData')` resolved to: `~/Library/Application Support/vision-desktop/`
  - (because `app.getName()` was "vision-desktop")

macOS detected a mismatch and triggered the TCC prompt on every data access, degrading UX.

### The Cascading Failure Chain

Worse, this mismatch caused a **critical runtime failure**:

1. User launches Vision → TCC prompt fires → user grants permission
2. First launch: `~/Library/Application Support/Vision/` does NOT exist yet
3. First launch generates fresh `embedded_compose/.env` with a new `POSTGRES_PASSWORD=<random>`
4. User later renames/reinstalls the app or Electron updates app location
5. Second launch: Electron now reads from `~/Library/Application Support/vision-desktop/` (renamed/reinstalled instance)
6. Second launch generates another fresh `embedded_compose/.env` with a DIFFERENT `POSTGRES_PASSWORD=<random2>`
7. Docker Compose project name is `embedded_compose` (computed as `basename(workDir)`)
   - **Problem:** Named volume `embedded_compose_db_data` is **shared** across all instances because project name never changes
   - Volume still has OLD password from first init (Postgres only honors `POSTGRES_PASSWORD` on first init)
8. Backend tries to authenticate with NEW password against volume with OLD password
   - `FATAL: password authentication failed for user "ftm_user"`
9. Backend 500s on every request → frontend loads but displays empty (no transactions, no portfolio)
10. User sees **completely broken app** after granting TCC permission

Recovery required manual `docker volume rm` + restore from backup.

## Decision

### 1. Force app.getName() to Match CFBundleName

**Location:** Top of `packaging/electron/main.js`, **before any `app.getPath()` call:**

```javascript
// ── App identity ──────────────────────────────────────────────────────────────
// Force Electron's runtime name to match CFBundleName ("Vision") so
// `app.getPath('userData')` resolves to ~/Library/Application Support/Vision/
// instead of the package.json `name` field ("vision-desktop"). Without this:
//   1. macOS Sonoma+ TCC fires the "Vision would like to access data from
//      other apps" prompt, because Vision.app reads/writes a userData folder
//      whose name doesn't match its bundle.
//   2. Each rename/reinstall lands in a different userData dir, generating a
//      fresh .env with a new POSTGRES_PASSWORD while the docker volume
//      `embedded_compose_db_data` (project name = basename of workDir =
//      "embedded_compose") is shared and keeps the OLD password — backend
//      auth fails, frontend loads empty.
// MUST run before any `app.getPath('userData')` (e.g. settingsPath below).
app.setName('Vision');
```

**Consequence:** All Electron instances now use the canonical `~/Library/Application Support/Vision/`.

### 2. One-Shot userData Migration Helper

**Location:** Immediately after `app.setName()`, before `settingsPath` initialization:

A one-time IIFE (`migrateLegacyUserData()`) detects and migrates the legacy "vision-desktop" userData directory:

```javascript
(function migrateLegacyUserData() {
  try {
    const target = app.getPath('userData');
    const legacy = path.join(path.dirname(target), 'vision-desktop');
    if (legacy === target) return; // Already migrated or fresh install
    if (!fs.existsSync(legacy)) return; // No legacy dir to migrate
    
    const targetExists = fs.existsSync(target);
    const targetEmpty = targetExists
      ? fs.readdirSync(target).filter(n => n !== '.DS_Store').length === 0
      : false;
    
    if (!targetExists || targetEmpty) {
      // Target doesn't exist or is empty → safe to rename legacy → Vision
      if (targetExists) fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(legacy, target);
      console.error('[migrate] Moved legacy userData "vision-desktop" → "Vision"');
    } else {
      // Both exist and target is populated → archive legacy to avoid conflicts
      const archived = `${legacy}.legacy-${Date.now()}`;
      fs.renameSync(legacy, archived);
      console.error(`[migrate] "Vision" userData already populated; archived legacy dir to ${archived}`);
    }
  } catch (err) {
    console.warn('[migrate] userData migration failed (non-fatal):', err && err.message ? err.message : err);
  }
})();
```

**Migration Logic:**

| Scenario | Action | Why |
|----------|--------|-----|
| Fresh install (no legacy dir) | Skip | Nothing to migrate |
| Already migrated (legacy === target) | Skip | Already done |
| Legacy exists, target empty | Rename `vision-desktop/` → `Vision/` | Preserves `settings.json` + `embedded_compose/.env` |
| Legacy exists, target populated | Rename legacy → `vision-desktop.legacy-<ts>` | Avoids TCC visibility of orphaned folder, preserves forensics |

**Benefits of this approach:**

1. **Preserves docker-compose state** — `embedded_compose/.env` (with original `POSTGRES_PASSWORD`) stays in userData, so the shared volume authenticates correctly
2. **Non-fatal** — Wrapped in try-catch; any error is logged (non-fatal) and app continues normally
3. **One-shot** — Idempotent; subsequent launches skip immediately if no legacy dir exists
4. **Clean TCC view** — Archiving prevents the legacy folder name from appearing in macOS's TCC audit logs

## Consequences

### Positive

- **TCC prompt eliminated** — App bundle name ("Vision") matches userData folder name, so macOS recognizes it as same-app access
- **Password mismatch prevented** — Fresh installs or updates preserve docker-compose state (settings + .env) so the shared volume stays authenticated
- **User experience** — No mysterious "completely broken app after granting permission" failure
- **Backward compatibility** — Existing installs migrate automatically on next launch; no user action needed
- **Forensics preserved** — Legacy folder archived (not deleted) if both exist, aiding debugging

### Neutral

- **One-time overhead** — First launch after upgrade checks/renames one directory (negligible I/O)
- **Error handling is optional** — Non-fatal error path lets app start even if migration fails (e.g., permission denied on rename)

### Negative

- **None anticipated.** The fix is purely structural (matching names), not behavioral.

## Implementation

### Code Changes

1. **`packaging/electron/main.js` (lines ~63–105):**
   - `app.setName('Vision')` before any `app.getPath('userData')` usage
   - `migrateLegacyUserData()` IIFE immediately after
   - No other changes to startup logic

### Testing

```bash
# Fresh install (clean system)
# Expected: No migration messages; userData created at ~/Library/Application Support/Vision/

# Existing install (legacy vision-desktop dir)
# Expected: [migrate] Moved legacy userData "vision-desktop" → "Vision"
# Verify: ~/Library/Application Support/vision-desktop/ no longer exists
#         ~/Library/Application Support/Vision/embedded_compose/.env unchanged

# Post-update with docker volume conflict
# Expected: docker-compose reuses existing volume with original password
#           Backend authenticates successfully
#           No 500 errors from password mismatch
```

## Related

- [[docs/architecture/electron|Electron Desktop Architecture]] — App startup sequence, userData, TCC
- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022: Electron Sandbox Hardening]] — Electron security posture
- [[docs/features/application-updates|Application Updates Feature]] — Update modes and backup recovery
- `[[packaging/electron/main.js]]` — Startup code with app.setName() + migrateLegacyUserData()
