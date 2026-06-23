# Monthly Code Audit — June 2026

**Window audited:** `31701f81` (2026-05-21) → `HEAD` (`4a4573e`, 2026-06-19)
**Scope:** 156 commits · 910 files · ~45k LOC of hand-written code change (excl. locales/lockfiles/docs).
**Method:** Five parallel dimension audits (security, correctness, performance, architecture, UI/UX), each scoped to the diff and verified by reading the code at HEAD. Read-only — no code was changed.

Major themes this window: the **research workspace** (markets overview, FRED/Eurostat/DBnomics macro), **internal-transfer detection & exclusion** (ADR-083), the **cross-workspace accounts / per-account net-worth epic** (ADR-088→102), **point-in-time FX tax** (ADR-085), the **settings sidebar rework** (ADR-084), the **admin DB data editor** (ADR-101), and Electron/demo builds.

---

## Overall assessment

The month's work is, on the whole, **well-engineered and disciplined**: enforced layering via custom ESLint rules (`no-repo-direct-from-route`, `no-raw-money-arithmetic`), a compile-time OpenAPI contract guard (0 drift across 210 ops), pure-core/IO separation, single-source money utilities in `@vision/shared-utils`, keyset/streaming pagination, TTL caches with in-flight dedup, `CONCURRENTLY` MV refresh, and exemplary post-incident migration hygiene. Each audit independently flagged large swaths of "verified clean."

The issues that matter cluster tightly, and several were found independently by **more than one** audit — which raises confidence:

- **Admin DB editor (ADR-101)** is the single riskiest new feature: open-by-default authz *and* a one-click destructive UI. (Security + UI/UX)
- **`computed_balance` is stale by design** — it freezes at the last *imported* balance and poisons balances, drift, net-worth, and rebalance cash. (Correctness + Architecture + Performance all touched it)
- **Transfers leak back into aggregates** on several paths, defeating ADR-083's whole purpose. (Correctness)
- **Per-account valuation has three divergent implementations.** (Architecture + Correctness)
- **The rebalancing cash-cap is unclamped and untested server-side.** (Correctness + Architecture)
- **Research / net-worth surfaces fail silently** as em-dashes and blank charts. (UI/UX + Performance)

No **Critical** issues; the highest are High. Below, findings are consolidated across audits and ordered by priority.

---

## Priority 1 — fix now

### P1.1 — Admin DB editor: dangerous by default, destructive by one click
*Security #1 + UI/UX H1 — corroborated from two angles.*

- **AuthZ:** `ADMIN_AUTH_TOKEN` defaults to `''` (`apps/node-backend/src/config/env.js:83`); when empty, `adminAuthMiddleware` calls `next()` unconditionally (`apps/node-backend/src/middleware/adminAuth.js:37-43`). The DB editor can then read/write **any user table**. The only protections are loopback port binding and a CSRF guard — and that guard treats a request with **neither** `Sec-Fetch-Site` **nor** `Origin` as a trusted non-browser client (`apps/node-backend/src/middleware/csrfGuard.js:44-48`), so any local non-browser process can drive destructive mutations with no credential.
- **UI:** the editor commits INSERT/UPDATE/DELETE to the live DB on a single click of the preview dialog, with **no confirmation, no undo** (`discardAll()` runs on success), and **editable primary keys** (`apps/frontend/src/pages/admin/TableDataEditorPage.tsx:499-504,250-259,92-114`). Editing a matview base table only rewords a banner.
- **Mitigating:** the SQL layer itself is well-hardened — identifiers validated against the live catalog and quoted, values parameterized, reads in a `READ ONLY` txn with `statement_timeout`, optimistic `xmin` concurrency, audit rows, rate limiting. This is an authz/UX problem, **not** SQL injection.
- **Fix:** fail closed — require `ADMIN_AUTH_TOKEN` whenever the mutating admin routes are mounted (or gate them behind an explicit server-side admin flag); don't treat missing `Origin`+`Sec-Fetch-Site` as trusted for `/api/admin` mutations. Gate commit behind an `AlertDialog` showing the op count (reuse `BackupSection.tsx:347`), use `variant="destructive"` when deletes are present, and make PK cells read-only (the code already knows `primaryKey`).

### P1.2 — `computed_balance` freezes at the last *imported* balance
*Correctness H1 — also underlies Architecture M3 and Performance M1.*

