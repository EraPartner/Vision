# Bug Hunt — Round 2

Generated 2026-05-05. Source: 5-agent parallel sweep over backend, frontend, migrations, packaging/CI, tests/i18n.

Excludes everything already in `BUGHUNT_PLAN.md` (phases 0-15). Phases 0-9 already shipped (`bc28c66`, `992fb14`); phases 10-15 still tracked.

Findings tally: **9 CRITICAL · 27 HIGH · 38 MEDIUM · 14 LOW**

Approach: same as round 1 — phase by phase, smallest blast radius first, verify after each phase.

---

## Phase A — Round-2 CRITICAL (silent corruption / runtime crash)

- [ ] `apps/node-backend/src/services/prices/priceCache.js:218` — On `23503` FK violation the upsert silently calls `_dropForeignKey()` and retries. Auto-dropping a constraint on a normal write path is a self-inflicted denial of integrity: any orphan ID (caller bug, attacker-supplied investment_id) permanently strips referential integrity from `asset_price_history`. **Fix:** investigate root cause (orphan investments, failed cascade), surface a proper error, never auto-drop.
- [ ] `apps/node-backend/src/services/recurringDetectionService.js:97` — `[...amounts].sort(...)[Math.floor(amounts.length / 2)]` is wrong median for even-length arrays (returns upper-middle). Mirror the proper `_median` helper already in `priceProviderRegistry.js`.
- [ ] `apps/node-backend/src/services/importPipeline/commit.js:129-135` — Per-row catch+UPDATE inside a `withTransaction` block. After the first row error, Postgres aborts the whole txn; subsequent statements (status update, logging) execute on the aborted txn and either no-op or roll back rows that *did* commit logically. **Fix:** wrap each row in a `SAVEPOINT` (release on success, rollback to savepoint on error) or accumulate failures and let the chunk roll back as a unit.
- [ ] `apps/node-backend/src/repositories/investmentRepository.js:172-173` — Base + child `client.query` UPDATEs not wrapped in `withTransaction`. Same class as Phase 1 round-1 bugs but in a different file. If child UPDATE fails after base commits, parent/child desync.
- [ ] `apps/frontend/src/components/onboarding/OnboardingWizard.tsx:191` — `selectedCategories.map(...)` called on `Set<number>` (declared at line 153). `Set.prototype.map` does not exist — clicking *Create categories* in onboarding throws `TypeError`. **Fix:** `Array.from(selectedCategories).map(...)` or `[...selectedCategories].map(...)`.
- [ ] `apps/frontend/src/pages/TaxOverviewPage.tsx:70-72` — `stats?.totalIncome / monthlyData / yearlyComparison` always undefined. `useStatistics()` returns `{ data, unfilteredData, ... }` (`useStatistics.ts:375`), not the `StatisticsData` shape. The whole tax overview page silently displays zero income, empty monthly data, empty yearly comparison. **Fix:** read `stats.data?.totalIncome` etc.
- [ ] `alembic/versions/0018_portfolio_performance_snapshots.py:23` — `snapshot_date DATE NOT NULL UNIQUE` on a multi-currency table. `snapshotBuilder.js:343` uses `ON CONFLICT (snapshot_date) DO UPDATE` which silently overwrites cross-currency rows on the same date. **Fix:** new migration changes constraint to `UNIQUE (snapshot_date, currency)` and `ON CONFLICT (snapshot_date, currency)`.
- [ ] `alembic/versions/0018_portfolio_performance_snapshots.py:56` — Trigger `update_portfolio_performance_snapshots_computed_at` calls `update_updated_at_column()` (canonical function set at `0001:51`) on a table with no `updated_at` column. Every UPDATE / `ON CONFLICT DO UPDATE` raises `record "new" has no field "updated_at"`. **Fix:** drop the trigger or rename column to `updated_at`.
- [ ] `alembic/versions/0001_initial_database_schema.py:429` — `manual_raw_transactions.transaction_id / recipient_id / category_id` declared as plain `INTEGER` with no FK references. Orphan rows accumulate every time a parent is deleted; row-level joins silently return nulls / wrong joins. **Fix:** new migration adds `REFERENCES … ON DELETE SET NULL`.

---

## Phase B — Round-2 HIGH (correctness + data drift)

### Backend

