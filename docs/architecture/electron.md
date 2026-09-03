---
title: Electron Desktop Architecture
type: architecture-doc
status: active
date: 2026-08-31
updated: 2026-09-03
tags:
  [
    architecture,
    electron,
    desktop,
    packaging,
    security,
    sandbox,
    health-monitoring,
    async-io,
    csp-headers,
    dev-rebuild,
    phase-0,
    phase-1,
    phase-2,
    phase-6,
    phase-7,
    backup,
    restore,
    bundle,
    ipc,
    encryption,
    schema-migration,
    bun,
    native-runtime,
    postgresql-18,
    docker-compose,
    pre-pull,
    startup,
    troubleshooting,
    alembic-migration-fixes,
    deployment-modes,
    shell-installer,
    docker-pull,
    update-system,
    checksum-verification,
    backup-before-update,
    cicd,
    april-2026,
    bug-hunt,
    recovery-hardening,
    concurrent-backup-guard,
    timeout,
    watchdog-pause,
    electron-native,
    macos,
    hiddeninset,
    vibrancy,
    system-accent,
    native-menu,
    dock-badge,
    csv-open-with,
    electronapi,
    renderer-ready-queue,
    compose-stop,
    window-bounds,
    splash-localized,
    shutdown-idle-connections,
    accelerator-hardening,
    before-input-event,
    did-start-navigation,
    june-2026,
  ]
description: >-
  Electron desktop application architecture, IPC communication, sandbox hardening, health monitoring,
  native PostgreSQL 18 and Bun runtime provider, optional Docker Compose provider, backup/restore
  bundle system (Phase 1+2), four-mode application update system with checksum verification, Phase 7 backup/restore hardening with
  concurrent-backup guard, HTTP timeout, and watchdog pause (May 2026), and June 2026 V12 native macOS
  integration (ADR-072) — hiddenInset chrome, native menu/dock, CSV open-with handoff, system accent
  overlay, under-window vibrancy. June 2026 (startup fixes): quit uses compose stop (preserves warm-boot
  fast path), window bounds persisted/restored, localized theme-aware splash with phase narration,
  graceful shutdown closes idle keep-alive sockets, dev watcher covers packages/ and i18n/source. June
  2026 (accelerator fixes): renderer-ready reset moved from did-start-loading to
  did-start-navigation+isSameDocument guard (eliminates sendToApp queue jam on React Router navigations);
  handleMenuAccelerator on before-input-event bypasses unreliable sandboxed-renderer→native-menu
  key-equivalent redispatch.
aliases:
  [
    electron,
    desktop app,
    packaging,
    IPC,
    main process,
    sandbox,
    watchdog,
    backup,
    bundle,
    update system,
    deployment modes,
    electronAPI,
    native menu,
    dock badge,
    system accent,
    vibrancy,
  ]
related_code:
  [
    "packaging/electron/",
    "packaging/electron/backup/bundle.js",
    "packaging/electron/backup/native-transport.js",
    "packaging/electron/main.js",
    "packaging/electron/preload.js",
    "packaging/electron/runtime/index.js",
    "packaging/electron/runtime/native.js",
    "packaging/electron/runtime/docker.js",
    "packaging/electron/runtime/importer.js",
    "apps/frontend/src/lib/api/electron.ts",
    "apps/frontend/src/components/layout/ElectronBridge.tsx",
    "apps/frontend/src/lib/importHandoff.ts",
    "apps/frontend/src/lib/accentColor.ts",
    "apps/frontend/src/components/notifications/UpdateNotification.tsx",
    "apps/frontend/src/features/settings/sections/AboutSection.tsx",
    "apps/node-backend/src/main.js",
    "alembic/versions/0001_initial_database_schema.py",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ]
---

# Electron Desktop Architecture

## Overview

Vision runs as an Electron desktop application, bundling the React frontend, compiled Bun backend,
PostgreSQL 18.6, migration executable, and Chrome Headless Shell into one distributable package.
Electron manages a private PostgreSQL cluster in the durable Vision application-data directory.
Docker Compose remains an explicit runtime provider and is not required for normal development or
the packaged app.

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

### Runtime Providers (ADR-113 and ADR-114)

Electron resolves one provider before it performs lifecycle or backup actions:

| Provider | Backend             | PostgreSQL                                | Use                                                        |
| -------- | ------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `native` | Bun child process   | Bundled 18.6 server, private data cluster | Default macOS development, packaged app, and isolated Demo |
| `docker` | Compose app service | Compose PostgreSQL 18 service             | Explicit container deployment                              |

The provider owns start, stop, restart, health, readiness, logs, database dump/restore, and
attachment paths. Backup bundle and application business logic remain shared. A durable marker at
`native/vision/runtime-state.json` prevents alternating writers. Existing Docker-era installs fail
closed until the opt-in importer validates database counts, schema, and attachment hashes and
activates the native marker. Vision Demo always uses a separate `vision_demo` native runtime and
deterministic seed; it ignores stale Docker selection. See
[[docs/adr/113-native-macos-runtime|ADR-113]],
[[docs/adr/114-native-deterministic-demo-runtime|ADR-114]], and
[[docs/guides/native-macos-runtime|Native macOS Runtime Guide]].

---

## Configuration

### Location

Electron configuration is in `packaging/electron/`.

### Key Settings

| Setting            | Value | Description                             |
| ------------------ | ----- | --------------------------------------- |
| `contextIsolation` | true  | Security: isolate preload from renderer |
| `nodeIntegration`  | false | Security: no Node.js in renderer        |
| `sandbox`          | true  | Security: sandboxed renderer            |

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

4. **Runtime selection** — Validate the explicit environment override, saved setting, and durable
   runtime marker. When a marker exists it is authoritative, so an old setting or environment
   variable cannot alternate databases after cutover. Without a marker, the explicit environment
   or saved setting applies. Normal Vision defaults to `native`. The seeded Demo always selects
   its isolated native runtime so stale settings cannot create two Demo writers.

