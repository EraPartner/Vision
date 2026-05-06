# Bug Hunt — Round 3

Generated 2026-05-06. Source: 3-agent parallel sweep (backend, frontend, WIP-fix verification) over surfaces NOT covered in `BUGHUNT_PLAN_2.md`.

Excludes everything in `BUGHUNT_PLAN.md` and `BUGHUNT_PLAN_2.md`. Verified against the WIP fixes already in the working tree (Phase A/B of round 2).

Findings tally: **1 CRITICAL · 19 HIGH · 25 MEDIUM · 9 LOW**

Approach: same as prior rounds — phase by phase, smallest blast radius first.

---

## Phase A — Round-3 CRITICAL

- [ ] `apps/node-backend/src/services/streamingImportService.js:179` — Generic CSV importer's `INSERT INTO transactions … ON CONFLICT DO NOTHING` references no unique constraint that covers field-based dedup. Postgres either errors (no matching arbiter) or silently no-ops, and downstream `transaction_raw_references` rows then point at non-existent transaction ids. **Fix:** drop the bogus `ON CONFLICT DO NOTHING`; rely on the upstream `isRawDuplicate` / `isDuplicateByFields` precheck.

## Phase B — Round-3 HIGH

### Backend

- [ ] `apps/node-backend/src/services/streamingImportService.js:177` — `txData.date.toISOString()` throws if `date` is null/undefined (adapter parse failure), aborting the row before the dedup path. **Fix:** `instanceof Date` guard; reject row with structured error.
- [ ] `apps/node-backend/src/services/streamingImportService.js:122` — Recipient bank-account INSERT and notes UPDATE are fire-and-forget after `getOrCreateRecipient` returns; warning log only on failure. **Fix:** await both writes (or batch them in the recipient upsert transaction).
- [ ] `apps/node-backend/src/services/materializedViewService.js:31` — `mv_monthly_summary` is `DROP MATERIALIZED VIEW IF EXISTS` then recreated on every backend startup, wiping the cached aggregate and forcing a cold scan over `transactions` at boot. **Fix:** `CREATE MATERIALIZED VIEW IF NOT EXISTS`; only DROP via a one-shot migration when the column list changes.
- [ ] `apps/node-backend/src/repositories/plannedTransactionRepository.js:416` — `getForForecast(_months)` ignores its `months` argument and returns every active, unexecuted planned txn with no horizon filter. **Fix:** `WHERE pt.planned_date <= CURRENT_DATE + INTERVAL '$1 months'`; include recurring rows whose start ≤ horizon.
- [ ] `apps/node-backend/src/database/connection.js:91` — `queryPrepared` overwrites `preparedStatements.set(name, text)` on every call (Map never read) and re-sends `text` every invocation. No actual caching benefit; Map grows unboundedly per distinct `name`. **Fix:** cache+omit `text` after first call per pool/connection, or remove the Map.
- [ ] `apps/node-backend/src/services/recurringDetectionService.js:259` — Top-level `try/catch` swallows DB errors and returns `{ patterns: [], total: 0 }`, masking outages from callers and the AI insight tool. **Fix:** rethrow or propagate failure status.
- [ ] `apps/node-backend/src/repositories/attachmentRepository.js` + `apps/node-backend/src/routes/attachments.js:120` — DELETE handler removes the file before deleting the DB row with no transaction. If `deleteById` fails the FS file is gone but the DB row still claims it exists. Also the `download` endpoint enforces no ownership/auth check. **Fix:** wrap both writes in `withTransaction` (delete row first, then unlink); add ownership guard on `/attachments/:id/download` if multi-tenant.
- [ ] `apps/node-backend/src/services/quoteBackfillService.js:542` — `cleanupStaleQuotes` builds open-window upper bound from UTC `new Date().toISOString().slice(0,10)`. For users west of UTC late in the day this can be one day behind local "today" and delete same-day quotes. **Fix:** use `toAppTz` helper.
- [ ] `apps/node-backend/src/repositories/settingsRepository.js:32` — `ensureUserSettingsTable` issues raw `CREATE TABLE IF NOT EXISTS user_settings` from app code, violating ADR-027 ("Alembic is single source of schema DDL"). Schema drift risk. **Fix:** drop runtime DDL; require Alembic migration.
- [ ] `apps/node-backend/src/services/recipientPatternService.js:283` — `previewPatternMatches` ships JS-flavoured regex (escaped via `\\$&`) to Postgres POSIX `~`/`~*`. POSIX ERE doesn't support JS-specific tokens (`\d`, `\b`, lookaheads), so preview count diverges from runtime matching and can throw `invalid regular expression`. **Fix:** for `pattern_kind === 'regex'`, run preview through JS `compilePattern` instead of POSIX.
- [ ] `apps/node-backend/src/services/providerHealthService.js:80` — `yf.quote(...)` does not accept an AbortSignal in its third arg in most published `yahoo-finance2` versions. If the lib ignores it, the timeout becomes dead code (existing fix may not actually wire). **Verify:** check installed version's typings; if unsupported, wrap in `Promise.race` against a timeout reject.

