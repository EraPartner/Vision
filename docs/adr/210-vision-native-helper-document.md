---
title: "ADR-210: Isolate a helper document for native Demo presentation"
type: adr
status: superseded
date: 2026-10-19
tags: [adr, architecture, swift, native-app, phase-4, demo, webkit, typescript]
description: "Accepted on 2026-10-17 with the phase-4 go. A default-off Debug Demo experiment with native presentation and routing plus a same-origin helper document for unchanged TypeScript calculations and scoped storage, without React UI, live authority handover or real-data migration."
aliases: [adr-210, native helper document]
---

# ADR-210: Isolate a helper document for native Demo presentation

## Status

> [!note] Superseded on 2026-10-18 by
> [[docs/adr/212-vision-native-retire-helper-document|ADR-212]]: the helper document is removed;
> its eligibility rules still gate ADR-211's native-only mode. The chain ends in
> [[docs/adr/214-retire-vision-native-swift-port|ADR-214]] (2026-10-19), which retires the Swift port.

Accepted on 2026-10-17 (proposed 2026-10-15) with Tor's phase-4 go, default-off. The SDK
implements the mode behind an explicit `VISION_NATIVE_HELPER_DOCUMENT=1` opt-in that only a
Debug build of the Demo variant with a supervised backend honours (see *Implementation* below);
every other launch keeps the retained web document. Phase 3p and phase 4 completion still require their
actual validation gates. The separate switch-over in
[[docs/adr/205-vision-native-hand-over|ADR-205]] remains unchanged.

## Date

2026-10-15

## Context

The SDK still loads the React application, delegates route requests to its router and keeps
that document mounted beneath native screens. Native navigation, startup selection and raw
storage have testable preparatory Core APIs, but the default SDK has not switched authority.
[[docs/adr/209-vision-native-staged-web-retirement|ADR-209]] describes that staged foundation.

For a fresh isolated Demo session whose complete presentation is native, maintaining a second
React presentation and router adds another route, leave-guard and startup owner. The SDK still
needs several narrow document capabilities: local/session storage, three fixed source
TypeScript calculation callbacks and current-document readiness. Those capabilities do not
require React UI or a browser history stack.

An audit also found remaining React-owned SDK behavior. Merely loading an empty document
would break Settings and theme menu actions, cold CSV routing and vibrancy activation. A
missing helper artifact currently risks reaching the backend's SPA fallback, silently mounting
the original application again. These are implementation prerequisites, not completed work.

## Decision

Prepare a dedicated built HTML/TypeScript helper entry for an explicitly selected, fresh
**Debug Vision Native Demo** session. The experiment is off by default. Both the Debug build
condition and the exact Demo variant must hold; standard and Release builds cannot activate
it. There is no persisted opt-in, live authority flip or automatic fallback into this mode.
Building the artifact is a separate step from enabling its SDK configuration.

### Document and source-calculation ownership

The helper loads from the backend's existing trusted origin and website-data store. It has
no React DOM root, React Router, route components or hidden application UI. It does not import
the regular frontend boot entry or its settings/category preloads, CSS, fonts or dashboard.
Its asset URL identifies infrastructure and must never become the user's native location or
`vision.lastRoute`.

The entry owns one `QueryClient`, the existing source translation resources and the lifetime
of `startNativeHelperRuntime`. It retains the fixed palette answer, tax profile projection
and tax context callbacks, their argument validation and the existing lazy fiscal imports.
The TypeScript financial algorithms and formatting remain unchanged. No calculation moves
to Swift, and no arbitrary-code or general-purpose RPC capability is added.

The entry owns readiness after its fixed handlers and locale are installed. It must not rely
on `ElectronBridge` mounting to call `electronAPI.ready()`. The host must identify the expected
helper document and fence readiness by the current committed document and graph generation;
ordinary SPA readiness cannot stand in for successful helper bootstrap. Helper failure is a
native loading/error state, with no partially authorized application surface.

The build must keep normal-index dashboard and font preloads out of the helper HTML. The
existing `defaultRoutePreloadPlugin` processes HTML entries without that distinction, so
adding a second HTML input alone is insufficient. A missing helper HTML or required bootstrap
asset must fail closed. The backend must not return `index.html` through its SPA fallback for
that missing artifact, and the host must not accept the SPA as the helper. The normal web and
Electron entry retain their existing boot and fallback behavior.

### Native ownership required before activation

