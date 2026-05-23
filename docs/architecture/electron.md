---
title: Electron Desktop Architecture
type: architecture-doc
status: active
date: 2026-04-27
updated: 2026-05-23
tags: [architecture, electron, desktop, packaging, security, sandbox, health-monitoring, async-io, csp-headers, dev-rebuild, phase-0, phase-1, phase-2, phase-6, phase-7, backup, restore, bundle, ipc, encryption, schema-migration, npm-vs-bun, docker-compose, pre-pull, startup, troubleshooting, alembic-migration-fixes, deployment-modes, shell-installer, docker-pull, update-system, checksum-verification, backup-before-update, cicd, april-2026, bug-hunt, recovery-hardening, concurrent-backup-guard, timeout, watchdog-pause]
description: Electron desktop application architecture, IPC communication, sandbox hardening, health monitoring, Docker image pre-pull optimization, backup/restore bundle system (Phase 1+2), three-mode application update system with checksum verification (April 2026), and Phase 7 backup/restore hardening with concurrent-backup guard, HTTP timeout, and watchdog pause (May 2026)
aliases: [electron, desktop app, packaging, IPC, main process, sandbox, watchdog, backup, bundle, update system, deployment modes]
related_code: ["packaging/electron/", "packaging/electron/backup/bundle.js", "packaging/electron/main.js", "packaging/electron/preload.js", "apps/frontend/src/lib/api/electron.ts", "apps/frontend/src/components/notifications/UpdateNotification.tsx", "apps/frontend/src/components/settings/tabs/AppTab.tsx", "apps/node-backend/src/main.js", "alembic/versions/0001_initial_database_schema.py", ".github/workflows/ci.yml", ".github/workflows/release.yml"]
---

# Electron Desktop Architecture

## Overview

Vision runs as an Electron desktop application, bundling the React frontend and Node.js backend into a single distributable package.

---

## Architecture

### Process Model

