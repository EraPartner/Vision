---
title: Swift Backend Port Playbook
type: guide
status: active
date: 2026-10-18
tags: [guide, swift, backend, hummingbird, openapi, native-app, migration, prompts]
description: Phase plan and ready-to-paste Claude Code prompts for porting the TypeScript backend to an in-app Swift backend (ADR-213), run locally on a Mac with Xcode.
aliases: [swift backend playbook, backend port prompts]
related_code: ["apps/node-backend/src/", "apps/native/", "openapi.yaml"]
---

# Swift Backend Port Playbook

How to run the [[docs/adr/213-vision-native-swift-backend|ADR-213]] port with Claude Code on a Mac
with Xcode. Each phase is one or more sessions; each prompt below is meant to be pasted as the
first message of a fresh session. The repository's `AGENTS.md` and `CLAUDE.md` load on their own.

## Before phase 1 (owner actions)

1. Merge `codex/native-phase-3g` into `main` through a pull request so `ci.yml` runs on it (it
   never ran on the branch). Use the *Phase 0* prompt.
2. Accept ADR-213 (or amend it) and answer its open questions; the prompts assume it is accepted.
3. Mac setup: Xcode, `brew install xcodegen postgresql@18`, `bun install`, and a throwaway test
   database for the backend's DB tests (`createdb vision_test`, then
   `export TEST_DATABASE_URL=postgres://localhost/vision_test`). Never point any tool at real data.

## How each session works

- **One phase slice per session.** Start fresh, paste the prompt, let it plan, then work. End when
  the slice's operations are green; do not stretch a session across slices.
- **Local verification is the loop.** `swift build`, `swift test --filter <Suite>` in
  `apps/native`, `bun vitest run <file>` in `apps/node-backend`, and the parity harness from
  phase 2. Push only when it is green; CI then confirms.
- **Effort.** Medium for plumbing and mechanical routes; high for money, tax, imports, security
  and anything the prompt marks *(high)*.
- **Handoff.** Every session ends by updating the *Swift backend* section of
  [[docs/reference/native-parity/agent-handoff|the agent handoff]] with the operations moved, the
  checks run and the next slice. The next session reads it first.

### Shared preamble

Every phase prompt starts with this block; paste it above the phase text.

```text
Context: Vision is moving its TypeScript backend (apps/node-backend) into the Mac app as a Swift
backend (ADR-213: Swift 6 strict concurrency, Hummingbird 2, PostgresNIO with plain SQL,
Foundation Decimal, swift-openapi-generator from openapi.yaml, running in the app process,
Node as fallback owner for operations not yet ported). Read docs/adr/213-vision-native-swift-backend.md,
docs/guides/swift-backend-port.md and the "Swift backend" section of
docs/reference/native-parity/agent-handoff.md before anything else.

Rules for this session:
- Parity first: the TypeScript route, its service and its tests are the specification. Port
  behaviour, including error codes, envelope shape, validation messages, rounding and ordering.
  When TypeScript and docs disagree, follow the code and note it in the handoff.
- Money and tax use Decimal end to end; never Double. Match decimal.js rounding exactly.
- Every ported operation gets: Swift tests translated from the TypeScript tests, a parity-harness
  case against Node on the synthetic Demo data, and its switch entry (default: Node owns it).
- Synthetic data only. Do not read .env files, do not run alembic downgrade, ask before rm in
  packaging/ or dist/.
- Verify locally before every commit: swift build and the relevant swift test filters in
  apps/native, the matching bun vitest files in apps/node-backend, and the parity harness.
- Small commits on the current branch; end by updating the handoff's Swift backend section.
```

## Phase 0: merge and baseline (medium)

```text
<preamble>
Task: get codex/native-phase-3g into main safely. Open a draft PR to main so ci.yml runs, read
every failing job, fix the causes on the branch (no skipped tests), and repeat until CI Complete
is green. Then summarise what changed outside apps/native for my review before I merge. Also run
./install-native.sh --measure once and add its table to the handoff.
```

## Phase 1: foundation (high, 2–3 sessions)

```text
<preamble>
Task: build the in-app Swift backend skeleton, with no business operation moved yet.
1. Add a VisionBackend target to apps/native/Package.swift (and project.yml) using Hummingbird 2,
   PostgresNIO and swift-openapi-generator's server plugin over openapi.yaml. Keep the app's
   existing client generation working.
2. Start it inside the app on the supervised loopback origin after PostgreSQL is ready, with the
   backend's least-privilege role and the same connection settings the Node child gets
   (see Sources/VisionNativeCore/Runtime/ChildEnvironment.swift).
3. Fallback: any operation the Swift side does not own is forwarded byte-for-byte to the Node
   backend, which the supervisor keeps running on an internal port. Streaming responses and
   uploads must pass through unchanged.
4. Port the cross-cutting middleware with tests first: request id, response envelope
   (middleware/envelope.ts), error mapping (middleware/errorHandler.ts), host guard, CSRF guard,
   global and AI rate limits, admin-token checks, body limits.
5. A per-operation owner switch (VISION_SWIFT_BACKEND=off|on plus a per-operationId override
   list), default off, Debug Demo only, logged at startup.
Prove it with one trivial operation (GET /api/info or /health): Swift owns it, everything else
falls through, the e2e smoke still passes, and install-native.sh --measure shows the numbers.
```