- [ ] `apps/node-backend/src/services/portfolio/snapshotBuilder.js:165-175` — `resolvePrice` does `Object.keys(histPrices)` full scan per (day, investment): O(D·I·P). Build sorted `(day, price)` arrays per investment once, binary-search by day.
- [ ] `apps/node-backend/src/services/portfolio/portfolioSummaryService.js:209-227` — 17 `await convertToCurrency(...)` calls per investment when `invCurrency != target`. Each does `getRates()` lookup. Resolve rate once, multiply locally.
- [ ] `apps/node-backend/src/services/aiChat/tools/planned.js:281-301` — `getProjectedBalance` does not expand recurring planned txns inside the horizon window. Misses every weekly/monthly fire that *should* hit before the horizon end. Result projection wrong for any recurring bill.
- [ ] `apps/node-backend/src/services/quoteBackfillService.js:375-451` — `backfillHistoricalAssetQuotes` and `refreshActiveHoldingQuotes` await sequentially per investment + per window. With N investments × W windows = N·W serial network round-trips. Bound concurrency with `p-limit`.
- [ ] `apps/node-backend/src/services/providerHealthService.js:77-83` — `probeYahoo` builds an `AbortController` but never passes `controller.signal` to `yf.quote(...)`. Timeout fires but fetch keeps running.
- [ ] `apps/node-backend/src/routes/splits.js:104-121, 123-158` — `validateSplitAllocation` precheck then `createSplit(s)Batch` not under any lock. Two parallel POSTs both pass total-check then both insert, over-allocating beyond transaction amount. **Fix:** wrap in `withTransaction` with `SELECT t.amount FOR UPDATE`.
- [ ] `apps/node-backend/src/services/recipientPatternService.js:250-265` — `previewPatternMatches` SELECTs every active recipient with no LIMIT, filters in JS. Push regex into Postgres (`SIMILAR TO`/`~`) or batch.
- [ ] `apps/node-backend/src/services/rawTransactionImportService.js:466-473` — `getOrCreateRecipient` overwrites `notes` unconditionally; `dataImportService.js:102-103` guards on `!recipient.notes`. Inconsistent — re-imports clobber existing notes.
- [ ] `apps/node-backend/src/repositories/recipientBankAccountRepository.js:141-156` — `setPrimary` issues two UPDATEs without a transaction. Concurrent calls can leave zero or two primaries.
- [ ] `apps/node-backend/src/services/aiChat/tools/insights.js:126-176` — `getRecipientInsights` pulls 50000 transactions then filters by recipientId in JS. Push `WHERE recipient_id = $1` into the repo call. Same anti-pattern as already-tracked `tools/expenses.js`.
- [ ] `apps/node-backend/src/services/importPipeline/adapters/_shared.js:32-34` and `wise.js:13` and `generic.js:86` — `parseCommaDecimal` / raw `parseFloat` paths. `'1.234,56'` becomes `1.234` for Belgian-format Wise CSV and the `balance` column in generic.js. **Fix:** route every adapter through `parseAmountField`.

### Frontend