5. **Native initialization** — Before any Docker code is loaded:
   - choose and persist an available loopback backend port;
   - verify the packaged PostgreSQL 18.6, compiled backend, migration executable, Chrome Headless
     Shell, and full checksum manifest;
   - create restricted runtime directories and initialize or reuse the private PostgreSQL cluster;
   - require PostgreSQL `listen_addresses` to be loopback-only, disable Unix sockets, and verify its
     exact data directory;
   - create separate cluster-administrator, owner/migration, and application roles. The owner role
     owns schema tables and performs migrations and database-wide maintenance; the application role
     owns only the runtime-managed materialized views in addition to its data privileges. The
     privileged bootstrap reapplies current table and view grants relation by relation, skipping
     those application-owned views so their ownership cannot invalidate the ordinary-table grant
     set;
   - create the database from `template0`, enable required extensions, and run the repository
     migration path (`db-migrate.js` in a source checkout; its underlying `runMigrations()`
     preflight from the packaged backend); and
   - spawn the backend with an allowlisted child environment and argument arrays.
   - launch managed PostgreSQL initialization and the server with an explicit portable `C` locale,
     independent of locale values inherited from the macOS application launcher.

   A missing, wrong-version, wrong-architecture, or corrupt packaged component is a hard native
   preflight failure. A PostgreSQL port collision also fails closed rather than selecting the
   unknown listener.
   Existing Docker imports preserve only supported research provider keys and
   `ADMIN_AUTH_TOKEN`; database credentials and unrelated host secrets are never copied.

   Native migration children set `VISION_SKIP_CONFIG_ENV_LOCAL=true`, so a source checkout's
   Docker-oriented `config/.env.local` cannot override the generated native database URLs.

   An existing Docker-era environment without a completed native marker raises
   `NATIVE_CUTOVER_REQUIRED`; Electron exits without creating or selecting an empty native database.

   For Vision Demo, the native branch verifies the packaged seed checksum and custom-format dump,
   restores a fresh staging database when the seed changes or reset is requested, compares the
   schema and all table counts, then starts the backend. It finalizes the atomic database switch
   only after detailed readiness and stable user-data counts. The post-start `user_settings`
   comparison excludes only the runtime-owned `transfers_backfilled` and
   `fx_full_history_repair_done` maintenance markers; ordinary settings remain protected. Failure
   restores the previous Demo database before startup exits.

   The explicit Docker provider retains its parallel Docker health, port, image, and build checks
   before Compose starts the application service.

### Backend Startup

6. **Backend startup** (`apps/node-backend/src/main.js`, either native Bun or the optional
   `docker-entrypoint.sh` provider):
   - **Database connection** — `checkConnection()` polls with exponential backoff (40 attempts, 50ms→1s)
   - **Alembic migrations** — JS runner checks DB version + migrations fingerprint; skips if at
     head. The version-table preflight uses the owner connection in split-role mode, while the
     application pool remains least-privilege.
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

8. **Create BrowserWindow and verify the renderer handoff**:
   - await the initial frontend navigation before treating it as loaded;
   - require the existing `app:renderer-ready` signal after React mounts;
   - if that signal does not arrive within `VISION_RENDERER_READY_TIMEOUT_MS` (default 12 seconds),
     reload the document once while bypassing Chromium's cache; and
   - if the retry also fails, replace the indefinite boot splash with the localized recovery page.
     The preload bridge records only structural failure metadata such as the failure kind, error
     name, asset basename, and line number. It never records a full URL, error message, credentials,
     application data, or localStorage contents.

9. **Watchdog Loop** starts (10s interval):
   - Polls `GET /health` continuously
   - 3 consecutive failures → emit `backend:lost` IPC event to renderer
   - Recovery → emit `backend:restored` event

10. **Frontend** connects to backend at `http://localhost:3002`

11. **Preload bridge** exposes `backend:lost` and `backend:restored` callbacks via `window.electronRecovery.onBackendLost/onBackendRestored()`. The current React renderer does not subscribe, so these runtime events are an available bridge contract rather than a visible banner today.

---

## Packaging

### macOS Distribution

Vision packages into native macOS formats via `electron-builder`:

#### Output Artifacts

