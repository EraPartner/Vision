---
title: "ADR-209: Retire the helper document"
type: adr
status: accepted
date: 2026-10-18
tags: [adr, architecture, swift, native-app, phase-4, demo, webkit, typescript]
description: "Accepted on 2026-10-18 by Tor. With native-only the passing Debug Demo default, the ADR-207 helper document is removed from the app, frontend build and backend; the retained web document stays as the explicit opt-out and for every ineligible build. Native-only stays limited to the Debug Demo."
aliases: [adr-209, retire helper document]
---

# ADR-209: Retire the helper document

## Status

Accepted on 2026-10-18 by Tor. It supersedes [[docs/adr/207-vision-native-helper-document|ADR-207]]'s
helper document and completes the "owner removes them" step in
[[docs/adr/208-vision-native-without-web-content|ADR-208]]'s consequences for the helper only.
ADR-207's eligibility rules (Debug build, Demo variant, supervised loopback runtime) still gate
the native-only mode. [[docs/adr/205-vision-native-hand-over|ADR-205]] is unchanged.

## Date

2026-10-18

## Context

Since ADR-208 every calculation the helper document hosted runs in Swift in every mode, and its
storage lives in `NativeRawStateStore`. Native-only became the Debug Demo default once the native
suites (run 39067544787) and the macOS smoke passed, and run 39069586078 passed the retained,
helper, native-only and Electron smokes together. The helper was then reachable only through an
explicit `VISION_NATIVE_HELPER_DOCUMENT=1`, yet it still shipped a second Vite entry, a backend
route namespace, a WebKit bridge and its session authority.

## Decision

1. **Remove the helper document:** `native-helper.html`, its entry and owner
   (`native-helper.ts`, `lib/nativeHelperDocument.ts`), the helper Vite build
   (`scripts/build-native-helper.ts`, `build:native-helper`), the backend's reserved
   `/native-helper.html` and `/native-helper-assets` router, the Swift bridge, session and
   presentation case, `WebShell`'s helper handler and navigation tracking, and the e2e helper mode.
   `VISION_NATIVE_HELPER_DOCUMENT` no longer has any effect.
2. **Keep the retained web document** as `VISION_NATIVE_WEB_FREE=0`'s opt-out and for every
   launch the eligibility rules exclude (Release, standard variant, developer override). Its
   React page keeps `lib/nativeHelperRuntime.ts` for the keyboard overlay bridge.
3. **Keep native-only limited to the Debug Demo** until the manual Mac checks are done; a Release
   Demo default needs its own decision.

## Consequences

- Two presentations remain: `NativeDocumentSelection.retainedWeb` and `.nativeOnly`, chosen once
  per launch. Native-only's eligibility source is `NativeDocumentSource`.
- The shared native navigation startup (StartupRedirect mirror, last route) and the native
  document readiness state (`NativeDocumentState`) stay; they now belong to native-only alone.
- Removing the retained web document as well is a later decision, after the manual checks and
  outside ADR-205's real-data rule.

## Related

- [[docs/adr/204-vision-native-swift-app-target|ADR-204: Vision Native]]
- [[docs/adr/205-vision-native-hand-over|ADR-205: Vision Native hand-over]]
- [[docs/adr/207-vision-native-helper-document|ADR-207: Helper document]]
- [[docs/adr/208-vision-native-without-web-content|ADR-208: Finish phase 4 without web content]]
- [[docs/reference/native-parity/agent-handoff|Vision Native agent handoff]]
