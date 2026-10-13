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

The first phase-3o safety checkpoint includes Settings window primitives, the seven-section
navigation helper and its tests. They are scaffolding, not a wired Settings screen. The
primitives passed syntax parsing and formatting; the new navigation tests still await the
phase harness. It also includes a narrow Chat UI correction: cached status remains visible
during background status refresh, matching the source's initial-only loading state. That
file passed syntax/format checks; macOS semantic compilation remains pending.

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
