# Package-adoption audit (2026-07)

Third round in the simplification series, following the code-simplification audit
(PR #103, SIMP-48/59–84) and the zod migration (PR #103, ZOD-01–12). Question
answered here: **which already-installed packages could be used more widely to
delete hand-rolled code without changing behavior or weakening any constraint —
and which installed packages should be removed instead?**

This document is the complete analysis. It is written so that an agent with no
prior context can pick up any OPEN row, implement it with the established
method, and flip the row — exactly like the two previous rounds.

## Method (identical to the zod migration)

1. **Pin-then-swap.** Before changing a unit, write regression tests that pin
   the OLD behavior (outputs, rendered strings, numeric results, loading/error
   sequencing) and pass against the old code. Then swap; the pins must stay
   green. Accept/produce sets must be identical by construction.
2. **No new dependencies.** Only wider use of packages already in a
   `package.json` (or Node builtins). Removing an unused dependency counts as a
   win.
3. **No invariant weakening.** Anything on the DO-NOT-MIGRATE list stays
   hand-rolled — each entry documents a deliberate semantic difference from the
   lookalike package API. Do not "fix" those differences.
4. **Gates green before each commit:** `bun run typecheck && bun run lint &&
   bun run test && bun run test:frontend && node scripts/validate-locales.js`
   plus backend `cd apps/node-backend && bunx tsc -p tsconfig.check.json`
   (the root typecheck covers only the frontend — this bites; see the zod
   round's savedCharts.js incident).
5. Flip a ledger row to `DONE (#<pr>)` in the same commit that lands the unit.
   Resume by grepping this file for `OPEN`.

## How this audit was produced

Three parallel read-only research passes over the tree at commit `f1a30c6`
(post-#103 main): backend (`apps/node-backend`, `packages/*`), frontend
utilities, and frontend data-layer architecture. Headline claims were
spot-verified by direct grep (date-fns imports: 0; template-literal className
sites: 109; backend async wrappers: 0). Overall verdict: **the codebase has
already absorbed most opportunities of this kind.** Express 5's native
async-error forwarding is already relied on (no wrapper boilerplate exists
anywhere), csv-parse already powers the backend import tokenizer
(`importPipeline/adapters/_shared.js`), decimal.js already flows through
`@vision/shared-utils/money` for all stored money, the zustand consolidation of
the settings contexts already happened (`stores/settingsStore.ts:1-16`), radix
primitives and react-virtual are used everywhere they apply, and msw is the
established test pattern (the 3 `vi.stubGlobal('fetch')` files are SSE/blob
tests where msw doesn't fit). What remains is the short list below.

---

## Tier 1 — clean wins (no behavior change; same bar as the zod round)

| ID | Unit | Detail | Status |
|----|------|--------|--------|
| PKG-01 | `cn()` adoption sweep | 109 template-literal `className={` sites in 51 frontend files bypass the existing `cn()` (clsx+tailwind-merge, `lib/utils.ts:4`, already used in 101 files). Highest-density: `components/layout/AppSidebar.tsx` (8), `pages/portfolio/PerformancePage.tsx` (8), `components/statistics/CategoryPivotTable.tsx` (6), `pages/RecipientsPage.tsx` (5), `features/imports/CsvDropzone.tsx`, `components/dashboard/NetSummaryCard.tsx`, `features/transactions/components/TransactionsTable.tsx`, `pages/admin/TableDataEditorPage.tsx`, `components/onboarding/RestoreFromBackupCard.tsx`, `components/shared/VirtualDataTable.tsx`, `components/portfolio/PerformanceBreakdown.tsx` (4 each). CAVEAT: `twMerge` dedupes conflicting Tailwind utilities last-wins where a template literal keeps both — spot-check each converted site for deliberately conflicting utilities (e.g. duplicated `px-*`) before flipping; the common conditional tone/opacity appends are identical. | OPEN |
| PKG-02 | `ImportHistoryCard` → react-query | `features/imports/ImportHistoryCard.tsx:185-209` hand-rolls `batches/total/offset/loading` state + `load` callback + refresh-key effect. Replace with `useQuery({ queryKey: ['importBatches', offset], placeholderData: keepPreviousData })`; replace both refresh keys with `invalidateQueries`. ~30→10 LOC. Pins: first-load-only spinner gating (`loading && batches.length === 0` → `isLoading`), header refresh spinner → `isFetching`, error toast on every failed load (line 202) must survive via an `isError` effect. | OPEN |
| PKG-03 | `OnboardingWizard` parser-fetch dedup | `components/onboarding/OnboardingWizard.tsx:176-190` re-implements a fetch for which a query hook already exists: `features/imports/useAdapters.ts:13-21` wraps the identical `apiClient.getSupportedParsers()` call. Straight duplication — swap to `useAdapters()`. ~15→3 LOC. Zero-risk. | DONE (#105) |
| PKG-04 | d3-array `sum` in chart data prep | `components/charts/AreaChart.tsx:288,291` and `components/charts/StackedBarChart.tsx:185`: `series.reduce((s, x) => s + (x.accessor(d) ?? 0), 0)` → `sum(series, s => s.accessor(d) ?? 0)`. The `?? 0` already guarantees numbers, so order and float result are identical. d3-array is already a dependency and already imported in these areas. | OPEN |
| PKG-05 | d3-array `min`/`max` for chart domains | `AreaChart.tsx:274,309,310` (file already imports `min, max` from d3-array at line 19 and doesn't use them here), `LineChart.tsx:200,224,225`, `ComposedChart.tsx:263,283,284`, `Sparkline.tsx:59,60`. `Math.min(...arr)` returns NaN if any element is NaN and can overflow the stack on very large arrays; d3 `min` SKIPS NaN/null and returns `undefined` on empty. **Only swap where the input array is provably finite** (verify each source); on gappy data the rendered domain would change — that site then belongs to the do-not list. Where safe, the swap also fixes the latent spread-size hazard. Do NOT touch `BarChart.tsx:338` (`Math.max(0, ...)` — the 0 floor is intentional; see do-not list). | OPEN |
| PKG-06 | Backend sleeps → `node:timers/promises` | `services/belgianInflationService.js:39` (delete the hand-rolled `sleep` helper), `database/connection.js:122`, `main.js:521`. `import { setTimeout as sleep } from 'node:timers/promises'` is a drop-in; none of the three sites use the resolve value. The only zero-risk backend finding in this audit. IMPLEMENTATION FINDING: only `main.js` was swapped. The other two sites are pinned by `vi.useFakeTimers()` tests (`belgianInflationService.test.js` throttle test, `connection.test.js` retry backoff) and fake timers patch the global `setTimeout` but CANNOT fake `node:timers/promises` — the swap makes those tests wait real time and time out. Verified empirically; both sites keep the global-setTimeout sleep with an explanatory comment. | DONE (#105) |
| PKG-07 | `parseISO` shim → date-fns `parseISO` | `components/shared/dateUtils.ts:42-50` hand-rolls date-only→local-midnight parsing; date-fns v4 `parseISO('2026-07-01')` returns local midnight — matches the documented intent. Preserve the non-date-only fallback branch (`new Date(dateString)`); date-fns is stricter on malformed timestamps. Pin with `lib/__tests__/timezone.test.ts` first. Contingent on the PKG-15 adopt-vs-remove decision. | OPEN |
| PKG-08 | days-in-month → date-fns `getDaysInMonth` | `components/statistics/CategoryPivotTable.tsx:23-24` (`new Date(year, month, 0).getDate()`). Same local-calendar result. Trivial; bundle with PKG-07. Contingent on PKG-15. | OPEN |
| PKG-09 | day subtraction → date-fns `subDays` | `components/charts/chartPeriods.ts:35` (`anchor.setDate(anchor.getDate() - days)`). Identical behavior (local, day-arithmetic on a midnight anchor). Bundle with PKG-07. Contingent on PKG-15. | OPEN |

## Tier 2 — worth doing, pin tests first (localized risk, must be reproduced exactly)

| ID | Unit | Detail | Status |
|----|------|--------|--------|
| PKG-10 | `usePlannedPayments` → react-query | `hooks/usePlannedPayments.ts:211-328`: full hand-rolled data layer (state + `mountedRef` + `fetchPayments` + five mutation callbacks that await the server and splice results into local state). It ALREADY invalidates `['upcomingPlannedPayments']` (222-224) — half-migrated. Replace with `useQuery(['plannedTransactions', showInactive])` + five `useMutation`. ~120→70 LOC. HARD REQUIREMENTS: consumer `pages/PlannedPaymentsPage.tsx:81` destructures `{ payments, addPayment, updatePayment, deletePayment, toggleActive, executePayment, loading, error }` — preserve the return contract verbatim; mutations are NOT optimistic today — use `setQueryData(serverResponse)` in `onSuccess`, not bare `invalidateQueries`, or update timing changes; `loading` starts true → map to `isLoading` not `isPending`; keep the `['upcomingPlannedPayments']` invalidation in every mutation. | OPEN |
| PKG-11 | `LinkTransactionDialog` → react-query | `components/planned/LinkTransactionDialog.tsx:30-119`: debounced (250ms) refetch effect + mounted guard + a recipient-id pre-resolution effect. Replace with `useQuery({ queryKey: ['linkTxCandidates', debouncedFilters], enabled: open && !!payment, placeholderData: keepPreviousData })`. ~45→20 LOC. HARD REQUIREMENTS: the 250ms debounce is deliberate — debounce the query-key input, don't drop it; `txSearchQuery` is intentionally client-side (comment at 117-118) and must stay OUT of the query key; spinner at line 244 keeps first-load vs refetch distinction. | OPEN |
| PKG-12 | `formatDate` numeric patterns → date-fns `format` | `components/shared/dateUtils.ts:5-40` is a 35-line switch reimplementing date-fns tokens. **Migrate ONLY the numeric-only patterns** (`yyyy-MM-dd`, `dd/MM/yyyy`, `dd.MM.yyyy`, `MM/yyyy`, …). The `MMM`-containing branches and the `default:` (`dateStyle:'long'`) branch render month names via `Intl.DateTimeFormat(locale, …)` honoring the app locale — date-fns `format` uses its own locale objects (default enUS) and would silently break non-English rendering. Keep those branches on Intl. Pin snapshot tests per pattern × locale first. Contingent on PKG-15. | OPEN |
| PKG-13 | zod residue: two localStorage reads | Optional completeness item extending ZOD-11: `hooks/useUpcomingPlannedPayments.ts:36-56` (`z.array(z.string()).catch([])`; the stale-date pruning is business logic and stays) and `components/planned/RecurringDetectionPanel.tsx:48-63` (int-array coercion; the `> 0` filter stays). Marginal benefit. The trivial guarded reads in `ThemeContext.tsx:121-125`, `lib/skin.ts:21`, `theme-flash.ts:6,19` are NOT worth migrating. | OPEN |

## Dependency decisions (the inverted findings)

| ID | Unit | Detail | Status |
|----|------|--------|--------|
| PKG-14 | Remove `@tanstack/react-table` | Installed, ZERO imports anywhere (`useReactTable`/`getCoreRowModel`/`createColumnHelper`: no matches). Adoption was evaluated and REJECTED: the shared table engine `components/shared/VirtualDataTable.tsx` (872 LOC) fuses sort/filter state with react-virtual virtualization, inline row editing, roving-tabindex keyboard nav, `aria-sort` semantics, server-vs-client sort duality, and rAF-coalesced column resize — react-table would delete ~60 lines while endangering all of that; `TableDataEditorPage` sorts server-side; `ResearchComparePage:296` is one tiny bespoke sort. Therefore: drop the dependency from `apps/frontend/package.json`. Zero runtime risk (no imports); verify install + build + tests after removal. | DONE (#105) |
| PKG-15 | Decide `date-fns`: adopt or remove | Installed, ZERO imports — while `components/shared/dateUtils.ts` hand-rolls a shim that mimics the date-fns API (same function names: `parseISO`, `differenceInDays`, `formatDistanceToNow`). Worst of both worlds. Two coherent paths: (a) **adopt** — implement PKG-07/08/09/12, keeping the do-not-migrate branches hand-rolled; (b) **remove** — drop the dependency and keep the shim. Either resolves the inconsistency; do NOT leave as-is. If (b), mark PKG-07/08/09/12 `WONTFIX (dep removed)`. This is a judgment call for the implementing agent/user; default recommendation: (a) adopt, because PKG-07/12 also delete ~40 lines of shim. | OPEN |

## Tier 3 — DO NOT MIGRATE (deliberate semantics; permanent KEEP list)

Frontend:

1. `dateUtils.ts:58` `formatDistanceToNow` — despite the date-fns name it emits `Intl.RelativeTimeFormat` output ("2 hours ago", `numeric:'auto'`, custom 30.44/365.25-day buckets). date-fns wording differs ("about 2 hours"). Swapping = rendering change.
2. `dateUtils.ts:52` `differenceInDays` — Math.round of UTC-normalized delta; date-fns truncates toward zero. Sub-day/DST-straddling pairs diverge.
3. All display-only float rounding: `PerformancePage.tsx:148-154`, `NetWorthPage.tsx:199-201`, `PortfolioTaxPage.tsx:663-685`, `utils/percent.ts`, `utils/formatCompactNumber.ts`. decimal.js is already the source of truth for stored money via `shared-utils/money`; converting display floats changes pixels for zero benefit.
4. `BarChart.tsx:338` `Math.max(0, ...values)` — the 0 floor is intentional; d3 `max` has no floor and returns `undefined` on empty.
5. `utils/currency.ts:50-77` `parseLocaleNumber` — bespoke EU/US/CH/IN separator heuristic; no installed package parses locale number strings.
6. `utils/currency.ts` `formatCurrency`/`formatCurrencyCompact` — app-specific Intl wrappers.
7. cva for computed-tone components (`components/shared/DeltaPill.tsx:18-28` and similar) — cva models discrete variant props, not sign-computed tones; the real cva components (`ui/badge`, `ui/button`, `ui/alert`, `ui/toggle`, `dashboard/StatCard`) already use it.
8. Upload/mutation flows with streamed progress (`features/imports/TransactionImportCard.tsx:175-222`, `SimpleImportCard.tsx`) — action-in-progress state, not cache; never useQuery.
9. All SSE streaming (`lib/aiChatStreamStore.ts`, `hooks/useAIChat.ts`, the stream tests `ai.test.ts`/`importsStream.test.ts` with `vi.stubGlobal('fetch')`, and `reports.test.ts` blob download) — outside both react-query and msw by design.
10. `RecurringDetectionPanel.tsx:83-120` — localStorage+settings merge with write-back, not a fetch bypass (its main data already uses useQuery).
11. `BelgianTaxProfileContext`, `LanguageContext`, `WorkspaceContext`, `PageTitleContext`, `SettingsPreloadContext` — DI/i18n/bootstrap contexts; the settings-state consolidation into zustand is already done.
12. The entire react-table adoption path (see PKG-14) and `VirtualDataTable`'s internals.

Backend (real duplications whose swap CHANGES output — listed as documented risk, not proposals; migrate only if the team explicitly accepts the output shift, with pinned tests):

13. `utils/portfolioMath.js:191,200,265`, `services/research/projection/portfolioProjection.js:49-50`, `services/aiChat/tools/expenses.js:591`, `services/recurringDetectionService.js:128` — `Math.round(v*100)/100` (half-up + float error) vs shared-utils `roundMoney` (half-even). Half-boundary inputs (e.g. 2.675, 0.125) diverge. These are mostly display metrics/percentages.
14. Epsilon comparisons (`currencyConversionService.js:449`, `prices/priceCache.js:117`, `portfolio/moveHoldingService.js:25`, `repositories/portfolioTxRepo.common.js:323`, forecast internals) — deliberately tolerant "changed enough to bother?" guards; exact Decimal compare flips borderline cases into extra writes.
15. Belgian bank adapters' `splitCsvLines` (`importPipeline/adapters/_shared.js:202`, used by belfius/bnp/ing/kbc) — these files carry non-tabular preambles (`belfius.js` HEADER_ROWS=13, balance-line scan); whole-file csv-parse would choke and would start honoring quoted embedded newlines the line-splitter deliberately ignores.
16. `_shared.js:147-198` `parseAmountField`/`parseCommaDecimal` — locale-aware amount parsing; keep.
17. `categoryRepository.js:127` template-literal `` `${general}:${detail}` `` vs shared-utils `formatCategoryName` — the helper collapses empty detail to just the general part; the literal always emits the separator, and the sibling `recipientRepository.js:21` builds the same string in SQL where the JS helper can't reach. Only unify after confirming `detail` is NOT NULL/non-empty in the schema.
18. Documented zod exclusions from the previous round (unchanged): `sanitizeUpdateFields`/`ALLOWED_COLUMNS`, `sanitizeString`, `dataImportService` + `importPipeline/validate.js` count-and-continue, `marketLookup.js` NO_VALIDATE, everything in `packaging/electron`.

## Verified already-done (do not re-investigate)

- Express 5 async error handling: no `asyncHandler`/`wrapAsync`/`catchAsync` anywhere; bare async handlers throw typed errors into `middleware/errorHandler.js`. The surviving `next(err)` calls are deliberate special branches (`routes/attachments.js:146-148` ENOENT→404, `lib/csvUpload.js:61-68` multer size limit, `errorHandler.js:90` headersSent).
- csv-parse backend tokenizer: `splitDelimitedRecord`/`parseCsvFile` in `_shared.js` and all record-style adapters already use it.
- decimal.js: ~30 call sites through `shared-utils/money` + 4 direct importers; stored-money math is covered.
- `@vision/shared-utils`: `lib/money.js`, `lib/csv.js`, `lib/assetClasses.js`, `lib/slugify.js` are thin re-exports; frontend equally clean.
- Node builtins: `randomUUID` and `AbortSignal.timeout` already used; no hand-rolled deep clone or UUID.
- react-virtual, radix primitives, zustand consolidation, msw: all clean (details in the Tier-3 entries above).

## Suggested batching (sequential subagents, same pipeline as before)

- **Batch P1:** PKG-14 (drop react-table) + PKG-06 (backend sleeps) + PKG-03 (useAdapters dedup). Trivial, zero-risk warm-up.
- **Batch P2:** PKG-01 (cn() sweep), split by directory; each diff spot-checked for conflicting Tailwind utilities.
- **Batch P3:** PKG-04 + PKG-05 (charts; verify finiteness per site) — contained to `components/charts/`.
- **Batch P4:** PKG-15 decision, then PKG-07/08/09 (+PKG-12 numeric patterns) if adopting.
- **Batch P5:** PKG-02, then PKG-10 and PKG-11 (react-query, pin loading/error/timing first).
- **Batch P6 (optional):** PKG-13.

Estimated total: roughly a day of pipeline time — far smaller than the zod
round. Every batch commits with the full gate suite green and flips its ledger
rows in the same commit.