- **Routes and startup:** supply the native history authority, preserve exact accepted raw
  locations and query spelling, and own startup/last-route capture and mirrors. A new session
  seeds one history visit; a document reload preserves history and applies any source startup
  replacement to its current entry. Keep route admission, decoded parameter policy and
  admin/legacy redirects separate from raw startup selection. No browser history is imported.
- **Menus and cold actions:** route Settings open/close, section selection, reports, appearance
  mode and history commands through native owners. Current SDK menu dispatch alone does not
  open native Settings or set its theme. Preserve cold Finder CSV and new-transaction intents
  through settings hydration and graph reconstruction, then route them once to the native
  screen. No required action can wait for an absent React menu or CSV subscriber.
- **Appearance and chrome:** bind native effective visual-effects tier to host vibrancy.
  Currently the React `ElectronBridge` effect supplies that call. Account for the custom
  `.app-topbar` drag/double-click bridge when establishing native window chrome; document
  actual AppKit behavior rather than assuming that an absent DOM region still works.
- **Loading, fallback and print:** keep the helper permanently outside presentation. Replace
  transient or unsupported `.web` detail states with explicit native loading/error/fallback
  behavior. Never expose or print the helper document as the user's current page. Native
  notices, onboarding, FX/upcoming banners, Dock badge and external-link actions retain their
  existing native owners.

The current `nativeNavigation` bridge flag means native sidebar presentation; it must not be
silently redefined as this experiment's route or document capability.

### Storage, reload and restore

The experiment does not require activating the preparatory native raw-state store. Existing
fixed same-origin storage scripts can remain, including the current local/session allowlists,
missing-versus-empty-versus-`"null"` semantics, backup registry, admin-token session lifetime
and legacy theme reads. Any later storage takeover has its own capture and source-identity
gates. No data is copied from another app or a real browser profile to make this experiment
start.

Normal reload still drains whole accepted native actions before pausing their writers.
Restore retains its distinct retirement semantics: failures resume the same authority;
success retires old callbacks, applies restored frontend state and awaits fresh onboarding
acknowledgment before the delayed reload. Physical HTTP and WebKit callback completion,
including completion after a logical timeout, remains part of the drains. Readiness and
input fences remain held through graph replacement until the new committed document is
accepted. The absence of React does not shorten these lifetimes. Legacy web-owned restore
calls must have an explicit mode policy rather than silently depending on nonexistent UI.

### Relationship to the retained-route adapter

ADR-209's history, startup and parameter foundations remain useful for this path. The
separately prepared retained React route adapter also remains dormant and testable as an
optional integration path. It is not activated or cancelled by this proposal. If retained
React presentation is used, its resolved route requests and leave guards still need an
admission/projection contract before native history can commit.

The helper-only experiment instead starts a fresh session with one native presentation and
route authority. It avoids introducing a second active router solely to mirror screens that
are already native. A mode is selected before document creation and remains fixed for that
SDK session; existing browser visits and unsaved React drafts are never handed over live.

### Activation evidence

Before enabling the Demo experiment, require a synthetic helper-entry test against the built
artifact: no React root/router/dashboard/font preloads; correct source helper registration
and locale; readiness only after successful bootstrap; missing artifacts cannot return the
SPA; and no real provider requests. Verify the ordinary frontend artifact still starts as
before.

Then require actual macOS app/package checks and synthetic Demo integration of native startup,
menus, cold intents, loading/fallback/print, native window input, reload and successful/failed
restore. Test stale document callbacks, failed bootstrap, physical completion after timeout
and rejected onboarding acknowledgments. Source-only Core proofs and a successful HTML build
do not establish AppKit/WebKit integration. Keep the flag off until these gates pass and
record the exact verified commit and evidence in the handoff.

> [!note] Amended by [[docs/adr/211-vision-native-without-web-content|ADR-211]] (2026-10-17)
> The helper document is a transition step: its calculations and storage move to Swift and a
> native-only mode removes the web view.

## Implementation (2026-10-17)

The SDK side lives in `apps/native/VisionNative/ShellController.swift` and `WebShell.swift`:

- **Selection.** `ShellState.ready` carries `NativeShellBackendSource` (supervised runtime
  identifier or Debug developer override). `NativeHelperDocumentSelection.select` builds the
  helper source once, before the first document and graph exist. A cold menu or Finder action
  that already built a renderer-mode graph keeps the retained web document.