### Frontend

- [ ] `apps/frontend/src/contexts/WorkspaceContext.tsx:44` — `writeWorkspace(workspace)` is a side-effect (sessionStorage write) called during render, not in `useEffect`. Violates React purity; can fire repeatedly during concurrent render attempts. **Fix:** move to `useEffect` with `workspace` dep.
- [ ] `apps/frontend/src/pages/MarketLookupPage.tsx:590` — `<a href={article.link}>` renders external news URL with no validation. A `javascript:` URI from a compromised feed = XSS. **Fix:** `isValidUrl(article.link)` guard; fall back to non-link span.
- [ ] `apps/frontend/src/pages/ImportReviewPage.tsx:90` — `numberFormatToLocale(appSettings?.numberFormat ?? "en-US")` uses `"en-US"` as fallback, but valid keys are `eu`/`us`/`ch`/`in`. Fallback never matches. **Fix:** use `'us'` or omit `??`.
- [ ] `apps/frontend/src/pages/ImportReviewPage.tsx:311` — `groupKey = String(group.recipient_id ?? "__unresolved__")`. All unresolved groups share the same React key → wrong accordion expansion / row state bleed. **Fix:** suffix with index/row id.
- [ ] `apps/frontend/src/pages/ImportReviewPage.tsx:410` — `formatCurrency(Math.abs(Number(row.amount)), ...)` strips sign; only color distinguishes income vs expense. Fails for color-blind users. **Fix:** render explicit sign or trend icon.
- [ ] `apps/frontend/src/lib/api/attachments.ts:27-31` — `uploadAttachment` uses raw `fetch`, not `rawFetch`. No timeout, ignored by `cancelAllRequests()`. Hung upload survives logout/route change. **Fix:** wrap in `rawFetch`.
- [ ] `apps/frontend/src/components/portfolio/AddInvestmentFromMarketDialog.tsx:61` — `currency: quote.currency === 'USD' ? 'USD' : 'EUR'` collapses every non-USD market into EUR (GBP/JPY/CHF/CAD/AUD…). **Fix:** use `quote.currency` directly.
- [ ] `apps/frontend/src/utils/forecastMerge.ts:328` — `new Date(\`${date}T00:00:00\`)` parses as local time → users east of UTC see forecast dates shifted one day. **Fix:** `parseLocalDateFromYmd(date)` from `dateUtils`.
- [ ] `apps/frontend/src/components/dashboard/CashFlowForecastChart.tsx:208` — Same TZ pinning: `new Date(monthQuery.data.month + "-01T00:00:00")` → month-name off-by-one at boundary. **Fix:** YMD parser.
- [ ] `apps/frontend/src/contexts/BelgianTaxProfileContext.tsx:176` — Provider value object built inline → new ref every render → every consumer re-renders. **Fix:** `useMemo`.
- [ ] `apps/frontend/src/components/shared/ErrorBoundary.tsx:29` — `process.env.NODE_ENV !== "production"` in browser bundle. Vite covers this in client code, but inside the boundary's render path a future build-strip miss = `ReferenceError` that crashes the boundary itself. **Fix:** `import.meta.env.DEV`.

