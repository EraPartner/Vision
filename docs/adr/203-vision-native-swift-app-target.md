---
title: "ADR-203: Vision Native is a Swift app target that replaces the Electron shell in phases"
type: adr
status: accepted
date: 2026-10-12
tags:
  [
    adr,
    swift,
    swiftui,
    macos,
    native-app,
    electron,
    packaging,
    rewrite,
    parity,
    adr-072,
    adr-113,
    adr-196,
  ]
description: "Records the owner's 2026-10-11 decisions for Vision Native, a separate Swift app under apps/native/ with its own bundle identifier and isolated data directory that runs only on the synthetic Demo dataset until a verified phase-4 switch-over. Apple-silicon Macs on current macOS, Swift 6 with SwiftPM and Swift Testing, local install with a free personal-team signature, no updater, backend and data unchanged. CI choice pending. Supersedes nothing yet."
aliases: [adr-203, vision native, swift native app, swift rewrite]
---

# ADR-203: Vision Native is a Swift app target that replaces the Electron shell in phases

## Status

Accepted on 2026-10-12 (decisions by Tor on 2026-10-11). It supersedes nothing yet.
[[docs/adr/072-electron-native-desktop-integration|ADR-072]],
[[docs/adr/113-native-macos-runtime|ADR-113]] (the Electron host part only; the PostgreSQL runtime
contract stays) and [[docs/adr/196-electron-shell-typescript|ADR-196]] remain in force for the
Electron app until phase 1 exits. A follow-up ADR then records the hand-over. Section 10 (CI) is
pending Tor's decision.

## Date

2026-10-12

## Context

Vision began as a website. Today a TypeScript Electron shell (`packaging/electron/`) hosts the
React frontend (`apps/frontend/`) and supervises the Bun backend and a bundled PostgreSQL 18
runtime (`packaging/electron/runtime/native.ts`). Tor wants better performance, better platform
support and closer parity with Apple's own apps, and asked for a phased rewrite in Swift: the shell
and the frontend first, the backend possibly later.

Facts about today's app that this decision builds on:

- Two Electron apps exist. "Vision" has app id `com.vaultvoyager.vision`
  (`packaging/electron/package.json`). "Vision Demo" has `com.vaultvoyager.vision-demo` and ships a
  `resources/DEMO` marker (`packaging/electron/electron-builder-demo.json`).
- Each app has its own data directory. `main.ts` names the app "Vision" or "Vision Demo" before
  any `userData` lookup and picks the runtime id (`packaging/electron/main.ts`, "App identity").
  The runtime keeps its data under `<userData>/native/<runtimeId>/`
  (`createNativeRuntime` in `packaging/electron/runtime/native.ts`).
- The runtime marker is `runtime-state.json` in that directory. It records `runtimeId` and
  `activeRuntime` (`readState`, `writeState` and `assertNativeActive` in `runtime/native.ts`).
  Exclusive use comes from the Electron single-instance lock, which lives in `userData`
  (`app.requestSingleInstanceLock()` in `main.ts`), and from PID files whose owner is checked
  before any signal (`BACKEND_PID_OWNERSHIP_MISMATCH` in `runtime/native.ts`). None of these
  checks coordinates with a second, non-Electron app, so a Swift app writing the same directory
  would not be stopped by them (inferred). Vision Native therefore gets its own directory.
- Both apps are built locally and unsigned: `identity: null`, `hardenedRuntime: false` and
  `gatekeeperAssess: false` (`packaging/electron/electron-builder-base.json`). `install.sh` and
  `install-demo.sh` build with `CSC_IDENTITY_AUTO_DISCOVERY=false` and copy the bundle to
  `/Applications`. Only `arm64` targets are built (`package.json`, `electron-builder-demo.json`).
- The audit Keychain witness uses an ad-hoc signed helper, and an app identity change can prompt
  or make verification unavailable ([[docs/adr/158-macos-keychain-audit-witness|ADR-158]]).
- The Belgian tax engine runs in the renderer, not the backend (`apps/frontend/src/lib/belgianTax/`),
  so a native Tax screen cannot simply call an existing endpoint.
