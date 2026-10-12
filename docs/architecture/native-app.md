---
title: Vision Native App Architecture
type: architecture-doc
status: active
date: 2026-10-12
updated: 2026-10-12
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
    adr-204,
  ]
description: "Vision Native is the Swift macOS app under apps/native/ that replaces the Electron shell in phases (ADR-204). Covers the directory layout, the runtime supervisor that starts its own PostgreSQL 18 cluster and backend on synthetic Demo data, payload discovery, the phase 1c shell (window, launch state, preload bridge, web view navigation and download policy, menus, dock and vibrancy), phase 1d backup and restore (bundle format compatibility, Keychain passphrase, restore allow-list, quit-time backup), the Debug-only backend override, the Native (macOS) CI job and install-native.sh."
aliases: [vision native, native app, swift app]
---

# Vision Native App Architecture

> [!abstract] Overview
> Vision Native is a separate Swift app, bundle identifier `com.vaultvoyager.vision-native`, that
> replaces the [[docs/architecture/electron|Electron shell]] in phases
> ([[docs/adr/204-vision-native-swift-app-target|ADR-204]]). In phase 1 it hosts the existing
> React frontend in a `WKWebView` and runs its own runtime on synthetic Demo data only. The Electron
> "Vision" app stays the daily app until the phase 4 switch-over.

## Layout

| Path                                            | Purpose                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/native/project.yml`                       | XcodeGen spec: project `VisionNative`, macOS app target "Vision Native", macOS 26.0   |
| `apps/native/Config/Signing.xcconfig`           | `DEVELOPMENT_TEAM` from `VISION_NATIVE_TEAM_ID`, optional gitignored `Local.xcconfig` |
| `apps/native/VisionNative/`                     | AppKit entry point, window, menus, `WKWebView` shell and the SwiftUI launch state     |
| `apps/native/Package.swift`                     | SwiftPM package (Swift 6 language mode) with the `VisionNativeCore` library, no deps  |
| `apps/native/Sources/VisionNativeCore/`         | `BackendLocator` and `BackendHealth`: non-UI logic, testable without the Xcode UI     |
| `apps/native/Sources/VisionNativeCore/Runtime/` | Runtime supervisor, PostgreSQL and backend lifecycle, Demo seeding, system seams      |
| `apps/native/Sources/VisionNativeCore/Shell/`   | Shell logic without AppKit: bridge contract, codec, policy, menu model, window frame  |
| `apps/native/Tests/VisionNativeCoreTests/`      | Swift Testing tests                                                                   |
| `install-native.sh`                             | Local Release build and install to `/Applications/Vision Native.app`                  |

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

Everything lives below `~/Library/Application Support/Vision Native/`. Vision Native refuses any
other application-data directory and never reads, locks or changes the `Vision` or `Vision Demo`
directories. Below `native/<runtimeId>/` the layout is the Electron native runtime's, so a later
phase can switch directories without converting files.

```text
Vision Native/
  settings.json             appPort (persisted random backend port), keepServicesOnQuit
  vision-native.lock        single-instance lock (flock)
  demo-reset-request.json   optional request to restore the canonical seed on next launch
  logs/main.log             lifecycle log, rotated once at 2 MB
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
`vision_analysis_executor`. PostgreSQL listens on `127.0.0.1:54331`, next to Vision (54329) and
Vision Demo (54330), so all three can run at once.

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
records, and treats PIDs of 1 or less as untrusted. On the next launch a healthy backend from an
earlier run is reused, and an unhealthy one is replaced.

