# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

- [ ] 🔽 Visually spot-check `apps/frontend/src/components/ui/calendar.tsx` in the running app after its react-day-picker v10 migration ([[docs/adr/062-frontend-typecheck-gate-enforcement|ADR-062]]). The code migration is **done** — v10 `classNames` keys, the `Chevron` component, and the removed temporary cast (typecheck + 1,379 frontend tests green) — but the theme (selected/today/range styling, nav button positioning) has not been confirmed visually. Open any date picker (e.g. Add Transaction → date) at 320/768/1440 in both themes. 🛫 2026-05-29

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

## Codebase audit — May 2026 (open backlog)

> 105 findings total — full report with evidence + per-finding fixes: [[docs/reference/codebase-audit-2026-05|Codebase Improvement Audit — May 2026]] (findings tagged there by id, e.g. `sec-auth-headers`, `correctness-money`).
> The **2026-05-29 remediation pass shipped 11 items** (SSRF guard, admin-auth+CSRF, historical FX, exclusion hook, loan-PATCH atomicity, release `npm ci --ignore-scripts`, VirtualDataTable semantics+keyboard+checkbox-perf, recharts preload, chart/aria i18n, portfolio loading/error) — see the report's "Remediated 2026-05-29" notes, git history, and memory `vision-audit-2026-05`. Items below are what remains **open**. Each line is self-contained: file:line + the fix. The medium/low long tail not listed here lives in the report.

### Security

- [ ] 🔼 **No baseline rate limiting on the data plane.** Only a few sub-routes are throttled (`main.js:272-289`); `/api/transactions`, `/api/settings`, etc. have none. **Fix:** mount a global limiter (the default 100/min `'global'` bucket from `middleware/rateLimiter.js`) app-wide before the data routers, keeping stricter per-route limiters on top. _(audit: sec-auth-headers)_ 🛫 2026-05-29
- [ ] 🔼 **Rate limiter trusts `X-Forwarded-For` from any private/link-local peer** → per-request bucket evasion. `middleware/rateLimiter.js:23-35` (`isTrustedProxyAddr`) + key derivation `:62-67`. **Fix:** only honor XFF from an explicitly configured trusted proxy IP/CIDR (env), not the whole private range; otherwise key on the socket address. _(audit: sec-auth-headers)_ 🛫 2026-05-29
- [ ] 🔼 **Zip restore has no zip-bomb guard.** `packaging/electron/backup/bundle.js:414-457` (`extractZip`, via `openBundle:480-497`) — no per-entry, total-size, or entry-count cap. **Fix:** track running bytes written and abort+cleanup past a `MAX_RESTORE_BYTES`; also cap entry count and reject any entry whose uncompressed size is implausible. _(audit: sec-files-ssrf)_ 🛫 2026-05-29
- [ ] 🔽 **Response-size cap on the *hardcoded* provider fetches.** The user-controlled custom-provider path is already capped (5 MB `Content-Length` check in `priceProviderRegistry._fetchJson`, shipped 2026-05-29); the fixed Binance (`priceProviderRegistry.js:315`), Kinesis, and Yahoo fetches are still uncapped. **Fix:** apply the same `Content-Length` guard to those. _(audit: sec-files-ssrf)_
- [ ] 🔽 **Dev mode fails open.** Rate limiting is fully disabled and CORS reflects a wildcard origin when env is `development` (`rateLimiter.js:56-60`, `main.js:100-106`). **Fix:** default the environment to `production` (fail-safe), or gate the dev bypasses on an explicit `VISION_DEV=true` so an unset env isn't permissive. _(audit: sec-auth-headers)_

### Correctness (money)

- [ ] 🔼 **Inconsistent money rounding mode.** `lib/money.js:42` `roundToCents` uses `ROUND_HALF_EVEN` (banker's) while `:72` `roundMoney` uses `ROUND_HALF_UP`; mixing them across emit paths can break snapshot/summary reconciliation by a cent. **Fix:** pick one (banker's is declared canonical at `money.js:37`) and make `roundMoney` delegate to it; audit call sites. _(audit: correctness-money)_ 🛫 2026-05-29
- [ ] 🔼 **Lossy `Math.round` in portfolio buy/sell math.** `repositories/portfolioTxRepo.common.js:116-118` (`roundTo`) used by `normalizeBuySellMath:121-154` — float rounding despite Decimal helpers in scope. **Fix:** replace `roundTo` with `roundMoney` from `lib/money.js` (Decimal path). _(audit: arch-deadcode-dup)_ 🛫 2026-05-29
- [ ] 🔼 **Snapshot 'today' boundary uses UTC, not `APP_TIMEZONE`.** `services/portfolio/snapshotBuilder.js:219-223` (day-walk start/end) + `:253` (`todayYmd`) compute the calendar day in UTC, so near midnight the last snapshot can land on the wrong day vs the rest of the calc layer. **Fix:** derive the end day from `toAppDateString(new Date())` (`lib/timezone.js`). _(audit: correctness-money)_ 🛫 2026-05-29
- [ ] 🔼 **Portfolio unit-math duplicated verbatim across Add/Edit dialogs.** The "derive the missing one of amount/units/price" logic + its rounding precisions (4/8/6) + float tolerance (`0.0001`) is copy-pasted in `components/portfolio/AddPortfolioTxnDialog.tsx:95-118` and `EditPortfolioTxnDialog.tsx:110-133` — drift here means Add and Edit silently accept/reject different inputs. **Fix:** extract one pure `deriveUnitMath({amount,units,price})` helper with named constants; unit-test it; both dialogs call it. _(audit: correctness, high finding)_ 🛫 2026-05-29