| Format        | Purpose                        | Location                          |
| ------------- | ------------------------------ | --------------------------------- |
| `.app` bundle | Native macOS application       | `dist/mac-arm64/Vision.app`       |
| `.dmg`        | Drag-to-install disk image     | `dist/Vision-1.0.0-arm64.dmg`     |
| `.zip`        | Compressed bundle for archival | `dist/Vision-1.0.0-arm64-mac.zip` |

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
    "files": [
      "main.js",
      "badge-image.js",
      "compose.js",
      "runtime/**/*",
      "updater.js",
      "preload.js",
      "backup/**/*",
      "assets/**/*"
    ],
    "extraResources": [
      { "from": "i18n", "to": "i18n" },
      { "from": "resources", "to": "resources" },
      { "from": "native-runtime", "to": "native-runtime" }
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

- **`files`** — Packed inside `app.asar`. Must include `runtime/**/*`, `backup/**/*`, and
  `assets/**/*`. Missing runtime or backup modules makes startup fail before data access.

- **`extraResources`** — Kept outside asar at `Contents/Resources/`. They include `i18n/`, optional
  Docker `resources/`, and the executable `native-runtime/` payload.

- **`native-runtime/`** — Also kept outside asar. It contains the compiled Bun backend,
  production frontend, migrations, migration runner, configuration, and checksum manifest used by
  the default native provider.

- **`demo-seed/`** — Vision Demo only. Contains a PostgreSQL custom-format dump and checksum/count
  manifest produced from a migrated disposable database. The data-only SQL generator remains a
  build input and is not shipped as the active database.

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

#### Package Manager (Bun)

`packaging/electron/` is a separate Bun package with its own committed `bun.lock`. It is not a root workspace, so install it explicitly:

```bash
bun install --frozen-lockfile --cwd packaging/electron
```

A normal local install runs `packaging/electron/package.json`'s narrow `postinstall` command, `install-electron`, so the pinned Electron binary exists before any `electron:*` wrapper launches it. CI backend verification and release verification add `--ignore-scripts`; the macOS package job uses the equivalent command from inside `packaging/electron/` and electron-builder fetches its build runtime independently. All three paths therefore resolve the dependency tree from the same lockfile without broadening lifecycle-script execution on release runners. `npm run dist` remains a script invocation in local examples; it does not make npm the dependency resolver.

The package declares its runtime dependencies directly (`archiver` and `yauzl`), and `bun.lock` pins their complete transitive graph. Do not reintroduce a second package lock for this directory.

### Platforms (Future)

- **Windows** — `.exe` / `.msi` (not yet implemented)
- **Linux** — `.AppImage` / `.deb` (not yet implemented)

### Bundled Components

- React frontend (built with Vite)
- Compiled Bun backend, spawned as a verified child process
- PostgreSQL 18.6 server and version-matched client tools
- Alembic migrations, migration configuration, guarded JS migration runner, and standalone
  migration executable
- Chrome Headless Shell pinned to the Electron workspace's Puppeteer version
- Native runtime provider and checksum manifest
- Vision Demo's deterministic seed dump and validation manifest in Demo packages
- Optional Docker provider and Compose resources for explicit container deployments

---

## Native Features

### Native Desktop Integration (V12, June 2026 — ADR-072)

> [!info] Added in ADR-072
> This section documents the `window.electronAPI` contextBridge surface, native menu bar / dock, window chrome, CSV import handoff, and system accent color. See [[docs/adr/072-electron-native-desktop-integration|ADR-072]] for the full decision record. All five bridge surfaces (`electronUpdater`, `electronBackup`, `electronServices`, `electronAPI`, and `electronRecovery`) share their TypeScript contract through `@vision/types/electron`.

#### `window.electronAPI` contextBridge Surface (preload.js)

The new surface sits alongside the existing `window.electronUpdater` and `window.electronBackup`. All subscriptions return an unsubscribe function for clean teardown.

| Method                     | Description                                                              |
| -------------------------- | ------------------------------------------------------------------------ |
| `platform`                 | `'darwin'` or other platform string                                      |
| `ready()`                  | Invoke `app:renderer-ready` — drains the pending send queue              |
| `setDockBadge(count)`      | Push integer badge count (0 clears); clamped 0–999 in main               |
| `setLanguage(language)`    | Persist `en`/`nl`, reload the shell dictionary, and rebuild native menus |
| `getAccentColor()`         | Return current macOS system accent color as RRGGBBAA hex                 |
| `onAccentColorChanged(cb)` | Subscribe to `AppleColorPreferencesChangedNotification` pushes           |
| `onMenuAction(cb)`         | Subscribe to `menu:action` — receives `{action, payload}` objects        |
| `onCsvOpen(cb)`            | Subscribe to `app:csv-opened` — receives `{name, content}` (no path)     |
| `onFullScreenChange(cb)`   | Subscribe to `window:fullscreen` with a boolean fullscreen state         |

Frontend helpers in `lib/api/electron.ts`: `getElectronAPI()`, `isElectronMac()`, `setDockBadge()`, `setNativeLanguage()`, `getSystemAccentColor()`. The optional language bridge preserves compatibility when a newer renderer is served by an older shell. `packaging/electron/electron-api.d.ts` owns bridge, invoke-channel, event-channel, argument, and result types; `@vision/types/electron` is a thin re-export consumed by the renderer, while preload JSDoc imports the canonical source directly. `ipc-contract.test.js` checks the 24 main handlers, 24 preload invokes, and 6 renderer events against it.

**IPC hygiene**: every `ipcMain.handle` that renderer can invoke validates `event.sender === mainWindow.webContents`. `app:set-badge` clamps the count to an integer 0–999. Backup handlers accept renderer-supplied paths only for guarded, local filesystem operations; OS-opened CSV paths stay in main and only `{name, content}` crosses into the renderer.

#### Renderer-Ready Queue Protocol

`sendToApp(channel, payload)` in main queues messages until the renderer has mounted its listeners. The queue drains the moment the renderer calls `electronAPI.ready()` (via `ipcMain.handle('app:renderer-ready')`). The `rendererReady` flag resets on window close and on **real document navigations/reloads** — detected via the `did-start-navigation` event filtered to `details.isMainFrame && !details.isSameDocument`.

This prevents lost IPC messages when the OS fires an `open-file` event (Finder "Open With" or dock drop) before the React app has mounted.

The same signal also closes the startup handoff. A bounded watchdog reloads once with Chromium's
cache bypassed if the document loads but React never reports ready. A second timeout opens the
recovery page with `app.rendererErrorPageMessage`. `did-fail-load`, `render-process-gone`, early
script or stylesheet load failures, runtime errors, and unhandled promise rejections write only
privacy-safe structural fields to `logs/main.log`. This makes an otherwise silent infinite splash
diagnosable without exposing application state.

> [!warning] `did-start-loading` must NOT be used here (fixed 2026-06-11)
> `did-start-loading` fires for same-document navigations (React Router `pushState` calls) as well as real page loads. The renderer only calls `app:renderer-ready` once per document, so resetting `rendererReady` on a same-document navigation permanently jams `pendingAppMessages` — every subsequent menu bar action, dock menu click, and CSV open-file handoff silently queues forever and never reaches the renderer. The fix is `did-start-navigation` with the `isSameDocument` guard, which only resets on actual document loads and reloads.

#### Accelerator Dispatch Hardening (2026-06-11)

The accelerators declared in `setupApplicationMenu()` (⌘1–⌘9, ⌘N, ⇧⌘I, ⌃⌘S) are also matched by a `handleMenuAccelerator(event, input)` function attached to `mainWindow.webContents.on('before-input-event')` in `createWindow()`.

**Why this is necessary:** macOS dispatches unhandled keystrokes from the renderer to the application menu for key-equivalent matching. With the sandboxed renderer focused, this renderer→native-menu redispatch path is unreliable — accelerators assigned to click-handler items (i.e., non-role items) silently do nothing when pressed via keyboard, even though menu-bar mouse clicks work correctly.

**How `handleMenuAccelerator` works:**

- Receives every real keydown before the renderer processes it.
- Matches ⌘1–⌘9 on `input.code` (`Digit1`…`Digit9`) — the physical-key code rather than `input.key` — so the shortcuts remain positional on non-QWERTY layouts (AZERTY, Dvorak) without requiring `Shift`.
- Matches ⌘N, ⇧⌘I, and ⌃⌘S on `input.key` (layout-agnostic for letter keys).
- ⌃⌘S is macOS-specific; on other platforms the chord is Ctrl+Shift+S.
- Calls `menuAction()` → `sendToApp('menu:action', …)` on match.
- Calls `event.preventDefault()` to suppress any duplicate native-menu dispatch, ensuring each chord fires at most once.
- Auto-repeat events (`input.isAutoRepeat`) are ignored.
- Role items (Reload, Zoom, Copy, Paste, …) are unchanged — they use Electron/AppKit's native path.

> [!warning] Manual sync point — accelerators and routes
> `handleMenuAccelerator` must mirror the accelerators declared in `setupApplicationMenu()`. `GO_MENU_ROUTES` in `packaging/electron/main.js` must stay in sync with `GO_TO_ROUTES` in `apps/frontend/src/hooks/useGoToShortcuts.ts`. Both files carry a comment flagging the dependency.

> [!info] AZERTY/non-QWERTY confirmation pending
> End-to-end tests on the real stack confirmed ⌘7 → /portfolio and ⌘1 → / after a client-side navigation. Real-keyboard validation on a built `.app` (including AZERTY layout) is still pending (logged in TODO.md).

#### Window Chrome (darwin-only)

`createWindow()` applies these options only on macOS:

| Option                 | Value            | Effect                                                |
| ---------------------- | ---------------- | ----------------------------------------------------- |
| `titleBarStyle`        | `'hiddenInset'`  | Hides the title bar; traffic lights stay in the frame |
| `trafficLightPosition` | `{x:20, y:20}`   | Centers traffic lights in the 56px topbar             |
| `vibrancy`             | `'under-window'` | NSVisualEffectView behind the window content          |
| `visualEffectState`    | `'followWindow'` | Active/inactive vibrancy follows window focus         |

`enter-full-screen` and `leave-full-screen` Electron events push a boolean over `window:fullscreen`. `ElectronBridge` adds/removes the `electron-fullscreen` html class so CSS can drop the 88px left inset when the traffic lights disappear in fullscreen mode.

The same lights also overlap the **sidebar's** top-left corner (the rail reaches the top of the window). `index.css` reserves a Finder-style strip above the sidebar header — `html.electron-mac:not(.electron-fullscreen) [data-sidebar="header"] { margin-top: 28px; }` — so the logo clears the buttons; the strip collapses in fullscreen along with the lights (fixed 2026-06-11, user-reported logo/close-button collision).

#### Native Application Menu

Built via `Menu.setApplicationMenu` after the shell loads the language persisted in Electron `settings.json`. The renderer republishes the hydrated in-app language over `app:set-language`; last-write-wins sequencing prevents rapid changes from applying out of order, and both application and dock menus rebuild after a change. Native labels and dialogs use the same flat JSON (`menu.*`, en + nl).

**Menu structure:**

| Menu   | Items                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| App    | Settings… (⌘,)                                                                                                 |
| File   | New Transaction (⌘N), Import CSV… (⇧⌘I)                                                                        |
| Edit   | System role (undo, cut, copy, paste, …)                                                                        |
| View   | Toggle Sidebar (⌃⌘S), Reload (dev-only), Zoom In/Out/Reset, Enter Full Screen, Toggle DevTools (dev-only)      |
| Go     | ⌘1–⌘9 routes from `GO_MENU_ROUTES` (manually mirrors `GO_TO_ROUTES` in `hooks/useGoToShortcuts.ts`)            |
| Window | System role (minimise, zoom, …)                                                                                |
| Help   | About Vision (Windows/Linux), Keyboard Shortcuts (opens overlay via `menu:action`), Source Code, Documentation |

`setAboutPanelOptions` supplies the application name, running version, copyright,
and AGPL-3.0 license identity on every supported platform. Electron displays the
configured project website in Linux's native About panel; macOS and Windows still
receive the same metadata but do not expose Electron's `website` field there.
The repository and documentation Help items use fixed HTTPS destinations from
the packaged main process; no renderer-supplied URL reaches `shell.openExternal`.

> [!warning] Manual sync point
> `GO_MENU_ROUTES` in `packaging/electron/main.js` must be kept in sync by hand with `GO_TO_ROUTES` in `apps/frontend/src/hooks/useGoToShortcuts.ts`. Both files carry a comment flagging this dependency.

Menu and dock items dispatch `{action, payload}` over `menu:action`. `ElectronBridge` maps actions to: `navigate` (React Router push), `open-settings`, `open-shortcuts` (ShortcutsOverlay), `new-transaction` (navigate to `/transactions?new=1`), `toggle-sidebar`.

#### Dock Menu and Desktop Badge

The macOS dock menu contains **New Transaction** and **Dashboard**. Both dispatch the same `menu:action` channel, and their labels rebuild when the in-app language changes.

The desktop badge reflects the visible (non-dismissed) count of upcoming planned payments. `UpcomingPaymentsNotification` owns the due-payments query and dismissal state; it calls `setDockBadge(count)` whenever the count changes and clears it on unmount. Main maps that count to the macOS dock badge, Linux launcher badge count, or a generated 32px PNG Windows taskbar overlay. The badge is entirely renderer-driven — main has no knowledge of upcoming payments.

#### CSV Import Handoff — Two Paths

**Path 1 — Window-wide drag-and-drop (renderer handles)**

`ElectronBridge` attaches a `dragover`/`drop` listener to `window`. All file drops are swallowed (closes the Chromium "navigate-to-dropped-file" hole). `.csv` files are read as text via the `File` API and pushed into `lib/importHandoff.ts`; non-CSV files are silently ignored. `data-dropzone` descendants of the dropzone div in `TransactionImportCard` are exempted via ancestor-check so in-card drops still work normally.

**Path 2 — Finder "Open With" / dock drop (main handles)**

`app.on('open-file')` in main applies an extension whitelist (`.csv` only) and a 25 MB cap, reads the file content itself, and forwards `{name, content}` over `app:csv-opened`. The renderer reconstructs a `File` object. The OS-chosen filesystem path never crosses into the renderer.

**`lib/importHandoff.ts`**: a one-slot, 30-second TTL registry (`registerPendingImportFile` / `consumePendingImportFile`) in the same style as `lib/undo.ts`. `TransactionImportCard` calls `consumePendingImportFile()` on mount; if a slot is waiting it pre-fills the import dropzone. Both paths converge on this slot, then navigate to `/import`.

#### System Accent Color Overlay

The system accent is a **runtime token overlay**, not a sixth theme variant, so it composes with all five variants and both light/dark modes.

- `settingsStore.ts` adds `themeSystemAccent: boolean` + `setThemeSystemAccent` + hydration support.
- `theme_settings` JSONB gains an optional `systemAccent` key; older payloads hydrate fine.
- Switch rendered in `AppearanceTab` only when `isElectronMac()` returns true.
- When enabled, `ThemeContext` calls `applyThemePalette` (resets all tokens) then overrides `--primary`, `--primary-foreground`, `--ring`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-ring` with the converted accent.
- `lib/accentColor.ts`: `hexToHslComponents` converts Electron's RRGGBBAA hex to `"h s% l%"`; `accentForegroundComponents` picks WCAG-contrast foreground (ink for yellow/green accents, white for blue/purple).
- Live updates arrive via `onAccentColorChanged`. An **epoch counter** in `ThemeContext` discards stale async applies that arrive out-of-order.
- Toggling off self-heals: `applyThemePalette` resets every token back to the variant default.

#### Under-Window Vibrancy

The window is always created with `vibrancy: 'under-window'` + `visualEffectState: 'followWindow'`. While the page paints opaque pixels the glass effect is invisible — default rendering is unchanged.

Only when `AppSettings.enhancedEffects` (ADR-071) is `true` does `ElectronBridge` add the `vibrancy` html class. One CSS rule in `index.css` then makes `body` translucent (`hsl(var(--background) / 0.72)`). Since body background propagates to the root canvas, a single rule controls the entire backdrop.

> [!warning] Requires visual pass on-device
> The 0.72 alpha and traffic-light/topbar geometry are tuned without a display. The user must validate contrast and positioning in the built `.app` before shipping.

#### Frontend Component: `ElectronBridge.tsx`

**File:** `apps/frontend/src/components/layout/ElectronBridge.tsx`

Mounted once in `AppLayout`, inside `SidebarProvider`. Responsibilities:

- Calls `electronAPI.ready()` on mount (drains the send queue).
- Attaches `onMenuAction`, `onCsvOpen`, `onFullScreenChange` listeners via stable refs so React re-renders never tear down IPC subscriptions.
- Routes menu actions: `navigate` → React Router; `open-settings` / `open-shortcuts` / `toggle-sidebar` → dispatch to UI state; `new-transaction` → navigate to `/transactions?new=1`.
- Manages `electron-mac`, `electron-fullscreen`, and `vibrancy` html classes.
- Attaches window-level `dragover`/`drop` for CSV handoff (exempts `[data-dropzone]` ancestors).

---

### Backup/Restore (Phase 1+2)

**IPC Handlers** for bundle-based backup/restore:

| Handler                        | Signature                                 | Purpose                                                                                                                                                         | Status                |
| ------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `backup:run`                   | `(destDir, frontendStateJson?)` → Promise | Create and optionally encrypt `.visionbak` bundle; returns `{ success, file, encrypted?, cleanupRemoved?, warning?, error? }`                                   | ✅ Phase 1+2          |
| `backup:restore`               | `(bundlePath)` → Promise                  | Restore from `.visionbak`; stage and validate a provider database and attachments, activate atomically, wait for detailed readiness, and restore frontend state | ✅ Phase 1+2 + native |
| `backup:select-file`           | `()` → Promise<string>                    | Show file picker for `.visionbak` or `.visionbak.enc` selection                                                                                                 | ✅ Phase 1+2          |
| `backup:select-dir`            | `()` → Promise<string>                    | Show folder picker for backup directory                                                                                                                         | ✅ Phase 1+2          |
| `backup:save-settings`         | `({ backupDir, backupOnQuit })` → Promise | Persist backup settings to `settings.json`                                                                                                                      | ✅ Phase 1+2          |
| `backup:load-settings`         | `()` → Promise                            | Load backup settings (directory, onQuit flag, encryption status)                                                                                                | ✅ Phase 1+2          |
| `backup:get-encryption-status` | `()` → Promise                            | Return `{ hasStoredPassphrase }`                                                                                                                                | ✅ Phase 1+2          |
| `backup:set-passphrase`        | `(passphrase)` → Promise                  | Set or update backup encryption passphrase (stored encrypted in `settings.json`)                                                                                | ✅ Phase 1+2          |

**Frontend Integration:**

- `apps/frontend/src/lib/api/electron.ts` — Type definitions and wrapper functions
  - `runBackup(destDir, frontendStateJson?)` — Collects localStorage snapshot, invokes `backup:run`
  - `restoreBackup(filePath)` — Invokes `backup:restore`, writes frontend state back to localStorage
- `apps/frontend/src/features/settings/sections/BackupSection.tsx` — UI for backup/restore, passphrases, directory selection
  - Handles `BUNDLE_SCHEMA_NEWER` error with user-friendly toast

**Passphrase Storage & OS Keychain (Lazy safeStorage):**

The backup encryption passphrase (when set by the user) is stored encrypted in `settings.json` using Electron's `safeStorage` API, which on macOS delegates to the system Keychain under the entry "Vision Safe Storage".

Vision is ad-hoc unsigned (no Developer ID certificate), so macOS treats the code identity as unstable. Normally, accessing `safeStorage` on every launch would trigger a login-password prompt even for users who have never configured a passphrase. The shell avoids this with lazy access:

- `getBackupPassphrase()` reads the stored `backupPassphraseEncrypted` blob from `settings.json` **before** calling `safeStorage.isEncryptionAvailable()` or `decryptString()`. If no blob is stored and the `VISION_BACKUP_PASSPHRASE` env var is absent, it returns without touching the keychain — zero prompts.
- `getBackupPassphraseStatus()` (IPC: `backup:get-encryption-status`, used by the Backup settings tab) only calls `isEncryptionAvailable()` when a passphrase is already stored. With nothing stored it reports availability from the mere presence of the `safeStorage` API object (no keychain probe). The real availability check happens in `setBackupPassphrase()` when the user actually opts in.

> [!info] Keychain prompts on unsigned builds
> Users who store a passphrase will still see macOS password prompts on an unsigned build because macOS re-challenges an unstable code identity each time. Workarounds:
>
> - Click **Always Allow** in the Keychain prompt to suppress future challenges for this app.
> - Set the `VISION_BACKUP_PASSPHRASE` environment variable — this bypasses `safeStorage` entirely and is useful for automation or CI.
> - Do not configure a backup passphrase if prompts are unwanted; unencrypted backups work without keychain access.
>
> Note: `safeStorage` only _stores/retrieves the passphrase_. The backup encryption key itself is always scrypt-derived from the passphrase and never touches the keychain.

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

### Application Updates (April–August 2026)

Vision supports **four update modes**, including a Docker-independent packaged native path. See [[docs/features/application-updates|Application Updates Feature]] for full architecture, IPC handlers, and frontend UI.

#### Deployment Modes

| Mode       | Condition                         | Update Method                          | Artifacts                                            |
| ---------- | --------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| **native** | Packaged app with native provider | Verified app replacement with rollback | `Vision-x.y.z-arm64-mac.zip` + `.sha256`             |
| **dev**    | `app.isPackaged === false`        | Source restart/relaunch                | Checkout files                                       |
| **source** | Packaged app in repository mode   | Shell script installer from GitHub     | `vision-source-launcher-x.y.z-arm64.zip` + `.sha256` |
| **docker** | Explicit Docker provider          | Compose pull and restart               | Image at `ghcr.io/erapartner/vision:<tag>`           |

#### IPC Handlers

| Handler                    | Purpose                                                       | Modes                  |
| -------------------------- | ------------------------------------------------------------- | ---------------------- |
| `update:get-mode`          | Return `native`, `dev`, `source`, or `docker`                 | All                    |
| `update:pre-update-backup` | Create a `.visionbak` through the active runtime transport    | native, source, docker |
| `update:install-shell`     | Download, verify, and install the native app or source update | native, source         |
| `update:check-github`      | Check GitHub and return the current update mode               | All                    |

#### Native Installer

Native mode requires a sibling checksum, rejects path traversal, accepts only a `Vision.app`
payload, and stops the native backend before launching the fixed installer helper. Helper-launch
failure restarts the old backend. The helper snapshots the installed application before
replacement; copy or relaunch failure restores the previous application. PostgreSQL and
attachments remain in application data and are not replaced by the application archive.

#### Generated Installer (Source Mode)

The updater generates a fixed shell helper after it has downloaded and verified
the source-launcher ZIP:

- **Rollback strategy:** BAK_DIR snapshot created before rsync, restored on failure
- **Native payload preservation:** the generated PostgreSQL, Alembic, and Chromium
  payload is excluded from source-tree replacement
- **Quarantine removal:** `xattr -rd com.apple.quarantine` applied to entire DEST_ROOT and launcher scripts
- **Separation:** this helper is not the repository's `install.sh` source-build command

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

All installable updates (native, source, and Docker modes) follow this sequence:

```
1. User clicks "Update & Restart"
   ↓
2. Backup phase: IPC call preUpdateBackup()
   → Create .visionbak through the active database/attachment transport
   → Encrypt bundle when configured (AEAD, Phase 1+2)
   ↓
3. Download phase: Fetch installer or pull image
   ↓
4. Verify phase (native and source): Check SHA256
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
  - Version tag matches the root, frontend, and Electron package manifests
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
    sandbox: true, // Layer 1: Renderer sandbox (OS-level)
    contextIsolation: true, // Layer 2: Isolate preload from renderer context
    nodeIntegration: false, // Layer 3: No Node.js in renderer
    preload: path.join(__dirname, "preload.js"),
  },
});
```

**Each layer is independent:** Even if one is bypassed, the others remain effective.

### Context Isolation & Preload

```javascript
// preload.js - the only Node-accessible code
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronRecovery", {
  retry: () => ipcRenderer.invoke("recovery:retry"),
  openLogs: () => ipcRenderer.invoke("recovery:open-logs"),
  onBackendLost: (cb) => ipcRenderer.on("backend:lost", cb),
  onBackendRestored: (cb) => ipcRenderer.on("backend:restored", cb),
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