- [ ] `apps/frontend/src/components/portfolio/AddPortfolioTxnDialog.tsx:22`, `EditPortfolioTxnDialog.tsx:25-37`, `PortfolioTaxAdjustmentsDialog.tsx:46-50` — `parsePositive` uses raw `Number(value)` instead of `parseDecimal`. EU users (numberFormat=eu) typing `1234,56` get NaN. Same root cause as Phase 2 round-1 (already fixed elsewhere); these sites missed.
- [ ] `apps/frontend/src/components/portfolio/AddInvestmentFromMarketDialog.tsx:136` — `if (!amount || isNaN(amount))` rejects `amount === 0` (falsy). `parseDecimal` returns 0 on parse fail, so legit zero and unparseable string both surface "amount required" — masks parse error and rejects valid 0. Use explicit `amount <= 0` distinct from parse failure.
- [ ] `apps/frontend/src/components/dashboard/CategoryPieChart.tsx:27` — `tooltipValueFormat` formats transaction count as currency (`DashboardPage.tsx:285` builds `categoryData.value = cat.count`). Format as integer or rename data shape.
- [ ] `apps/frontend/src/hooks/useWidgetVisibility.ts:13` — Module-level `cachedVisibility` and `listeners` shared across all consumers. Race when multiple components mount before initial fetch resolves; `saveTimerRef` from one consumer keeps firing if another unmounts. Move state into provider context or per-`pageKey` scope.
- [ ] `apps/frontend/src/contexts/AppSettingsContext.tsx:60-77` — `isFirstRender.current` gate against persisting on initial hydration is fragile. The preload "no value" path persists `DEFAULT_APP_SETTINGS` back to backend, polluting state. Guard with `isLoading || !preloaded` before scheduling save.
- [ ] `apps/frontend/src/components/notifications/UpcomingPaymentsNotification.tsx:62-64` — `today/nextWeek` computed from `new Date()` outside `queryFn`; pinned at first load. With `staleTime: 5min` the query goes stale across midnight. Pin date inside `queryFn` or include in `queryKey`.
- [ ] `apps/frontend/src/components/portfolio/WatchlistChartDialog.tsx:62, 80-83` — Raw `fetch().json()` returns the envelope, not `data`. Component reads `.quotes?.[0]` from envelope → undefined. Plus the fetch URL doesn't `encodeURIComponent` the symbol. **Fix:** migrate to `apiRequest`.
- [ ] `apps/frontend/src/utils/currency.ts:184-198` — `formatAmountWithSymbol` always `Math.abs(amount).toFixed(2)`. Strips sign on negatives, hardcodes 2 decimals (ignores user's `showDecimalPlaces`).
- [ ] `apps/frontend/src/pages/PlannedPaymentsPage.tsx:160-180` — `<span>` containing `<div>` is invalid HTML. Browser auto-closes the span, breaking the line-through styling on inner content.
- [ ] `apps/frontend/src/components/portfolio/InvestmentDetailDialog.tsx:433, 437` — `txn.units && (...)` truthy check skips `units === 0`; `txn.amount / txn.units` divides without zero-guard, can yield `Infinity`/`NaN` in UI.
- [ ] `apps/frontend/src/components/charts/AreaChart.tsx:115` — `xAccessor` inline in `useMemo` deps. Every parent render with inline accessor rebuilds `xValues`, scale memos recompute, whole chart re-renders.
- [ ] `apps/frontend/src/components/dashboard/CashFlowForecastChart.tsx:77-78` — Default `excludedCategoryIds = []` / `excludedRecipientIds = []` allocate new arrays every render. When caller omits prop, `queryKey` changes each render → infinite refetch loop. Module-level `EMPTY_ARRAY` const.
- [ ] `apps/frontend/src/pages/TaxOverviewPage.tsx:476` and `apps/frontend/src/components/shared/PageError.tsx:15` — Hardcoded English strings ("Federal PIT after reductions", "Communal surcharge", "Total burden", "Manual input needed", "Something went wrong", "Try again") leak into Dutch UI. Move to i18n keys.

### Migrations / DB

- [ ] `alembic/versions/0001_initial_database_schema.py:189` — Monetary precision drift: `transactions.amount NUMERIC(15,2)` vs `portfolio_transactions.amount NUMERIC(18,4)` vs `import_staging_rows.amount NUMERIC(20,4)`. Staging→commit truncates; cross-table math loses precision. Standardize on `NUMERIC(18,4)`.
- [ ] `alembic/versions/0001_initial_database_schema.py:504` — `asset_price_history.investment_id NOT NULL` lacks FK to `investments(id)`. Orphan price rows survive deletes; same root as the priceCache auto-drop bug above.
- [ ] `alembic/versions/0004_attachments.py:29` — `attachments.transaction_id BIGINT` references `transactions.id` which is `SERIAL` (int4). Type drift; every other FK to transactions uses INTEGER.
- [ ] `alembic/versions/0006_portfolio_event_types.py:37` — Downgrade SETs `type=NULL` on `portfolio_transactions` but baseline declares `type NOT NULL`. Downgrade fails on any populated DB.
- [ ] `alembic/versions/0007_bank_reconciliation.py:30, 91` — `CREATE TYPE ... ENUM` and `CREATE TRIGGER ...` without `IF NOT EXISTS` / `EXCEPTION WHEN duplicate_object`. Partial-rerun fails. Same gap also exists in `0013_cashflow_forecast_mc.py:23`.
- [ ] `alembic/versions/0001_initial_database_schema.py:264` — `transaction_raw_references.transaction_id` is `UNIQUE` — implies 1:1 — but a single transaction can have multiple raw sources (CSV+API). Confirm intent or change to `UNIQUE (transaction_id, raw_source_type, raw_source_id)`.
- [ ] `alembic/versions/0019_transaction_splits_and_agg.py:24, 38` — `transaction_splits.amount` and `split_payments.amount` lack `CHECK (amount > 0)` despite the app invariant (`portfolioTxRepo.common.js:131,183`). DB cannot prevent negative/zero splits if app bypassed.

### Electron / packaging

- [ ] `packaging/electron/main.js:1902-1908` — `runBundleRestore` atomic-swap fires AFTER the function returns success — the Promise chain runs detached, so a swap failure leaves `attachments.staging` un-swapped while the user is told restore succeeded. Await the swap inside the function, surface the failure.
- [ ] `packaging/electron/main.js:2150` — `backup:restore` IPC handler has no `senderFrame` validation. Any preload-exposed channel that XSS-injected renderer hits gets to drop+recreate the production database from any picker-blessed path. Add `event.senderFrame` check + UI-confirmed gate.
- [ ] `packaging/electron/main.js:1819, 1845` — `psql -c 'DROP DATABASE "${dbName}" / CREATE DATABASE … OWNER "${dbUser}"'` and `docker run -e PGPASSWORD=${dbPass}` paths interpolate identifiers into a shell string. `validateIdentifier` blocks the typical case; missing/malformed `.env` bypasses it. `PGPASSWORD` also leaks into `docker inspect` / `ps` output. **Fix:** use `psql -v ON_ERROR_STOP=1` with quoted identifiers via `\setvar`, pass password via `--env-file` (mode 0600, deleted after).
- [ ] `packaging/electron/main.js:1116` — `compareVersions` parses dot-split with `parseInt` and silently drops prerelease/build metadata. `1.2.3-rc.1 == 1.2.3` → updater can install older "stable" over newer rc. Use `semver` lib.
- [ ] `packaging/electron/main.js:1371` — `ditto` extraction of the downloaded ZIP without per-entry path-traversal validation. ditto follows `../` and absolute paths in headers. Validate entries before extraction.
- [ ] `packaging/electron/main.js:1322` — `tempRoot` is never cleaned on the success path (only `zipPath` unlinked on errors). Installer + extracted zip leak in `/tmp` until OS purge.
- [ ] `packaging/electron/main.js:347` — `dockerEnv` extends PATH but inherits **all** of `process.env` including any secret. Leaked to every spawned `docker` / `pg_dump` / installer subprocess. Whitelist (PATH, DOCKER_HOST, HOME, PORT, PGPASSWORD, …).
- [ ] `packaging/electron/main.js:1199` — Installer script runs `bun install` from updated `$DEST_ROOT` — runs `postinstall` lifecycle scripts. Compromised release ZIP can run arbitrary code. Use `bun install --ignore-scripts`.

### Cross-cutting / docs

- [ ] `docs/reference/api-endpoint-matrix.md:1` vs `openapi.yaml:1` — 149 endpoints in matrix vs 21 paths in `openapi.yaml`. Massive drift on AI / aggregations / recipients / imports / info / portfolio. Regenerate openapi.yaml from route handlers or document the scope split.
- [ ] `apps/node-backend/src/utils/portfolioMath.js:1` (528 lines, FIFO/LIFO/accruedInterest, money math) and `apps/node-backend/src/services/portfolio/snapshotBuilder.js:1` (363 lines) — zero unit tests. Phase 5 + Phase 6 round-1 fixes ship without regression coverage. Add tests covering FIFO `sellRatio` scaling, LIFO oversell, accruedInterest UTC day-diff, snapshot UTC increment + DST.
- [ ] `apps/node-backend/src/services/importPipeline/commit.js, match.js, stage.js, validate.js` — `IMPORT_PIPELINE_V2` defaults true in `env.js:89`; the entire pipeline ships with zero unit tests.

---

## Phase C — Round-2 MEDIUM (perf + design)

### Backend perf

- [ ] `apps/node-backend/src/utils/portfolioMath.js:145, 165-168, 223, 243-246` — FIFO/LIFO build new lots arrays via spread on every buy / partial sell. O(n²) total. Mutate in place or use a deque.
- [ ] `apps/node-backend/src/services/importPipeline/match.js:111-145` and `validate.js:33-55` — Per-row UPDATE inside `withTransaction`. 1000 rows = 1000 UPDATEs. Build VALUES table, single `UPDATE FROM (VALUES …) v WHERE id = v.id`.
- [ ] `apps/node-backend/src/services/calculations/forecast/methods/ensemble.js:67-72` — `m.series.find` per `forecastDate` is O(M·N). Pre-build `Map<date, value>` per method once.
- [ ] `apps/node-backend/src/services/attachmentService.js:86` — `mkdirSync` (sync I/O) inside async `storeAttachment` hot path. Use `fsPromises.mkdir`.
- [ ] `apps/node-backend/src/routes/transactions.js:273-289, 319-342` — CSV/NDJSON export uses chunked OFFSET pagination. OFFSET grows linearly per chunk on large filtered sets. Switch to keyset pagination on `(t.date, t.id)`.
- [ ] `apps/node-backend/src/repositories/investmentRepository.js:128` — `ensureSymbolIsUnique` uses `LOWER(symbol)=LOWER($1)` — defeats any plain symbol index. Use `citext` column or expression index on `lower(symbol)`.
- [ ] `apps/node-backend/src/services/filterBuilder.js:151-169` — Search WHERE includes `CAST(t.amount AS TEXT) ILIKE`. Forces seq scan on every transaction. Drop or gate behind explicit `amount`-search mode.
- [ ] `apps/node-backend/src/repositories/aiChatRepository.js:98-106` — `getMessages` no LIMIT. Long conversations stream the full history every turn. Add LIMIT + window-trim by recency.
- [ ] `apps/node-backend/src/services/prices/priceProviderRegistry.js:388-473` — `PROVIDERS.custom` and `.kinesis` serial `for...of` with awaits. Parallelize with bounded concurrency.
- [ ] `apps/node-backend/src/main.js:646-654` — Hourly `setInterval` calls `refreshActiveHoldingQuotes` which is itself sequential per investment+window. Long runs can overlap with next tick. Add inflight guard.
- [ ] `apps/node-backend/src/services/recipientClusterService.js:36-82` — SELECT all active primary recipients with no LIMIT before bucketing in JS. Push first-N-chars bucket key into SQL.
- [ ] `apps/node-backend/src/services/aiChat/tools/tax.js:78-84, 277-302` — `getTaxableIncomeSummary` and `getDeductibles` fetch `limit 100000` rows for in-JS sum / keyword filter. Push `SUM` and category filter into SQL.
- [ ] `apps/node-backend/src/repositories/portfolioTxRepo.reads.js:27` — `where.replace(/\binvestment_id\b/g, 'pt.investment_id')` is brittle string-rewrite. Have `buildListWhereClause` emit aliased columns directly.
- [ ] `apps/node-backend/src/repositories/recipientBankAccountRepository.js:55-113` — `getByAccountNumber` + INSERT not under transaction. Two concurrent calls both see "no existing" then INSERT — second hits unique constraint. Wrap in `withTransaction` or rely solely on `ON CONFLICT`.
- [ ] `apps/node-backend/src/services/streamingImportService.js:123-141` — Fire-and-forget INSERT into `recipient_bank_accounts` and UPDATE notes. Errors logged but recipient row already returned. If account insert is critical, await.

### Backend design / smaller bugs

- [ ] `apps/node-backend/src/services/portfolio/portfolioSummaryService.js:211` — `convert(Math.abs(totalInvested))`. Taking abs hides negative net invested (sells > buys). Caller can't distinguish cashed-out positions.
- [ ] `apps/node-backend/src/routes/info/_performanceHelpers.js:48-54` — `cutoff.setDate` uses local TZ math but compares ISO `YYYY-MM-DD`. Off-by-one in non-UTC zones. Use `setUTCDate`.
- [ ] `apps/node-backend/src/repositories/splitRepository.js:160-162` — Subquery `SUM(amount) FROM split_payments GROUP BY split_id` runs over the whole payments table to attach to one transaction's splits. Push to outer query as `LEFT JOIN LATERAL` on `ts.id`.
- [ ] `apps/node-backend/src/middleware/rateLimiter.js:15` — Cleanup interval hardcoded to 60000ms. Any limiter with `windowMs > 60000` evicts entries before window expires. Read max from registered limiters.
- [ ] `apps/node-backend/src/services/deduplication.js:31-33` — `isDuplicate` uses `UPPER(name)` subquery — defeats normalized_name index. Use `normalized_name` like `rawTransactionImportService`.
- [ ] `apps/node-backend/src/repositories/infoRepositoryHelpers.js:19-29` — `mvAvailable` false-result not cached. Every call re-queries until view first has data. Cache both true and false with short TTL.
- [ ] `apps/node-backend/src/middleware/requestMetrics.js:50-53` — Reservoir `bucket.sampled` counter increments unbounded across the 15min window. Cap or roll over per bucket.

### Frontend

- [ ] `apps/frontend/src/components/dashboard/CategoryPieChart.tsx:18` — `coloredData = data.map(...)` not memoized. New array each render.
- [ ] `apps/frontend/src/hooks/useChartCurrencyFormatter.ts:25-34` — `formatCurrency` and `formatCompact` are new function refs every call, breaking memoization in consumers.
- [ ] `apps/frontend/src/hooks/useConfirmDialog.tsx:49-72` — `ConfirmDialog` is a `useCallback` returning JSX; rendering `<ConfirmDialog />` recreates the component each render, defeating memo. Also if component unmounts mid-confirm the promise never resolves → leak.
- [ ] `apps/frontend/src/components/charts/Sparkline.tsx:51-52`, `AreaChart.tsx:128, 163`, `LineChart.tsx:102, 126`, `WatchlistChartDialog.tsx:145` — `Math.min(...data)` / `Math.max(...data)` spread call-stack overflow on very large arrays. Use `data.reduce((a, b) => Math.min(a, b))`.
- [ ] `apps/frontend/src/components/charts/AreaChart.tsx:214` — `'area-grad-' + Math.random()` for SVG gradient id. Use `useId()`.
- [ ] `apps/frontend/src/components/dashboard/BankBalancesWidget.tsx:159` — `style={{ ringColor: color }}` is not a valid CSS property; React silently ignores. Use `boxShadow` or `--tw-ring-color` CSS var.
- [ ] `apps/frontend/src/components/ui/sidebar.tsx:74-84` — Global `window.addEventListener("keydown")` for Cmd/Ctrl+B. Fires from inputs / textareas / Electron menus. Scope to non-input target.
- [ ] `apps/frontend/src/components/statistics/CustomCategoryChart.tsx:188, 204` — `Math.round(cat.months[period] || 0)` rounds money to integers (off by up to 0.5 per row); `yTick = (v) => '${cur}${(v / 1000).toFixed(0)}k'` shows `0k` for amounts below 500. Use compact formatter.
- [ ] `apps/frontend/src/contexts/LanguageContext.tsx:68-79` — `useEffect` deps include the full `dicts` object — every dict load triggers re-run for unloaded languages. Use `dicts[language]` boolean as dep.
- [ ] `apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx:158-191` — 30-day sparkline uses `86_400_000` ms over local-time math. DST transition shifts day index. Use UTC math throughout.
- [ ] `apps/frontend/src/lib/api/sse.ts:122-126` — Invalid SSE JSON payload throws "Invalid SSE payload" — kills the entire stream for one bad frame. Skip the frame.
- [ ] `apps/frontend/src/components/dashboard/CashFlowForecastChart.tsx:89-94, 117-187` — `rollingDays` defaults via IIFE re-parsed every render; three `useQuery` calls share unstable `excluded*` array refs from parent → all three refetch in parallel each render. Wrap defaults in `useMemo`.

### Migrations / DB design

- [ ] `alembic/versions/0012_cashflow_forecast_accuracy.py:27` and `0013_cashflow_forecast_mc.py:26` — `as_of_month TEXT` / `month TEXT` instead of DATE prevents indexable date math; `mae/rmse/mape DOUBLE PRECISION` for percentage metrics. Use `DATE` and `NUMERIC(10,4)`.
- [ ] `alembic/versions/0010_add_provider_health.py:24`, `0017_saved_charts_recipients_variants.py:26`, `0021_split_audit.py:26` — Enum-like `TEXT/VARCHAR` columns (`kind`, `chart_variant`, `time_bucket`, `action`) lack `CHECK` constraints. Add CHECK or use enum types.
- [ ] `alembic/versions/0001_initial_database_schema.py:637` — `import_staging_rows` lacks `UNIQUE (batch_id, tx_hash)` despite app using tx_hash for dedup within a batch.
- [ ] `alembic/versions/0001_initial_database_schema.py:523` — `portfolio_transactions.fees / taxes NUMERIC(18,4) DEFAULT 0` are nullable. App always supplies values. Add NOT NULL.
- [ ] Redundant left-prefix indexes — drop in a single migration:
  - `0001:698` `idx_transactions_recipient_id`, `_category_id`, `_bank_account` (covered by `_recipient_date`, `_category_date`, `_bank_date`).
  - `0001:725` `idx_pte_planned_id` (covered by `uniq_pte_planned_executed`).
  - `0001:730` `idx_ptls_planned_transaction_id` (covered by `uq_ptls_planned_installment`).
  - `0012:38` `idx_cfa_user_method` (covered by `uq_cfa_user_method_month`).
  - `0013:35` `idx_cfmc_user_month` (covered by `(user_id, month, filter_hash)` UNIQUE).
  - `0018:44` `idx_portfolio_performance_snapshots_date` (covered by `snapshot_date UNIQUE`).
- [ ] Boolean-only indexes — replace with partial indexes:
  - `0001:719` `idx_pt_is_active / _is_executed / _is_recurring / _is_loan` → `WHERE is_active = true` on `(date)`, etc.
  - `0001:777` `idx_exchange_rates_latest` → partial `WHERE is_latest = true` on `(currency_code)`.

### Electron / CI

- [ ] `packaging/electron/main.js:1226` — `readGitHubRelease` no timeout, no rate-limit retry, JSON.parse throws on empty body. Set `req.setTimeout`, fallback on 5xx.
- [ ] `packaging/electron/main.js:1517, 1532` — `httpGet` / `httpPut` parse JSON without try/catch around `res.on('end')`; empty body resolves as parse error. Wrap with try/catch.
- [ ] `packaging/electron/main.js:1448` — `installPreparedShellUpdate` sets `isQuitting=true` + `setImmediate(app.quit)` after spawning installer — if installer file fails to launch, app already quits. Wait for `spawn.on('spawn')` first.
- [ ] `packaging/electron/main.js:1499` — `applyDockerImageUpdate` is dead code — never called. Remove or wire into `update:pull-image`.
- [ ] `packaging/electron/main.js:2244` — `backup:save-settings` IPC has no schema validation on `backupDir` (could be non-string, system dir like `/etc/cron.daily`). Validate at save time.
- [ ] `.github/workflows/release.yml:138` — Docker push `cache-to: type=gha,mode=max` caches multi-platform layers, can blow the 10GB GitHub Actions cache budget. Cap with `scope=release`.

### Cross-cutting

- [ ] `apps/frontend/vite.config.ts:128` — Vitest coverage thresholds 17/11/10/18 are far below project-mandated 80%. Either ratchet incrementally or document an ADR exception.
- [ ] `apps/node-backend/vitest.config.js:9` — Backend has no coverage thresholds at all.
- [ ] `apps/frontend/playwright.config.ts:31` — Only `chromium` configured; project rule mandates Chrome+Firefox+Safari minimum.
- [ ] `apps/frontend/tsconfig.app.json:25` — `noUncheckedIndexedAccess` not enabled. Would have caught Phase 5 round-1 portfolioMath sellRatio bugs at compile time.
- [ ] Direct `process.env.*` reads bypass `config/env.js` Zod schema:
  - `apps/node-backend/src/main.js:449` (`VISION_BOOT_TRACE`)
  - `apps/node-backend/src/services/streamingImportService.js:46` (`DB_POOL_SIZE`, `DB_MAX_OVERFLOW`)
  - `apps/node-backend/src/database/migrate.js:21` (`ALEMBIC_BIN`, `ALEMBIC_CONFIG`, `VISION_CACHE_DIR`)
  - `apps/node-backend/src/services/reports/puppeteerRenderer.js:21` (`PUPPETEER_EXECUTABLE_PATH`)
- [ ] `apps/frontend/src/locales/nl.ts:1` — ~50 nl entries identical to en. Several are missed translations (`tax.pit.table.component "Component"` → `Onderdeel`, `invDetail.trigger "Details"`, `addCat.detail "Detail"`).
- [ ] `apps/frontend/stryker.config.json:28` — `thresholds.break=null` disables CI failure on mutation regressions; `packageManager` set to `npm` while project uses bun.
- [ ] `scripts/auto-translate-nl.js`, `auto-translate-nl-pass2.js`, `sync-nl-with-en.js`, `locales-capitalizer.js` — All use cwd-relative paths and don't anchor to `__dirname`. Two are dead one-shot migration scripts that should be moved to `docs/migrations/` or deleted.
- [ ] `config/eslint.config.js`, `config/tsconfig.json`, `config/config.py` — Dead orphan configs in `config/`. Backend/frontend each have their own; nothing imports these. Delete.
- [ ] `packages/types/src/api.d.ts` — Shared API envelope contract has no tests. Add a `fixtures.ts` that `tsc`-validates `ApiSuccess / ApiFailure / ResponseMeta`.

---

## Phase D — Round-2 LOW

- [ ] `apps/node-backend/src/middleware/requestMetrics.js:71-75` — Percentile uses ceil-based ranking; document or switch to linear interp.
- [ ] `apps/node-backend/src/services/calculations/forecast/methods/holtWinters.js:93-105` — 81-point grid search per call; smaller grid + local refine.
- [ ] `apps/node-backend/src/services/aiChatService.js:46-50` — `parseToolCallArguments` returns raw string on JSON.parse fail — silent type coercion at call site.
- [ ] `apps/node-backend/src/lib/csv.js:21-27` — `escapeCsvValue` doesn't quote on `\t` / `\r` mid-value. Excel may interpret tab as separator.
- [ ] `apps/frontend/src/lib/api/client.ts:39` — Backoff cap silently truncates jitter.
- [ ] `apps/frontend/src/components/dashboard/CashFlowForecastDiagnostics.tsx:153` — `Math.max(...Array.from(inverseWeights.values()))` spread on Map values — same call-stack risk pattern.
- [ ] `apps/frontend/src/contexts/SettingsPreloadContext.tsx:36` — `apiClient.getSettings()` once on mount with no retry on transient failures.
- [ ] `apps/frontend/src/components/portfolio/EditInvestmentDialog.tsx:81` — Validation toast on `unitBased && !form.symbol.trim()` but symbol field already `required` — duplicate error path.
- [ ] `apps/frontend/src/components/portfolio/EditPortfolioTxnDialog.tsx:155` — Validation `effectiveAmount <= 0` rejects zero — inconsistent with `parseNonNegative` allowing 0.
- [ ] `apps/frontend/src/components/dashboard/NetSummaryCard.tsx:36-39` — Inline `chartData.map` not memoized.
- [ ] `apps/frontend/src/components/ui/sidebar.tsx`, `pagination.tsx` — sr-only English strings for screen readers; minor a11y i18n gap.
- [ ] `apps/node-backend/src/config/env.js:93` — `passthrough()` lets typos pass silently (e.g. `env.PROT` reads undefined).
- [ ] `apps/node-backend/eslint.config.js:124, 136` — `vision-local/no-repo-direct-from-route` and `vision-local-money/no-raw-money-arithmetic` set to `warn`; promote to `error` after cleaning existing violations.
- [ ] `config/alembic.ini:1` — Split between root shim and `config/` canonical duplicates ~70 lines; cwd determines which is read. Consolidate to `config/` + symlink at root.

---

## Cross-cutting themes

1. **Money parsing**: Phase 2 round-1 fix (`parseDecimal` → `parseLocaleNumber`) addressed the central util but multiple feature dialogs and CSV adapters call `Number(...)` / `parseFloat(...)` directly. Sweep should be holistic — grep for `parseFloat` and `Number(` against form/import code.
2. **Transaction atomicity**: Phase 1 round-1 fixed three sites; round-2 found two more in the *same* pattern (`investmentRepository.js:172`, `recipientBankAccountRepository.js:141`). Worth a one-shot grep for `client.query(...UPDATE` / `BEGIN` outside `withTransaction`.
3. **N+1 + serial-await**: At least 8 distinct sites still doing per-row `await` over collections (quote backfill, providers, AI tools, currency backfill). One round-of-changes touch with `p-limit` + bulk SQL.
4. **Snapshot table 0018 has two CRITICAL bugs** (UNIQUE constraint + trigger). Fix both in a single follow-up migration; don't ship more snapshot writes until done.
5. **Tests**: critical money math + import pipeline has zero tests. Every Phase-5/6/7 round-1 fix shipped without regression coverage. Earmark a sprint to retroactively cover.

---

## Sequencing recommendation

| Phase | Effort | Risk |
|------:|:-------|:-----|
| A (CRITICAL) | 1d | Medium — touches DB schema, IPC, money math |
| B-backend | 1d | Low |
| B-frontend | 1d | Low |
| B-migrations | 0.5d | Medium — new migrations + downgrade test |
| B-electron | 1d | Medium — re-test packaged .dmg |
| B-cross | 0.5d | Low |
| C (MEDIUM) | 2-3d | Low |
| D (LOW) | 1d | Low |

**Round-2 CRITICAL track ≈ 1 day. Full round-2 ≈ 1 week.**

After Phase A: rebuild .dmg, smoke-test Electron, run `bun run test:all`, then invoke `vision-kb-updater`.
