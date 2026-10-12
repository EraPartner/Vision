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
    adr-204,
  ]
description: "Vision Native is the Swift macOS app under apps/native/ that replaces the Electron shell in phases (ADR-204). Covers the directory layout, the runtime supervisor that starts its own PostgreSQL 18 cluster and backend on synthetic Demo data, payload discovery, the Debug-only backend override, the Native (macOS) CI job and install-native.sh."
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
| `apps/native/VisionNative/`                     | SwiftUI `App`, the `WKWebView` shell and the "backend not running" placeholder        |
| `apps/native/Package.swift`                     | SwiftPM package (Swift 6 language mode) with the `VisionNativeCore` library, no deps  |
| `apps/native/Sources/VisionNativeCore/`         | `BackendLocator` and `BackendHealth`: non-UI logic, testable without the Xcode UI     |
| `apps/native/Sources/VisionNativeCore/Runtime/` | Runtime supervisor, PostgreSQL and backend lifecycle, Demo seeding, system seams      |
| `apps/native/Tests/VisionNativeCoreTests/`      | Swift Testing tests                                                                   |
| `install-native.sh`                             | Local Release build and install to `/Applications/Vision Native.app`                  |

The generated `apps/native/VisionNative.xcodeproj`, its `Info.plist`, `apps/native/build/` and
the SwiftPM state are gitignored. The app target uses Swift 6 with complete strict concurrency,
automatic signing, no hardened runtime and no App Sandbox, because the app supervises the bundled
PostgreSQL runtime as child processes. App Transport Security allows only local networking
(`NSAllowsLocalNetworking`).

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

1. `VISION_NATIVE_RUNTIME_DIR`: an absolute path to a prepared `native-runtime` directory (for
   example `packaging/electron/native-runtime` or `apps/native/build/payload/native-runtime`).
2. `Contents/Resources/runtime/` in the app bundle, which `install-native.sh` stages.

The synthetic seed is the `demo-seed/` sibling of the runtime directory in both cases. A missing
payload fails with `NATIVE_RUNTIME_MISSING`, and the window shows the reason, the install command
and the Retry button. Before any process starts, every file must match `manifest.json` (size and
SHA-256, no unlisted, symlinked or special files), and `postgres/runtime.json` and
`chromium/runtime.json` must pin the expected versions for this platform and architecture.

### Start sequence

`ShellResolver` calls `RuntimeSupervisor.launch()`. Concurrent calls share one launch, and a call
after a failure retries.

1. Take the exclusive lock on `vision-native.lock`. A second instance fails with
   `NATIVE_ALREADY_RUNNING`.
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
   another process fails closed. A backend `PORT_COLLISION` re-picks the app port once.
6. After a seed switch, wait for `/health/detailed` to report a connected database, recheck the
   stable counts and finalize the switch. Any failure rolls the switch back.
7. Poll `GET /health/detailed` (20 probes at 100 ms, then every 300 ms, about 3 minutes) and load
   `http://localhost:<appPort>`. A timeout copies the redacted tail of `backend.log` into
   `main.log`.

### Stop sequence

On quit the app delegate answers `terminateLater` and calls `RuntimeSupervisor.shutdown()` with
a 45-second hard limit. When `keepServicesOnQuit` is on (the database setting first, then the
`settings.json` mirror), both processes keep running. Otherwise the backend gets `SIGTERM` and,
after 10 seconds, `SIGKILL`, and PostgreSQL stops with `pg_ctl stop -m fast`. Vision Native
signals a recorded PID only when `ps -o command=` shows its own `vision-backend`, removes stale
records, and treats PIDs of 1 or less as untrusted. On the next launch a healthy backend from an
earlier run is reused.

Phase 1b leaves out backup on quit and directory-switch tokens (phase 1d), the audit anchor and
Keychain witness (phase 1e), external PostgreSQL clusters, the Bun source mode and the health
watchdog that restarts a crashed backend.

### Developer override

In Debug builds only, `VISION_NATIVE_BACKEND_URL` skips supervision and loads an already running
backend. The URL must be absolute `http` or `https` with a loopback host (`localhost`,
`127.0.0.1` or `::1`). Any other value, and the variable in a Release build, is ignored with a
logged reason. `BackendHealth.status` then checks `GET <base>/health` before loading. Debug builds
make the web view inspectable with the Safari Web Inspector.

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
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/reference/scripts|Scripts Reference]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
