---
title: "Vision Native agent handoff"
type: reference
status: active
date: 2026-10-13
updated: 2026-10-15
tags: [reference, swift-rewrite, native-parity, handoff]
description: "Resumable checkpoint for the Swift port: published branch, current phase, ownership, remaining work, verification evidence and subsequent-phase gates."
---

# Vision Native agent handoff

## Resume here

Continue the Swift frontend port on **`codex/native-phase-3g`**, remote
`https://github.com/EraPartner/Vision.git`. Do not merge or push `main`.
The user explicitly authorized continued work through subsequent phases, parallel agents,
local commits and pushes to this GitHub branch. Preserve workflows and adopt macOS controls
and styling while keeping the source colours, navigation and chart layouts.
The user also explicitly said to continue without requiring manual verification or Demo
steps between phases. Carry out available automated checks and continue independent work;
do not ask the owner to perform those steps as an intermission.

Phase **3o**, Settings and shared shell behaviour, has a hash-matched Foundation proof
of 1,173 tests. Phase **3p**, remaining shell overlays and report parity, is in progress;
its first full mounted integration checkpoint is **`fcd7ee95`**, pushed and verified.
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

Next: inspect the automatic macOS run for this continuation, repair remaining actual
failures (including stream-watchdog and Investigation polling tests if reproduced), then
complete the phase-3p lifecycle/printing validation below. Earlier isolated proof directories
and the phase-4 audit under `/workspace/vision-*` are absent in this fresh environment;
the historical results below are prior evidence, not newly reproduced checks.

## Current continuation work

Latest full remote checkpoint: **`368a0317`**, pushed and verified after **`2ef06366`**.
The next full save must include all subsequent dirty/new task files, this handoff and
the current printing/readiness work. Root owns publication; never wait for manual owner
verification or a Demo intermission to proceed.

The definitive phase-3p Foundation proof passes **1,271 tests in 161 suites**, with zero
source drift: 239 actual production sources (229 exact, ten documented platform
extracts/adapters), 86 permanent test files (84 exact, two adaptations), retaining every
predecessor file from the 1,173-test phase-3o proof. Manifest SHA
`bb19da749c03df558f0e0ed5b342697aba016117b43d0c4b34a283867f599f35`, artifacts
`/workspace/vision-shell-overlays-combined-check/{final.log,verification.json,SHA-manifest.json}`.
**Keep this proof immutable.** It includes the Print menu and restricted storage-key
fixture, but excludes subsequent Tax printable-page preparation, SDK and rendered UI.

Remaining phase-3p work, in priority order:

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

Current owners: `palette_cont` SDK; `palette_ts_cont` frontend/shared-source bridges;
`docs_reports_cont` Reports/print/parity/diagrams; `onboarding_cont` Onboarding/overlay UI;
`banners_cont` Home/rates/notifications; `verify_cont` proofs and read-only phase-4 dependency
audit; Root shared Core/menu/tests/catalogs/handoff/commits/pushes. Below is historical
checkpoint context; this section and current source override older unfinished assignments.

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