- **Document authority.** The helper web view installs only the fixed document-start script and
  the `visionNativeHelper` reply handler, never the generic `electronAPI` bridge. Each load,
  reload and crash reload records its `WKNavigation` object; commit and finish observations come
  from WebKit. A matching finish issues provenance for the fixed bootstrap call, and the bootstrap
  receipt and the page's ready callback are accepted independently. Only both together stand in
  for the renderer's `ready()`. A changed backend origin, rejected receipt or failed bootstrap shows
  the native unavailable state.
- **Native owners.** The graph uses `helperDocument` presentation and native history. One
  controller-owned `NativeShellIntentCoordinator` survives graph rebuilds; every renderer menu
  action goes through `acceptNativeMenuAction`, and the mounted native screen acknowledges intent
  consumer readiness. Startup captures `vision.startupSection` and `vision.lastRoute`, resolves
  once through `NativeNavigationStartup` and then mirrors both keys as `StartupRedirect` does.
  Language changes send the fixed locale command; the effective `enhanced` tier drives vibrancy.
- **Restore policy.** Native Settings owns restore in helper mode (frontend state applied through
  the fixed storage script, then the native reload). The legacy `electronBackup.restore` bridge
  call belongs to the retained web document only; in helper mode it fails closed.
- **Artifact.** `scripts/lib/native-mac-build.sh` runs `build-native-helper.ts --out-dir` into the
  staged frontend, so the packaged runtime serves `/native-helper.html`. The Release build and the
  standard variant cannot select it.

Remaining before the experiment can be called verified: an actual macOS run of the opted-in Demo
(startup, menus, cold CSV, reload, successful and failed restore, print), and window-drag behaviour
on native screens. The handoff records each CI result.

## Consequences

This keeps the unchanged source financial runtime while giving a fresh Demo session one UI
and route owner. It adds a small build entry and explicit host bootstrap contract. The
existing renderer mode remains available while the experiment is disabled; diagrams and
flow visualizer continue to describe that actual runtime until activation changes it.

This is not web-runtime retirement or phase-4 completion. There is no backend financial
rewrite, real-data migration, data-directory change, Keychain/service-name change, audit
witness move or backup-folder migration. ADR-204's Demo restriction and ADR-205's separate
real-data switch-over sequence remain in force.

## Source evidence

| Surface                                                                    | Audited source                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current route/menu delegation, CSV handoff, vibrancy and reload fences     | `apps/native/VisionNative/ShellController.swift`                                                                                                                                                      |
| Detail fallback, native history and Settings/report ownership              | `apps/native/Sources/VisionNativeCore/Navigation/NativeShellModel.swift`                                                                                                                              |
| Raw startup selection, separate from route admission                       | `apps/native/Sources/VisionNativeCore/Navigation/NativeNavigationStartup.swift`                                                                                                                       |
| React route, Settings, startup, menu and CSV owners                        | `apps/frontend/src/App.tsx`, `apps/frontend/src/components/layout/AppLayout.tsx`, `apps/frontend/src/components/layout/ElectronBridge.tsx`, `apps/frontend/src/components/shared/StartupRedirect.tsx` |
| Framework-independent fixed helper lifetime and existing React mount owner | `apps/frontend/src/lib/nativeHelperRuntime.ts`, `apps/frontend/src/components/shared/NativePaletteAnswerBridge.tsx`                                                                                   |
| Unchanged callback implementations                                         | `apps/frontend/src/lib/nativePaletteAnswer.ts`, `apps/frontend/src/lib/nativeTaxReportProfile.ts`, `apps/frontend/src/lib/nativeTaxReportContext.ts`                                                  |
| HTML preload injection and build registration                              | `apps/frontend/src/build-support/defaultRoutePreload.ts`, `apps/frontend/vite.config.ts`                                                                                                              |
| Static artifacts followed by SPA fallback                                  | `apps/node-backend/src/main.ts`                                                                                                                                                                       |
| Existing focused source checks, not activation evidence                    | `apps/frontend/src/lib/__tests__/nativeHelperRuntime.test.ts`, `apps/native/Tests/VisionNativeCoreTests/NativeNavigationStartupTests.swift`                                                           |

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/204-vision-native-swift-app-target|ADR-204: Swift app target and phase gates]]
- [[docs/adr/205-vision-native-hand-over|ADR-205: Separate real-data switch-over]]
- [[docs/adr/209-vision-native-staged-web-retirement|ADR-209: Staged route authority]]
- Native app architecture (page removed by ADR-214)
- Shell and Settings parity (page removed by ADR-214)
- Native continuation handoff (page removed by ADR-214)