The root `bun install` prepares the separate Electron package outside CI. If its local binary is missing, repair it explicitly with `bun run install:electron` before launching a wrapper.

```bash
# Native development mode
bun run electron:dev

# Production mode
bun run electron:prod

# Explicit optional Docker provider
bun run electron:docker
```

### Debugging

- **Main process:** `electron --inspect`
- **Renderer process:** Chrome DevTools (Cmd+Option+I)
- **Backend process:** Standard Node.js debugging

### Optional Docker Dev Rebuild File Watcher

When the explicit Docker provider is used in development, a file watcher monitors source files and
triggers an automatic Docker rebuild and restart. Native development restarts the Bun backend from
the checkout and does not build a Docker image.

```javascript
// Watches frontend, backend, packages/, i18n/source and bun lockfiles
fs.watch(sourceDir, { recursive: true }, (eventType, filename) => {
  // Kill in-flight build with SIGTERM to signal cancellation
  if (activeBuildChild) {
    activeBuildChild.kill("SIGTERM");
  }
  // Queue new rebuild from updated sources
});
```

**Watch targets (June 2026):** `apps/frontend`, `apps/node-backend`, `packages/`, `i18n/source`, `package.json`, `bun.lock[b]`. The watch callback ignores `node_modules/`, `dist/`, and dot-directory churn.

