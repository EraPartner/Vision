---
title: Electron Desktop Architecture
type: architecture-doc
status: active
date: 2026-04-27
tags: [architecture, electron, desktop, packaging, security, sandbox, health-monitoring, async-io, csp-headers, dev-rebuild, phase-0, phase-1, phase-2, backup, restore, bundle, ipc, encryption, schema-migration]
description: Electron desktop application architecture, IPC communication, sandbox hardening, health monitoring, and backup/restore bundle system (Phase 1+2)
aliases: [electron, desktop app, packaging, IPC, main process, sandbox, watchdog, backup, bundle]
related_code: ["packaging/electron/", "packaging/electron/backup/bundle.js", "apps/frontend/src/lib/api/electron.ts", "apps/frontend/src/components/settings/tabs/BackupTab.tsx", "apps/node-backend/src/main.js"]
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
4. **Backend server** is spawned as a child process
   - Settings, env, and work directory resolved via async functions
5. **Health Poll** — `pollHealth()` loops:
   - Polls `GET /health` every 300ms (`VISION_HEALTH_POLL_INTERVAL_MS`)
   - Max 200 attempts (`VISION_HEALTH_POLL_ATTEMPTS`)
   - On success: proceed to step 4
   - On timeout (~60s): load error page, enable Retry/OpenLogs buttons
4. **Create BrowserWindow** with sandbox enabled + loading frontend
5. **Watchdog Loop** starts (10s interval):
   - Polls `GET /health` continuously
   - 3 consecutive failures → emit `backend:lost` IPC event to renderer
   - Recovery → emit `backend:restored` event
6. **Frontend** connects to backend at `http://localhost:3002`
7. **Renderer** subscribes to `backend:lost` and `backend:restored` events via `window.electronRecovery.onBackendLost/onBackendRestored()`

---

## Packaging

### Platforms

- **macOS** — `.dmg` / `.app`
- **Windows** — `.exe` / `.msi`
- **Linux** — `.AppImage` / `.deb`

### Bundled Components

- React frontend (built with Vite)
- Node.js backend (bundled with dependencies)
- PostgreSQL (external — not bundled)

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

## Related

- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022: Electron Sandbox Hardening]] — Security + recovery design
- [[docs/adr/023-update-installer-checksum-verification|ADR-023: Installer Checksum Verification]] — Supply-chain security
- [[docs/api/health|Health API]] — Backend readiness endpoints
- [[docs/guides/deployment]] — Deployment guide
- [[docs/reference/scripts]] — Build scripts
- [[docs/security/index]] — Security documentation