## Phase C — Round-3 MEDIUM

### Backend

- [ ] `apps/node-backend/src/services/recipientPatternService.js:54` — `compilePattern` cache key is `${id}:${updated_at}`; excludes `pattern_kind`/`case_sensitive`/`pattern`. Row whose `updated_at` is unchanged but kind/case-sensitivity flipped returns stale regex. **Fix:** include full pattern signature in key.
- [ ] `apps/node-backend/src/routes/transactions.js:386` — `recordManualRawTransaction` awaited after `transactionRepository.create` with no transaction wrapping the two writes. Crash between writes leaves transaction visible but dedup record missing. **Fix:** single `withTransaction`.
- [ ] `apps/node-backend/src/routes/admin.js:48` — `fetchLatestRelease` accumulates GitHub response body via `body += chunk` with no cap. Hostile redirect chain returning gigabytes can OOM. **Fix:** cap buffered body (~1 MB), reject non-JSON Content-Type before parsing.
- [ ] `apps/node-backend/src/services/currency/currencyConversionService.js:154` — `warmCache` does `Object.assign(FALLBACK_RATES, mergedRates)`, mutating the exported "constant". Downstream consumers can observe values changing; test fixtures break. **Fix:** keep `FALLBACK_RATES` immutable; store live rates separately.
- [ ] `apps/node-backend/src/services/currency/currencyConversionService.js:251` — `convertRowsToEur` resolves both legs of every row sequentially in `for...of` loop with two awaits each. Serializes thousands of historical-rate lookups. **Fix:** group by `${currency}:${rowDate}`; resolve all rates in batched SQL or `Promise.all`.
- [ ] `apps/node-backend/src/services/calculations/aggregation/sankey.js:42` — `excludedCategoryIds`/`excludedRecipientIds` interpolated into SQL `ANY($N)` array without `validateInt4Ids` filter. Also exclusion only matches `t.category_id`/`r.default_category_id`, ignoring `pr.default_category_id` — diverges from `filterBuilder.buildExclusionClauses`. **Fix:** reuse `filterBuilder.buildExclusionClauses`.
- [ ] `apps/node-backend/src/services/calculations/aggregation/categoryPivot.js:18` — `source: hasExclusions ? 'live' : 'live'` — both branches return `'live'`, dead-code ternary. **Fix:** drop branch or restore intended `'mv'` for no-exclusion path.
- [ ] `apps/node-backend/src/lib/network.js:60` — `isInternetReachable({ force: true })` returns the in-flight non-forced probe if one is running. `force` does not actually force a fresh probe under contention. **Fix:** track inflight call's `force` flag; start new probe when forced caller arrives.
- [ ] `apps/node-backend/src/repositories/splitRepository.js:372` — `paid_at` default = `new Date().toISOString().split('T')[0]` (UTC date). Wrong for users west of UTC late in the day. **Fix:** app-timezone helper.
- [ ] `apps/node-backend/src/services/importPipeline/commit.js:96` — Per-row `SAVEPOINT sp_row_${row.id}` inside chunk transaction. For 1000-row chunk = 2-3k extra round-trips. **Fix:** consider chunk-level error boundary unless individual row isolation is truly required.
- [ ] `apps/node-backend/src/middleware/validation.js:43-55` — `sanitizeUpdateFields` silently drops unknown keys; frontend bugs (typoed columns) go undetected. **Fix:** log dropped keys at `debug` or include in response meta.
- [ ] `apps/node-backend/src/services/aiChat/tools/insights.js:130` — Phase B fix added `recipientId` filter, but assumes underlying repo accepts that option. If repo silently ignores unknown options, results silently include unrelated rows. **Verify:** check repo signature actually filters.
- [ ] `apps/node-backend/src/services/portfolio/portfolioSummaryService.js:188-189` — Phase B multiplier shortcut assumes `convertToCurrency` is linear. If it ever applies non-linear logic (per-call rounding, fee tiers), the 17 fields silently differ from the prior per-value path. **Fix:** add a regression test pinning new behavior to old for at least one non-EUR investment.
- [ ] `alembic/versions/0023_fix_portfolio_snapshots_constraint.py:58-65` — `downgrade()` re-adds `UNIQUE(snapshot_date)` without first deduplicating multi-currency rows that may have been written under the new composite constraint. Fails on production DBs that exercised multi-currency. **Fix:** pre-step deletes duplicate non-EUR rows, or document downgrade is destructive.