Previously only the two `apps/` directories were watched, so edits to `packages/shared-utils` or locale strings in `i18n/source` never triggered an auto-rebuild in dev mode — the container kept serving stale code until the next manual relaunch. This was confusing because `DOCKER_PATHS` (the skip-build cache check) already tracked those paths.

**Behavior:**

- File edit detected → signal SIGTERM to any in-flight build
- In-flight build catches SIGTERM, marks error as `.cancelled = true`, rejects promise
- Cancelled build swallows error (expected), does not log failure
- New build is immediately queued with the latest source state

**Rationale:** Eliminates stale builds when multiple edits occur in quick succession. Prevents cascading Docker builds while preserving the most recent change for execution.

### Dockerfile Dependency-Layer Cache (June 2026 — P2 fix)

**Problem:** Both Dockerfile stages previously copied the full `packages/` directory and `i18n/source/` before running `bun install --frozen-lockfile`. Any change to `packages/shared-utils/src/*` or a locale string invalidated the install layer, triggering a full dependency reinstall in every image build (CI and Electron dev-mode auto-rebuilds).

**Fix:** Only workspace manifests (`packages/*/package.json`) are copied before `bun install`. The full `packages/` tree and `i18n/source/` are copied after the install layer, before the build steps that require them. Stage 2 also adds a post-install `COPY packages/` so symlink targets for the shared-utils workspace are in place at runtime.

