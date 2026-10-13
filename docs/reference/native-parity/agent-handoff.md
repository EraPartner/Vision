---
title: "Vision Native agent handoff"
type: reference
status: active
date: 2026-10-13
updated: 2026-10-13
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

The last completed and published implementation checkpoint is **`17158f6d`**,
`feat(native): port Dossiers and AI chat for phase 3n`. Phase **3o**, Settings and shared shell
behaviour, is now in progress. This handoff records intended work; it does not certify that
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

## Completed checkpoints

| Commit | Work |
| --- | --- |
| `821504e3` | Home and Insights, phase 3g |
| `039e6b4e` | TypeScript Belgian-tax prerequisite |
| `a0f82b22`, `719f1bab` | Tax frozen overview and phase 3h |
| `33d6bbad` | Portfolio, Holdings, Rebalance and Net worth, phase 3i |
| `11d3102e` | Portfolio import and Tax, phase 3j |
| `198a29cd` | Analysis and Monitors, phase 3k |
| `1aa760ba` | Research home, Markets, Lookup, Watchlist and Compare, phase 3l |
| `a9957d4e` | Forecast and Chart Builder, phase 3m |
| `17158f6d` | Dossiers and AI Chat/Investigation, phase 3n |

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

## Active phase 3o ownership

Agents share a filesystem. Assign disjoint files and coordinate public interfaces before
editing another owner's files. Root alone integrates shared APIs, generated files,
localization catalogs, shell/router/factory, top-level docs and publishing.

| Owner | Current assignment |
| --- | --- |
| `tax_overview_ui` | New `Core/Settings/NativeSettings*.swift` main raw-settings model/service and tests, excluding desktop/AI/backup/about files |
| `tax_deductions` | Settings window/rail, General and Appearance UI; shared Settings UI primitives |
| `tax_charts_ui` | Settings Insights/statistics and Behavior UI |
| `tax_charts_backend` | Settings AI, provider keys and AgentCloak Core/UI and tests |
| `review_native` | Settings Backup/About Core/UI; Foundation desktop-service interface and tests |
| `tax_profile` | Independent source-parity review and new combined verification harness |
| Root | Global notices/Undo, six undo adapters, native Settings hosting/navigation, desktop SDK callbacks, shared settings projection/API/catalog, integration and commit/push |

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

## What remains in this phase

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