```
┌─────────────────────────────────────────────────────┐
│                   Main Process                       │
│  ┌───────────────────────────────────────────────┐  │
│  │  Electron Main (BrowserWindow management)     │  │
│  │  ├── Creates renderer window                  │  │
│  │  ├── Manages app lifecycle                    │  │
│  │  ├── Handles native OS features               │  │
│  │  └── Spawns backend server                    │  │
│  └───────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │ IPC
┌──────────────────────┴──────────────────────────────┐
│                  Renderer Process                    │
│  ┌───────────────────────────────────────────────┐  │
│  │  React App (Chromium)                         │  │
│  │  ├── UI components                            │  │
│  │  ├── State management                         │  │
│  │  └── API calls to localhost backend           │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│                  Backend Process                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  Express Server (Node.js/Bun)                 │  │
│  │  ├── REST API                                 │  │
│  │  ├── PostgreSQL connection                    │  │
│  │  └── External service integrations            │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Communication Pattern

The frontend communicates with the backend via **HTTP on localhost**, not via Electron IPC:

```
Renderer (React) ──HTTP──▶ Express Backend (localhost:3002)
```

This design choice means:
- The backend is a standard Express app (testable independently)
- The frontend is a standard React app (deployable to web)
- Electron is just the packaging layer

---

## Configuration

### Location

Electron configuration is in `packaging/electron/`.

### Key Settings

| Setting | Value | Description |
|---------|-------|-------------|
| `contextIsolation` | true | Security: isolate preload from renderer |
| `nodeIntegration` | false | Security: no Node.js in renderer |
| `sandbox` | true | Security: sandboxed renderer |

---

## Startup Sequence

### App Identity & userData Directory

**⚠️ Critical:** `app.setName('Vision')` is called at the very top of main.js, before any `app.getPath('userData')` calls.

- **Why:** `package.json` `name` field is `"vision-desktop"`, but the macOS bundle name (CFBundleName) is `"Vision"` (appId: `com.vaultvoyager.vision`)
- **Without this:** Electron's `app.getName()` returns `"vision-desktop"`, causing `app.getPath('userData')` to resolve to `~/Library/Application Support/vision-desktop/` instead of the canonical `Vision/`
- **macOS Sonoma+ consequence:** TCC (Transparency, Consent, and Control) treats the mismatch as cross-app data access, firing the prompt `"Vision would like to access data from other apps"` on every data access
- **Cascading failure:** Rename/reinstall lands in a different userData dir, regenerating a fresh `embedded_compose/.env` with a new `POSTGRES_PASSWORD`, while the shared docker volume keeps the old password → backend authentication fails → app appears completely empty

See [[docs/adr/045-electron-app-name-userData-migration|ADR-045]] for the full problem statement and migration strategy.

**One-shot userData migration (lines ~82–104):**

The `migrateLegacyUserData()` IIFE detects and migrates any legacy `vision-desktop/` userData directory to the canonical `Vision/`:

- **Fresh install:** No legacy dir → skip migration
- **Existing install (legacy only):** Rename `vision-desktop/` → `Vision/`; preserves `settings.json` and `embedded_compose/.env` so docker volume stays authenticated
- **Migration conflict (both exist):** Archive legacy to `vision-desktop.legacy-<timestamp>` to avoid TCC visibility

Migration is non-fatal; any error is logged and app continues.

### Main Process Initialization

1. **Electron Main** starts, calls `app.requestSingleInstanceLock()`
   - If lock unavailable (another instance running), quit immediately
   - Otherwise, register `second-instance` handler to focus existing window

2. **Security Headers Registration** via `registerSecurityHeaders()`
   - Installs Content-Security-Policy and other security headers via `session.webRequest.onHeadersReceived`
   - Gated by `app.isPackaged` (dev mode leaves HMR unrestricted)
   - CSP: `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: https:`, etc.

3. **Internationalization** loaded asynchronously via `await initI18n()`
   - `loadI18nAsync()` reads locale from `app.getLocale()`, tries resource path then fallback dir
   - Deferred from module-load init to support async `fs.promises` in preload/runtime (Phase 0)

4. **Parallel Initialization** — All of the following run concurrently via `Promise.all()`:
   - **Docker status check** — `check_docker()` pings Docker Unix socket `/_ping` (~30ms on macOS)
   - **Port discovery** — Find open port for backend (default 3002)
   - **Environment initialization** — Resolve workspace paths, detect dev mode
   - **Docker image pre-pull** (packaged mode only, 2026-04-27) — Pull `ghcr.io/erapartner/vision:<tag>` if image missing locally; non-fatal, falls back to inline pull during `compose up`
   - **Build decision** — Skip-build cache: compare Docker image ID + git working-tree state against `.vision-cache/docker-build.json`; skip `--build` if unchanged

5. **Backend server** spawned as child process via `docker-compose up`
   - If image was pulled in step 4, skip `--build` flag
   - Emit boot mark: `pre_pull_image` (packaged mode)

### Backend Startup

6. **Backend startup** (inside container via `docker-entrypoint.sh` + `apps/node-backend/src/main.js`):
   - **Database connection** — `checkConnection()` polls with exponential backoff (40 attempts, 50ms→1s)
   - **Alembic migrations** — JS runner checks DB version + migrations fingerprint; skips if at head
   - **FX cache warmup** — Exchange rate and portfolio historical rate refresh (parallel promises)
   - **Snapshot computation** — Portfolio snapshots computed after FX data is available
   - **Info caches** — Net-worth and portfolio-performance caches warmed

### Frontend Initialization

7. **Readiness Poll** — `pollAndLoad({ building })` uses a build-aware budget and gates the FIRST navigation on `/health/detailed` readiness:
   - Polls `GET /health/detailed` every 300ms (`VISION_HEALTH_POLL_INTERVAL_MS`) via `pingReady()` + `pollReady()`
   - **Readiness predicate:** navigate when `/health/detailed` returns `status === 'ready'` OR `caches.materializedViews === true`. The materialized-views flag is DB-only and fast; network-bound warmup tasks (exchange rates, portfolio snapshots) cannot stall startup.
   - **Fallback:** if the `/health/detailed` endpoint returns 404 (older backend) or an unparseable 2xx, the shell treats the response as ready and navigates — ensuring it never blocks longer than the previous shallow liveness check.
   - **Warm boot** (no build): max `VISION_HEALTH_POLL_ATTEMPTS` attempts (default 200, ≈56s). On timeout the "taking longer than expected" modal fires and then the error page loads with Retry/OpenLogs.
   - **Cold/build launch** (image was pulled or built during this launch): max `VISION_HEALTH_POLL_BUILD_ATTEMPTS` attempts (default 600, ≈3 min). The slow-start modal is suppressed; on timeout the app falls through directly to the recoverable error page.
   - `pollReady(maxAttempts)` replaces `pollHealth` inside `pollAndLoad` for the initial navigation path. The boot mark was renamed `poll_health` → `poll_ready`.
   - The `recovery:retry` IPC handler calls `pollAndLoad()` with no arguments (warm budget + modal), because a manual retry means the image already exists. Restart/update/dev-rebuild flows still use the lighter `pollHealth` liveness probe (unchanged).
   - On success: proceed to step 8

> [!info] Why `/health/detailed` for initial navigation only
> `GET /health` (shallow liveness) returns 200 the moment Express listens — before `refreshMaterializedViews()` and other warmup tasks finish. Navigating on that caused a cold-start blank dashboard until a restart. The health watchdog and restart/update flows still use the shallow `/health` probe because "is the backend process alive?" is the right question for those paths. See [[docs/api/health|Health API]] for the distinction between `status: warming` and `status: ready`.

8. **Create BrowserWindow** with sandbox enabled + loading frontend

9. **Watchdog Loop** starts (10s interval):
   - Polls `GET /health` continuously
   - 3 consecutive failures → emit `backend:lost` IPC event to renderer
   - Recovery → emit `backend:restored` event

10. **Frontend** connects to backend at `http://localhost:3002`

