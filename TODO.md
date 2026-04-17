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