### Frontend

- [ ] `apps/frontend/src/contexts/ThemeContext.tsx:57-59` — `schedule.lightFrom.split(':').map(Number)` → `NaN` when string is malformed. Downstream comparisons silently fail; user gets wrong theme. **Fix:** validate, fallback.
- [ ] `apps/frontend/src/components/shared/dateUtils.ts:49` — `differenceInDays` uses `Math.floor((a - b) / 86400000)`. DST transitions (23/25-hour days) cause off-by-one. Used by `PlannedPaymentsPage.dueBadge` so "due today" can flip a day. **Fix:** normalize both dates to local midnight before subtracting, or use calendar fields.
- [ ] `apps/frontend/src/components/shared/PageHeader.tsx:21` — Title rendered as `<h2>`. Pages have no `<h1>`; document outline starts at h2 (WCAG violation). **Fix:** promote to `<h1>` (or accept `as` prop).
- [ ] `apps/frontend/src/pages/admin/AdminOverviewPage.tsx:84` and `apps/frontend/src/pages/admin/EndpointLivenessPage.tsx:75` — `<PageHeader description={...} />` but `PageHeader` accepts `subtitle`. Prop silently dropped. **Fix:** rename to `subtitle`.
- [ ] `apps/frontend/src/components/shared/DatePicker.tsx:32` — `clearLabel = "Clear"` default. Line 76 `clearLabel || t('common.clear')` — default is truthy so `t(...)` never reached. Always says "Clear" regardless of language. **Fix:** default to `undefined` or empty string.
- [ ] `apps/frontend/src/components/shared/AttachmentPanel.tsx:76` — `title="Delete attachment"` hardcoded English; no `aria-label`. Screen readers announce nothing distinctive. **Fix:** `t(...)` + `aria-label`.
- [ ] `apps/frontend/src/components/notifications/UpcomingPaymentsNotification.tsx:130-141` — "dismiss all" close button has no `aria-label`/`title`. Pure-icon button invisible to screen readers.
- [ ] `apps/frontend/src/components/shared/RecipientCombobox.tsx:24-28` — `useRecipients({ search: trimmedSearch })` fires per keystroke (no debounce). Floods recipient-search index. **Fix:** `useDebounce(300ms)`.
- [ ] `apps/frontend/src/pages/CategoriesPage.tsx:184` — Singular/plural keys off `items.length === 1` but displayed count is `activeCount`. Group with one inactive → "1 item" rendered as `n=0`.
- [ ] `apps/frontend/src/pages/RecipientsPage.tsx:249-251` — `formatCategoryName` does `detail.charAt(0) + detail.slice(1).toLowerCase()`. `toLowerCase()` is locale-insensitive (Turkish dotted-I, Dutch IJ). **Fix:** `toLocaleLowerCase` with active locale, or display as-is.
- [ ] `apps/frontend/src/pages/OwesPage.tsx:174` — Filename built from `recipient.name.replace(/\s+/g, '_').toLowerCase()` with no traversal sanitization. Recipient named `../../etc/passwd` produces a CSV with slashes. **Fix:** `sanitizeFilename`.
- [ ] `apps/frontend/src/lib/api/client.ts:215-217` — `options.signal.addEventListener('abort', ...)` registers listener never removed. If parent signal lives for app lifetime, slow leak. **Fix:** `{ once: true }` + remove on completion.
- [ ] `apps/frontend/src/lib/api/client.ts:234-235` — `if ((err as Error).name === 'AbortError')` conflates user-cancellation, parent-signal cancellation, and timeout into one error. Caller can't tell whether to retry.
- [ ] `apps/frontend/src/hooks/useCsvPreview.ts:71` — Line splitter is flat `.split('\n')`. Quoted fields with newlines (addresses/notes) get broken into pieces; column-count check drops them silently. **Fix:** state-machine parser, or vetted CSV lib.
- [ ] `apps/frontend/src/hooks/useRestoreBackup.tsx:70` — `setTimeout(() => window.location.reload(), 3000)` has no cleanup ref. Hook unmount before 3s still fires (probably harmless but uncancellable). **Fix:** ref + clear on unmount.
- [ ] `apps/frontend/src/hooks/useRestoreBackup.tsx:66` — `t('settings.restore.successDesc').replace('{file}', ...)` only replaces first occurrence. **Fix:** use the standard `t(key, vars)` interpolation.
- [ ] `apps/frontend/src/components/onboarding/OnboardingWizard.tsx:225` and many similar sites — `aria-label="Close"` hardcoded English across `TransactionsTable`, `FilterBanner`, `MergeRecipientsDialog`, `RecipientsPage`, `CategoriesPage`, `InvestmentDetailDialog`, `RecurringDetectionPanel`, `SplitTransactionDialog`, `DataTable`, `VirtualDataTable`, `useRestoreBackup`. **Fix:** `t(...)`.
- [ ] `apps/frontend/src/components/charts/AreaChart.tsx:117-120` — Phase B WIP: mutating `xAccessorRef.current` during render plus a constant-deps `useCallback`. Memoized `xValues`/`bisect` will not refresh when only `xAccessor` changes. Stale derivations possible if a parent swaps accessors mid-lifecycle. **Fix:** add `xAccessor` to memo deps, or document that accessor identity is stable by contract.