- The shell has its own updater (`packaging/electron/updater.ts`,
  `packaging/electron/native-update-installer.ts`).
- All CI jobs run on `ubuntu-24.04` (`.github/workflows/ci.yml`). Linux cannot build macOS apps.

## Decision

1. **Vision Native target.** A new Swift app, "Vision Native", lives under `apps/native/`. It uses
   SwiftUI, and AppKit where SwiftUI lacks a control. It is separate from the Electron "Vision"
   app and from "Vision Demo". Its bundle identifier is `com.vaultvoyager.vision-native`, and it
   has its own isolated data directory. Until the final switch-over it runs only against the
   synthetic Demo dataset, never Tor's real data directory, because no runtime check stops two
   apps from writing one data directory (see Context). The Electron app stays Tor's daily app
   until the verified switch-over in phase 4.
2. **Platform.** Apple-silicon Macs on current macOS only. The deployment target is the macOS
   major release installed on the development Mac when phase 1 starts. It is recorded in the
   Xcode project and may be raised at any time. There is no Intel, Windows, Linux or browser
   build.
3. **Toolchain.** Xcode on the Mac, Swift 6 language mode with strict concurrency, and Swift
   Testing for tests. All non-UI logic lives in SwiftPM packages, so `swift build` and
   `swift test` work without the Xcode UI. Phase 1's first PR decides how the app project file is
   produced:
   - Hand-maintained `.xcodeproj`: no extra tool, but merge conflicts in a generated format.
   - XcodeGen from a committed `project.yml`: reviewable diffs, but one more dev-only tool.
   - SwiftPM only, with a script-built bundle: no project file, but signing, resources and
     entitlements are scripted by hand.

   The default is XcodeGen as a dev-only tool, with the `.xcodeproj` gitignored. This default is
   pending Tor's confirmation.

4. **Distribution.** Local build only. An `install-native.sh` next to `install.sh` runs
   `xcodebuild` and copies the app to `/Applications`. The app is signed with Xcode's free
   personal team (an Apple ID, no paid Developer ID), so the signature is stable between builds.
   There is no notarization, no App Store and no Developer ID. Today's Electron app is already
   unsigned (`electron-builder-base.json`). An ad-hoc signature that changes on every build could
   re-prompt for Keychain access and affect the audit Keychain witness of ADR-158 (inferred).
   That is why the personal-team identity is used.
5. **No updater and no releases.** `updater.ts` and `native-update-installer.ts` are not ported.
   The install script is the update path. Tor approved this cut on 2026-10-11 at 16:02 UTC. It is
   the only functionality cut allowed under the parity rule.
6. **Backend and data unchanged.** Through phases 0 to 4 these stay as they are: the TypeScript
   backend on Bun, PostgreSQL 18, Alembic, the AEAD backup format v2
   ([[docs/adr/040-backup-format-v2-aead-encryption|ADR-040]]) and the isolated data directory.
   A Swift backend is a separate, later decision (phase 5). The Belgian tax engine is TypeScript
   and is never recomputed in Swift. Today it runs in the frontend
   (`apps/frontend/src/lib/belgianTax/`, about 9,500 lines, lazy-loaded by
   `apps/frontend/src/contexts/BelgianTaxProfileContext.tsx`); the backend only stores the
   profile and renders the PDF report. The rewrite plan assumed it was a backend service. Before
   the Tax screen moves to SwiftUI (phase 3), the engine is exposed by the backend behind an
   OpenAPI operation, so that SwiftUI only displays its results. Pending Tor's decision
   (2026-10-12); porting the engine to Swift is the alternative, under differential testing.
7. **Look.** Vision Native looks more Apple-native than today, with native macOS controls and
   styling. It is not a pixel recreation. Three things must match today's app: the colours (the
   design tokens of [[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]] to ADR-190), the
   navigation structure and the chart layouts. Golden screenshots from phase 0 check these three.
8. **Rules carried into every phase.**
   - Parity rule: no functionality cut. Every screen PR shows where each inventoried action
     lives. The inventory is at `docs/reference/native-parity/`.
   - One source for EN/NL copy: `i18n/source/en.json` and `nl.json` generate the String Catalogs.
     Nothing is retyped.
   - Money is Foundation `Decimal`, never `Double`. A lint rule enforces this.
   - Each phase starts only on Tor's explicit go.
   - Electron stays shippable until phase 1 exits. Every web route stays until its native
     replacement passes parity.
