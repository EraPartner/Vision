# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

Curated from the May 2026 bug-hunt and optimization audits — only items with a
real correctness, robustness, performance, or UX payoff are kept. File:line
references are approximate (audit-era) — re-locate before acting.

## Monetary precision (float drift)

High-stakes for a finance app: most money paths accumulate IEEE-754 floats and round with lossy `Math.round(x*100)/100`. Direction: route through `decimal.js` / money helpers, round once on emit with an explicit mode.

- [ ] Route `portfolioSummaryService.js` money math through decimal — per-investment sums, currentValue/gainLoss, FX multiplier, `aggregateTotals` are raw float; it is the dashboard's source of truth 🔺
- [ ] Fix raw-float accumulators in `portfolio/snapshotBuilder.js` — `cumulativeInvested`, per-class invested, `totalValue`, `cumulativeInflation` drift compounds over multi-year ranges and is persisted 🔺
- [ ] De-float frontend `hooks/portfolio/usePortfolioSummaries.ts` + `usePortfolioCalculations.ts` — duplicate float money math; also resolve the gross/net inconsistency where `totalSellProceeds` adds the full amount while realized-gain scales by `sellRatio` ⏫
- [ ] Fix `cashflowForecast.js` — `parseFloat(row.amount)` + float `+=` over up to 500 occurrences × N months before a lossy round ⏫
- [ ] Fix `transactionExport.js:169` running balance — collapses `decimal.js` back to a JS number each step, re-ingesting a drifted float ⏫
- [ ] Preserve canonical decimal in import adapters (`vision/revolut/belfius/sabb`) + `streamingImportService`/`rawTransactionImportService` — amounts/balances parsed via `parseFloat`; `belfius.js` rounds accumulated float balances ⏫
- [ ] Fix `SplitTransactionDialog.tsx:52-71` — float `reduce` + `Math.round` compared with `> absAmount + 1e-6` can mis-gate an exact split ⏫
- [ ] Add a shared half-up `roundMoney` helper and replace lossy `Math.round(x*100)/100` across forecast methods, `infoRepo.statistics`, `aiChat/tools/tax.js`, etc. 🔼
- [ ] Fix `belgianInflationService.js` — `monthlyRate` rounded to 6dp then compounded multiplicatively in `snapshotBuilder`; truncation compounds into the inflation-adjusted series 🔼

## Date / timezone correctness

Pattern: UTC `new Date('YYYY-MM-DD')` mixed with local-time `getFullYear/getMonth/getDate`, causing off-by-one-day/month at boundaries.

- [ ] Fix `cashflowForecast.js:101-115` + `recurrence.js` — `expandOccurrences` buckets UTC-midnight dates via `getUTCMonth` but `calculateNextDate` uses app-TZ wall-clock; a recurring occurrence can land in the wrong forecast month ⏫
- [ ] Fix `splitRepository.js:352` `paid_at` default — built from server-local `getFullYear/getMonth/getDate`, wrong calendar day near midnight on non-UTC servers ⏫
- [ ] Fix `infoRepositoryPlanned.js:14-17` — month-window bounds computed in server-local time, then used in a SQL `planned_date` range ⏫
- [ ] Fix `recurringDetectionService.js:216-221` `predictedNext` — uses local `getDate/setDate` while the interval calc above uses `Date.UTC`; ±1 day across DST ⏫
- [ ] Fix `infoRepositoryRecipients.js:96-99` — `recipientInsights` MoM periods from local-time `new Date()` while SQL buckets use `CURRENT_DATE`; empty MoM near month boundary ⏫
- [ ] Fix `reports/dataFetcher.js:107-113` `filterMonthsByPeriod` 'custom' — compares UTC-parsed ISO dates against local-time `new Date(y,m,1)` 🔼
- [ ] Fix `portfolioMath.js:309-314` `calculateAccruedInterest`/`computeMetrics` — UTC `new Date(startDate)` vs wall-clock `new Date()`, day count off by 1 (contradicts ADR-009) 🔼

