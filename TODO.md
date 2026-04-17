# TODO

## Bugs

### General

### No translations provided for the following

## Features

- Use Claude to make the UI premium

- Ship the app through docker (marketplace)?
- Add ability to query database using local AI

## Refactor follow-ups (Phase 2 dashboard perf)

- **Rewrite `useStatistics` hook** to consume `/api/aggregations/*` envelopes instead of paginating all transactions + client-side 4-map pipeline. Blocked: `mv_monthly_summary` is 12-month only; full-history `allYears`, `yearlyComparison`, and full-history `categoryPivot` require broader aggregation (Phase 1 MV extension).
- **Split `DashboardPage.tsx` and `StatisticsPage.tsx`** into `features/dashboard/sections/*` and `features/statistics/sections/*` (target <250 LOC per page). Blocked on the `useStatistics` rewrite above.
- **Delete `statisticsProcessing.ts` 4-map pipeline** once `useStatistics` no longer depends on it.
- **Remove `/api/info/*` shim** — Phase 9 cleanup after shadow-mode parity with `/api/aggregations/*` proves out.
- **Extend Phase 1 MVs** beyond 12-month window: `mv_category_monthly`, `mv_recipient_monthly`, `mv_daily_cashflow` (per plan Phase 1). Prereq for the items above.

## Refactor follow-ups (Phase 3 planned / loans / recurring)

- **TZ-aware date math for recurrence + loan schedule**. Current `addMonthsClampedUtc` / `addMonthsAtDay` hard-code UTC. Blocked on Phase 0 timezone ADR (`APP_TIMEZONE`, `toAppTz` / `toUtc` boundary helpers). Replace call sites once ADR lands.
- **MV `vw_planned_upcoming_30d`** — materialized view of planned + next N recurring expansions within 30 days, refreshed nightly + on planned_transactions write. Drives the due-soon widget without per-request expansion.
- **`GET /api/planned-transactions/due-soon?within=30d`** — new endpoint reading the MV above; replaces the current `getAllUpcomingInRange` loop.
- **Split `PlannedPaymentsPage.tsx` (906 LOC)** into `features/planned/{PlannedList,PlannedForm,LoanScheduleView,RecurringDetectionPanel}.tsx`. Target <250 LOC per component.
- **Remove back-compat shims** at `services/loanRepaymentService.js` and `services/recurrenceService.js` once all imports move to `services/calculations/{loanSchedule,recurrence}.js`.
- **Additional loan golden fixtures** — leap-day start date + DST boundary cases (defer until TZ-aware rewrite so fixtures are meaningful).
- ~~**Flaky test** `tests/routes/plannedTransactions.test.js > should execute recurring and advance date`~~ — fixed in Phase 5: tests updated for `executeAndAdvance(id, executed_transaction_id, execDate, updateFields)` idempotency contract (route no longer calls `update` + `addExecution` pair).

## Refactor follow-ups (Phase 4 splits / who-owes-you)

- **Split `OwesPage.tsx`** into `features/splits/{OwesSummary,OwesDetail,RecordPaymentDialog,SettleDialog}.tsx`. Target <250 LOC per component.
- **Expand `split_audit.action` vocabulary** to cover future lifecycle events (amount_edit, note_edit, reopen) — migration to widen the CHECK constraint and audit call sites once those mutations land.
- **Enforce `x-actor` at reverse proxy** — currently route accepts header verbatim with `req.user?.id` fallback. Once real auth lands, remove header fallback.
- **Periodic `split_audit` archival** — append-only table will grow unbounded. Add rolling-window export + prune job (e.g. >18 months old → cold storage).
- **`agg_split_outstanding` regression fixture** — extend golden harness to exercise the MV projection end-to-end against seeded Postgres once test-DB scaffolding lands (Phase 0 testcontainers work).

## Refactor follow-ups (Phase 5 transactions)

- **`BulkActions.tsx` surface** — plan called out a bulk-actions component. Current `TransactionsPage` has no multi-select bulk operations (toggle/delete/categorize multiple rows). Defer until a concrete UX ask lands; not a blocker.
- **`InlineEditCell.tsx` extraction** — plan listed it explicitly; inline editing currently handled inside `VirtualDataTable` via column `render(isEditing)`. Extract only if a second table surface needs the same cell shape (YAGNI otherwise).
- **`RawApiTransaction` → generated type** — the feature-local `RawApiTransaction` shape should be replaced with the API client's generated response type when `apiClient.getTransactions` gets a stricter return signature (currently returns `{ items, total }` with loose item shape).
- **Consolidate `buildWhereClause`** usages — Phase 5 added the shared `services/filterBuilder.js`. Audit remaining `repositories/*.js` callers (splits, planned, recipients) to ensure they route through it rather than rebuilding clauses inline.
- **Streaming export back-pressure** — current CSV export calls `res.write(chunk)` without checking the return value; on large exports + slow clients the write buffer may grow. Add `drain` handling if a perf report surfaces.
- **`includeBalance=true` MV** — running-balance via window function is O(n) per query. If dashboard balance widgets land on this endpoint, precompute into `agg_transaction_balance` maintained by trigger.

## Refactor follow-ups (Phase 6 recipients + categories)