11. **Renderer** subscribes to `backend:lost` and `backend:restored` events via `window.electronRecovery.onBackendLost/onBackendRestored()`

---

## Packaging

### macOS Distribution

Vision packages into native macOS formats via `electron-builder`:

#### Output Artifacts

| Format | Purpose | Location |
|--------|---------|----------|
| `.app` bundle | Native macOS application | `dist/mac-arm64/Vision.app` |
| `.dmg` | Drag-to-install disk image | `dist/Vision-1.0.0-arm64.dmg` |
| `.zip` | Compressed bundle for archival | `dist/Vision-1.0.0-arm64-mac.zip` |

**Build:** `cd packaging/electron && npm run dist`

#### Configuration

Electron-builder configuration in `packaging/electron/package.json`:

```json
{
  "build": {
    "appId": "com.vaultvoyager.vision",
    "productName": "Vision",
    "directories": {
      "buildResources": "build"
    },
    "files": ["main.js", "preload.js", "backup/**/*", "assets/**/*"],
    "extraResources": [
      { "from": "i18n", "to": "i18n" },
      { "from": "resources", "to": "resources" }
    ],
    "mac": {
      "target": ["dmg", "zip"],
      "category": "public.app-category.finance",
      "icon": "build/icon.icns"
    }
  }
}
```

**Key Configuration Details:**

- **`files`** — Packed inside `app.asar`. Must include `backup/**/*` (backup/restore bundle) and `assets/**/*` (frontend dist). If missing, runtime raises `Cannot find module './backup/bundle'`.

- **`extraResources`** — Kept outside asar at `Contents/Resources/`. Must include `i18n/` and `resources/` because `main.js` references them via `process.resourcesPath` (lines 22, 204, 234). Packing them in asar breaks runtime path resolution.

- **`pull_policy: missing`** in embedded `resources/docker-compose.yml` — Uses local Docker image if available; avoids GHCR registry auth failures on first launch.

#### Icon

- **Source**: `packaging/electron/build/icon.svg` (1024px, stylized "V eye" gradient on dark navy rounded square)
- **Compiled**: `packaging/electron/build/icon.icns` (macOS native icon format)
- **Referenced in package.json**: `mac.icon: "build/icon.icns"`

If updating the icon, regenerate `.icns` from `.svg` using an asset pipeline tool (e.g., `iconutil`, Figma export, or CI build step).

#### Code Signing Status

- **Current**: Ad-hoc unsigned (no Developer ID certificate)
- **Suitable for**: Personal/local use, internal distribution
- **First launch**: macOS Gatekeeper prompts "Cannot be verified"; user can:
  - Right-click → "Open"
  - Or: `xattr -dr com.apple.quarantine /Applications/Vision.app`
- **For production**: Acquire Developer ID, set `mac.signingIdentity` + `mac.notarize` in electron-builder config

#### Package Manager (npm vs. bun)

The `packaging/electron/` sub-package uses **npm** for dependency management, while the root project uses **bun**.

**Why npm for electron-builder?**

Bun's nested-hoisting algorithm places transitive dependencies in their own `node_modules/` trees, with shared deps at intermediate paths. This confuses electron-builder's asar tree-walker, resulting in incomplete bundling — runtime hits `Cannot find module 'archiver-utils'` even though the package is installed.

**Solution:** npm's flat-top-level hoisting ensures all dependencies (including Archiver's transitives) live at `node_modules/` root, where electron-builder can find and bundle them correctly.

**Transitive Explicit Declaration:** Because hoisting timing varies, Vision's `packaging/electron/package.json` explicitly declares archiver's transitives:

```json
{
  "dependencies": {
    "archiver": "^7.1.2",
    "archiver-utils": "^5.0.2",
    "compress-commons": "^6.0.2",
    "readable-stream": "^4.5.2",
    "zip-stream": "^6.0.1"
  }
}
```