## Import pipeline correctness

- [ ] Add `ON CONFLICT` to `rawTransactionImportService.js:360-364` — `processRawImportRow` inserts into `transactions` with no conflict guard; a bypass/race inserts duplicates ⏫
- [ ] Fix `importPipeline/match.js:155` blank-recipient auto-commit — a batch of only blank-`recipient_raw` rows yields `requiresReview=false` and auto-commits transactions with `recipient_id=NULL` ⏫
- [ ] Fix `importPipeline/commit.js:71-93` counter divergence — JS `imported`/`duplicates` counters increment before a chunk can roll back and aren't restored; per-chunk `import_batches` checkpoint is not atomic with the commit ⏫
- [ ] Add intra-batch dedup in `importPipeline/validate.js` + `commit.js` — `tx_hash` is computed/stored per row but never used; two identical rows in one CSV are both inserted ⏫
- [ ] Make `streamingImportService.js:122-141` `getOrCreateRecipient` awaited — `recipient_bank_accounts` INSERT and `recipients` notes UPDATE are fire-and-forget, can be in flight after the import returns 🔼

## Database / connection robustness

- [ ] Restrict `database/connection.js:42-76` `query()` retry to reads — currently retries transient errors for INSERT/UPDATE/DELETE too; a write that committed before `ECONNRESET` would be re-applied 🔺
- [ ] Fix `database/connection.js:117-126` `withTransaction` — if `ROLLBACK` throws, the client is `release()`d back to the pool in an unknown state; use `client.release(rollbackErr)` to destroy it ⏫
- [ ] Fix `main.js:436-444` `shutdown()` — calls `closePool()` + `process.exit(0)` without `server.close()` (drops in-flight requests); add a double-signal guard and force-exit timeout ⏫

## SQL / repository correctness

- [ ] Fix `investmentRepository.js:542` `updatePrice` — calls `updateThroughInheritanceTables` unconditionally; on a flat schema it throws instead of falling back to `UPDATE investments`, breaking the live-price scheduler ⏫
- [ ] Fix `deduplication.js:29-43` — `recipient_id = (SELECT … LIMIT 1)` yields NULL for unknown recipients so an identical `recipient_id IS NULL` row is never flagged; `LIMIT 1` without `ORDER BY` is non-deterministic on name collisions ⏫
- [ ] Fix `splitRepository.js:355-365` auto-settle — compares raw `SUM(sp.amount) >= ts.amount` while validation rounds to cents; a split validated as fully paid may not auto-settle ⏫
- [ ] Fix `portfolioTxRepo.common.js:406-415` — `createThroughInheritanceTables` runs `setval(MAX(id)+1)` before every insert; concurrent creates collide on `23505`. Resync should only run in the duplicate-id catch path ⏫
- [ ] Fix `belgianInflationService.js:528` — external-fetch `catch` caches a date-range-filtered subset into `memoryCache`; a later wider-range call gets a truncated cache hit ⏫
- [ ] Fix `infoRepositoryNetWorth.js:186-196` — `getNetWorthFromSnapshots` doesn't forward-fill `investmentsByDay`; days with no snapshot row show net worth as liquid-only 🔼
- [ ] Fix `recipientBankAccountRepository.js:99-110` `createOrGet` — inserts a new primary then unsets siblings in a separate transaction (brief two-primary window); `isFirst` uses `activeOnly=true` so a recipient with only soft-deleted accounts gets a surprise primary 🔼
- [ ] Decide + fix Kinesis `KAU_EUR`→`KAU_USD` (`priceProviderRegistry.js:62-91`, `priceProviderService.js:341-382`) — fetches USD prices but persists them into `asset_price_history` for a EUR investment without conversion 🔼
- [ ] Decide: `transactionRepository.js:112` `running_balance` `SUM() OVER (ORDER BY …)` runs after WHERE + LIMIT with no account partition — it is a partial sum of the current page, not a true account balance 🔼

