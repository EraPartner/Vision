---
title: Swift backend port handoff
type: guide
status: active
date: 2026-11-24
tags: [guide, swift, native, backend, parity, handoff]
description: State, method and next steps of the ADR-270 Swift backend port, for the agent that continues it on branch claude/project-thread-8yvcm0.
---

# Swift backend port handoff

This page lets the next agent continue the Swift backend port the same way it was done so far.
Read [[docs/adr/270-swift-backend-in-process|ADR-270]] first, then
[[docs/architecture/native-app]] (section on the in-process backend), then this page.

## 0. Start here

1. Merge `origin/main` into `claude/project-thread-8yvcm0` (the branch is behind main).
2. Finish phase P10a (section 8) on top of the WIP commit 53b88d1. Open a draft PR and let macOS CI
   compile it, because the WIP itself has never been built.
3. Then work through section 7 top to bottom. Every PR must meet section 6.

## 1. Goal and rules (from the owner, Tor)

- **Goal.** The SwiftUI app reaches full functional, behavioural and optimisation parity with the
  TypeScript backend, with an in-process Swift backend (ADR-270). Electron keeps the TypeScript
  backend and stays the product until the switch.
- **In-process library.** No HTTP and no new package dependencies. Only the SDK and system SQLite.
  Operations that are not ported yet keep going to Bun through `RoutingAPITransport`.
- **Parity is proven, not claimed.** Every ported area has a corpus recorded from TypeScript and
  replayed by Swift tests. It also has a `*-mutations` corpus with seeded random inputs.
- **Work sequentially.** Use one PR per area, or per sub-phase when an area is large. Start the next
  area as soon as the previous one is merged. Stop only for a real blocker that needs Tor.
- **Never cut functionality** unless Tor asks. Keep the TypeScript quirks, including error messages,
  key order where it matters, and 400/404/409 wording.
- **CI.** The `swift` job in `.github/workflows/ci.yml` (macOS) builds the app and runs
  `swift test`. It is the authority. Never add CI jobs or CI time.
- **Types (ADR-252).** Use per-entity ID types (`AccountID`, `TransactionID`,
  `PlannedTransactionID`, …) and typed rows. `scripts/native-lint` flags raw ids (`raw-id`) and raw
  currency strings (`raw-currency`). Suppress a flag only with a `// lint:allow <rule> <reason>`
  comment that gives a real reason.
- **Persistence contracts stay unchanged** (packaging/AGENTS.md). These are the SQLite format,
  canonical value forms, migration ledger and directory layout.
- **Docs.** When an area lands, add a paragraph to `docs/architecture/native-app.md`, keep the vault
  frontmatter, and bump the page `date`.
- **Commits.** Use lowercase conventional subjects. Check each message with
  `git log -1 --format=%B | bun scripts/commitlint.ts`.

## 2. Where things are