## Phase D — Round-3 LOW

### Backend

- [ ] `apps/node-backend/src/middleware/rateLimiter.js:30` — Limit key composed only from client IP. Behind reverse proxy without `app.set('trust proxy', …)`, every request collapses to proxy IP and one user trips every other user's limit. **Fix:** document trust-proxy requirement, or include `req.id`/session in key.
- [ ] `apps/node-backend/src/lib/sse.js:63` — `createSseWriter.write(event, data)` interpolates `event` into `event:` line without sanitising. Any `\n` in attacker-controlled event name breaks SSE framing. **Fix:** validate `event` against `[A-Za-z0-9_-]+` or document trusted-constant requirement.
- [ ] `apps/node-backend/src/services/importPipeline/match.js:99` — Per-unmatched-name UPSERT loop issues two queries per recipient. Hundreds of new recipients = hundreds of round-trips. **Fix:** bulk INSERT via `INSERT … FROM UNNEST($1::text[], $2::text[]) ON CONFLICT … RETURNING`.
- [ ] `apps/node-backend/src/services/recurringDetectionService.js:194` — `Math.round((d2 - d1) / 86400000)` collapses DST-spanning intervals (off by 1 hour). Bias accumulates for sub-daily transactions. **Fix:** UTC-only date math.
- [ ] `apps/node-backend/src/repositories/splitRepository.js:166-176` — Phase B WIP: `createSplitsBatchAtomic` exists, but old non-atomic `createSplitsBatch` is now dead code. Will drift out of sync with atomic version's validation. **Fix:** remove or alias.
- [ ] `apps/node-backend/src/services/aiChat/tools/planned.js:296-318` — Phase B WIP: `calculateNextDate` loop guard at 500 iterations using ISO-string `>` against `endStr`. Works only because format is `YYYY-MM-DD`. **Fix:** comment, or compare via `Date`.
- [ ] `apps/node-backend/src/services/portfolio/snapshotBuilder.js:131` — Phase B WIP: `priceHistorySortedDays[invId]` relies on SQL `ORDER BY investment_id, price_date` invariant. If query ever changes ordering, binary search returns wrong results silently. **Fix:** assert sorted at push time, or sort defensively once per investment.