## API / route handling

- [ ] Fix `rateLimiter.js:38-41` — trusts `X-Forwarded-For` only from loopback, but behind docker-proxy the source IP is the bridge gateway; all clients share one rate-limit bucket ⏫
- [ ] Fix `materializedViewService.js:185-196` — non-concurrent-refresh fallback only triggers on 3 message substrings; any other error is swallowed and `refreshMaterializedViews` resolves "successfully" with a stale view ⏫
- [ ] Add backpressure handling to `transactionExport.js:130-140` — export chunk loop calls `res.write()` without checking `drain`; rows buffer unboundedly for a slow client on a 50k-row export 🔼
- [ ] Fix `attachments.js:112` `res.sendFile` — no callback, so a missing-on-disk file surfaces as a raw `ENOENT` 500 instead of a clean 404 🔼
- [ ] Validate `:id` params: `routes/transactions.js:482` POST checks `recipient_id` truthiness only (non-integer → DB FK 500 not 400); `routes/watchlist.js` `:id` skips `validateIdParam` (`NaN` → 500) 🔼
- [ ] Coerce `symbols`/`symbol` query params in `routes/marketLookup.js` — arrays make `.split` throw, caught as a generic 502 instead of a clean 400 (needs a test update) 🔼
- [ ] Add an in-flight guard to `startup/warmup.js:225-240` `setInterval` refresh tasks — a slow run can overlap the next tick 🔽
- [ ] Decide: `refreshCashflowForecastMc.js:44` passes `includeBacktest: true` although the job docstring says "without backtest" — runs the expensive backtest nightly per user 🔽
- [ ] Decide: `attachments.js:124-127` DELETE removes the DB row first; if file removal then throws, the file is orphaned with no row to retry from 🔽

## Charts / calculations

- [ ] Fix LTTB last-bucket average bug in `utils/downsample.js:27-37` (+ frontend `downsample.ts`) and `forecastMerge.ts:35` — `avgCount` is computed from clamped bounds while the loop iterates fewer times, distorting the tail bucket ⏫
- [ ] Add a `>= 1` guard to `calculations/recurrence.js:66-69` — `"every 0 days"` matches the custom-pattern regex and returns the same date, an infinite-loop risk for any "advance until > now" caller 🔺
- [ ] Fix `portfolioMath.js:425-431` `computeHeatmap` — computes returns between consecutive month keys, so a gap (Jan→Mar) is mislabelled as a one-month return; also sort `snapshots` defensively ⏫
- [ ] Fix `aiChat/tools/portfolio.js:157` — `getReturnsForRange`/`getBestWorstPerformers`/`getDividendIncome` use `new Date(to)` (UTC midnight) as the upper bound, excluding same-day non-midnight timestamps (`tax.js` does it right) 🔼
- [ ] Add a `truncated` meta flag to `aiChat/tools/insights.js:165` `getRecipientInsights` — caps the scan at 50k rows with no signal, silently truncating aggregates for high-volume recipients 🔼
- [ ] Fix `aiChat/tools/_validate.js:21-31` `parseDate` — `new Date('2025-02-30')` rolls to Mar 2; the bad string reaches SQL as a generic error instead of a clean validation error 🔼
- [ ] Decide: `portfolioMath.js:97-102` `calculateCostBasis` — a `split`/`return_of_capital` with `units<=0` is silently a no-op; weighted-avg vs FIFO/LIFO distribute `return_of_capital` differently 🔽

## Frontend correctness / UX feel