This forces npm and electron-builder to include them at the correct depth inside `app.asar`, guaranteeing backup serialization works at runtime.

### Platforms (Future)

- **Windows** — `.exe` / `.msi` (not yet implemented)
- **Linux** — `.AppImage` / `.deb` (not yet implemented)

### Bundled Components

- React frontend (built with Vite)
- Node.js backend (spawned as child process, not bundled)
- PostgreSQL (external — not bundled, requires Docker Desktop)

---

## Native Features

### Backup/Restore (Phase 1+2)

**IPC Handlers** for bundle-based backup/restore:

| Handler | Signature | Purpose | Status |
|---------|-----------|---------|--------|
| `backup:run` | `(destDir, frontendStateJson?)` → Promise | Create and optionally encrypt `.visionbak` bundle; returns `{ success, file, encrypted?, cleanupRemoved?, warning?, error? }` | ✅ Phase 1+2 |
| `backup:restore` | `(bundlePath)` → Promise | Restore from `.visionbak` bundle; schema-checks, drops DB, loads SQL, swaps attachments, restores frontend state; returns `{ success, file?, frontendState?, error? }` | ✅ Phase 1+2 |
| `backup:select-file` | `()` → Promise<string> | Show file picker for `.visionbak` or `.visionbak.enc` selection | ✅ Phase 1+2 |
| `backup:select-dir` | `()` → Promise<string> | Show folder picker for backup directory | ✅ Phase 1+2 |
| `backup:save-settings` | `({ backupDir, backupOnQuit })` → Promise | Persist backup settings to `settings.json` | ✅ Phase 1+2 |
| `backup:load-settings` | `()` → Promise | Load backup settings (directory, onQuit flag, encryption status) | ✅ Phase 1+2 |
| `backup:get-encryption-status` | `()` → Promise | Return `{ hasStoredPassphrase }` | ✅ Phase 1+2 |
| `backup:set-passphrase` | `(passphrase)` → Promise | Set or update backup encryption passphrase (stored encrypted in `settings.json`) | ✅ Phase 1+2 |

**Frontend Integration:**

- `apps/frontend/src/lib/api/electron.ts` — Type definitions and wrapper functions
  - `runBackup(destDir, frontendStateJson?)` — Collects localStorage snapshot, invokes `backup:run`
  - `restoreBackup(filePath)` — Invokes `backup:restore`, writes frontend state back to localStorage
- `apps/frontend/src/components/settings/tabs/BackupTab.tsx` — UI for backup/restore, passphrases, directory selection
  - Handles `BUNDLE_SCHEMA_NEWER` error with user-friendly toast

**Passphrase Storage & OS Keychain (Lazy safeStorage):**

The backup encryption passphrase (when set by the user) is stored encrypted in `settings.json` using Electron's `safeStorage` API, which on macOS delegates to the system Keychain under the entry "Vision Safe Storage".

Vision is ad-hoc unsigned (no Developer ID certificate), so macOS treats the code identity as unstable. Normally, accessing `safeStorage` on every launch would trigger a login-password prompt even for users who have never configured a passphrase. The shell avoids this with lazy access:

- `getBackupPassphrase()` reads the stored `backupPassphraseEncrypted` blob from `settings.json` **before** calling `safeStorage.isEncryptionAvailable()` or `decryptString()`. If no blob is stored and the `VISION_BACKUP_PASSPHRASE` env var is absent, it returns without touching the keychain — zero prompts.
- `getBackupPassphraseStatus()` (IPC: `backup:get-encryption-status`, used by the Backup settings tab) only calls `isEncryptionAvailable()` when a passphrase is already stored. With nothing stored it reports availability from the mere presence of the `safeStorage` API object (no keychain probe). The real availability check happens in `setBackupPassphrase()` when the user actually opts in.

> [!info] Keychain prompts on unsigned builds
> Users who store a passphrase will still see macOS password prompts on an unsigned build because macOS re-challenges an unstable code identity each time. Workarounds:
> - Click **Always Allow** in the Keychain prompt to suppress future challenges for this app.
> - Set the `VISION_BACKUP_PASSPHRASE` environment variable — this bypasses `safeStorage` entirely and is useful for automation or CI.
> - Do not configure a backup passphrase if prompts are unwanted; unencrypted backups work without keychain access.
>
> Note: `safeStorage` only *stores/retrieves the passphrase*. The backup encryption key itself is always scrypt-derived from the passphrase and never touches the keychain.

**Bundle Format:**

See [[docs/features/backup-coverage-audit|Backup Coverage Audit]] for `.visionbak` structure, encryption details, and restore process.

