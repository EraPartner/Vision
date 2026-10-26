---
title: "ADR-214: Retire the Vision Native Swift port"
type: adr
status: superseded
date: 2026-10-19
tags:
  [
    adr,
    architecture,
    swift,
    native-app,
    electron,
    typescript,
    retirement,
    adr-204,
    adr-213,
  ]
description: "Accepted on 2026-10-19 by Tor. The Vision Native Swift app (ADR-204 and its follow-ups ADR-205 and ADR-209 to ADR-212) is retired and the proposed Swift backend (ADR-213) is withdrawn. Electron with the React/TypeScript frontend and the TypeScript backend stays the only desktop app; the Electron native PostgreSQL runtime, Vision Demo and the shared TypeScript logic and endpoints extracted during the port stay."
aliases: [adr-214, retire vision native, retire swift port]
---

# ADR-214: Retire the Vision Native Swift port

> [!note] Superseded by [[docs/adr/249-revive-swift-app|ADR-249]] on 2026-10-25.
> [[docs/adr/254-remove-swift-app|ADR-254]] retired ADR-249 again on 2026-10-26.

## Status

Accepted on 2026-10-19 by Tor. It supersedes
[[docs/adr/204-vision-native-swift-app-target|ADR-204]],
[[docs/adr/205-vision-native-hand-over|ADR-205]],
[[docs/adr/209-vision-native-staged-web-retirement|ADR-209]],
[[docs/adr/211-vision-native-without-web-content|ADR-211]] and
[[docs/adr/212-vision-native-retire-helper-document|ADR-212]], ends the chain that
[[docs/adr/210-vision-native-helper-document|ADR-210]] (already superseded by ADR-212) belonged to,
and rejects the proposed [[docs/adr/213-vision-native-swift-backend|ADR-213]].

## Date

2026-10-19

## Context

ADR-204 started Vision Native, a separate Swift/SwiftUI macOS app under `apps/native/` that was
to replace the Electron shell in phases. ADR-205 recorded its phase 1 hand-over, ADR-209 to
ADR-212 moved the Debug Demo towards native routing and no web content, and ADR-213 proposed
replacing the TypeScript backend with a Swift backend inside the app. Real data never moved to
the Swift app: it ran only on the synthetic Demo dataset, and the Electron app stayed the
product throughout.

On 2026-10-19 Tor decided to stop:

> "I don't like the swift port ... we tried but this is not something i want to continue
> pushing, the typescript stuff is just too good."

## Decision

Retire the Swift port. The Electron desktop app with the React/TypeScript frontend and the
TypeScript backend is the only desktop app. ADR-213 is rejected and withdrawn; no Swift backend
is built.

Removed from the repository:

- The Swift app `apps/native/` (SwiftUI screens, WKWebView shell, XcodeGen project, Swift
  backup, audit and runtime code) and `install-native.sh`.
- The Swift code generators and their tests: `scripts/native-{baseline,design-tokens,navigation,openapi,strings}.ts`,
  `scripts/lib/nativeCodegen.ts`, `scripts/tests/native-generators.test.ts`, the
  `native:generate*` and `demo:reset-vision-native` package scripts, and the `x-swift-type`
  extensions in `openapi.yaml`.
- The Swift CI: `.github/workflows/native-branch.yml`, `native-e2e.yml`,
  `.github/scripts/native-e2e-smoke.sh`, the `native-macos` and `native-interop` jobs in
  `ci.yml` and the `native` output of `scripts/ci-classify.py`.
- The Electron-side interop and fixtures for the Swift app:
  `packaging/electron/backup/native-interop.test.ts`,
  `packaging/electron/scripts/native-audit-fixture.ts` and the "Vision Native" and "Vision Native
  Demo" targets of `native-demo-cli.ts` and `runtime/native-demo.ts`.
- The frontend bridges that only the Swift shell used: `nativeShell`, `nativePaletteAnswer`,
  `nativeHelperRuntime`, `nativeRouteAdapter`, `nativeTaxReport*`, `nativeSettings` hydration,
  `NativePaletteAnswerBridge`, `useReportDialogState`, the `window.__VISION_NATIVE_*` flags, the
  native navigation menu actions (`nativeNavigation`, `routeChanged`, `replace-route`,
  `open-palette`, `native-sidebar`, `close-settings`), `isNativeSettings` and the
  `html.native-navigation` CSS.
- The Swift-only documentation: the native app architecture page, the Swift backend port
  playbook and the native parity inventory.

Kept:

- The Electron native runtime: the bundled native PostgreSQL 18 runtime
  (`packaging/electron/runtime/native.ts`), its `VISION_NATIVE_*` environment variables,
  `native:smoke`, `demo:reset-native`, Vision Demo and
  `packaging/electron/audit-keychain.swift`, as recorded in
  [[docs/adr/113-native-macos-runtime|ADR-113]], [[docs/adr/114-native-deterministic-demo-runtime|ADR-114]],
  [[docs/adr/133-native-only-runtime-and-delivery|ADR-133]] and
  [[docs/adr/207-coordinated-native-recovery|ADR-207]]. "Native" in those names means the
  bundled runtime of the Electron app, not the Swift port.
- Backend endpoints and shared TypeScript logic added or extracted during the port, such as
  `GET /api/belgian-tax/dashboard`, the research presentation and forecast endpoints, the
  Belgian tax engine in `@vision/shared-utils` and the frontend, and `taxReportContext`. They
  are ordinary API surface and shared code now, documented without reference to the Swift app.

## Consequences

- One desktop app and one backend to maintain. [[docs/adr/072-electron-native-desktop-integration|ADR-072]],
  [[docs/adr/113-native-macos-runtime|ADR-113]] and [[docs/adr/196-electron-shell-typescript|ADR-196]]
  stay in force without the phase-out ADR-204 planned.
- ADR-205's phase-4 switch-over steps (data directory, Keychain service names, iCloud backup
  folder, audit key and witness migration) never happen; the Electron app keeps its data
  directory and audit anchor unchanged.
- The superseded ADRs stay as history. Their links to the removed documentation pages are kept
  as plain text.
- Future agents must not restart a Swift or other native rewrite of Vision, or reintroduce
  Swift app code, generators or CI, without a new ADR accepted by Tor.

## Related

- [[docs/adr/204-vision-native-swift-app-target|ADR-204: Vision Native]]
- [[docs/adr/213-vision-native-swift-backend|ADR-213: Swift backend (rejected)]]
- [[docs/architecture/electron|Electron architecture]]
- [[docs/guides/native-macos-runtime|Native macOS runtime]]
- [[docs/adr/index|All ADRs]]