`computed_balance` is a LATERAL picking the latest active transaction **with `balance IS NOT NULL`** (`apps/node-backend/src/repositories/accountRepository.js:45-50`, duplicated in `crossWorkspaceDataService.js:59-64` and `infoRepositoryNetWorth.js:108-117`). But `transactions.balance` is only stamped by some CSV adapters — it's NULL for manual entries, trade cash legs (`tradeCashLegService.js:65-72`), and brokerage fan-out cash (`brokerageFanout.js:100-104`). After any trade/dividend/manual/brokerage row, the figure stops moving.

This poisons the Accounts hub balance, the `drift = statement_balance − computed_balance` badge, per-account net-worth cash, and the rebalance `availableCash` — and it contradicts `mv_bank_balances.balance = SUM(t.amount)` and ADR-094.

- **Fix:** make it a true running total (`COALESCE(SUM(t.amount),0)` LATERAL) at all three call sites, matching the MV. Architecture M3 separately recommends extracting this thrice-copied SQL into one repository helper — do both together.

### P1.3 — Transfers leak back into spending & category aggregates
*Correctness H2, H3, M1 — defeats the core goal of ADR-083.*

- `getAverageVsCurrentSpending` (`apps/node-backend/src/repositories/infoRepo.statistics.js:15-30`) filters only `is_active = true` — **no `is_transfer = false`** — so transfer outflows inflate `avg_monthly_spending`, daily spending, and `projected_monthly_total`. The `includeTransfers` toggle has no effect here.
- `getCategoryBreakdown` excludes transfers on the MV fast path but **not** the live fallback (`apps/node-backend/src/repositories/infoRepositoryStatistics.js:27-37`), so totals shift non-deterministically as the MV populates/clears.
- The toggle is honored in monthly/pivot, **hardcoded off** in recipient insights (`infoRepositoryRecipients.js`), and **ignored** in the two above — surfaces no longer reconcile.
- **Fix:** add `AND t.is_transfer = false` (gated on `getIncludeTransfers()`) to both queries; decide and document one consistent toggle policy across all aggregate surfaces.

---

## Priority 2 — fix soon

### P2.1 — Three divergent "per-account holdings value" implementations
*Architecture H1 + Correctness L1.* `portfolioSummaryService.aggregateByAccount` (exact cost-basis), `snapshotBuilder.splitByAccount` (proportional weight-split), and `infoRepositoryNetWorth.getNetWorthByAccount` compute the same user-facing number two different ways; the parity test only asserts `Σ == total`, not that the per-account splits agree. The dashboard card and the net-worth-by-account page can disagree for the same account with no test catching it. `getNetWorthByAccount` also models liabilities as negative cash while the snapshot path splits them into a `liabilities` bucket. **Fix:** pick one canonical decomposition for current holdings; add a cross-parity test; carry `is_liability` through.

### P2.2 — Rebalancing cash-cap: unclamped, duplicated, untested server-side
*Correctness H4/L4 + Architecture H2.* The cash-override rule lives in the route (`apps/node-backend/src/routes/crossWorkspace.js:48-51`), is re-implemented client-side (`RebalancePage.tsx:50`), and the server does **not** clamp `overrideCash ≤ availableCash` — an API caller can deploy money that doesn't exist. Separately, all-zero target weights silently "deploy nothing" with no error (route + saved plans). The pure `rebalanceDeployment` is tested; the override path is not. **Fix:** move `resolveDeployableCash({availableCash, cap})` (clamped to `[0, availableCash]`) into `crossWorkspaceAnalytics.js`, call from both layers, reject `Σ targetWeights ≤ 0`, add a route test.

### P2.3 — Research / net-worth surfaces fail silently
*UI/UX H3/M5 + Performance.* The research hub and Markets Overview heatmap destructure only `data` (`ResearchHomePage.tsx:60-95`, `MarketOverviewPage.tsx:981-1037`) — on rate-limit/outage/offline every tile renders "—", indistinguishable from loading or genuinely-flat. Per-account net-worth (`NetWorthPage.tsx:45-49`) — the exact endpoint behind the e98 500 — silently disappears the chart on error. **Fix:** read `isError`/`isLoading`; show skeletons on first load and inline error/offline banners (reuse `EmptyState`/`ResearchUnavailableNote`/`PageError`). Mirror the four-state handling the page-level net-worth query already does well.

### P2.4 — Import-pipeline per-row DB round-trips
*Performance H1.* Portfolio/brokerage import issues ~5–7 serial round-trips per staging row (dup-check SELECT, FX resolve, insert, status UPDATE) — a 2,000-row export ≈ 10,000+ serial RTTs, tens of seconds on a remote DB (`portfolioImportPipeline/commit.js:70-170`, `importPipeline/brokerageFanout.js:96-132`). **Fix:** bulk-preload dedup keys into a Set (one query) and batch status updates with `UPDATE … FROM unnest(...)` — the pattern already used in `matchInvestments.js:70-79`. Keep per-row create for atomicity.