- **Integration tests for `findBestRecipientMatches`** — pg_trgm GIN index path covered only by unit fixtures on the pure `normalizeForMatching`. Exercise the matcher end-to-end against a seeded Postgres (needs Phase 0 testcontainers scaffolding) to lock the similarity threshold + ordering contract.
- **Integration tests for atomic `mergeRecipients`** — BEGIN/COMMIT boundary, `FOR UPDATE` primary lock, and `INSERT ... ON CONFLICT DO NOTHING RETURNING id` RBA dedupe are only covered by manual smoke. Add tx-aware integration test once test-DB scaffolding lands.
- **Delete dead `recipientRepository.mergeRecipients`** if still present after `services/recipientMergeService.js` fully supersedes it — audit import graph and remove stale export.
- **Pre-existing lint errors in `RecipientsPage.tsx`** (4× `@typescript-eslint/no-explicit-any` at lines 47, 91, 92, 163) and `CategoriesPage.tsx` (1× `react-hooks/exhaustive-deps` warning at line 60) — not introduced by Phase 6; tackle alongside a dedicated typing pass on the pages surface.

## Refactor follow-ups (Phase 7 imports)

- **Delete `services/importService.js` + its test** once the `IMPORT_PIPELINE_V2` feature flag defaults to on and `services/importPipeline/*` has run at least one full release cycle without divergence. Plan Phase 9 scope.
- **Split `ImportPage.tsx` (1062 LOC)** into `features/imports/{BankSelect,FileUpload,ColumnMapping,Preview,Progress}.tsx` with a shared Zustand store for multi-step state. Frontend work deferred from Phase 7 backend pipeline PR.
- **Adapter telemetry** — `services/importPipeline/adapters/index.js` auto-registration emits no observability. Add a `detect()` fan-out log (bank + confidence) so misdetected CSVs are triageable without repro.
- **Staging-row retention policy** — `import_batches` + `import_staging_rows` grow unbounded. Add a rolling prune (>30d committed/failed) once pipeline is GA.
- **Chunked commit tuning** — current `commit()` batches 1000 rows per tx. Profile on 100k-row Belfius imports; adjust batch size or switch to COPY if p95 commit time exceeds 500ms per batch.

## Refactor follow-ups (Phase 8 calc correctness)

- **Wire `aggregationShadow` middleware** onto `/api/aggregations/*` routes with a real `fetchLegacy` client against `/api/info/*`. Middleware + diff logic is now locked; wiring deferred to avoid double-roundtripping during Phase 8 property-test merge.
- **Shadow divergence dashboard** — surface `aggregation-shadow: divergence detected` warn entries into a time-series panel so the release-cycle parity claim can be demonstrated with data before Phase 9 removal.
- **Dev-mode invariant assertions** — optional cheap `assertRoundTripIdentity(x, A, B)` / `assertCategoryConservation(agg)` hooks re-run the Phase 8 invariants in non-prod and log mismatch. Wire once a request of the invariant is worth the overhead.
- **Property test expansion** — property suite currently covers the 6 headline invariants from the plan. Add coverage for: dedup hash idempotency (`hash(normalize(t)) == hash(normalize(normalize(t)))`), filterBuilder parameter stability, LTTB downsample preserves endpoints.
- **Cross-check sweep script** — one-shot CLI that hits every `/api/aggregations/*` + paired `/api/info/*` over a configurable date window and emits a CSV of divergences. Drives the "30 days" end-to-end verification from the plan without waiting on shadow-mode to accumulate traffic.

## Refactor follow-ups (Phase 9 cleanup — blocked on prereqs)

Phase 9 audit (2026-04-17): **every code-removal item is blocked**. Each target is still imported by live code paths; upstream migration work from phases 2/3/7 plus real shadow-mode parity data is required before any `rm` lands. Phase 9 completed only the documentation side (honest status + kb-updater pass). Each item lists its unblocker.

- **`/api/info/*` routes** — blocked on `aggregationShadow` wiring + one full release cycle of zero `aggregation-shadow: divergence detected` warnings. Middleware (`src/middleware/aggregationShadow.js`) is locked but never wired; see the "wire aggregationShadow" follow-up under Phase 8.
- **`services/importService.js`** — still called by `services/rawTransactionImportService.js`; that caller runs whenever `IMPORT_PIPELINE_V2` is off (default). Unblock: flip `IMPORT_PIPELINE_V2` default on, migrate `rawTransactionImportService` off `importCSV`, run one release cycle without divergence, then delete.
- **`apps/frontend/src/hooks/statisticsProcessing.ts`** — still imported by `hooks/useStatistics.ts`. Unblock: rewrite `useStatistics` to consume `/api/aggregations/*` envelopes (blocked on the Phase 1 MV extension for full-history `allYears` / `yearlyComparison` / `categoryPivot`, listed under "Refactor follow-ups (Phase 2 dashboard perf)").
- **`services/loanRepaymentService.js` + `services/recurrenceService.js` shims** — still imported by `routes/plannedTransactions.js` (`generateLoanRepaymentSchedule`, `calculateNextDate`). Unblock: migrate the route + tests to `services/calculations/{loanSchedule,recurrence}.js`, then remove the shims.
- **`services/currencyConversionService.js`** — plan called this a back-compat shim; audit shows it's the *live* implementation that `services/calculations/currency.js` re-exports from. Nothing to delete; strike from the cleanup list once the ADR is refreshed.
- **`aggregationShadow` middleware** — cannot be removed until it has been wired, collected a full release cycle of parity data, and driven the `/api/info/*` removal. Retain as a parked Phase 8 tool.
- **Docs refresh** — partial pass landed via `vision-kb-updater` after Phase 8; the remaining targets (`docs/features/{dashboard,statistics,planned-transactions,splits,imports}.md`, `docs/reference/api-endpoint-matrix.md`, `docs/reference/code-patterns.md`, ADRs for timezone/aggregation strategy/import pipeline/soft-delete) stay open until the corresponding code removals actually happen — otherwise the docs would lie.