**Verify:** `docker build` twice with a one-line change in `packages/shared-utils/src/money.js` between runs — the second build should show `CACHED` on the install layer.

### Dockerfile Bun Install Retries (August 2026)

Both Dockerfile dependency stages run `scripts/bun-install-with-retry.sh`. The wrapper retries a
failed frozen install up to three times with a two-second delay. This covers transient registry or
Bun download failures, including a tarball integrity failure caused by an incomplete download.

Every attempt keeps `--frozen-lockfile` and Bun's integrity verification enabled. The wrapper does
not rewrite the lockfile, clear the cache, or bypass a mismatch; a persistent failure still stops
the image build after the third attempt.

### Quit and Runtime Lifecycle (June–August 2026)

The `will-quit` handler delegates shutdown to the selected runtime provider. Native mode sends a
clean termination signal to the verified backend and Vision-managed PostgreSQL children, waits for
shutdown, and uses a bounded force fallback. An explicitly configured external PostgreSQL service
is never stopped. Docker mode runs `docker compose stop` (not `down`) to stop containers on quit.

When the user enables `keepServicesOnQuit`, the shutdown call is skipped for either provider. In
native mode this keeps both the verified Bun backend and Vision-managed PostgreSQL child alive for
the next launch.

**Why this matters:** `compose down` removes containers and the Docker network on every quit. The launcher's warm-boot fast path (`compose start`) requires containers to exist in a stopped state — if they were removed, every boot pays full container/network recreation. With `compose stop`, containers survive in the `exited` state and the next launch completes the `compose start` sub-second path rather than a full `compose up`.