### Frontend

- [ ] `apps/frontend/src/lib/api/helpers.ts:16` — `buildQuery` keeps boolean `false` and empty-string params (only `null`/`undefined` filtered). Backends comparing `?foo=false` against `if (foo)` see truthy. **Fix:** explicit `=== false` skip or normalize.
- [ ] `apps/frontend/src/hooks/usePortfolio.ts:28` — `const { data: transactions = [] } = ...` — fresh array reference every render → downstream memo invalidates. **Fix:** module-level `const EMPTY = []`.
- [ ] `apps/frontend/src/components/shared/VirtualDataTable.tsx:114-118` — `useEffect(() => { cancelEditingRef.current = cancelEditing; }, [cancelEditingRef])`. `cancelEditing` recreated every render, missing from deps; effect runs on mount only. Brittle. **Fix:** add `cancelEditing` to deps or wrap in `useCallback`.
- [ ] `apps/frontend/src/pages/MarketLookupPage.tsx:130-149` — `fmtNum`/`fmtPrice`/`fmtLargeNum` recreated every render; passed into chart props (`tooltipValueFormat`, `xTickFormat`) → invalidates chart memos every render. **Fix:** `useCallback` or extract from `useChartCurrencyFormatter`.
- [ ] `apps/frontend/src/pages/MarketLookupPage.tsx:587, 533` — `key={i}` for news articles and analyst actions. List re-orders on refetch → React reuses wrong DOM nodes. **Fix:** `article.link`, `${action.date}-${action.firm}`.
- [ ] `apps/frontend/src/pages/MarketLookupPage.tsx:612` — `formatDateStringWithAppSettings(article.publishedAt, …)` but `publishedAt` is `number | null` while helper expects `string`. Helper falls into `new Date(string)` interpreting number-as-string as a year. **Fix:** convert via `new Date(article.publishedAt).toISOString()` first.

---

## Notes on WIP fixes (Phase A/B of Round 2)

Largely sound. Spot-check verification:

- `priceCache.js` auto-drop: confirm fix removes `_dropForeignKey()` path and surfaces a real error.
- `recurringDetectionService` median: confirm even-length fix matches `_median` helper signature.
- `commit.js` SAVEPOINT: introduces per-row round-trips (Phase C MEDIUM above) — accept the tradeoff or reduce per-row by accumulating then chunk-rolling.
- `0023_fix_portfolio_snapshots_constraint.py` downgrade is destructive on multi-currency data — see Phase C MEDIUM.
- `portfolioSummaryService` multiplier shortcut needs a pinning test — see Phase C MEDIUM.
- `AreaChart` ref pattern can stale-derive — see Phase C MEDIUM.

OpenAPI regen (3111 lines): not reviewed for accuracy; recommend a contract test that cross-checks against route handlers (already raised in Round 2, still open).

---

## Tally

- **CRITICAL: 1** — streamingImportService.js bogus ON CONFLICT
- **HIGH: 19** — split between backend (11) and frontend (8)
- **MEDIUM: 25** — split between backend (14) and frontend (11)
- **LOW: 9** — split between backend (6) and frontend (3)
- **Total: 54 NEW findings**

Round 1 + 2 + 3 cumulative: ~140 findings catalogued.
