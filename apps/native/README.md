# Vision Native

Vision Native is the Swift macOS app that replaces the Electron shell in phases
([ADR-204](../../docs/adr/204-vision-native-swift-app-target.md)). Phase 1 hosts the existing
React frontend in a `WKWebView` and runs its own PostgreSQL 18 cluster and backend on synthetic
Demo data in `~/Library/Application Support/Vision Native/`. It never reads or changes the Vision
or Vision Demo data directories.

Requirements: an Apple-silicon Mac, Xcode 26 (macOS 26 deployment target) and XcodeGen.

## Layout

| Path                           | Purpose                                             |
| ------------------------------ | --------------------------------------------------- |
| `project.yml`                  | XcodeGen spec for the "Vision Native" app target    |
| `Config/Signing.xcconfig`      | Signing team from `VISION_NATIVE_TEAM_ID`           |
| `VisionNative/`                | SwiftUI app and the `WKWebView` shell               |
| `Package.swift`                | SwiftPM package with the `VisionNativeCore` library |
| `Sources/VisionNativeCore/`    | Non-UI logic: runtime supervision, health, override |
| `Tests/VisionNativeCoreTests/` | Swift Testing tests                                 |

`VisionNative.xcodeproj`, `VisionNative/Info.plist`, `build/`, `.build/` and
`Config/Local.xcconfig` are generated or local and are gitignored.

## Generate, build and test

Run from the repository root:

```bash
brew install xcodegen
xcodegen generate --spec apps/native/project.yml
xcodebuild -project apps/native/VisionNative.xcodeproj -scheme "Vision Native" -configuration Debug CODE_SIGNING_ALLOWED=NO build
swift test --package-path apps/native
```

## Install

`./install-native.sh` prepares the runtime payload (PostgreSQL 18, the compiled backend, Alembic,
Chrome Headless Shell and the synthetic Demo seed) with the same scripts as `install-demo.sh`,
into `apps/native/build/payload/`. It then generates the project, builds Release into
`apps/native/build/`, stages the payload into `Contents/Resources/runtime/` and
`Contents/Resources/demo-seed/` before signing, and copies the app to
`/Applications/Vision Native.app`. `VISION_NATIVE_SKIP_PAYLOAD=1 ./install-native.sh` builds
without a payload; the app then shows how to provide one.

Set `VISION_NATIVE_TEAM_ID` to your free personal team id, or put `VISION_NATIVE_TEAM_ID = <id>` in
`apps/native/Config/Local.xcconfig`, for a signature that stays stable between builds. Without
either the build is signed ad-hoc, and the signature changes on every build.

## Runtime

On launch the app takes a single-instance lock, verifies the payload against its `manifest.json`,
creates or reuses its private cluster on `127.0.0.1:54331`, activates the synthetic Demo seed when
it changed, starts the backend on a random loopback port (persisted as `appPort` in
`settings.json`) and loads the frontend once `/health/detailed` is ready. On quit it stops the
backend and PostgreSQL unless "keep services running on quit" is on. Logs are in
`~/Library/Application Support/Vision Native/logs/main.log` and
`native/vision_native/logs/{backend,postgres}.log` below the same folder.

The payload is found in this order:

1. `VISION_NATIVE_RUNTIME_DIR`, an absolute path to a prepared `native-runtime` directory, in
   Debug builds only. A Release build ignores it with a logged warning. The synthetic seed must
   be its `demo-seed` sibling.
2. `Contents/Resources/runtime/` in the app bundle.

Without a payload the window shows the reason and a Retry button. A failed launch stops the
backend it started and keeps PostgreSQL running, so Retry starts a fresh backend.

To run a Debug build against a payload, run `./install-native.sh` once (it leaves `native-runtime/` and `demo-seed/` in
`apps/native/build/payload/`), then set `VISION_NATIVE_RUNTIME_DIR` to
`<repo>/apps/native/build/payload/native-runtime` in the scheme's Run environment (Product > Scheme >
Edit Scheme > Run > Arguments).

## Developer backend override

In Debug builds only, `VISION_NATIVE_BACKEND_URL` skips supervision and loads a backend that is
already running, for example `http://localhost:3002`. The host must be `localhost`, `127.0.0.1` or
`::1`. Other hosts, malformed values and the variable in a Release build are ignored with a logged
reason, and the app starts its own runtime.

Apps launched from Finder or the Dock do not inherit your shell environment. Set both variables in
the Xcode scheme, or pass them with `open`:

```bash
open --env VISION_NATIVE_RUNTIME_DIR="$PWD/apps/native/build/payload/native-runtime" \
  "<DerivedData>/Build/Products/Debug/Vision Native.app"
```