#### Phase 7 Hardening (May 2026)

Three critical issues discovered during bug hunt phase were hardened:

**Issue 1: HTTP Connection Hang**
- **Problem:** `httpGet()` helper (used for fetching backup settings, triggering backup) had no timeout, causing indefinite hangs if backend became unresponsive mid-operation
- **Fix:** Added `req.setTimeout(10000, ...)` to destroy hung connections after 10 seconds
- **Impact:** Prevents UI freeze; timeout is generous enough for slow systems but short enough to show feedback quickly

**Issue 2: Concurrent Backup Operations**
- **Problem:** Renderer could rapid-click the backup button, spawning multiple concurrent `pg_dump` processes that overloaded the system or corrupted backup bundles
- **Fix:** Module-scope `let backupInFlight = false;` guard in `backup:run` IPC handler; first backup sets flag, subsequent calls rejected with clear message, flag reset in `finally` block
- **Impact:** Prevents data corruption, system overload, and user confusion from multiple simultaneous backups

**Issue 3: Pre-Restore Data Loss Risk**
- **Problem:** `backup:restore` IPC handler silently overwrote live database without user confirmation, making accidental restore from stale backups a critical data-loss vector
- **Fix:** Added `dialog.showMessageBox()` confirmation dialog before restore attempt, with warning message and filename display; "Cancel" is default button (index 1) to prevent Enter-key accidents
- **Impact:** User must explicitly confirm they're about to lose all current data, preventing accidents

**Issue 4: Restore ↔ Watchdog Race Condition**
- **Problem:** Health watchdog polled `GET /health` continuously, even during restore operations. When database was stopped, dropped, and recreated, watchdog would see backend-offline, increment failure counter, and potentially emit spurious `backend:lost` events while restore was still in progress
- **Fix:** Call `stopHealthWatchdog()` before restore attempt, guarantee `startHealthWatchdog()` in `finally` block; watchdog remains paused until restore completes
- **Impact:** Prevents spurious recovery alerts mid-restore, eliminates race condition between restore cleanup and watchdog recovery logic

**Issue 5: Excessive Memory Buffering**
- **Problem:** `run()` helper (used for shell commands) defaulted to 200 MB `maxBuffer`, intended for capturing full command output in memory. However, `pg_dump` uses `spawn()` with stream piping (not buffered), so the default wasted 200 MB per backup
- **Fix:** Reduced default `maxBuffer` from 200 MB to 10 MB; sufficient for typical Docker CLI output, signals errors if commands exceed it
- **Impact:** Memory footprint on typical commands drops by 190 MB per operation

See [[docs/adr/049-phase-6-7-bug-hunt-recovery-hardening|ADR-049]] for detailed rationale, consequences, and testing guidance.

### Application Updates (April 2026)

Vision supports **three deployment modes**, each with a distinct update path. See [[docs/features/application-updates|Application Updates Feature]] for full architecture, IPC handlers, and frontend UI.

#### Deployment Modes

| Mode | Condition | Update Method | Artifacts |
|------|-----------|----------------|-----------|
| **dev** | `app.isPackaged === false && !useRepoMode` | File watcher → Docker rebuild | (automatic via file system) |
| **source** | `app.isPackaged === true && useRepoMode === 'true'` | Shell script installer from GitHub | `vision-x.y.z.zip` + `vision-x.y.z.zip.sha256` |
| **docker** | `app.isPackaged === true` (default) | `docker-compose pull` → restart | Docker image at `ghcr.io/erapartner/vision:<tag>` |

#### IPC Handlers

| Handler | Purpose | Modes |
|---------|---------|-------|
| `update:get-mode` | Return deployment mode (`'dev'` \| `'source'` \| `'docker'`) | All |
| `update:pre-update-backup` | Create timestamped snapshot in `userData/pre-update-backups/` | source, docker |
| `update:install-shell` | Download, verify SHA256, extract, install shell update | source only |
| `update:check-release` | Check GitHub for new release; return `{ available, version, update_mode }` | source, docker |

#### Shell Installer (Source Mode)

The shell installer script (`install.sh`) included in release ZIPs:
- **Rollback strategy:** BAK_DIR snapshot created before rsync, restored on failure
- **Quarantine removal:** `xattr -rd com.apple.quarantine` applied to entire DEST_ROOT and launcher scripts
- **Usage:** `./install.sh --dest-root /path/to/app --backup-dir /tmp/backup`

#### Checksum Verification (ADR-023)