`compose down` is still used by:

- The explicit clean-slate rebuild path (`docker-compose.clean.yml`)
- Manual maintenance flows

`restart: unless-stopped` semantics are preserved: user-stopped containers do not auto-start when the Docker daemon relaunches.

### Window Bounds Persistence (June 2026 — U2 fix)

Window size and position are persisted to `settings.json` under the `windowBounds` key and restored on the next launch.

**Behavior:**

- On `resize` and `move` events, `getNormalBounds()` is written via a debounced handler.
- On quit, bounds are written synchronously before the process exits.
- On `createWindow()`, stored bounds are read and clamped to the active display's `workArea` (handles unplugged external monitors). Minimum enforced size: 800×600.
- If no stored bounds exist, the window opens at the prior default (1280×800, centered).

This is baseline macOS window-state behavior and removes the most visible "not a real Mac app" tell alongside the V12 native-chrome work.

### Boot Splash — Localized, Branded, and Theme-Aware (June 2026 — P5/U3 fix; branded August 2026)

The boot splash (`setSplashStatus()`) is now:

- **Localized** — uses the `splash.*` i18n keys loaded at startup via `initI18n()` (available before the window opens).
- **Theme-aware** — derives the near-black base, glow, and foreground from the persisted primary palette. First launch uses the canonical emerald primary instead of the previous generic slate fallback.
- **Branded** — the Vision mark appears above the spinner. The backend recovery page uses the same validated palette variables plus the champagne accent, so startup and failure states share one identity without weakening the error page Content Security Policy.
- **Phase-narrating** — calls `setSplashStatus(text)` at four boot checkpoints:
  - `splash.checkingDocker` — explicit Docker provider socket probe
  - `splash.downloading` — Docker image pre-pull/build or packaged update phase
  - `splash.startingServices` — native PostgreSQL/backend or Compose startup
  - `splash.waitingApp` — backend health-poll underway

**i18n keys (en/nl):** `splash.checkingDocker`, `splash.downloading`, `splash.starting`, `splash.startingServices`, `splash.waitingApp`. Keys flow through `i18n/source/*.json` → `apps/frontend/src/locales/*.ts` → `packaging/electron/i18n/*.json` via `generate-locales`.

### Graceful Shutdown — Idle Keep-Alive Sockets (June 2026 — P4 fix)

The backend shutdown path (`httpServer.close()`) now immediately follows with `httpServer.closeIdleConnections?.()`. The Electron health watchdog uses a `keepAlive: true` agent, so an idle keep-alive socket from the shell to the backend is the norm. Without `closeIdleConnections`, `server.close()` could hang for up to the 10-second force-exit backstop waiting for the socket to time out.

Additionally, the shell destroys its health-poll `keepAlive` agent on quit before sending the
provider stop signal, so the agent socket is already gone by the time the backend initiates
shutdown.

---

## Error Recovery

### Error Page

If the backend is unavailable at startup, or the frontend does not complete its renderer-ready
handoff after one cache-bypass retry, `error.html` displays localized `app.*` strings:

```
┌───────────────────────────────────────────────────┐
│  Vision couldn't start                            │
│  Vision couldn't reach its backend. Try again,    │
│  or check the logs to see what happened.          │
│                                                   │
│  [Try again]      [Open logs]                     │
└───────────────────────────────────────────────────┘
```

`loadErrorPage()` passes only HSL component strings that satisfy the same strict
validator used by the splash. `error.js` re-validates those query values before
setting the three palette custom properties. The page ships its own emerald and
champagne defaults, so malformed or missing palette input still remains branded.
Backend failures use `app.errorPageMessage`; renderer handoff failures use
`app.rendererErrorPageMessage`. Both offer the same bounded retry and log-opening actions.

### Demo Application Identity

The Demo builder overrides the production icon with
`resources-demo/icon-demo.icns`, derived from the canonical mark and carrying a
high-contrast champagne `DEMO` badge. The production and Demo apps therefore
remain distinguishable in Applications, the Dock, and system dialogs. The
committed SVG is the editable source; `scripts/pack-iconset.cjs` packs validated
PNG representations into the ICNS container without changing the production
icon.

The Demo app uses `~/Library/Application Support/Vision Demo/native/vision_demo`, PostgreSQL port
`54330`, and a dedicated role/database namespace. Production Vision uses `native/vision` and port
`54329`. The package contains the same native PostgreSQL, migration, Bun backend, frontend, and
Chrome Headless Shell payload as production plus the deterministic `demo-seed` resource. First
launch and seed updates use a staged database-name switch with rollback until detailed readiness
passes. The seed manifest records its build reference date; all application
dates are shifted from the canonical scenario anchor so historical rows end at
the reference date and planned rows remain current. The same explicit
reference date always generates identical logical SQL. `bun run demo:reset-native` requests the same verified seed activation on the next launch.
No Demo startup or installer path invokes Docker. See
[[docs/adr/114-native-deterministic-demo-runtime|ADR-114]].

**Try again** → Re-runs health poll from current state (`recovery:retry` IPC)
**Open logs** → Opens app logs directory (`recovery:open-logs` IPC)

