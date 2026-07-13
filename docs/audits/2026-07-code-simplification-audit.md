# Code Simplification Audit — July 2026

**Audited at:** `1e494de` (2026-07-13)
**Scope:** All hand-written source — `apps/frontend/src`, `apps/node-backend/src`, `packages/*`, `scripts/`, root shell scripts, and compose files (~200k LOC total; tests, codegen output, and locales excluded).
**Method:** Four parallel dimension sweeps (backend, frontend components/hooks, frontend pages/lib/contexts, scripts & cross-app duplication) hunting for "100 lines where 1 would do": dead code, hand-rolled reimplementations of existing dependencies, copy-pasted scaffolding, and boilerplate replaceable by a config-driven loop. Every finding below was verified by reading the code at HEAD; the highest-impact claims (dead-code reachability, byte-identical duplicates, dependency availability) were independently re-verified with grep. Read-only — no code was changed.

---

## Overall assessment

The codebase is healthier than a bloat audit usually finds. Routes use a central error handler (no repeated `try/catch + res.status(500)`), big switch chains have already been turned into lookup registries, money math is centralized in `@vision/shared-utils` with Decimal.js, react-query is used consistently (no hand-rolled fetch state machines), and the money/slugify/downsample/portfolio-math utilities are already properly shared between apps.

The dominant smell is **not** clever over-abstraction — it is **unfinished deduplication**: abstractions that exist but aren't used everywhere (shared currency-formatter hooks bypassed by inline `Intl.NumberFormat` copies; `date-fns` installed but re-implemented by hand), and large stateful scaffolding that was copy-pasted instead of extracted (three visx charts each carrying the same ~150-line scale/hover/tooltip machine; `DataTable` being a frozen copy of `VirtualDataTable`'s state machine; two repositories carrying byte-identical inheritance-table helpers). On top of that sits ~1,150 lines of provably dead code that can simply be deleted.

**Realistically removable: ~2,300–2,900 lines** with no behavior change, of which ~1,150 are zero-risk deletions.

| Tier | Theme | Est. lines removed | Risk |
| --- | --- | --- | --- |
| 1 | Delete dead code | ~1,150 | None (verified unreferenced) |
| 2 | Use what already exists (date-fns, shared hooks, shared-utils) | ~450–700 | Low |
| 3 | Extract shared scaffolding (charts, repos, tax pages) | ~700–900 | Low–medium |
| 4 | Careful refactors (money math, load-bearing tooling) | ~170 | Medium — do under existing tests |

---

## Tier 1 — Delete: verified dead code (~1,150 lines, zero risk)

### 1.1 `scripts/locales-capitalizer.js` + committed report — ~607 lines

`scripts/locales-capitalizer.js` (213 lines) hand-rolls a line-by-line quote/escape string parser (`parseAndTransform`, lines 103–180) to title-case locale values, writes `*.capitalized.tmp` files that are never applied, and dumps `scripts/locales-capitalizer-report.json` (394 lines) which is checked into the repo. Referenced by **no** `package.json` script, workflow, git hook, or `docs/reference/scripts.md` — only by `TODO.md`, which itself flags it as dead (line ~3993).

**Fix:** delete both files.

### 1.2 `scripts/auto-translate-nl.js` + `auto-translate-nl-pass2.js` — ~242 lines

Two one-shot migration scripts (174 + 68 lines) holding hardcoded `{key: "Dutch string"}` maps that were written into `i18n/source/nl.json` once. They duplicate each other — both hardcode the same `tax.suggestions.*` keys with *different* Dutch values (pass2 silently overrides pass1). Unreferenced anywhere; superseded by the live `sync-nl` workflow (`scripts/sync-nl-with-en.js`, which is fine and stays).

**Fix:** delete both files.

### 1.3 `apps/frontend/src/pages/RecipientInsightsPage.tsx` — orphaned page, ~302 lines (+ its test)

Not referenced in `App.tsx`, `lib/routePreload.ts`, or any component — the only importers are its own integration test and a `LanguageSwitch` test. Its functionality is superseded by `components/statistics/RecipientInsightsTab.tsx`, which is what `StatisticsPage` actually renders. It even carries its own re-implemented `formatCurrency` (lines 35–40).

