---
title: "Vision Native agent handoff"
type: reference
status: active
date: 2026-10-15
updated: 2026-10-17
tags: [reference, swift-rewrite, native-parity, handoff]
description: "Resumable checkpoint for the Swift port: published branch, current phase, ownership, remaining work, verification evidence and subsequent-phase gates."
---

# Vision Native agent handoff

## Resume here (2026-10-17 continuation)

Branch **`codex/native-phase-3g`**; push only to this branch, no PR (owner's choice on
2026-10-17). The owner gave the **phase-4 go** on 2026-10-17 with every new authority
**default-off**, and asked to fix the macOS UI gate first. ADR-206 and ADR-207 are now
accepted on that basis. This container had no Swift toolchain (download.swift.org is denied
by the environment's network policy), so the macOS workflow is the only compiler; each
result below is from an actual `Native Branch Verification` run.

**UI gate (phase 3p) — what changed and what CI showed**

- `7bf8630`: SwiftUI print blocks were blank because `NSPrintOperation` does not capture
  `NSHostingView` layers. `NativePrintHostingView` draws the same root via `ImageRenderer`
  off-screen; all Tax/Statistics/Net-worth print hosts and the PDF canary use it.
  Run 31: print-readiness issues 29 → 0; Core 1,682 passed; UI 21 issues left.
- `7498aff`: the SwiftPM test helper was never active (cooperative activation refused), so
  every focus fixture failed. The harness now falls back to `activate(ignoringOtherApps:)`.
  Run 36: "Native overlay responder ownership" passes (15 issues → 0).
- `5599a5b`: `DisclosureGroup` is AppKit-backed and `ImageRenderer` cannot print it;
  `VisionDisclosure` prints the three Tax disclosures as plain SwiftUI. Run 40: household
  print check passes.
- `c1f27ff`: test-only — `NativePDFGlyphs` reads printed text by glyph position grouped into
  lines (content order interleaves cells; `selection(for:)` selects whole lines). Pivot and
  recipient expectations are unchanged. Pending CI.
- `50ce61b`: accessible-content test attempt 1 (owner-approved plan: up to two attempts that
  keep the assertion, then assert rendered content and leave VoiceOver to a manual Mac check).
  Its walker now also reads titles and the attribute API and dumps the tree on failure.
  Pending CI.

Run 40 (`eb59813`): app build passed; Core **1,687 tests / 231 suites passed**; UI **94 tests,
5 issues** (pivot ×2, recipients ×1 — addressed by `c1f27ff`; accessible content ×2).

**Phase 4 (default-off) — implemented in the SDK**

| Commit    | Change                                                                                                                                    | CI                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `4a4933c` | `ShellState.ready` carries `NativeShellBackendSource`; `NativeHelperDocumentSelection`                                                    | built (run 36), 5 tests |
| `1e1e91c` | `WebShell` helper mode (fixed script + `visionNativeHelper` handler, WKNavigation tracking); controller session lifecycle, native history | built (run 36)          |
| `d3fa8e4` | native menu admission, one retained intent coordinator, consumer readiness, locale command, vibrancy                                      | built (run 36)          |
| `a5960a6` | `native-mac-build.sh` builds the helper into the staged frontend (`--out-dir`)                                                            | local build + 25 tests  |
| `bca9993` | helper-mode `StartupRedirect` (`vision.startupSection`, `vision.lastRoute` allowlisted)                                                   | built (run 40)          |

Opt-in: `VISION_NATIVE_HELPER_DOCUMENT=1` with a Debug build of the Demo variant and a
supervised backend; anything else keeps the retained web document. **No opted-in Demo run has
happened**; none of the helper flows has run on a Mac.

**Accessible-content test outcome (owner-approved fallback applied).** Attempt 1 (`50ce61b`)
showed `NSHostingView<NativeShellUnavailableView>` exposing an AXGroup with no SwiftUI nodes;
attempt 2 (`5ccecd1`) showed the process cannot enable client accessibility for itself
(`AXEnhancedUserInterface` −25208, `AXManualAccessibility` −25205). The test now asserts that the
native loading/unavailable views render their localized text. **Manual Mac check still owed:**
VoiceOver reads "Loading…" and the unavailable message on the native startup/failure screens.
The same run's glyph dump showed the test helper mixed `page.string` and `characterBounds`
index spaces; it now reads each character through a one-character selection.

**Parity continuation (2026-10-17, after the owner's "continue until stopped")**

Owner decisions: port the devtools (API Inspector and a query panel), port the visual effects
faithfully, add a macOS end-to-end smoke job and flip the helper default once it passes, build a
Debug Developer Tools item, cut the non-macOS About row, build a native topbar, and build the
skip-link and Reload page equivalents. Native work since the UI gate, each pushed to this branch:

- Shell: sidebar badges, search field, go-to hints, collapse button with saved state, topbar
  (sidebar trigger, search, scroll-linked title), skip link, Reload page on the shell failure
  state, page zoom persistence, scroll restoration on Back/Forward, backend health watchdog,
  Debug Toggle Developer Tools, system notifications for Electron's `notify` notices.
- Devtools: `NativeAPIInspector` (requests, metrics, queries) behind admin mode, ⌘⇧A.
- Visual effects: aurora canvas (Metal shader), page entrance, rolling numbers, hero trend hue
  and sheen, fetch shimmer, `DeltaPill`.
- Planned payments: a failed list load retries once (`retry: 1`).
- Phase 4: bridge restore fails closed in helper mode (ADR-207 restore policy); the e2e smoke
  workflow (`native-e2e.yml`) builds PostgreSQL 18.6 with OpenSSL, the payload, the Debug Demo
  app, then smokes the retained control and the helper mode with a graceful Quit.
- Parity inventory: 87 rows moved to `native` by audit, plus the context menu, topbar, skip
  link, error fallback and Developer Tools rows. Only the sidebar logo button stays `web`.

**ADR-208 (accepted 2026-10-17): finish phase 4 without web content**

Tor chose to port the helper document's work to Swift and add a web-free mode, default-off:

- Palette answers (`NativePaletteCalculator`) and the tax report context (`NativeTaxReportProfile`
  plus the overview for every four-digit year; the backend overview's year bound widened) no
  longer use the helper document, in any mode.
- The native-only mode is the eligible Debug Demo default (supervised runtime;
  `VISION_NATIVE_WEB_FREE=0` opts out, `VISION_NATIVE_HELPER_DOCUMENT=1` selects the helper): storage
  via `NativeShellStorage` over `NativeRawStateStore` (`native/<runtimeId>/raw-state.json`), a
  one-time capture through a transient web view (`NativeStorageCapture`), no web view afterwards.
  Owner decisions: transient-view capture; a complete empty capture is an explicit empty start;
  a migrated store opens under its recorded source after a port change; errors fail closed.
- Known divergence: helper or retained runs after the capture write the web store, which the
  native store does not see. Pick one mode per Demo until the helper is retired.
- The e2e smoke runs `retained`, `helper` and `native` modes plus the Electron Demo baseline and
  records bundle size and resident memory per mode (job summary and artifact).
- The helper-default flip is superseded by the native-only default; the helper stays an explicit
  opt-in until the owner retires it.

**First end-to-end evidence (run 39062704573, 2026-10-17)**

The Debug Demo app and its payload built on `macos-26`; the retained control reached `phase
running` and answered `/health`. The helper and native-only smokes never selected their mode: the
accent-colour observer resolved appearance at start, which built the shell graph before launch,
so selection logged "helper document ineligible: the shell graph already exists". Fixed by not
resolving appearance before a graph exists. Notifications are not allowed on the runner, as
expected for an unsigned build. First metrics (KiB, after startup):

| Mode                | Bundle  | App RSS | Process tree RSS | WebKit RSS |
| ------------------- | ------- | ------- | ---------------- | ---------- |
| Native, retained    | 458,292 | 466,720 | 1,099,984        | 207,664    |
| Electron Demo       | 648,716 | 169,488 | 1,154,080        | 0          |

The Electron tree includes its renderer and GPU helpers; the native tree's WebKit services run
outside the process tree and are counted separately.

**Native-only smoke passes (run 39065530611, `c1b8d39`, 2026-10-17)**

With `VISION_NATIVE_WEB_FREE=1` the Debug Demo selected the native-only document, captured the
origin's storage once ("native-only storage captured (7 local keys)"), logged "native-only
document ready" and answered `/health`. The retained control passed again. Metrics (KiB):

| Mode                | Bundle  | App RSS | Process tree RSS | WebKit RSS | Processes |
| ------------------- | ------- | ------- | ---------------- | ---------- | --------- |
| Native, retained¹   | 458,292 | 466,720 | 1,099,984        | 207,664    | —         |
| Native, native-only | 458,616 | 467,264 | 963,120          | 55,600     | 19        |
| Electron Demo       | 648,716 | 169,408 | 1,165,376        | 0          | 24        |

¹ From run 39062704573. The native-only WebKit figure is the transient capture view's services,
which outlive the view after the first launch. App RSS is unchanged from the retained mode, so
the app's own footprint, not WebKit, dominates it; profiling it is a follow-up.

The helper smoke selected its mode, then the helper page reported `bootstrap-failed`:
`startNativeHelperDocument` requires `__VISION_NATIVE_PALETTE__` and `__VISION_NATIVE_REPORTS__`,
which only the retained `BridgeScript` defined. The helper's document-start script now defines
both. On run 39067544790 (branch suites green, run 39067544787) native-only passed again and the
helper's bootstrap call itself then threw; the shell now logs that error with the stage.

**All four modes pass (run 39069586078, `96c21ab`, branch suites run 39069586079, 2026-10-17)**

Native-only is the Debug Demo default and passed with no variable set; the retained control
(`VISION_NATIVE_WEB_FREE=0`) and the helper (`VISION_NATIVE_HELPER_DOCUMENT=1`, "helper document
ready" in 3.4 s) passed too. The helper's earlier bootstrap throw did not recur; if it does, the
log now names WebKit's error. Metrics (KiB):

| Mode                | Bundle  | App RSS | Process tree RSS | WebKit RSS | Processes |
| ------------------- | ------- | ------- | ---------------- | ---------- | --------- |
| Native, retained    | 458,616 | 388,016 | 956,288          | 210,400    | 21        |
| Native, helper      | 458,616 | 467,440 | 992,256          | 98,576     | 21        |
| Native, native-only | 458,616 | 466,816 | 940,912          | 233,536    | 18        |
| Electron Demo       | 648,716 | 171,216 | 1,181,584        | 0          | 24        |

The WebKit column sums every WebKit service on the runner, including ones the earlier modes left
behind in the same job, so it is not attributable per mode; the process tree and bundle are.
Native-only has the smallest tree and process count; the app's own RSS (~390–470 MB, about 2.5×
Electron's main process) is the next thing to profile.

**Next**

1. Read the latest `Native Branch Verification` and `Native End-to-End Smoke` runs; fix any
   compile or test failure. Native-only is the Debug Demo default (suites run 39067544787); the
   helper-default flip is superseded. Confirm the helper smoke passes with its capability flags,
   then retire the helper and retained modes for the Demo with the owner (ADR-208 end state).
2. Manual Mac checks owed: VoiceOver on the startup/failure screens, the text context menu,
   window drag on native screens, notification permission prompt, topbar title on scroll.
3. Remaining phase-4 gates from ADR-206/207: storage takeover, retiring the retained renderer
   by default, bundle size and memory against the phase-0 baseline (ADR-204 exit). Real-data
   switch-over stays under ADR-205.

## Resume here (2026-10-15, historical)

Continue the Swift frontend port on **`codex/native-phase-3g`**, remote
`https://github.com/EraPartner/Vision.git`. Do not merge or push `main`.
The user explicitly authorized continued work through subsequent phases, parallel agents,
local commits and pushes to this GitHub branch. Preserve workflows and adopt macOS controls
and styling while keeping the source colours, navigation and chart layouts.
The user also explicitly said to continue without requiring manual verification or Demo
steps between phases. Carry out available automated checks and continue independent work;
do not ask the owner to perform those steps as an intermission.
The owner's latest instruction explicitly requires continuing through the plan with parallel
agents **until stopped**, making intermediate snapshot commits along the way. A snapshot is a
save point, not a reason to end work or ask for a phase-start approval. Continue independent
work while platform checks run and keep their actual results distinct from implementation.

Phase **3o**, Settings and shared shell behaviour, has a hash-matched Foundation proof
of 1,173 tests. Phase **3p**, remaining shell overlays and report parity, is in progress;
its first full mounted integration checkpoint is **`fcd7ee95`**, pushed and verified.
The latest combined continuation checkpoint is **`02303479`**, pushed and remote-verified.
Its [macOS run](https://github.com/EraPartner/Vision/actions/runs/38709674772) built the app,
then package compilation stopped at two UI fixture diagnostics: a concatenated String where
Swift Testing requires a Comment literal, and `NSAccessibility` namespace used instead of
the formal `NSAccessibilityProtocol`. The narrow follow-up uses an interpolated literal and
the correct protocol without changing assertions. No package tests ran in this run.
The preceding **`bb67c6f2`** [macOS run](https://github.com/EraPartner/Vision/actions/runs/38706224180) built the
app and passed all **1,652 Core tests in 226 suites**. The preceding **`ca7a25ea`** run passed
all **1,617 Core tests in 221 suites**, then exposed print-render fixture and positive focus-restoration
failures. **`4ddaa2c7`** added row-aware printing and startup routing; its package compile
found two new fixture diagnostics, repaired in `bb67c6f2`. The latest snapshot also serializes
AppKit UI suites, captures synthetic PDF diagnostics on failure and stages detached route,
numeric-ID and raw-storage capture boundaries. The latest UI process ran **91 tests in
14 suites with 44 issues**: every print readiness probe remained blank, including the
independent SwiftUI canary, and all 15 focus cases failed actual application/key-window
ownership setup. Dedicated agents are investigating the AppKit execution context and saved
PDF artifact; no repaired rendering/focus pass is claimed.
The dated checkpoints below preserve historical evidence; use this continuation's results
before treating any earlier phase or test count as current.
This handoff records both implemented and unfinished work; it does not certify that
in-progress files compile or that macOS validation has passed. Inspect `git log`,
`git status` and the actual diff before continuing.

The first phase-3o safety checkpoint, **`9a38ffed`**, published the initial handoff and
Settings scaffolding. The next in-progress checkpoint saved all current task changes and
introduces `.github/workflows/native-branch.yml`, an automatic macOS app/package check on
pushes to `codex/native-phase-*`. This is a work-in-progress checkpoint, not a completed
Settings port. Full integration and combined verification are still required.

Current saved implementation includes raw Settings persistence/model/default migration,
seven-section native window and General/Appearance/Insights/Behavior/Backup/About UI,
AI service/model work, the desktop callback interface and private localStorage helper,
global notice host, six captured Undo adapters, zero-retry Settings client support and
sticky host settings queues. Root Settings sheet/close-router integration is on disk.
The desktop SDK factory is wired to all seven sections, the single native writer, source
router and shared notices. The latest restore lifetime fences remain under verification;
do not claim the Settings screen is usable end to end until the macOS build passes.
Raw normal app/dashboard edits preserve unknown fields, required fields
are migrated exactly as the source, optional presence is retained, and CAS baselines remain
the original raw value. Theme normal writes reconstruct its four source fields.

Focused checks so far: 21 main Settings Core tests, eight Insights/Behavior helpers, two
rail navigation tests, four portable storage bridge tests, two Import/global notice tests,
script behaviour under Bun and workflow admission/policy checks passed. New global Undo,
API replay and combined checks are in progress. SwiftUI sources passed syntax/format checks
where reported; automated macOS builds are finding and correcting real compiler issues,
and rendering is not yet verified. Final frontend takeover validation passed 81 tests in
seven files, full frontend typecheck and targeted ESLint. The prior phase's
979-test result applies only to `17158f6d`, not to this unfinished snapshot.

The user requested an immediate handoff, commit and push of **all dirty changes for this
work** when Codex plan usage reaches 3%. The current tools do not expose remaining plan
percentage. Keep this note current and push regular checkpoints instead of depending on
detecting that threshold. When a usage warning or user signal arrives, pause parallel
writers, collect their exact state, update this note, stage all task changes (including new
files), commit and push this branch. Label incomplete work and failed or pending checks
explicitly. Do not leave the handoff or unfinished task files only in the workspace.

## Resume verification (2026-10-15)

Resumed from remote **`fd68b492`** on `codex/native-phase-3g`, with a clean worktree.
Its actual [macOS run](https://github.com/EraPartner/Vision/actions/runs/38486890925)
**built the app successfully** and compiled the full package, then ran **1,631 tests in
226 suites with 50 issues**. The failure is not an app compiler failure. Do not advance
phase-completion claims until the package gate passes.

That run crossed UTC midnight. Planned UI fixtures generated dates before midnight but
read the strip after it; Statistics tests also used different real dates within one
scenario. Many receipt assertions ran after the shared notice host's four-second expiry.
The continuation supplies fixed clocks to those fixtures and permits shell construction
with an injected notice center; production still creates its normal expiring center.
The Tax print HTTP fixture now serves `dashboard_settings`, which the dashboard must read
before loading figures, and asserts successful page loading before snapshot capture.

`6c1d6f96` is pushed and verified on the remote. Frontend typecheck and seven generator
tests pass. Its macOS run exposed optional notice-parameter shadowing in shell initialization;
the follow-up uses a distinct internal parameter name. The follow-up also synchronizes the
three printing diagrams and existing visualizer flow for all three current-page print routes;
five visualizer tests pass, with coverage unchanged at 106 components/79 flows.

The follow-up app build at `fa1f2bf3` passed; its combined package run is still in progress.
The next checkpoint also moves the standalone stream watchdog test off MainActor and runs Core
and UI test targets in separate processes in both macOS workflows. No tests are removed: the
second invocation uses `--skip-build --filter VisionNativeUITests`; the first skips only that
target. Full package results are pending, not inferred from elapsed time or the earlier proof.

The combined `fa1f2bf3` package result is now available: **1,631 tests / 226 suites / 13 issues**
(down from 50). Notice expiry, midnight-sensitive strip and Statistics failures are gone.
Remaining failures exposed further real-time cache tests (Home/Admin/Portfolio), three Investigation
poll assertions, the MainActor watchdog test and the Tax print fixture's hidden-category reads.
The next save supplies the two empty category responses and shared fixture cache clocks; normal
production clocks and TTLs remain unchanged. `2ffce6fe` is pushed and verified, with its isolated
Core/UI macOS run in progress. Read its actual results before counting any remaining issue fixed.

Next: inspect the automatic macOS run for this continuation, repair remaining actual
failures (including stream-watchdog and Investigation polling tests if reproduced), then
complete the phase-3p lifecycle/printing validation below. Earlier isolated proof directories
and the phase-4 audit under `/workspace/vision-*` are absent in this fresh environment;
the historical results below are prior evidence, not newly reproduced checks.

## Parallel continuation checkpoint (2026-10-15)

The owner explicitly requested parallel subagents in this resumed thread. Root coordinated six
owners; their source is collected in **`1ba95571`**, pushed and remote-verified after
`cb41be8a`. The SDK route/storage takeover remains disabled. Current implementation includes:

- Document-commit readiness authority and captured model/generation checks; fresh restore frontend
  and onboarding-completion drains; normal About reload uses the shared accepted-action path.
- Extracted paginator, changed-paper remeasurement, narrow wrapping Statistics pivots and ten new macOS
  AppKit/PDF rendering cases. Tall blocks can still split rows; physical printer/VoiceOver unverified.
- Deterministic watchdog/poll receipt tests; a real AI Settings paused-read replay race fixed by
  rechecking lane ownership; notice clocks fixed and repeated suspension test separated from the
  legitimate two-write cost-basis debounce.
- Default-off native history integration with 23 new tests and proposed ADR-206, plus a dormant
  raw state actor with nine permanent tests. No browser import/retirement or real-data migration.
- Scoped parity mappings and print/lifecycle architecture diagrams reconciled with actual source.

The separated predecessor `2ffce6fe` app built and ran **1,577 Core tests in 217 suites with eight
issues**. The platform gate remains open: `cb41be8a` built successfully and ran 1,577 Core tests / 217 suites with seven issues; it excludes
this combined work. Its Tax fixture failure precisely required `CategoryList.links`, now included;
its other failures are the notice deadline, watchdog, SettingsAI replay and two-write fixture cases
addressed in this combined save. Do not describe new UI/SDK source as compiled until its own Mac run completes.

The `1ba95571` macOS app build passed. Package compilation then stopped at
`NativePrintRenderFixtures.swift:92`: the compiler could not type-check the combined
Net-worth row expression in reasonable time. No package tests ran. The fixture follow-up
uses typed scalar/Decimal intermediates and explicit row/pagination loops with unchanged
synthetic values. `598d8fd3` predates that fix and will encounter the same diagnostic.
Final review also published a follow-up: the PDF test window explicitly retains ownership on
close, and staged history preserves deferred Settings-open ownership and matches encoded
static paths using the installed React Router 8.3 all-or-nothing decoding behavior. Four
regressions bring navigation coverage to 27 tests; an installed-router oracle passed 16
encoded/malformed/slash cases. The new Swift regressions still need the follow-up Mac run.
Existing dynamic-parameter consumers (including raw Portfolio import identifiers and
double-encoded slashes) remain an explicit parity gate before native routing activation;
the follow-up does not change renderer-mode `NativeRoute` consumers.

Additional scoped Linux evidence: all 13 exact Settings AI tests pass using the exact model
with explicit API/transport/domain excerpts/adapters. Removing only the paused-lane membership
guard reproduces the duplicate desktop-read failure. The exact watchdog body also completed
100 executions with event-domain stubs. Preserve `/workspace/scratch/ai-final-review` logs and
metadata; these checks supplement, and do not replace, the full macOS package gate.

The official Swift 6.2.3 Linux toolchain is now installed at
`/workspace/.vision-tools/swift623/swift-6.2.3-RELEASE-ubuntu24.04/usr/bin` (official detached
signature verified). Focused proof **12 tests / two suites / zero drift / zero adapters** includes
four exact production files (`NativeRawStateStore`, `NativeRendererReadiness`,
`NativeSettingsStorageBridge`, `JSONValue`) and two exact permanent test files. Preserve
`/workspace/vision-phase4-foundation-check/{verification.log,verification.json,SHA-manifest.json}`;
manifest SHA `8a5e5917da460da79fef710576c3f88bb951e71123f251161fcfc924d1cf2cce`.
It does not certify routing/ShellController/AppKit or host storage migration.

### Collected focus/input/helper follow-up (2026-10-15)

**`afed3bcc`** is pushed and remote-verified. This combined follow-up adds final route-opener focus restoration and synthetic AppKit window
tests, preserving covered-overlay focus and field-editor owner/selection. Palette Escape now
lives on its container and Close has the cancel shortcut. A route-window marker captures before
presentation; final `onDismiss` restoration rejects a changed graph/underlying route, detached
or reparented control, another key window, newer overlay, attached sheet or reload/restore fence.
Eight new test functions provide 15 synthetic cases; actual AppKit execution remains pending.

Final lifecycle review confirmed fresh graphs reset the prior reload input gate. The follow-up
holds `isReloadingGraph` across reconstruction, hides WebKit and resigns its descendant responder,
then releases only at checked current-document/model/generation startup. Initial launch remains
ungated; fresh restore completion still drains before rebuilding. Source parse/review passed;
host runtime behavior is not inferred from the earlier app builds.

`apps/frontend/src/lib/nativeHelperRuntime.ts` extracts installation/retirement of the same
three fixed source helpers and keyboard bridge. The existing React component still owns runtime,
QueryClient and live locale lifetime. All original calculation/registration modules are unchanged.
**48 tests / five files**, targeted ESLint and root typecheck pass; logs are
`/workspace/native-helper-{tests,eslint,typecheck}.log`. No SDK activation or provider calls.

The focused navigation proof passes **18 tests / one suite**, with three full exact production
files, the full exact permanent test file and nine documented actual route-declaration extracts.
All three focused mutation variants compiled and were caught by regression assertions.
`/tmp/vision-navigation-proof-598d8fd3/{manifest.json,test.log,verification.json}`; manifest SHA
`92cbb7971de7e43e6880b5d6976cf533babf6dd1b0f1009c40e40c9a79f931ec`.
Zero drift against `a10c3deb`; excludes nine shell integration tests, SDK and UI/macOS.
Do not count these scoped proofs as the full package gate.
Combined verification also passes six Swift syntax checks, three changed-note metadata/link
checks and all five flow-visualizer tests; coverage remains 106 components / 79 flows.

### Continuous phase-plan continuation (2026-10-15)

The `a10c3deb` package compiled successfully and ran **1,617 Core tests / 221 suites /
three issues**. Tax's same-year cache-count assertions crossed its real 30-second TTL;
Investigation's five-second polling-publication loop expired before its acknowledged waiting
snapshot reached MainActor. The next test-only save injects the existing fixed Tax clock and
awaits actual Observable job publication with cancellation and one-minute deadlock guards.
Production TTL and polling policies are unchanged. A scoped Linux proof passes **23 tests /
two suites** using exact Investigation/TaxOverview models with documented boundary adapters;
it excludes the HTTP Investigation case and uses a reduced Tax result fixture. Artifacts:
`/workspace/scratch/ai-poll-tax-check` and `/workspace/scratch/ai-poll-tax-check.log`.
The full Mac gate remains authoritative. `afed3bcc` built the app/package and ran
**1,617 Core tests / 221 suites / one issue**, the old Investigation publication deadline.
`ca7a25ea` publishes both test fixes and its Mac run is in progress. The next combined save
also makes the two deadlock guards two minutes: the real passing sibling took 61.86 seconds
under aggregate MainActor load. Exact publication/count assertions remain unchanged.

Parallel owners now implement measured row-aware pagination and adapters for Tax, Statistics
and Net worth. Root integrates SDK calls; the paginator retains the existing `[NSView]` builder
interface and recognizes explicit table blocks. Another owner audits staged Phase-4 startup,
history, storage and readiness dependencies. Neither unfinished work nor a pending CI run
establishes phase completion. Continue from actual `git log` and collect all task files at saves.

### Row-aware print and staged navigation checkpoint (2026-10-15)

**`4ddaa2c7`** is pushed and remote-verified. This snapshot adds `NativePagePrintRow`/`NativePagePrintTableBlock`, retaining the existing
`[NSView]` builder boundary. The paginator measures actual variable-height rows, moves fitting
tables intact, repeats fresh continuation headers, keeps the final footer with the last row
when possible, and resolves columns from the full frozen table. Oversized individual rows or
footers use explicit clipped continuations; a header occupying the paper falls back to ordinary
blocks without repeated headers. All three SDK print adapters call the new document factories.
Tax expanded PIT/household/comparison, Statistics pivot/recipient/yearly and Net-worth loaded
account/history tables use the structured blocks without new reads or financial recalculation.
Generic and document-specific AppKit/PDF tests cover row bounds, headers, footer count, columns,
long labels/amounts, frozen state and request counters. Their actual Mac execution remains pending.

Algorithm-only proof compiles the two exact production files against an AppKit geometry stand-in
and passes 1,000 seeded layouts. Artifacts `/tmp/vision-print-table-algorithm`, manifest SHA
`166721c14562a247ab6a1e0f4820d98b0ca199e4f26120c43acda24eb5c5e712`.
This is not an AppKit/PDF/physical-printer result.

New dormant `NativeNavigationStartup` preserves source boot-mirror/last-route selection,
settings-arrival location, root-query behavior, and new-session seed versus document-reload
replacement. Raw selection deliberately defers route admission/admin/legacy handling.
Its exact-source proof passes nine tests, and the actual `StartupRedirect` component/effect
oracle matches 21,842 scenarios / 28,084 evaluations. Preserve
`/workspace/vision-native-startup-proof`, manifest SHA
`1198aa4c1549d4251227ba53e7408920ed7bf856876e2c8ecf7046e09f6732a6`.

Native-only matched parameters now remain separate from raw pathname/search. Opt-in shell,
database table and Portfolio review consumers use decoded match values without decoding again;
renderer-mode behavior is unchanged. The new matcher/18 prior history tests pass a scoped
24-test proof and 68 installed React Router oracle cases. Artifacts:
`/workspace/scratch/native-parameter-check`. Two shell integration tests and SwiftUI need Mac
execution. JavaScript numeric-ID coercion remains a separate activation gate; SDK takeover is off.

Source audit corrected a stale Portfolio-print claim: `PortfolioPage` has no optimized print
markers, `AppLayout` and `printReports.contract.test.ts` explicitly cover Tax/Statistics/Net worth,
and Electron defines no Print menu/call. Generic browser printing is separate from that contract.
Portfolio PDF export remains implemented; do not invent a missing optimized Portfolio print port.

Next Phase-4 chunks: default-off request/commit adapter preserving the single web leave guard;
strict raw-state capture codec/script before any live migration; numeric route-ID parity; then
typed host bootstrap, history continuity and restore/menu integration. Startup resolution and
matched parameters alone do not enable a new SDK route owner. Continue independent preparation
while full package checks run; do not end work merely because a snapshot was published.

### Core gate and UI/Phase-4 follow-up (2026-10-15)

`ca7a25ea` built the app/package and **all 1,617 Core tests / 221 suites passed**. The separate
UI process ran **70 tests / ten suites / 84 issues**: 80 print-content assertions saw blank
SwiftUI PDFs while custom NSView PDF markers passed, and four positive focus restorations
failed while the ownership-fence cases passed. Diagnostics: `/workspace/mac-ca7-diagnostics.log`.
The follow-up keeps assertions and production guards: shared print tests use a visible non-key
per-page viewport, observed SwiftUI vector readiness and display transactions; focus fixtures
establish and assert actual AppKit activation/key ownership. A two-page SwiftUI text canary
checks the harness independently. The UI invocation is explicitly `--no-parallel` in both Mac
workflows because AppKit state is process-global. An actual Swift 6.2.3 probe showed default
Testing concurrency versus serial execution with that flag; source evidence is under
`/workspace/scratch/swift-testing-concurrency-probe`. Failed runs retain synthetic print PDFs
for three days when emitted. No actual repaired Mac render pass is claimed.

`4ddaa2c7` also **built the app successfully**, including row-aware production views and
native matching, but its package compilation stopped on two Net-worth test diagnostics:
a Testing macro incorrectly propagated optional chaining through a nested `normalized` call,
and a fixture omitted required theme appearance. The follow-up extracts typed local strings
before the unchanged assertion and supplies explicit dark appearance. No tests ran in that run.

Additional dormant Phase-4 preparation is collected in this follow-up:

- `NativeRawStateCaptureBridge` and permanent tests: six exact-source Foundation cases plus
  16 exact emitted-script Bun cases passed, zero adapters/drift; three JavaScriptCore cases
  remain Mac-only. Full raw local keys/unknown strings and exactly four session keys are
  captured read-only, with strict origin/provenance/stability checks. Host-exclusive admission,
  physical callback drains and final current-document checks remain mandatory; no SDK import.
  Preserve `/workspace/vision-phase4-capture-check`, manifest SHA
  `f176ff7afcdaca826beaf8e1811b0c272e1e9661b10963a085d10a01e74d0fb8`.
- `lib/nativeRouteAdapter.ts` is detached and inactive: native preflight is a lease, source
  `UnsavedChangesProvider` stays the sole blocker, and commits report actual source acceptance
  once. It adds no App facade/history override. Twenty-four actual-router/guard cases, targeted
  ESLint and root typecheck pass. Unified interception, resolved target admission and host
  reservation/projection atomicity are still required before a retained-router takeover.
- `NativeNavigationIdentifier` models source Number coercion for identifier text only. Its
  exact-source five-test proof passes, with 49 Number/backend oracle cases; binary64 never
  carries money. Valid numeric aliases now reach native matched screens/Portfolio typed load.
  A 32-test scoped routing proof passes at `/workspace/scratch/native-valid-alias-check`.
  Invalid import review context, source retry/cache identity and error/query policy remain
  explicit gates. Default renderer branches are unchanged; native authority is still disabled.
- [[docs/adr/207-vision-native-helper-document|Proposed ADR-207]] records an isolated default-off
  Debug Demo helper document, with unchanged TypeScript financial modules and no React UI/router.
  No such SDK configuration is active. Locale/readiness, startup/native commands, cold CSV/new
  transaction, vibrancy and fail-closed artifact serving must be implemented and tested first.

Continue from these bounded chunks rather than re-running immutable proofs in place. The next
parallel work prepares helper bootstrap/asset serving and resolves remaining import-route policy;
actual Mac diagnostics take priority whenever they become available.

### Dormant helper bootstrap continuation (2026-10-15)

`lib/nativeHelperDocument.ts` and its tests prepare a document owner without an HTML entry or
SDK activation. The caller supplies copied/frozen document and generation identity, language,
current-owner checks and a host readiness acknowledgment. The owner loads actual generated
locale resources directly, mounts a QueryClient with App defaults and installs the unchanged
three fixed callbacks. It acknowledges only after locale and callbacks are present. Explicit
typed locale updates preserve the cache and callback identity; superseded/disposed owners
reject pending work and cannot finish readiness. No settings event is trusted implicitly,
and client provenance checks do not replace the future host's current-document authorization.

The new/bootstrap predecessor suites pass **19 tests**; a combined source regression run passes
**74 tests in six files**, including the detached router and actual fiscal/palette callbacks.
Targeted ESLint, formatting and full frontend typecheck pass. Checks use synthetic hosts and
mocked provider access. Evidence: `/workspace/vision-native-helper-document-proof.json`.
The optional artifact build and native presentation policy are now prepared; actual
host/menu/startup integration remains in progress. The default SDK still loads the retained
React document.

The production backend now reserves `/native-helper.html` and `/native-helper-assets` before
generic static/SPA fallback. Seven real-Express synthetic tests pass, including raw HTTP
encoded traversal, missing HTML/bootstrap/lazy assets, GET/HEAD MIME/cache and normal-route
preservation. Backend source/tests/scripts typecheck, full lint (36 existing monetary-arithmetic
warnings) and compile-only Bun build pass; no server/database/provider ran. The static namespace
adds no OpenAPI operation. Architecture diagrams and the visualizer now cover this boundary
(106 components / 80 flows); five visualizer tests pass. Build/entry and SDK activation are
separate. Evidence: `/workspace/native-helper-artifacts-{tests,typecheck,lint,build}.log`.

The latest actual Mac run `38706224180` passed the app build and all 1,652 Core tests / 226 suites,
then failed UI application/display setup (91 tests / 14 suites / 44 issues). Synthetic PDF ZIP:
artifact `11959402105`, SHA256
`012aa33f399f1cd4c1e762fb2acd6ec6db7de403adfb2d78016684e4043da6f9`.
All original content/focus assertions remain. Shared AppKit launch context takes priority over
changing individual report expectations. The ordinary frontend build, full typecheck and bundle
budgets pass (474.74 KiB boot / 1,373.83 KiB all gzip); helper artifacts must remain separate.

The optional frontend command `bun run --filter vision-frontend build:native-helper` adds the
inert ABI-1 entry and nine namespaced chunks after the ordinary build. Actual emitted-module
tests and the fixed-helper/route regression pass **80 tests in seven files**. All 196 normal
index/assets SHA256 hashes remain unchanged. The separate build uses no normal Vite config,
preload plugin, public directory or environment file. Evidence:
`/workspace/vision-native-helper-normal-hashes.json` and
`/workspace/vision-helper-combined80.log`.

`NativeHelperDocumentSession`/`NativeHelperDocumentBridge` and their tests are dormant Core
authority/ABI foundations. Eleven exact-source Swift tests in two suites pass. The actual
Swift-emitted existing bridge, narrow document-start script and fixed commands pass 75 checks
against byte-identical built helper entry/chunks; Swift codecs accept 14 emitted wire messages.
Separate script VM checks pass 43 assertions. No provider, storage or generic bridge call occurs.
Evidence: `/workspace/vision-native-helper-host-proof/verification.json`; manifest SHA256
`e19899de5bbc068e05e692b592c3b6672d774b5c177677b5f6a44bb193d33d09`.
These are Foundation/Node synthetic checks, not WebKit. Actual navigation/store admission,
supervisor-owned Demo eligibility, bounded physical callback and per-document locale ownership
must still be wired. A healthy developer backend override is not a Demo launch receipt.

The immutable default `retainedWeb` presentation remains. Optional helper presentation never
returns `.web`: native loading/unavailable/Not Found and an AppKit-hidden, noninteractive,
accessibility-excluded helper enclosure replace its fallback. The SDK's print policy now checks
native eligibility before capture and again after asynchronous preparation. Five Core tests
and four UI cases are authored; their macOS run is pending.

Actual PDF inspection found all 29 readiness probes contain only empty drawing streams,
while custom NSView pages retain correct text. The follow-up initializes AppKit via a genuine
`NSApplication.run()` launch turn and actual event dispatch before print/focus hosts, and renders
PDFs through no-panel `NSPrintOperation.pdfOperation`, matching production print hooks. It keeps
all activation/key-window/content/media assertions and adds process/window diagnostics to the
failure artifact. Syntax/format checks pass; no repaired AppKit/render result is claimed yet.

The next SDK seams are source-confirmed: preserve supervised Demo provenance currently lost in
`.ready(URL)`; forward actual WKNavigation/store identity; install only the narrow helper handler;
separately accept current ready callback and physical launch receipt; reconcile locale before
native startup/input; native cold intents/menus, vibrancy and titlebar; drain-based fresh-document
retry/reload/restore. The helper remains default-off and no session migrates real data.
Packaging must build the helper into `VISION_FRONTEND_DIST` after its staged ordinary build and
before runtime copying; the standalone helper command targets repository dist. Existing
`install-native.sh` builds Release, which cannot enable the proposed Debug-only experiment.

`NativeShellIntentCoordinator` plus optional `nativeIntents` model integration now owns gated
cold CSV/new-transaction and native Settings/theme commands when explicitly supplied. Retain
one coordinator across ordinary rebuilds: leases reject old graphs, committed raw history and
unconsumed actions survive, registered CSV expiry is not renewed, and consumed Add/import state
does not replay. A replacement cancels its old Leave prompt while preserving a cold destination;
first attachment retains a legitimate initial pending startup request. Native consumers must
explicitly acknowledge readiness; an attempted navigation is insufficient. Default nil behavior
is unchanged. Seven coordinator tests, a four-case source CSV oracle and lease/expiry mutation
checks pass at `/workspace/scratch/native-intent-check/verification.json`, with exact five
routing/coordinator sources plus documented ImportFile/route adapters. Seven shell integration
tests are authored and parsed, not yet semantically checked on macOS. SDK ingress/UI consumer
hooks and the separate successful-restore fresh-authority policy remain unwired.

## Phase-4 dependency recheck (2026-10-15)

The former scratch audit is absent, so these source-confirmed dependencies replace its
unavailable path as the continuation starting point. They are outstanding work, not a
claim that web retirement has happened:

- `ShellRootView.swift` keeps `webContent` mounted under native screens. Removing that
  presentation alone does not remove its routing, storage or helper dependencies.
- `ShellController.makeShellModel` still delegates `onNavigate` to renderer menu messages.
  Native route/history ownership must preserve push/replace/back behavior, settings/report
  query state, legacy `/portfolio/performance` redirects and admin-mode redirects before
  the retained router can retire. `NativeShellModel.detail` still delegates those last two
  cases to web presentation.
- Narrow local/session storage callbacks in `ShellController` require the ready web view.
  Preserve the existing key allowlists, missing-versus-null/string semantics, backup registry,
  session lifetime, accepted-write drains and generation ownership when replacing them.
- Palette answers and report fiscal context use fixed `__visionNativePaletteAnswer`,
  `__visionNativeTaxReportProfile` and `__visionNativeTaxReportContext` callbacks. Retain
  the shared TypeScript source calculations and its input contracts; do not recompute them
  in Swift or replace them with a broad arbitrary-code bridge.
- `reloadNativeSettingsFrontend`, graph reconstruction and `rendererReady` still use document
  readiness to sequence startup, successful/failed restore and fresh onboarding authority.
  Decouple that readiness only with matching lifecycle tests; hiding a web view is insufficient.
- Keep phase-3p accepted-action drains and immutable print snapshots intact. Prepare the
  new switch-over ADR and verify the native route/storage/helper replacement before claiming
  phase 4 complete. Real data migration is outside this continuation.

## Historical continuation work (2026-10-13)

At this checkpoint, the latest full remote save was **`368a0317`**, pushed and verified
after **`2ef06366`**. The later resume and parallel-continuation sections above supersede
its source status, ownership and next-save instructions. Root owns publication; never
wait for manual owner verification or a Demo intermission to proceed.

The definitive phase-3p Foundation proof passes **1,271 tests in 161 suites**, with zero
source drift: 239 actual production sources (229 exact, ten documented platform
extracts/adapters), 86 permanent test files (84 exact, two adaptations), retaining every
predecessor file from the 1,173-test phase-3o proof. Manifest SHA
`bb19da749c03df558f0e0ed5b342697aba016117b43d0c4b34a283867f599f35`, artifacts
`/workspace/vision-shell-overlays-combined-check/{final.log,verification.json,SHA-manifest.json}`.
**Keep this proof immutable.** It includes the Print menu and restricted storage-key
fixture, but excludes subsequent Tax printable-page preparation, SDK and rendered UI.

The phase-3p priorities recorded at that checkpoint were:

1. Follow automatic macOS app/package builds and repair actual compiler diagnostics.
   The app build passed at `2ef06366`; its package run was cancelled by a later safety push.
   Newer source needs fresh app/package checks. Keep SDK runtime/PDFKit/crypto/VoiceOver
   claims explicitly unverified.
2. Finish SDK shared Home upcoming/dismissal wiring, false/true renderer-ready transitions
   and distinct native-owned versus legacy-web restore reload paths. Native backup must
   settle frontend state/fresh onboarding ACK before its delayed reload; legacy web
   restore applies state and reloads itself. Neither path may leave fresh startup stranded.
3. Finish immutable loaded Tax-page print rendering and actual File Print/Cmd-P dispatch
   and availability. Preserve selected year and visible widgets, without new fiscal queries
   or calculations. Inspect current-view printing on Statistics and Net worth as well;
   a generic PDF export is a separate workflow.
4. Complete bidirectional FX cache refresh: banner refresh updates an active rates page;
   rates-page refresh invalidates/refetches the global warning using stored rates only.
   Forced status reads must replace older passive reads without repeating the provider POST.
5. Complete overlay keyboard/focus restoration and scoped parity/structural docs, then
   verify new source outside the immutable proof with distinct artifacts and run macOS
   tests. Frontend fiscal fallback tests/typecheck/build passed, with all fiscal modules
   lazy; actual measured gzip totals are 474.69 KB preload/1,373.85 KB total and the
   reviewed final budgets are 475/1,374 KB.
6. Proceed autonomously to phase 4's new ADR and staged native web-presentation retirement,
   preserving financial computations, navigation/history, storage/restore and active drafts.

Owners at that checkpoint: `palette_cont` SDK; `palette_ts_cont` frontend/shared-source bridges;
`docs_reports_cont` Reports/print/parity/diagrams; `onboarding_cont` Onboarding/overlay UI;
`banners_cont` Home/rates/notifications; `verify_cont` proofs and read-only phase-4 dependency
audit; Root shared Core/menu/tests/catalogs/handoff/commits/pushes. These historical
assignments do not supersede the parallel continuation above.

## Completed checkpoints

| Commit                 | Work                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `821504e3`             | Home and Insights, phase 3g                                     |
| `039e6b4e`             | TypeScript Belgian-tax prerequisite                             |
| `a0f82b22`, `719f1bab` | Tax frozen overview and phase 3h                                |
| `33d6bbad`             | Portfolio, Holdings, Rebalance and Net worth, phase 3i          |
| `11d3102e`             | Portfolio import and Tax, phase 3j                              |
| `198a29cd`             | Analysis and Monitors, phase 3k                                 |
| `1aa760ba`             | Research home, Markets, Lookup, Watchlist and Compare, phase 3l |
| `a9957d4e`             | Forecast and Chart Builder, phase 3m                            |
| `17158f6d`             | Dossiers and AI Chat/Investigation, phase 3n                    |

All Research/AI inventory actions have native implementations. Per-screen visual approval
and the full macOS compiler/runtime checks remain pending; implementation status alone
does not satisfy those gates.

## Latest continuation checkpoint

`86c34c71` saved all 89 dirty task files and was verified on the GitHub branch.
`2310593d` subsequently fixed five account-picker identities exposed by the real macOS
build and was pushed and verified. That build passed the earlier Home/Tax/account
diagnostics, then Xcode 26.6 crashed during Analysis query-view IR generation. The next
checkpoint replaces bound model setters with explicit closures to avoid that compiler
reabstraction; the automatic rebuild must confirm the result.

The `ce1848ee` checkpoint was pushed and verified, saving all 15 task files present at
the snapshot, including Main/HTTP/stream restore fences and the Analysis workaround.
Its macOS build passed that compiler crash and next reported the Portfolio freshness
helper reading MainActor shell state from an unisolated function. The follow-up marks
that helper MainActor; source parsing/format checks pass, and CI will rerun.

`bf658d4a` is pushed and verified. The next macOS compile passed that Portfolio helper
and found type-checking timeouts in `AIChatToolChart` and `AIInvestigationView`. Their
follow-up splits chart marks and the OpenAI picker into typed helpers, preserving the
same values, rendering and labels. The macOS rerun must establish compilation.

Main Settings now passes 33 tests, including six restore-lifetime cases. The data-session
proof now passes 13 cases: paused reads fail before delegation, and a read epoch invalidates
pre-restore responses even if audit verification rolls back and the same session resumes.
Accepted mutations still drain actual delegate completions. The SDK common restore path
now coalesces fresh-model reconstruction for both native Backup and retained onboarding;
overlapping restore receipts act only on their own UUID fence. Root's fresh combined proof
is still pending, and source scope is recorded rather than inferred from earlier proofs.

Independent remaining phase-3 shell preparation has started in parallel: banners owned by
`review_native`, command palette/shortcuts/404 by `tax_charts_ui`, and native onboarding by
`tax_deductions`. Their new files are unfinished and not mounted yet. Do not count these
surfaces as complete merely because their scaffolding appears in a later safety checkpoint.

## Environment refresh checkpoint (2026-10-13 22:23 UTC)

The workspace survived an execution-environment refresh with all dirty work intact.
The old live agent processes did not survive; restart parallel owners from the files and
assignments below. This checkpoint saves every dirty tracked and new task file currently
present, including incomplete phase-3 shell preparation. It is deliberately a safety save,
not a completed phase claim. Last verified remote before this save: `1fce9851`.

The `1fce9851` macOS build passed the AI chart/picker compile stage. It next reported:
`ResearchCompareView` uses an unsupported `showZero` argument, `ResearchScreenView` omits
the watchlist-add model, and `ResearchWatchlistChartSheet` needs its chart expression split.
Full job evidence is `/workspace/vision-native-macos-seventh-build.log` outside the repo.
Fix these automatically and keep following the next app/package build results.

Current unmounted shell preparation: Palette Core data/service/model and its UI,
Shortcuts Help and Not Found UI; Onboarding draft/service/model with its UI and tests still
missing; FX/upcoming Core models and banners with tests/integration still missing.
`createCategory` is now in the native generator allowlist; existing `importCsv` uses a
hand-written multipart operation. The reusable Backup model has restore-only activation
and an acknowledged-restore callback; its new synthetic test needs final verification.

Next integration must mount these surfaces while retaining the current native route model,
provide the fixed shared-TypeScript palette arithmetic/FX answer callback, bind narrow
storage callbacks, and use fresh restored-database authority to finish onboarding after
restore rather than trying the retired writer. Onboarding category presets preserve the
source partial-success behavior. Shared native PDF/report dialogs and Tax print are next;
their existing OpenAPI report descriptions need reconciliation with actual binary PDF routes.

Main Settings 33 tests and API-session 13 tests passed before this refresh. Final frontend
takeover evidence records 81 tests, typecheck and lint. The fresh combined proof remains
unfinished: the initial run found two test-fixture errors that have been corrected, then
unmounted Palette preparation briefly failed compilation; that optional-array expression
is corrected on disk. Preserve earlier immutable proofs. Refresh the exact final scope
and hash manifest rather than reporting those partial logs as a completed combined run.

## Next full-work snapshot (2026-10-13 22:35 UTC)

`0a8fa5ab` is pushed and verified and saved all 40 files present after recovery. Live
parallel owners were restarted as `onboarding_cont`, `palette_cont`, `banners_cont`,
`verify_cont`, `palette_ts_cont` and `docs_reports_cont`. Root owns shared shell/SDK/bridge
integration, generation and publication. The current next snapshot includes every dirty
task file, including new UI/tests and unfinished Reports scaffolding.

The three Research compiler repairs are on disk: use Decimal sign-formatting's actual
`includingZero` label, provide the existing watchlist-add model to Lookup, and split the
Watchlist target editor into typed helpers. Mac CI must confirm these repairs.

Current source prep is still unmounted. Onboarding now has three Core files, three UI
files and 14 synthetic tests; Palette has three Core/three UI files plus source-score and
lifecycle tests; banners have 10 tests and the reusable Backup suite has 15 tests.
Their focused final proofs are running. Accepted local draft/recents/dismissal writes must
be drained before restored frontend state is applied; SDK storage callbacks must be bound
to the original factory generation. Ordinary overlay dismissal keeps accepted writes alive.

The fixed TypeScript palette answer module/component is implemented, with arithmetic/FX
delegated to existing source helpers and the shared rate cache. Its first 27 focused tests
passed; minimal AppLayout mounting and broader integration/type checks are underway.
Native activation still needs document-start capability and SDK/native overlay wiring.
All existing React palette, shortcuts, banners and onboarding mounts remain in place until
their corresponding native graph is actually mounted.

The report specification now matches the existing binary PDF routes and period/sections/
theme/currency/tax-context request fields. Runtime is unchanged; stale generated JSON/date
consumers see a corrective breaking specification change. All 10 existing report parser
tests pass and the endpoint matrix remains 309 HTTP operations/336 combined entries.
Frontend types have been regenerated. Native Reports currently has four Core scaffolding
files only; UI, focused proofs, save/print and origin-query integration remain to be done.

The exact phase-3o combined focus passed 79 tests in six suites. Full proof is rebuilding
its scoped 222 actual production sources and 79 permanent test files; unfinished unmounted
phase-3p prep is explicitly excluded. Do not describe this as a completed full run yet.
The frontend report generation and 137 additional existing EN/NL native catalog keys are
included in this snapshot. Structural flow docs/tests pass at 101 components/74 flows.

## Full integration checkpoint (2026-10-13 23:07 UTC)

`fcd7ee95` saved all 48 task files and is pushed and verified on the remote branch.
Parallel work continues on restore coordination, source report edge cases and verification.
The ninth macOS build passed the earlier Research/Onboarding diagnostics, then Xcode
crashed in AIChatView IR generation when adapting an actor-bound enum setter to Binding.
The follow-up uses an explicit closure, as with the earlier Analysis compiler workaround.
The next automatic app/package build must confirm it; no full macOS build has passed yet.

`b0623fef` saved all 44 files from the previous snapshot; `3d7e3997` fixed the Onboarding
multipart/notice API labels. Both are pushed, with remote `3d7e3997` verified. This next
safety checkpoint saves every current tracked/new task file, including unfinished SDK
coordination. Root should continue work after pushing; no owner demo or approval pause.

The immutable Phase-3o Foundation proof now passes **1,173 tests in 153 suites**, retaining
all predecessor tests: 222 actual production sources and 79 permanent test files, zero hash
drift. Manifest SHA `fb0ea6f968f6d66be563937c3ab7563c3722af83e76df500720de6494b5a9a70`,
`/workspace/vision-settings-shell-combined-check/verification.json`. This does not certify
live SSE, Keychain/crypto, SDK, macOS UI or rendered accessibility.

Phase-3p slices passed focused proofs: Palette 15 cases plus 4,096 cmdk comparisons;
Onboarding 16 cases including ECMAScript trim/fresh restore authority; banners/Backup 25;
shared Home/rate-cache 17; Reports/context 30; new local write-session five. All final
reported slice manifests match their production sources. Frontend takeover passed 152
regression tests, typecheck, lint and build; fiscal schema/migration/runtime chunks remain
lazy. The separate initial broadened Swift proof passed 107 tests in eight suites before
shared graph integration changed; its newer full proof is still pending.

Root now mounts the optional four models through a shared shell: native palette/shortcuts,
seven-step onboarding, FX/upcoming banners, Not Found and PDF report sheet. One sheet keeps
lower overlay views mounted and hides their input/accessibility/announcements while a
higher overlay is active. Startup local reads wait for renderer readiness. The fixed
TypeScript arithmetic/FX and tax-profile projection handlers retain source calculations;
strict individual capability flags suppress their matching React surfaces. Trusted
`shell:open-overlay` accepts only palette/shortcuts. A further 43 existing report locale
keys have been generated. These mounts are on disk, not yet verified end to end on macOS.

**SDK unfinished and next priority:** `palette_cont` owns `ShellController.swift`. The
before-restore local write actor is wired to ordinary typed and legacy WK mutation paths,
with tickets released on actual WK completion, including callbacks after the caller's
five-second timeout. Failed restore resumes the same local actor; success retires old
queued writes. Complete early graph-rebuild/restore frontend-state ordering, preserve the
source delayed retained-page reload, wrap remaining Chart/SQL/Tax/Portfolio/Admin factory
closures with originating generation/session, and fence remaining session-tier/reminder/
restart mirror writes. Fresh onboarding completion must use new database authority and
remove v1 state only after its real ACK; never route it through retired actors. Draining
only model tasks twice is insufficient: an HTTP ACK can enqueue a local write afterward.

Other remaining integration work: add trusted overlay IPC and shared-shell regression
tests, complete native Tax print/menu binding, resolve out-of-range custom report years
using source store resolvers/shared engine (overview restricts 1900–2200 while source custom
date years are broader), synchronize parity action rows/diagrams after stable mounting, run
fresh complete exact-scope Swift proof and final generator/locales/types/build checks, and
follow actual macOS compiler/package results. The current bundle-size guard also needs the
reviewed minimal 475/1373 KB budgets: b062 was already above the old guard, and takeover adds
only 1.20 KB boot/1.94 KB total. `palette_ts_cont` owns that measured comment/docs update.

Owners: `palette_cont` SDK; `onboarding_cont` Onboarding/union UI; `banners_cont` shared
Home/rates/banners; `docs_reports_cont` Reports/context and later diagrams;
`palette_ts_cont` frontend takeover/size guard/source context fallback;
`verify_cont` new local actor, read-only integration review and fresh combined proof.
Root owns Core shell/bridge/notice integration, final tests/catalogs/docs/commits/pushes.

The API data-session actor and wrapper now exist on disk, and the SDK uses one shared
session for HTTP and streams. Accepted restore confirmation drains Main Settings, the
legacy host writer, old chat streams and the data session before the existing unfenced
backup restore operation. A failed restore resumes the same actors; success retires them
and reconstructs the graph. Main model and persistence fences are now on disk. Settings
controls are disabled during suspension; controlled transport tests are still being
completed. Inspect actual code rather than treating this wiring as
verified. New root tests cover trusted preference IPC, same-route onboarding, native
Settings route/history retention and stale Settings-read protection; these are not yet
part of a completed combined proof.

The final documentation snapshot describes 100 flow components and 74 flows. Five flow
tests and structural/link checks passed. Final combined Swift proof, full macOS app build
and package tests remain pending; the earlier 979-test proof is preserved unchanged.

## Historical phase-3o ownership

Agents share a filesystem. Assign disjoint files and coordinate public interfaces before
editing another owner's files. Root alone integrates shared APIs, generated files,
localization catalogs, shell/router/factory, top-level docs and publishing.

| Owner                | Current assignment                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tax_overview_ui`    | New `Core/Settings/NativeSettings*.swift` main raw-settings model/service and tests, excluding desktop/AI/backup/about files                                           |
| `tax_deductions`     | Settings window/rail, General and Appearance UI; shared Settings UI primitives                                                                                         |
| `tax_charts_ui`      | Settings Insights/statistics and Behavior UI                                                                                                                           |
| `tax_charts_backend` | Settings AI, provider keys and AgentCloak Core/UI and tests                                                                                                            |
| `review_native`      | Settings Backup/About Core/UI; Foundation desktop-service interface and tests                                                                                          |
| `tax_profile`        | Independent source-parity review and new combined verification harness                                                                                                 |
| Root                 | Global notices/Undo, six undo adapters, native Settings hosting/navigation, desktop SDK callbacks, shared settings projection/API/catalog, integration and commit/push |

Ownership has expanded after the initial parallel slices:

- `tax_deductions` also owns ordinary-notice attachments and now the sole phase-3o SDK
  edits in `VisionNative/ShellController.swift` (factory, existing desktop callbacks,
  safe script evaluator, restore reload, display cadence). Root must not race that file.
- `tax_charts_ui` also owns `Shell/NativeSettingsStorageBridge.swift`, its synthetic
  tests and the new branch macOS workflow; these are ready for integration.
- `tax_charts_backend` owns shared AI status/model read receipts and in-flight deduplication,
  including narrowly scoped `APIClient.swift` plumbing. Root must coordinate before editing it.
- `tax_overview_ui` also owns new native appearance resolution and missing typed app-settings
  projections; the main persistence model has passed its focused checks.
- `tax_profile` is implementing the frontend native-Settings takeover in addition to review/
  harness work. The source router must retain Settings history while hidden React Settings
  panes are suppressed and preference drafts/acknowledgements synchronize without double writes.
  Root owns `ElectronBridge`'s new `close-settings` action; coordinate frontend files.

Core paths above are relative to `apps/native/Sources/VisionNativeCore`; UI paths are under
`apps/native/Sources/VisionNativeUI/Screens/Settings`. Existing source
`apps/frontend/src/features/settings/` defines the parity contract. Settings section IDs are
`general`, `appearance`, `statistics`, `behavior`, `ai`, `backup`, `about`.

## Historical phase-3o task list

1. Implement and integrate native Settings without serializing a lossy typed read projection
   back over the raw saved objects. Preserve unknown app/dashboard fields and absent values;
   theme writes reconstruct the source's four fields. Match
   per-key first-read CAS baselines, serialized 500 ms debounce, acknowledged-baseline
   advancement and source failure behaviour. Host `SettingsSync` is a separate persistence
   contract; do not conflate it with backend `app_settings` writes.
2. Implement all section actions, exact reset scope and source confirmations. Reset-all
   resets app/dashboard preferences and `includeTransfers`; it does not remove provider
   credentials, theme, Life scenarios or other stored settings. Theme editor needs raw
   mode/schedule/variant/system-accent and the separate session override.
3. Reuse actual shell desktop backup/service/passphrase/file-picker callbacks. No new HTTP
   wrapper or simulated host runtime. Preserve cancellation and receipt/error semantics.
   The updater is the explicitly approved cut in ADR-204 section 5.
4. Integrate Settings query push/replace/back/close behaviour while preserving unrelated
   route parameters and underlying native drafts. Handle initial deep links. Compare
   actual setting dependencies before invalidating unrelated financial/provider reads.
5. Add app-wide ordinary notices and one shared Undo slot with an absolute eight-second
   deadline. Consume before awaiting; the newest registration replaces the shortcut slot;
   text editing keeps its native Undo. Keep notices/actions alive across navigation.
6. Adapt Transactions, Recipients, Categories, Planned payments, Life scenarios and Chart
   Builder. Capture the durable target/restore value rather than depending on mutable
   current selection/cache. Planned Undo currently requires a cached row; Life clears its
   snapshot on exit; Charts unload storage on exit. Fix those safely, preserving exact
   storage authority and acknowledged-write semantics. Other toast actions are not Undo.
7. Merge existing EN/NL keys into the native catalog; update API allowlist/generated clients
   only for existing operations; update parity and affected architecture/flow docs after
   actual implementation stabilizes. Run meaningful persistence/lifecycle/race tests,
   repository checks and a fresh combined Swift proof before a verified checkpoint.

Specific unfinished integration at this snapshot:

- Wire all four Settings models in the actual SDK factory and reuse host backup/service APIs.
  Rebuild native query models and their CAS writers after confirmed backup restore; the
  source full reload cannot leave old native IDs or poisoned pre-restore baselines alive.
- Complete shared AI read receipts/in-flight deduplication, then connect the broker to
  Settings and Chat/Investigation without fetching fresh shared status twice.
- Suppress the retained React Settings dialog only under a new native-Settings capability,
  preserving older native-navigation builds' web fallback. Synchronize live native drafts
  and acknowledged baselines; web-origin preference changes must be forwarded rather than
  silently discarded or written by both hydration providers and the native writer.
- Attach ordinary notice publishers (including dynamic database editors), finish captured
  Undo cross-route/race tests, protect editable WK controls from the native Cmd-Z shortcut,
  and wire notice descriptions and source-specific lifetimes.
- Wire source theme/system-accent/visual-effects/display-cap behaviour and immediate
  language/format updates, then complete catalogs, parity docs and final checks.

Provider credentials must remain masked. AI provider Save trims and clears the draft
immediately, including when its write later fails; Clear is allowed only for
`source=settings`. Insights group toggles apply to search-filtered rows, including hidden
items with badges. Recipients read only the first 1,000 and sort excluded items first.

## Verification evidence and limitations

At `17158f6d`, **979 Swift tests in 130 suites** passed in a Linux Foundation harness using
197 production sources (190 exact and seven documented platform adaptations), 58 repository
test files and a test-only hash adapter. Manifest SHA:
`cf82e222dc946659f81fd50ff3a62859a5d8546680d13a194c5c1c6a2029532c`.
The immutable workspace proof is `/workspace/vision-dossiers-ai-combined-check`.
It is an ephemeral validation artifact, not a remote dependency or a substitute for macOS.
Preserve it if present. A new phase needs a new proof directory and hashes of actual sources.

Phase 3n also passed 46 focused backend tests, 32 focused frontend tests, frontend/backend/
package type checks, build, lint, locale validation, API matrix and boundaries, native
generation drift checks, seven generator tests and five flow-visualizer tests. The API
matrix has 309 HTTP methods, 336 operations including health/IPC. The flow visualizer has
97 components and 70 flows.

Full SwiftUI/AppKit/WebKit semantic compilation, rendered views, VoiceOver, macOS Demo
parity and performance checks **have not been run in this Linux environment**.
Do not report them as passed. Previous proof directories for phases 3l and 3m are also
immutable; don't silently refresh them to match new code.

Automatic macOS verification is now available through branch pushes. The first run,
`https://github.com/EraPartner/Vision/actions/runs/38461360344`, built `0a9413e3` on
macOS 26.6.2 and failed on three Home date-formatting overload errors. Package tests were
skipped after the build failure. The compiler fix adds the existing Date overload's
missing default time zone; four meaningful date/time-zone/DST tests pass locally.
This is the first native compiler feedback, not a successful full build. Continue fixing
actual runner errors and pushing; no manual owner verification is required to proceed.
The first job's logs are at `/workspace/vision-native-macos-first-build.log` if present.
CLI Actions API access was denied by the workspace network policy. The permitted public
GitHub Actions page supplied the run ID; GitHub connector workflow job/log tools then
provided the actual status and compiler errors.

## Latest integration checkpoint

**`86c34c71`** published all 89 current integration files and this handoff. Its automatic
macOS run `https://github.com/EraPartner/Vision/actions/runs/38473045992` passed the Tax
callback stage and found five Portfolio account-picker `ForEach` identity errors. The
follow-up fix supplies the existing account primary key explicitly at those five sites;
no account data or selection behaviour changes. The new runner logs are saved at
`/workspace/vision-native-macos-third-build.log`. Full native build/test still has not passed.

The phase-3o frontend/backend/package type checks, frontend build, locale validation,
endpoint matrix and package boundaries passed at this checkpoint. Frontend/backend lint
passed with existing warnings. The documentation visualizer now has 100 components and
74 flows; five flow tests and geometry/ID validation passed after the saved WIP layout was
corrected. Final combined Swift and restore-lifetime tests remain pending.

`7e023475` published the Home date-overload fix. The next automatic run,
`https://github.com/EraPartner/Vision/actions/runs/38462560168`, passed that compiler stage
and failed on Tax Overview's missing `try` in a deduction callback. The current checkpoint
includes the one-line `try await` fix; the existing deduction model handles failures and
records success only after an acknowledged result. Logs:
`/workspace/vision-native-macos-second-build.log`.

The SDK Settings factory and existing desktop callbacks are now wired in
`apps/native/VisionNative/ShellController.swift`, including raw draft/ACK mirrors, source
route history, global notices, language, appearance/session tier, display/schedule checks,
and fresh native model/host reconstruction after a successful restore. The frontend
native-Settings takeover now suppresses hidden React Settings panes, forwards known field
deltas to the native writer, and applies native drafts/ACKs without duplicate saves. A new
restricted native-only `shell:settings-change` channel handles exactly app/dashboard/theme
preferences; optional onboarding visibility on the existing route channel keeps the
retained wizard visible. No HTTP operations were added. The endpoint-matrix total counts
Electron IPC separately and remains 336.

Additional focused evidence: 59 AI/settings/shared-read tests, 52 portfolio-notice tests,
14 Backup/About tests, six semantic accent tests and four date formatter tests passed.
The frontend takeover passed its focused tests and type check before its final onboarding
coverage adjustments; rerun after the final diff. A root Foundation integration proof
compiled actual bridge/notice/settings sources and reported 30 passing focused tests, but
nine sources changed during that run, so it is an early result, not final hash-matched
verification. New combined verification remains pending.

**Still unverified at this safety checkpoint:** the before-restore lifetime fences.
The main Settings model now suspends/drains accepted writes, preserves pending drafts and
the same sticky CAS writer on a failed/cancelled restore, and retires permanently only for
an actual successful reload. The per-client `NativeDataSession` HTTP/stream wrapper now
pauses new mutations and drains actual delegate completions before the database switches;
failed restores resume the same session, successful reloads reject old queued work and
use a fresh session. Root's host `SettingsWriter` fence and three tests are on disk but
not yet validated. The intended SDK order is Main Settings drain, host Settings writer
drain, old chat stream stop, API session drain, then the existing restore operation.
Keep the restore operation's own transport unfenced to avoid a deadlock. This fencing is
wired end to end but awaiting new gated proofs and a successful macOS build; do not
claim the native backup restore is verified.

Remaining owners: `tax_overview_ui` main Settings fence/tests and root proof support;
`tax_charts_ui` new API data-session fence/tests; `tax_deductions` SDK fence wiring;
`tax_profile` frontend/onboarding final tests and combined proof; `tax_charts_backend`
architecture/flow documentation; Root integration/tests/checks/publishing. `review_native`
finished its assigned portfolio notices, Backup trim and scoped parity documentation.
The broad UI/runtime, final catalogs/docs checks and actual macOS build/test are still
required. Keep publishing unfinished checkpoints as well as verified milestones.

## Restore and source parity checkpoint (2026-10-13 23:20 UTC)

`c188f14b` saved all 28 dirty/new task files and is pushed and verified. Its macOS build
passed the bound-setter compiler workarounds and next reported StatisticsView's card
helper capturing a non-escaping content closure in an escaping view builder. The
follow-up annotates the content closure `@escaping`; the next app/package run is required.
New native File Print/Cmd-P plumbing and immutable Tax page printing are in progress.

`7f11b123` is pushed and verified after `fcd7ee95`. Its macOS build passed the AI Chat
picker workaround, then crashed on the same actor-bound String setter in
AnalysisMonitorsCreationView. The next snapshot saves explicit closure workarounds for
that view, Research Watchlist search, Backup toggle and Reports type picker. Full
app/package compilation remains unverified; evidence is
`/workspace/vision-native-macos-tenth-build.log` outside the repository.

The SDK restore coordinator now fences actual WebKit callback completion, including
completion after a logical timeout. Chart/Tax/SQL/Portfolio/Admin factory callbacks
capture their originating generation, so retired callbacks cannot write through fresh
storage authority. Native restore intent defers renderer-ready reconstruction until
frontend state and fresh restored-database onboarding acknowledgment settle, then the
source delayed callback rebuilds once and fully reloads the WebView. These SDK changes
are still awaiting real macOS compilation and focused final review.

On disk: retryable cancelled onboarding/banner storage reads; silent expected retirement
cancellation; idempotent upcoming-badge teardown; an FX read generation that prevents an
old GET receipt replacing the result of an explicit cache invalidation/retry. Their new
tests are in progress. Root added restricted trusted-overlay bridge tests, immutable
JavaScriptCore capability tests, and route-preserving overlay/copy/report/404 cases.

The extreme Tax-report custom-year fallback is being implemented through fresh raw fiscal
settings and the existing retained TypeScript resolvers/engine. Preserve source one-partner
success and the two-partner endpoint validation rejection; do not clamp years, widen the
API, or drop configured household fields. The common composition is being extracted for
both web export and the fixed native callback, with fiscal modules staying lazy.
Tax visible-page printing remains unfinished: generic all-section PDF printing does not
preserve the source's current loaded year and visible-widget print behavior.

Preliminary new combined proof passed **150 tests in 13 suites** after compiling 239
actual production sources and 86 permanent test files. Ten files changed during that run,
so it is not the final hash-matched proof. The next fresh focused/full snapshots must
include the new tests and latest cancellation/context fixes. Preserve the immutable
phase-3o 1,173-test proof. Root validation before this snapshot passed frontend typecheck,
lint (zero errors; 35 existing warnings), locale parity/drift, all native generators,
309 endpoint matrix and package boundaries. Further source edits require appropriate
fresh checks. The measured frontend size budget adjustment is 475 KB preload/1,373 KB total,
based on a 472.94/1,370.35 KB prior snapshot and 474.14/1,372.29 KB overlay implementation;
the actual final artifact guard and source-context chunk growth remain under verification.

Continue after the full commit and push. Current owners remain SDK `palette_cont`,
frontend/source helpers `palette_ts_cont`, Reports/print/docs `docs_reports_cont`,
Onboarding/overlay UI `onboarding_cont`, banners/Home/rates `banners_cont`, verification
`verify_cont`, and Root integration/tests/handoff/publication. Finish phase-3 parity gaps,
then autonomously prepare phase 4's new ADR and remove native dependence on web presentation
without losing source fiscal computations, route/state semantics or backup compatibility.
No manual owner verification or phase-start intermission is required.

## Full work checkpoint (2026-10-13 23:31 UTC)

`106774f2` is pushed and verified. Its macOS build passed the prior UI compiler stage and
reported six SDK errors: three invalid JSONValue number cases, unsupported PDF scaling case,
and two off-actor generation checks. The snapshot repairs those with integer JSON cases,
`pageScaleDownToFit` and a MainActor token-read helper. The actual next macOS app/package
build remains required; `/workspace/vision-native-macos-twelfth-build.log` holds the evidence.

This save includes every current task file: Print menu/validation/SDK dispatch and pagination,
immutable Tax print snapshot/presentation/document scaffolding, shared Home upcoming mirrors,
native-versus-legacy restore reload ownership and proper readiness reset, overlay Escape/focus
restoration with four macOS-only tests, forced FX status read generation and successful
rates-refresh callback, strict six-key fixture, reviewed frontend budgets/docs and this handoff.
Source parsing/format checks pass where reported; printing and responder tests require Mac
semantic/runtime validation. Tax chart/disclosure local presentation state needs a follow-up
capture audit; native Statistics/Net-worth print snapshots are not implemented yet.

The immutable 1,271-test proof passed before the newest FX callback/forced-read changes and
Tax print scaffolding. Separate new proof is pending. Onboarding's 20 focused tests pass;
notification lifecycle/rates had 52 passing cases before its two additional cases. Reports
context has 35 passing focused cases. Frontend final regression has 179 cases in 16 files plus
three print-contract checks; full typecheck, lint (zero errors, 35 existing warnings), build
and actual 475/1,374 KB guard pass, with the fiscal modules still lazy.

After pushing, resume source printing/parity docs and the SDK's reverse FX refresh binding.
Cmd-R must deliberately rebuild native models/authority with unsaved-work confirmation and
accepted-write draining; current menu reload only refreshes the web document. Zoom likewise
must affect native detail content using the existing bounded PageZoom factors. Phase-4
dependency audit is read-only preparation while these phase-3 gaps and automated Mac checks
are completed. Continue without an owner intermission.

## Post-checkpoint repairs (2026-10-13 23:37 UTC)

`69415f27` saved all 18 task files and is pushed and verified. Its Mac build found a
Sendable return restriction in the overlay focus monitor: `MainActor.assumeIsolated`
must return Void, with the unchanged NSEvent returned outside. The source repair is
included in the next compiler push; actual AppKit responder tests remain pending.

Review found that typed local shell keys had expanded to six while the emitted JavaScript
guard still accepted only three. The guard now derives from `LocalKey.allCases`.
Actual Swift sources compile and emit the tested scripts; Bun execution passed six raw-string
round trips, 15 denied operations before storage access, injection-string preservation and
the unchanged 15-key manual backup registry. FX dismissal remains excluded from that registry.
Proof: `/workspace/vision-native-storage-script-check`. Permanent JavaScriptCore cases are
added for Mac execution. This is newer source than the immutable 1,271-test proof.

Root added finite bounded native `pageZoom` and `isReloadingGraph` input fencing, with
one new meaningful shell test and a stable-identity native detail zoom wrapper. SDK/UI
wiring is on disk but awaits the next full save, focused Core proof and Mac compilation.
Native Tax local comparison/rules state capture is on disk; Statistics and Net-worth
current-view print work is parallel preparation. Notification/rates latest focused proof
passes 54 cases with zero drift; manifest
`b6f3c6275f163b6e2ae56e5b23807d7cc746b1beac1447bc250de1bb95f49803`.

## Full print/lifecycle checkpoint (2026-10-13 23:42 UTC)

`2ef06366` is pushed and verified after `69415f27`; it saves the actual emitted-storage
guard fix, permanent Mac JavaScriptCore tests, native zoom/reload Core ABI and the focus
monitor compiler repair. The next full checkpoint saves all dirty/new printing and
lifecycle task files, including unfinished preparation and new tests.

Current on-disk scope: native detail zoom/root input fence; SDK normal graph reload and
bidirectional FX cache refresh; shared paginator and Statistics print routing; Tax current
comparison/disclosure snapshot state; Statistics snapshot/inert presentation/document with
five new tests; Net-worth snapshot/presentation/document without tests yet; Tax seven
print tests and synthetic fixtures. Reports now preserves same-page form drafts across
close/reopen and clears them on page leave, with focused tests and Root same-route/type/
query integration. Source parse/format checks pass where reported, but new Core, Mac
rendering and pagination verification are unfinished.

**Normal reload is still in progress:** Onboarding completion/category/import actions,
Analysis SQL-history tails and Portfolio import checkpoint tails must be drained through
their entire accepted logical actions before Main/HTTP/local actors pause. Physical HTTP
completion and two local flushes do not prove a future post-ACK callback has finished.
`onboarding_cont` owns its accepted-action hook; `verify_cont` will implement
`AnalysisModel.flushAcceptedRuns`; `palette_cont` owns the Portfolio commit-tail hook and
SDK await order. Keep restore's intentional old-tail rejection separate so it cannot
deadlock at paused writers. The new hooks are pending at this save.

Next source printing work: Stats width/footer/loaded-snapshot guards and cached-error
behavior; Net-worth semantic tests and SDK binding; Tax proof and capture/lifecycle tests;
light print appearance and readable source chart layouts. Required stable 3p parity/
structural docs have no partial changes yet and remain `docs_reports_cont`'s next chunk.
Keep the 1,271-test proof immutable and establish a new full scope after all new Core
source stabilizes. Follow real Mac compiler/package runs continuously, then proceed to
phase 4 under a new ADR; no user manual verification or intermission is needed.

## Full accepted-action/print checkpoint (2026-10-13 23:53 UTC)

`368a0317` saved all 28 files and is pushed and verified. Its Mac build passed the newer
print/zoom UI stage but failed on the SDK calling flushHistory directly on AnalysisScreens.
The next snapshot fixes both history/run drain calls through its workspace model. Evidence:
`/workspace/vision-native-macos-fifteenth-build.log`. The earlier app build at `2ef06366`
did pass; package tests were cancelled by the next safety push. Branch CI now lets a running
verification finish and retains the newest pending snapshot; workflow policy and seven
tests pass. It still does not install, publish, merge or replace CI Complete.

The next full save includes every current task file and unfinished proof preparation.
On disk: full accepted-action drain hooks for Onboarding, Analysis and Portfolio commit
tails; SDK normal reload awaits these before pausing writers, drains existing local queues,
and respects the input/reload-owner fences. Restore keeps intentional old-tail retirement.
Portfolio commit tests cover both success and lost-ACK tails; Analysis tests cover history
receipt, failed-query cleanup and visit retirement. Their focused proofs are pending.

Current isolated proofs: 24 Onboarding cases pass with zero owned source drift, immutable
`/workspace/vision-onboarding-proof-24`, manifest
`98eb44f6f3d7335d9d331f7598eac3b36e49a824551a35bea0d979e0364bed42`;
37 report/context cases pass including retained form drafts; 19 Statistics cases pass,
including six current-view snapshots and original race/aggregation regressions; Net-worth
11 cases passed before its final metadata refresh. Tax print Core compiled, but an inherited
Analysis fixture/API typo blocked its test target; the fixture is corrected and the next
proof refresh must use that actual corrected test. No actual printer rendering claim.

All three native print routes are wired in source. Tax captures comparison/rules/PIT/
household disclosure state and uses non-scrolling print tables; Statistics captures current
filters, window, selected/hovered values, widget/custom chart data and cached failures;
Net-worth freezes loaded rows, period/currency, chart selections and existing partial/error
states without new queries or financial recomputation. Shared print theme overrides only
the original white-paper page/card/muted/border roles and retains original chart/semantic
colours. SwiftUI semantic/rendered proof still depends on Mac CI.

Required 3p docs are on disk: scoped shell/Tax/PDF/onboarding/API/native architecture,
three PlantUML diagrams and five new native flows, with 106 components/79 flows and all four
indexes synchronized. Five flow tests, frontmatter/links/paths/geometry and format checks
pass. A follow-up should refine notification versus Backup reminder ownership and include
the final Statistics/Net-worth print graph after tests stabilize.

Keep all prior immutable proofs, finish the new lifecycle/print focused proofs and obtain
a fresh complete source scope. Follow Mac results, then implement phase 4 under a new ADR.
The read-only dependency audit is `/workspace/vision-phase4-dependency-audit.txt`; preserve
its staged native route/history/local storage takeover and narrow unchanged-TypeScript
helper operations. No manual owner verification or phase intermission is required.

## Tooling and safety for continuation

- Workspace: `/workspace/Vision`. Bun: `/tmp/vision-tools/package/bin/bun` (1.4.3).
  Swift 6.2.3: `/tmp/vision-tools/swift-6.2.3-RELEASE-ubuntu24.04/usr/bin`.
  Formatting config: `/tmp/vision-swift-format.json`; module cache:
  `/tmp/vision-swift-cache623`. These paths may not survive a new environment; reinstall
  appropriate tooling if absent. Build/harness scratch paths belong outside the repo.
- Read root/nested `AGENTS.md`, relevant docs, localization and documentation-sync skills.
  Never read or print `.env`, real financial data or secret credential values. All test
  fixtures must be synthetic. Do not make real provider requests.
- Keep Git hooks intact. Push normally, never force. Branch tracking is configured; if a
  fresh clone fetches only main, fetch this branch explicitly and verify the remote SHA.
- Continue using existing TypeScript financial computations; money stays `Decimal` in
  Swift. Preserve write acknowledgement, cancellation, route ownership and stale-read
  guards from the completed screens.
- At checkpoint time coordinate writers, inspect every dirty/untracked task file, record
  what is unfinished and which checks ran, commit and push, then verify that the remote
  branch contains the new commit. A local commit alone is not a saved remote checkpoint.

## Subsequent phases

After Settings/shared shell, finish remaining phase-3 parity gaps, including shell chrome,
onboarding, shortcuts/palette, fallback/error flows and any remaining screen-specific
dialogs such as Tax PDF/browser print. Use the inventory rather than assuming all routes
being native means all actions are complete. Then run macOS integration, accessibility,
keyboard/window behaviour, charts, Demo screenshots and performance checks; refine the
native look without changing successful workflows.

The user's latest instruction authorizes continuing through later phases. It does not
make unrun validation gates pass. Prepare and implement later-phase work autonomously;
use available macOS automation when possible, and record any unavailable platform evidence
without blocking other work on an owner visual pass. The explicit instruction supersedes
earlier requirements to pause for manual Demo verification or a new phase-start approval.
Before claiming completed switch-over, prepare its ADR and record the actual automated
validation and remaining gaps. Never connect to or migrate the real
data directory merely to advance the phase. Phase 5 is the optional Swift backend and is
a separately scoped architectural decision in ADR-204, not a prerequisite for a great
Swift frontend port.

## Related

- [[docs/reference/native-parity/index|Native parity inventory]]
- [[docs/reference/native-parity/shell-and-settings|Shell and Settings action inventory]]
- [[docs/adr/204-vision-native-swift-app-target|Swift port decisions and phase gates]]
- [[docs/architecture/index|Architecture index]]
