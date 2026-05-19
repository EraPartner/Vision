---
title: ADR-022 Electron Sandbox Hardening and Recovery
type: adr
status: Accepted
date: 2026-04-19
tags: [adr, electron, security, sandbox, defense-in-depth, error-recovery, phase-9]
description: Enable renderer sandbox + single-instance lock, add health-polling and backend-loss watchdog, recover via error page with recovery IPC surface
aliases: [adr-022, electron sandbox, renderer sandbox, single-instance lock, backend watchdog]
---

# ADR-022: Electron Sandbox Hardening and Recovery

## Status
Accepted

## Date
2026-04-19

## Context

Vision's Electron application shipped with renderer process `nodeIntegration: false` and `contextIsolation: true`, making Node APIs inaccessible in the renderer. However, the **renderer sandbox** (`sandbox: true`) was **not enabled**, meaning the renderer process still had access to:

- Reading/writing arbitrary files (relative to the app)
- Opening subprocesses
- Network access without CSP constraints
- Other OS-level APIs through Chromium

While the preload script (using `contextBridge` + `ipcRenderer.invoke`) was the only bridge to Node, a **preload sandbox escape** (even a hypothetical one) would grant full renderer⟶Node access.

A critical security audit flagged this gap: **renderer sandbox off** = single-layer defense, not defense-in-depth.

Additionally, the Electron app relied on the backend being alive at startup but had no way to **monitor or recover** if the backend crashed after startup (e.g., Docker OOM kill, uncaught exception). Users experienced hung windows, no recovery path, and no visibility into what went wrong.

## Decision

### 1. Enable Renderer Sandbox

Add `webPreferences.sandbox: true` to the main window:

```js
const mainWindow = new BrowserWindow({
  webPreferences: {
    sandbox: true,                // NEW: Sandbox enabled
    nodeIntegration: false,       // Existing
    contextIsolation: true,       // Existing
    preload: path.join(__dirname, 'preload.js'),
    // …other options
  }
});
```

**Consequence:** Renderer no longer has access to file system, subprocesses, or OS APIs—only what `contextBridge` explicitly exposes via the preload.

### 2. Backend Health Polling & Watchdog

#### Startup Health Poll

Before displaying the window, `pollHealth()` (already present) now:
- Polls `GET /health` every 300ms (`HEALTH_POLL_INTERVAL_MS`)
- Max 200 attempts (~60s; configurable via `VISION_HEALTH_POLL_ATTEMPTS`)
- On success: proceed to app load
- On timeout: show error page

**Env vars (new):**
- `VISION_HEALTH_POLL_ATTEMPTS` (default: 200)
- `VISION_HEALTH_POLL_INTERVAL_MS` (default: 300)

#### Watchdog Loop

After successful startup, a 10-second-interval watchdog polls `GET /health`:
- Tracks consecutive failures (threshold: 3)
- 3+ failures → emit `backend:lost` IPC event
- Recovery: `backend:restored` event on next success

Renderer subscribes via `window.electronRecovery.onBackendLost()` and `onBackendRestored()`.

### 3. Error Page & Recovery IPC

New `packaging/electron/assets/error.html`:
- Sandbox-safe static HTML (no inline script, CSP: `default-src 'self'`)
- Localized via query params (e.g., `?title=...&message=...&retry=...`)
- Two buttons: **Retry** (triggers `recovery:retry` IPC) and **Open Logs** (triggers `recovery:open-logs` IPC)
- Wired via new `electronRecovery` context bridge:

```js
contextBridge.exposeInMainWorld('electronRecovery', {
  retry: () => ipcRenderer.invoke('recovery:retry'),
  openLogs: () => ipcRenderer.invoke('recovery:open-logs'),
  onBackendLost: (cb) => ipcRenderer.on('backend:lost', cb),
  onBackendRestored: (cb) => ipcRenderer.on('backend:restored', cb),
});
```

**Main process IPC handlers:**
- `recovery:retry` → calls `pollAndLoad()` again
- `recovery:open-logs` → `shell.openPath(app.getPath('logs'))`

### 4. Single-Instance Lock

Add at app startup (before any window creation):

```js
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) mainWindow.focus();
  });
}
```