When updating via shell installer:
1. Download sibling `.sha256` file from GitHub release
2. Compute SHA256 of downloaded ZIP
3. **Hard verification:** If `.sha256` exists but is malformed or mismatches, abort immediately
4. **Backward compat:** If `.sha256` absent, log warning and best-effort proceed
5. On mismatch: delete ZIP, throw error, abort update

See [[docs/adr/023-update-installer-checksum-verification|ADR-023]] for rationale.

#### Docker Pre-Pull Optimization (Phase 0)

During Electron startup, if Docker image is missing locally:
1. Pre-pull `ghcr.io/erapartner/vision:<tag>` in parallel with other init steps
2. If pre-pull succeeds, skip `--build` flag in `docker-compose up`
3. If pre-pull fails (network, GHCR unavailable), fallback to inline pull during compose up
4. Emit boot mark `pre_pull_image` to observability layer

This reduces first-boot latency in packaged Docker mode.

#### Backup-Before-Update Pattern

All updates (source and docker modes) follow this sequence:

```
1. User clicks "Update & Restart"
   ↓
2. Backup phase: IPC call preUpdateBackup()
   → Snapshot userData/ to userData/pre-update-backups/backup-{ISO8601}/
   → Encrypt snapshot (AEAD, Phase 1+2)
   ↓
3. Download phase: Fetch installer or pull image
   ↓
4. Verify phase (source only): Check SHA256
   ↓
5. Install phase: Extract/deploy to install directory or restart container
   ↓
6. Restart phase: App restarts with new version
   ↓
7. Health poll: Verify backend is live before rendering UI
   ↓
8. Done: Frontend reconnects to backend
```

On failure at any step: error toast shown, user can manually restore from `pre-update-backups/` directory.

#### Frontend UI

**UpdateNotification component:**
- Phases: idle → backing-up → downloading/pulling → restarting → done
- Mode-aware routing: Docker shows "Pulling Docker image…", source shows "Downloading installer…"
- Localized labels via i18n: `update.backingUp`, `update.downloadingUpdate`, `update.pullingImage`, etc.

**AppTab (Settings → App):**
- Shows current update mode
- Manual "Check for Updates" button
- Displays latest available version if newer

#### CI/CD Integration (April–May 2026)

**release.yml** (May 2026):
- `verify` job checks:
  - Named volumes in `docker-compose.yml` match `packaging/electron/resources/docker-compose.yml`
  - Version tag matches both package.json files
  - JS dependencies audit passes
  - Blocks all other jobs until checks pass

- `docker` job pushes image with version tag to GHCR
- `package-mac` job generates `.sha256` checksum alongside ZIP
- Both artifacts uploaded to GitHub release

**ci.yml** (May 2026):
- Early stage:
  - `secrets-scan`, `deps-audit`, `pip-audit`, `lint`, `typecheck`, `build-frontend`, `test-frontend`, `test-backend`
  - `verify-compose-sync` — compares named volumes between root and embedded compose files
  - `quality-gate` — aggregates all early checks, gates expensive Docker build

- Docker stage (after quality-gate passes):
  - `build-image` — builds Docker image once, reused by downstream jobs
  - `trivy-scan` — scans image for OS/system CVEs
  - `docker-verify` — container health check (build image, start compose, poll health on port 3002)
  - `test-live-api-contracts` — validates MSW fixtures against real backend responses
  - `ci-complete` — final aggregation gate (set as required status check in branch protection)

**Security focus:** Compose sync verification prevents the v1.0.2 data-loss bug where omitted volumes caused attachments to vanish on update.

Detailed workflow definitions in [[docs/features/application-updates|Application Updates Feature]] and [[docs/guides/cicd-pipelines|CI/CD Pipelines Guide]].

---

## Security Considerations

### Defense-in-Depth Isolation

Vision uses a three-layer isolation model:

```javascript
const mainWindow = new BrowserWindow({
  webPreferences: {
    sandbox: true,           // Layer 1: Renderer sandbox (OS-level)
    contextIsolation: true,  // Layer 2: Isolate preload from renderer context
    nodeIntegration: false,  // Layer 3: No Node.js in renderer
    preload: path.join(__dirname, 'preload.js'),
  }
});
```

**Each layer is independent:** Even if one is bypassed, the others remain effective.

### Context Isolation & Preload

```javascript
// preload.js - the only Node-accessible code
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronRecovery', {
  retry: () => ipcRenderer.invoke('recovery:retry'),
  openLogs: () => ipcRenderer.invoke('recovery:open-logs'),
  onBackendLost: (cb) => ipcRenderer.on('backend:lost', cb),
  onBackendRestored: (cb) => ipcRenderer.on('backend:restored', cb),
});
```