9. **Execution model (hybrid).** Cloud agent threads write the Swift code on `claude/*` branches
   with draft PRs. Remote Control on Tor's Mac, in `/Users/computer/Code/Vision`, only builds, runs
   tests and takes screenshots. It never commits, because commits need Touch ID signing. Linux
   containers cannot build macOS apps.
10. **CI. Pending Tor's decision (2026-10-12).**
    - (a) A GitHub-hosted macOS runner job in `ci.yml` builds and tests the Swift package and the
      app on every PR. The repository is public, so GitHub-hosted runners are free for it. The Mac
      is used only for screenshots and the Demo app.
    - (b) No CI gate. Checks run only on Tor's Mac.
    - (c) A self-hosted runner on Tor's Mac. Rejected by default: on a public repository it
      exposes the Mac to code from fork PRs.

    Option (a) is the proposed default.

11. **Phases** (from the 2026-10-11 rewrite plan):
    - 0: Decide and baseline: this ADR, performance baseline, parity inventory, golden screenshots.
    - 1: A Swift shell hosts the current React build in a `WKWebView`.
    - 2: Native foundations: OpenAPI client, design tokens, String Catalogs, navigation shell.
    - 3: Screens move to SwiftUI one at a time.
    - 4: Retire the web UI. Needs Tor's OK and a new ADR.
    - 5: Optional Swift backend, as a separate decision.

## Consequences

### Positive

- Native controls, menus and windowing come from AppKit and SwiftUI rather than from Chromium.
- Vision Native cannot touch real data before the switch-over: it has its own bundle identifier
  and data directory and runs on the Demo dataset only.
- The phases keep a working app at every step. Electron stays shippable until phase 1 exits.
- A stable personal-team signature avoids per-build identity changes for the Keychain witness
  (inferred).
- CI on GitHub-hosted macOS runners costs nothing for a public repository.

### Negative

- Two apps must be maintained during the transition, and every shell fix may be needed twice.
- In phase 1 the React UI renders in WebKit instead of Chromium. CSS, fonts, charts and PDF
  output can differ, so every screen is checked against the golden screenshots.
- The updater is cut. Updates need a local rebuild with `install-native.sh`.
- macOS runners are slower than the Linux runners, so PR checks take longer under option (a).
- Without notarization or a Developer ID the app runs only on Macs that built it or trust the
  personal team (inferred).

### Neutral

- The backend, PostgreSQL 18, Alembic, the backup format and the tax engine do not change in
  phases 0 to 4.
- ADR-072, ADR-113 and ADR-196 stay in force for the Electron app until a follow-up ADR records
  the hand-over at phase 1's exit.
- The project-file tool and the CI option are still open and are settled in phase 1.

## Phase gates

| Phase | Exit                                                                                  |
| ----- | ------------------------------------------------------------------------------------- |
| 0     | This ADR merged, baseline numbers recorded, parity inventory committed under `docs/`. |
| 1     | Feature parity with Electron, backup round-trip tests pass both ways, hand-over ADR.  |
| 2     | One trivial screen runs natively end to end in EN and NL, with tests.                 |
| 3     | Per screen: parity list complete and Tor's visual pass on the Demo app.               |
| 4     | No web content left; bundle size and memory compared with the phase 0 baseline.       |
| 5     | Decided separately after phase 4.                                                     |

Every phase starts only on Tor's explicit go.

## Related

- [[docs/adr/072-electron-native-desktop-integration|ADR-072]]
- [[docs/adr/113-native-macos-runtime|ADR-113]]
- [[docs/adr/158-macos-keychain-audit-witness|ADR-158]]
- [[docs/adr/180-sidebar-sections-replace-workspaces|ADR-180]]
- [[docs/adr/196-electron-shell-typescript|ADR-196]]
- [[docs/architecture/electron|Electron architecture]]
- [[docs/reference/native-parity/index|Native parity inventory]]
- [[docs/adr/index|All ADRs]]
