# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

- [ ] 🔽 Visually spot-check `apps/frontend/src/components/ui/calendar.tsx` in the running app after its react-day-picker v10 migration ([[docs/adr/062-frontend-typecheck-gate-enforcement|ADR-062]]). The code migration is **done** — v10 `classNames` keys, the `Chevron` component, and the removed temporary cast (typecheck + 1,379 frontend tests green) — but the theme (selected/today/range styling, nav button positioning) has not been confirmed visually. 🛫 2026-05-29

## "100x" initiative — deferred items

> Context: the 2026-05-29 improvement initiative shipped 14/15 planned items (all verified; see memory `vision-100x-initiative`). These three were **deliberately not shipped** because each is unsafe/unverifiable to rush — they need a running stack or careful pattern design, not a budget-tail change. Plans below are self-contained.

- [ ] ⏫ **Import → commit E2E (data-integrity safety net).** The single highest-stakes write path — CSV upload → staged review → commit — has only "page loads" smoke coverage. Add a real write + dedup E2E. 🛫 2026-05-29
	- **Why deferred:** needs the running Docker stack to validate (can't run E2E in the sandbox); the upload flow lives in nested `features/imports/*` components, so a blindly-authored spec risks wrong selectors / false confidence on the most consequential path.
	- **Plan:**
		1. Add a fixed CSV fixture under `apps/frontend/e2e/fixtures/` (e.g. `belfius-sample.csv`). Reuse the realistic rows from `apps/node-backend/tests/belfiusAdapter.test.js` so the expected amounts/signs are pinned and known.
		2. (Recommended first) Add `data-testid` to the upload `<input type="file">` in `apps/frontend/src/features/imports/TransactionImportCard.tsx` and to the commit button in `apps/frontend/src/pages/ImportReviewPage.tsx`, so the spec is robust to copy changes.
		3. New spec `apps/frontend/e2e/import-commit.spec.ts`: `goto('/import')` → `setInputFiles` the fixture → adapter auto-detect → land on `/import/:batchId/review` → click commit.
		4. **Assert (write):** navigate to `/transactions`, confirm the imported rows appear with correct **amounts and signs** (− expense / + income).
		5. **Assert (dedup):** re-upload the *same* CSV → staging/commit yields **0 new rows**.
		6. Register the spec in the `test:e2e` file list in `apps/frontend/package.json` (it then runs in the scheduled `.github/workflows/e2e.yml`).
	- **Acceptance:** spec green against a live stack (`bun run dev` or `docker compose up`, `PLAYWRIGHT_BASE_URL=http://localhost:3002`); dedup assertion passes on re-upload.
	- **Refs:** model on `apps/frontend/e2e/critical-flows.spec.ts`; [[docs/features/import|Import feature]]; `.github/workflows/e2e.yml`.

- [ ] 🔼 **Optimistic updates on high-frequency CRUD mutations.** Today every core mutation invalidate-and-refetches, so the most repetitive workflows (categorize / tag / toggle) wait a full round-trip. Only 2 of ~64 `useMutation` sites are optimistic. 🛫 2026-05-29
	- **Why deferred:** there is **no existing `onMutate` pattern** in the codebase to copy, and transaction list queries are keyed `['transactions', params]` (parameterized by filter + pagination). A naïve optimistic patch updates one cached page and corrupts others — i.e. **wrong money on screen**. Must be designed carefully with a rollback test, not rushed.
	- **Plan:**
		1. Start with the **lowest-risk, non-money** mutation: tag toggle (`useBulkTagTransactions`) or the exclusion toggle in `apps/frontend/src/hooks/useTransactions.ts`. **Never** start with amount edits.
		2. Per mutation, implement the full TanStack pattern:
			- `onMutate`: `await queryClient.cancelQueries({ queryKey: ['transactions'] })`; snapshot **all** matching caches via `queryClient.getQueriesData({ queryKey: ['transactions'] })`; apply the optimistic change to each via `setQueriesData`; return the snapshot.
			- `onError`: restore every snapshotted `[key, data]` with `setQueryData`.
			- `onSettled`: keep the existing `invalidateQueries` for `['transactions']`, `['transactions-virtual']`, `['monthlySummary']`, `['tags']` as the reconcile/settle step.
		3. Extract the snapshot/rollback boilerplate into a small `apps/frontend/src/lib/optimistic.ts` helper so the remaining mutations reuse one audited implementation.
		4. **Gate (do not ship without):** an integration test (RTL + MSW) per mutation asserting (a) the optimistic value renders immediately and (b) it **rolls back** on a forced 500.
		5. Roll-out order: tags/exclusion → category assignment → (only then, with extra care) money-changing edits.
	- **Acceptance:** optimistic render + verified rollback test for each migrated mutation; aggregates (`monthlySummary`, totals) are **never** optimistically derived — always invalidate-on-settle.
	- **Risk:** HIGH if wrong. Keep invalidate-on-settle as the safety net.
	- **Refs:** `apps/frontend/src/hooks/useTransactions.ts`, `useTags.ts`; TanStack Query "optimistic updates" guide.

- [ ] 🔽 **Empty-state standardization + Dashboard zero-data CTA.** Bespoke empty states are scattered across pages; the shared `apps/frontend/src/components/shared/EmptyState.tsx` exists but isn't used everywhere. 🛫 2026-05-29
	- **Why deferred:** broad cross-page refactor (presentational); low risk but wide surface — out of scope for a single verified pass.
	- **Plan:**
		1. Inventory bespoke empty states: grep `src/pages` + `src/features` for centered "no … yet" blocks / `noData` / `emptyTitle` usages not going through `EmptyState`.
		2. Migrate each to `<EmptyState>` (icon + title + description + optional CTA), preserving existing i18n keys.
		3. Add a Dashboard zero-data "get started" CTA (shown when no transactions exist) linking to `/import`, in `apps/frontend/src/pages/DashboardPage.tsx`.
		4. Any new copy → add keys to `i18n/source/en.json` **and** `nl.json`, then `bun run generate-locales` + `bun run validate-locales` (keep parity green).
	- **Acceptance:** no remaining bespoke empty-state blocks where `EmptyState` fits; fresh-install Dashboard shows an actionable CTA; locale parity clean.
	- **Refs:** `apps/frontend/src/components/shared/EmptyState.tsx`.