- Preload is the **only** way renderer can access Node.js or IPC
- All functions are validated and scoped
- Sandbox prevents renderer from directly calling Node APIs

### Error Page (Sandbox-Safe)

`packaging/electron/assets/error.html` is sandbox-compliant:
- Static HTML (no inline scripts)
- CSP: `default-src 'self'`
- Localized via query params
- Communicates with main only via `window.electronRecovery` bridge

### CSP Headers

The backend sets Content-Security-Policy headers appropriate for Electron:
- `img-src` includes `https:` for remote news thumbnails
- `script-src` restricts script sources
- `default-src` limits resource loading

---

## Development

### Running Electron

```bash
# Development mode
bun run electron:dev

# Production mode
bun run electron:prod
```

### Debugging

- **Main process:** `electron --inspect`
- **Renderer process:** Chrome DevTools (Cmd+Option+I)
- **Backend process:** Standard Node.js debugging

### Dev Rebuild File Watcher

In dev mode, a file watcher monitors source files and triggers automatic Docker rebuild+restart on code changes:

```javascript
// Watches frontend, backend, migrations directories
fs.watch(sourceDir, { recursive: true }, (eventType, filename) => {
  // Kill in-flight build with SIGTERM to signal cancellation
  if (activeBuildChild) {
    activeBuildChild.kill('SIGTERM');
  }
  // Queue new rebuild from updated sources
});
```

**Behavior:**
- File edit detected → signal SIGTERM to any in-flight build
- In-flight build catches SIGTERM, marks error as `.cancelled = true`, rejects promise
- Cancelled build swallows error (expected), does not log failure
- New build is immediately queued with the latest source state

**Rationale:** Eliminates stale builds when multiple edits occur in quick succession. Prevents cascading Docker builds while preserving the most recent change for execution.

---

## Error Recovery

### Error Page

If backend is unavailable at startup, `error.html` displays:

```
┌───────────────────────────────────────────────────┐
│  Backend Service Unavailable                      │
│  Vision's backend service is not responding.       │
│  Check logs or try restarting.                     │
│                                                   │
│  [Retry]      [Open Logs]                         │
└───────────────────────────────────────────────────┘
```

**Retry** → Re-runs health poll from current state
**Open Logs** → Opens app logs directory

### Runtime Watchdog

After startup succeeds, a watchdog monitors backend health:
- Polls `/health` every 10 seconds
- 3 consecutive failures → `backend:lost` IPC event
- Renderer can show user-facing error banner
- Recovery → `backend:restored` event

### Corrupt Settings Recovery

If `settings.json` is unparsable:
- App quarantines corrupted file as `settings.json.corrupt-<timestamp>`
- Returns application defaults
- User can manually fix or let defaults reset settings

---

## Health Monitoring

### Poll Functions

Two poll functions cover distinct use cases:

| Function | Endpoint | Purpose |
|----------|----------|---------|
| `pollReady(maxAttempts)` | `GET /health/detailed` | Gates the **initial page navigation** on materialized-view warmup. Navigate when `status === 'ready'` OR `caches.materializedViews === true`. 404/unparseable responses fall back to ready. Boot mark: `poll_ready`. |
| `pollHealth(maxAttempts)` | `GET /health` | Used by watchdog, restart, update, and dev-rebuild flows. Only tests that Express is listening. |

### Startup Readiness Poll

**Env vars:**
- `VISION_HEALTH_POLL_ATTEMPTS` (default: 200) — warm-boot budget; triggers the slow-start modal on expiry
- `VISION_HEALTH_POLL_BUILD_ATTEMPTS` (default: 600) — cold/build-launch budget; ≈3 min, no modal on expiry
- `VISION_HEALTH_POLL_INTERVAL_MS` (default: 300) — poll cadence in ms

**Examples:**
- Warm boot: 200 attempts × 300ms ≈ 56-second timeout (modal fires)
- Cold/build launch: 600 attempts × 300ms ≈ 3-minute timeout (no modal; falls to error page)

### Endpoints

- `GET /health` — Shallow liveness check: returns 200 as soon as Express is listening. Used by the runtime watchdog and restart/update flows.
- `GET /health/detailed` — Warmup readiness: returns `status: 'warming' | 'ready'` plus per-cache boolean flags (including `materializedViews`). Used by `pollReady()` for initial navigation.

See [[docs/api/health|Health API]] for full field semantics and the `caches.materializedViews` gate.

---

## Packaging Troubleshooting

### Fresh Database Installation Fails on Migration 0003

**Symptom:** Packaged app boots, launches Docker container, but migration fails with FK constraint violation or string truncation error on revision `0003_import_batch_id_on_transactions`.