### P2.5 — Tax FX missing-rate fallback converts 1:1 silently
*Correctness M2/M5.* For an ECB-unsupported currency, `rateToEurForDate` returns `undefined` and `convertWithRates` returns the **raw amount** as EUR with no flag (`apps/node-backend/src/services/reports/dataFetcherTax.js:154-174`) — e.g. 1000 KRW shows as 1000 EUR in the tax PDF. **Fix:** propagate a per-section "rate unavailable" flag the PDF annotates; never silently sum an unconverted foreign amount. Also normalize currency strings once (`toUpperCase().trim()`) at the loop top.

---

## Priority 3 — quality, hardening, cleanup

**Performance**
- **P3.1** Markets Overview polls per-symbol Yahoo quotes (~34 symbols) every 60s with **no cache, no governor, no dedup** (`marketLookup.js:142-161`). Add a short-TTL per-symbol cache + in-flight coalescing.
- **P3.2** Full-resolution net-worth chart over-fetches the entire multi-year daily series and filters period client-side; the downsampler has zero call sites (`NetWorthPage.tsx:38-42,82-87`, `routes/info/netWorth.js:41-44`). Scope the query by `period` server-side or downsample wide windows to a ~500-point budget.
- **P3.3** `includeTransfers=true` bypasses **all** dashboard MVs into full scans, and `getIncludeTransfers()` is an uncached `SELECT` per aggregate request. Add a transfer-inclusive MV path; memoize the setting.
- **P3.4** Research aggregator has no concurrent-request single-flight; quota check/spend straddle an await (burst overshoot); serial provider chain × 8s timeout can block ~32s (`researchAggregator.js`, `quotaGovernor.js`). Add an in-flight `Map`, reserve-and-refund quota, an overall request deadline.
- Minor: serialized `convertToCurrency` in a per-account loop (`infoRepositoryNetWorth.js:310-317`); pivot-cell closure churn (`CategoryPivotTable.tsx:286-372`); macro adapters fetch full series then trim.

**Architecture / maintainability**
- **P3.5** ADR-098/102 same-day thrash: the Unified Tax view shipped (`86bd2169`) and was removed ~8h later (`4a4573e3`) — a conclusion reachable with zero code. ADR-102 is clean, **but** `docs/adr/098-cross-workspace-features.md` still claims the unified tax view is "wired end-to-end," `docs/adr/index.md:66` still marks ADR-098 "Proposed" and lists the deleted feature as shipped, and ADR-083/088 are still "Proposed" despite shipping. Reconcile the ADR index/statuses.
- **P3.6** `snapshotBuilder.js` is a 683-line god file duplicating valuation math from `buildInvestmentSummaryCore`, kept in sync *by comment*. Extract `fxHistoryIndex`, `nonUnitValuation`, `perAccountSplit`; have non-unit valuation call the shared core.
- **P3.7** Raw SQL crept back into the service layer (`moveHoldingService`, `transferReconciliationService`, `crossWorkspaceDataService`, `snapshotBuilder`) after the accounts epic introduced a clean `accountRepository` — the repo boundary is now inconsistent.
- **P3.8** Research adapters sometimes return empty-but-successful shapes instead of throwing (`finnhubAdapter.js:44,66`, eurostat/dbnomics), which the aggregator caches as success and stops falling through — causes silent blank tabs. Standardize an `assertNonEmpty`/throw contract.
- Research pages still roll their own card chrome instead of the unified `ChartCard` (`ChartBuilderPage.tsx:541`, `ResearchComparePage.tsx:393`); `MarketLookupPage` re-declares backend types inline, outside contract-guard protection.

**Testing gaps (high-risk, currently untested)**
- `transferReconciliationService.js` (IO/dual-write/triggers), rebalance cash-cap override path, `snapshotBuilder.js`, `quotaGovernor.js`, `fxResolve.js`. (The pure transfer matcher, `rebalanceDeployment`, FX-tax point-in-time, `moveHoldingService`, projections, and `dbEditor` *are* well tested.)
- 19 test files mock the DB by substring-matching raw SQL; the `asset_class::text` cast incident (`e207a115`) is direct evidence these break on correct refactors. Move toward behavioral fixtures.

