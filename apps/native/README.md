# Vision Native

Vision Native is the Swift macOS app that replaces the Electron shell in phases
([ADR-204](../../docs/adr/204-vision-native-swift-app-target.md)). Phase 1 hosts the existing
React frontend in a `WKWebView`. It runs on the synthetic Vision Demo data only, never on the real
Vision data directory.

Requirements: an Apple-silicon Mac, Xcode 26 (macOS 26 deployment target) and XcodeGen.

## Layout

| Path                           | Purpose                                             |
| ------------------------------ | --------------------------------------------------- |
| `project.yml`                  | XcodeGen spec for the "Vision Native" app target    |
| `Config/Signing.xcconfig`      | Signing team from `VISION_NATIVE_TEAM_ID`           |
| `VisionNative/`                | SwiftUI app and the `WKWebView` shell               |
| `Package.swift`                | SwiftPM package with the `VisionNativeCore` library |
| `Sources/VisionNativeCore/`    | Non-UI logic: backend location and health probe     |
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

`./install-native.sh` generates the project, builds Release into `apps/native/build/` and copies
the app to `/Applications/Vision Native.app`. Set `VISION_NATIVE_TEAM_ID` to your free personal
team id (or put `VISION_NATIVE_TEAM_ID = <id>` in `apps/native/Config/Local.xcconfig`) for a
signature that stays stable between builds. Without it the build is signed ad-hoc, and the
signature changes on every build.

## Backend

The app does not start a backend. It uses, in order:

1. `VISION_NATIVE_BACKEND_URL`, an absolute `http` or `https` URL. A malformed value is an error.
2. `appPort` from `~/Library/Application Support/Vision Demo/settings.json`, which the Vision Demo
   app writes, as `http://localhost:<appPort>`.

If neither gives a URL, or `GET /health` does not answer 200, the window shows the reason and a
Retry button. Open Vision Demo first (`open "/Applications/Vision Demo.app"`).