### Performance (frontend)

- [ ] 🔼 **`PlannedPaymentsPage` renders up to 1000 rows through the non-virtualized `DataTable`.** `pages/PlannedPaymentsPage.tsx` (DataTable usage ~`:466`; `usePlannedPayments` fetches limit 1000). **Fix:** migrate to `VirtualDataTable` (now has full table semantics + keyboard activation). Safe frontend change. _(audit: perf-frontend)_ 🛫 2026-05-29

#### perf-DB — deferred (validate against a running DB; do NOT ship blind)

> **Why all three are deferred:** they rewrite money-aggregation SQL whose correctness the **Vitest suite cannot catch** — `tests/**` mock `database/connection.js`'s `query()`, so the SQL string is never executed; a passing unit test only proves the JS around the query, not the query. One also needs an Alembic migration (you apply migrations; they're not auto-run — see AGENTS.md). Wrong aggregation here = wrong money on the dashboard/reports.
>
> **How to validate (do this before shipping any of these):**
> 1. Bring up the stack with real data: `bun run docker:dev` (Postgres + backend, hot-reload) — or `docker compose up`. Apply migrations: `bun run db:upgrade`.
> 2. Seed/import a **multi-currency, multi-year** dataset (e.g. import a CSV with USD + EUR rows spanning several years; ensure `exchange_rates` has historical rows — run a price/rate backfill if needed).
> 3. Capture the **current** endpoint output as the baseline (`curl localhost:3002/api/info/transaction-summary`, `/api/info/monthly-summary?all_time=true`, `/api/aggregations/recipient-insights`), then apply the change and diff — the numbers must match exactly (these are read-only perf rewrites, not behavior changes).
> 4. Confirm the perf win with `EXPLAIN ANALYZE` (rows scanned / time) before vs after. `bun run db:index-stats` helps.
>
> **Key already-verified fact (de-risks #3):** `convertRowsToEur(rows, target)` defaults to `useHistoricalRatesByDate = false` (`currencyConversionService.js:191`), i.e. **one latest rate per currency**, not per-date — so a `GROUP BY currency` SQL pushdown is mathematically valid for these endpoints.

- [ ] ⏫ **`mv_recipient_monthly` is refreshed on every mutation but never read.** The recipient-insight reads (`infoRepositoryRecipients.js` `getRecipientInsights`/`getRecipientByYear`/`getRecipientPivot`, full `FROM transactions` scans at lines 31/81/144/207) do **not** query the MV; it's only **created** (`materializedViewService.js`, alembic `0035_add_recipient_aggregations.py`) and **refreshed** (`aggregationRefresh.js:39`, `PHASE_1_MATERIALIZED_VIEWS`). So every transaction mutation pays a `REFRESH MATERIALIZED VIEW` for a view nothing reads. 🛫 2026-05-29
  - **Decide (one of):** (a) **wire the reads** through `mv_recipient_monthly` + a live current-month overlay (the bigger perf win; this is what the Phase-1 scaffolding was building toward — validate aggregate correctness on real data per the steps above); or (b) **stop refreshing it** — remove `'mv_recipient_monthly'` from `PHASE_1_MATERIALIZED_VIEWS` (and consider dropping the MV via a new migration), which removes the write-amplification but abandons the in-progress migration.
  - **Also (independent, safe):** `recipient.js:18` mislabels its envelope `source: 'mv'` while actually serving a live scan — its siblings `recipientPivot.js`/`recipientByYear.js` correctly say `source: 'live'`. Fix `recipient.js` to `'live'`. ⚠️ First check no test/consumer asserts `source === 'mv'` for recipient insights (`meta.source` is set across `services/calculations/aggregation/*` and documented in `_envelope.js`).
  - **Gate:** existing refresh scaffolding has tests at `tests/aggregationRefresh.test.js:42-119` (CONCURRENTLY default, non-concurrent fallback, error log, coalescing) — option (b) must update/remove these; option (a) must leave them green.
  - **Refs:** audit `performance.3`; `services/calculations/aggregation/recipient.js`; `repositories/infoRepositoryRecipients.js`.
- [ ] ⏫ **Report monthly summary always takes the unbounded live path.** `infoRepo.monthly.js:29` skips the `mv_monthly_summary` fast path whenever `allTime` is true (or any exclusion is set); the PDF report fetcher (`services/reports/dataFetcher.js`) always calls `computeMonthlySummary({ allTime: true })`, so reports never hit the MV. `mv_monthly_summary` is structurally capped at the last 12 months (`materializedViewService.js`), so it cannot serve all-time even if the gate were relaxed. 🛫 2026-05-29
  - **Plan (one of):** (a) add an **all-time monthly MV** (per `year, month, currency`) via a new Alembic migration (`bun run db:revision -- "msg"`, ship rollback, user applies) + an incremental/scheduled refresh, then read it in the allTime path; or (b) push the aggregation into SQL: `GROUP BY (date_trunc('month', date), currency)` then FX-convert the small grouped result (valid per the verified `convertRowsToEur` fact above) — no migration needed, lower risk, preferred first.
  - **Gate:** report output must be numerically identical to the current live path (validate per steps above); add a test asserting the grouped/MV path equals the live path for a fixed multi-currency fixture.
  - **Refs:** audit `performance.2`; `repositories/infoRepo.monthly.js`; `services/reports/dataFetcher.js`.
- [ ] ⏫ **Unbounded scan in `/transaction-summary`.** `getTransactionSummary` (`infoRepositoryStatistics.js:199`) selects **every** active transaction's amount/currency/date with no LIMIT and (for a no-arg request) no date bound, then computes count/sum/avg/min/max in JS after per-row FX. 🛫 2026-05-29
  - **Plan:** push to SQL `SELECT currency, COUNT(*), SUM(amount), MIN(amount), MAX(amount) FROM transactions WHERE is_active GROUP BY currency` (+ the existing optional bank/date filters), then in JS convert each currency's aggregate by its latest rate and combine: `count = Σ count_c`; `total = Σ (sum_c × rate_c)`; `min = min_c (min_c × rate_c)`, `max = max_c (max_c × rate_c)` (valid because rate_c > 0 ⇒ monotonic, and the default conversion is one rate per currency — verified above); `avg = total / count`. This preserves exact semantics while replacing a full-table transfer with a grouped scan.
  - **Gate:** rewrite the `getTransactionSummary` unit test to mock the grouped query result and assert the combine math (covers the JS); then validate end-to-end equality vs the current output on the running stack per the steps above. (Do **not** instead add a default date window — that silently changes "all-time" to a window; product decision, avoid.)
  - **Refs:** audit `performance.1`; `repositories/infoRepositoryStatistics.js:199`; `services/currency/currencyConversionService.js:188`.

### UX / i18n

- [ ] 🔼 **`PlannedPaymentsPage` uses native `window.alert()` for save errors and swallows toggle/delete errors.** `pages/PlannedPaymentsPage.tsx:353` (`alert`), toggle catch `:279`, delete catch `:326`. **Fix:** `toast.error(...)` for the save error and in both catch blocks (matching `useTransactions`/`useRecipients`, which toast on every `onError`). _(audit: ux-states)_ 🛫 2026-05-29
- [ ] 🔼 **`t()` has no plural support → ungrammatical "1 items".** `components/shared/DataTable.tsx:578` (keys `table.items` / `portfolio.investments` / `performance.holdings`) and similar count strings. **Fix:** add a minimal plural mechanism — `Intl.PluralRules`-aware `.one`/`.other` keys resolved by a small helper — and migrate the count strings. _(audit: ux-i18n)_ 🛫 2026-05-29

### Architecture / cleanup

- [ ] 🔼 **15 route files bypass the services layer**, importing repositories / the DB pool directly (each carries `// eslint-disable-next-line vision-local/no-repo-direct-...`). `routes/*.js`. **Fix:** pick one boundary — either introduce thin service modules (`transactionService`, …) that own name→id resolution / bulk ops, **or** formally permit repo access from routes and drop the lint rule. Don't leave it half-enforced. _(audit: arch-backend)_ 🛫 2026-05-29
- [ ] 🔼 **`features/` vs `components/` migration is half-finished.** The import feature is split across `components/import/*` and `features/imports/*` with a back-reference (`pages/ImportPage.tsx:5-10`, `features/imports/TransactionImportCard.tsx:22`). **Fix:** pick one organizing axis and finish the move (consolidate into `features/<domain>/`). _(audit: arch-frontend)_ 🛫 2026-05-29
- [ ] 🔼 **Pure utilities hand-mirrored across frontend/backend.** `apps/frontend/src/lib/slugify.ts`, `lib/money.ts`, `utils/downsample.ts`, `utils/currency.ts` duplicate backend logic — drift risk on money/slug code. **Fix:** extract the shared pure helpers into a `packages/shared-utils` workspace package consumed by both. _(audit: arch-deadcode-dup)_ 🛫 2026-05-29
- [ ] 🔽 **Dead code + stale config.** Dead exports `useTransaction` (`hooks/useTransactions.ts:37-44`) and `formatAmountWithSymbol` (`utils/currency.ts:188-210`) have no call sites; `config/vite.config.ts` is a stale, divergent second Vite config with a broken PostCSS path (`:32`). **Fix:** delete the dead exports; delete `config/vite.config.ts` (or, if it's meant to be canonical, wire the build to it and fix the postcss path). _(audit: arch-deadcode-dup / perf-bundle)_