| What                                                  | Where                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swift backend library                                 | `apps/native/Sources/VisionBackend/`                                                                                                                          |
| Ported areas                                          | `apps/native/Sources/VisionBackend/Areas/*.swift`                                                                                                             |
| Ported operation ids + registration                   | `apps/native/Sources/VisionBackend/Routing/RoutingAPITransport.swift` (`PortedOperations.ids`, `InProcessBackend.live`)                                       |
| DB connection, clock, transactions                    | `Database/BackendDatabase.swift` (`BackendDatabase` actor, `BackendSession`)                                                                                  |
| SQL functions (byte-identical to `functions.ts`)      | `Persistence/*SQLFunctions.swift`                                                                                                                             |
| decimal.js port                                       | `Numeric/DecimalJS.swift`, `Numeric/DecimalJSMath.swift`                                                                                                      |
| zod engine, JS values, envelope                       | `HTTP/Zod.swift`, `HTTP/JSValue.swift`, `HTTP/BackendEnvelope.swift`, `HTTP/RequestInput.swift`                                                               |
| Parity recorder (TS side)                             | `scripts/native-parity.ts` (`AREAS`), mutations in `scripts/lib/nativeParityMutations.ts`                                                                     |
| Parity corpora                                        | `apps/native/parity/<area>.json`, `<area>-mutations.json`                                                                                                     |
| Parity replay (Swift side)                            | `apps/native/Tests/VisionBackendTests/ParityTests.swift`                                                                                                      |
| Pure-core ports with recorded vectors (#432, on main) | `VisionBackend/PortfolioImport`, `BankImport`, `Workbook`, `Analysis`, `Time`, `Tax`, `Forecast`, `Prices`, `Reports`; recorder `bun run native:parity-plans` |
| TS source of truth                                    | `apps/node-backend/src/{routes,services,repositories,lib}`                                                                                                    |

## 3. Method for one area

1. **Read the TS fully.** Read the route file, service, repository, row schemas
   (`database/rowSchemas.ts`) and any `lib` helpers. Note every validation message and the order
   checks run in, because the first thrown error wins.
2. **Check what the client calls.** `OpenAPIOperations.operationIds` in
   `VisionNativeCore/API/Generated/OpenAPIOperations.swift` lists them. Port only those operations.
   A route that is not in the client stays on Bun.
3. **List Bun caches over the area's tables** (ADR-270 decision 4). Each one must re-validate on
   `PRAGMA data_version`, or the Swift writes must not touch its tables.
4. **Write `Areas/<Area>.swift`.**
   - Add `static func register(_ backend: inout InProcessBackend, database: BackendDatabase)`. Then
     add its ids to `PortedOperations.ids` and call it in `InProcessBackend.live`.
   - Copy the SQL verbatim from the Kysely query. Use the same joins, the same `ORDER BY` and the
     same bound arguments. Ties are then broken the same way, because both sides run the same
     SQLite.
   - Use `session.transaction { }` wherever TS uses `withTransaction`.
5. **Add the parity area** in `scripts/native-parity.ts`:
   - The `seed` is SQL. Give every row an explicit `created_at`/`updated_at` of `SEED_TIME`, so the
     replay can tell a seeded timestamp from a written one.
   - The `steps` are requests with the client's `operationId`.
   - Add a `<area>-mutations` entry with a seeded `Random`.
   - Record with `bun run native:parity -- <area>` and `bun run native:parity -- <area>-mutations`.
6. **Add the tests** in `ParityTests.swift`: `@Test func <area>()` plus the mutations argument,
   following the existing pattern.
7. **Run the local checks.** These are `bun scripts/native-lint` (or the repo's `native-lint`
   script), prettier, and eslint on the script:
   `apps/node-backend/node_modules/.bin/eslint -c eslint.projects.config.mjs scripts/native-parity.ts`.
8. **Open the PR and finish it.**
   - Open a draft PR. Use the repo template sections: Summary, Type of change, Checklist,
     Architecture & data, Verification, Residual risk & follow-ups.
   - Wait for the macOS `swift` job to go green, then mark the PR ready and squash-merge it.
   - Append one dated line to `/mnt/project-files/swift-restart/plan.md` (if you have that folder).
   - Then start the next area.

Swift cannot be built in a Linux cloud container except as a pure-logic scratch package in Docker
(`swift:6.2-noble`; scripts in `/mnt/project-files/swift-restart/linux-scratch-build/`). Anything
touching SQLite3 or SwiftUI is verified only by macOS CI.

## 4. Parity harness facts that cost time before

- **Timestamps.** A timestamp that the run wrote is compared by form only, and it must not equal a
  seed timestamp. `{{today}}` in a corpus stands for the recorder's today (Europe/Brussels).
- **Query strings follow Node `querystring` rules.** A repeated key becomes an array, and the
  routes read it comma-joined (`InProcessRequest.query`, `TransactionsArea.raw`). The replay
  encodes paths the way `fetch` does (`ParityTests.fetchEncoded`).
- **Rate limiters** are off during recording (`VISION_DEV=true`) and are not ported.
- **User regex** (recipient patterns) runs in JavaScriptCore. Bun is JSC, so the results are
  exact. Tor confirmed this choice on 2026-11-13.
- **`assertYmd`.** A wrong shape answers "must be in YYYY-MM-DD format". A month outside 1–12 or a
  day outside 1–31 answers "is not a valid date". Feb 30 passes.
- **The TS list count cache (2 s)** is not ported. Swift counts exactly every time.
- **Debounced jobs** (transfer reconcile, materialized-view refresh: 5 s debounce, 10 s max wait)
  never fire during a corpus recording.
- **Seed traps.**
  - An auto-created parent category takes the next free id. Pick seed ids that leave room (the
    transactions seed uses id 10).
  - A NULL `updated_at` becomes `now()`.

## 5. Status (2026-11-24)

### Merged to main (Swift serves these operations)

| PR         | Area                                                                        |
| ---------- | --------------------------------------------------------------------------- |
| #427       | Persistence: SQL functions, ledger check, typed rows, routing transport     |
| #428       | Tags (`getTags`, `createTag`), envelope, `BackendDatabase`, parity recorder |
| #429       | Settings                                                                    |
| #431       | Exchange rates (Bun rate caches revalidate on `data_version`)               |
| #433       | Parity audit: mutation corpora, repeated-query fix                          |
| #434, #435 | Accounts (list, create, update, delete, statement balance)                  |
| #436       | Categories (tree, node CRUD and merge, legacy list) + Swift MV refresh      |
| #437       | Recipients (CRUD, merge/unmerge, match patterns, JSC regex)                 |
| #438       | Transaction reads (`getTransactions` with every filter, `getTransaction`)   |
| #432       | Pure cores with recorded vectors (not wired to routes)                      |

### On this branch, not on main

- **Commit 53b88d1** (WIP) has groundwork for the planned-payments area:
  - **Fixed replay clock.** `SQLConnectionClock(wall:)` and `BackendDatabase(path:time:wall:)`.
    `BackendSession.currentInstant()` replaces the static clocks.
  - **Nested `session.transaction`.** It now nests with savepoints, as `withTransaction` does in
    `connection.ts`.
  - **Route headers.** `HandlerResult.headers` lets a route set headers, for `Idempotent-Replay`.
- **The branch is behind main.** Main has #432 and many frontend PRs (#441–#455). Merge
  `origin/main` into the branch before continuing.
- **The WIP commit is not compiled yet.** CI has not run it.

## 6. Quality requirements (definition of done for every PR)

A PR is done only when every line below holds. Report each one exactly as it was run.
Never write "should pass".

**Behaviour**

1. Every operation in the PR answers like TypeScript. Check:
   - status, envelope, body shape and key names;
   - number forms (`toNumber(toDecimal(x))`) and null versus absent;
   - error code and message wording, and which of several errors wins (the first thrown in TS
     order);
   - pagination clamps and query-array handling;
   - timestamps written with `now()`.
2. Writes leave the database in the same state TS leaves it in. That covers rows, `updated_at`,
   junction tables, side tables, `ON CONFLICT` behaviour and transaction boundaries (the same
   rollback on a failure). Debounced follow-ups (MV refresh, transfer reconcile) are ported with
   the same timing.
3. No Bun cache goes stale. Every module-level cache in TS over the area's tables either
   re-validates on `PRAGMA data_version` (see the exchange-rate and `/api/info` caches) or moves to
   Swift with the area. List them in the PR body. To find them, run
   `grep -rn "new Map\|cache" apps/node-backend/src/services` and filter to the area's tables.
4. Nothing is cut or simplified. If TS has a quirk or a bug, Swift keeps it and the PR lists it
   under "Residual risk". Fixing it needs Tor's yes, and then lands in both backends.

**Proof**

5. The area corpus (`<area>.json`) has hand-written steps for:
   - every operation and every validation branch, including a bad id, a repeated key, an empty
     value, wrong types and out-of-range values;
   - every 404 and 409;
   - one happy path per write, with reads after each write that show the new state.
6. The mutations corpus (`<area>-mutations.json`) has at least 200 seeded random steps. They mix
   mutated bodies, random queries (`randomQuery` over all the route's keys) and writes aimed at
   random ids, with reads in between.
7. A today-dependent answer uses the fixed clock (section 8), never a corpus that only passes on
   the recording day.
8. The macOS `swift` CI job is green: build plus `swift test`, with both corpora replayed and 0
   differences. TS-side checks on the changed TS files are green: prettier, eslint (see method
   step 7), `bun run typecheck:scripts` and `native-lint`.

**Code**

9. Types follow ADR-252: entity ID types, typed rows, no raw `[String: Any]`. `// lint:allow`
   appears only with a reason.
10. SQL is copied from the compiled Kysely query, with the same joins, order and arguments. Shared
    SQL lives in one place (see `TransactionWhere.swift` and `AccountBalanceSQL.swift`).
11. Each type or function names its TS counterpart in its doc comment (`/// \`formatTransaction\``),
    so a reviewer can diff the two.
12. Nothing new in CI. No new package dependency. Persistence contracts are unchanged.

**Paperwork**

13. `docs/architecture/native-app.md` gets a paragraph on the area, and the page `date` is bumped.
14. The PR body follows the template. Verification lists the corpora with their step counts and
    the CI run. Residual risk lists the known differences and the parts not ported.
15. After the merge, add one dated line to `/mnt/project-files/swift-restart/plan.md`, or to
    section 5 of this page.

## 7. Everything left, in order

There are 197 generated client operations to go (231 in the client, 34 ported). There are also
the hand-written multipart and SSE operations, the background jobs and the final switch.

The order follows dependencies: an area moves only after the areas it calls. Each phase is one PR,
or a few PRs where marked. Tick the boxes as PRs merge.

### P10 Planned payments (7). Details in section 8.

- [ ] 10a `getPlannedTransactions`, `getPlannedTotals`, `getPlannedMatchSuggestions`,
      `executePlannedTransaction`, `deletePlannedTransaction`
- [ ] 10b `createPlannedTransaction`, `updatePlannedTransaction` (loan schedule)

### P11 Transaction writes and attachments

TS: `routes/transactions.ts`, `transactionService.ts`, `transactionRepository.ts`,
`deduplication.ts`, `plannedMatchService.autoLinkTransactions`, `accountLifecycleLock.ts`,
`plannedExecutionGuard.ts`, `routes/attachments.ts`, `attachmentService`.

- [ ] `createTransaction`. Covers the manual-v3 dedup hash and claims (`manualAmountIdentity`
      ROUND_HALF_UP to 4 dp), auto-link to planned payments (setting `autoClearPlannedOnMatch`), and
      the 409 with conflict details.
- [ ] `updateTransaction`. Covers the hand-written explicit-null PATCH, recipient and category name
      resolution, `sanitizeUpdateFields`, the account lock "Reopen the account before changing its
      ledger balance", and tags.
- [ ] `deleteTransaction`. Covers the planned guard 409 and best-effort attachment file unlink. Pass
      the attachments directory into `BackendDatabase` next to `resume(databasePath:)`; the app knows
      it as `layout.attachments`.
- [ ] The debounced transfer reconcile (`transferReconciliationService.scheduleReconcile`: 5 s
      debounce, 10 s max wait). It also invalidates statistics caches and schedules the MV refresh.
- [ ] `getTransactionAttachments`, `downloadAttachment` (binary), `deleteAttachment`, and the
      hand-written multipart `uploadAttachment`.

### P12 Transfers and bulk

- [ ] `markTransfer` (mark and unmark), and transfer suggestions if the client reads them
- [ ] `bulkUpdateTransactions`, `bulkDeleteTransactions`, `bulkTagTransactions`
      (`transactionBulkService.ts`)

### P13 Exports

- [ ] `exportTransactionsCsv`, `exportTransactionsJson`, and `bulkExportTransactions` (file
      answer plus `x-exported-count`). The byte-exact CSV quoting is compared in the corpus.

### P14 Account operations that wait on transactions

- [ ] `setAccountOpeningBalance`, `reconcileAccount`, `closeAccount`, `previewAccountMerge`,
      `mergeAccounts`. Merge repoints transactions, planned rows and recipients with
      `repointAccount`.

### P15 Splits (10)

- [ ] `getSplitsByTransaction`, `createSplitBatch`, `createBulkSplits`, `getSplitsOwed`,
      `getSplitOwedByRecipient`, `exportSplitsOwedCsv`, `paySplit`, `settleSplit`,
      `settleAllSplitsForRecipient`, `deleteSplit` (`routes/splits.ts`)

### P16 Bank imports

The pure cores for these are already on main (`BankImport`, `Workbook`, from #432).

- [ ] Parsers: `getCustomParsers`, `createCustomParser`, `updateCustomParser`,
      `deleteCustomParser` (`parserConfigRoutes.ts`)
- [ ] Batches: `getImportBatches`, `deleteImportBatch`, `previewImportBatch`, `overrideImportRow`,
      `overrideImportRowCategory`, `commitImportBatch` (`importBatchRoutes.ts`)
- [ ] Uploads (hand-written multipart and SSE in `Screens/Imports/ImportRequests.swift`):
      `importCsv`, `importCsvCustom`, `importCsvStream`, `importRecipients`, `importCategories`
      (`importRoutes.ts`, `services/importPipeline`)
- [ ] `getSupportedAdapters`, `getInfoBanks`, `getRecurringPatterns`

### P17 Portfolio core and prices

- [ ] Investments: `getInvestments`, `createInvestment`, `updateInvestment`, `deleteInvestment`,
      `getInvestment`, `getInvestmentSummary`
- [ ] Portfolio transactions: `getInvestmentTransactions`, `createInvestmentTransaction`,
      `updatePortfolioTransaction`, `deletePortfolioTransaction`, `getBulkPortfolioTransactions`,
      `bulkRetagPortfolioTransactions`
- [ ] Prices: `refreshInvestmentPrices`, `listInvestmentProviders`, `getInvestmentPriceHistory`
      (Yahoo client, price cache, provider registry, backfill; the pure `Prices` core is on main).
      Provider answers are stubbed with the corpus `fetch` map.
- [ ] Exposure: `getPortfolioExposure`, `upsertPortfolioExposureSources`,
      `getPortfolioExposureClassifications`, `savePortfolioExposureClassifications` (ADR-267: manual
      edits win over re-imports)

### P18 Portfolio imports (13 plus 2 uploads)

The reconciliation planner is on main (#432).

- [ ] Parsers: `getPortfolioParsers`, `createPortfolioParser`, `updatePortfolioParser`,
      `deletePortfolioParser`
- [ ] Batches: `getPortfolioImportBatches`, `getPortfolioImportBatch`,
      `deletePortfolioImportBatch`, `previewPortfolioImportBatch`,
      `portfolioImportRowInvestmentOverride`, `portfolioImportRowsInvestmentOverride`,
      `commitPortfolioImportBatch`
- [ ] Reconciliation: `previewPortfolioImportReconciliation`, `commitReviewedPortfolioImports`
- [ ] Uploads: `portfolioImportCsvCustom`, `portfolioImportCsvStream` (hand-written)

### P19 Portfolio-dependent figures

- [ ] `previewAccountPortfolioLots`, `getAccountTotals`, `getPortfolioSummary`,
      `getPortfolioPerformance`, `getPortfolioPerformanceByBroker`, `getNetWorth`,
      `getNetWorthByAccount` (`routes/info/*`, ADR-216/217 server-owned totals)

### P20 Aggregations (12) and the forecast

- [ ] `getMonthlySummary`, `getAverageVsCurrent`, `getBankBalances`, `getCategoryPivot`,
      `getRecipientPivot`, `getTagPivot`, `getRecipientInsights`, `getRecipientByYear`, `getSankey`
- [ ] `getCashflowForecastMethods`, `getCashflowForecastRolling`, `getCashflowForecastAccuracy`.
      These include the Monte Carlo job `jobs/refreshCashflowForecastMc.ts`. The pure `Forecast` core
      is on main. Seeded randomness must match TS exactly.

### P21 Info, insights and small areas

- [ ] `getTransactionCount`, `getInsightsDigest`, `getInsightsCount`, `dismissInsight`,
      `getDeductionCandidates`
- [ ] Saved charts: `getSavedCharts`, `createSavedChart`, `updateSavedChart`, `deleteSavedChart`
- [ ] Cross-workspace: `computeRebalance`, `computeCommitmentAwareCash`

### P22 Belgian tax

The pure `Tax` core is on main.

- [ ] `computeBelgianTax`, `getBelgianTaxOverview`, `getBelgianTaxDashboard`,
      `getBelgianPortfolioTaxDashboard` (`belgianTax*.ts`, `belgianPortfolioTax.ts`, inflation service)

### P23 Analysis (25)

The pure `Analysis` core (formulas, SQL rules) is on main.

- [ ] Run: `getAnalysisCatalog`, `executeAnalysis`, `cancelAnalysis`, `drillAnalysis`,
      `executeAnalysisPivot`, `evaluateAnalysisExtension`. The SQL sandbox must stay synchronized with
      `tools/analysis-sandbox.js` (packaging/AGENTS.md).
- [ ] Saved: `listSavedAnalyses`, `createSavedAnalysis`, `updateSavedAnalysis`,
      `deleteSavedAnalysis`, `runSavedAnalysis`, `listSavedAnalysisVersions`,
      `restoreSavedAnalysisVersion`
- [ ] AI proposals: `generateAnalysisProposal`, `previewAnalysisProposal`, `applyAnalysisProposal`
- [ ] Monitors: `listAnalysisMonitors`, `createAnalysisMonitor`, `patchAnalysisMonitor`,
      `deleteAnalysisMonitor`, `checkAnalysisMonitor`, `listAnalysisMonitorObservations`,
      `listAnalysisMonitorNotifications`, `readAnalysisMonitorNotification`, plus
      `startup/analysisMonitorScheduler.ts`

### P24 Research and markets

- [ ] Market: `marketQuote`, `marketNews`, `marketChart`, `marketSearch`
- [ ] Research: `researchSearch`, `researchChart`, `researchScorecard`, `researchAnalyst`,
      `researchNews`, `researchMacroSearch`, `researchMacroSeries`, `researchPortfolioForecast`
      (research cache)
- [ ] Mappings: `researchListMappings`, `researchResolveMappings`, `researchSaveMappings`,
      `researchDeleteMapping`, `researchAuditMappings`
- [ ] Provider keys: `researchListProviderKeys`, `researchSetProviderKey`,
      `researchClearProviderKey`. Never log or record real keys.
- [ ] Watchlist: `getWatchlist`, `addToWatchlist`, `updateWatchlistItem`, `deleteWatchlistItem`
- [ ] Dossiers: `listResearchDossiers`, `createResearchDossier`, `getResearchDossier`,
      `updateResearchDossier`, `deleteResearchDossier`, `listResearchDossierVersions`,
      `restoreResearchDossier`, `exportResearchDossiers`, `exportResearchDossier`

### P25 AI

The backend is Ollama (ADR-229). The Apple Foundation Models helper `vision-apple-ai` is already
Swift (ADR-246).

- [ ] Model: `getAiStatus`, `getAiModels`, `getAiModelFit`, `warmAiModel`, `releaseAiModel`
- [ ] Conversations: `getAiConversations`, `createAiConversation`, `getAiConversation`,
      `updateAiConversation`, `deleteAiConversation`, and the SSE `aiChatStream`
- [ ] Research AI: `listAiResearchDocuments`, `createAiResearchDocument` (multipart),
      `deleteAiResearchDocument`, `createAiInvestigation`, `getAiInvestigation`,
      `deleteAiInvestigation`, `resumeAiInvestigation`, `cancelAiInvestigation`

### P26 Admin

- [ ] `adminDatabaseStats`, `adminDatabaseVacuum`, `adminGetTableSchema`, `adminGetTableRows`,
      `adminMutateTableRows` (`dbEditor.ts`)
- [ ] `adminListEndpoints`, `adminMetricsRequests`, `adminProvidersHealth`, `adminProviderProbe`

### P27 Background work owned by Bun today

Port each item with the area that owns its tables, and tick it here. Each one must run exactly once
when both runtimes are alive.

- [ ] `startup/dailyJobs.ts` (daily checkpoint in settings)
- [ ] `startup/warmup.ts` (startup price refresh, import batch pruning, …)
- [ ] `startup/prepareViews.ts`
- [ ] Rate fetcher (`services/currency/rateFetcher.ts`)
- [ ] Price cache refresh (`services/prices/priceCache.ts`)
- [ ] Inflation (`services/belgianInflationService.ts`)
- [ ] Aggregation and MV refresh (`aggregationRefresh.ts`; MV refresh already in Swift)

### P28 Optimisations and type strength (ADR-270 phase 6e)

- [ ] Audit each ported area for every TS optimisation and record each one as ported or not needed
      (with a reason) in `native-app.md`. Examples: batched sub-collection loads, window counts,
      caches, debounces, single-statement upserts, prepared statement reuse.
- [ ] No untyped JSON left in handlers where a generated `Codable` type exists (ADR-270
      decision 7).

### P29 Switch (ADR-270 phase 6f and the last step of decision 6)

- [ ] Migrator in Swift (applies `db/migrations`, the same ledger and checksums).
- [ ] Backups and restore, the backup transport and `tools/db-file.js` behaviour (packaging/AGENTS.md).
- [ ] A new ADR that drops Bun from the Swift app's payload. Electron keeps the TS backend.
- [ ] Tor runs the Swift app on the Swift backend on his Mac and signs it off.

## 8. Phase P10 in detail: planned payments

This area comes before the transaction writes, because creating a transaction auto-clears a
matching planned payment through `executePlanned`.

**Client operations:** `getPlannedTransactions`, `createPlannedTransaction`,
`updatePlannedTransaction`, `deletePlannedTransaction`, `executePlannedTransaction`,
`getPlannedMatchSuggestions`, `getPlannedTotals`. The routes `GET /:id` and `/due-soon` are not in
the client.

Suggested split:

- **10a:** list, totals, match suggestions, execute, delete.
- **10b:** create and update, which carry the loan schedule.

**TS sources:**

- `routes/plannedTransactions.ts`
- `services/plannedTransactionService.ts`
- `repositories/plannedTransactionRepository.ts`
- `services/plannedExecutionService.ts`
- `services/plannedMatchService.ts`
- `lib/plannedMatching.ts`
- `services/plannedTotalsService.ts`
- `lib/calculations/recurrence.ts`
- `services/calculations/loanSchedule.ts`
- `services/currency/latestRateConversion.ts`

Notes from reading them:

- **Today-dependent output needs a fixed clock.** Totals, match suggestions and the execute
  default date all depend on today, so a corpus recorded one day fails the next.
  - Add an optional `now` (ISO instant) to `ParityArea` and the corpus.
  - The recorder calls `setSystemTime(new Date(now))` from `"bun:test"`. This works in a plain Bun
    script (checked). The TS SQL `now()`/`today()` follow it.
  - `ParityTests.replay` passes `wall: { fixed instant }` to `BackendDatabase` and computes
    `{{today}}` from it.
  - The Swift side of this is in 53b88d1.
- **List (`GET /`).** Checks throw in this order:
  1. `bank_account`, then `search` (each "must be a single value").
  2. `start_date`, `end_date` (`assertYmd`).
  3. `account_id`, `category_id`, `recipient_id` (`assertOptionalId`).

  Other rules:
  - `is_recurring`/`is_executed`: present means `parseBooleanQueryParam(value)` with default
    false, so `?is_recurring=` filters on false.
  - `active` defaults to `"true"`.
  - `search` is sliced to 200 UTF-16 units.
  - Pagination is `parsePagination` with max 5000.
  - The body is `{items, total, limit, offset, links: []}`. `total` is `COUNT(*) OVER()`, or a
    count query when the page is empty.
  - The SQL is `selectPlannedFields(filterPlannedTransactions(...))` ORDER BY
    `pt.planned_date DESC` LIMIT/OFFSET.
  - Executions, loan schedule and tags are attached with three batched queries (the repository's
    `getAll`).

- **`formatPlannedTransaction`** (end of the route file). It uses `|| null` on `recipient_name`,
  `category_name`, `url`, `loan_type` and the loan dates. Its money fields are
  `toNumber(toDecimal(text))`. `executed_transaction_id` comes from the newest execution
  (`execution_date DESC`). It ends with `links: []`.
- **Totals.**
  - Reads `getForCommitmentProjection("9999-12-31")` and the latest stored rates (Swift already has
    `AccountsArea.latestRatesToEur` and `convert`).
  - `expandOccurrences` is calendar stepping. Day steps use `addDays`. Month steps clamp and
    compound (Jan 31 → Feb 28 → Mar 28).
  - Expansion is capped at 500 occurrences, or at `max_occurrences - execution_count`.
  - Rounding is decimal.js half-even to 2 places.
  - The pattern grammar is daily, weekly, biweekly, monthly, quarterly, yearly, and
    `every N days` with N ≥ 1. Matching is case- and whitespace-insensitive.
- **Match suggestions.**
  - Candidates come from `listActiveUnexecuted` (non-loan rows only). Transactions come from
    `transactionRepository.listRecentUnlinked` since today − 45 days.
  - The tolerance check (`matchesTolerance`) requires the same recipient cluster and currency and
    the same sign. The amount must be within max(1, 5 %). The dates must be within ±5 days.
- **Execute.**
  - The body is `z.object` with a transform. The missing-id error is "Missing required field:
    executed_transaction_id", then `validateId`, then `validateDateString`.
  - `executePlanned` runs in one transaction:
    1. Read the state (duplicate check).
    2. Return 409 "Planned transaction is inactive or complete" when that applies.
    3. Return 404 "Transaction not found", or 409 when the transaction is inactive or the
       currency differs.
    4. Return 409 when `max_occurrences` is reached.
    5. Advance with `nextOccurrenceYmd`, or complete on max or end date.
    6. Insert the execution with ON CONFLICT DO NOTHING, inherit the tags into
       `transaction_tags`, and set `updated_at = now()`.
  - A duplicate replay answers 200 with the header `Idempotent-Replay: true`.
- **Delete.** Answers 204, or 404 "Planned transaction N not found".
- **Create and update (10b).**
  - Zod loose schemas with superRefine. Loan generation (`generateLoanRepaymentSchedule`) uses JS
    doubles plus `roundMoney`; `Math.pow` is `std::pow` for negative exponents.
  - `applyLoanPatchDefaults` and `resolveLoanScheduleDirective` decide the PATCH changes.
  - `sanitizeUpdateFields("planned_transactions")` is the column allow-list.
  - `stampAccountIdForUpdate` resolves the account.
  - Name resolvers: `resolveRecipientIdByName`, `resolveCategoryIdByName`.

## 9. Open questions left with Tor

- A TS bug in recipients: a SYSTEM recipient name answers 500. Should it be fixed in both backends?
  No answer yet. Swift currently matches TS.
- None of the phases above is optional. Ask Tor before skipping or merging any of them.