**Benefit:** Prevents multiple app instances competing for the same Node backend (especially relevant in Docker Compose where the backend is shared). Second-instance attempt focuses the existing window.

### 5. Corrupt Settings Recovery

`loadSettings()` now quarantines unparsable `settings.json`:

```js
function loadSettings() {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (e) {
    return getDefaultSettings();
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    // Quarantine corrupt file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(settingsPath, `${settingsPath}.corrupt-${timestamp}`);
    return getDefaultSettings();
  }
}
```

User recovers with defaults; file is preserved for forensics.

### 6. New i18n Keys

Backend (`packaging/electron/i18n/en.json` + `nl.json`):

```json
{
  "app.errorPageTitle": "Backend Service Unavailable",
  "app.errorPageMessage": "Vision's backend service is not responding. Check logs or try restarting.",
  "app.errorPageRetry": "Retry",
  "app.errorPageOpenLogs": "Open Logs",
  "app.backendLost": "Backend service lost. Click retry or check logs."
}
```

## Consequences

### Positive

- **Defense-in-depth:** Renderer sandbox + contextIsolation + nodeIntegration=false = three layers of isolation
- **Attack surface reduction:** Preload is now the only Node-accessible code; sandbox makes it the mandatory gateway
- **Visibility into failures:** Watchdog + error page gives users actionable feedback instead of a hung window
- **Data recovery:** Corrupt settings quarantine prevents cascading startup failures
- **Multiinstance safety:** Single-instance lock prevents port conflicts and backend contention in Docker Compose
- **Audit compliance:** Passes renderer-sandbox security requirement

### Neutral

- **Sandbox edge cases:** In rare cases, sandboxed renderer may have platform-specific limitations (mitigated by comprehensive preload API). Tested on macOS, Windows, Linux.
- **Recovery IPC surface:** New `electronRecovery` API adds slight complexity to main/renderer communication; follows established `contextBridge` patterns.
- **Env var proliferation:** Two new env vars; documented in `docs/reference/environment-variables.md`

### Negative

- **None anticipated.** Sandbox is a feature flag in Electron; preload is already the sole bridge, so enabling it closes the loop but does not break existing usage.

## Implementation

### Code Changes

1. **`packaging/electron/main.js`:**
   - Add `sandbox: true` to `webPreferences`
   - `requestSingleInstanceLock()` at app startup
   - `app.on('second-instance', ...)` handler
   - Expand `pollHealth()` to track watchdog state
   - Add 10s watchdog timer after successful poll
   - `recovery:retry` and `recovery:open-logs` IPC handlers
   - Enhance `loadSettings()` to quarantine corrupt files

2. **`packaging/electron/preload.js`:**
   - Expose `electronRecovery` object via `contextBridge`:
     - `retry()`, `openLogs()` methods
     - `onBackendLost(cb)`, `onBackendRestored(cb)` event listeners

3. **`packaging/electron/assets/error.html`:**
   - Sandbox-safe HTML with CSP header
   - Localized strings via query params
   - Retry and Open Logs buttons
   - Minimal inline CSS (no style-src 'unsafe-inline')

4. **`packaging/electron/i18n/en.json` + `nl.json`:**
   - Add four new keys (title, message, retry, logs, backendLost)

5. **`docs/reference/environment-variables.md`:**
   - Add `VISION_HEALTH_POLL_ATTEMPTS`, `VISION_HEALTH_POLL_INTERVAL_MS`

### Testing

```bash
# Disable backend, verify error page displays
# kill -9 <backend-pid> while app is running
# Watchdog detects loss, emits backend:lost
# Restart backend, watchdog emits backend:restored

# Launch two instances in rapid succession
# Second instance should quit immediately, first focuses

# Corrupt settings.json, launch app
# App should start with defaults, quarantine file
```

## Related

- [[docs/adr/019-framer-motion-adoption|ADR-019: Framer Motion Adoption]] — Recovery page uses animation library
- [[docs/features/settings|Settings Feature]] — Settings recovery flows
- [[docs/security/data-protection|Data Protection Policy]] — Sandbox isolates renderer from file system
- [[docs/architecture/electron|Electron Desktop App Architecture]] — Full Electron architecture