> [!info] Localization status
> The error page has been fully localized since 2026-06-11. Prior to that date, `packaging/electron/main.js` passed the i18n key names as the query-param values (e.g. `?title=app.errorPageTitle`) because the keys were absent from `i18n/source/` — see the correction note in [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022]] and the batch entry in [[docs/i18n/translations|translations]] for details.

### Runtime Watchdog

After startup succeeds, a watchdog monitors backend health:

- Polls `/health` every 10 seconds
- 3 consecutive failures → `backend:lost` IPC event
- Renderer can show user-facing error banner
- Recovery → `backend:restored` event

The watchdog is observational. It does not restart a container whose process is still alive but
whose Docker health status is `unhealthy`; plain Docker also does not restart on health status
alone. Its loss/restoration IPC callbacks are exposed by preload but currently have no React
subscriber. On initial readiness timeout, native mode captures a redacted tail of
`native/vision/logs/backend.log`; Docker mode captures `docker compose ps --all` and recent
app/database logs. This makes a repeated migration or startup failure diagnosable without turning
the shell into an automatic database-recovery controller.

### Corrupt Settings Recovery

If `settings.json` is unparsable:

- App quarantines corrupted file as `settings.json.corrupt-<timestamp>`
- Returns application defaults
- User can manually fix or let defaults reset settings

---

## Health Monitoring

### Poll Functions

Two poll functions cover distinct use cases:

| Function                  | Endpoint               | Purpose                                                                                                                                                                                                              |
| ------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pollReady(maxAttempts)`  | `GET /health/detailed` | Gates the **initial page navigation** on materialized-view warmup. Navigate when `status === 'ready'` OR `caches.materializedViews === true`. 404/unparseable responses fall back to ready. Boot mark: `poll_ready`. |
| `pollHealth(maxAttempts)` | `GET /health`          | Used by watchdog, restart, update, and dev-rebuild flows. Only tests that Express is listening.                                                                                                                      |

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

**Symptom:** A fresh database fails migration with an FK constraint violation or string truncation
error on revision `0003_import_batch_id_on_transactions`.

**Root cause:** Two pre-ADR-027 squash oversights:

1. Baseline migration 0001 was missing `import_batches` and `import_staging_rows` tables; migration 0003 tried to FK to non-existent tables.
2. If DB is truly fresh (no `alembic_version` table), alembic auto-creates it at `VARCHAR(32)`, but revision name `0003_import_batch_id_on_transactions` (38 chars) causes string truncation.

**Fix:** Implemented in 2026-04-27 release:

1. Ported import staging tables from legacy 0030 into 0001 baseline.
2. Preflight-created `alembic_version` table at `VARCHAR(64)` before alembic runs.

See [[docs/adr/027-alembic-single-source-of-schema#follow-up-migration-ordering-bugs-fixed-2026-04-27|ADR-027 follow-up: Migration Ordering Bugs Fixed]].

**Verification:** The current migration runner preflights `alembic_version VARCHAR(64)` in both
runtime providers. A fresh synthetic native database and the optional clean Docker database should
both migrate to the current head.

### Cannot find module './backup/bundle'

**Cause:** `backup/` directory is absent from the electron-builder base `files` array.

**Fix:** Ensure `packaging/electron/electron-builder-base.json` includes `backup/**/*` and
`runtime/**/*`.

```json
{
  "build": {
    "files": [
      "main.js",
      "badge-image.js",
      "compose.js",
      "updater.js",
      "preload.js",
      "backup/**/*",
      "assets/**/*"
    ]
  }
}
```

**Verification:** After build, inspect asar contents:

```bash
file dist/mac-arm64/Vision.app/Contents/Resources/app.asar
```

### Cannot find module 'archiver-utils' (or compress-commons, readable-stream, zip-stream)

**Cause:** The Electron dependency tree or packaged asar is incomplete. See [[#package-manager-bun|Package Manager (Bun)]] above.

**Fix:**

1. Confirm `packaging/electron/bun.lock` is present and unchanged.
2. Reinstall with `bun install --frozen-lockfile --cwd packaging/electron`.
3. Rebuild with `npm run dist` from `packaging/electron/` and inspect the resulting asar before changing dependency declarations.

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

**Verification:** After build, verify `app.asar` and the external native payload manifest. The
payload must contain the compiled backend, frontend, migrations, and migration runner.

```bash
node packaging/electron/scripts/prepare-native-runtime.js
```

### Docker provider: registry unauthorized on first launch

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
    pull_policy: missing # Use local image if available; skip registry pull
```

**Manual pre-pull (if needed):**

1. Build locally: `docker compose build` (creates `vision-app:latest`)
2. Retag: `docker tag vision-app:latest ghcr.io/erapartner/vision:latest`
3. Rebuild packaged app: `npm run dist`

With automatic pre-pull + `pull_policy: missing`, Docker Compose finds the locally-tagged image without attempting registry auth on first launch or subsequent boots.

## Related

- [[docs/adr/072-electron-native-desktop-integration|ADR-072: Electron-Native Desktop Integration]] — hiddenInset chrome, native menu/dock, CSV handoff, system accent, vibrancy (June 2026)
- [[docs/adr/113-native-macos-runtime|ADR-113: Native macOS Runtime]] — PostgreSQL 18, runtime providers, cutover, and rollback
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]] — operation and migration procedure
- [[docs/adr/071-premium-v3-effects-toggle|ADR-071: Premium v3]] — `enhancedEffects` toggle that gates vibrancy
- [[docs/adr/045-electron-app-name-userData-migration|ADR-045: App Name & userData Migration]] — macOS TCC prompt fix + legacy dir migration
- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022: Electron Sandbox Hardening]] — Security + recovery design
- [[docs/adr/023-update-installer-checksum-verification|ADR-023: Installer Checksum Verification]] — Supply-chain security
- [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020: Glass System Downgrade]] — Electron M1 GPU budget history (vibrancy context)
- [[docs/api/health|Health API]] — Backend readiness endpoints
- [[docs/features/appearance|Appearance]] — System accent toggle, enhancedEffects, vibrancy
- [[docs/features/import|Import Feature]] — CSV drag-and-drop + Finder handoff
- [[docs/guides/deployment]] — Deployment guide
- [[docs/reference/scripts]] — Build scripts
- [[docs/security/index]] — Security documentation
