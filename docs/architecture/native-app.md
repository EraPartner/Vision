---
title: Vision Native App Architecture
type: architecture-doc
status: active
date: 2026-10-13
updated: 2026-10-15
tags:
  [
    architecture,
    swift,
    swiftui,
    macos,
    native-app,
    xcodegen,
    ci,
    packaging,
    postgresql,
    runtime,
    webkit,
    menus,
    preload-bridge,
    backup,
    audit-log,
    keychain,
    demo,
    adr-204,
    adr-205,
    phase-2,
    openapi,
    design-tokens,
    string-catalog,
    navigation,
  ]
description: "Vision Native is the Swift macOS app under apps/native/ that replaces the Electron shell in phases (ADR-204). Covers the directory layout, the runtime supervisor that starts its own PostgreSQL 18 cluster and backend on synthetic Demo data, payload discovery, the phase 1c shell (window, launch state, preload bridge, web view navigation and download policy, menus, dock and vibrancy), phase 1d backup and restore (bundle format compatibility, Keychain passphrase, restore allow-list, quit-time backup), the phase 1e audit anchor and Keychain witness with restore continuity, the standard and Demo variants of one build, the Debug-only backend override, the phase 2 foundations (generated OpenAPI client, design tokens, String Catalog and sidebar registry, the native NavigationSplitView shell with the shell:route-changed bridge message, and the native Exchange rates screen), the Native (macOS) CI job with the backup and audit interop job, screen ports through phase 3p native shell overlays, onboarding and PDF reports, alongside phase 3n Research Home, Markets, Lookup, Watchlist, Compare, Forecast, Chart Builder, Dossiers and AI chat/Investigation (lossless provider data, shared TypeScript presentation, guarded local drafts/cache, and earlier Analysis/Portfolio/Tax/import screens), and install-native.sh."
aliases: [vision native, native app, swift app]
---

# Vision Native App Architecture