Before the shutdown the shell runs the quit-time backup (see
[[docs/architecture/native-app#Backup and restore (phase 1d)|Backup and restore]]); the 45-second limit covers both. Phase 1b leaves out the
audit anchor and Keychain witness (phase 1e), external PostgreSQL clusters, the Bun source mode and the health
watchdog that restarts a crashed backend.

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
opens at Electron's 1280 x 800 with a minimum of 800 x 600, titled "Vision Native". It matches
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

The native chrome follows the system appearance, like Electron, which never sets
`nativeTheme.themeSource`. The page applies its own theme. `app:set-vibrancy` shows an
`NSVisualEffectView` (`underWindowBackground`, behind window, following the window's active state)
behind a transparent page, which is Electron's `setVibrancy("under-window")`.

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
| `electronAudit`    | `audit:enroll`, `read`, `export`, `transfer-export`, `transfer-import`, `rotate-key`                                          | Stubs that reject "not available in Vision Native yet" (phase 1e)       |
| `electronServices` | `services:save-settings`, `services:load-settings`                                                                            | Database setting with baseline writes, mirrored to `settings.json`      |
| `electronRecovery` | `recovery:retry`, `recovery:open-logs`                                                                                        | Relaunch through the supervisor; open `native/vision_native/logs`       |
| `electronAPI`      | `app:renderer-ready`, `app:set-badge`, `app:set-language`, `app:set-vibrancy`, `app:get-accent-color`, `theme:persist-splash` | Implemented (queue flush, dock badge, menus, material, accent, palette) |
| (user script)      | `app:renderer-failure`                                                                                                        | Logged as kind, name, source file and line only                         |
| (Vision Native)    | `native:window-drag`, `native:window-titlebar-double-click`                                                                   | Topbar drag region                                                      |

The backup settings use the same baseline writes and `settings.json` mirror (`backupDir`,
`backupOnQuit`) as the services settings, and `save-settings` refuses system directories like
`validateBackupDest`, so Settings > Backup keeps its directory and on-quit toggle. Without a
configured directory, `load-settings` answers the iCloud Drive default like
`resolveBackupSettingsWithDefaults`, and the quit-time backup reads the database value, else the
mirror.

Events: `menu:action`, `app:csv-opened` (a CSV opened with the app, at most 25 MiB),
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
`menu:action` through the bridge, showing the window first. The Toggle Developer Tools item is
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

Phase 1e ports the audit anchor and Keychain witness (`electronAudit`). The pre-update backup has
no counterpart because there is no updater. Still missing as well: the health
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

New bundles are always v2. AES-GCM is streamed (CommonCrypto AES counter blocks plus GHASH), so a
large bundle is never held in memory; tests compare it with CryptoKit and with files written by
Node. The test resources carry the Electron Vision 1.0.2 fixture
(`packaging/electron/backup/fixtures/vision-1.0.2-sanitized.visionbak.enc`) byte for byte, and a
test opens it. Extraction refuses absolute and `..` entry names and stops beyond 10 GiB of output
or 100,000 entries.

### Passphrase

`VISION_BACKUP_PASSPHRASE` wins, as in Electron. Otherwise the passphrase is a generic password in
the login Keychain with the service `com.vaultvoyager.vision-native.backup-passphrase` and the
backup device id as the account (`KeychainPassphraseStore` behind the `PassphraseStore` protocol).
Vision Native never writes Electron's `backupPassphraseEncrypted` field. An empty passphrase
removes the item. Without a passphrase a backup is written unencrypted with Electron's warning.

### Device id, directory and retention

The device id is Electron's (the first 8 hex digits of SHA-1 over `darwin|arch|hostname|userData`),
persisted once as `backupDeviceId` in `settings.json`. Without a configured directory the default
is `~/Library/Mobile Documents/com~apple~CloudDocs/Vision Native/Backups` when iCloud Drive exists,
and the quit-time backup is then on. Retention keeps the newest seven backups of this device and
removes older ones, and `.partial` leftovers, only when they are more than 10 minutes old.

### Restore

`backup:is-encrypted` and `backup:restore` accept only a path the restore picker returned
(`RestorePathAllowList`, Electron's `ALLOWED_RESTORE_PATHS`) with a `.visionbak`,
`.visionbak.enc`, `.enc` or `.sql` extension. After the confirmation, the bundle is decrypted
and extracted into a private temporary directory, and a bundle from a newer schema is refused with
`BUNDLE_SCHEMA_NEWER`. Then, as in `restoreNativeBundle`:

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

### Quit-time backup

`ShellController.prepareForQuit` runs the backup before `RuntimeSupervisor.shutdown()` when the
effective settings enable it and the runtime is running. It writes a bundle without frontend state.
A backup already in progress is awaited instead of starting a second one. The app delegate's
45-second hard limit, Electron's will-quit timeout, covers the backup and the shutdown together.
Failures are logged to the unified log; there are no OS notifications yet.

## CI

Linux cannot build macOS apps, so the `native-macos` job ("Native (macOS)") in
`.github/workflows/ci.yml` runs on the GitHub-hosted `macos-26` runner. It installs XcodeGen,
generates the project, builds the Debug app with `CODE_SIGNING_ALLOWED=NO` and runs
`swift test --package-path apps/native`. It selects Xcode 26.6 with `xcode-select` and prints
`xcodebuild -version`, and installs XcodeGen 2.46.0 from its release zip after checking a pinned
SHA-256. CI builds without a runtime payload. The `changes` job sets `native` to true when a pull request
touches `apps/native/`, `install-native.sh` or `ci.yml`, on every push to `main` and whenever the diff cannot
be classified (`scripts/ci-classify.py`). Quality Gate needs the job and tolerates `skipped`, so a
failed native build or test blocks "CI Complete" through Quality Gate.

## Install

`install-native.sh` requires `xcodegen` and `xcodebuild`. It prepares the payload with the same
scripts as `install-demo.sh` (`prepare_native_macos_build`, then `prepare-native-runtime` and
`build-demo-seed` from `packaging/electron/scripts/`) into `apps/native/build/payload/`. It then
generates the project and builds Release into `apps/native/build/`. A "Stage runtime payload"
build phase copies the payload to `Contents/Resources/runtime/` and `Contents/Resources/demo-seed/`
before code signing. The script checks the staged files and `codesign --verify --strict`, then
replaces `/Applications/Vision Native.app`. `VISION_NATIVE_SKIP_PAYLOAD=1` builds without a payload.

It signs automatically with the free personal team from `VISION_NATIVE_TEAM_ID`, or from
`VISION_NATIVE_TEAM_ID = <id>` in `apps/native/Config/Local.xcconfig`, so the signature stays
stable between builds. Without either the app is signed ad-hoc and the script warns that the
signature changes on every build. There is no updater: rerunning the script is the update path.

## Related

- [[docs/adr/204-vision-native-swift-app-target|ADR-204]]
- [[docs/reference/native-parity/index|Native parity inventory]]
- [[docs/reference/native-parity/shell-and-settings|Native parity: shell, menus, dock and bridge]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/reference/scripts|Scripts Reference]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
