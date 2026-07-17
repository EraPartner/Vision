# Code Simplification Audit — July 2026

**Audited at:** `main@1e494de` (2026-07-13). All line numbers below refer to this commit.
**Cross-checked against:** PR **#84** (`claude/review-todo-backlog-jrbvpo@413d40e`, the open integration branch) — see [PR #84 cross-check](#pr-84-cross-check). **Every finding below is still present on #84's tree**; none of them are fixed there.
**Scope:** All hand-written source — `apps/frontend/src`, `apps/node-backend/src`, `packages/*`, `scripts/`, root shell scripts, and compose files (~200k LOC total; codegen output and locales excluded).
**Method:** Three audit rounds, each of four parallel dimension sweeps. **Round 1** (SIMP-01…22): backend data layer, frontend components/hooks, frontend pages/lib, scripts & cross-app duplication (tests excluded). **Round 2** (SIMP-23…46): backend services not covered in round 1 (AI chat, price providers, importers), frontend infrastructure (vendored UI, dependencies, API/MSW plumbing), the test suites, and repo-wide dead weight (lockfiles, generated artifacts, CI config). **Round 3** (SIMP-47…58): dead declarative surface (i18n keys, API endpoints), electron/packaging code, alembic, e2e specs, the remaining frontend feature directories, and the remaining backend services/repositories (`infoRepo.*` family, snapshot builder, transfers, env config). Every finding was verified by reading the code at HEAD; the highest-impact claims (dead-code reachability, byte-identical duplicates, dependency availability) were independently re-verified with grep, and then re-verified a second time against PR #84's tree. Read-only — no code was changed.

---

## How to use this document (for follow-up agents)

Each finding has a stable ID (`SIMP-01` … `SIMP-84`; rounds 1–3 are SIMP-01…58, round 4 — audited post-remediation at `main@6be1ee6` — is SIMP-59…84). To continue this work:

1. **Pick a finding** from the [status ledger](#status-ledger) with status `OPEN`, lowest tier first (Tier 1 is zero-risk).
2. **Re-verify before changing anything.** Line numbers are pinned to `main@1e494de`. If PR #84 has merged (it rewrites 279 files, splits `portfolioTxRepo` into `.common`/`.reads`/`.writes`, and adds `apps/node-backend/src/lib/dateFormat.js`), re-locate the code by the grep patterns given in each finding, not by line number. Per-finding `#84 note` rows call out where the fix should differ on #84's tree.
3. **One finding (or one coherent group) per PR**, following the [suggested sequencing](#suggested-sequencing). Run the repo's standard gates (`bun run test`, `bun run lint`, `bun run typecheck`; visual e2e for SIMP-13).
4. **Update the ledger row** in this file in the same PR: set status to `FIXED (<PR #>)` — the repo's `TODO.md` uses the same resolving-commit convention.

## Status ledger

| ID | Finding | Files (primary) | Est. lines | Risk | In PR #84 too? | Status |
| --- | --- | --- | --- | --- | --- | --- |
| SIMP-01 | Dead script: locales-capitalizer + report | `scripts/locales-capitalizer.js`, `scripts/locales-capitalizer-report.json` | ~607 | None | Yes — unchanged | FIXED (#92) |
| SIMP-02 | Dead scripts: auto-translate-nl ×2 | `scripts/auto-translate-nl.js`, `scripts/auto-translate-nl-pass2.js` | ~242 | None | Yes — unchanged | FIXED (#92) |
| SIMP-03 | Orphaned page: RecipientInsightsPage | `apps/frontend/src/pages/RecipientInsightsPage.tsx` | ~302 | None | Yes — still orphaned | FIXED (#92) |
| SIMP-04 | DataTable is a frozen copy of VirtualDataTable | `apps/frontend/src/components/shared/DataTable.tsx` | 200–611 | Low | Yes — still 1 consumer | FIXED (#92) |
| SIMP-05 | dateUtils.ts reimplements date-fns | `apps/frontend/src/components/shared/dateUtils.ts` | 80–120 | Low | Yes — intact | DEFERRED |
| SIMP-06 | Inline formatCurrency bypasses shared hooks (8 files) | see finding | ~75 | Low | Yes — all 7 live sites intact | FIXED (#92) |
| SIMP-07 | fmtLargeNum ×3 | `ResearchComparePage`, `MarketLookupPage`, `ResearchFundamentalsTab` | ~14 | Low | Yes — untouched | FIXED (#92) |
| SIMP-08 | toYmd ×3 | `portfolioMath.js`, `plannedMatchService.js`, `dateUtils.ts` | ~15 | Low | Yes — but see #84 note | FIXED (#92) |
| SIMP-09 | prefersReducedMotion ×4 | `useCountUp`, `RollingNumber`, `ShaderAurora`, `ThemeContext` | ~15 | Low | Yes — all 4 intact | FIXED (#92) |
| SIMP-10 | CSV escaping mirrored frontend/backend | `frontend/src/lib/csv.ts`, `node-backend/src/lib/csv.js` | ~30 | Low | Yes — intact | FIXED (#92) |
| SIMP-11 | ASSET_CLASSES duplicated frontend/backend | `frontend/src/utils/assetClass.ts`, `node-backend/src/lib/assetClasses.js` | ~5 | Low | Yes — untouched | FIXED (#92) |
| SIMP-12 | Local formatDate shadows shared helper | `apps/frontend/src/pages/ImportReviewPage.tsx` | ~8 | Low | Yes — untouched | DEFERRED |
| SIMP-13 | visx chart frame duplicated ×3 | `charts/AreaChart.tsx`, `LineChart.tsx`, `ComposedChart.tsx` | 300–400 | Medium | Yes — intact | DEFERRED |
| SIMP-14 | Inheritance-table CRUD duplicated ×2 | `investmentRepository.js`, `portfolioTxRepo.common.js` | 150–180 | Medium | Yes — `buildUpdateSql` still ×2 | DEFERRED |
| SIMP-15 | SQL SET/INSERT clause builder ×10 repos | `apps/node-backend/src/repositories/*` | 60–80 | Low | Yes — 9 files, 30 sites | FIXED (#92) |
| SIMP-16 | plannedTransactionRepository SELECT ×5 + hydration ×2 | `plannedTransactionRepository.js` | ~65 | Low | Yes — **worse: SELECT ×6** | FIXED (#92) |
| SIMP-17 | Investment field list spelled out 4–5× | `investmentRepository.js`, `investmentController.js` | ~40 | Low | Yes — intact | FIXED (#92) |
| SIMP-18 | Belgian tax pages: repeated cards/reducers/fields | `TaxOverviewPage`, `PortfolioTaxPage`, `IncomeStep`, `ExemptionsStep` | ~180 | Low | Yes — intact | DEFERRED |
| SIMP-19 | Small backend extractions (reports, splits, formatters) | `reports/index.js`, `splitRepository.js`, `routes/transactions.js` | ~70 | Low | Yes — intact | FIXED (#92) |
| SIMP-20 | BelgianTaxProfileContext debounce ×3 + installers dup | `BelgianTaxProfileContext.tsx`, `install.sh`, `install-demo.sh` | ~80 | Low | Yes — intact | FIXED (#92) |
| SIMP-21 | FIFO/LIFO cost basis near-twins (money math) | `packages/shared-utils/src/portfolio.js` | ~90 | **High care** | Yes — untouched | FIXED (#92) |
| SIMP-22 | validate-locales hand-rolled JS lexer | `scripts/validate-locales.js` | ~80 | Medium | Yes — untouched | DEFERRED |
| SIMP-23 | 9 unused vendored shadcn components + orphaned deps | `apps/frontend/src/components/ui/*` | ~790 + 13 deps | None | Yes — still unimported | FIXED (#92) |
| SIMP-24 | Stale electron `package-lock.json` beside `bun.lock` | `packaging/electron/package-lock.json` | 170 KB | None | Yes — both tracked | FIXED (#92) |
| SIMP-25 | Generated electron i18n JSON checked in (byte-identical to source) | `packaging/electron/i18n/{en,nl}.json` | ~418 KB | None | Yes — present | FIXED (#92) |
| SIMP-26 | Dead exports in shared packages + dead re-export barrel | `packages/types`, `packages/shared-utils`, `frontend/src/utils/downsample.ts` | ~30 | None | Yes | FIXED (#92) |
| SIMP-27 | CI setup prelude copy-pasted across 9+ jobs | `.github/workflows/ci.yml` (+e2e/release) | ~100 YAML | Low | Yes — 9 sites | FIXED (#92) |
| SIMP-28 | Generated frontend locales not verified in CI (drift gap) | `apps/frontend/src/locales/{en,nl}.ts`, `ci.yml` | correctness | Low | Yes — same gap | FIXED (#92) |
| SIMP-29 | `archiver`/`yauzl` are root runtime deps, used only by one test | root `package.json` | 2 deps | Low | Yes | FIXED (#92) |
| SIMP-30 | Parser-config CRUD duplicated across both import routers | `routes/importRoutes.js:167-235`, `routes/portfolioImportRoutes.js:242-300` | ~70 | Low | Yes — 2×2 handlers | FIXED (#92) |
| SIMP-31 | MAD spike-detector duplicated between price sanitizers | `quoteBackfillService.js:132-171`, `prices/priceProviderRegistry.js:233-282` | ~45 | Low | Yes — `1.4826` in both | FIXED (#92) |
| SIMP-32 | Investment-spike sanitizer clones portfolioMath | `repositories/infoRepositoryHelpers.js:234-274` | ~35 | Low | Yes | DEFERRED |
| SIMP-33 | `fetchLivePricesDetailed` provider blocks ×4 | `services/priceProviderService.js:87-164` | ~40 | Low | Yes | FIXED (#92) |
| SIMP-34 | quoteBackfill SELECT + row-mapper cloned ×2 | `services/quoteBackfillService.js:186-329` | ~35 | Low | Yes | DEFERRED |
| SIMP-35 | AI-chat tools: repeated bucketing/shaping/envelope + arg-coercion dup | `services/aiChat/tools/*`, `aiChatService.js` | ~110–130 | Low | Yes | FIXED (#92) |
| SIMP-36 | `svgGroupedBarChart` is a special case of the generic chart | `services/reports/sectionHelpers.js:123-280` | ~40 | Low | Yes | FIXED (#92) |
| SIMP-37 | importRoutes: result block ×3, csv-options validation ×2 | `routes/importRoutes.js` | ~20 | Low | Yes | FIXED (#92) |
| SIMP-38 | Ollama error-normalization ×2 + no-logic pass-through wrappers | `integrations/ollama/client.js`, `priceProviderService.js:256-262` | ~12 | Low | Yes | FIXED (#92) |
| SIMP-39 | Route-test harness (`mockRouter` + `mockResponse`) copy-pasted in 22 files | `apps/node-backend/tests/routes/*` | ~470 | Low | Yes — grew to 23–24 files | FIXED (#92) |
| SIMP-40 | Shared test mocks: logger ×28, `clearAllMocks` ×73, repo mocks, `writeTempCSV` ×8 | `apps/node-backend/tests/**` | ~200 | Low | Yes | FIXED partial (#92) |
| SIMP-41 | `contracts.test.ts`: near-identical `it()` blocks → `it.each` tables | `apps/frontend/src/test/msw/contracts.test.ts` | ~150–200 | Low | Yes | FIXED (#92) |
| SIMP-42 | Hook-test QueryClient wrapper re-implemented ×7 | `apps/frontend/src/hooks/**/__tests__/*` | ~70 | Low | Yes | FIXED (#92) |
| SIMP-43 | MSW handler micro-helpers (`aggOk`, `deleted`) | `apps/frontend/src/test/msw/handlers.ts` | ~40–60 | Low | Yes | FIXED (#92) |
| SIMP-44 | App.tsx lazy/route lists hand-maintained; redundant react-query overrides | `apps/frontend/src/App.tsx`, hooks | ~50 | Medium | Yes | DEFERRED |
| SIMP-45 | `recharts` is a full dependency for exactly one component | `features/ai-chat/ToolResultCard.tsx` | 1 dep | Medium | Yes — still 1 file | KEEP (#92) |
| SIMP-46 | 1.1 MB checked-in pg_dump for demo DB | `packaging/electron/demo-db/01-demo.sql` | ~1.1 MB | Medium | Yes | KEEP (#92) |
| SIMP-47 | 507 dead i18n keys (14% of surface) + no unused-key validator pass | `i18n/source/*.json` + 4 generated locale files | ~3,042 data lines | Low | Yes — samples verified | FIXED (#92) |
| SIMP-48 | Exclusion-clause builder copy-pasted ~8× while tested canonical helper sits unused | `infoRepo.*`/`infoRepository*.js`, `services/filterBuilder.js` | ~110–130 | Low–medium | Yes — 0 prod call sites there too | PARTIAL — see Round 4 preamble |
| SIMP-49 | Period-pivot + recipient-rollup shaping duplicated across info repos | `infoRepositoryRecipients/Tags/Statistics.js` | ~65 | Low | Yes | FIXED (#92) |
| SIMP-50 | Small service dedups: asset-class dispatch ×4, `aggregateByDate` ×2, cumulative-avg ×2, transfer-leg UPDATE ×3 | `snapshotBuilder.js`, `infoRepo.forecast.js`, `transferReconciliationService.js` | ~50 | Low | Yes | FIXED partial (#92) |
| SIMP-51 | Backend hygiene: dead `IMPORT_PIPELINE_V2` env key, duplicate net-worth query, per-account await loop, double export | `config/env.js:108`, `infoRepositoryNetWorth.js`, `portfolioPerformanceSnapshotService.js` | ~20 + perf | Low | Yes — env key present | FIXED (#92) |
| SIMP-52 | Backup AES-256 crypto fully duplicated between electron main and bundle | `packaging/electron/main.js:669-975`, `backup/bundle.js:80-416` | ~150 | Medium | Yes — same KDF consts ×2 | DEFERRED |
| SIMP-53 | Electron backup/restore plumbing copy-pasted (restore-SQL ×2, pg_dump ×2, .env creds ×4) | `packaging/electron/main.js` | ~110 | Medium | Yes | DEFERRED |
| SIMP-54 | E2E page catalog redeclared 3-4×; critical-flows unrolls 13 identical tests | `apps/frontend/e2e/*.spec.ts` | ~105–125 | Low | Yes — grew to 15 tests | FIXED (#92) |
| SIMP-55 | Dead alembic autogenerate block imports a nonexistent Python backend | `alembic/env.py:31-51` | ~20 | None | Yes | FIXED (#92) |
| SIMP-56 | Portfolio transaction form fields triplicated across add/edit/from-market dialogs | `components/portfolio/{Add,Edit}PortfolioTxnDialog.tsx`, `AddInvestmentFromMarketDialog.tsx` | ~180–200 | Low | Yes | FIXED (#92) |
| SIMP-57 | EditInvestmentDialog reimplements InvestmentFormFields' provider block; `PRICE_PROVIDERS` ×3 | `components/portfolio/EditInvestmentDialog.tsx:175-297` | ~110 | Low | Yes — dup intact | FIXED (#92) |
| SIMP-58 | Small frontend dedups: CsvColumnMapper double-write, PerformanceBreakdown twins, ToolResultCard chart views, GeneralSection rows, ExportCard buttons | see finding | ~130 | Low | Yes | FIXED (#92) |
| SIMP-59 | R4: 4 frontend modules alive only via their own tests | `utils/sanitize.ts`, `hooks/useCountUp.ts`, `useFormState.ts`, `useDataTableColumns.ts` | ~244 + ~299 test | None | n/a | FIXED (#103) |
| SIMP-60 | R4: 24 dead `apiClient` members + 22 dead backing functions | `lib/api.ts`, `lib/api/*.ts` | ~115–145 | Low | n/a | FIXED (#103) |
| SIMP-61 | R4: dead frontend exports batch (motion variants, chartStyles, tag hooks, tax compat consts) | `lib/motion.ts`, `shared/chartStyles.ts`, `hooks/useTags.ts`, `lib/belgianTax/constants.ts` | ~150 | None–low | n/a | FIXED (#103) |
| SIMP-62 | R4: shared-utils dead module `downsample.js` chain + `index.d.ts` barrel drift | `packages/shared-utils/src/*` | ~95 + ~60 test | Low | n/a | FIXED (#103) |
| SIMP-63 | R4: dead backend functions `validatePagination`, `downgradeMigrations` | `middleware/validation.js`, `database/migrate.js` | ~34 + ~10 test | None | n/a | FIXED (#103) |
| SIMP-64 | R4: dead electron surface (`electronServices` API, `applyDockerImageUpdate`, legacy `runBackup`) | `packaging/electron/{main,preload}.js` | ~113 | Low | n/a | FIXED (#103) |
| SIMP-65 | R4: dead deps, orphaned overrides, dead config (`config.py`, `env.DEBUG`, `DB_*` injections) | root/frontend/electron `package.json`, `config/` | ~90 + 7 deps/overrides | None–low | n/a | OPEN |
| SIMP-66 | R4: toolchain version-drift hazards (typescript ^7 vs pinned 6.0.3; vite pinned below declared floor) | root + app `package.json` | correctness | Medium | n/a | OPEN |
| SIMP-67 | R4: 13 currency-formatter stragglers bypass shared hooks (incl. RebalancePage locale bug) | see finding | ~90–110 | Low | n/a | OPEN |
| SIMP-68 | R4: `buildSetClauses`/`buildInsert` — 7 unmigrated hand-rolled sites | 6 repositories + `recipientPatternService.js` | ~35 | Low | n/a | OPEN |
| SIMP-69 | R4: `shared-utils/category` stranded — 4 inline reimplementations live on | `RecipientsPage`, `DashboardPage`, `dataImportService.js` | ~30–35 (or delete ~120) | Low | n/a | OPEN |
| SIMP-70 | R4: Y-M-D formatter stragglers vs canonical `dateFormat.js` (3 TZ-sensitive copies + 7 epoch-ms sites + `todayYmd`) | see finding | ~28 | None | n/a | OPEN |
| SIMP-71 | R4: small helper-exists batch (`median` ×2, `assertCurrency` ×3, `triggerBlobDownload`, `AbortSignal.timeout`, `RegExp.escape`) | see finding | ~50 | None–low | n/a | OPEN |
| SIMP-72 | R4: `routes/settings.js` hand-rolls ~185 lines of validators; zod installed and in use one file over | `routes/settings.js` | ~90–110 net | Low–medium | n/a | OPEN |
| SIMP-73 | R4: frontend hand-rolled CSV parser vs `csv-parse` browser build | `hooks/useCsvPreview.ts` | ~90–100 | Low–medium | n/a | OPEN |
| SIMP-74 | R4: electron hand-rolled HTTP helpers vs `fetch` (latent redirect bug) + semver comparator | `packaging/electron/main.js` | ~60–125 | Low | n/a | OPEN |
| SIMP-75 | R4: `CryptoPage` is an unparameterized copy of the parameterized `StocksPage` | `pages/portfolio/CryptoPage.tsx` | ~200 (or ~35 minimal) | Medium | n/a | OPEN |
| SIMP-76 | R4: SIMP-56/57 stragglers — from-market dialog never adopted `PortfolioTxnFormFields`; EditInvestmentDialog init/reset dup | `AddInvestmentFromMarketDialog.tsx`, `EditInvestmentDialog.tsx` | ~125–145 | Medium | n/a | OPEN |
| SIMP-77 | R4: multi-select combobox trio + pivot-hook twins | `shared/*Combobox.tsx`, `hooks/use{Recipient,Tag}Pivot.ts` | ~170 | Low | n/a | OPEN |
| SIMP-78 | R4: config-driven micro-dedups (research quotes query ×4, RANGES ×4, symbol search ×3, segmented buttons ×6, CURRENCIES ×7, misc) | see finding | ~120–140 | Low | n/a | OPEN |
| SIMP-79 | R4: small JSX/logic collapses (admin cards, CommandPalette groups, dialogs, belgianTax, account form mapping, SelectSettingRow hoist) | see finding | ~150 | Low | n/a | OPEN |
| SIMP-80 | R4: backend service batch (SSE dup + drifted error detail, report KPI cards + escaping, plannedTxRepo update dup, rateFetcher binary search) | see finding | ~140–150 | Low | n/a | OPEN |
| SIMP-81 | R4: test-suite dedup round 2 (transactions preamble ×6, `withTransaction` ×17, logger ×23, contracts `it.each` completion, 10 re-inlined sites) | `apps/node-backend/tests/**`, `contracts.test.ts` | ~530–610 test | Low | n/a | OPEN |
| SIMP-82 | R4: e2e — `smoke.spec.ts` subsumed by a11y suite; duplicated create flows | `apps/frontend/e2e/*` | ~80–100 | Low | n/a | OPEN |
| SIMP-83 | R4: electron IPC handler boilerplate + `electron-builder-demo.json` re-declaration | `packaging/electron/main.js`, `electron-builder-demo.json` | ~55–75 | Medium | n/a | OPEN |
| SIMP-84 | R4: CI compose bring-up ×3 → composite action; no-op compose logging blocks | `.github/workflows/*`, `docker-compose.*.yml` | ~40–50 | Low | n/a | OPEN |

---

## Overall assessment

The codebase is healthier than a bloat audit usually finds. Routes use a central error handler (no repeated `try/catch + res.status(500)`), big switch chains have already been turned into lookup registries, money math is centralized in `@vision/shared-utils` with Decimal.js, react-query is used consistently (no hand-rolled fetch state machines), and the money/slugify/downsample/portfolio-math utilities are already properly shared between apps.

The dominant smell is **not** clever over-abstraction — it is **unfinished deduplication**: abstractions that exist but aren't used everywhere (shared currency-formatter hooks bypassed by inline `Intl.NumberFormat` copies; `date-fns` installed but re-implemented by hand), and large stateful scaffolding that was copy-pasted instead of extracted (three visx charts each carrying the same ~150-line scale/hover/tooltip machine; `DataTable` being a frozen copy of `VirtualDataTable`'s state machine; two repositories carrying byte-identical inheritance-table helpers). On top of that sits ~1,150 lines of provably dead code that can simply be deleted.

**Realistically removable across all three rounds: ~5,600–6,500 code lines** with no behavior change (~2,300–2,900 round 1 + ~2,300–2,500 round 2 + ~950–1,100 round 3), **plus ~3,000 locale-data lines** (507 dead i18n keys × 6 files), **~1.7 MB of checked-in artifacts**, and **~15 removable npm dependencies**. Of the code total, ~1,950 are zero-risk deletions (dead code + unused vendored components).

| Tier | Theme | Findings | Est. lines removed | Risk |
| --- | --- | --- | --- | --- |
| 1 | Delete dead code | SIMP-01…03 | ~1,150 | None (verified unreferenced) |
| 2 | Use what already exists (date-fns, shared hooks, shared-utils) | SIMP-04…12 | ~450–700 | Low |
| 3 | Extract shared scaffolding (charts, repos, tax pages) | SIMP-13…20 | ~700–900 | Low–medium |
| 4 | Careful refactors (money math, load-bearing tooling) | SIMP-21…22 | ~170 | Medium — do under existing tests |
| R2-dead | Round 2: unused vendored UI, stale artifacts, dead exports, misplaced deps | SIMP-23…26, 29 | ~820 + ~590 KB + 15 deps | None–low |
| R2-backend | Round 2: service-layer dedup (importers, prices, AI chat, reports) | SIMP-30…38 | ~400 | Low |
| R2-tests | Round 2: test-scaffolding dedup and table-driven tests | SIMP-39…43 | ~900 | Low (coverage-neutral) |
| R2-infra | Round 2: CI prelude, locales drift guard, App.tsx, judgment calls | SIMP-27, 28, 44…46 | ~150 + ~1.1 MB | Low–medium |
| R3-i18n | Round 3: dead translation keys + unused-key validator pass | SIMP-47 | ~3,042 data lines | Low |
| R3-backend | Round 3: finish the filterBuilder migration, info-repo shaping, hygiene | SIMP-48…51 | ~250 | Low–medium |
| R3-electron | Round 3: backup crypto/plumbing dedup, e2e page table, alembic dead block | SIMP-52…55 | ~390 | Low–medium |
| R3-frontend | Round 3: portfolio dialog extractions + small dedups | SIMP-56…58 | ~420–440 | Low |

---

## Tier 1 — Delete: verified dead code (~1,150 lines, zero risk)

### SIMP-01 — `scripts/locales-capitalizer.js` + committed report — ~607 lines

`scripts/locales-capitalizer.js` (213 lines) hand-rolls a line-by-line quote/escape string parser (`parseAndTransform`, lines 103–180) to title-case locale values, writes `*.capitalized.tmp` files that are never applied, and dumps `scripts/locales-capitalizer-report.json` (394 lines) which is checked into the repo. Referenced by **no** `package.json` script, workflow, git hook, or `docs/reference/scripts.md` — only by `TODO.md`, which itself flags it as dead (line ~3993).

**Fix:** delete both files. *Re-verify:* `grep -rn "locales-capitalizer" --exclude-dir=node_modules .` returns only TODO.md and the files themselves.

### SIMP-02 — `scripts/auto-translate-nl.js` + `auto-translate-nl-pass2.js` — ~242 lines

Two one-shot migration scripts (174 + 68 lines) holding hardcoded `{key: "Dutch string"}` maps that were written into `i18n/source/nl.json` once. They duplicate each other — both hardcode the same `tax.suggestions.*` keys with *different* Dutch values (pass2 silently overrides pass1). Unreferenced anywhere; superseded by the live `sync-nl` workflow (`scripts/sync-nl-with-en.js`, which is fine and stays).

**Fix:** delete both files. *Re-verify:* `grep -rn "auto-translate-nl" --exclude-dir=node_modules .`

### SIMP-03 — `apps/frontend/src/pages/RecipientInsightsPage.tsx` — orphaned page, ~302 lines (+ its test)

Not referenced in `App.tsx`, `lib/routePreload.ts`, or any component — the only importers are its own integration test and a `LanguageSwitch` test. Its functionality is superseded by `components/statistics/RecipientInsightsTab.tsx`, which is what `StatisticsPage` actually renders. It even carries its own re-implemented `formatCurrency` (lines 35–40).

**Fix:** delete the page and `pages/__tests__/RecipientInsightsPage.integration.test.tsx`; update the `LanguageSwitch` test to target a live page. *Re-verify:* `grep -rln "RecipientInsightsPage" apps/frontend/src | grep -v __tests__` returns only the page itself. (Re-confirmed orphaned on #84's tree too.)

---

## Tier 2 — Use what already exists (~450–700 lines, low risk)

### SIMP-04 — `DataTable.tsx` is a frozen copy of `VirtualDataTable.tsx`'s state machine — ~200–611 lines

`components/shared/DataTable.tsx` (611 lines) and `VirtualDataTable.tsx` (843 lines) contain byte-identical helpers and logic: `getSortValue`, `IndexedRow`, the asc→desc→null `handleSort` cycle, `setColumnFilter`/`activeFilterCount`, the lazy `openFilterUniqueValues` scan, the filter+search+sort `processedRows` pipeline, `startEditing`/`cancelEditing`/`saveEditing`, and the `SortIcon` sub-component (DataTable 178–304 vs VirtualDataTable 289–489). `VirtualDataTable` is a strict superset (adds virtualization, context menus, keyboard nav). `DataTable` has exactly **one** consumer: `pages/DashboardPage.tsx` (line 9 on main, line 10 on #84 — both trees touch these files but the duplication is fully intact on both).

**Fix (preferred):** migrate `DashboardPage` to `VirtualDataTable` and delete `DataTable.tsx` (−611 lines). **Fallback:** extract a shared `useDataTableState()` hook (−~200 lines). *Re-verify:* `grep -rn "shared/DataTable" apps/frontend/src | grep -v Virtual`.

### SIMP-05 — `components/shared/dateUtils.ts` reimplements date-fns — ~80–120 lines

`date-fns@^4.3.0` is already a frontend dependency, yet `dateUtils.ts` (193 lines) hand-rolls `formatDate` as a 14-case pattern switch (lines 5–40), plus `parseISO` (42–50), `differenceInDays` (52–56), and `formatDistanceToNow` (58–69) — all direct date-fns exports. Ironically, `appDateFormatToDateFnsPattern` (86–95) already converts app formats to date-fns pattern strings, then feeds them to the custom formatter instead of date-fns `format()`. The layered `formatMonthYearWithAppSettings` / `formatDateStringWithAppSettings` switches (101–153) collapse similarly once the base is swapped.

**Fix:** delete the custom implementations and call date-fns directly. (The file's comment cites Intl construction cost, but date-fns `format` doesn't use Intl for these patterns.) *Re-verify:* the hand-rolled `formatDate`/`pad2` still heads the file (true on both main and #84).

### SIMP-06 — Inline `formatCurrency` copies bypass the existing shared hooks — ~75 lines across 8 files

`hooks/useCurrencyFormatter.ts` and `hooks/useChartCurrencyFormatter.ts` already provide cached `Intl.NumberFormat` formatting, and pages like `StocksPage`, `CryptoPage`, `SavingsPage`, `PortfolioOverviewPage`, and `AccountsPage` use them correctly. But eight files re-declare a local `formatCurrency`/`fmt` with `new Intl.NumberFormat(locale, {style:'currency', …})`:

- `components/statistics/RecipientInsightsTab.tsx:56` (even re-implements the hook's per-formatter caching)
- `components/statistics/CustomChart.tsx:78`
- `components/statistics/CustomChartBuilderModal.tsx:89`
- `pages/TaxOverviewPage.tsx:89–96`
- `pages/portfolio/tax/PortfolioTaxPage.tsx:107–114`
- `pages/portfolio/RealEstatePage.tsx:31–41` (plus a local `fmtNum`)
- `pages/portfolio/net-worth/NetWorthPage.tsx:95–102`
- `pages/RecipientInsightsPage.tsx:35` (dies with SIMP-03)

All seven live sites re-confirmed present on #84's tree (`grep -c "new Intl.NumberFormat"` per file).

**Fix:** `const { formatCurrency } = useChartCurrencyFormatter()` / `useCurrencyFormatter(targetCurrency)` in each. Also removes drift risk when number-format settings change.

### SIMP-07 — `fmtLargeNum` triplicated — ~14 lines

Byte-identical `1e12/1e9/1e6 → T/B/M` formatter in `pages/research/ResearchComparePage.tsx:181–188`, `pages/research/MarketLookupPage.tsx:144–150`, and `components/research/ResearchFundamentalsTab.tsx:77–84`. **Fix:** one `formatCompactNumber` in `utils/`.

### SIMP-08 — `toYmd` implemented three times — ~15 lines

Same pg-`Date`→`YYYY-MM-DD` helper in `node-backend/src/utils/portfolioMath.js:97–105`, `node-backend/src/services/plannedMatchService.js:33–43` (private copy), and `frontend/src/components/shared/dateUtils.ts:79`. **Fix:** export once and import.
**#84 note:** PR #84 adds a central `apps/node-backend/src/lib/dateFormat.js` (`formatDateToYmd` + a Date-coercing wrapper) but the two private backend `toYmd` copies **still remain** there. On #84's tree the fix is: route both through `lib/dateFormat.js` instead of creating a new helper.

### SIMP-09 — `prefersReducedMotion()` duplicated ×4 — ~15 lines

Identical inline `matchMedia("(prefers-reduced-motion)")` check in `hooks/useCountUp.ts:29`, `components/shared/RollingNumber.tsx:6`, `components/layout/ShaderAurora.tsx`, and `contexts/ThemeContext.tsx` (all four re-confirmed on #84). **Fix:** one util, or framer-motion's `useReducedMotion` (already used in charts) where hook context allows.

### SIMP-10 — CSV escaping mirrored frontend/backend — ~30 lines

`frontend/src/lib/csv.ts` (40 lines) and `node-backend/src/lib/csv.js` (38 lines) both define `neutralizeCsvFormula`/`quoteIfNeeded`/`escapeCsvValue` with the same `DANGEROUS_CSV_FORMULA_PREFIXES`; the frontend header comment admits it mirrors the backend. **Fix:** move to `packages/shared-utils/src/csv.js` with an options flag, re-export both sides like `money`/`slugify` already do.

### SIMP-11 — `ASSET_CLASSES` duplicated frontend/backend — ~5 lines

`frontend/src/utils/assetClass.ts:5` and `node-backend/src/lib/assetClasses.js:6` hardcode the identical ordered array, which must stay in lockstep with `TRANSACTION_TABLE_BY_ASSET_CLASS`. **Fix:** single const in shared-utils. Small line count, but it removes a silent-drift hazard.

### SIMP-12 — local `formatDate` shadows the shared helper — ~8 lines

`pages/ImportReviewPage.tsx:81` defines a private `formatDate(raw)` while `components/shared/dateUtils.ts` already exports one. **Fix:** import the shared helper (after SIMP-05, that's date-fns underneath).

---

## Tier 3 — Extract shared scaffolding (~700–900 lines, low–medium risk)

### SIMP-13 — Three visx charts each hand-roll the same chart frame — ~300–400 lines

`components/charts/AreaChart.tsx` (566), `LineChart.tsx` (483), and `ComposedChart.tsx` (353) each duplicate the full block: `xScale`/`yScale` `useMemo` (domain padding + `nice`), `bisector` setup, hover-index state, `indexAtClientX`/move/leave/down/up handlers, the cross-chart `syncedIndex` nearest-point loop, the `tooltipItems` builder, grid-line map, axis block, scrub-range band, hover-capture `<rect>`, and scrub-delta pill. AreaChart ~125–283 and LineChart ~100–234 are near-verbatim copies (only variable-name drift: `hoverIndex` vs `hoverIdx`); ComposedChart ~92–171 repeats the scale/hover/tooltip subset. (Re-confirmed on #84: `bisector`/`indexAtClientX` still per-file; no shared frame exists there either.)

**Fix:** one `useCartesianChartFrame(props)` hook returning `{xScale, yScale, hoverDatum, handlers, tooltipItems}` plus a `<ChartFrame>` wrapper for grid/axes/capture-rect/scrub/tooltip; each chart keeps only its series rendering. Land only with the visual-regression e2e suite green.

### SIMP-14 — Inheritance-table CRUD duplicated across two repositories — ~150–180 lines

`node-backend/src/repositories/investmentRepository.js` (~37–335) and `portfolioTxRepo.common.js` (~37–466) independently implement the same helper set for the Postgres inheritance/view schema: `isNonUpdatable…ViewError`, `isMissingInheritanceRelationError`, `isDuplicate…IdError`, `resync…BaseIdSequence`, `buildUpdateSql`, and `create/update/hardDeleteThroughInheritanceTables`. `buildUpdateSql` is **byte-for-byte identical** in both files (investmentRepository 144–163 vs portfolioTxRepo.common 316–335; re-confirmed still ×2 on #84). The three `…ThroughInheritanceTables` functions differ only in table-name constants and the child-field map.

**Fix:** a `makeInheritanceRepo({ baseTable, tableByAssetClass, baseFields, childFieldsByClass })` factory module — or at minimum share `buildUpdateSql`, the error classifiers, and the sequence-resync helper.
**#84 note:** #84 splits the portfolio-tx repo into `portfolioTxRepo.common/.reads/.writes` and adds tests — line numbers differ there; locate by `grep -n "function buildUpdateSql"`.

### SIMP-15 — Dynamic SET/INSERT clause builder reinvented in ~10 repositories — ~60–80 lines

The `for (const [key, value] of Object.entries(fields)) { … setClauses.push(…$${i++}); params.push(value); }` idiom appears at 23 push-sites across 10 files on main: `plannedTransactionRepository.js` (405, 515, 667), `investmentRepository.js` (149, 553), `portfolioTxRepo.common.js` (321), `accountRepository.js` (74, 94 — near-identical INSERT and UPDATE variants back-to-back), `transactionRepository.js` (479), `watchlistRepository.js` (85), plus the category/recipient/tag repos. On #84 it's **30 sites across 9 files** — the accounts rewrite added more.

**Fix:** shared `buildSetClauses(fields, { allowed, startIdx })` / `buildInsert(fields, { allowed })` in `node-backend/src/lib/`. *Locate by:* `grep -rn "setClauses.push" apps/node-backend/src/repositories`.

### SIMP-16 — `plannedTransactionRepository.js` — one SELECT spelled out five times — ~65 lines

The identical `SELECT pt.*, r.name AS recipient_name, CASE … END AS category_name FROM planned_transactions pt LEFT JOIN …` block appears in `getAll` (117–134), `getById` (256–269), `update` (436–454), `getDueSoon` (561–578), and `getForForecast` (592–610). Separately, the executions + loan_schedule + tags hydration is duplicated verbatim between `getById` (274–303) and `update` (460–489), ~30 lines each.

**Fix:** a `PLANNED_SELECT` const and a `hydratePlannedRow(row)` helper.
**#84 note:** on #84's tree the SELECT appears **six** times (`grep -c "AS recipient_name"`) — the duplication grew. Fixing this on/after #84 collapses one more copy than on main.

### SIMP-17 — `investmentRepository.create()` — same 21-field list spelled out 4–5× — ~40 lines

`create` (417–519) and `createThroughInheritanceTables` (193–324) re-list the same ~21 provider/price fields as `modernValues`, `legacyValues`, `baseValues`, and `legacyBaseValues`; `investmentController.createInvestment` (204–251) destructures the identical set a fifth time just to re-assemble the same object. (Re-confirmed on #84: 9 `*Values` list sites in the repo file.)

**Fix:** an `INVESTMENT_FIELDS` constant array driving column list + placeholder generation; pass a picked subset of `req.body` through.

### SIMP-18 — Belgian tax pages — repeated cards, reducers, and form fields — ~180 lines

- **`ProfileInputsCard` duplicated:** `TaxOverviewPage.tsx` 600–670 and `PortfolioTaxPage.tsx` 498–533 render the same label/value rows over the same `profile`/`calculation` shape; six rows are byte-identical. → one `<TaxProfileInputsCard>` driven by a `{labelKey, value}[]` array (~50 lines).
- **`PortfolioTaxPage.tsx` 626–699:** four dividend metric tiles + four `rounded-lg border p-3` estimate cards (TOB recorded/auto, TACR, CGT, Reynders) differ only in `{title, badge, description, value, visibleWhen}` → config array + `.map` (~35 lines).
- **`PortfolioTaxPage.tsx` 144–199:** `taxBreakdown` and `feeBreakdown` are the same ~28-line reducer twice, differing only in the field read (`taxes` vs `fees`) and category labels → one parameterized `bucketTxnCosts(field, categoryMap)` (~25 lines).
- **`TaxOverviewPage.tsx`:** identical income-sources empty state at 558–577 and 685–704 (`ListChecks` icon + CTA) → one component (~20 lines).
- **`components/tax/profile-steps/IncomeStep.tsx`:** the label + description + number-`Input` block repeats ~6×, and the Flanders/Wallonia/Brussels `<Select>` is inlined twice (157–168, 234–248) and again in `RegionStep`/`EmploymentStep` → a `NumberField` component driven by a config array + a shared `<RegionSelect>` (~50–70 lines). `ExemptionsStep.tsx`'s three `[0..5].map` dependent-count selects collapse the same way (~30 lines).

(#84 touches `TaxOverviewPage.tsx` but the duplicated empty state and inputs card are intact; `PortfolioTaxPage`/`IncomeStep`/`ExemptionsStep` are untouched there.)

### SIMP-19 — Smaller backend extractions — ~70 lines

- **`services/reports/index.js`:** `buildFinancialBody` (478–495), `buildPortfolioBody` (501–518), `buildTaxBody` (524–541) are the same ~18-line function with different renderer maps/defaults/fetchers; the "no sections selected" placeholder HTML is triplicated → one `buildBody({...})` (~30 lines). (Still 3 builders on #84.)
- **`repositories/splitRepository.js`:** `createSplitAtomic` (80–113) and `createSplitsBatchAtomic` (120–164) open with the identical `FOR UPDATE` lock + totals query, which also appears a third time in `getTransactionSplitTotals` (46–53) → `lockAndGetTotals(client, transactionId)` (~18 lines).
- **Row formatters:** `routes/transactions.js` `formatTransaction` (653–678) and `splitRepository.js` `formatSplit` (490–503) are long field-by-field copies whose only work is `toNumber(toDecimal(x))` — an idiom appearing **55 times across 15 files**. `lib/money.js` already exports `coerceNumericFields` (used by exactly one caller) → route the formatters through it (~20 lines).

### SIMP-20 — Debounced-persist triplication + installer duplication — ~80 lines

- **`contexts/BelgianTaxProfileContext.tsx` 229–321:** three ~16-line debounced-persist `useEffect` blocks (profile/snapshots/metas) with three `isFirst*Render` refs and three `*SaveTimerRef` timer refs, identical except key + state var → `useDebouncedSetting(key, value, isLoading)` (~40 lines). (Pattern intact on #84.)
- **`install.sh` / `install-demo.sh`:** the Docker-daemon wait loop (`install.sh` 93–108 vs `install-demo.sh` 18–22), the "find built `.app`" candidate scan (127–140 vs 53–57), and the remove/`cp -r`/`xattr -cr` install block (143–150 vs 59–65) are each duplicated → a sourced `scripts/lib/mac-install.sh` (~40 lines, mainly a drift-risk fix).

---

## Tier 4 — Do carefully (money math & load-bearing tooling, ~170 lines)

### SIMP-21 — `packages/shared-utils/src/portfolio.js` — FIFO and LIFO calculators are near-twins — ~90 lines

`calculateCostBasisFIFO` (191–283) and `calculateCostBasisLIFO` (293–385) are ~95 lines each and differ **only** in which lot is consumed (`lots[0]` + `lots.slice(1)` vs `lots[lots.length-1]` + `lots.slice(0, -1)`). The per-txn field-parse block and the 12-field result object are repeated a third time in `calculateCostBasis`.

**Fix:** one `calculateCostBasisLotBased(txns, opts, { fromEnd })` with the lot pointer parameterized, plus a shared result builder. **This is golden-fixture-covered money math — refactor only under the existing fixtures, in its own PR.**

### SIMP-22 — `scripts/validate-locales.js` — hand-rolled JS lexer — ~80 lines

Lines 204–311 implement a from-scratch tokenizer (`blankComments`, `readStringLiteral`, `readArgs`, `objectKeys`, `walkSources`) purely to find `t()`/`tc()` call sites in `.ts/.tsx` source. The workspace already depends on `typescript`.

**Fix:** a ~20-line `ts.createSourceFile` + `CallExpression` visitor. This is load-bearing CI tooling that currently works — the win is robustness (real string/template/JSX handling) more than line count; do it with a before/after diff of extracted keys.

---

## Round 2 — dead weight & artifacts (SIMP-23…29)

### SIMP-23 — Nine vendored shadcn components never imported — ~790 lines + 13 dependencies

Verified with grep (zero importers outside `components/ui/` on both main and #84): `aspect-ratio.tsx` (5), `avatar.tsx` (44), `breadcrumb.tsx` (99), `form.tsx` (132), `hover-card.tsx` (27), `input-otp.tsx` (61), `menubar.tsx` (196), `navigation-menu.tsx` (122), `pagination.tsx` (104) — all in `apps/frontend/src/components/ui/`.

Deleting them also orphans their backing npm packages, plus five deps that never even got a component vendored: `@radix-ui/react-aspect-ratio`, `@radix-ui/react-avatar`, `@radix-ui/react-hover-card`, `@radix-ui/react-menubar`, `@radix-ui/react-navigation-menu`, `input-otp`, `react-hook-form`, `@hookform/resolvers`, and (already zero imports today) `embla-carousel-react`, `vaul`, `react-resizable-panels`, `d3-time`, `next-themes`. Each verified at zero imports across `apps/frontend/src` (the lone `react-hook-form`/`input-otp` matches are inside the dead `ui/` files themselves).

**Fix:** delete the nine files, remove the 13 packages from `apps/frontend/package.json`. *Re-verify:* `grep -rn "ui/<name>\"" apps/frontend/src | grep -v components/ui` per component.

### SIMP-24 — Stale `packaging/electron/package-lock.json` — 170 KB

`packaging/electron/package.json` declares `"packageManager": "bun"` and `bun.lock` (73 KB) is tracked beside it; all electron scripts run via bun, nothing references npm here. **Fix:** `git rm packaging/electron/package-lock.json`.

### SIMP-25 — Generated electron i18n JSON checked in — ~418 KB, maintained-twice hazard

`packaging/electron/i18n/{en,nl}.json` are **byte-identical** (md5-verified) to `i18n/source/{en,nl}.json` and are listed as generated outputs in `scripts/generate-locales.js` (header, lines 6–9), rewritten on `electron start`/`dist`. Nothing gitignores them, so the copies are committed and can silently drift. **Fix:** gitignore `packaging/electron/i18n/*.json` (the electron scripts already run the generator), or read `i18n/source` directly.

### SIMP-26 — Dead exports in shared packages + dead barrel — ~30 lines

- `packages/types`: `isApiErrorCode` has zero external references.
- `packages/shared-utils/portfolio`: exported `UNIT_BASED_CLASSES`, `FIXED_INCOME_CLASSES`, `REAL_ESTATE_CLASS`, `daysBetweenYmd` are used only internally — make them private.
- `apps/frontend/src/utils/downsample.ts` is a re-export barrel with **zero importers** (verified) — delete.

### SIMP-27 — CI setup prelude copy-pasted across 9+ jobs — ~100 YAML lines

`bun install --frozen-lockfile` appears 9× in `.github/workflows/ci.yml` (plus e2e/release), each preceded by the same pinned `actions/checkout` + toolchain setup (~10 lines/job). No `.github/actions/` composite exists. **Fix:** one composite action (`.github/actions/setup`); each job becomes `- uses: ./.github/actions/setup`.

### SIMP-28 — Generated frontend locales are not drift-checked in CI

`apps/frontend/src/locales/{en,nl}.ts` are generator output (`// Auto-generated - do not edit manually`), but the root build runs `generate-locales-if-not-ci`, which **skips generation when `$CI` is set** — CI consumes the committed files with no freshness check, unlike `generated.ts` which has the `verify-generated` job. **Fix:** add a `verify-locales` job (run the generator, `git diff --exit-code`), mirroring `verify-generated`. Few lines, real correctness gap.

### SIMP-29 — `archiver`/`yauzl` are root runtime dependencies used only by one test

The only importers are `packaging/electron/backup/bundle.js` (which has its own copies in the electron `package.json`) and `apps/node-backend/tests/backup-roundtrip.test.js` — no backend `src/` file uses either. **Fix:** move both from root `dependencies` to `apps/node-backend` `devDependencies`.

---

## Round 2 — backend service dedup (SIMP-30…38)

### SIMP-30 — Parser-config CRUD duplicated across both import routers — ~70 lines

`routes/importRoutes.js:167–235` and `routes/portfolioImportRoutes.js:242–300`: the four `/parsers` handlers (GET/POST/PATCH/DELETE) are identical except a `PARSER_KIND` constant, the `normalize*ParserConfig` fn, and the word "portfolio" in the conflict message (same 23505/`PARSER_NAME_CONSTRAINT` handling, same `parseParserId`/`normalizeParserName`). `lib/parserConfigRoutes.js` already exists as the shared home. **Fix:** `registerParserRoutes(router, { kind, normalizeConfig, label })`.

### SIMP-31 — MAD spike-detector duplicated between the two price sanitizers — ~45 lines

`services/quoteBackfillService.js:132–171` and `services/prices/priceProviderRegistry.js:233–282` contain the same log-returns → `median` → MAD → `robustSigma = max(1.4826*mad, .0015)` → needle-detection loop verbatim (both already import `median` from `lib/math.js`; the `1.4826` constant appears in exactly these two files). **Fix:** one `detectMadNeedles(points, opts)` in `lib/math.js`.

### SIMP-32 — `sanitizeIsolatedDailyInvestmentSpikes` clones `sanitizeIsolatedValueSpikes` — ~35 lines

`repositories/infoRepositoryHelpers.js:234–274` reimplements `utils/portfolioMath.js:48–86` (same `minJump`/`neighborTolerance`/`localNeedleRatio`, same needle/peak/trough conditions), differing only in the fixed `investments` field and recomputing `netWorth`. `portfolioMath.sanitizeSnapshotSpikes:300` already shows the wrapper pattern. **Fix:** thin wrapper over `sanitizeIsolatedValueSpikes(rows, 'investments', {...})` + a `netWorth` post-pass.

### SIMP-33 — `fetchLivePricesDetailed` provider blocks are a copy-paste quartet — ~40 lines

`services/priceProviderService.js:87–164`: four `if (stale.X.length) { providerTasks.push(async () => { try {…map+cacheSet…; recordProviderSuccess} catch {…recordProviderError} })}` blocks; `custom` and `kinesis` are essentially identical. **Fix:** a provider descriptor table `{ key, resolveId, cacheKey, batchFn }` driving one loop.

### SIMP-34 — quoteBackfill `getInvestments(With)HoldingWindows` — SELECT + row-mapper cloned — ~35 lines

`services/quoteBackfillService.js:186–260` vs `268–329`: the same 25-line SELECT (12-column `price_provider_*` list) and the same 13-field investment literal written twice. **Fix:** parameterize the WHERE, share `mapRowToInvestment(row)`.

### SIMP-35 — AI-chat tools: repeated bucketing/shaping/envelope + arg-coercion dup — ~110–130 lines

- `tools/expenses.js`: the `ymd → year/quarter|year-month` bucket-key logic is inlined 4× (124–135, 314, 514, 665–670) and the `{id, date, amount, recipient, category, memo}` row shaper appears 4× (272, 409, 458, 611) → `bucketKey(ymd, groupBy)` + `shapeTxnRow(row)`.
- `tools/portfolio.js`: the per-investment `{income, costs, count}` flow aggregation is duplicated (161–207 vs 480–506), and the `txnsByInvestment` grouping + `computeNetUnits` + market-value calc repeats ×3 (84–108, 320–343, 392–415) → `aggregateFlows(txns, range)` + `groupTxnsByInvestment(txns)`.
- All 29 tools repeat the same envelope (destructure `maxRows`, validate, `rows.slice(0, maxRows)`, `{ok, data, meta}`) → a `defineTool({...})` factory centralizes the contract.
- `aiChatService.js:43–56` `parseToolCallArguments` duplicates `tools/index.js:107–123` `coerceArguments` → export one.

### SIMP-36 — `svgGroupedBarChart` is a special case of `svgGenericGroupedBarChart` — ~40 lines

`services/reports/sectionHelpers.js:123–178` vs `228–280`: the income/spending chart is the generic N-series chart with two fixed series. All three chart builders also repeat the empty-SVG string, W/H/PAD constants, baseline, label-thinning, and legend loop — a `chartFrame()` helper trims more. **Fix:** call the generic with a two-series config.

### SIMP-37 — importRoutes: result block ×3, csv-options validation ×2 — ~20 lines

The `requiresReview` + `{total, imported, duplicates, errors, batch_id, auto_linked_count}` result block repeats in `/csv:59–80`, `/csv/custom:138–157`, `/csv/stream:267–291`; the separator/encoding validation is duplicated in `/recipients:314–320` and `/categories:338–344`. **Fix:** `buildPipelineResult(pipelineResult)` + `parseCsvOptions(req)`.

### SIMP-38 — Ollama error-normalization ×2 + no-logic pass-throughs — ~12 lines

`integrations/ollama/client.js`: the timeout/abort/network error mapping is written twice (`request:112–121`, `chatStream:259–269`) → `normalizeFetchError(err, opts)`. `services/priceProviderService.js:256–262`: `_fallbackHistoricalPoints` → `_filterHistoricalPoints` → `filterPointsByRange` are two wrapper layers with no logic → inline.

---

## Round 2 — test suites (SIMP-39…43)

The suite is healthy where it counts: `renderWithApp` is shared by 55 frontend files, MSW is centralized, there are essentially no skipped/dead tests, and the big backend test files (`filterBuilder`, `priceProviderService`, `aiChatTools`, `pit.test.ts`) were checked and are **correctly** shaped, not table-able. The debt is concentrated and mechanical:

### SIMP-39 — Route-test harness copy-pasted in 22 files — ~470 lines

Every backend route test re-declares the same ~15-line `mockRouter`/`routeHandlers`/`vi.mock('express')` scaffold (e.g. `tests/routes/ai.test.js:9–24`) **and** a ~10-line `mockResponse()` helper (e.g. `routes/info.test.js:842`) — 22 files each, and no `tests/helpers/` directory exists at all. On #84's tree it's already 23–24 files. **Fix:** `tests/helpers/routeHarness.js` exporting `createMockRouter()` and `createMockResponse(extra)`.

### SIMP-40 — Shared test mocks: logger ×28, `clearAllMocks` ×73, repo mocks, temp files — ~200 lines

- The literal `logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }` mock appears verbatim in 28 files → `mockLogger()`.
- `vi.clearAllMocks()` in `beforeEach` across 73 files → vitest `clearMocks: true` config.
- The AI-chat repository `vi.mock` blocks are re-declared across 4 files → `tests/helpers/repoMocks.js`.
- 8 bank-adapter tests each define the same `writeTempCSV` + unlink `afterEach` → `tests/helpers/tempFile.js`.

### SIMP-41 — `contracts.test.ts`: sequential identical `it()` blocks — ~150–200 lines

`src/test/msw/contracts.test.ts` (1,352 lines, ~119 tests): lines 320–432 are 5 resources × 2 byte-identical blocks differing only in `{path, Schema, STUB, limit}`; 273–313 are ~11 one-line schema checks; the mutation section repeats 45 `mutateEnvelope(...)` one-liners. Only 4 files in the whole repo use `it.each` today. **Fix:** `describe.each`/`it.each` tables.

### SIMP-42 — Hook-test QueryClient wrapper re-implemented ×7 — ~70 lines

Seven `hooks/**/__tests__` files each define a ~12-line `makeWrapper`/`createWrapper` (`new QueryClient({retry:false…})` + provider); `renderWithApp` covers component rendering but nothing covers `renderHook`. **Fix:** `src/test/queryWrapper.tsx` exporting `createQueryWrapper()`.

### SIMP-43 — MSW handler micro-helpers — ~40–60 lines

`test/msw/handlers.ts` already uses `ok()`/`err()`, but the `meta: { computedAt, source: "live" }` wrapper repeats 13× and `ok({ message: "... deleted" })` stubs repeat 11× → `aggOk(data)` + `deleted(msg)`.

---

## Round 2 — judgment calls (SIMP-44…46)

### SIMP-44 — App.tsx hand-maintained lazy/route lists + redundant react-query overrides — ~50 lines

`App.tsx` has 37 `const X = lazy(routeLoaders["/path"])` lines (26–62) that must be kept in sync with the `routeLoaders` map by hand, and `<RequireAdmin>` is wrapped manually 6× — derivable from the map + one admin parent route. Separately, several hooks re-state query options equal to the app defaults (`staleTime: 30_000` in `useSplits` ×3, `useTransactions:35`, `useFilteredDashboardStats:105`, `useAIChat:19`) and `staleTime: 60_000` recurs ~15× as a magic number → drop redundant overrides, hoist a shared constant. Medium confidence; behavior-neutral but touches routing.

### SIMP-45 — `recharts` is a full charting dependency for exactly one component — CONSIDER

`grep -rln recharts` → only `features/ai-chat/ToolResultCard.tsx`; every other chart uses visx. Porting that one card to visx drops the dependency. Not dead code — a bundle-weight judgment call.

### SIMP-46 — 1.1 MB checked-in pg_dump — CONSIDER

`packaging/electron/demo-db/01-demo.sql` is pg_dump output, regenerable via the co-located `generate.mjs`/`regenerate.sh`, but it IS a required build input (`demo-db/Dockerfile` COPYs it). Keep if the demo image must build offline; otherwise generate at build time. Largest artifact in the tree.

### Round 2 non-findings — checked, leave alone

- **Root `alembic.ini` vs `config/alembic.ini`** — not duplication: the root file is an intentional 791-byte compat shim; both are reachable.
- **`apps/frontend/src/types/generated.ts`** — generated but CI-guarded (`verify-generated` job). Correct.
- **`docs/flow-visualizer.html`, `docs/templates/*`** — hand-authored and referenced, not artifacts.
- **All `apps/node-backend` dependencies** — every one verified imported (`pg`, `decimal.js`, `express`, `zod`, `multer`, `csv-parse`, `puppeteer`, `yahoo-finance2`).
- **`lib/concurrency.js` / `lib/network.js` / `toolCache.js`** — appropriately minimal; `forEachConcurrent` is a legitimate bounded pool (no p-limit in deps).
- **`lib/api/client.ts`** — single well-factored transport, no duplicate fetch wrappers; `lib/api.ts` is a live barrel with 37 importers.
- **Big backend test files** (`filterBuilder`, `priceProviderService`, `aiChatTools`, `pit.test.ts`) — high `it()` counts but each block asserts different behavior; converting to tables would hurt readability. `pit.test.ts` already uses a `profile()` factory.

---

## Round 3 — dead declarative surface (SIMP-47)

### SIMP-47 — 507 dead i18n keys (14% of the translation surface) — ~3,042 data lines

Of 3,529 flat keys in `i18n/source/en.json` (`nl.json` is an exact key-set mirror), **507 have zero occurrence anywhere** in `apps/`, `packaging/`, `scripts/`, `packages/`, or `config/` outside the locale files themselves. The count is deliberately conservative: it excludes 40 electron-used `app.*` keys, ~460 keys covered by 21 dynamic template-literal prefixes (e.g. `` t(`accounts.type.${…}`) ``, `research.scorecard.reason.*`), and 287 keys that appear anywhere else at all — including keys whose only "reference" is the dead scripts flagged in SIMP-01/02, so the true dead count **rises** once those are deleted. Largest dead namespaces: `planned` (44), `transactions` (40), `onboarding` (34), `statistics` (31), `tax` (28), `common` (28), `shadowDivergences` (19 — a removed feature). Hand-verified samples (0 refs each): `common.required`, `metals.howItWorks`, `shadowDivergences.refresh`, `export.comingSoon`, `settings.saved`, `notifications.updateAvailable`.

Each key is one line in each of 6 files (2 source JSON + 2 generated `src/locales/*.ts` + 2 generated electron JSON) → **~3,042 lines**.

**Root cause & durable fix:** `scripts/validate-locales.js` only checks the *reverse* direction (referenced-but-missing keys) — nothing detects present-but-unreferenced keys, so they accumulate silently. Add an **unused-key pass** to the validator (its `t()`/`tc()` extraction machinery already exists), with an allowlist for the 21 dynamic prefixes; then delete the 507 keys it reports. Do the validator first, deletion second, so the list is machine-generated rather than hand-maintained.

### Round 3 non-findings — API surface is exemplary

- **Zero dead API endpoints:** all **211** operations in `openapi.yaml` are referenced by production frontend code (211/211; none test-only, none electron-only). The endpoint-matrix changelog shows dead endpoints are actively removed, and `check-endpoint-matrix.js` enforces the count in CI. (Caveat: matching was path-level; any residual dead surface would be method-level and small.)
- **`openapi.yaml` is hand-written and already DRY** — 59 named schemas, 332 `$ref`s, shared ADR-026 envelope. The ~90 repeated 6-line `allOf` success wrappers are *not* a `$ref` win (OpenAPI 3.0 can't parameterize a generic wrapper).

---

## Round 3 — backend: finish the migration that already exists (SIMP-48…51)

### SIMP-48 — Exclusion-clause builder copy-pasted ~8× while the canonical helper sits unused — ~110–130 lines

The block "validate int4 ids → `AND COALESCE(t.category_id, r.default_category_id, pr.default_category_id) NOT IN (...)` + recipient `NOT IN (...)` + join fragment" is hand-copied at `infoRepo.forecast.js:26-55, 227-254, 346-373, 447-469` (4×), `infoRepo.monthly.js:26-27,128-133`, `infoRepositoryStatistics.js:89-104`, and `infoRepositoryRecipients.js:32-40, 165-177, 237-242` (3×).

Meanwhile `services/filterBuilder.js` exports `buildExclusionClauses` (line 243) and `buildAggregationFilter` (line 287) that produce exactly this shape — written, unit-tested (`tests/filterBuilder.test.js`), and with **zero production call sites** (verified: the file's other exports `buildTransactionWhere`/`validateInt4Ids` ARE live in 3 files; the two aggregation builders are only ever called from the test). The file's own header admits "callers are NOT migrated here", and `infoRepo.monthly.js`/`infoRepositoryStatistics.js` carry comments saying "match buildExclusionClauses" next to inline re-implementations.

**Fix:** finish the designed migration — import and call `buildExclusionClauses(...)` at each of the ~8 sites (~4 lines each). Bonus: this fixes a latent inconsistency where several recipient sites use `COALESCE(pr.id, r.id)` instead of the canonical `COALESCE(r.primary_recipient_id, t.recipient_id)`. Slightly elevated risk *because* it harmonizes that inconsistency — diff the SQL output per site.

### SIMP-49 — Period-pivot and rollup shaping duplicated across the info repos — ~65 lines

`getRecipientPivot` (`infoRepositoryRecipients.js:236-325`), `getTagPivot` (`infoRepositoryTags.js:24-103`), and `getCategoryPivot` (`infoRepositoryStatistics.js:88-182`) share the same `periodExpr` ternary, the same `SUM(ABS(amount))/COUNT(*) GROUP BY` shape, and an essentially identical JS accumulate→map→round→sort tail. Within `infoRepositoryRecipients.js`, three functions also re-implement the same "group converted rows by recipient, sum, sort desc, slice, round" rollup. **Fix:** `buildPeriodPivot(convertedRows, {idField, labelField})` + `rollupByRecipient(rows)` in `infoRepositoryHelpers.js` (which already hosts `buildCategoryFromConvertedRows` — precedent exists).

### SIMP-50 — Small service-layer dedups — ~50 lines

- `services/portfolio/snapshotBuilder.js`: the `if (assetClass==='stock'||'etf') … else if ('crypto') … else if ('metals')` sleeve dispatch repeats 4× (395-397, 418-420, 448-450, 494-496) → a `SLEEVE` lookup map + keyed accumulators.
- `infoRepo.forecast.js`: byte-identical local `aggregateByDate` closures at 310-317 and 420-427 (+ a by-category variant at 517-534) → one module-level helper; the cumulative-average-by-day loop is duplicated at 128-141 vs 167-180 → `avgCumulativeByDay(monthDayNet)`.
- `services/transferReconciliationService.js`: the two-leg `UPDATE transactions SET is_transfer=…, transfer_peer_id=…, transfer_source=…` pair repeats in 3 functions, and the clear-triple in 4 places → `markLeg(client, id, peerId, source)` + a `CLEAR_SQL` const.

### SIMP-51 — Backend hygiene — ~20 lines + a perf win

- **Dead env key:** `config/env.js:108` declares `IMPORT_PIPELINE_V2: booleanEnv(true)`; nothing reads it (0 grep hits; `TODO.md:3131` already flags it). Delete the line + its row in `docs/reference/environment-variables.md:47`.
- `infoRepositoryNetWorth.js:33-50`: the `firstDataDate` query is run twice (second differs only by dropping `WHERE is_active`) → one `LEAST(...)` query, one fewer round-trip.
- `infoRepositoryNetWorth.js:310-317`: `getNetWorthByAccount` awaits `convertToCurrency` per account in a loop; sibling repos already use the batch converters → batch it.
- `portfolioPerformanceSnapshotService.js:10-18`: imports symbols under `_`-aliases AND re-exports the same three — keep one declaration.

---

## Round 3 — electron, e2e, alembic (SIMP-52…55)

### SIMP-52 — Backup AES-256 crypto fully duplicated between electron main and bundle — ~150 lines

`packaging/electron/main.js:669-975` and `packaging/electron/backup/bundle.js:80-416` independently implement the identical scheme: scrypt KDF with the same params (`N=1<<15, r=8, p=1, maxmem=128*N*r*2` — the constants blocks at `main.js:165-176` and `bundle.js:43-78` mirror each other), AES-256-GCM (v2) / AES-256-CBC (v1 fallback), identical header layout (10-byte magic + salt + IV + trailing tag), identical stream-cipher promise boilerplate, and identical error→`INVALID_PASSPHRASE` mapping. The only real difference is the magic constant (`VISIONENC1/2` vs `VISIONBAK1/2`). **Fix:** a shared `packaging/electron/backup/crypto.js` parameterized by magic bytes. **This is crypto handling backups — refactor carefully and verify old backups still decrypt (v1 and v2 paths both).**

### SIMP-53 — Electron backup/restore plumbing copy-pasted inside main.js — ~110 lines

- `runBundleRestore` (2286-2347) is a near-verbatim copy of `runRestore` (2480-2558): stop app → terminate connections + DROP/CREATE DATABASE → resolve pg image tag + network via `docker inspect` → `psql -f` via throwaway container → restart app → `restoreSqlIntoDb(sqlPath, opts)`.
- The pg_dump-to-file spawn block is duplicated between `runBackup` (2067-2091) and `runBundleBackup` (2149-2165) → `pgDumpToFile(outPath, opts)`.
- The `.env` DB-credential parse preamble appears 4× (2046-2051, 2130-2135, 2262-2268, 2469-2475) → `resolveDbCreds()`.

### SIMP-54 — E2E page catalog redeclared; critical-flows unrolls identical tests — ~105–125 lines

`critical-flows.spec.ts:12-117` hand-writes 13 tests (15 on #84's tree) with the identical 6-line body, differing only in path + heading regex — while the exact `{name, path, heading}` table already exists in `a11y.spec.ts:11-21` and `network-drift.spec.ts:12-23`, both of which correctly loop. **Fix:** one `e2e/pages.ts` exporting `PAGES`; every spec imports and loops/filters. Smaller siblings: the create-category/recipient dialog flow is duplicated between `critical-flows.spec.ts:119-147` and `mutations-parity.spec.ts:20-71`, and `dialogs-edge.spec.ts:15-37` has four copies of an open-dialog helper.

### SIMP-55 — Dead alembic autogenerate block — ~20 lines, zero risk

`alembic/env.py:31-51` does `sys.path.insert(0, …/apps/backend)` then `from database.models import Base` — but there is **no `apps/backend` directory and no `models.py` anywhere in the repo** (the backend is Node). The import always fails, logs a warning, and `target_metadata` stays `None`, so `--autogenerate` can never work. **Fix:** delete the block, keep `target_metadata = None`. (Leave the SQLite branch — `config/config.py` still references it for test paths.)

---

## Round 3 — frontend portfolio dialogs & small dedups (SIMP-56…58)

### SIMP-56 — Portfolio transaction form fields triplicated — ~180–200 lines

`AddPortfolioTxnDialog.tsx` (form JSX 169-311) and `EditPortfolioTxnDialog.tsx` (181-353) are ~90% identical — type/date/account/units/price/amount/fees/taxes/FX/recurring/note fields, plus a duplicated `parsePositive` helper and an identical `RECURRENCE_LABELS` map — and `AddInvestmentFromMarketDialog.tsx`'s `'transaction'` step (298-409) is a third partial copy. **Fix:** extract `<PortfolioTxnFormFields …>` + shared `parsePositive`/`RECURRENCE_LABELS`; each dialog body drops to ~30-40 lines.

### SIMP-57 — `EditInvestmentDialog` reimplements `InvestmentFormFields`' provider block — ~110 lines

`EditInvestmentDialog.tsx:175-297` (provider select + provider-id + manual price + the 6 custom-JSON path inputs) near-verbatim copies `InvestmentFormFields.tsx:282-402` — the shared component that `AddInvestmentDialog` already uses, sitting in the same directory. The `PRICE_PROVIDERS` array is defined 3× (Edit :52-58, Add :25-31, plus pass-through). **Fix:** extract `<PriceProviderFields …>` used by both; hoist `PRICE_PROVIDERS` to one module constant.

### SIMP-58 — Small frontend dedups — ~130 lines

- `features/imports/CsvColumnMapper.tsx:46-123` writes all four columns twice (headers/no-headers branches); its sibling `PortfolioCsvColumnMapper.tsx` already solved this with a config-array `.map()` (104-126) — adopt the same pattern (~40).
- `components/portfolio/PerformanceBreakdown.tsx:208-275`: top/bottom performer blocks are identical JSX differing in title/icon/tone; `TotalValueCard.tsx` already has a reusable `PerformerRow` (~30).
- `features/ai-chat/ToolResultCard.tsx`: `LineChartView` (191-220) and `BarChartView` (222-249) share the full recharts frame, differ only in the mark → `<CartesianChartView kind>` (~25).
- `components/settings/sections/GeneralSection.tsx:40-132`: seven identical `SettingRow`→`Select` blocks → `<SelectSettingRow>` over a config list (~25, partial).
- `features/imports/ExportCard.tsx:132-147`: two identical export buttons → map over `['csv','json']` (~10).

### Round 3 non-findings — checked, leave alone

- **Accounts dialogs** — `AddAccountDialog` already unifies create/edit via a `mode` prop; `Close`/`Merge` are genuinely distinct flows.
- **`SimpleImportCard`, `SettingsPrimitives`, ai-chat list/bubble components, `TotalValueCard`** — already cleanly factored shells with real consumers.
- **No dead exports** found in the round-3 frontend directories (12 suspects each verified to have real importers).
- **`ForecastInner` vs `ForecastInnerRolling`** — share a skeleton but genuinely differ (axis type, merge fn, today-line); consolidation would add branching that offsets savings. Borderline, not recommended.
- **Alembic migrations** (64 + 39 legacy) — append-only one-off DDL history; recurring trigger/function blocks have distinct bodies. Correctly out of scope. `script.py.mako` is stock.
- **`Dockerfile` two-stage COPY repetition** — inherent to multi-stage builds (isolated filesystems), heavily commented as intentional.
- **`demo-db/generate.mjs`** — dense but single-purpose; duplicates no backend seeder.
- **`preload.js`** — straight contextBridge exposition.
- **`routes/settings.js`, `cashflowForecast.js`, middleware, remaining `config/env.js` keys** — verified clean/consumed; only `IMPORT_PIPELINE_V2` is dead.

---

## PR #84 cross-check

PR **#84** (`claude/review-todo-backlog-jrbvpo`, 279 files, +12k/−3.9k, based on the same `main@1e494de`) is the open integration branch consolidating #79–#83/#87. Every finding above — both rounds — was re-verified against its head `413d40e` by grepping that tree directly (`git grep … origin/claude/review-todo-backlog-jrbvpo`). Results:

- **No finding is fixed by #84.** All 58 remain present on its tree; the dead files (SIMP-01…03) are untouched, `RecipientInsightsPage` is still unrouted, the nine shadcn components are still unimported, both electron lockfiles are still tracked, the CI prelude still repeats 9×, the `1.4826` MAD block is still in both sanitizers, `buildExclusionClauses`/`buildAggregationFilter` still have zero production call sites, the backup-crypto KDF constants are still duplicated, the alembic dead import is still there, the sampled dead i18n keys are still unreferenced, and `PRICE_PROVIDERS` is still defined in both portfolio dialogs.
- **Some got worse:** SIMP-16 — the planned-transaction SELECT block appears 6× on #84 vs 5× on main; SIMP-15's SET-clause idiom grew to 30 sites (accounts rewrite); SIMP-39's route-test harness grew from 22 to 23–24 files; SIMP-54's unrolled critical-flows tests grew from 13 to 15.
- **One fix should be done differently on #84:** SIMP-08 — #84 introduces `apps/node-backend/src/lib/dateFormat.js`; the surviving private `toYmd` copies should route through it rather than a new helper.
- **Line-number drift:** #84 rewrites `accountRepository`, the charts, `dateUtils.ts`, `TaxOverviewPage`, and splits `portfolioTxRepo` into `.common`/`.reads`/`.writes` (+ tests). If working on or after #84, re-locate code by the grep patterns given per finding, not by the line numbers (which are pinned to `main@1e494de`).

Practical consequence: **land the cleanup PRs after #84 merges** (or rebase them onto it) — otherwise SIMP-13/14/15/16/18 will conflict with #84's 279-file diff.

---

## Non-findings — checked and deliberately left alone

These were flagged as suspects by size and verified **fine**; don't spend refactor budget here:

- **`pages/research/MarketOverviewPage.tsx` (1,111 lines)** — ~850 lines are irreducible static `REGION_VIEWS`/`SECTOR_VIEWS` symbol-universe data; the rendering is already config-driven (`ToggleCluster` + `renderGrid`).
- **`styles/themes.ts` (614 lines)** — five genuinely distinct hand-tuned HSL palettes, already applied via a `TOKEN_KEYS` loop. Not compressible from a smaller table.
- **`contexts/BelgianTaxProfileContext.tsx`** overall — a real 25-method state/persistence manager; only the debounce triplication (SIMP-20) is bloat.
- **`docker-compose.{yml,dev.yml,clean.yml}`** — already a correct base+override split; anchors wouldn't help (they don't cross files).
- **Backend error handling & switch chains** — routes consistently throw typed errors into a central handler; big switches are already lookup registries.
- **`packages/shared-utils`** as an institution — `money`, `slugify`, `downsample`, and portfolio math are already single-sourced and re-exported by both apps; SIMP-10/11 just finish the job for the stragglers.
- **`scripts/sync-nl-with-en.js`, `generate-locales.js`, `docker-entrypoint.sh`, `setup-git-hooks.js`** — lean and referenced; the `normalizeString` typographic normalizer is purpose-built, not replaceable by a stock library.

---

## Suggested sequencing

Wait for PR #84 to merge first (or branch from it) — see the cross-check section. Then:

1. **PR: dead code & artifact deletion** (SIMP-01, 02, 03 + SIMP-23, 24, 25, 26, 29 + SIMP-51's env key, SIMP-55) — ~2,000 lines + ~590 KB + 15 deps, zero-to-minimal behavioral risk, immediate.
2. **PR: unused-key validator pass, then dead i18n keys** (SIMP-47) — extend `validate-locales.js` first (with a dynamic-prefix allowlist), then delete the machine-generated dead-key list (~3,000 data lines). Do after step 1 so keys referenced only by the deleted scripts are included.
3. **PR: formatting stragglers** (SIMP-05…12) — mechanical swaps to existing hooks/deps; verify with `bun run test:frontend` + visual e2e.
4. **PR: kill `DataTable`** (SIMP-04) — migrate `DashboardPage` to `VirtualDataTable`, delete the copy.
5. **PR: CI hygiene** (SIMP-27 composite setup action, SIMP-28 verify-locales job) — tooling only; pairs naturally with step 2.
6. **PR per backend extraction** (SIMP-14…17, 19 round 1; SIMP-30…38 round 2; SIMP-48…51 round 3) — small, each independently testable. Start with SIMP-30 and SIMP-48: both are "finish a migration whose shared home already exists" (`lib/parserConfigRoutes.js`, `services/filterBuilder.js`). For SIMP-48, diff the generated SQL per call site — it intentionally harmonizes a `COALESCE` inconsistency.
7. **PR: test-harness helpers** (SIMP-39…43) — create `apps/node-backend/tests/helpers/` + frontend `queryWrapper`; then the `contracts.test.ts` tables. Coverage-neutral by construction. Include the e2e page-table consolidation (SIMP-54).
8. **PR: portfolio dialog extractions** (SIMP-56, 57) — the two biggest frontend wins after the charts; both reuse components already in the same directory.
9. **PR: chart frame extraction** (SIMP-13) — the largest single win; do it after the visual-regression e2e suite is green so scrub/hover/sync behavior is pinned.
10. **PR: tax page dedup** (SIMP-18), debounce/installers (SIMP-20), App.tsx routes (SIMP-44), small dedups (SIMP-58) — UI-only / tooling-only, config-driven rewrites.
11. **Careful, each in its own PR:** cost-basis merge (SIMP-21) under golden fixtures; locale-lexer swap (SIMP-22) with a key-extraction diff; **electron backup crypto dedup (SIMP-52/53) with explicit decrypt tests for v1+v2 legacy backups**. SIMP-45/46 are optional judgment calls — decide, don't default.

When a finding lands, update its row in the [status ledger](#status-ledger) to `FIXED (<PR #>)` in the same PR.

---

# Round 4 — post-remediation audit (SIMP-59…84)

**Audited at:** `main@6be1ee6` (2026-07-16). All line numbers below refer to this commit — the tree has moved ~24k insertions / ~26k deletions since the round 1–3 baseline (`1e494de`), so rounds 1–3 line numbers no longer apply.
**Scope & method:** five parallel dimension sweeps over the post-#92 tree — backend, frontend, library-reimplementation ("1 line replaces 100"), tests/e2e/CI/electron, and dead-code/dependency/drift — each finding verified by reading the code at HEAD; the highest-impact claims (dead reachability, dep installation, helper call-site counts) were independently re-verified with grep by the coordinating pass. Read-only — no code was changed.

**What changed since rounds 1–3:** PR #92 landed the bulk of SIMP-01…58; #93/#99/#100/#101 landed ~230 TODO-backlog fixes, the timezone (ADR-009) routing, and the accounts epic follow-ups. Round 4's dominant theme is therefore different from round 1's: it is **stragglers of the remediation itself** — helpers that #92 created and migrated 7 call sites onto while leaving 7 more on the old idiom (SIMP-68), shared components adopted by two of three intended consumers (SIMP-76), test helpers adopted by 25 files while 23 still inline the old mock (SIMP-81) — plus a second stratum of dead code that only *became* dead when the fix PRs deleted the last caller (SIMP-60, 62).

**Status updates to earlier findings observed at HEAD:**
- **SIMP-48 is now half-done** (not by a SIMP PR — as a side effect of the backlog batches): `infoRepo.monthly.js` and `infoRepositoryStatistics.js` call `buildExclusionClauses`; `infoRepo.forecast.js` (4 sites) and `infoRepositoryRecipients.js` (3 sites) still carry the inline copies. Finishing it is now half the original size.
- **SIMP-56 was marked FIXED but has a straggler:** `AddInvestmentFromMarketDialog` (the "from-market" third copy the finding named) never adopted `PortfolioTxnFormFields` — re-filed with evidence as SIMP-76.
- **SIMP-40's planned `repoMocks.js` was never created** — `tests/helpers/` contains only `routeHarness.js`, `mockLogger.js`, `tempFile.js`. The gap is re-scoped as SIMP-81.
- **SIMP-47's durable fix is working:** `node scripts/validate-locales.js` at HEAD passes its unused-key pass — no dead i18n keys have regrown.

**Realistically removable in round 4: ~2,300–2,700 source/config lines + ~1,000 test lines**, 7 npm dependencies/override entries, and two live behavior drifts fixed as a side effect (SIMP-67's RebalancePage locale bug, SIMP-80's SSE error-detail gap). Of that, ~800 source lines are zero-risk verified-dead deletions.

| Tier | Theme | Findings | Est. lines | Risk |
| --- | --- | --- | --- | --- |
| R4-dead | Dead code the remediation orphaned or missed | SIMP-59…64 | ~800 + ~370 test | None–low |
| R4-deps | Dead deps, orphaned overrides, dead config, toolchain drift | SIMP-65, 66 | ~90 + 7 deps | None–medium |
| R4-stragglers | Finish adopting the helpers that already exist | SIMP-67…71 | ~250 | None–low |
| R4-library | Hand-rolled code an installed dep replaces | SIMP-72…74 | ~240–335 | Low–medium |
| R4-frontend | Copy-paste collapse (dialogs, pages, comboboxes, micro-patterns) | SIMP-75…79 | ~600–800 | Low–medium |
| R4-backend | Service-layer batch | SIMP-80 | ~140–150 | Low |
| R4-tests | Test/e2e dedup round 2 | SIMP-81, 82 | ~610–710 test | Low |
| R4-infra | Electron IPC/builder + CI/compose | SIMP-83, 84 | ~95–125 | Low–medium |

---

## Round 4 — dead code (SIMP-59…64)

### SIMP-59 — Four frontend modules alive only through their own tests — ~244 src + ~299 test lines, zero risk

Each has **zero production importers** (verified: the only importer of each is its own test file; the `sanitize` hits in `RemoteNewsImage.tsx` and `types/generated.ts` are an unrelated local function and an API path string):

- `apps/frontend/src/utils/sanitize.ts` (80) + `utils/__tests__/sanitize.test.ts` (~95) — all six exports dead
- `apps/frontend/src/hooks/useCountUp.ts` (63) + its block in `hooks/__tests__/useUtilityHooks.test.ts`
- `apps/frontend/src/hooks/useFormState.ts` (68) + co-located test (~97)
- `apps/frontend/src/hooks/useDataTableColumns.ts` (33) + co-located test (~107)

**Fix:** delete module + test together. *Re-verify:* `grep -rln "useCountUp\|useFormState\|useDataTableColumns\|utils/sanitize" apps/frontend/src | grep -v test`.

### SIMP-60 — 24 dead `apiClient` members + 22 dead backing functions — ~115–145 lines

`lib/api.ts` exposes 24 members with zero call sites outside `lib/api/` and tests: `cancelAll`, `getTransaction`, `getCategory`, `getAccount`, `getRecipientAliases`, `getRecipientClusters`, `getPlannedTransaction`, `getImportBatch`, `saveSettingsBulk`, `getInvestment`, `getPriceProviders`, `getBanks`, `getCashflowComparison`, `getMonthlyFinancialSummary`, `getBelgianInflationRates`, `refreshMaterializedViews`, `getUpdateMode`, `getResearchQuote`, `getResearchFundamentals`, `getAggregationCategoryBreakdown`, `getAggregationCashflowComparison`, `getAggregationAverageVsCurrent`, `getAggregationBankBalances`, `sendChatMessage`. 22 of their backing functions (in `lib/api/{info,research,ai,aggregations,transactions,categories,accounts,recipients,planned,imports,settings,portfolio,electron,client}.ts`) are reachable only via the dead member and die with it.

**Careful:** two backing functions are **still live** through other wrappers and must be kept — `getAggregationMonthlySummary` (`aggregations.ts:5`, live via `apiClient.getAggregationMonthlySummary`) and `getAggregationBankBalances` (`aggregations.ts:99`, live via `apiClient.getBankBalances`); for those two, delete only the dead member lines. **Fix:** delete members first (fully safe), backing functions second. *Re-verify per member:* `grep -rn "apiClient\.<name>\b" apps/frontend/src | grep -v lib/api | grep -v test`.

### SIMP-61 — Dead frontend exports batch — ~150 lines

- `lib/motion.ts:60-122`: seven variants (`fadeUp`, `fadeIn`, `scaleIn`, `dialogVariants`, `staggerContainer`, `microLift`, `pressFeedback`) have zero importers — every consumer pulls only `springs`/`durations`/`easings` (keep lines 13–58). ~63 lines.
- `components/shared/chartStyles.ts` (19 lines): recharts-era leftover, zero importers repo-wide.
- `hooks/useTags.ts:30-58`: `useUpdateTag`/`useDeleteTag` have zero callers (`useTags`/`useCreateTag` are live). ~28 lines — confirm tag editing isn't an in-flight feature before deleting.
- `lib/belgianTax/constants.ts:595-613` + `contexts/BelgianTaxProfileContext.tsx:62-79`: 18 "backwards-compat" constants (`BELGIAN_TAX_BRACKETS`, `EMPLOYEE_SS_RATE`, `PENSION_SAVINGS_CAP_*`, …) exist only as definition + re-export, zero consumers; one is self-marked `@deprecated`. Keep `DEFAULT_COMMUNAL_SURCHARGE`, `SUPPORTED_TAX_YEARS`, `LATEST_TAX_YEAR`, `getTaxTable`. ~36–40 lines.

### SIMP-62 — `shared-utils/downsample.js` is a dead module chain; `index.d.ts` drifts from `index.js` — ~95 + ~60 test lines

`downsampleLTTB`'s last production caller (the performance-snapshot path) was deleted; a comment at `routes/info/_performanceHelpers.js:76-78` even records the removal. Dead: `packages/shared-utils/src/downsample.js` (79), `downsample.d.ts` (7), the backend re-export shim `apps/node-backend/src/utils/downsample.js` (5), two barrel lines, and `tests/downsample.test.js` (~60). While editing the barrels, fix the drift: `index.js` re-exports 5 modules but `index.d.ts` omits `portfolio` — masked only because all consumers use the `/portfolio` subpath. *Re-verify:* `grep -rn "downsampleLTTB" --include="*.js" --include="*.ts" apps packages | grep -v test`.

### SIMP-63 — Dead backend functions superseded by their own replacements — ~34 + ~10 test lines, zero risk

- `middleware/validation.js:181-191` `validatePagination`: zero production callers; `lib/pagination.js` (created in the fix PRs, adopted by all list routes) replaced it and its docblock documents the old function's defects. Delete + its block in `tests/validation.test.js:98-113`.
- `database/migrate.js:293-312` `downgradeMigrations`: exported, zero callers; the operator path is the npm script `db:migrate:down` (alembic directly). ~22 lines.

### SIMP-64 — Dead electron surface — ~113 lines

- **`electronServices` API is unwired end-to-end:** `preload.js:113-132` exposes it, `main.js:3395-3411` registers `services:save-settings`/`load-settings`, and `main.js:4209-4212` reads `keepServicesOnQuit` at quit — but no renderer caller exists (`grep -rn "electronServices" apps/` → nothing), so the only writer of `keepServicesOnQuit` never runs and the "keep Docker on quit" branch is unreachable. ~40 lines (or wire a UI if the feature is wanted).
- **`applyDockerImageUpdate`** (`main.js:2419-2431`) and **legacy `runBackup`** (`main.js:2479-2538`): each name greps exactly once (its definition); all live backup entry points call `runBundleBackup`, and the live image-update path inlines the logic at 2960–2966. Deleting `runBackup` also removes a duplicated pg_dump spawn block (distinct from deferred SIMP-52/53 territory). ~73 lines — verify `encryptBackupFile`/`cleanupOldBackups` retain callers before cascading.

---

## Round 4 — dependencies, overrides, dead config (SIMP-65, 66)

### SIMP-65 — Dead deps, orphaned overrides, dead config — ~90 lines + 7 deps/override entries

**Dead frontend devDependencies** (each verified zero imports and zero config references): `@tailwindcss/typography` (no `@plugin`/`prose` usage anywhere), `jest-axe` + `@types/jest-axe` (a11y runs exclusively through `@axe-core/playwright`). `@vitest/ui` is a judgment call (no script uses `--ui`; docs mention it once for manual use).

**Redundant electron declarations:** `packaging/electron/package.json` directly declares `archiver-utils`, `compress-commons`, `readable-stream`, `zip-stream` — zero requires anywhere; all four are transitives of `archiver` (verify no deliberate version pin against `packaging/electron/bun.lock` before dropping).

**Orphaned root overrides/resolutions** (zero resolved entries in `bun.lock`): `rollup` (vite 8 bundles rolldown), `basic-ftp`, `lodash` (resolves only in electron's separate lockfile, which the root override doesn't govern). Also delete the dead `react-hook-form` branch in `apps/frontend/vite.config.ts:50,83` `manualChunks` — the package was removed in SIMP-23 but the chunk rule survived.

**Dead config:**
- `config/config.py` (38 lines): Python config module with zero importers — `alembic/env.py` reads `DATABASE_URL` directly and does not import it; only reference is a docs row.
- `env.DEBUG` → `config.debug` chain: `config/env.js:58` declares it, `config/config.js:54` maps it, nothing reads `config.debug`. Delete both lines + the docs row.
- `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_NAME` compose injections (`docker-compose.yml:98-101`): `docs/reference/environment-variables.md:159-162` already documents them as "stale / not consumed — safe to remove from compose"; remove them and the doc rows.

### SIMP-66 — Toolchain version-drift hazards — correctness, not lines

- **typescript:** both apps declare `^7.0.2`, but the root override/resolution pins `^6.0.3` and `bun.lock` resolves **6.0.3** — which is what the toolchain actually supports (`typescript-eslint@8.64` peers `<6.1.0`, `openapi-typescript@7.13` peers `^5.x`). The `^7.0.2` declarations are misleading and would break lint/type tooling if the override were ever removed. **Fix:** align the app declarations to `^6.0.3`; do *not* bump the override to 7.
- **vite:** frontend declares `^8.1.4` but the root override pins `8.0.16` — the pin drags vite *below* the app's own semver floor. **Fix:** raise the override to ≥8.1.4 (or lower the declaration); reconcile so declared ≤ resolved.

---

## Round 4 — finish adopting the helpers that already exist (SIMP-67…71)

### SIMP-67 — 13 files still hand-roll currency formatting past the shared hooks — ~90–110 lines + a live locale bug

SIMP-06 fixed its enumerated 8 files; this is a disjoint straggler set, all replaceable by `useCurrencyFormatter`/`useChartCurrencyFormatter`: `InvestmentDetailDialog.tsx:45-61` (re-implements the hook *including its cache*), `CloseAccountDialog.tsx:78-83`, `ResearchHomePage.tsx:111-117`, `WatchlistPage.tsx:78-84` (identical bodies), `MarketLookupPage.tsx:137-145`, `WatchlistChartDialog.tsx:124-130`, `PortfolioTaxAdjustmentsDialog.tsx:96-102`, `SuggestedDeductionsCard.tsx:15-23`, `YearComparisonCard.tsx:72-80`, `MultiYearTrendStrip.tsx:43-52`, `ResearchFundamentalsTab.tsx:99-101`, `MonthlyTrendsChart.tsx:45-58` (compact variant — `formatCompact` already exists), and `RebalancePage.tsx:87-88`, which passes `undefined` locale and therefore **ignores the user's number-format setting** — a live drift bug. `CommandPalette.tsx` is the one legitimate exception (needs try/catch for invalid quote currencies) — dedupe its two internal copies instead. *Re-verify:* `grep -rln "new Intl.NumberFormat" apps/frontend/src | grep -v hooks/use`.

### SIMP-68 — `lib/sqlClauses.js` has 7 unmigrated hand-rolled call sites — ~35 lines

PR #92 created `buildSetClauses`/`buildInsert` and migrated 7 repositories, but left the exact target idiom in: `savedChartsRepository.js:41-58` (13-field bag — biggest win, use `mapColumn`), `recipientBankAccountRepository.js:60-82, 123-140`, `recipientRepository.js:216-231`, `categoryRepository.js:89-104`, `tagRepository.js:100-117`, `customParserConfigRepository.js:51-65`, `recipientPatternService.js:369-385`. **Caveat:** several sites add `&& x !== null` guards (`is_active`, `general`, `detail`) — pre-strip nulls from the field bag to preserve "null means skip" semantics. *Re-verify:* `grep -rn "setClauses.push" apps/node-backend/src`.

### SIMP-69 — `@vision/shared-utils/category` is stranded while 4 inline reimplementations live on — ~30–35 lines

`packages/shared-utils/src/category.js` (`formatCategoryName`/`parseCategoryName`, extracted per its own docblock from "a local closure — see RecipientsPage") has **zero production callers** — only its test imports it. Meanwhile: `RecipientsPage.tsx:214-223` still has the original closure, `DashboardPage.tsx:222-231` carries a verbatim duplicate, and `dataImportService.js:120-124, 193-197` splits on `:` by hand twice. **Fix:** either finish the migration (all four sites) or delete the module + test (~120 lines) — don't leave it stranded. TODO.md ~3308 confirms the call-site sweep was planned and never happened.

### SIMP-70 — Y-M-D formatter stragglers vs canonical `lib/dateFormat.js` — ~28 lines, TZ-sensitive drift hazard

PR #101 made `formatDateToYmd` canonical for local-getter date extraction, yet three hand-copies of the exact TZ-sensitive logic survive: `currency/rateFetcher.js:62-68` (comment says "mirrors toYmd"), `importPipeline/commit.js:81-86`, `calculations/recurrence.js:108-113`. Separately, the **UTC** variant `new Date(ms).toISOString().slice(0, 10)` is locally aliased in 7 files (`quotaGovernor.js:42`, `finnhubAdapter.js:28`, `priceCache.js:33`, `holtWinters.js:30`, `prophetLite.js:109`, `_densify.js:24`, `rateFetcher.js:234`) → one `epochMsToUtcYmd` in `dateFormat.js`, deliberately named to stay distinct from the local-time formatter (that distinction is load-bearing per the file's header). Frontend twin: `lib/timezone.ts:19-25` `todayYmd` hand-formats what line 9's re-exported `toYmd` already does. Line count is small; the value is that a future TZ fix propagates to all copies.

### SIMP-71 — Small helper-exists batch — ~50 lines

- `recurringDetectionService.js:51-56, 114-119`: byte-identical reimplementations of `lib/math.js` `median()` (created by SIMP-31). The pseudo-median at `researchMappingService.js:223-224` is a tiny behavior change — treat separately.
- ISO-4217 validation triplicated: `accountService.js:53-57`, `openingBalanceService.js:55-62`, `routes/watchlist.js:68-78` (its comment even cites `assertCurrency`) → use `middleware/validation.js:145` `assertCurrency`.
- `hooks/useTransactions.ts:303-312` `triggerBlobDownload` reimplements `lib/downloadBlob.ts`, whose docstring exists to prevent exactly this copy (the shared one revokes in `finally`).
- `providerHealthService.js:93-95, 106-108`: manual `AbortController` + `setTimeout` where the codebase's dominant pattern is `AbortSignal.timeout` (10+ sites).
- `recipientPatternService.js:64, 242`: hand-rolled regex escaping — `RegExp.escape` is available under Bun.
- `AreaChart.tsx:418`: `Math.random` SVG gradient id → React `useId()` (deterministic for snapshots).

---

## Round 4 — hand-rolled code an installed dependency replaces (SIMP-72…74)

### SIMP-72 — `routes/settings.js` hand-rolls ~185 lines of validators; zod is installed and in use one file over — ~90–110 net lines

Lines 46–230 (`assertFiniteNumberInRange`, `assertBelgianTaxProfileValue`, `assertBelgianTaxSnapshotsValue`, `assertBelgianTaxSnapshotMetaValue`, `assertThemeSettingsValue`, `assertDashboardSettingsValue`, `assertRebalancePlansValue`) implement deep object/enum/range/HH:MM-regex validation via manual `typeof` chains. zod ^4.4.3 is a backend dependency and `routes/reports.js:16, 95-98` already shows the house pattern (`safeParse` → `ValidationError`). **Deltas to handle:** `tests/routes/settings.test.js` asserts error-message text in ~16 places (update alongside); `assertDashboardSettingsValue` mutates via int-coercion — replicate with `z.coerce.number().int()`. (The broader `middleware/validation.js` is *not* included — it's shared across ~15 routes and is an architectural migration, noted as a non-finding.)

### SIMP-73 — `useCsvPreview.ts` hand-rolls a full CSV state machine; `csv-parse` ships a browser build — ~90–100 lines

`apps/frontend/src/hooks/useCsvPreview.ts:28-135` (`parseCsvLine`, `splitCsvRecords`, `parseCsvText`) implements quote-state-machine parsing with embedded-newline handling. `csv-parse` (v7, already in the workspace lockfile via the backend) ships `csv-parse/browser/esm/sync`: `parse(text, { delimiter: sep, to: MAX_PREVIEW_ROWS + 1, relax_column_count: true, relax_quotes: true })`. Bundle cost is small and lazy-loadable (only the import flow uses it). Side benefit: today the frontend preview parser and the backend's csv-parse can *disagree* on edge cases; this makes them agree. Verify truncated-tail behavior (file cut at `PEEK_BYTES`) with a test.

### SIMP-74 — Electron hand-rolled HTTP + semver — ~60–125 lines, fixes a latent bug

- `main.js` `readGitHubRelease` (:2111-2133), `fetchUrlBody` (:2146-2168, hand-rolled recursive redirect following), and the zip-download promise (:2212-2231) reimplement what Electron 43's global `fetch` provides — and the zip download **does not follow redirects** while GitHub `browser_download_url` serves a 302, so that path is fragile. **Fix:** `fetch` + `AbortSignal.timeout` for the JSON paths; `pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath))` for the download. Keep the unix-socket `http.get` health probes (fetch can't do `socketPath`). ~60–70 lines.
- `main.js:1959-2012` `compareVersions`/`comparePreRelease` reimplement semver precedence spec-section by spec-section — the `semver` package replaces both with one call, but it's a new runtime dep in the packaged shell; KEEP is defensible. ~55 lines, judgment call.

---

## Round 4 — frontend copy-paste collapse (SIMP-75…79)

### SIMP-75 — `CryptoPage` is an unparameterized copy of the already-parameterized `StocksPage` — ~200 lines (or ~35 minimal)

`StocksPage.tsx` was parameterized (`assetClasses`, `titleKey`, empty-state keys) and `MetalsPage.tsx` is a 13-line delegator — but `CryptoPage.tsx` (272 lines) still duplicates verbatim: loading/error/empty scaffolds (Crypto 71–109 ≡ Stocks 152–190), the StatCard grid, a byte-identical 16-line FX-column IIFE (212–227 ≡ 296–311), `openMarketLookup`, `fmtPct`, and the delete-confirm cell. Real deltas: icon, unit precision (6 vs 4), converted-vs-native price columns, no dividends column, no FX-aware PnL. **Full fix:** extend StocksPage's props (icon, decimals, column toggles, convertPrices) and make CryptoPage a delegator — Medium risk. **Minimal:** extract shared `FxPnlCell` + `fmtPct` — ~35 lines, Low risk.

### SIMP-76 — SIMP-56/57 stragglers in the portfolio dialogs — ~125–145 lines + an i18n bug

- `AddInvestmentFromMarketDialog.tsx` never adopted `PortfolioTxnFormFields` (its transaction step :324-444 still hand-rolls type/date/units/price/amount/fees/taxes/note) and has already drifted: it uses non-localized `TXN_TYPE_LABELS`, so its type dropdown is **untranslated**. Bonus dead code: `isRecurring`/`recurrence*` state (:77-79, 100-102, 180-182) has no UI and always submits `is_recurring: false`. Also the same duplicated initial/reset literal pair (:60-80 vs :84-103). ~100–120 lines.
- `EditInvestmentDialog.tsx:26-49` vs `:55-75`: identical 20-line form literal in init + reset (adopt the `initialForm()` factory pattern from `EditPortfolioTxnDialog.tsx:60-77`); its `price_provider_*` trim-block (:95-102) mirrors `AddInvestmentDialog.tsx:132-139`. ~25 lines.

### SIMP-77 — Combobox trio + pivot-hook twins — ~170 lines

- `shared/BankAccountMultiCombobox.tsx` (81), `CategoryMultiCombobox.tsx` (82), `TagFilterCombobox.tsx` (89): identical Popover+Command shell, `toggle()`, selected-first sort, "N selected" label — differ only in data hook, item render, i18n keys. → generic `MultiCombobox<T>` + three ~15-line wrappers. ~110 lines.
- `hooks/useRecipientPivot.ts` (89) vs `useTagPivot.ts` (84): same hook modulo renames, plus one real divergence (the tag variant passes `all: allTags`, the recipient one omits it) that a shared factory should encode. ~60 lines.

### SIMP-78 — Config-driven micro-dedups (research pages + misc) — ~120–140 lines

- 60s online-gated quotes `useQuery` block ×4 (`MarketOverviewPage.tsx:981-989`, `ResearchHomePage.tsx:60-68, 87-95`, `WatchlistPage.tsx:46-53`; `MarketLookupPage.tsx:195-206` has already drifted to 30s/no-retry) → `useMarketQuotesQuery(symbols)`.
- `RANGES` constant ×4 (`ResearchComparePage.tsx:32-38` ≡ `ChartBuilderPage.tsx:25-31`; variants in `MarketLookupPage.tsx:38-47` ⊃ `WatchlistChartDialog.tsx:28-34`) → `lib/research/ranges.ts`.
- `research-search` query + debounce plumbing ×3 (`ResearchHomePage.tsx:49-54`, `ChartBuilderPage.tsx:118-123`, `ResearchComparePage.tsx:206-211`) → `useSymbolSearch()`.
- Segmented range/option button groups ×6 (`ResearchComparePage.tsx:390-402`, `ChartBuilderPage.tsx:391-396, 408-412`, `MarketLookupPage.tsx:427-439`, `PortfolioForecastPage.tsx:108-118, 186-198`) → `<SegmentedButtons>`.
- 30-item `CURRENCIES` array duplicated verbatim (`AddAccountDialog.tsx:37-41` ≡ `GeneralSection.tsx:9-13`) + 5 inline subsets → `SUPPORTED_CURRENCIES` in `utils/currency.ts` (adding a currency currently means finding 7 lists).
- `AddInvestmentDialog.tsx:182` re-inlines `AssetTypeSelector.tsx:17-21`'s `defaultProviderFor` ternary → export it.
- `OpeningBalanceDialog.tsx:64-69` and `ReconcileDialog.tsx:51-56` hand-copy the account-derived invalidation set; `hooks/useAccounts.ts:17-21` `invalidateAccountDerived` exists but isn't exported → export and use.

### SIMP-79 — Small JSX/logic collapses — ~150 lines

- `admin/ExchangeRatesPage.tsx:138-178` three summary cards → config map; also its `RatesTable` is defined inside the render body (remount churn) — hoist.
- `admin/ProviderHealthPage.tsx:184-190` ≡ `admin/EndpointLivenessPage.tsx:106-112` skeleton grids → shared `TableSkeleton`.
- `CommandPalette.tsx:411-452` four identical nav-group `.map` blocks → sections array.
- `InvestmentDetailDialog.tsx:520-528, 536-543, 640-648` same add-transaction ternary ×3 → compute once.
- `OnboardingWizard.tsx:351-364` vs `:390-397` success block ×2 → local `StepSuccess`.
- `CsvColumnMapper.tsx:57-80` vs `PortfolioCsvColumnMapper.tsx:104-126`: the `hasHeaders ? <ColumnSelect> : <Input>` branch ×2, already drifting on required-`*` placement.
- `lib/belgianTax/portfolioTax.ts:60-72` vs `:75-87` (`recordedTaxesForYear`/`recordedFeesForYear` identical modulo field); `lib/belgianTax/pit.ts:531-542` four copy-pasted bracket-row spreads → `table.brackets.map`.
- Account form mapping ×3 (`AddAccountDialog.tsx:147-162`, `AccountsPage.tsx:92-109, 297-314` — 14 fields each) → `toAccountPayload()`/`accountToFormValues()` keeping the null-vs-undefined PATCH semantics in one commented place.
- `SelectSettingRow` (#92) is local to `GeneralSection.tsx:40-51` while `BehaviorSection.tsx:53-77`/`AppearanceSection` still hand-roll the same stack → hoist to `SettingsPrimitives`.

---

## Round 4 — backend service batch (SIMP-80)

### SIMP-80 — SSE, report KPI cards, plannedTxRepo, rateFetcher — ~140–150 lines + two drift hazards

- **SSE:** the identical 6-line `res.writeHead(200, {text/event-stream, …})` block precedes `createSseWriter` at `importRoutes.js:220-226`, `portfolioImportRoutes.js:190-196`, `ai.js:295-300` → fold into `createSseWriter` (lib/sse.js already owns flushHeaders/heartbeat). The stream-import handler skeleton (`importRoutes.js:209-273` vs `portfolioImportRoutes.js:180-247`, ~35 lines each) has **already drifted**: the portfolio copy surfaces `ValidationError.message` in the SSE error event; the transactions copy always emits generic `'Import failed'` — a live UX gap a shared `streamImport()` helper would back-port. ~45 lines.
- **Report KPI cards:** the KPI-card HTML block is hand-rolled in 5+ report sections with 3 divergent local renderers (`executiveSummary.js:39-60`; `portfolioExecutiveSummary.js:51-73` — pasted *twice in one file*, already drifted on `kpi-sub`; `plannedOutlook.js:42-58`; `rollingAverages.js:52-74`; `taxExecutiveSummary.js:67-100`) → `kpiCard()`/`kpiGrid()` in `sectionHelpers.js`. Side benefit: escaping is currently inconsistent (one section escapes values, one escapes labels but not values, one escapes nothing). ~60–70 lines; PDF snapshot check advised.
- **`plannedTransactionRepository.js:419-440` vs `:478-505`:** the "apply SET clauses → `setPlannedTransactionTags`" transaction body is copy-identical (~20 lines) between `update()` and `updateWithLoanSchedule()` → extract or delegate.
- **`rateFetcher.js:380-403` vs `:410-425`:** identical EUR-shortcut + binary-search loop, differing only in post-loop resolution (nearest vs floor) → shared `searchIndex()`. ~15 lines.

---

## Round 4 — tests & e2e (SIMP-81, 82)

### SIMP-81 — Test-suite dedup round 2 — ~530–610 test lines

Post-#92 helper adoption is largely healthy (25 files on `routeHarness`, `queryWrapper` adoption complete but one file), but:

- **Transactions route-test family:** 6 files (`routes/transactions*.test.js` ×5 + `transactionPatchValidation.test.js`) each carry a ~45–70-line near-identical `vi.mock` preamble (repository, deduplication, logger, transferReconciliation, currencyConversion, connection incl. a 15-line BEGIN/COMMIT `withTransaction` ceremony ×3, attachments, export, bulkSelection) → `tests/helpers/transactionsRouteMocks.js` with `mock*`-prefixed factories (vitest-hoisting-safe; `mockLogger` proves the pattern). ~200 lines.
- **The missing `repoMocks`:** `withTransaction`/connection mocks are re-implemented in **17 files** (5 observed variants of transaction semantics) and the inline logger object survives in **23 files** despite `mockLogger()` → add `mockConnection()`/`mockTxConnection()` helpers; sweep the logger sites. ~120–150 lines.
- **`contracts.test.ts`:** #92 converted only the first block to `it.each`; E4 (:400-620) and both Phase F1 blocks (:624-1180) remain ~50 tests of identical 5-line ceremony with the path duplicated 2–3× per test → extend the existing table style. ~150–200 lines.
- **Re-inlined sites added after #92** (~10 files, ~60 lines): inline loggers in `dataFetcherFinancial.test.js`, `portfolioImportValidateFutureDate.test.js`; inline `withTransaction` in `openingBalanceService.test.js`, `reconcileService.test.js`; inline QueryClient wrapper in `usePlannedPayments.test.ts:12-13`; never-converted stubs in `main.test.js`, `transactionPatchValidation.test.js`, `settingsStorage.test.js`, `rateLimiter.test.js`, `validation.test.js`.

### SIMP-82 — E2E: `smoke.spec.ts` is subsumed; create-flows duplicated — ~80–100 lines

- `smoke.spec.ts` (53 lines) is ~90% subsumed by `a11y.spec.ts` + `pages.ts` running in the same `test:e2e` invocation (same goto+heading+axe, stricter gate, 4 of its 5 pages already in `PAGES`); heading regexes are now maintained in **three** places (`pages.ts:16`, `smoke.spec.ts:26`, `critical-flows.spec.ts:19`). **Fix:** add an Import entry to `PAGES`, delete `smoke.spec.ts`. Optionally loop `visual.spec.ts`'s 5 identical blocks.
- The create-category/create-recipient steps in `critical-flows.spec.ts:50-77` are a byte-equivalent subset of `mutations-parity.spec.ts:21-70` (which also tracks pageerrors and cleans up) → delete the two critical-flows tests or share `createCategory()`/`createRecipient()` helpers.

---

## Round 4 — electron & CI infra (SIMP-83, 84)

### SIMP-83 — Electron IPC boilerplate + builder-config re-declaration — ~55–75 lines

- The sender guard `if (!mainWindow || event.sender !== mainWindow.webContents)` appears at `main.js:3235, 3302, 3336, 3401, 3463, 3660, 3681, 3689` with **three divergent return shapes**; uniform try/catch→`{success:false, error}` shells ×7; `workDir not set` precondition ×3 → `registerHandler(channel, fn, { requireMainSender, requireWorkDir })`. Migrate only the uniform handlers — return shapes are load-bearing for `electron.ts`. Medium risk.
- `electron-builder-demo.json:1-28` re-declares the `package.json` `build` block (identical `mac`/`files`/`extraResources`; only appId/productName/output differ) → electron-builder `extends` + ~5 overrides; verify with a `dist-demo` build.

### SIMP-84 — CI compose bring-up ×3 + no-op compose logging blocks — ~40–50 lines

- `.github/workflows/ci.yml:449-500` (`docker-verify`) vs `:522-569` (`test-live-api-contracts`) duplicate verbatim the artifact-download + `docker load` + stub-`.env` + `compose up -d` + 30-attempt `/health` loop + `down -v`; near-copy again in `e2e.yml:49-81` → composite action `.github/actions/compose-up` (the repo already proved the pattern with `.github/actions/setup`).
- `docker-compose.dev.yml:19-23` and `docker-compose.clean.yml:16-20, 28-32` carry exact copies of the base's `logging:` blocks, which Compose merge already supplies (overlays never run standalone) → delete; verify with `docker compose config` before/after.

---

## Round 4 non-findings — checked, deliberately left alone

- **No regrown dead i18n keys:** `validate-locales.js` (with SIMP-47's unused-key pass) runs clean at HEAD.
- **Zero dead scripts:** every file in `scripts/` and `apps/node-backend/scripts/` is referenced from package scripts, hooks, workflows, or docs.
- **API surface still in sync:** all 213 OpenAPI operations register (parser-config ops via `registerParserRoutes`); no route/spec drift.
- **Frontend routing complete:** all 60 pages registered in `routePreload.ts`; zero orphaned pages; all 32 remaining `components/ui/*` files have real importers.
- **Backend lib/ is healthy:** every export of `lib/*` (sqlClauses, pagination, sse, dateFormat, timezone, urlSafety, fileSniff, parserConfigRoutes, …) verified to have production callers — the only stragglers are the *call sites* (SIMP-68/70/71), not the helpers.
- **Backend date handling is correctly hand-rolled** (date-fns is not a backend dep; `lib/timezone.js` uses `Intl.formatToParts` per ADR); `useCountUp`'s rAF logic carries hard-won fixes (moot if SIMP-59 deletes it); `utils/sanitize.ts`'s design was fine — it's just unused; `middleware/validation.js` zod migration is an architectural project, deliberately not filed.
- **Not extractable:** importPipeline vs portfolioImportPipeline validate/commit skeletons (column sets diverge enough), bank CSV adapters (already share `_shared.js`), reconcileService vs transferReconciliationService (different domains), aiChat tool `run({maxRows})` repetition (uniform registry contract), infoRepo test preambles (intentional per-file variation), `ForecastInner` twins (re-confirmed round 3 verdict).
- **Electron IPC channels:** all 22 registered channels have preload invokers and vice versa — the only orphan is SIMP-64's `electronServices`.
- **Workflows:** `.github/actions/setup` adopted by every Bun job; no dead inputs; release↔CI duplication and the `VISION_IMAGE` no-op are already filed in TODO.md.
- **`@types/d3-sankey` in runtime deps** — cosmetic misplacement, already noted in TODO.md.

---

## Round 4 suggested sequencing

1. **PR: dead code batch 1 (frontend)** — SIMP-59, 60 (members first, then the 22 safe backing functions), 61. ~660 lines, zero-to-low risk.
2. **PR: dead code batch 2 (backend/shared/electron/config)** — SIMP-62, 63, 64 + SIMP-65's config/env/compose items. ~330 lines.
3. **PR: deps & overrides** — SIMP-65's package.json items + SIMP-66 version-drift alignment (typescript declarations to `^6.0.3`, vite override reconciliation). Lockfile-touching; run full CI.
4. **PR: helper-adoption sweep** — SIMP-67 (with the RebalancePage locale fix called out in the changelog), 68, 70, 71; SIMP-69 as adopt-or-delete decision. Mechanical, high drift-risk payoff.
5. **PR: zod settings validators** — SIMP-72, updating the message-coupled tests in the same PR.
6. **PR: portfolio dialog stragglers** — SIMP-76 (fixes the untranslated type dropdown), then SIMP-75 (decide full delegator vs minimal extraction).
7. **PR: frontend collapse batch** — SIMP-77, 78, 79 in 2–3 slices.
8. **PR: backend service batch** — SIMP-80 (back-ports the SSE error-detail fix; PDF snapshot check for the KPI cards).
9. **PR: test dedup round 2** — SIMP-81 (helpers first, then the sweeps), SIMP-82. Coverage-neutral.
10. **PR: infra** — SIMP-83 (conservative handler migration), 84; SIMP-73/74 as judgment-call PRs (SIMP-74's fetch swap doubles as the redirect bugfix).

When a finding lands, update its ledger row to `FIXED (<PR #>)` in the same PR.