**Fix:** delete the page and `pages/__tests__/RecipientInsightsPage.integration.test.tsx`; update the `LanguageSwitch` test to target a live page.

---

## Tier 2 — Use what already exists (~450–700 lines, low risk)

### 2.1 `DataTable.tsx` is a frozen copy of `VirtualDataTable.tsx`'s state machine — ~200–611 lines

`components/shared/DataTable.tsx` (611 lines) and `VirtualDataTable.tsx` (843 lines) contain byte-identical helpers and logic: `getSortValue`, `IndexedRow`, the asc→desc→null `handleSort` cycle, `setColumnFilter`/`activeFilterCount`, the lazy `openFilterUniqueValues` scan, the filter+search+sort `processedRows` pipeline, `startEditing`/`cancelEditing`/`saveEditing`, and the `SortIcon` sub-component (DataTable 178–304 vs VirtualDataTable 289–489). `VirtualDataTable` is a strict superset (adds virtualization, context menus, keyboard nav). `DataTable` has exactly **one** consumer: `pages/DashboardPage.tsx:9`.

**Fix (preferred):** migrate `DashboardPage` to `VirtualDataTable` and delete `DataTable.tsx` (−611 lines). **Fallback:** extract a shared `useDataTableState()` hook (−~200 lines).

### 2.2 `components/shared/dateUtils.ts` reimplements date-fns — ~80–120 lines

`date-fns@^4.3.0` is already a frontend dependency, yet `dateUtils.ts` (193 lines) hand-rolls `formatDate` as a 14-case pattern switch (lines 5–40), plus `parseISO` (42–50), `differenceInDays` (52–56), and `formatDistanceToNow` (58–69) — all direct date-fns exports. Ironically, `appDateFormatToDateFnsPattern` (86–95) already converts app formats to date-fns pattern strings, then feeds them to the custom formatter instead of date-fns `format()`. The layered `formatMonthYearWithAppSettings` / `formatDateStringWithAppSettings` switches (101–153) collapse similarly once the base is swapped.

**Fix:** delete the custom implementations and call date-fns directly. (The file's comment cites Intl construction cost, but date-fns `format` doesn't use Intl for these patterns.)

### 2.3 Inline `formatCurrency` copies bypass the existing shared hooks — ~75 lines across 8 files

`hooks/useCurrencyFormatter.ts` and `hooks/useChartCurrencyFormatter.ts` already provide cached `Intl.NumberFormat` formatting, and pages like `StocksPage`, `CryptoPage`, `SavingsPage`, `PortfolioOverviewPage`, and `AccountsPage` use them correctly. But eight files re-declare a local `formatCurrency`/`fmt` with `new Intl.NumberFormat(locale, {style:'currency', …})`:

- `components/statistics/RecipientInsightsTab.tsx:56` (even re-implements the hook's per-formatter caching)
- `components/statistics/CustomChart.tsx:78`
- `components/statistics/CustomChartBuilderModal.tsx:89`
- `pages/TaxOverviewPage.tsx:89–96`
- `pages/portfolio/tax/PortfolioTaxPage.tsx:107–114`
- `pages/RealEstatePage.tsx:31–41` (plus a local `fmtNum`)
- `pages/NetWorthPage.tsx:95–102`
- `pages/RecipientInsightsPage.tsx:35` (dies with Tier 1.3)

**Fix:** `const { formatCurrency } = useChartCurrencyFormatter()` / `useCurrencyFormatter(targetCurrency)` in each. Also removes drift risk when number-format settings change.

### 2.4 Small utilities defined 2–4 times each — ~70 lines

| Utility | Copies | Fix |
| --- | --- | --- |
| `fmtLargeNum` (1e12/1e9/1e6 → T/B/M) | `pages/research/ResearchComparePage.tsx:181`, `pages/research/MarketLookupPage.tsx:144`, `components/research/ResearchFundamentalsTab.tsx:77` — byte-identical | one `formatCompactNumber` in `utils/` |
| `toYmd` (pg Date → `YYYY-MM-DD`) | `node-backend/src/utils/portfolioMath.js:97`, `node-backend/src/services/plannedMatchService.js:33`, `frontend/src/components/shared/dateUtils.ts:79` | export once from shared-utils |
| `prefersReducedMotion()` | `hooks/useCountUp.ts:29`, `components/shared/RollingNumber.tsx:6`, `components/layout/ShaderAurora.tsx`, `contexts/ThemeContext.tsx` | one util (framer-motion's `useReducedMotion` already used in charts) |
| CSV escaping (`neutralizeCsvFormula`/`escapeCsvValue`) | `frontend/src/lib/csv.ts` + `node-backend/src/lib/csv.js` — the frontend header comment admits it's a mirror | move to `packages/shared-utils/src/csv.js`, re-export both sides like `money`/`slugify` |
| `ASSET_CLASSES` ordered array | `frontend/src/utils/assetClass.ts:5` + `node-backend/src/lib/assetClasses.js:6` — must stay in lockstep with `TRANSACTION_TABLE_BY_ASSET_CLASS` | single const in shared-utils (silent-drift hazard, not just line count) |
| local `formatDate` shadowing the shared helper | `pages/ImportReviewPage.tsx:81` | import from `dateUtils` |

---

## Tier 3 — Extract shared scaffolding (~700–900 lines, low–medium risk)

### 3.1 Three visx charts each hand-roll the same chart frame — ~300–400 lines

`components/charts/AreaChart.tsx` (566), `LineChart.tsx` (483), and `ComposedChart.tsx` (353) each duplicate the full block: `xScale`/`yScale` `useMemo` (domain padding + `nice`), `bisector` setup, hover-index state, `indexAtClientX`/move/leave/down/up handlers, the cross-chart `syncedIndex` nearest-point loop, the `tooltipItems` builder, grid-line map, axis block, scrub-range band, hover-capture `<rect>`, and scrub-delta pill. AreaChart ~125–283 and LineChart ~100–234 are near-verbatim copies (only variable-name drift: `hoverIndex` vs `hoverIdx`); ComposedChart ~92–171 repeats the scale/hover/tooltip subset.

**Fix:** one `useCartesianChartFrame(props)` hook returning `{xScale, yScale, hoverDatum, handlers, tooltipItems}` plus a `<ChartFrame>` wrapper for grid/axes/capture-rect/scrub/tooltip; each chart keeps only its series rendering.

### 3.2 Inheritance-table CRUD duplicated across two repositories — ~150–180 lines

`node-backend/src/repositories/investmentRepository.js` (~37–335) and `portfolioTxRepo.common.js` (~37–466) independently implement the same helper set for the Postgres inheritance/view schema: `isNonUpdatable…ViewError`, `isMissingInheritanceRelationError`, `isDuplicate…IdError`, `resync…BaseIdSequence`, `buildUpdateSql`, and `create/update/hardDeleteThroughInheritanceTables`. `buildUpdateSql` is **byte-for-byte identical** in both files (investmentRepository 144–163 vs portfolioTxRepo.common 316–335 — re-verified). The three `…ThroughInheritanceTables` functions differ only in table-name constants and the child-field map.

**Fix:** a `makeInheritanceRepo({ baseTable, tableByAssetClass, baseFields, childFieldsByClass })` factory module — or at minimum share `buildUpdateSql`, the error classifiers, and the sequence-resync helper.

### 3.3 Dynamic SET/INSERT clause builder reinvented in ~10 repositories — ~60–80 lines

The `for (const [key, value] of Object.entries(fields)) { if (allowed…) { setClauses.push(…$${i++}); params.push(value); } }` idiom appears at 23 push-sites across 10 files: `plannedTransactionRepository.js` (405, 515, 667), `investmentRepository.js` (149, 553), `portfolioTxRepo.common.js` (321), `accountRepository.js` (74, 94 — near-identical INSERT and UPDATE variants back-to-back), `transactionRepository.js` (479), `watchlistRepository.js` (85), plus the category/recipient/tag repos.

**Fix:** shared `buildSetClauses(fields, { allowed, startIdx })` / `buildInsert(fields, { allowed })` in `node-backend/src/lib/`.

### 3.4 `plannedTransactionRepository.js` — one SELECT spelled out five times — ~65 lines

The identical `SELECT pt.*, r.name AS recipient_name, CASE … END AS category_name FROM planned_transactions pt LEFT JOIN …` block appears in `getAll` (117–134), `getById` (256–269), `update` (436–454), `getDueSoon` (561–578), and `getForForecast` (592–610). Separately, the executions + loan_schedule + tags hydration is duplicated verbatim between `getById` (274–303) and `update` (460–489), ~30 lines each.

**Fix:** a `PLANNED_SELECT` const and a `hydratePlannedRow(row)` helper.

### 3.5 `investmentRepository.create()` — same 21-field list spelled out four times — ~40 lines

`create` (417–519) and `createThroughInheritanceTables` (193–324) re-list the same ~21 provider/price fields as `modernValues`, `legacyValues`, `baseValues`, and `legacyBaseValues`; `investmentController.createInvestment` (204–251) destructures the identical set a fifth time just to re-assemble the same object.

**Fix:** an `INVESTMENT_FIELDS` constant array driving column list + placeholder generation; pass a picked subset of `req.body` through.

### 3.6 Belgian tax pages — repeated cards, reducers, and form fields — ~180 lines

- **`ProfileInputsCard` duplicated:** `TaxOverviewPage.tsx` 600–670 and `PortfolioTaxPage.tsx` 498–533 render the same label/value rows over the same `profile`/`calculation` shape; six rows are byte-identical. → one `<TaxProfileInputsCard>` driven by a `{labelKey, value}[]` array (~50 lines).
- **`PortfolioTaxPage.tsx` 626–699:** four dividend metric tiles + four `rounded-lg border p-3` estimate cards (TOB recorded/auto, TACR, CGT, Reynders) differ only in `{title, badge, description, value, visibleWhen}` → config array + `.map` (~35 lines).
- **`PortfolioTaxPage.tsx` 144–199:** `taxBreakdown` and `feeBreakdown` are the same ~28-line reducer twice, differing only in the field read (`taxes` vs `fees`) and category labels → one parameterized `bucketTxnCosts(field, categoryMap)` (~25 lines).
- **`TaxOverviewPage.tsx`:** identical income-sources empty state at 558–577 and 685–704 → one component (~20 lines).
- **`components/tax/profile-steps/IncomeStep.tsx`:** the label + description + number-`Input` block repeats ~6×, and the Flanders/Wallonia/Brussels `<Select>` is inlined twice (157–168, 234–248) and again in `RegionStep`/`EmploymentStep` → a `NumberField` component driven by a config array + a shared `<RegionSelect>` (~50–70 lines). `ExemptionsStep.tsx`'s three `[0..5].map` dependent-count selects collapse the same way (~30 lines).

### 3.7 Smaller backend extractions — ~85 lines

- **`services/reports/index.js`:** `buildFinancialBody` (478–495), `buildPortfolioBody` (501–518), `buildTaxBody` (524–541) are the same ~18-line function with different renderer maps/defaults/fetchers; the "no sections selected" placeholder HTML is triplicated → one `buildBody({...})` (~30 lines).
- **`repositories/splitRepository.js`:** `createSplitAtomic` (80–113) and `createSplitsBatchAtomic` (120–164) open with the identical `FOR UPDATE` lock + totals query, which also appears a third time in `getTransactionSplitTotals` (46–53) → `lockAndGetTotals(client, transactionId)` (~18 lines).
- **Row formatters:** `routes/transactions.js` `formatTransaction` (653–678) and `splitRepository.js` `formatSplit` (490–503) are long field-by-field copies whose only work is `toNumber(toDecimal(x))` — an idiom appearing **55 times across 15 files**. `lib/money.js` already exports `coerceNumericFields` (used by exactly one caller) → route the formatters through it (~20 lines).
- **`contexts/BelgianTaxProfileContext.tsx` 229–321:** three ~16-line debounced-persist `useEffect` blocks (profile/snapshots/metas) with three `isFirst*Render` refs and three timer refs, identical except key + state var → `useDebouncedSetting(key, value, isLoading)` (~40 lines).
- **`install.sh` / `install-demo.sh`:** the Docker-daemon wait loop, the "find built `.app`" candidate scan, and the remove/`cp -r`/`xattr -cr` install block are each duplicated between the two installers → a sourced `scripts/lib/mac-install.sh` (~40 lines, mainly a drift-risk fix).

---

## Tier 4 — Do carefully (money math & load-bearing tooling, ~170 lines)

### 4.1 `packages/shared-utils/src/portfolio.js` — FIFO and LIFO calculators are near-twins — ~90 lines

`calculateCostBasisFIFO` (191–283) and `calculateCostBasisLIFO` (293–385) are ~95 lines each and differ **only** in which lot is consumed (`lots[0]` + `lots.slice(1)` vs `lots[lots.length-1]` + `lots.slice(0, -1)`). The per-txn field-parse block and the 12-field result object are repeated a third time in `calculateCostBasis`.

**Fix:** one `calculateCostBasisLotBased(txns, opts, { fromEnd })` with the lot pointer parameterized, plus a shared result builder. **This is golden-fixture-covered money math — refactor only under the existing fixtures, in its own PR.**

### 4.2 `scripts/validate-locales.js` — hand-rolled JS lexer — ~80 lines

Lines 204–311 implement a from-scratch tokenizer (`blankComments`, `readStringLiteral`, `readArgs`, `objectKeys`, `walkSources`) purely to find `t()`/`tc()` call sites in `.ts/.tsx` source. The workspace already depends on `typescript`.

**Fix:** a ~20-line `ts.createSourceFile` + `CallExpression` visitor. This is load-bearing CI tooling that currently works — the win is robustness (real string/template/JSX handling) more than line count; do it with a before/after diff of extracted keys.

---

## Non-findings — checked and deliberately left alone

These were flagged as suspects by size and verified **fine**; don't spend refactor budget here:

- **`pages/research/MarketOverviewPage.tsx` (1,111 lines)** — ~850 lines are irreducible static `REGION_VIEWS`/`SECTOR_VIEWS` symbol-universe data; the rendering is already config-driven (`ToggleCluster` + `renderGrid`).
- **`styles/themes.ts` (614 lines)** — five genuinely distinct hand-tuned HSL palettes, already applied via a `TOKEN_KEYS` loop. Not compressible from a smaller table.
- **`contexts/BelgianTaxProfileContext.tsx`** overall — a real 25-method state/persistence manager; only the debounce triplication (3.7) is bloat.
- **`docker-compose.{yml,dev.yml,clean.yml}`** — already a correct base+override split; anchors wouldn't help (they don't cross files).
- **Backend error handling & switch chains** — routes consistently throw typed errors into a central handler; big switches are already lookup registries.
- **`packages/shared-utils`** as an institution — `money`, `slugify`, `downsample`, and portfolio math are already single-sourced and re-exported by both apps; Tier 2.4 just finishes the job for the stragglers (CSV, `ASSET_CLASSES`, `toYmd`).
- **`scripts/sync-nl-with-en.js`, `generate-locales.js`, `docker-entrypoint.sh`, `setup-git-hooks.js`** — lean and referenced; the `normalizeString` typographic normalizer is purpose-built, not replaceable by a stock library.

---

## Suggested sequencing

1. **PR: dead code deletion** (Tier 1) — ~1,150 lines, zero behavioral risk, immediate.
2. **PR: formatting stragglers** (2.2, 2.3, 2.4) — mechanical swaps to existing hooks/deps; verify with `bun run test:frontend` + visual e2e.
3. **PR: kill `DataTable`** (2.1) — migrate `DashboardPage` to `VirtualDataTable`, delete the copy.
4. **PR per backend extraction** (3.2–3.5, 3.7) — small, each independently testable against the existing route/repo tests.
5. **PR: chart frame extraction** (3.1) — the largest single win; do it after the visual-regression e2e suite is green so scrub/hover/sync behavior is pinned.
6. **PR: tax page dedup** (3.6) — UI-only, config-driven rewrites.
7. **Last, separately: cost-basis merge** (4.1) under golden fixtures, and the locale-lexer swap (4.2) with a key-extraction diff.
