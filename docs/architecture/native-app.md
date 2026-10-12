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
    adr-203,
  ]
description: "Vision Native is the Swift macOS app under apps/native/ that replaces the Electron shell in phases (ADR-203). Covers the directory layout, how the app finds the backend (VISION_NATIVE_BACKEND_URL, then the Vision Demo appPort), the Native (macOS) CI job and install-native.sh."
aliases: [vision native, native app, swift app]
---

# Vision Native App Architecture

> [!abstract] Overview
> Vision Native is a separate Swift app, bundle identifier `com.vaultvoyager.vision-native`, that
> replaces the [[docs/architecture/electron|Electron shell]] in phases
> ([[docs/adr/203-vision-native-swift-app-target|ADR-203]]). In phase 1 it hosts the existing
> React frontend in a `WKWebView`. It runs on the synthetic Vision Demo data only. The Electron
> "Vision" app stays the daily app until the phase 4 switch-over.

## Layout

| Path                                       | Purpose                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `apps/native/project.yml`                  | XcodeGen spec: project `VisionNative`, macOS app target "Vision Native", macOS 26.0   |
| `apps/native/Config/Signing.xcconfig`      | `DEVELOPMENT_TEAM` from `VISION_NATIVE_TEAM_ID`, optional gitignored `Local.xcconfig` |
| `apps/native/VisionNative/`                | SwiftUI `App`, the `WKWebView` shell and the "backend not running" placeholder        |
| `apps/native/Package.swift`                | SwiftPM package (Swift 6 language mode) with the `VisionNativeCore` library, no deps  |
| `apps/native/Sources/VisionNativeCore/`    | `BackendLocator` and `BackendHealth`: non-UI logic, testable without the Xcode UI     |
| `apps/native/Tests/VisionNativeCoreTests/` | Swift Testing tests                                                                   |
| `install-native.sh`                        | Local Release build and install to `/Applications/Vision Native.app`                  |

The generated `apps/native/VisionNative.xcodeproj`, its `Info.plist`, `apps/native/build/` and
the SwiftPM state are gitignored. The app target uses Swift 6 with complete strict concurrency,
automatic signing, no hardened runtime and no App Sandbox, because a later phase supervises the
bundled PostgreSQL runtime. App Transport Security allows only local networking
(`NSAllowsLocalNetworking`).

## Finding the backend

Vision Native does not start a backend in this phase. `BackendLocator.locate` resolves the base
URL in this order:

1. `VISION_NATIVE_BACKEND_URL`, an absolute `http` or `https` URL with a host. A set but malformed
   value is an error, not a fallback.
2. The integer `appPort` (1024 to 65535) in `~/Library/Application Support/Vision Demo/settings.json`,
   as `http://localhost:<appPort>`. The Electron Vision Demo app writes this file
   (`resolveAppPort` in `packaging/electron/main.ts`; the folder name is `DEMO_USER_DATA_NAME` in
   `packaging/electron/runtime/native-demo.ts`). Vision Native only reads it.
3. Otherwise no backend is found.

`BackendHealth.status` then sends `GET <base>/health`. The window loads the frontend only when it
answers 200. Otherwise it shows the reason and a Retry button. Debug builds make the web view
inspectable with the Safari Web Inspector.

## CI

Linux cannot build macOS apps, so the `native-macos` job ("Native (macOS)") in
`.github/workflows/ci.yml` runs on the GitHub-hosted `macos-26` runner. It installs XcodeGen,
generates the project, builds the Debug app with `CODE_SIGNING_ALLOWED=NO` and runs
`swift test --package-path apps/native`. The `changes` job sets `native` to true when a pull request
touches `apps/native/`, `install-native.sh` or `ci.yml`, on every push and whenever the diff cannot
be classified (`scripts/ci-classify.py`). Quality Gate needs the job and tolerates `skipped`, so a
failed native build or test blocks "CI Complete" through Quality Gate.

## Install

`install-native.sh` requires `xcodegen` and `xcodebuild`, generates the project, builds Release
into `apps/native/build/` and replaces `/Applications/Vision Native.app`. With
`VISION_NATIVE_TEAM_ID` set it signs automatically with the free personal team, so the signature
stays stable between builds. Without it the app is signed ad-hoc and the script warns that the
signature changes on every build. There is no updater: rerunning the script is the update path.

## Related

- [[docs/adr/203-vision-native-swift-app-target|ADR-203]]
- [[docs/reference/native-parity/index|Native parity inventory]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/reference/scripts|Scripts Reference]]