- [ ] Fix `hooks/useConfirmDialog.tsx:49-72` — `ConfirmDialog` is a `useCallback` with `open`/`options` in deps, so a new component identity every open/close remounts the whole `AlertDialog` and breaks its enter/exit animation ⏫
- [ ] Fix `hooks/useCountUp.ts` — on a new `target` mid-animation, `from` is the previous target not the currently-visible value, causing a visible jump on rapid value changes ⏫
- [ ] Key `VirtualDataTable.tsx:556` rows by stable row `id`, not `virtualRow.key` — on sort/filter reorder, in-progress inline edits and row transitions can attach to the wrong row ⏫
- [ ] Fix `DataTable.tsx` pagination — "Previous" on page 0 wraps to the last page and "Next" on the last page wraps to 0 (buttons only disabled when `totalPages <= 1`) 🔼
- [ ] Add the `isTypingRef` guard to `DataTable.tsx:100-108` `searchValue`→`localSearchQuery` sync (the one `VirtualDataTable` already has) — a stale `searchValue` prop can revert characters mid-typing 🔼
- [ ] Re-seed `columnWidths` in `DataTable`/`VirtualDataTable` when `columns` change — derived in a `useState` initialiser, so a locale change or added column never re-seeds `defaultWidth` 🔼
- [ ] Fix `VirtualDataTable.tsx:307-325` — `loadRequestedForLengthRef` reset effect can race `maybeLoadMore`, re-firing `onLoadMore` for an already-requested page 🔼
- [ ] Fix `ai-chat/ChatMessageList.tsx:52-56` auto-scroll — keyed on `combined.length`, so a streaming tool message growing in place won't keep the view pinned to the bottom 🔼
- [ ] Reset per-item state in `WatchlistChartDialog.tsx:51-53` when `item` changes — `selectedRange`/`editingPrice`/`newTargetPrice` leak across items in the persistent dialog 🔼
- [ ] Make `utils/currency.ts:190` `formatAmountWithSymbol` honor the user's decimal-places + locale-grouping settings instead of hardcoded `.toFixed(2)` 🔼

## CSV integrity

- [ ] Fix `lib/csv.js:24` `escapeCsvValue` — quote-trigger covers `,"\n` but not `\r`; a bare CR can corrupt a row for strict parsers 🔼
- [ ] Fix `lib/csv.js:12-19` `neutralizeCsvFormula` — checks the trimmed first char but prefixes the untrimmed value, so the neutralising quote isn't guaranteed to be the literal first character 🔼

## Performance — memoization & query bounds

Behaviour-neutral follow-ups in the spirit of the shipped PRs #58–#63.

- [ ] Bound `recurringDetectionService.detectRecurringPatterns` — full-table scan of `transactions` (joined, ordered) with no date bound on every call, including via the `getRecurringDetected` aiChat tool; bound to ~3 years or add a `MAX(updated_at)`-keyed cache 🔼
- [ ] Cache recipients per import in `streamingImportService.getOrCreateRecipient` — re-normalizes the name and runs the upsert (+ address/account writes) for every CSV row though merchants repeat within a file 🔼
- [ ] Memoize `CustomChart.tsx` — `categoryPivot.filter(...)` is recomputed 3×, category-id lookup is O(n) `.includes`, `legendItems`/`series` get new identity each render; `seriesMeta` deps omit `recipientData` 🔼
- [ ] Fix `CategoryPivotTable.tsx` — hoist `getPeriodValue` to a pure module function (currently redefined each render, used inside 3 `useMemo`s behind `eslint-disable exhaustive-deps`); derive `columnTotals` in one pass 🔼
- [ ] Memoize `usePortfolioSummaries.byAssetClass` — returns a fresh filtered array each call, so Stocks/Crypto/Metals pages get a new identity every render 🔽
- [ ] Memoize the `Intl.NumberFormat` in `RecipientInsightsTab.tsx` `formatCurrency` (same pattern fixed in #59) 🔽
- [ ] Add a count cap / LIMIT guard to `recipientPatternService.previewPatternMatches` regex path — `SELECT id, name FROM recipients WHERE is_active = true` with no LIMIT 🔽
- [ ] Deduplicate `forecastMerge.ts` `mergeForView` — re-implements ~140 lines of `mergeForViewRolling`'s band-map/series logic inline instead of reusing `buildBandMaps`/`buildSeries`; also drop the unused `bandsCumByMethod` 🔽
