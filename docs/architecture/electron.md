---
title: Electron Desktop Architecture
type: architecture-doc
status: active
date: 2026-04-27
updated: 2026-04-27
tags: [architecture, electron, desktop, packaging, security, sandbox, health-monitoring, async-io, csp-headers, dev-rebuild, phase-0, phase-1, phase-2, backup, restore, bundle, ipc, encryption, schema-migration, npm-vs-bun, docker-compose, pre-pull, startup, troubleshooting, alembic-migration-fixes]
description: Electron desktop application architecture, IPC communication, sandbox hardening, health monitoring, Docker image pre-pull optimization, and backup/restore bundle system (Phase 1+2)
aliases: [electron, desktop app, packaging, IPC, main process, sandbox, watchdog, backup, bundle]
related_code: ["packaging/electron/", "packaging/electron/backup/bundle.js", "apps/frontend/src/lib/api/electron.ts", "apps/frontend/src/components/settings/tabs/BackupTab.tsx", "apps/node-backend/src/main.js", "alembic/versions/0001_initial_database_schema.py"]
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

7. **Health Poll** — `pollHealth()` loops:
   - Polls `GET /health` every 300ms (`VISION_HEALTH_POLL_INTERVAL_MS`)
   - Max 200 attempts (`VISION_HEALTH_POLL_ATTEMPTS`)
   - On success: proceed to step 8
   - On timeout (~60s): load error page, enable Retry/OpenLogs buttons

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

**Bundle Format:**

See [[docs/features/backup-coverage-audit|Backup Coverage Audit]] for `.visionbak` structure, encryption details, and restore process.

### Auto-Update

Electron can check for and apply updates:

| Endpoint | Description |
|----------|-------------|
| `GET /api/admin/update/check` | Check for available updates |
| `POST /api/admin/update/apply` | Acknowledge update |
| `POST /api/admin/update/apply-and-restart` | Apply and restart app |

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

### Startup Health Poll

**Env vars:**
- `VISION_HEALTH_POLL_ATTEMPTS` (default: 200)
- `VISION_HEALTH_POLL_INTERVAL_MS` (default: 300)

**Example:** 200 attempts × 300ms = 60-second startup timeout

### Endpoints

- `GET /health` — Simple liveness check (empty body OK)
- `GET /health/detailed` — Includes warmup status (caches loading?)

See [[docs/api/health|Health API]] for details.

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

- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022: Electron Sandbox Hardening]] — Security + recovery design
- [[docs/adr/023-update-installer-checksum-verification|ADR-023: Installer Checksum Verification]] — Supply-chain security
- [[docs/api/health|Health API]] — Backend readiness endpoints
- [[docs/guides/deployment]] — Deployment guide
- [[docs/reference/scripts]] — Build scripts
- [[docs/security/index]] — Security documentation
