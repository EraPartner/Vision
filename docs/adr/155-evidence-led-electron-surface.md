---
title: ADR-155 - Evidence-Led Electron Surface
type: adr
status: Accepted
date: 2026-09-19
tags: [adr, electron, security, packaging, native-runtime, demo]
description: Keep Vision's required native desktop journeys while narrowing renderer trust and excluding unneeded packaged assets, with measured Demo evidence.
aliases: [minimal electron capability surface, electron package audit]
---

# ADR-155: Evidence-Led Electron Surface

## Context

The native desktop build needs Electron for local startup, native file selection,
backups and restore, verified updates, Finder CSV handoff, notifications, menus,
window state, and macOS integration. Its renderer previously accepted navigation
to any localhost port or local file while retaining its preload bridge. The
package also carried test fixtures, source maps, foreign-platform Bare prebuilds,
and duplicate Demo art. Removing the native runtime, Chromium, or a used bridge
for a small size gain would be a poor trade.

## Decision

- Keep the one-window sandbox, context isolation, disabled Node integration,
  fixed external-link handling, existing native update transport, backup and
  restore, main-process notifications, menus, CSV open-with, dock badge, system
  accent, optional vibrancy, and persisted window bounds.
- Trust only the selected local backend origin and exact packaged recovery page
  for renderer navigation and main-frame privileged IPC. Deny subframes and
  other localhost ports or files. Restrict renderer connections to its own
  origin and install both request and check permission handlers. The renderer
  needs sanitized clipboard writes and loopback access; it does not need
  camera, microphone, geolocation, file-system, or notification permissions.
- Remove the unused `update:get-mode` invoke bridge. Update checks already
  include the mode used by the UI. Keep the other 23 invoke and 6 event
  channels because they have current owners and tests.
- Exclude package-only tests and fixtures, JavaScript maps, and non-Apple-Silicon
  Bare prebuilds. Keep the native runtime manifest and payload unchanged. The
  Demo keeps its identity through the small `resources/DEMO` marker and app icon
  without shipping the source art again as an extra resource.
- Do not add web views, a general download manager, protocol deep links, shell
  command bridges, renderer file-system access, or additional background
  processes. No current user journey justifies their permissions and lifecycle
  cost. Native accessibility remains the operating-system and web-content
  baseline; no new privileged accessibility API is required.

The audited surface maps to current work as follows:

| Surface                                                               | Required use and selected scope                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserWindow` size, minimum size, background color and saved bounds | Usable first frame and recoverable window position; macOS alone uses `hiddenInset`, traffic-light placement and follow-window visual effect state. No second renderer window.                                                    |
| `webPreferences` and session                                          | One sandboxed, isolated preload without renderer Node integration; fixed-origin Content Security Policy (CSP), denied window creation, origin and frame navigation checks, and fail-closed permissions.                          |
| Update bridge: 3 invokes                                              | Explicit check, verified install and pre-install backup. No separate mode query.                                                                                                                                                 |
| Backup bridge: 9 invokes                                              | Bundle creation, guarded restore, native file and folder selection, encryption and settings. `archiver` writes and `yauzl` reads bundles.                                                                                        |
| Services bridge: 2 invokes                                            | Persist and read the native service-on-quit choice.                                                                                                                                                                              |
| App bridge: 7 invokes and 4 events                                    | Renderer readiness/failure, badge, language, vibrancy, accent and splash theme; menu, Finder CSV, fullscreen and accent events.                                                                                                  |
| Recovery bridge: 2 invokes and 2 events                               | Retry or open diagnostics, plus backend loss and restoration events.                                                                                                                                                             |
| Main-process platform hooks                                           | Native notifications for update/service status, fixed external links, menus and dock, Finder CSV, display/window lifecycle, macOS system accent and optional vibrancy. These do not grant renderer operating-system permissions. |
| Bundle assets and processes                                           | Keep Electron/Chromium, Bun backend, PostgreSQL 18, Alembic, PDF browser, frontend, locales, update helper, backup code, icons and Demo seed. Do not start a second backend or renderer process solely for a new feature.        |

`electron-builder` is a build-only dependency. `archiver` and `yauzl` are
runtime dependencies of `.visionbak`; the remaining Bare modules come from the
packaged dependency graph, so only their non-target-platform prebuilds are
removed. The Demo's native payload is not repacked by this change.

## Evidence and limits

Two disposable Apple Silicon Vision Demo directory bundles used the same native
runtime manifest. Package size changed from 686,196 to 681,804 KiB (4,392 KiB
smaller); `app.asar` changed from 6,668,208 to 2,891,881 bytes. One cold-start
`launch_total` log sample was 11,004 ms before and 10,414 ms after. One idle
aggregate process sample was 15 processes, 1,117.2 MiB resident memory and
0.5% CPU before; 16 processes, 942.2 MiB and 1.5% CPU after. The timing and
resource samples are not controlled benchmarks and do not establish a causal
performance improvement.

Both disposable builds reached the synthetic Demo home screen. The final build
also passed a native menu action, ordinary text copy, and a backup picker that
was cancelled without changing Demo data. A separate packaged-payload smoke
with a disposable PostgreSQL cluster passed frontend and API checks, an
encrypted backup, synthetic state mutation, and restore. Electron contract
and unit tests pass. These checks do not constitute an end-to-end update,
in-app restore, download, Finder open-with, notification, deep-link, or
release-DMG test. The existing update and backup tests still guard those code
paths; a production release must perform its own release and recovery gates.

## Consequences

The narrower boundary rejects navigation and IPC from a different loopback
service, arbitrary local files, and subframes. Package filters are scoped to
known non-runtime files, so the large but necessary native payload remains.
The IPC removal is a breaking internal preload contract for callers of
`electronUpdater.getMode`, but the shipped frontend had no such caller.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]]
- [[docs/features/application-updates|Application Updates]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