**UI/UX**
- **P3.9** Account-card "double-click to open transactions" has **no keyboard/touch path** and is undiscoverable (`AccountsPage.tsx:129-134`) — add a "View transactions" menu item (the dropdown already exists) and/or `role="button"`+Enter/Space. Same pattern on holding-name chart shortcuts.
- **P3.10** `MergeAccountDialog` is irreversible with a conditional warning and single-click confirm (`features/accounts/MergeAccountDialog.tsx:60-73`) — match the guarded delete flow (`useConfirmDialog`).
- **P3.11** Instant-apply settings (ADR-084) fail **silently** — persistence errors are only logged, no toast, no "Saved" indicator (`AppSettingsContext.tsx:62-77`); high-impact toggles (cost-basis recompute, Admin-Mode unlock) have no warning. Surface failures via the existing `sonner` toasts.
- **P3.12** a11y polish: hover-only row actions never revealed on focus (`StocksPage.tsx:440`, `CryptoPage.tsx:285`); rebalance "Compute" / import errors shown only as muted inline text, not toasts; settings nav and DB-editor cells lack full ARIA (tablist, `aria-sort`, keyboard cell-edit); heatmap "held" state and per-tile context invisible to screen readers; toggles missing `aria-pressed`/`aria-current`.
- Minor: small i18n leaks (mostly acronyms/provider data — `"PK"` aria-label, untranslated `sector`/`employmentType`, US decimal samples), a couple of raw `yellow-500` literals bypassing the `warning` token, and a few non-shared empty/error presentations.

---

## Lower-severity / informational

- **Security #2** Raw `WHERE` escape hatch in DB-editor reads (`dbEditor.js:172-178`) — read-only, timeout-bounded, no data beyond the admin's existing reach; prefer the structured `filters` allowlist.
- **Security #3** `new Function()` arithmetic in the command palette (`CommandPalette.tsx:137`) — charset-guarded to digits/operators, not exploitable; also verify it isn't dead under the Electron CSP. Prefer a shunting-yard parser.
- **Security #4** Provider-key endpoints sit on the public data plane without the admin CSRF guard (write-only, masked) — low impact for a local app.
- **Correctness** Per-sleeve rounding drift so "Total deployed" can be a cent or two off cap (`crossWorkspaceAnalytics.js:71-73` — largest-remainder fix); rebalance presets target unfillable sleeves `commodities`/`intl_stocks` (`crossWorkspaceDataService.js:23-28`); tax totals use raw float `+=` against the Decimal convention; `createAccount`/`updateAccount` responses aren't NUMERIC-coerced (latent re-crash); pure JS transfer matcher diverges from the SQL one (test-only today); `trimToRange` does month math in local time on a UTC epoch.
- **Architecture** MV-refresh fallback matches error *text* not SQLSTATE `55000`; duplicated Yahoo thumbnail helpers already drifting; asset-class taxonomy hand-synced across the PG enum + ~5 JS/TS lists.

---

## Notably good work this window

- **Enforced (not aspirational) layering** — custom ESLint rules; 0 route files import repositories.
- **Compile-time OpenAPI contract guard** keeps `api.ts` assignable to generated types; 0 drift across 210 ops, verified path-by-path.
- **Single-source money utilities** in `@vision/shared-utils` ended a prior frontend/backend rounding-mode divergence; the LTTB downsampler change was a genuine bug *fix*.
- **Exemplary post-incident migration hygiene** — the destructive 0055 auto-apply incident neutralized to a no-op, recovered idempotently by 0056, and the ADR-088 contract-phase drop moved fully out-of-band with a soak guard and lossless rollback.
- **SSRF defense** (`lib/urlSafety.js`) — scheme + private/loopback/link-local/CGNAT/metadata blocking with per-redirect-hop revalidation and a body cap; applied at the research and investment-write boundaries.
- **Electron hardening** — `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, denied window-open, navigation allowlist, CSP, subprocess env allowlist, mode-0600 `PGPASSWORD` file, IPC sender verification.
- **Solid frontend foundations** — ChartCard chrome unified, localized screen-reader chart summaries (`chartAria.ts`), tier-aware glass with reduced-transparency fallback, EmptyState broadly adopted, reduced-motion respected, the Stocks/Crypto loading→error→empty triad as a model, an i18n'd platform-aware shortcuts overlay.
- **Healthy performance defaults** — keyset/streaming transaction pagination, batched snapshot queries, `CONCURRENTLY` MV refresh with non-blocking reads, SQL-side statistics aggregation, fully lazy routes with chart libs out of the main bundle, virtualized data tables.

---

*Generated by an automated multi-dimension audit pass. Findings were verified by reading code at HEAD but should be confirmed by a maintainer before action; severities reflect a self-hosted, single-tenant, local-first deployment model (workspaces are data partitions, not security boundaries).*