> [!abstract] Overview
> Vision Native is a separate Swift app, bundle identifier `com.vaultvoyager.vision-native` (and
> `com.vaultvoyager.vision-native-demo` for the Demo variant), that replaces the
> [[docs/architecture/electron|Electron shell]] in phases
> ([[docs/adr/204-vision-native-swift-app-target|ADR-204]]). In phase 1 it hosts the existing
> React frontend in a `WKWebView` and runs its own runtime on synthetic Demo data only. The Electron
> "Vision" app stays the daily app until the phase 4 switch-over. The phase 1 hand-over is
> recorded in [[docs/adr/205-vision-native-hand-over|ADR-205]] (accepted), and
> [[docs/reference/native-parity/phase-1-exit|the phase 1 exit checklist]] maps every shell and
> settings action to its Swift code. Phase 2 adds a native sidebar around the web view and the
> first native screen, Exchange rates (see
> [[docs/architecture/native-app#Native navigation and screens (phase 2)|phase 2]]). Phase 3 now includes
> native Research Home, Markets, Lookup, Watchlist, Compare, Forecast and Chart Builder, alongside Analysis, Portfolio
> Import/review and Portfolio Tax. TypeScript retains financial calculations, restricted execution
> and import writers. Settings and global notices are native in phase 3o; palette, banners, onboarding and shared PDF overlays are native in phase 3p. Dossiers and AI chat/Investigation
> are native in phase 3n. macOS build and synthetic Demo visual/keyboard review remain pending.

## Layout

| Path                                               | Purpose                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/native/project.yml`                          | XcodeGen spec: project `VisionNative`, macOS app target "Vision Native", macOS 26.0                                                                                                                    |
| `apps/native/Config/Signing.xcconfig`              | `DEVELOPMENT_TEAM` from `VISION_NATIVE_TEAM_ID`, optional gitignored `Local.xcconfig`                                                                                                                  |
| `apps/native/VisionNative/`                        | AppKit entry point, window, menus, `WKWebView` shell and the SwiftUI launch state                                                                                                                      |
| `apps/native/Package.swift`                        | SwiftPM package (Swift 6), libraries `VisionNativeCore` and `VisionNativeUI`, no deps                                                                                                                  |
| `apps/native/Sources/VisionNativeCore/`            | `BackendLocator` and `BackendHealth`: non-UI logic, testable without the Xcode UI                                                                                                                      |
| `apps/native/Sources/VisionNativeCore/API/`        | `APIClient` (the Swift `client.ts`) and the generated OpenAPI models and operations                                                                                                                    |
| `apps/native/Sources/VisionNativeCore/Design/`     | Generated design tokens and `ThemeSelection` (variant and appearance of the page)                                                                                                                      |
| `apps/native/Sources/VisionNativeCore/Navigation/` | Generated sidebar registry, routes, shortcuts and the `NativeShellModel` (phase 2)                                                                                                                     |
| `apps/native/Sources/VisionNativeCore/Screens/`    | View models of native screens (Exchange rates, Admin, Planned, Imports, Transactions, Owes, Accounts, Categories, Recipients, Home/Insights, Tax, Portfolio/wealth tools, Analysis/Monitors, Research) |
| `apps/native/Sources/VisionNativeUI/`              | SwiftUI shell, native screens and the generated `Localizable.xcstrings` (phase 2)                                                                                                                      |
| `apps/native/openapi-operations.txt`               | The operationIds the Swift client is generated for                                                                                                                                                     |
| `apps/native/i18n-keys.txt`                        | The `i18n/source` keys copied into the String Catalog                                                                                                                                                  |
| `apps/native/Sources/VisionNativeCore/Runtime/`    | Runtime supervisor, PostgreSQL and backend lifecycle, Demo seeding, system seams                                                                                                                       |
| `apps/native/Sources/VisionNativeCore/Shell/`      | Shell logic without AppKit: bridge contract, codec, policy, menu model, window frame                                                                                                                   |
| `apps/native/Sources/VisionNativeCore/Backup/`     | Backup bundles, encryption, restore and the `electronBackup` service (phase 1d)                                                                                                                        |
| `apps/native/Sources/VisionNativeCore/Audit/`      | Audit anchor, Keychain witness, backend audit bridge and `electronAudit` (phase 1e)                                                                                                                    |
| `apps/native/Tests/VisionNativeCoreTests/`         | Swift Testing tests and fixtures (Electron backup bundle, Electron audit anchor)                                                                                                                       |
| `apps/native/Tests/VisionNativeUITests/`           | String Catalog completeness (EN and NL) and SwiftUI layout tests                                                                                                                                       |
| `install-native.sh`                                | Local Release build and install, by default to `/Applications/Vision Native Demo.app`                                                                                                                  |

The generated `apps/native/VisionNative.xcodeproj`, its `Info.plist`, `apps/native/build/` and
the SwiftPM state are gitignored. The app target uses Swift 6 with complete strict concurrency,
automatic signing, no hardened runtime and no App Sandbox, because the app supervises the bundled
PostgreSQL runtime as child processes. App Transport Security allows only local networking
(`NSAllowsLocalNetworking`).

XcodeGen stays the project-file tool: ADR-204 decision 3 made it the default and the owner has not
objected. The macOS deployment target (`project.yml` and `Package.swift`) and the CI runner label
(`macos-26`) are pinned together and are raised together when GitHub's runner image moves.

## Runtime supervision

Vision Native starts, supervises and stops its own PostgreSQL 18 cluster and compiled backend. The
Swift code ports `packaging/electron/runtime/native.ts` and `native-demo.ts` and reuses their SQL,
roles, extensions and manifest semantics. See the
[[docs/guides/native-macos-runtime|Native macOS Runtime Guide]],
[[docs/adr/113-native-macos-runtime|ADR-113]] and
[[docs/adr/114-native-deterministic-demo-runtime|ADR-114]]. It does not depend on Vision Demo
running.

| Type                | Role                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- |
| `RuntimeSupervisor` | Actor. Single instance lock, payload, app port, Demo seeding, start, readiness and quit |
| `NativeRuntime`     | Actor. Cluster creation, `postgres` and backend processes, roles, PID records, switches |
| `NativeDemo`        | Seed validation, staging restore, count verification, finalize and rollback             |
| `RuntimePayload`    | Payload location, `manifest.json` verification, PostgreSQL and Chrome metadata, tools   |
| `RuntimeFileSystem` | Protocol seams for files, processes, signals, ports, HTTP, clock and randomness (tests) |

### Data directory

Everything lives below `~/Library/Application Support/Vision Native/` (the Demo variant:
`Vision Native Demo/`, see [[docs/architecture/native-app#Variants (phase 1e)|Variants]]). Vision
Native refuses any other application-data directory, and a directory that belongs to the other
variant, and never reads, locks or changes the `Vision` or `Vision Demo` directories. Below `native/<runtimeId>/` the layout is the Electron native runtime's, so a later
phase can switch directories without converting files.

```text
Vision Native/
  settings.json             appPort (persisted random backend port), keepServicesOnQuit
  vision-native.lock        single-instance lock (flock)
  demo-reset-request.json   optional request to restore the canonical seed on next launch
    logs/main.log             lifecycle log, rotated once at 2 MB
  audit-anchor/             key.enc, checkpoint.json (phase 1e, same files as Electron)
  native/vision_native/
    runtime.env             generated credentials (0600)
    runtime-state.json      runtime marker (activeRuntime, demoSeed, pendingDatabaseSwitch)
    backend.pid.json        backend PID record
    postgres.pid.json       PostgreSQL PID record
    logs/backend.log, logs/postgres.log
    postgres/data/          PostgreSQL 18 cluster (0700)
    attachments/, cache/
```

The runtime id is `vision_native`, so the database is `vision_native` and the roles are
`vision_native_admin`, `vision_native_owner` and `vision_native_app`, plus
`vision_analysis_executor`. PostgreSQL listens on `127.0.0.1:54331`, next to Vision (54329),
Vision Demo (54330) and Vision Native Demo (54332, runtime id `vision_native_demo`), so all four
can run at once.

### Payload discovery

The payload (PostgreSQL 18.6, `vision-backend`, `vision-alembic`, Chrome Headless Shell and the
built frontend) is not committed. The supervisor looks for it in this order:

1. `VISION_NATIVE_RUNTIME_DIR`, in Debug builds only: an absolute path to a prepared
   `native-runtime` directory (for example `packaging/electron/native-runtime` or
   `apps/native/build/payload/native-runtime`). A Release build ignores it with a logged warning,
   like `VISION_NATIVE_BACKEND_URL`.
2. `Contents/Resources/runtime/` in the app bundle, which `install-native.sh` stages.

The synthetic seed is the `demo-seed/` sibling of the runtime directory in both cases. A missing
payload fails with `NATIVE_RUNTIME_MISSING`, and the window shows the reason, the install command
and the Retry button. Before any process starts, every file must match `manifest.json` (size and
SHA-256, no unlisted, symlinked or special files), and `postgres/runtime.json` and
`chromium/runtime.json` must pin the expected versions for this platform and architecture.

### Start sequence

`ShellResolver` calls `RuntimeSupervisor.launch()`. Concurrent calls share one launch, and a call
after a failure retries. A failed launch stops the backend it started and leaves PostgreSQL
running, so Retry starts a fresh backend.

1. Take the exclusive lock on `vision-native.lock`. A second instance fails with
   `NATIVE_ALREADY_RUNNING`. Only the instance that holds the lock rotates `main.log`.
2. Locate the payload and resolve the app port: the persisted `appPort`, otherwise a random free
   port from 20000 to 59999 (64 tries, then 3002), persisted to `settings.json`. A corrupt
   `settings.json` is renamed to `settings.json.corrupt-<ms>`.
3. Create the private directories and `runtime.env`, verify the payload and check that every
   PostgreSQL tool reports major 18.
4. Prepare the Demo seed. A seed whose `logicalSha256` and `schemaRevision` match the marker is
   kept. Otherwise the dump is restored into a staging database, its schema head and table counts
   are verified, and it is renamed into place while the previous database is kept for rollback.
   An interrupted switch from an earlier launch is rolled back first.
5. Start the backend. This runs `initdb` once (scram, C locale, data checksums), writes
   `vision.conf`, starts `postgres` on the loopback port with Unix sockets disabled, inspects the
   server (major 18, loopback-only, our data directory), bootstraps the roles, database and
   extensions, then spawns `vision-backend` with the allowlisted environment. A port held by
   another process fails closed. A backend `PORT_COLLISION` re-picks the app port once. A recorded
   backend of ours that does not answer `/health` within three probes is stopped and replaced.
   Electron fails here with `BACKEND_STALE_PID`.
6. After a seed switch, wait for `/health/detailed` to report a connected database, recheck the
   stable counts and finalize the switch. Any failure rolls the switch back.
7. Poll `GET /health/detailed` (20 probes at 100 ms, then every 300 ms, about 3 minutes) and load
   `http://localhost:<appPort>`. A timeout copies the redacted tail of `backend.log` into
   `main.log`.

### Stop sequence

On quit the app delegate answers `terminateLater` and calls `RuntimeSupervisor.shutdown()` with
a 45-second hard limit. Like Electron, the quit does not wait for a launch in progress. It cancels
the launch, which ends a running tool such as `initdb` or `pg_restore`. The runtime then refuses
to spawn PostgreSQL or the backend or to begin a database switch. A Demo staging database
without a persisted switch plan is dropped. A persisted plan is rolled back on the next launch.
Tools run with `Foundation.Process` get `SIGTERM` on timeout or cancellation, then `SIGKILL` after 2
seconds, and their output is read for at most 2 more seconds after exit. When `keepServicesOnQuit` is on (the database setting first, then the
`settings.json` mirror), both processes keep running. Otherwise the backend gets `SIGTERM` and,
after 10 seconds, `SIGKILL`, and PostgreSQL stops with `pg_ctl stop -m fast`. Vision Native
signals a recorded PID only when `ps -o command=` shows its own `vision-backend`, removes stale
records, and treats PIDs of 1 or less as untrusted. On the next launch a backend from an earlier run is
replaced, healthy or not, because the audit bridge token is new on every launch (Electron does the
same when it has an audit token).

Before the shutdown the shell runs the quit-time backup (see
[[docs/architecture/native-app#Backup and restore (phase 1d)|Backup and restore]]) and then ends the
audit session; the 45-second limit covers all of it. Not ported: external PostgreSQL clusters, the Bun source mode and the health watchdog that
restarts a crashed backend.

### Developer override

In Debug builds only, `VISION_NATIVE_BACKEND_URL` skips supervision and loads an already running
backend. The URL must be absolute `http` or `https` with a loopback host (`localhost`,
`127.0.0.1` or `::1`). Any other value, and the variable in a Release build, is ignored with a
logged reason. `BackendHealth.status` then checks `GET <base>/health` before loading. Debug builds
make the web view inspectable with the Safari Web Inspector.

## Shell (phase 1c)

Phase 1c gives the native shell Electron's behaviour. The decisions that do not depend on AppKit or
WebKit live in `Sources/VisionNativeCore/Shell/` and have Swift Testing tests; the files in
`VisionNative/` only apply them.

| File (`VisionNative/`)  | Role                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `VisionNativeApp.swift` | `@main` AppKit entry point and `AppDelegate`: reopen, dock menu, CSV open, quit     |
| `ShellController.swift` | Window, frame persistence, launch flow, menus, dock badge, vibrancy, `BridgeHost`   |
| `WebShell.swift`        | `WKWebView` subclass, navigation, UI and download delegates, script message handler |
| `LaunchStateView.swift` | SwiftUI launch state (splash and error page) and `ShellResolver`                    |
| `MenuBuilder.swift`     | Turns the `ApplicationMenu` model into `NSMenu`s; role items use AppKit's actions   |

### Window and launch state

The app no longer uses a SwiftUI `App` scene, so SwiftUI does not replace the menu bar. One window
opens at Electron's 1280 x 800 with a minimum of 800 x 600, titled with the app name ("Vision Native" or "Vision Native Demo"). It matches
Electron's `titleBarStyle: "hiddenInset"`: full-size content view, transparent title bar and a
hidden title, so the frontend draws its topbar under the traffic lights (the `electron-mac` CSS in
`apps/frontend/src/index.css`). The traffic lights keep AppKit's default position; Electron moves
them to `{ x: 20, y: 20 }`. WebKit has no `-webkit-app-region`, so the user script reports a
mouse-down on `.app-topbar` (outside buttons, links, inputs and combo boxes) and the shell calls
`NSWindow.performDrag(with:)`. A double-click follows the system "double-click a window's title
bar" setting. Native full screen sends `window:fullscreen`.

The frame is saved 500 ms after a move or resize to `windowBounds` in `settings.json`, the key and
top-left screen coordinates Electron uses, and restored clamped to the most overlapping screen's
work area. Closing the window hides it; a dock click shows it again, and only Quit ends the app.

The launch state replaces Electron's data-URL splash and `assets/error.html`. It paints the splash
palette (`deriveSplashPalette`: the persisted `splashTheme`, else a near-black base with the brand
hue) with the Vision mark, a spinner and the localized `splash.*` status for the supervisor phase.
On failure it shows `app.errorPageTitle`, the reason, Open logs and Try again. The window
background and the web view's `underPageBackgroundColor` use the same base colour, and the web view
stays hidden until the page calls `ready()` (or 3 seconds after the document finishes loading), so
there is no white flash on launch. `theme:persist-splash` updates these colours at once.

The native menus and dialogs follow the system appearance, like Electron, which never sets
`nativeTheme.themeSource`. The page applies its own theme. `app:set-vibrancy` shows an
`NSVisualEffectView` (`underWindowBackground`, behind window, following the window's active state)
behind a transparent page, which is Electron's `setVibrancy("under-window")`; from phase 3a its
appearance follows the page palette from `theme:persist-splash` (light or dark), not macOS.

### Preload bridge

A user script injected at document start in the main frame defines the six `window.*` bridges of
`packaging/electron/preload.ts` with the same method names and promise semantics, so the unchanged
frontend detects a desktop shell (`isElectron()` checks `window.electronUpdater`, and
`electronAPI.platform` is `"darwin"`). Methods call
`window.webkit.messageHandlers.visionNative.postMessage(JSON.stringify({ channel, args }))`, a
`WKScriptMessageHandlerWithReply`. The reply is JSON text, or an error message the promise rejects
with. Like `registerHandler`, the shell first checks the sender (the main frame whose security
origin, protocol, host and port, is the backend origin), then refuses malformed messages and
unknown channels, validates the arguments with the rules of `runtime/ipc-schemas.ts` and answers
invalid calls with each channel's `invalidResult`. Messages are limited to 64 KiB once the channel
is known; `backup:run`, which carries the localStorage snapshot, accepts up to 8 MiB, and nothing
larger is parsed. Events reach the page through `window.__visionNativeDispatch`; renderer-bound
events wait until the page calls `ready()`, and a newly committed document clears that state (a
load that turns into a download does not). The script also reports structural `error` and
`unhandledrejection` metadata, like the preload. A Swift Testing test runs the generated script in
JavaScriptCore with a stub message handler.

`BridgeContract.entries` in `Shell/BridgeContract.swift` is the channel to handler table:

| Bridge             | Electron channels                                                                                                             | Vision Native                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `electronUpdater`  | `update:check-github`, `update:install-shell`, `update:pre-update-backup`                                                     | Empty object: no updater (ADR-204 decision 5); direct calls reject      |
| `electronBackup`   | `backup:run`, `select-dir`, `select-file`, `restore`, `is-encrypted`, `get-encryption-status`, `set-passphrase`               | `BackupService` and AppKit panels (phase 1d)                            |
| `electronBackup`   | `backup:save-settings`, `backup:load-settings`                                                                                | `backup_settings` database setting, mirrored to `settings.json`         |
| `electronAudit`    | `audit:enroll`, `read`, `export`, `transfer-export`, `transfer-import`, `rotate-key`                                          | `AuditChannels` over the audit anchor and backend bridge (phase 1e)     |
| `electronServices` | `services:save-settings`, `services:load-settings`                                                                            | Database setting with baseline writes, mirrored to `settings.json`      |
| `electronRecovery` | `recovery:retry`, `recovery:open-logs`                                                                                        | Relaunch through the supervisor; open `native/vision_native/logs`       |
| `electronAPI`      | `app:renderer-ready`, `app:set-badge`, `app:set-language`, `app:set-vibrancy`, `app:get-accent-color`, `theme:persist-splash` | Implemented (queue flush, dock badge, menus, material, accent, palette) |
| (user script)      | `app:renderer-failure`                                                                                                        | Logged as kind, name, source file and line only                         |
| (Vision Native)    | `native:window-drag`, `native:window-titlebar-double-click`                                                                   | Topbar drag region                                                      |
| `electronAPI`      | `shell:route-changed` (`routeChanged(route)`, Vision Native only)                                                             | The native sidebar's route (phase 2)                                    |

The backup settings use the same baseline writes and `settings.json` mirror (`backupDir`,
`backupOnQuit`) as the services settings, and `save-settings` refuses system directories like
`validateBackupDest`, so Settings > Backup keeps its directory and on-quit toggle. Without a
configured directory, `load-settings` answers the iCloud Drive default like
`resolveBackupSettingsWithDefaults`, and the quit-time backup reads the database value, else the
mirror.

`electronAPI` also carries `nativeNavigation: true`, which Electron never defines. The page then
leaves out its own sidebar and reports `pathname + search` with `routeChanged` (see
[[docs/architecture/native-app#Native navigation and screens (phase 2)|phase 2]]).

Events: `menu:action`, `app:csv-opened` (a CSV opened with the app, at most 25 MiB, while
`app_settings` is not read yet; afterwards the native Import & export card takes it),
`window:fullscreen` and `app:accent-color-changed` (on `AppleColorPreferencesChangedNotification`)
are sent. `backend:lost` and `backend:restored` can be subscribed to but never fire, because the
health watchdog is not ported yet.

### Navigation, new windows and downloads

`NavigationPolicy` mirrors `will-frame-navigate`, `will-redirect` and `setWindowOpenHandler`:

- A frame may load only the backend origin (scheme, host and port, no credentials). Subframes may
  also load `about:blank` and `about:srcdoc`.
- The two trusted links (`ShellLinks.repository` and `documentation`, Electron's
  `TRUSTED_EXTERNAL_URLS`) open in the default browser through `NSWorkspace`, compared as exact
  strings. Everything else is cancelled and logged with its scheme and host only.
- `window.open` and `target="_blank"` never create a web view: trusted links open in the browser,
  everything else is denied.
- `<a download>` of a `blob:` URL from the app origin, a `data:` URL or an app URL, and app
  responses sent as attachments or of a type WebKit cannot show, become a `WKDownload`. A save
  panel opens in Downloads with the suggested name, Electron's default download behaviour. When
  the chosen file exists, the download writes a hidden temporary file next to it and replaces the
  file only when it finished; a failed download leaves the old file. A folder is never replaced.
- A main-frame response that WebKit would show must come from the backend origin.
- `<input type="file">` opens an `NSOpenPanel`. Camera and microphone requests are denied.
- When the web content process terminates, the shell reloads the page, at most twice within 30
  seconds (`CrashReloadPolicy`); after that it shows the launch error page, whose Try again starts
  afresh.

### Menus and dock

`ApplicationMenu` builds Electron's macOS menu: the app menu (About, Settings… `⌘,`, Services, Hide,
Hide Others, Show All, Quit; no update check), File (New transaction `⌘N`, Import CSV… `⇧⌘I`, Close
Window), Edit, View (Toggle Sidebar `⌃⌘S`, Appearance with the four theme modes, Reload, Actual
Size, Zoom In `⌘+` with a hidden `⌘=` alternate, Zoom Out, Toggle Full Screen `⌃⌘F`), Go (`⌘1` to `⌘9` from `GO_MENU_ROUTES`),
Window and Help (Keyboard Shortcuts, Source Code, Documentation). Labels that Electron passes to
`t()` use the same keys from `i18n/source/en.json` and `nl.json`, which a build phase copies to
`Contents/Resources/i18n/`; role items keep Electron's English labels. `app:set-language` reloads
the strings, persists `nativeLanguage` and rebuilds the menus. Items that act in the page send
`menu:action` through the bridge, showing the window first. From phase 2, Toggle Sidebar hides and
shows the native sidebar instead of the page's. The Toggle Developer Tools item is
left out: Debug builds are inspectable from Safari's Develop menu.

The dock menu has New transaction and Home. `app:set-badge` sets the dock badge to the planned-
payment count (0 clears it), like `app.dock.setBadge`. Electron shows no dock progress, so neither
does Vision Native. The PNG of `badge-image.ts` is the Windows overlay icon and is not needed.

### Runtime checks on a Mac

CI builds and unit-tests the shell but cannot drive WebKit. Check these by hand on the first Mac
run:

- Blob exports: `apps/frontend/src/lib/downloadBlob.ts` revokes the object URL immediately after
  the click. WebKit may need a delayed `revokeObjectURL`; that frontend change waits for this test.
- Topbar drag: `performDrag(with:)` from the bridge message still moves the window, and the
  mouse-up reaches the page afterwards (no stuck pressed state).
- Clicks under the transparent title bar reach the page's topbar controls.
- The web view's context menu: its Download Image and Download Linked File items go through the
  download policy and save panel. Trimming that menu is not planned for phase 1c.

### Left for later phases

The pre-update backup has no counterpart because there is no updater. Still missing: the health
watchdog and `backend:lost`/`backend:restored`, the renderer-ready watchdog that reloads and shows
the error page, the production security headers of `registerSecurityHeaders`, the text context
menu with spelling suggestions, Electron's traffic-light position, zoom persistence and JavaScript
`alert`/`confirm` panels, which the frontend does not use.

## Backup and restore (phase 1d)

Phase 1d answers the `electronBackup` channels with `BackupService` in
`Sources/VisionNativeCore/Backup/`. It follows `packaging/electron/backup/` (`bundle.ts`,
`crypto.ts`, `restore.ts`) and the backup handlers of `main.ts`, uses no third-party package and
has no AppKit dependency. The app target adds only the folder and file pickers (`NSOpenPanel`) and
the restore confirmation (`NSAlert`, Cancel as the default button).

### Format compatibility

A bundle is a zip archive named `vision_backup_<deviceId>_<YYYY-MM-DD_HH-MM-SS>.visionbak`
with `metadata.json` (Electron's field order), `db.sql` (`pg_dump --format=plain`), the
`attachments/` tree and an optional `frontend-state.json`. It is written as `<name>.partial` and
renamed when complete. Files read and written by Vision Native and Electron Vision are
interchangeable:

| Piece            | Implementation                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Zip              | `ZipArchive.swift`: streaming writer and reader, deflate through the Compression framework, zip64, CRC-32 checks |
| v2 encryption    | `VISIONBAK2`, 16-byte salt, 12-byte nonce, AES-256-GCM, 16-byte tag; key `scrypt(N=2^15, r=8, p=1)`              |
| v1 decryption    | `VISIONBAK1`, 16-byte IV, AES-256-CBC; key `scrypt(N=2^14, r=8, p=1)` with the salt `vision-backup-v1`           |
| Legacy SQL files | `.sql` and `.sql.enc` (`VISIONENC1` / `VISIONENC2`) restore as database-only backups                             |
| Key derivation   | `Scrypt.swift`, checked against the RFC 7914 vectors                                                             |

New bundles are always v2. AES-GCM is streamed (CommonCrypto AES-CTR plus GHASH), so a
large bundle is never held in memory; tests compare it with CryptoKit and with files written by
Node. The test resources carry the Electron Vision 1.0.2 fixture
(`packaging/electron/backup/fixtures/vision-1.0.2-sanitized.visionbak.enc`) byte for byte, and a
test opens it. Extraction refuses absolute and `..` entry names and stops beyond 10 GiB of output
or 100,000 entries. The v1 salt is Electron Vision's (`vision-backup-v1`, from the app name
"Vision"); legacy files written by Vision Demo, whose salt differs, are out of scope.

### Passphrase

`VISION_BACKUP_PASSPHRASE` wins, as in Electron. Otherwise the passphrase is a generic password in
the login Keychain with the service `com.vaultvoyager.vision-native.backup-passphrase` (Demo:
`com.vaultvoyager.vision-native-demo.backup-passphrase`) and the backup device id as the account (`KeychainPassphraseStore` behind the `PassphraseStore` protocol).
Vision Native never writes Electron's `backupPassphraseEncrypted` field. An empty passphrase
removes the item. Without a passphrase a backup is written unencrypted with Electron's warning.
A failed Keychain write answers `available: true` with the error, like a failed `safeStorage`
write. The item belongs to the app's code signature: after an ad-hoc or otherwise unsigned
rebuild, macOS can ask for the login password before the new build may read it.

### Device id, directory and retention

The device id is Electron's (the first 8 hex digits of SHA-1 over `darwin|arch|hostname|userData`),
persisted once as `backupDeviceId` in `settings.json`. Without a configured directory the default
is `~/Library/Mobile Documents/com~apple~CloudDocs/Vision Native/Backups` (Demo: `Vision Native
Demo/Backups`) when iCloud Drive exists, and the quit-time backup is then on. The folder is
deliberately `Vision Native`, not Electron's `Vision`, so the two apps' backups and retention never
mix. Retention keeps the newest seven backups of this device and
removes older ones, and `.partial` leftovers, only when they are more than 10 minutes old.

### Restore

`backup:is-encrypted` and `backup:restore` accept only a path the restore picker returned
(`RestorePathAllowList`, Electron's `ALLOWED_RESTORE_PATHS`) with a `.visionbak`,
`.visionbak.enc`, `.enc` or `.sql` extension; the picker offers a "Vision Backup" and an
"All Files" filter. After the confirmation, the bundle is decrypted and extracted into a private
temporary directory, and a bundle from a newer schema is refused with `BUNDLE_SCHEMA_NEWER`. The
current schema is the live database's Alembic head, else the newest revision file in the
payload's `alembic/versions` (Electron's `getLocalMigrationChainHead`). When neither is known, a
backup with a numbered revision is refused with `SCHEMA_UNKNOWN` instead of restoring unchecked,
which is stricter than Electron. Only one restore runs at a time, and `backup:run` and the
quit-time backup are refused while it runs. Then, as in `restoreNativeBundle`:

1. `psql --single-transaction` restores `db.sql` into a staging database, which is validated and
   switched in with the persisted `pendingDatabaseSwitch` token (the Demo seeding switch).
2. The attachment tree is copied next to the live one, verified by fingerprint and swapped in;
   the previous tree is kept and the token persisted as `pendingAttachmentSwitch`.
3. The backend starts and must pass `/health/detailed`; then the database switch is finalized.
4. Removing the previous attachment tree is cleanup; a failure there is a warning.

A failure before step 3 completes rolls back the attachments, then the database, then restarts the
backend (unless the database switch could not be recovered). Errors keep Electron's
`"Error: <message>"` form, so the frontend's `PASSPHRASE_REQUIRED` and `INVALID_PASSPHRASE`
checks reopen the passphrase prompt.

A launch after a quit or crash during a restore settles `pendingAttachmentSwitch` before the
backend starts. If `pendingDatabaseSwitch` is still persisted, the previous attachment tree goes
back and the database switch then rolls back. Otherwise the restore had committed: the restored
tree stays and the previous one is removed.

Audit continuity (phase 1e) follows `restoreWithAuditRecovery` in `runtime/native.ts`: the restore
pauses the audit closure before it stops the backend and resumes it afterwards, also after a
failure. Once the restored backend is healthy, `assertRestoredAuditHistory` must accept the
restored history before the database switch is finalized; otherwise the restore rolls back. When
the audit check fails with a recoverable code and the rollback succeeded, a second `NSAlert` asks
whether to restore without audit verification. Accepting restores again, ends the audit session
and adds `auditStatus: "unavailable"` to the result; declining fails with "Restore cancelled by
user". See [[docs/architecture/native-app#Audit anchor and Keychain witness (phase 1e)|Audit
anchor]].

### Quit-time backup

`ShellController.prepareForQuit` runs the backup before `RuntimeSupervisor.shutdown()` when the
effective settings enable it and the runtime is running. It writes a bundle without frontend state.
A backup already in progress is awaited instead of starting a second one. The app delegate's
45-second hard limit, Electron's will-quit timeout, covers the backup and the shutdown together.
Failures are logged to the unified log; there are no OS notifications yet.

## Audit anchor and Keychain witness (phase 1e)

Phase 1e answers the `electronAudit` channels. `Sources/VisionNativeCore/Audit/` ports
`packaging/electron/audit-anchor.ts`, the audit half of `runtime/native.ts` and `audit-viewer.ts`
([[docs/adr/156-forward-only-audit-chain-foundation|ADR-156]] to
[[docs/adr/162-one-year-audit-retention|ADR-162]]). It has no AppKit dependency; the app
target adds only the confirmations (`NSAlert`), the save and open panels and the notice sheet.

| Type                      | Role                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `AuditAnchor`             | Actor. Receipt, HMAC, enrol, rotate, retention boundary, legacy cutover, transfer export and import    |
| `AuditReceipt`            | Receipt fields, the signed bytes, `receiptHash` and `receiptId`, parsed and checked as Electron does   |
| `KeychainAuditWitness`    | The witness item through the Security framework; no helper process                                     |
| `NativeAuditKeyProtector` | Protects the 32-byte HMAC key (`vn1`) under a Keychain wrapping key; reads Electron's `v10` on request |
| `AuditRuntime`            | Actor. Verification, enrolment, verified reads, live closure, retention, transfer, restore checks      |
| `URLSessionAuditBridge`   | `POST /api/internal/audit/<endpoint>` with the bridge token                                            |
| `AuditChannels`           | The six channels with Electron's result shapes, the 30-second closure timer and the audit notices      |
| `AuditViewer`             | The read range and the snapshot export of `audit-viewer.ts`                                            |

### Format compatibility

The files are Electron's, in the same place: `<userData>/audit-anchor/checkpoint.json` and
`key.enc`, written atomically with mode 0600. The receipt (`macos_keychain_witness_hmac_v3`,
version 3) is signed with HMAC-SHA256 over the same JSON array of version, key id, sequence, hash,
legacy cutover, creation time and the optional enrolment sequence and retention boundary; the
receipt hash is SHA-256 of those bytes and the MAC, and the receipt id is
`<keyId>:<sequence>[:<retention through>]`. The transfer file (`.vat`) is Electron's envelope:
scrypt (N = 32768, r = 8, p = 1), AES-256-GCM with the additional data `vision-audit-transfer-v1`,
and a password of 16 to 1,024 characters. An interrupted transfer import is recovered from
`checkpoint.before-transfer.json` and `key.before-transfer.enc` at the next start, as in Electron.

The tests read a receipt, key, witness value and transfer that `audit-anchor.ts` wrote with a fake
`safeStorage` and witness (`Tests/VisionNativeCoreTests/Fixtures/audit/`, made by
`packaging/electron/scripts/native-audit-fixture.ts`; its README says how), and CI checks the
other direction (see [[docs/architecture/native-app#CI|CI]]).

### Key protection and witness

Electron protects the HMAC key with `safeStorage` (`v10`, AES-128-CBC under the "Vision Safe
Storage" password). Vision Native cannot use that item, which belongs to Electron's signature, so
it writes `key.enc` as `vn1` + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag (additional
authenticated data `vision-native-audit-key-v1`), under a random
256-bit wrapping key in the login Keychain (service `com.vaultvoyager.vision-native.audit-key`,
account `audit-anchor-key`). A Keychain error or a denied access prompt on that item is
`secure_storage_unavailable`, the code Electron gives a failing `safeStorage`; the protector cannot
probe availability without a Keychain read that may prompt, so it reports itself available and the
first real use decides. The prefix tells the two encodings apart, and
`ElectronSafeStorage` reads a `v10` value when it is given the Safe Storage password, which only a
phase 4 migration would do. Trade-off: the key file and the wrapping key are separate secrets, as
with `safeStorage`; the receipt format does not change.

The witness is a generic password with the service `com.vaultvoyager.vision-native.audit-witness`
(Demo: `com.vaultvoyager.vision-native-demo.audit-witness`) and the account `latest-checkpoint`,
holding the same JSON value as Electron's (version, key id, sequence, hash, receipt hash), at most
8 KiB. Errors keep Electron's vocabulary: `audit_witness_unavailable`, `audit_witness_invalid` and
`audit_witness_already_exists`; a missing item reads as no witness. Electron Vision's witness is
`com.vaultvoyager.vision.audit-witness`; [[docs/adr/205-vision-native-hand-over|ADR-205]] lists
the phase 4 migration.

### Backend bridge and lifecycle

Each launch draws a 32-byte random token, passes it to the backend as `VISION_AUDIT_BRIDGE_TOKEN`
(64 lowercase hex characters, checked by `NativeRuntime`) and sends it as a bearer token to
`/api/internal/audit/*`. A backend left running from an earlier launch has the old token, so it is
replaced (see [[docs/architecture/native-app#Stop sequence|Stop sequence]]). When the runtime is
ready, the shell verifies the history before the page loads, closes the checkpoint every 30 seconds
while the window lives, runs retention at most once a day and ends the session at quit. A status
other than verified is logged and shown once as a sheet on the window; Electron posts an OS
notification instead.

### Differences from Electron

- `key.enc` is `vn1` under a Keychain wrapping key, not `safeStorage` (`v10`).
- A Keychain failure on the wrapping key is `secure_storage_unavailable` everywhere. Electron gives
  `key_unavailable` when `safeStorage.decryptString` fails while loading the anchor and
  `transfer_import_incomplete` when `encryptString` fails during a transfer import; a denied
  Keychain prompt leaves the key intact, so Vision Native does not report it as lost.
- An imported transfer's receipt is rewritten in canonical field order, and transferred receipts
  are checked in that order, which is stricter than Electron's check of the raw object.
- The snapshot export sorts nested object keys.
- No update decision is recorded, because there is no updater.
- A Demo reset on an enrolled Demo cluster replaces the history under the anchor, so the next
  verification fails, as in Electron Vision Demo.

## Variants (phase 1e)

One app target builds two variants. The build setting `VISION_NATIVE_VARIANT` (`standard` or
`demo`) picks the product name and bundle identifier in `project.yml` and is copied into
`Info.plist` as `VisionNativeVariant`; `NativeVariant.fromInfoPlist` reads it at launch, and a
missing or unknown value is the standard variant. A second XcodeGen target was rejected: one target
keeps one CI build, and Electron's `resources/DEMO` marker would need a copy step for the same
result.

| Variant    | App                      | Bundle id                             | Data directory                           | Runtime id           | PostgreSQL |
| ---------- | ------------------------ | ------------------------------------- | ---------------------------------------- | -------------------- | ---------- |
| `standard` | `Vision Native.app`      | `com.vaultvoyager.vision-native`      | `Application Support/Vision Native`      | `vision_native`      | 54331      |
| `demo`     | `Vision Native Demo.app` | `com.vaultvoyager.vision-native-demo` | `Application Support/Vision Native Demo` | `vision_native_demo` | 54332      |

The Keychain services (backup passphrase, audit witness, audit key) use the runtime id with
hyphens, for example `com.vaultvoyager.vision-native-demo.backup-passphrase`. The iCloud backup
folder follows the app name (`Vision Native Demo/Backups`). Both variants seed the synthetic Demo
dataset on first launch and when the seed changes, and neither has an updater, so the standard
variant holds no real data until the phase 4 switch-over (ADR-204 decision 1).
`install-native.sh` builds the Demo variant unless `VISION_NATIVE_VARIANT=standard`; a plain Xcode
or CI build is the standard variant.

The Demo reset follows `native-demo.ts`: `bun run demo:reset-vision-native` writes
`demo-reset-request.json` into `Vision Native Demo/`, and the next launch restores the canonical
seed. `native-demo-cli.js reset --execute --target vision-native` targets the standard variant;
`bun run demo:reset-native` still targets Electron's Vision Demo. Electron Vision Demo has no reset
action in the app, so Vision Native has none either.

## Native navigation and screens (phase 2)

Phase 2 lays the foundations for native screens: four generators turn the existing sources of truth
into Swift, a native sidebar replaces the web sidebar, and one screen, Exchange rates, is drawn in
SwiftUI. Every other route still shows the web app.

### Generated sources

`bun run native:generate` runs the four generators; CI's Verify Generated Artifacts job reruns it
and fails when `apps/native/` changes. The outputs are committed.

| Script                            | Inputs                                                        | Output                                                         |
| --------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| `scripts/native-openapi.ts`       | `openapi.yaml`, `apps/native/openapi-operations.txt`          | `Sources/VisionNativeCore/API/Generated/` (models, operations) |
| `scripts/native-design-tokens.ts` | `styles/tokens.css`, `styles/skin-v2.css`, `styles/themes.ts` | `Sources/VisionNativeCore/Design/Generated/DesignTokens.swift` |
| `scripts/native-strings.ts`       | `i18n/source/{en,nl}.json`, `apps/native/i18n-keys.txt`       | `Sources/VisionNativeUI/Resources/Localizable.xcstrings`       |
| `scripts/native-navigation.ts`    | `apps/frontend/src/lib/navigation.ts`                         | `Sources/VisionNativeCore/Navigation/Generated/`               |

The OpenAPI generator emits one `APIOperation` struct per allow-listed operationId and the
component schemas they reach, plus the ADR-026 `Envelope` and `ErrorPayload`. Numbers become
`Decimal`, dates stay strings, and an untyped schema becomes `JSONValue`. An operation whose
response is a bare envelope decodes its `data` as `JSONValue`, so typing the response in
`openapi.yaml` is how a native screen gets a model. The token generator resolves the cascade the
browser applies: a variant's inline palette from `themes.ts`, then `--gain`/`--loss` from
`tokens.css` (classic) and `skin-v2.css` (colorblind-safe). The navigation generator maps each
Lucide icon to an SF Symbol and fails on an icon without one or a label key missing from
`i18n-keys.txt`.

### API client

`APIClient` is the Swift `apiRequest` of `apps/frontend/src/lib/api/client.ts`: the same
`Content-Type` and `X-Request-Id` headers (one id for every attempt), ADR-026 envelope unwrapping,
`ApiClientError` from the failure envelope with the status fallback codes, `ApiContractError` for a
body that does not decode (paths and problems only, never values), a 30-second timeout and two
retries of idempotent methods on 408, 429, 502, 503 and 504, timeouts and network errors, with
500 ms × 2^n backoff plus up to 200 ms of jitter. Validation, rate-limit, auth, not-found and
conflict errors are not retried. The transport is a protocol; the app uses an ephemeral
`URLSession`, and the tests use a fake.

The admin token stays where the web app keeps it, in the page's `sessionStorage`
(`vision.adminToken`), never in `settings.json` or the Keychain. Before a request the client reads
it from the web view with `callAsyncJavaScript` and sends it as `Authorization: Bearer`; a page
that does not answer within 5 seconds gives no token. Without a token, as in a fresh session, the backend's loopback allowlist decides, exactly as for the web app
in the same window.

### Theme and strings

`ThemeSelection.resolve` recovers the page's theme from the `splashTheme` it persists
(`theme:persist-splash`): the resolved mode, and the variant whose `--background` and
`--foreground` match. `VisionNativeUI` exposes it to SwiftUI as the `visionTheme` environment
value, together with `Color(token:)`; the colorblind skin follows `app_settings`. The sidebar and
native screens take the page's appearance; the web view keeps following the system, as before.

`CatalogStrings` is the native `t()`: it reads the compiled String Catalog of `VisionNativeUI`
for the page's language (`app:set-language`), fills every `{name}` placeholder and falls back to
the key. `tc(key, count)` is the web's plural `tc`: it reads the flat `key.one` and `key.other`
entries of `i18n/source` (listed in `i18n-keys.txt` like any other key) for the CLDR category of
the count in English or Dutch, then falls back to `key.other` and `key`. A test checks every listed
key in both languages against `i18n/source`.

### Navigation shell

`ShellRootView` is a `NavigationSplitView` hosted in the window in place of the bare web view. The
sidebar is a list built from `NavigationRegistry`: the sections of `NAV_SECTIONS` with
collapsible headers (hidden sections are stored per Mac, and a section that holds the active page
opens), the admin section in admin mode only, and the footer entries with Settings, which opens the
page's settings dialog. The detail column shows the native screen for the route, or the web view,
which stays in the hierarchy so the page keeps its state.

The shell looks like the web sidebar (`ShellGlass`, phase 3a): the sidebar column is a
behind-window sidebar material under the `.glass-chrome` gradient of `--sidebar-background`
(0.55 to 0.72, dark 0.74), with the `--glass-highlight` top line and the `--sidebar-border` rail
edge, and the active row gets the emerald `--primary` pill (0.12, dark 0.16) and primary icons
instead of the system selection highlight. The sidebar stays a `List(selection:)`, so the arrow
keys move through it; the clear selection tint hides the system highlight and selecting a row goes
through `navigate`, like a click. Native screens sit on a behind-window material tinted with the
page's `--background`, with opaque cards on top, in every theme variant. Every material takes the
page theme's light or dark appearance, not the macOS one.

The web router stays the source of truth. `AppLayout` reports `pathname + search` through
`electronAPI.routeChanged` (`shell:route-changed`, validated as an app-relative route of at most
2 KiB, with the query read like `URLSearchParams`, so a malformed percent-escape stays as written).
A sidebar click or a native shortcut only sends the `navigate` menu action; the route, the detail
column and the sidebar selection change when the page reports the new route, so an unsaved-changes
prompt opens on the visible page and a blocked move keeps the route. A native screen with unsaved
work registers a `NativeLeaveGuard` instead (phase 3b): while it reports changes, `navigate` holds
a move to another path behind the Leave this page? alert (`unsavedChanges.*`), whose Stay on page
cancels it and Leave and discard drops the work and sends it. Sidebar clicks, native links and
shortcuts, and the menu bar's Go items all pass through `navigate`. Quit asks too: while the guard
reports changes, `applicationShouldTerminate` shows the same alert as an `NSAlert` and quits only on
Leave and discard. A move the page makes on its own (the command palette) is not held. A native `?tab` change sends
`replace-route`, which the page applies with `replace`, like `useTabParam`; the page accepts
`navigate` and `replace-route` payloads that start with one `/` only. `replaceQuery` with no value
removes the parameter, like `useSearchParamState` writing its default.

`app_settings` is read again when the page reports a new path and when the settings dialog closes
(`?settings` removed), plus once more 600 ms after that close, because the page saves its settings
500 ms after a change. Admin mode, the default currency and number and date formats follow the page
that way. Every native screen waits for the first `app_settings` answer and shows the web view until
then. The native shell never redirects: an admin route shows a native screen only while
`app_settings` says admin mode is on, and otherwise the web view, where `RequireAdmin` redirects and
reports the new route. Screens outside the admin section (`/planned`, `/import`,
`/import/:batchId/review`, `/transactions`, `/owes`, `/accounts`, `/accounts/:id`, `/categories`,
`/recipients`, `/`, `/statistics`, `/tax`, `/portfolio`, its five asset pages,
`/portfolio/rebalance`, `/portfolio/net-worth`) are native in
either mode. The page's topbar keeps its traffic-light inset only while the native sidebar is
hidden (`native-sidebar`).

The command palette and the shortcuts stay the page's. On a native screen, which takes the key
events, `NativeShortcuts` handles the same keys: ⌘K sends `open-palette`, `?` opens the shortcuts
overlay, `g` then a key, `[`, `]` and `N` navigate. Opening a page dialog (palette, settings,
shortcuts) shows the web view at the same route until the route changes or the dialog closes:
settings close by removing `?settings`, and when the palette or the shortcuts overlay closes the
page reports its unchanged route again.

### Admin screens (phase 3a)

`/admin`, `/admin/providers` and `/admin/endpoints` are native in admin mode
([[docs/reference/native-parity/admin|admin parity]]); phase 3b adds the database pages (below).
`AdminScreens` holds their models over one `AdminService` (the five admin operations
of the generated client); `ScreenQuery` mirrors one React Query query (data and error kept side by
side, stale time, one request at a time) and `AdminErrorState` the page's auth alert, whose link
navigates to `/admin`. The overview's tiles keep the web thresholds and link to their pages. Its
admin token card writes the page's own `sessionStorage` (`vision.adminToken`) through
`callAsyncJavaScript` with the token as an argument, so the web admin pages and the native client
share one token and nothing else stores it; a write the page does not confirm within 5 seconds
toasts `apiError.unknown` instead of the saved or cleared notice. The typed token and the audit
transfer password are cleared when the overview disappears. The audit history card calls
`AuditChannels` directly, so its confirmations, save and open panels and notices are the phase 1e
ones. A probe on Data sources cancels a provider fetch in flight and fetches again, and marks the
overview's provider query stale.

### Database screens (phase 3b)

`/admin/db` and `/admin/db/:table` are native in admin mode
([[docs/reference/native-parity/admin|admin parity]],
[[docs/adr/101-db-data-editor|ADR-101]]). `NativeScreen.tableEditor` carries the decoded table
name of the route. `DatabaseScreens` holds their models over one `DatabaseAdminService` (the
stats, vacuum, schema, rows and mutate operations of the generated client).
`DatabaseMaintenanceModel` keeps the 30-second stats query, runs one vacuum at a time without a
confirmation and refetches after it; a vacuum or a refresh marks the overview's database tile
stale. `TableDataEditorModel` loads the schema once and pages the rows by cursor (100 per page,
the previous page stays on screen while the next loads), sorts and filters with `contains`
filters, and stages edits, deletions and new rows; Preview SQL runs the dry run (an answer without
`dryRun: true` counts as a failed preview) and the Review pending changes sheet commits exactly the
previewed change list in one transaction, then reloads the page. While the dry run or the sheet is
open, cell edits, Add row, Discard, the row menus and Refresh are disabled; a list that no longer
matches the preview closes the sheet and asks for a new one. Refresh also waits while changes are
pending, since a reload could move the staged rows' `__xmin`. The
editor registers the shell's leave guard while it has pending changes. When the page itself moves
away (the command palette), pending changes stay with that table's editor until they are
discarded; without pending changes the editor is dropped with the route, so a table opens fresh.
Unlike the web page, cells of a table without a primary key are not editable, since such edits
never produce a change.

### Exchange rates

`/admin/exchange-rates` is the first native screen
([[docs/reference/native-parity/admin|admin parity]]). `ExchangeRatesModel` mirrors
`useExchangeRatesQuery` (`db_only=true`, 10-minute stale time, one request at a time) and the
refresh mutation (toast, then refetch); `ExchangeRatesPresentation` produces the summary cards and
tables with the web's formats through `VisionFormat` (six and four fraction digits, money with the
`showDecimalPlaces` setting, `Intl`-compatible locales of the four number formats, the five app date
formats and a two-digit local time). The Live/Fallback tab lives in `?tab`.

### Planned payments (phase 3c)

`/planned` is the first native screen outside the admin section and does not need admin mode
([[docs/reference/native-parity/planned-payments|planned payments parity]],
[[docs/adr/183-remaining-screens-redesign|ADR-183]]). `PlannedPaymentsModel` keeps one list per
`show_all` value like the web query key (30-second stale time, one request at a time, a failed
answer is never fresh) and maps rows with `PlannedPayment` (`mapFromAPI`, the default currency from
`app_settings`). The Next 7 days strip (`PlannedStrip`, eight local days) and Estimated monthly
convert to the default currency through the shared `ExchangeRatesModel`, so the screen and Exchange
rates share one rates cache; a payment without a rate is counted, not summed. Money stays
`Decimal`. The table (`LocalDataTable` with `LocalTableQuery`) searches, filters and sorts the raw
row fields like `VirtualDataTable`. Pause and Resume write the server's row into the cached list
and offer Undo for 8 seconds (⌘Z while the toast shows); Delete asks in an alert first. Payment
history looks up every execution's transaction in parallel and offers Retry after a partial
failure. View › Include paused writes `?show_all=true` with `replace-route`.

Phase 3c part B adds the rest of the page. Add payment, a strip item and the row menu's Edit open the
planned-payment sheet (`PlannedPaymentFormModel`, `PlannedPaymentFormSheet`). It has every field of
the web form, `parseLocaleNumber` amounts in the app number format and the web's validation:
errors show after a blocked submit, which scrolls to and focuses the first invalid field. Create
sends `POST`; an edit sends a `PATCH` body (`PlannedPaymentPatch`) that can carry the explicit
`null` the web sends for a cleared End date or Max occurrences. While the sheet holds edits, the
model's leave guard makes the shell ask before leaving `/planned`. Mark as paid and the match
suggestions' Review open `PlannedLinkModel`: debounced candidate fetches (the payee's merge-cluster
root when known), the local search and amount match, and `POST …/execute` with the chosen
transaction's date. `PlannedRecurringModel` drives the recurring panel. It keeps the 5-minute
pattern cache and merges the dismissed payees of the `dismissed_recurring_patterns` setting with a
per-device copy in user defaults. A dismissal saves both; the setting is written against the
baseline of its last read. Track creates the planned payment directly. The shared pickers live in
`VisionNativeUI/Components` over `PickerDataModel`: `VisionDateField` (typed date, calendar, Clear),
`RecipientPicker`, `CategoryPicker`, `AccountPicker` and `TagField`. Every model that a view's
`.task` loads shares one request in flight, so a second caller waits for the first.

### Import & export (phase 3d)

`/import` and `/import/:batchId/review` are native without admin mode
([[docs/reference/native-parity/imports|imports parity]], [[docs/api/imports|imports API]]): the
commit receipt, the bank import card, Import history, the export card, Setup and reference and the
Review import screen (`ImportRoutes.reviewIsNative`). The export card downloads the raw body through
`APIClient.download` and hands it to `TransactionExportModel.save`, which the app target implements
with an `NSSavePanel`. The review model (`ImportReviewModel`) sends one override request per row
when a group's payee or category changes, then reloads the preview; Commit and Discard replace the
route with `/import` (`NativeShellModel.replace(with:)`) and the commit hands its receipt to
`ImportsModel.showCommitReceipt`. One `ImportNoticeCenter` stacks the toasts of both pages. `ImportsModel` loads the built-in adapters once, the saved
parsers (one-minute stale time) and the history pages (ten per page, 30-second stale time), each
with one request in flight. A built-in bank streams `POST /api/import/csv/stream` through
`APIClient.streamEvents`: a hand-written `multipart/form-data` body (`MultipartFormData`), the
response read as Server-Sent Events (`ServerSentEventParser`, the web's `readSseFrames`) over the
`APIStreamTransport` seam, and Cancel cancels the task, which closes the connection. A custom or
saved parser posts one `POST /api/import/csv/custom` (`ImportCsvCustomRequest`). The generator
writes JSON bodies only, so these two and the payee and category imports stay hand-written, as
do the review's preview, override and commit requests (the override body sends an explicit `null`).
`CSVPreview` reads the detected columns and sample rows from the first 16 KB of the file on the
Mac, like `useCsvPreview`. A batch that needs review navigates to its review route without the
Leave this page? alert; when the import finishes after the user left `/import`, the shell stays
where it is and an Awaiting review toast offers Resume review instead. A chosen file or an unsaved
parser edit otherwise registers the shell's leave guard. A CSV opened from Finder or the dock or
dropped on a native screen goes to `NativeShellModel.openImportFile`, which pre-fills the native
card within 30 seconds (after a running import ends) and moves to `/import`; before `app_settings`
is read the web page also gets the file as `app:csv-opened` and does the navigation, so a cold
launch keeps the file whichever side draws `/import`. The import never starts by itself.

### Transactions (phase 3e)

`/transactions` is native without admin mode
([[docs/reference/native-parity/transactions-and-splits|transactions parity]],
[[docs/api/transactions|transactions API]], [[docs/api/attachments|attachments API]]). The URL is
the source of truth, as on the web: `TransactionFilters` reads the filters from the route, filter
controls push a new route through the shell, and search and sort replace the query
(`NativeShellModel.replaceQuery`). `TransactionsModel` loads pages of `defaultPageSize` rows
(`app_settings`, 50 by default) with one request in flight per query and drops answers for an
older query; the next page loads when one of the last rows appears. Column filters stay
client-side over the loaded rows, and column visibility is kept under `transactionsColumns` in the
`widget_visibility` setting against the baseline of its last read. Row edits,
category and payee picks and the Status toggle patch the row first and roll back when the `PATCH`
fails (`TransactionPatch` sends explicit `null`s). Delete asks first, removes the row and offers
Undo for 8 seconds, which recreates the transaction. The inspector (`TransactionInspectorModel`)
docks beside the list from a 1024-point page width and is a sheet below it, which then presents
the Split dialog, the Delete alert and the Add sheet over itself; its tips call the
bulk update for the payee's uncategorised rows (Use for all) and set the payee's default category
(Always use). The Attachments panel (`TransactionAttachmentsModel`) uploads one multipart file,
previews with Quick Look from a temporary file and saves downloads through the export save panel.
`id` in the URL opens the inspector for that row, and `new=1` opens the Add sheet and is removed
with replace. `⌘N`, the dock menu and `N` open the sheet in place on `/transactions`, or move there
without `new=1` and open it on arrival, so the hidden web page does not open its own sheet too.

Phase 3e part B adds the rest. The Add transaction sheet (`AddTransactionModel`) records an
expense, an income or a transfer; a transfer creates a payee for each account name, the outflow and
inflow legs, and links them with `markTransfer`. A `409` shows the duplicate prompt with Add
anyway, and the form persists across Cancel until a create succeeds, guarded by the leave guard
while dirty. The payee picker offers "Add {name}" (`POST /api/recipients`). The Split dialog
(`SplitDialogModel`) splits equally, lets others pay all or takes custom amounts, rounding with
`MoneyMath` (banker's rounding, like `ROUND_HALF_EVEN`); a created split, single or bulk,
invalidates the `/owes` summary and person detail like `splitKeys.all`. The bulk bar (`TransactionsModel+Actions`)
acts on the checked ids or, after "Select all {n} matching filter", on the filter with
`expected_count`; tag and split stay id-only. `/owes` (`OwesModel`, `OwesView`) shows the total
outstanding and the people, and a person's detail records payments, settles, settles all, deletes
splits, exports CSV through the save panel and lists Recent transactions in a local table. Scroll
restore on back and forward stays web-only: the shell gets route reports without a history-entry
key, so it cannot tell a back navigation from a new one.

### Categories and payees (phase 3f part B)

`/categories` and `/recipients` are native without admin mode
([[docs/reference/native-parity/accounts-categories-recipients|accounts, categories and payees parity]],
[[docs/api/categories|categories API]], [[docs/api/recipients|recipients API]]). `CategoriesModel`
builds the tree from `GET /api/categories/tree` (inactive ancestors of active nodes stay as
context) and keeps `show_all` and the repeated `expanded` parameter in the route. The category
dialog sends `parentId: null` and `description: null` explicitly, and a status flip offers Undo for
8 seconds. The spec names the tree response by `$ref` to its envelope, which the generator reads
as the unwrapped data, so `CategoryTreeRequest` decodes `{ items }` by hand; the shared pickers
use it too. `RecipientsModel` pages the payees by `defaultPageSize` with the gated server search
(three characters), the server sort in `sort_key` / `sort_dir`, client-side column filters over the
loaded rows and a load-more Retry. Rows edit inline (double-click or Edit), and the default
category is patched at once (`default_category_id: null` clears it). Merge payees
(`PayeeMergeState`) loads every payee in pages of 1000 and keeps its selection when dismissed;
while a selection exists the leave guard asks first. A merge with a rule suggestion shows one
toast with a Create rule action for 10 seconds. Match rules (`MatchRulesState`) previews a pattern
before saving and drops a preview for a superseded draft. A category write invalidates Transactions,
Planned and the shared pickers; a payee write resets the pickers, and a merge or unmerge also
invalidates Transactions and Planned.

## CI

Linux cannot build macOS apps, so the `native-macos` job ("Native (macOS)") in
`.github/workflows/ci.yml` runs on the GitHub-hosted `macos-26` runner. It installs XcodeGen,
generates the project, builds the Debug app with `CODE_SIGNING_ALLOWED=NO` and runs
`swift test --package-path apps/native`. It selects Xcode 26.6 with `xcode-select` and prints
`xcodebuild -version`, and installs XcodeGen 2.46.0 from its release zip after checking a pinned
SHA-256. `swift test` runs both test targets, `VisionNativeCoreTests` and `VisionNativeUITests`. CI
builds without a runtime payload. The generated Swift sources and String Catalog are checked on
Linux by the Verify Generated Artifacts job (`bun run native:generate`, then no change below
`apps/native/`). The `changes` job sets `native` to true when a pull request
touches `apps/native/`, `packaging/electron/backup/`, `install-native.sh`, `ci.yml`,
`packaging/electron/audit-anchor.ts` or `packaging/electron/scripts/native-audit-fixture.ts`, on
every push to `main` and whenever the diff cannot be classified (`scripts/ci-classify.py`).

The test step sets `VISION_NATIVE_INTEROP_DIR`, so `NativeInteropExportTests` writes a plain
bundle, a v2-encrypted bundle and an audit transfer from synthetic data with fixed test
passwords, plus `expected.json`; the job uploads them as the `native-interop` artifact. The
`native-interop` job ("Native Interop (Electron reader)") runs on `ubuntu-24.04` after
`native-macos`, only when `native` is true. It downloads the artifact, builds the Electron code and
runs `packaging/electron/backup/native-interop.test.ts` with `node --test`: the Electron readers
must open both bundles (metadata, `db.sql`, attachments and frontend state) and refuse a wrong
passphrase, and `createAuditAnchor` must import the audit transfer. A skipped test fails the job.
Quality Gate needs both jobs and tolerates `skipped`, so a failed native build, test or interop
check blocks "CI Complete" through Quality Gate.

### Home and shared chart foundations (phase 3g part A)

`/` draws with `HomeView` once app settings load. The eleven web widget ids and their defaults
are preserved: summary cards and bank balances start hidden. The native page has the greeting
and date, spending pace hero, Needs attention, net worth, planned payments, accounts, summary
cards, bank balance history, monthly bars, category donut, forecast, and recent transactions.
The UI uses the generated theme tokens and EN/NL String Catalog.

`HomeModel` resolves `dashboard_settings` and hidden categories before requesting filtered
aggregates. Exclusions are repeated query parameters, with a separate unfiltered monthly
summary only when needed. Recent filtered rows scan additional server pages until five survive.
The hero keeps the web's unfiltered month-to-date and stored planned-amount behavior. Financial
responses decode directly as `Decimal` through `InsightRequest`, which specializes the generated
OpenAPI operations without bypassing `APIClient`'s envelope or authentication handling. A failed
refetch for the same currency and exclusion set retains successful data; changed exclusions clear old filtered totals; entering Home invalidates its snapshot so edits on other screens
are reflected. A replaced currency request cannot publish an older answer.

`InsightTimelineChart` uses Swift Charts for line, grouped-bar, and stacked-area layouts. Negative
bank balances use lines instead of a misleading positive stack, as on the web. Hover, arrow keys,
Home/End, Escape, and drag/Shift-arrow range comparisons display the original decimal values.
The bank history and forecast share the selected date and range. The net sparkline scrubs the
summary amount and returns to the latest month after release. Category slices navigate with
`category_id`, `uncategorised`, or the remaining `category_ids`; recent rows use the native `id`
inspector parameter.

Forecast mode and rolling-day controls preserve the URL and call the existing forecast services;
Swift does not calculate forecasts. Scheduled ledger transactions and planned payments are already
included in the server series and are not added again. Cumulative uncertainty bands use only the
server's cumulative bands. Diagnostics loads the rolling backtest on demand, shows MAE/RMSE/MAPE,
persisted accuracy sparklines, and the web's shrunk inverse-MSE weight preview.

Customize preserves other pages and unknown widget ids in `widget_visibility`, saves with the
previous JSON value as `expected`, and rolls back the UI on failure. The shell binds only the
`vision.home.dismissedAccountInactivity` and `dismissed_upcoming_planned_payments` local-storage
keys through WebKit arguments, with a timeout. Add transaction reuses the native sheet and leave
guard; a successful creation navigates to `/transactions?id=…`.

The parity mapping is in [[docs/reference/native-parity/home-and-statistics|Home and Insights]].
The macOS build, SwiftUI runtime behavior, and Demo visual comparison remain unverified locally.
Insights now uses the native implementation below; the shared report dialog still uses the web view.

### Insights, saved charts, and the report handoff (phase 3g part B)

`/statistics` draws `StatisticsView` with the six existing tab ids. `StatisticsModel` reads
`?window=all` or the local first day 23 months ago through today, resolves the statistics exclusion
scope, and fetches monthly, category, payee, and payee-by-year aggregates in parallel. Tab changes
reuse the snapshot. Each chart can independently use the filtered or unfiltered snapshot, while
the payee details keep their server-filtered, alias-aware population. A changed currency, window,
or exclusion set cannot display totals from the previous query; failed refreshes of the same query
retain successful data. The shell's settings-read revision refreshes these models after the web
settings dialog's 500 ms persistence debounce, even when date/currency formats did not change.

The monthly rhythm excludes the current month from best/worst comparisons when completed months
exist. Category amounts use the explicit income/expense split, including refunds, and ordered path
segments take precedence over legacy colon-delimited labels. Pivot ancestor rows roll up their
canonical descendant ids without counting transactions twice. Metric, year, expansion, 12-month
column paging, sticky labels, and transaction drill links are native. Payee details reuse the
shared searchable, sortable, filterable table and reveal additional loaded rows on scroll. Yearly
summaries and Sankey flows continue to use the backend's aggregates. Sankey labels and category
colors follow the existing reserved-id and stable-hash rules.

`SavedChartsModel` retains the saved-chart schema, excludes internal `autochart:` records, and
fetches payee/tag pivots for selected sources. The builder preserves all seven type/variant
combinations, monthly/yearly buckets, clearable date bounds, dynamic All sources, searchable
multi-selection, and a debounced live preview. Yearly bounds compare year prefixes, and dynamic
sources retain eight leading entities plus Other. Saving explicitly sends null for cleared bounds.
Historical FX fallback remains visible. Native menus edit and delete charts, with confirmation.
`StatisticsDigestModel` reads existing deterministic findings and persists the same dismissal shapes;
it does not run a new detection or forecast engine.

The header's PDF action temporarily shows the existing React `ExportDialog` at
`/statistics?export=pdf`, preserving tab and window parameters. Closing or downloading removes
only `export`, with replace, and returns to the native screen. The same dialog handles financial,
portfolio, and tax reports; tax-result serialization stays in the existing TypeScript dialog. The computation operation
described below supplies the native Tax screen. This is a retained web surface, not a completed native report
port, and it keeps this area's phase-3 exit gate open.

### Belgian tax computation prerequisite

`POST /api/belgian-tax/compute` runs the existing PIT/household engine from
`packages/shared-utils/src/belgianTax/`, shared with the frontend through compatibility exports.
The endpoint accepts a complete v2 household, validates the existing settings schema, and returns
both the household result and the compatible PIT calculation. It does not read or write settings
or filing records. Unknown-year approximation and issue codes retain the engine's behavior.

`TaxComputationService` uses the generated `computeBelgianTax` operation. Generated monetary
and rate fields decode as `Decimal`; Swift does not calculate taxes. The existing tax scenarios
and golden parity tests exercise the moved engine, and HTTP/native-adapter tests cover the new
boundary. `GET /api/belgian-tax/overview` now handles read-only v1/v2 hydration and live/historical selection,
returning frozen figures and original CAS baselines. Fully frozen records skip computation; legacy
frozen PIT with no household result retains its PIT while deriving that missing breakdown. Missing
legacy fields stay unavailable. The native `TaxOverviewModel` caches the selected year, clears
amounts on a failed year change, and guards against older requests replacing a newer selection.
Shared schema/migration/default modules keep React's existing behavior and lazy loading.

### Tax overview, profile, and year actions (phase 3h)

`/tax` now renders in SwiftUI. `TaxOverviewView` composes the filing masthead, disclosures,
server-computed income/reserve charts, yearly chart, frozen multi-year trend and comparison,
current inputs, possible deductions, transaction-derived deduction review, and all eight widget
visibility controls. Year selection remains `?year=YYYY`. Loading/read failures replace the
statistics-dependent content; changing the year, currency, or settings invalidates old data and
late responses cannot replace a newer selection. Missing legacy frozen fields display as
unavailable; Swift does not reconstruct them.

`GET /api/belgian-tax/dashboard` supplies chart series, recorded income per partner, recorded
portfolio taxes, year comparison calculations, household presentation rows, rule-key groups,
live-profile suggestions, and the viewed v1 projection for CSV. Native callers resolve the
Statistics exclusions and send the explicit last-24-month calendar window. Owner attribution,
frozen PIT scaling, reserve proration, and all fiscal formulas remain shared TypeScript.
Recorded portfolio taxes retain the web latest-rate conversion; inactive investments are included.
See [[docs/api/belgian-tax|the Tax API]] and [[docs/api/info|deduction candidates]] (`partnerShares`).

The six-step `TaxProfileSheet` edits the v2 household: relationship/events and claimants,
per-partner activities and expense methods, home/residences and regional mortgage inputs,
category sources, deductions/dependents, and region/communal rate. `TaxProfileModel` sends
stateless backend previews after a 300 ms debounce and persists edits after 500 ms through the
existing atomic `saveSettings` operation. CAS baselines come from the overview and advance only
from acknowledged writes. Save configures the profile; closing flushes pending changes. Earlier
edits remain saved when the sheet closes, matching the web's write-through behavior. Filed
profiles stay locked until amendment or unfiling; failures/conflicts preserve the draft and surface
an error rather than silently overwriting another editor.

`TaxActionsModel` creates missing snapshots, freezes/unfreezes calculations, marks/unmarks
filings, and records history through the same atomic settings API. Freeze/file computations run
in the TypeScript backend; metadata retains the frozen household result and calculation.
`TaxYearCSV` exports the existing input/calculation columns through the native save panel, with
Decimal precision, escaped fields, and spreadsheet-formula protection. Deduction confirmations
use server-returned partner shares, include the incomplete-year confirmation, and persist the
structural household patch with CAS. Dismissals retain the existing `dismissed_deduction_candidates_v1` localStorage behavior through the shell bridge.

The Tax PDF menu sets `export=pdf` on `/tax`, preserving `year` and other query values, and opens
the shared React report dialog. Closing removes only `export` and restores the native Tax view.
The report dialog and browser-print surface remain web. This is a native screen implementation,
not a phase exit: the full macOS build and the owner's synthetic Demo visual/keyboard review
remain pending. The action mapping is [[docs/reference/native-parity/tax|Tax parity]].

The cloud checks cover portable models, API adapters, generated outputs, and the web handoff.
The full macOS app/package build and the owner's Demo visual pass have not run in this workspace.
See [[docs/reference/native-parity/home-and-statistics|the action mapping]] and
[[docs/features/statistics|Statistics]] for the remaining review surface.

### Portfolio, holdings and wealth tools (phase 3i)

`PortfolioScreens` composes shared read models, retained editor drafts, Rebalance and Net Worth.
`PortfolioScreenView` owns the root detail sheet and the editing presentation. Nested editors
present above the detail without losing its selection; closing a successful archive/delete closes
an active detail. Dirty drafts register the native leave/quit guard. Explicit Cancel resets the
form; Escape or the sheet close keeps applicable edit/trade drafts, matching the web.

`PortfolioModel` consumes typed Decimal responses for canonical active summaries, performance,
broker partitions, exposure and prices. Currency/period revisions reject late reads. The eleven
widget choices preserve other pages and forward the complete original CAS baseline. Portfolio
transaction histories page until complete; incomplete or oversized histories cannot enable a lot
assignment. Ambiguous retag retries retain their UUID per request fingerprint. Broker defaults
use instrument history, then the latest global manual trade, then an active account.

The additive `portfolio-summary?active=false` scope provides canonical all-holding data and an
explicit `archivedPresentation`. The latter retains the existing web archive's ordinary-history
and current-FX presentation, plus its dated in-kind income bridge. Native archive views consume
that presentation rather than substituting the active canonical calculation. Default active totals
and their cache remain unchanged; scope and currency use separate cache entries. See
[[docs/api/portfolio-summary|the summary contract]]. Raw quote amounts seed edit fields; display
columns retain the canonical response currency. Optional unavailable FX decomposition is shown as
unavailable. The OpenAPI generator keeps snake_case/camelCase compatibility aliases as distinct
Swift members when ordinary camelization would collide.

Ticker queries are restricted to Yahoo-provider identities, including the existing configured-id
or symbol fallback. Polling stops while hidden, inactive or offline; reduced motion and hover stop
animation. News displays six articles and validates external HTTP(S) links. Exposure imports retain
the existing typed server contract and 1 MB limit. The five asset pages reuse guarded histories,
price disclosures and native forms while retaining their distinct layouts.

`RebalanceModel` sends targets and reserve floor to the existing TypeScript operations. It first
loads commitment-aware candidate cash, applies the custom cap, then asks for the plan. Fiscal,
valuation, FIFO and deployment engines remain in TypeScript. URL drafts, saved plans and CAS
conflicts preserve the web's input behavior. No trades are executed by this screen.

`NetWorthModel` reads the full daily chart series independently of newest-first table pages,
deduplicates table dates and uses raw page counts for offsets. Its period window uses Gregorian
calendar days in the local timezone and anchors to the latest snapshot. Account rows combine
server broker partitions and guarded stored-rate conversions, excluding cash from holdings-only
wallets. Reconciliation remains visible when those totals differ from the headline. Refreshes
cannot leave an older pagination spinner active or restore a period selected before an awaited
price refresh. Cached/historical quote notices retain the refresh metadata.

Completed price refreshes invalidate the other wealth screens through the shared coordinator's
data revision, including when navigation happens during the request. A lost acknowledgement
still triggers authoritative reads and retains the request error; cached values cannot imply
that the mutation succeeded.

The shared PDF dialog remains in React on overview and asset routes. `export=pdf` preserves all
other parameters, and closing removes only that key with replace. The legacy performance redirect
remains owned by the web router, which reports the resulting native Portfolio route. Browser print,
full macOS compilation and the owner's synthetic Demo visual/keyboard review remain open gates;
see [[docs/reference/native-parity/portfolio-holdings|Portfolio parity]] and
[[docs/reference/native-parity/portfolio-wealth-tools|Wealth tools parity]]. Portfolio import and
Portfolio Tax were still web surfaces at phase 3i; the following phase ports them.

### Portfolio Import and Portfolio Tax (phase 3j)

`PortfolioImportScreens` coordinates the advanced parser, multi-statement session, paginated history
and batch review models. Native file selection/drop reads security-scoped files with the existing
50 MiB limit. `PortfolioImportService` sends their original bytes to the additive, read-only
`POST /api/portfolio/import/probe`: complete-source CSV/XLS/XLSX detection, source-account identities,
separator and bounded header/sample preview remain in shared TypeScript. Probe failures stay explicit;
this endpoint creates no batches or financial records. The Swift controls edit parser configuration
and routing rather than parse financial amounts or infer an ambiguous broker destination.

The advanced parser retains custom mapping, maintained presets, source hints, saved parsers,
progress and the existing custom import behavior. Multi-statement sessions stage sequentially through
the existing SSE operation and require a verified review-required result with zero imported rows.
Stop waits for the active upload so its batch is retained. Session checkpoints contain staged batch
metadata and reviewed routing/policy settings, excluding file bytes. Native reads and serializes
the same two sessionStorage keys through the retained web page, preserving its session lifetime
and staged web receipts. A retained IBKR batch can be
added to the review scope. Source/routing/policy changes invalidate the reviewed plan; cash-only
funding confirmation is tied to the current source routing. Whole history, source attachment,
source correction, in-kind income and cash-only scopes retain their existing server rules.

`PortfolioImportReviewModel` rejects malformed route IDs, resolves complete server-resolvable groups
to an active investment or explicit new holding, and refreshes the authoritative preview after writes.
The investment picker pages and verifies the complete active source. The multi-statement model
requires a ready, blocker-free recognized plan and sends its exact `expected_plan_fingerprint` to
the existing reconciliation commit operation. Server proof, lot/custody, correction, income/cash and
immutable receipt logic is reused without a new migration or import writer. Batch history retains
pagination and guarded rollback. Uncertain acknowledgements refresh retained batches/previews and
block blind repeats; coordinated invalidation refreshes affected wealth screens and any visible
Home, Insights, transaction or account view after cash/ledger writes, including lost responses. See
[[docs/api/portfolio-imports|Portfolio Import API]] and
[[docs/reference/fund-holdings-import-contract|the evidence contract]].

`TaxYearRoute` accepts exactly four ASCII digits, stored snapshot years or the live-year window
from 30 years back through one year ahead. `TaxScreens.loadRoute` reads the authoritative live
profile before adopting or replacing the URL, preserving unrelated parameters and an already
viewed fallback year. It retires prior year reads before awaiting that probe, including when the
new probe fails.

`PortfolioTaxView` reuses `TaxScreens` for the shared profile, historical year/status actions and
native CSV, with the seven configurable Portfolio Tax widgets, recorded/manual costs and PIT budget.
`PortfolioTaxModel` uses `getBelgianPortfolioTaxDashboard`, validates the selected year/currency and
rejects late context revisions. Custom DTOs decode financial values directly as `Decimal`; charts
convert coordinates only. All fiscal/FX amounts, cost bucket precedence, null dividend uncertainty,
estimates and rate badges are computed by shared TypeScript. Source parity keeps the first 500
name-ordered investment metadata rows and newest 1000 ordinary transactions per investment, active
canonical values and the explicit archived/current-FX presentation. Historical selections filter
recorded costs, manual keys, dividends/buy legs and annual tables while retaining current all-time
gains/current-value estimates and selected frozen-first PIT. See
[[docs/api/belgian-tax#Read Portfolio Tax widget data|the exact dashboard contract]].

Manual adjustments and tax classifications edit the live household year even when viewing history.
`PortfolioTaxSettingsDraft` preserves other years, archived entries and unknown fields in both maps;
`PortfolioTaxService` sends one existing atomic `saveSettings` CAS request with unchanged original
baselines. Conflicts or failed acknowledgements retain the open form and its submitted baseline;
success requires a fresh authoritative read before opening another editor. Missing settings seed empty
maps without replacing absence baselines. Widget settings preserve other pages. The shared profile
sheet still writes through its retained draft. Portfolio Tax has no PDF action in the existing page;
PDF export on the earlier Tax/Portfolio routes remains the shared web dialog.

Portable Core/API/route and golden estimator checks cover these paths. The full macOS package build
and the owner's synthetic Vision Demo visual/keyboard checks remain pending. Implemented action
mappings are recorded in [[docs/reference/native-parity/portfolio-wealth-tools|Wealth tools parity]];
[[docs/features/portfolio-import|Portfolio Import]] and [[docs/features/portfolio-tax|Portfolio Tax]]
retain the shared processing contracts. [[docs/flow-visualizer.html|The flow visualizer]] includes
native probe/staging, reviewed reconciliation/commit, and Portfolio Tax read/settings journeys.

### Analysis workspace and Monitors (phase 3k)

![[docs/diagrams/system-architecture.puml]]

`AnalysisScreens` coordinates `AnalysisModel` and `AnalysisWorkbenchModel` for `/analysis`.
`AnalysisWorkspaceView` composes the catalog-backed visual builder, SQL editor/history, financial
parameters, result table/charts/pivot, refinement workbench and reusable-analysis library. Native
controls send approved dataset/column identifiers, opaque SQL and plans to the existing restricted
TypeScript execution APIs. Financial datasets, FX, formulas, calendar/preparation operations,
scenario evaluation, sensitivity and goal calculations stay server-owned. `AnalysisService` uses
generated operation metadata with custom lossless dynamic DTOs; decimal strings, unsafe identifiers,
JSON cells, units, scope, coverage and provenance survive decoding. Chart coordinates alone use
floating point; labels and tooltips retain original values.

Explicit Run/Cancel, bounded paging and request/signature guards retain the last usable result and
mark it outdated when its inputs change. Pivot cells drill against the current pivot plan independently
of an older main table. Workbench previews debounce and reject superseded input signatures; Apply
runs the complete existing TypeScript transformation pipeline and preserves returned completeness,
lineage and errors. Money-aware presentation requires compatible units and complete source scope.
Leaving the workspace cancels previews and retires read generations, resets per-visit state and keeps
SQL history plus already-started write acknowledgements. See
[[docs/reference/analysis-contract|the Analysis contract]] and
[[docs/features/analysis-workspace|Analysis Workspace]].

Saved definitions, run preferences, version history/restore and generated or JSON edit proposals
reuse the existing versioned APIs. Native selection/draft guards prevent a late response from
replacing another selected source. Restore carries the selected expected version; proposal preview
and Apply require the same saved definition and base version. Server conflict/error responses stay
visible. Names, source references and presentation settings remain metadata edits rather than
unrelated financial-query changes.

`AnalysisInterchangeService` sends original CSV/XLSX bytes to read-only multipart import and captured
result/context JSON to multipart export. Shared `packages/shared-utils/src/analysis/` serializers and
parsers serve both frontend compatibility wrappers and the backend; Node adapts XML through the
existing Saxes library. CSV imports retain stable SHA-derived identities and replace the same
attachment, while workbooks receive new identities and append. Removing an attachment removes its
`inputId` joins. Original decimal strings and provenance column IDs survive; workbook formula cells
are ignored as null and counted, imported unit metadata is unavailable, and formulas are never
executed. Imports keep the existing five-attachment, 1000-row and 32-column caller limits; CSV is
bounded at 1,000,000 bytes and XLSX at the effective parser limit of 10,000,000 bytes. Export uses a
scoped 64 MiB transport and supports 100,000 XLSX rows without silently truncating. Any defined,
current captured snapshot can export, including a paged/truncated snapshot whose window is retained;
chart completeness gates do not block report export. CSV formula escaping, stored ZIP/CRC checks,
Excel 1900 dates and precision-preserving workbook text match the shared web implementation. See
[[docs/api/analysis#Read-only CSV and workbook interchange|the exact interchange API]].

`AnalysisMonitorsModel` and `AnalysisMonitorsView` implement the separate `/analysis/monitors`
route: paged rules and dossier targets, exact string thresholds, schedule/cooldown editing,
enable/disable, explicit Check/Delete, observations and inbox read state. The page polls rules and
inbox while visible; target selection and observation reads have independent generations. Mutations
retire reads both before and after the server action, then refresh authoritative state, preventing
an earlier read from overwriting a completed write. The existing local TypeScript scheduler and
monitor service own comparisons, persisted baselines, episodes and notifications; Swift does not
evaluate conditions or invoke providers. See [[docs/features/analysis-monitors|Analysis Monitors]].

Portable Core/presentation, backend route and browser/Node golden checks cover these paths. The full
macOS package build and synthetic Vision Demo visual/keyboard review remain pending, including
EN/NL layout, focus, query cancellation, chart/pivot interaction, version/proposal dialogs and monitor
errors. [[docs/reference/native-parity/analysis|Analysis parity]] records implemented controls;
[[docs/flow-visualizer.html|the flow visualizer]] includes native execution/refinement, saved-version,
interchange and monitor journeys.

### Research Home, Markets, Lookup, Watchlist and Compare (phase 3l)

`ResearchScreens` coordinates exactly five native routes: `/research`, `/research/markets`,
`/research/market`, `/research/watchlist` and `/research/compare`. `ResearchHomeView` and
`ResearchMarketsView` reuse the maintained catalog, paged watchlist/holding metadata, quote batches,
news links and native search. `ResearchMarketLookupView`, `ResearchWatchlistView` and
`ResearchCompareView` retain the source query parameters, dialogs, filters, provenance and explicit
error/unavailable states. At phase 3l, Chart Builder and the remaining Research/AI screens
retained their web implementation. Native phases 3m and 3n below cover those later ports.

`ResearchService` reuses existing Research/Market/Watchlist/mapping/investment operations with
custom lossless DTOs. `APIClient.sendWithMeta` exposes the same validated data plus retained metadata
so provider/source/request identity is available to the native provenance controls. Provider price
leaves remain optional/nullable, decimal values decode directly as `Decimal`, and unknown fields
remain in raw values. Missing provenance source stays unavailable rather than inventing live data.
`ResearchReadCache` coalesces current scoped reads, caches successful replies and retains prior usable
model rows with a scoped error on refresh failure. Search debounces and hides old-query hits;
route/symbol/range/selection generations discard late reads. Visible children own delayed polling;
the coordinator propagates online/route changes, resets applicable local controls on entry and
retires departing reads while preserving already-started write acknowledgements.
Settings and global web overlays preserve the current Analysis/Research visit, its drafts and the
Lookup dirty-form guard. `NativeShellModel.routeDidChange` retires those visits on an actual path
exit, including navigation that occurs while an overlay covers the native screen.

The additive `computeResearchPresentation` operation accepts one multipart JSON snapshot containing
already-fetched values. Shared `packages/shared-utils/src/research/` helpers compute Compare rebased
rows/statistics/timestamp-aligned correlations, Chart Builder indicators/OHLC fallbacks, Watchlist
list/chart/add target facts, provider-history quotes, analyst verdict/bar fractions and market-add
two-of-three previews. Frontend pages and compatibility exports reuse those same helpers. The
endpoint has a scoped 64 MiB file limit and preserves complete submitted histories without extra
provider, database, settings, FX or quota calls. Original provider order, duplicate/gapped timestamps,
null warmups, percentage conventions and existing quote/booking currency behavior remain intact.
Swift performs structural sorting and chart geometry, while numerical transformations stay
TypeScript. See [[docs/api/research#POST /api/research/presentation|the exact presentation contract]].

Lookup retains provider-mode history and regular symbol-mode quote/chart/news/analyst/scorecard
reads, existing mapping operations, Watchlist add and market buy/sell drafts. The server preview
supplies effective/derived unit fields and consistency; the existing trade writer remains
responsible for persistence and validation. Scope/selection guards keep previous-symbol replies
from replacing a new draft. A changed mapping instrument/investment identity resets proposal, audit
and selection state rather than attaching the previous context to a new holding. The quote-native
price seed can differ from the default booking currency; this existing source behavior is retained. Writes retain explicit failed/uncertain acknowledgement state and
coordinate portfolio/watchlist invalidation rather than blindly replaying a create.

Watchlist batches list metrics after the existing list and quote reads, computes chart/add facts
from their matching source values, and displays the existing item currency without adding FX.
Target edits PATCH only `target_price`; the added-price snapshot is immutable. Mutations retire
reads before and after callbacks and refresh authority on success or failure. A selected chart stays
selected until its actual row is removed. Add requests retain quote/selection scope and guard a lost
acknowledgement from an unverified repeat. Compare preserves repeated-symbol URL normalization,
maximum six symbols, eager chart plus scorecard reads even on the other tab, provider/source notes,
fundamental ordering and first/last available history hints. Its presentation response is accepted
only for the current input/generation; undefined or constant correlations remain unavailable.

Named OpenAPI schema corrections record unchanged Market search `{items}`, quote/news `{items,total}`,
paged Watchlist `{items,total,limit,offset}`, nullable Research leaves and investment history
`{investment_id,provider,points:[{timestampMs,price}]}` with actual `from_ms`/`to_ms`/`db_only` queries.
No migration, fiscal semantics or provider-selection change accompanies these ports. Portable native
model/transport tests and frontend/backend source goldens cover the paths, including an independent
comparison against the pre-extraction source. The full macOS package build and synthetic Vision Demo
visual/keyboard checks remain pending. [[docs/reference/native-parity/research-and-ai-chat|Research
parity]] records action coverage; [[docs/features/research|Research]] and
[[docs/flow-visualizer.html|the flow visualizer]] retain the shared processing boundaries.

### Research Chart Builder and Forecast/Life Scenario (phase 3m)

`ResearchChartBuilderScreenView` mounts `/research/charts`; `ResearchForecastScreenView` mounts
`/research/forecast` with Life Scenario embedded in the same page. These extend the five native
Research routes from phase 3l. Dossiers and AI Chat/Investigation now use the native phase 3n
implementation below.

`ResearchChartBuilderModel` owns series, provider-pinned macro search, indicators/oscillators,
local layouts and clipboard sharing of portable chart URLs. Ticker/macro reads retain
source scopes and provider metadata. One existing `computeResearchPresentation` chart request
returns aligned price/volume/OHLC, rebasing, SMA/EMA/Bollinger and raw-close RSI/MACD rows; native
charts convert coordinates and edit structural settings without moving numerical transformations
to Swift. Late state/range responses lose their generation authority. Empty/unavailable series and
warmups remain explicit. Presets, axes, log/rebase controls and series/indicator limits retain the
source behavior. See [[docs/api/research#POST /api/research/presentation|the chart presentation contract]].

`ResearchChartLayoutStore` reads and serializes the same
`vision.research.chartBuilder.layouts.v2` localStorage key through the retained WK page. It restores
the complete library before editing, queues writes, reports storage failures and retains the
portable version/state format. Limits remain 20 layouts, five series, 20 indicators, periods
1..500, 250,000 UTF-8 bytes on save and the source UTF-16 read bound. Shared URLs use the same
versioned base64url state and 20,000-character cap; a valid share is consumed through the existing
route update. Copy Share encodes the current structural state, resolves the retained page origin
and copies the resulting URL to the clipboard, with a visible success or failure notice. No
financial data or simulation result is persisted by the stateless presentation service.

`ResearchForecastScreens` coordinates `ResearchForecastModel` and `ResearchLifeScenarioModel`.
Main Forecast keeps its 450 ms debounce, five-minute cache and source defaults, calls the existing
TypeScript projection API and rejects stale input/generation/visit results. Invalid or still-pending
main input hides prior output. Custom DTOs retain raw Decimal bands, metadata, absent values and
unavailable extensions. Native rendering uses the six returned percentile/capital series; no
simulation, drift, probability or contribution arithmetic is recreated in Swift. Required numeric
available-result fields retain the canonical client guard even where OpenAPI records nullable
wire overflow. An overflow is an error rather than a zero projection.

Life Scenario receives the immediate main input independently of whether that main forecast can
run. `lifeScenarioPrepare` overwrites discarded main contribution/goal/seed fields and returns
baseline/interrupted requests, the reduced contribution and monthly deficit. Native forwards two
existing forecast requests concurrently with the same returned seed, then submits their raw replies
to `lifeScenarioCompare`. The shared TypeScript helper retains the fixed first three reduced months,
trailing planned contributions, exactly five market-input comparisons and a median gap only when
known. Null available medians are rejected at the existing client-validity boundary. No additional
provider, database or FX call accompanies these preparation/comparison kinds. New unsaved runs use
a fresh source ID; saved definitions keep their ID/seed. Local goal-month resolution is structural.
Draft/input/currency signatures retire obsolete preparation, projection and comparison replies.

Saved `life_scenarios` definitions use the existing settings CAS, with a first-read pinned raw
baseline and serialized acknowledgements. Rejected/lost receipts retain recovery state rather than
blindly replaying a write; only an acknowledged save advances the baseline. Delete retains the
source bounded Undo action. Reads cannot replace pending mutation authority; a late acknowledgement
after leave updates the baseline without restoring a departed draft. A real route exit resets
controls and retires previews, while temporary native overlays retain their screen instance.
There is no added polling or leave guard. See [[docs/features/research|Research]],
[[docs/api/settings|Settings API]] and [[docs/diagrams/life-scenario-flow.puml|Life Scenario Flow]].

Shared/backend tests and immutable frontend goldens verify monetary preparation, comparability,
missing values, overflow/client rejection and unchanged projection behavior. Native Core/UI owners
have separate focused transport/state checks. Full macOS package, responsive drawing, VoiceOver,
keyboard and synthetic Vision Demo review remain pending; code coverage in
[[docs/reference/native-parity/research-and-ai-chat|Research parity]] is not a rendered verification.

### AI Chat, Investigation and Research Dossiers (phase 3n)

`AIChatScreenView` mounts `/ai-chat`; `ResearchDossiersScreenView` mounts `/research/dossiers`.
`AIChatScreens` keeps Chat and Investigation mounted through mode changes. The `mode` and `c`
query parameters retain source selection, and the Ollama banner and conversation rail belong only
to Chat. Same-visit mode/conversation updates do not independently refetch stale page-wide provider
queries. Native overlays retain the screen; a real route exit retires page reads and resets local
drafts. Full macOS package and synthetic Demo review remain pending.

`AIChatModel`, `AIChatService` and `AIChatStreamStore` retain conversation paging, explicit
create/rename/delete, the composer model/tools controls and existing JSON/SSE operations. Each
conversation’s stream generation protects tokens, tool messages and terminal receipts; the stream
store remains separate from page-read lifetime. Leaving the page does not implicitly stop an
ongoing chat turn. Stop keeps partial output, and Retry Last Turn remains explicit rather than
replaying a failed POST automatically. Typed raw DTOs retain Decimal tool values, usage, message
status and unknown provider/result fields. Existing source completeness and streaming states remain
visible; no new tool, model route or financial engine is introduced.

Outgoing tool messages receive a `toolPresentation` sibling without changing `toolResult`.
Shared `packages/shared-utils/src/ai-chat/toolPresentation.ts` derives ordered first-row columns,
axes and source pie proportions before Swift loses JSON member order. It retains explicit empty
x keys, nested-array rows, ignored legacy axis metadata and Recharts default signed sector
composition, including no sectors for a nonpositive sum. Native charts draw returned geometry and
format retained values; stored results and model prompts stay unchanged. SSE, JSON turns and
historical conversation reads use the same enrichment. See [[docs/api/ai|AI Chat API]].

`AIInvestigationModel` uses the existing jobs, status, documents and disclosure endpoints. Form
preferences retain exact currency/benchmark/depth/model fallback rules and EN/NL language. Public
symbols and web queries remain separately authored; selected evidence remains the inspected text.
Cloud Run first produces the exact preview; the next consent action creates its digest-bound grant
and submits the preview's frozen `outboundRequest` with that grant ID. Form or resolved-context
changes retire obsolete previews. Native rendering retains capability/reference/preflight metadata,
facts, calculations, interpretations, evidence locators and the existing saved-analysis link.

Status alone follows the source 60-second TanStack freshness and mount/reconnect policy, with
no automatic retry loop. The global QueryClient disables ordinary window-focus refetch; focus
continues a previously paused read. Online initial mounts and newly invalidated active reads can
start when backgrounded, while continuation of an offline-paused read waits for focus. Successful
status receipts are shared with Settings without another provider request. Documents remain a
mount-only manual read.
The current job uses the source manual 1.2-second polling policy while the page remains mounted,
including hidden mode and offline/background intervals; failed polls are silent. A slow GET does
not postpone later interval ticks; published snapshots restart the interval and retire older read
authority. Polling stops at
completed, failed, cancelled, partial or waiting. Resume uses the current scope and the source
clarification. Cancel leaves local job state to any already-active poll. Document upload sends original
multipart bytes; document deletion retains its confirmation. Job/history deletion and grant
revocation keep their immediate source actions. Footer revoke clears the active grant control;
history revoke stamps only that history row. Visit/write guards prevent late reads restoring deleted
or departed state. No job recovery browser or additional provider request is added. See
[[docs/api/ai-research|AI Research API]] and [[docs/features/ai-chat|AI Chat]].

`ResearchDossiersModel` retains the source 500-row list pages, explicit editor drafts, current links,
evidence/document anchors, immutable versions, conflicts and server JSON exports. Saving sends the
captured expected version; a stale editor gets a conflict rather than overwriting newer content.
Restore creates a new version. New/switch with unsaved edits and delete/restore/reload retain their
source confirmations; selecting the current dossier preserves the draft. Changing a linked document
clears its four citation anchors, and only a literally empty source title is filled automatically.
Deleted links retain their saved labels. Export one/all reads the existing server export operation
and saves its captured JSON; there is no dossier import or financial transformation in Swift.
Selection/visit guards and write acknowledgements protect newer drafts from stale reads. See
[[docs/features/research-dossiers|Research Dossiers]] and [[docs/api/research-dossiers|its API]].

Focused Foundation transport/state tests and TypeScript inference/Recharts tests cover these
contracts. The native parity inventory records code coverage; responsive rendering, VoiceOver,
keyboard behavior and Vision Demo acceptance still require macOS. The architecture/flow catalogue
shows native clients calling existing backend services, with tool presentation staying in shared
TypeScript and provider disclosure remaining behind the existing consent boundary.

### Settings and global notices (phase 3o)

![[docs/diagrams/frontend-state-management.puml]]
![[docs/diagrams/frontend-data-flow.puml]]

See also [[docs/diagrams/system-architecture.puml|System architecture]].

The native Settings window has seven panes: General, Appearance, Insights, Behavior, AI & research,
Backup, and About & maintenance. `NativeSettingsWindow.swift` and the `NativeSettings*.swift` views
under `apps/native/Sources/VisionNativeUI/Screens/Settings/` use shared section/group/row primitives,
a section rail with keyboard navigation, and the existing source controls. The retained router still
owns section query parameters and Back/close navigation. Settings and action notices now render
natively; the retained WK page continues to host onboarding, shared PDF dialogs, and browser state.

`NativeSettingsModel.swift`, `NativeSettingsDefaults.swift`, and `NativeSettingsService.swift` under
`apps/native/Sources/VisionNativeCore/Settings/` retain the existing settings API and raw first-read
CAS baselines. App and dashboard envelopes are migrated into editable defaults while preserving
unknown fields; optional AI model/depth/benchmark absence stays absent. Initial hydration does not
save. Theme writes retain the source four known fields (`mode`, `schedule`, `variant`,
`systemAccent`). Each preference key has its own 500 ms debounce and serialized write lane. Only
acknowledged receipts advance its baseline; a rejected or uncertain save keeps the failed lane
sticky rather than blessing a later draft with a fresh background read. App/dashboard failures
retain the existing save feedback, while theme persistence retains the source silent-failure policy.
Server-only transfer and cash-category controls keep their existing operations. No new backend
endpoint or financial calculation accompanies this screen port.

The retained page and native window share one writer for `app_settings`, `dashboard_settings`, and
`theme_settings`. `apps/frontend/src/stores/hydration/nativeSettings.ts` receives immediate native
drafts and separate acknowledged receipts, updates Zustand without an echo, and forwards retained
page edits as structural field deltas. The native-only `shell:settings-change` bridge accepts only
these three keys and their supported fields; removal is restricted to the four optional app fields.
`NativeSettingsPatch.swift`, the existing bridge codec/dispatcher, and
`apps/native/VisionNative/ShellController.swift` apply those deltas to the same native writer.
App/dashboard unknown fields survive; schedule changes merge only the edited clock fields. Native
mode disables the three web hydration writers. Draft mirrors never advance the web CAS baseline;
only a checked server receipt does. These native-only messages are separate from the endpoint
matrix's unchanged 309 HTTP routes, two health entries, and 25 Electron IPC entries (336 total).

`NativeSettingsAIModel.swift` retains independent local/OpenAI defaults, source server-default
fallbacks, benchmark-on-blur validation, and absent product-default depth. Secure provider drafts
clear on submission, including failures; Clear appears only for settings-backed keys. Provider
writes invalidate masked key status only. AgentCloak uses the existing status/configuration
operations and refreshes desktop/OpenAI status after an acknowledgment. Successful status/model
receipts are shared with Chat and Investigation; only pending typed reads for the same backend
scope coalesce. Ordinary focus refetch is disabled globally, paused reads resume with focus,
and Ollama keeps healthy/down polling intervals. An offline-paused mutation waits for online and
foreground continuation even after its pane unmounts. `ShellRootView.swift` supplies app-lifetime
connectivity and scene state to that model.

Appearance keeps the five canonical palettes and source light/dark/system/schedule behavior. A
system accent changes exactly `primary`, `primaryForeground`, `ring`, `sidebarPrimary`,
`sidebarPrimaryForeground`, and `sidebarRing`. Both foreground tokens use the same source contrast
pair; palette swatches and the palette accent remain canonical. Display size uses physical
pixels, with the source cap above 6,000,000 pixels: auto-adapt defaults to reduced effects, and an
explicit override stays session-only. `NativeSettingsAppearanceResolver.swift`,
`Design/ThemeSelection.swift`, `VisionTheme.swift`, and the SDK host apply the same appearance to
native chrome and the retained page.

Backup/About use the existing native picker, encrypted bundle, passphrase, restore, services,
update and onboarding bridges. `NativeSettingsStorageBridge.swift` captures the source localStorage
registry without file bytes and restores captured strings without clearing omitted keys. Confirmed
restore remains a lifecycle boundary. `NativeSettingsModel.suspendForRestore()` holds the latest
debounced drafts, retires late reads, and waits for Main-accepted requests and writer queues before
the database switch. A failed/cancelled restore resumes those drafts with the same opaque baselines
and sticky failed lanes; it does not reread/rebase them. Successful reload retires callbacks and old
writers and constructs fresh models/baselines.

`API/NativeDataSession.swift` supplies `NativeSessionAPITransport` to the shared APIClient's HTTP
and SSE paths. Confirmed restore pauses new mutation admission, waits for accepted transport writes,
and stops current chat and import streams through the SDK. New reads are refused while paused, and a read
admission epoch rejects pre-attempt results/read-stream chunks even if the restore fails and resumes
the original database. A failed restore resumes the same session. Success retires it, rejecting old
admissions and late HTTP/SSE delivery; a new client uses a fresh session.
Transport cancellation does not assert that a server write rolled back. The Main fence has focused
portable gated tests, and the shared transport has 13 focused cases; SDK/macOS verification
remains unverified at this checkpoint. The common SDK restore path serves native Settings and retained
web onboarding. A UUID owns each entered fence, so an overlapping operation cannot resume or retire
another operation’s session. Main and legacy preference writers drain first, chat/import streams stop,
and the shared transport drains before the existing Backup service switches the database through its
unfenced transport. A successful restore marks the old graph for retirement; native reload and the
renderer-ready path share one generation-checked rebuild task. Fresh models, the API session and
preference writers replace the old graph once, including when the retained onboarding page reloads.

`Shell/NativeNoticeCenter.swift`, `Components/NativeNoticeHost.swift`, and `ActionToast.swift`
provide app-lifetime notices and consume captured actions before awaiting them. Shell construction accepts an optional notice center so tests can control expiry and clock time; normal app construction retains automatic expiry. Transactions,
Planned payments, Categories, Recipients, Chart Builder, and Life Scenario retain eight-second
Undo actions and the source one-slot shortcut registry. Editor typing keeps its own Undo; route
changes preserve eligible notices. Retry, Create rule, and Import actions remain non-Undo actions
with their source callbacks/routes. No new retry or confirmation workflow is added.

`.github/workflows/native-branch.yml` now verifies `codex/native-phase-*` branch pushes with an
unsigned Debug macOS app build and Swift package tests. The automated build is not yet green:
successive builds have exposed SDK compiler issues, and corrections continue through the
automatic branch workflow. Full app compilation and the following package-test step remain pending.
Portable source/transport tests and UI syntax checks do not replace macOS SDK or rendered
VoiceOver/Demo verification. Those checks remain recorded gaps; the user's authorization continues
later phases without a manual Demo-review intermission. See [[docs/features/settings|Settings]],
[[docs/api/settings|Settings API]], and [[docs/reference/native-parity/shell-and-settings|Settings parity]].

### Shell overlays and reports (phase 3p)

`NativeCommandPaletteModel` and `NativeCommandPaletteView` own palette selection, recent actions,
navigation and native shortcuts help. The fixed retained TypeScript answer callback preserves source
calculator and currency parsing; Swift does not recreate those calculations. `NativeShellNotificationsModel`
owns the global FX state, Home upcoming-payment reminders and backup reminder. Their dismissal state
uses the app-lifetime local-state queue, which drains accepted writes before restore.

`NativeOnboardingModel` and `NativeOnboardingView` replace the seven-step Welcome, Overview, Categories,
Bank, Import, Tour and Backup wizard. Draft progress stays in the existing local-storage shape;
completion uses the common settings writer. CSV review and backup restore reuse their existing owners.
The strict native capability suppresses the competing web wizard before its hooks run.

`NativeReportModel` and `NativeReportSheet` provide the shared financial, portfolio and tax export form.
The initial period remains rolling twelve months, including exports opened from a historical Tax page.
The source section order, twelve currencies, date/year validation, all-selected empty section array,
financial exclusion scope and submit-time theme are preserved. Closing and reopening on the same path
retains the draft; leaving the page resets it. Canceling the native save panel keeps the dialog and
produces no success notice. Closing removes only the current route's `export` parameter.

The hand-written binary request uses the existing `/api/reports/{type}` routes through a dedicated
900-second client sharing `NativeDataSession`; PDF data and response headers are retained, with no
retry. `NativeTaxReportContextService` reads the original selected-year overview and invokes the fixed
shared TypeScript household projection. Frozen PIT/household precedence and legacy missing-household
fields are preserved, including Decimal values and unknown household fields. For a custom year outside
the overview API's 1900–2200 bounds, the fixed `__visionNativeTaxReportContext` callback receives a fresh,
read-only five-key settings snapshot and uses the original source loaders, resolvers and fiscal engine.
It neither clamps the requested year nor drops configured fiscal blocks: source-valid one-partner
requests and source-invalid two-partner household requests retain their original result/error behavior.
No report endpoint or fiscal formula changes.

File → Print is a separate current-page operation. `NativeTaxPrintSnapshot` freezes the already loaded
Tax year, visible widgets, comparison year, disclosure state and deduction state. The inert presentation
and `NativeTaxPrintDocument` reuse section views without query lifecycle hooks or fiscal recalculation.
Printer-only tables render all columns without horizontal scroll clipping. The SDK checks the route,
generation, restore state and overlays again before paginated `NSPrintOperation` presentation. This
implementation does not claim verified printer pagination or rendered macOS parity; those checks remain
pending. Statistics and Net worth print preparation is tracked separately until their own proof passes.

The immutable combined Foundation proof passed **1,271 tests in 161 suites** for the mounted phase-3p
Core graph (239 production and 86 test files); it excludes subsequent current-page print additions.
Focused Reports proof passed **37 tests in two suites**. The retained source fiscal context and export
regression passed **179 tests across 16 files**, with source typecheck, lint and build passing. These
checks do not verify SwiftUI/AppKit compilation, accessibility, visual layout or real printer output.
See [[docs/reference/native-parity/shell-and-settings|shell parity]],
[[docs/reference/native-parity/tax|Tax parity]], [[docs/features/onboarding|onboarding]],
[[docs/features/pdf-report-export|PDF export]] and [[docs/diagrams/index|structural diagrams]].

## Install

`install-native.sh` requires `xcodegen` and `xcodebuild`. It prepares the payload with the same
scripts as `install-demo.sh` (`prepare_native_macos_build`, then `prepare-native-runtime` and
`build-demo-seed` from `packaging/electron/scripts/`) into `apps/native/build/payload/`. It then
generates the project and builds Release into `apps/native/build/`. A "Stage runtime payload"
build phase copies the payload to `Contents/Resources/runtime/` and `Contents/Resources/demo-seed/`
before code signing. The script checks the staged files and `codesign --verify --strict`, then
replaces `/Applications/Vision Native Demo.app` (with `VISION_NATIVE_VARIANT=standard`,
`/Applications/Vision Native.app`). `VISION_NATIVE_SKIP_PAYLOAD=1` builds without a payload.

It signs automatically with the free personal team from `VISION_NATIVE_TEAM_ID`, or from
`VISION_NATIVE_TEAM_ID = <id>` in `apps/native/Config/Local.xcconfig`, so the signature stays
stable between builds. Without either the app is signed ad-hoc and the script warns that the
signature changes on every build. There is no updater: rerunning the script is the update path.

## Related

- [[docs/adr/204-vision-native-swift-app-target|ADR-204]]
- [[docs/reference/native-parity/index|Native parity inventory]]
- [[docs/reference/native-parity/shell-and-settings|Native parity: shell, menus, dock and bridge]]
- [[docs/reference/native-parity/phase-1-exit|Native parity: phase 1 exit checklist]]
- [[docs/adr/205-vision-native-hand-over|ADR-205]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/reference/scripts|Scripts Reference]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