## Phase 2: parity harness (medium, 1 session)

```text
<preamble>
Task: build the parity harness every later phase relies on.
- A command (bun script or Swift executable, your call; justify it) that starts both owners on
  the synthetic Demo database, replays a list of requests per operationId against Node and Swift,
  and diffs status, headers that matter, and JSON bodies (order-sensitive where the API is,
  Decimal strings compared exactly).
- Request cases live in a checked-in file per route group; seed them from the existing backend
  tests' fixtures where possible.
- Mutating operations run inside a transaction that is rolled back, or against a fresh copy of
  the Demo database per case.
- Add it to native-e2e.yml as a non-blocking job first, blocking once phase 3 lands.
```

## Phases 3 to 10: route groups

Use one session per bullet in each phase; paste the template with the group filled in.

```text
<preamble>
Task: port this route group to the Swift backend: <GROUP>.
Routes: <ROUTE FILES>. Services and repositories they reach: follow the imports.
For each operation: generated server stub, Swift service and SQL, translated tests, parity cases,
owner switch entry. Reuse Swift code that already exists in apps/native (models, calculations)
instead of duplicating it. When every operation in the group passes locally, flip the group's
default owner to Swift for the Debug Demo, run the e2e smoke and install-native.sh --measure,
and record the group in the handoff.
```

| Phase | Effort | Groups (route modules in `apps/node-backend/src/routes`) |
| --- | --- | --- |
| 3 Reference data | medium | `settings`, `tags`, `categories`, `accounts`; `recipients`, `recipientBankAccounts`; `info`, `savedCharts`, `watchlist` |
| 4 Transactions | high | `transactions`; `splits`, `attachments`; `plannedTransactions` |
| 5 Imports | high | `importRoutes`, `importBatchRoutes`, `parserConfigRoutes`; `portfolioImportRoutes`, `portfolioImportProbeRoutes` |
| 6 Portfolio and markets | high | `investments`, `aggregations`; `marketLookup` and the price providers (`services/prices`); `research`, `researchDossiers`, `researchPresentation` |
| 7 Belgian tax and reports | high | `belgianTax`, `belgianTaxDashboard`, `belgianPortfolioTax`, `belgianTaxSettingsSchemas`; `reports` with native PDF rendering (drops Puppeteer) |
| 8 Analysis | high | `analysis`, `analysisInterchange`; `analysisMonitors`, `crossWorkspace` |
| 9 AI | medium | `ai` (chat streaming), `aiResearch`, `aiResearchDocuments`, `codexExperimental` |
| 10 Admin and jobs | high | `admin`, `internalAudit`; `startup/dailyJobs`, `startup/warmup`, `startup/analysisMonitorScheduler`, `jobs/refreshCashflowForecastMc` |

Notes per phase:

- **5:** CSV and Excel parsing must reproduce the TypeScript parsers' output row for row on every
  bundled sample; add the samples to the parity cases.
- **7:** run the tax parity cases for every year the overview accepts that has data, and compare
  printed reports page by page with the existing print-render tests.
- **9:** streaming needs a parity case that compares the event sequence, not just the final text.
- **10:** jobs move only when their schedule, locking and failure behaviour have tests; run them
  once against the Demo database and compare the rows they write with Node's.

## Phase 11: cut-over (high, 1–2 sessions)

```text
<preamble>
Task: finish ADR-213 for the Debug Demo. Verify every operationId in openapi.yaml is Swift-owned
(add a test that fails if one is not), make Swift the only owner, stop starting the Node child,
remove Node, the compiled backend and Chrome Headless Shell from the native payload
(native-mac-build.sh, install-native.sh, the payload manifest), and update the e2e smoke. Run the
full native test suites, the e2e smoke and install-native.sh --measure; record before/after bundle
size and memory in the handoff, and draft the ADR-213 amendment that records completion. Do not
touch the Electron/Docker path; it keeps the TypeScript backend until its own decision.
```

## Related

- [[docs/adr/213-vision-native-swift-backend|ADR-213: Move the backend into the Mac app in Swift]]
- [[docs/reference/native-parity/agent-handoff|Vision Native agent handoff]]
- [[docs/reference/api-endpoint-matrix|API endpoint matrix]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