**Root cause:** Two pre-ADR-027 squash oversights:
1. Baseline migration 0001 was missing `import_batches` and `import_staging_rows` tables; migration 0003 tried to FK to non-existent tables.
2. If DB is truly fresh (no `alembic_version` table), alembic auto-creates it at `VARCHAR(32)`, but revision name `0003_import_batch_id_on_transactions` (38 chars) causes string truncation.

**Fix:** Implemented in 2026-04-27 release:
1. Ported import staging tables from legacy 0030 into 0001 baseline.
2. Preflight-created `alembic_version` table at `VARCHAR(64)` before alembic runs.

See [[docs/adr/027-alembic-single-source-of-schema#follow-up-migration-ordering-bugs-fixed-2026-04-27|ADR-027 follow-up: Migration Ordering Bugs Fixed]].

**Verification:** Fresh packaged app with clean Docker volume should boot to head at migration `0015_recipient_match_patterns` with no FK or truncation errors.

### Cannot find module './backup/bundle'

**Cause:** `backup/` directory not in electron-builder `files` array.

**Fix:** Ensure `packaging/electron/package.json` build config includes:
```json
{
  "build": {
    "files": ["main.js", "preload.js", "backup/**/*", "assets/**/*"]
  }
}
```

**Verification:** After build, inspect asar contents:
```bash
npm ls @electron/asar  # Confirm npm package installed
file dist/mac-arm64/Vision.app/Contents/Resources/app.asar
```

### Cannot find module 'archiver-utils' (or compress-commons, readable-stream, zip-stream)

**Cause:** Hoisting left Archiver's transitives as nested-only, electron-builder couldn't bundle them. See [[#package-manager-npm-vs-bun|Package Manager (npm vs. bun)]] above.

**Fix:**
1. Ensure `package-lock.json` exists (npm, not bun.lock)
2. Explicitly declare transitives in `packaging/electron/package.json`:
   ```json
   {
     "dependencies": {
       "archiver": "^7.1.2",
       "archiver-utils": "^5.0.2",
       "compress-commons": "^6.0.2",
       "readable-stream": "^4.5.2",
       "zip-stream": "^6.0.1"
     }
   }
   ```
3. Rebuild: `npm install && npm run dist`

### ENOENT docker-compose.yml at Contents/Resources/resources/

**Cause:** Embedded `resources/docker-compose.yml` not copied to app bundle via `extraResources`.

**Fix:** Ensure `packaging/electron/package.json` includes:
```json
{
  "build": {
    "extraResources": [
      { "from": "i18n", "to": "i18n" },
      { "from": "resources", "to": "resources" }
    ]
  }
}
```

**Verification:** After build, check asar not corrupted:
```bash
ls -la dist/mac-arm64/Vision.app/Contents/Resources/resources/docker-compose.yml
```

### registry unauthorized on first launch

**Cause:** Packaged app attempted to pull Docker image from private GHCR registry without credentials.

**Solution (2026-04-27):** Electron orchestrator (`packaging/electron/main.js`) now pre-pulls the image during `parallel_init()` if missing locally:

```javascript
// Inside Promise.all() during main process startup:
// Pulls ghcr.io/erapartner/vision:<tag> only if image missing
// Non-fatal; falls back to inline pull during compose up
await preLoadDockerImage();
```

**Additional safeguard:** Embedded `resources/docker-compose.yml` also uses `pull_policy: missing` to avoid re-pulling on subsequent launches:

```yaml
services:
  app:
    image: ghcr.io/erapartner/vision:latest
    pull_policy: missing  # Use local image if available; skip registry pull
```

**Manual pre-pull (if needed):**
1. Build locally: `docker compose build` (creates `vision-app:latest`)
2. Retag: `docker tag vision-app:latest ghcr.io/erapartner/vision:latest`
3. Rebuild packaged app: `npm run dist`

With automatic pre-pull + `pull_policy: missing`, Docker Compose finds the locally-tagged image without attempting registry auth on first launch or subsequent boots.

## Related

- [[docs/adr/045-electron-app-name-userData-migration|ADR-045: App Name & userData Migration]] — macOS TCC prompt fix + legacy dir migration
- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022: Electron Sandbox Hardening]] — Security + recovery design
- [[docs/adr/023-update-installer-checksum-verification|ADR-023: Installer Checksum Verification]] — Supply-chain security
- [[docs/api/health|Health API]] — Backend readiness endpoints
- [[docs/guides/deployment]] — Deployment guide
- [[docs/reference/scripts]] — Build scripts
- [[docs/security/index]] — Security documentation
