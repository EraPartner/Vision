---
title: "ADR-208: Finish phase 4 without web content"
type: adr
status: accepted
date: 2026-10-17
tags: [adr, architecture, swift, native-app, phase-4, demo, webkit, typescript, storage]
description: "Accepted on 2026-10-17 by Tor. Phase 4 ends with no web content at all: the helper document's calculations (command-palette answers, tax report profile and context) and its scoped storage move to Swift, and a default-off native-only mode stops creating the WKWebView until CI parity and the macOS smoke prove it. Amends ADR-207's 'TypeScript calculations stay' decision."
aliases: [adr-208, native without web content]
---

# ADR-208: Finish phase 4 without web content

## Status

Accepted on 2026-10-17 by Tor. It amends [[docs/adr/207-vision-native-helper-document|ADR-207]]:
the helper document becomes a transition step, not the end state. New authorities stay
default-off until CI proves parity, as with ADR-206 and ADR-207.
[[docs/adr/205-vision-native-hand-over|ADR-205]]'s real-data switch-over sequence is unchanged.

## Date

2026-10-17

## Context

[[docs/adr/204-vision-native-swift-app-target|ADR-204]]'s phase-4 exit reads "no web content
left; bundle size and memory compared with the phase 0 baseline". After ADR-207 every route,
menu, overlay and report is native, but the Debug Demo still loads a hidden, same-origin helper
document. It does three calculations in TypeScript and holds some browser storage:

- `__visionNativePaletteAnswer`: the command palette's arithmetic and currency answers
  (`lib/commandPalette.ts`, `lib/nativePaletteAnswer.ts`);
- `__visionNativeTaxReportProfile`: the household-to-profile projection for the tax report
  (`lib/nativeTaxReportProfile.ts`);
- `__visionNativeTaxReportContext`: the tax report context, which runs the household tax engine
  (`lib/nativeTaxReportContext.ts`);
- the allowlisted `localStorage`/`sessionStorage` keys reached through fixed storage scripts.

A hidden web document is still web content: it ships the WebKit content process, the bundled
frontend and its memory. Tor chose to port these pieces rather than to read the exit as "no web
UI".

## Decision

1. **Port the calculations to Swift**, each behind the same native seam its caller already uses,
   with tests that mirror the TypeScript suites and the source's output on edge cases:
   - palette answers: `NativePaletteCalculator` and `NativePaletteRates` (done 2026-10-17);
   - tax report profile and context: computed natively, with the household engine reached
     through the backend tax endpoint that already serves the native Tax screens.
2. **Move the helper's storage to the native raw-state store** (`NativeRawStateStore`), with a
   one-time, source-identified capture from the existing web store as the store's own gates
   require. Unknown keys survive; nothing is deleted from the web store by the capture.
3. **Add a native-only shell mode** that never creates the WKWebView. Like the helper mode it is
   Debug Demo only and default-off until the native suites and the macOS end-to-end smoke pass
   on the mode, then it becomes the Debug Demo default with an explicit opt-out.
4. **Measure it.** The end-to-end smoke records bundle size and resident memory for the retained,
   helper and native-only modes and for the Electron Demo as the phase-0 baseline, which was
   never recorded.

## Implementation (2026-10-17)

- **Palette answers:** `NativePaletteCalculator` and `NativePaletteRates`
  (`apps/native/Sources/VisionNativeCore/Navigation/NativePaletteCalculator.swift`) in every mode.
- **Tax report:** `NativeTaxReportProfile` projects the three report fields;
  `GET /api/belgian-tax/overview` now accepts every four-digit year, so the TypeScript fallback for
  years outside 1900–2200 is gone (`NativeTaxReportContext.swift`).
- **Selection:** `VISION_NATIVE_WEB_FREE=1` selects `NativeHelperDocumentSelection.nativeOnly` under
  the helper's eligibility rules (Debug build, Demo variant, supervised loopback runtime) and takes
  precedence over the helper opt-in. `NativeShellPresentationMode.nativeOnly` shares the helper's
  readiness rules.
- **Storage:** `NativeShellStorage` answers each fixed page-storage script from `NativeRawStateStore`
  at `native/<runtimeId>/raw-state.json`; the shell keeps every admission, generation and restore
  fence. On first use `NativeStorageCapture` (app target) loads the backend's `/health` document in
  a transient, unpresented web view, captures the origin's storage once and releases the view. A
  complete capture with no data is recorded as an empty start; a migrated store opens under its
  recorded source after a port change; any failure shows the unavailable state (Tor's decisions,
  2026-10-17).
- **Host:** the shell builds its root view without a web view, marks the graph's document ready
  and runs the shared startup; reload is the graph rebuild.
- **Evidence:** the e2e smoke's `native` mode launches the Debug Demo with
  `VISION_NATIVE_WEB_FREE=1`, waits for `/health` and "native-only document ready", and records
  bundle size and memory beside the retained, helper and Electron numbers. It first passed on run
  39065530611 (2026-10-17); the numbers are in
  [[docs/reference/native-parity/agent-handoff|the agent handoff]].

## Consequences

- Phase 4 can meet ADR-204's exit literally. The retained web document and the helper remain
  available as fallbacks until the native-only mode is the default and the owner removes them.
- Each port is a parity risk: the tests must pin the source's behaviour, not a new reading of it.
  Formatting follows Foundation's ICU data, which the native app already uses everywhere.
- Storage moves only on the synthetic Demo data; real data stays under ADR-205.

## Related

- [[docs/adr/204-vision-native-swift-app-target|ADR-204: Vision Native]]
- [[docs/adr/205-vision-native-hand-over|ADR-205: Vision Native hand-over]]
- [[docs/adr/206-vision-native-staged-web-retirement|ADR-206: Staged web retirement]]
- [[docs/adr/207-vision-native-helper-document|ADR-207: Helper document]]
- [[docs/reference/native-parity/agent-handoff|Vision Native agent handoff]]
