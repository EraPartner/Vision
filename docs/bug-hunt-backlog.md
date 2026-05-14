# Bug-Hunt Backlog

Findings from the bug-hunt passes on branch `claude/bug-hunt-refactor-RhaV1`
(PR #57) that were **deliberately not fixed in that PR** because the fix would
change observable behaviour, output, or UI feel — or because it needs a product
decision, carries refactor risk, or is low-confidence.

They are recorded here for later review: each should be re-assessed to decide
whether it still warrants its own PR. Line numbers are approximate (as of the
time of the hunt) — re-locate before acting.

Classification:
- **BEHAVIOR-CHANGING** — fix alters a displayed/stored number, a date
  boundary, an HTTP status, counts, etc. (often *is* the point — it's a bug —
  but it was out of scope for a "no behaviour change" PR).
- **RISKS UI/FEEL** — fix could change scrolling/animation/interaction feel.
- **NEEDS DECISION** — depends on intended product behaviour.
- **RISKY REFACTOR** — correct only with a complete/precise change; a mistake
  would introduce a new bug.
- **LOW-CONFIDENCE / MINOR** — possibly not a real defect, or negligible impact.

---

## 1. Monetary precision (float drift)

High-stakes for a finance app. Most of these accumulate IEEE-754 floats on
money and/or round with `Math.round(x*100)/100` (lossy on values like `1.005`).
Recommended global direction: route money math through `decimal.js` / the
existing money helpers, round once on emit with an explicit rounding mode.

| File:line | Issue | Class |
|---|---|---|
| `apps/node-backend/src/services/portfolio/portfolioSummaryService.js:25-26,99-209,279-307` | Entire portfolio-summary pipeline (per-investment sums, currentValue/gainLoss, FX multiplier, `aggregateTotals`) is raw float; `round2`/`round6` mis-round. This is the dashboard's source of truth. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/portfolio/snapshotBuilder.js:210-298` | Daily snapshot accumulators (`cumulativeInvested`, per-class invested, `totalValue`, `cumulativeInflation`) are raw float, accumulated once per day over multi-year ranges, then persisted. | BEHAVIOR-CHANGING |
| `apps/frontend/src/hooks/portfolio/usePortfolioSummaries.ts:36-126`, `usePortfolioCalculations.ts:31-101` | Frontend duplicate of the same float math (`+=` accumulation, `totalCost/totalUnits`, realized-gain). | BEHAVIOR-CHANGING |
| `apps/frontend/src/hooks/portfolio/usePortfolioCalculations.ts:48-52` | `totalSellProceeds += amount` adds the full unscaled amount while realized-gain math scales by `sellRatio` — inconsistent gross/net. | BEHAVIOR-CHANGING / NEEDS DECISION |
| `apps/node-backend/src/services/calculations/aggregation/cashflowForecast.js:76,149-167` | `parseFloat(row.amount)` then float `+=` over up to 500 occurrences × N months before a lossy round. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/transactionExport.js:169` | Running balance uses `decimal.js` per step but collapses back to a JS number each iteration, so the next step re-ingests a drifted float. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/importPipeline/adapters/{vision,revolut,belfius,sabb}.js`, `streamingImportService.js:350`, `rawTransactionImportService.js:88` | Imported amounts/balances parsed via `parseFloat`; `belfius.js:35` does `Math.round(bal*100)/100` on accumulated float balances. Should preserve canonical string / decimal. | BEHAVIOR-CHANGING |
| `apps/frontend/src/components/splits/SplitTransactionDialog.tsx:52-71` | Split totals via raw float `reduce` + `Math.round(x*100)/100`, compared with `> absAmount + 0.000001` — float math can mis-gate an exact split. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/belgianInflationService.js:206,245,287` | `monthlyRate` rounded to 6 dp, then compounded multiplicatively in `snapshotBuilder` — truncation compounds into the inflation-adjusted series. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/quoteBackfillService.js:73,256,332` & `snapshotBuilder.js:231` | `Number(tx.units)` and `amount/units` as float feed historical valuation. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/calculations/forecast/methods/*` & `portfolioSummaryService.js`/`cashflowForecast.js`/`infoRepo.statistics`/`aiChat/tools/tax.js:136` | Shared lossy `Math.round(x*100)/100` rounding pattern — replace with a half-up `roundMoney` helper. | BEHAVIOR-CHANGING |

## 2. Date / timezone correctness

Pattern: `new Date('YYYY-MM-DD')` (UTC) mixed with local-time
`getFullYear/getMonth/getDate/setDate`, or app-TZ helpers mixed with UTC
buckets — causing off-by-one-day/month at boundaries.

| File:line | Issue | Class |
|---|---|---|
| `apps/node-backend/src/services/calculations/aggregation/cashflowForecast.js:101-115` (+ `recurrence.js:34-52`) | `expandOccurrences` builds UTC-midnight dates and buckets via `getUTCMonth`, but `calculateNextDate` routes through `addMonthsClampedInAppTz` (app-TZ wall-clock) — a recurring occurrence can land in the wrong forecast month. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/repositories/splitRepository.js:352` | `paid_at` default built from server-local `getFullYear/getMonth/getDate` — wrong calendar day near midnight on non-UTC servers. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/repositories/infoRepositoryPlanned.js:14-17` | Month-window bounds (`new Date(now.getFullYear(), now.getMonth()+1, 1)`) computed in server-local time, then used in a SQL `planned_date` range. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/recurringDetectionService.js:216-221,240` | `predictedNext` uses local `getDate/setDate` while the interval calc just above uses `Date.UTC` — ±1 day across DST on non-UTC servers. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/repositories/infoRepositoryRecipients.js:96-99` | `recipientInsights` MoM `currentPeriod`/`prevPeriod` derived from local-time `new Date()` while SQL buckets use `CURRENT_DATE`/`TO_CHAR` — empty MoM near month boundary. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/reports/dataFetcher.js:107-113` | `filterMonthsByPeriod` 'custom' compares UTC-parsed ISO dates against local-time `new Date(y, m, 1)` constructors. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/utils/portfolioMath.js:309-314,374-376` | `calculateAccruedInterest` / `computeMetrics` use `new Date(startDate)` (UTC) vs `new Date()` (wall-clock) — day count off by up to 1 (contradicts ADR-009). | BEHAVIOR-CHANGING |
| `apps/node-backend/src/routes/marketLookup.js:42-51` | `rangeToDate` mixes ms-arithmetic (`1d`/`5d`) with local-time component math (`1mo`+) — can skip/duplicate a day of quote history. | BEHAVIOR-CHANGING (low impact) |
| `apps/frontend/src/components/shared/dateUtils.ts:140-143,162-173` | `formatDateStringWithAppSettings` falls back to raw `new Date(dateStr)` for space-separated datetimes — parsed as local, inconsistent with the YMD branch. | BEHAVIOR-CHANGING (edge) |
| `apps/frontend/src/utils/priceStaleness.ts:23` | `Date.parse` on a bare `YYYY-MM-DD` parses as UTC midnight — staleness off by up to a day for non-UTC users *if* date-only strings ever arrive. | LOW-CONFIDENCE (confirm API always sends zoned timestamps) |

## 3. Import pipeline correctness

| File:line | Issue | Class |
|---|---|---|
| `apps/node-backend/src/services/streamingImportService.js:179-205` | A transaction that hits `ON CONFLICT DO NOTHING` (duplicate) still `return 'imported'` — inflates the imported count and orphans the raw-bank row (no `transaction_raw_references` link). Fix: `return txResult.rows[0] ? 'imported' : 'duplicate'`. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/rawTransactionImportService.js:360-364` | `processRawImportRow` inserts into `transactions` with no `ON CONFLICT` — dedup relies solely on the earlier hash check; a bypass/race inserts duplicates. Inconsistent with the streaming path. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/importPipeline/match.js:155-156` (+ `index.js prepareImport`) | `matchSourceCounts` tallies distinct names; blank-`recipient_raw` rows contribute nothing, so a batch of only blank-recipient rows yields `requiresReview=false` and auto-commits transactions with `recipient_id=NULL`. | BEHAVIOR-CHANGING / NEEDS DECISION |
| `apps/node-backend/src/services/importPipeline/commit.js:71-93,159-172` | Dup-check `SELECT` runs before the row `SAVEPOINT`; JS `imported`/`duplicates` counters are incremented before a chunk can roll back and aren't restored — counts can diverge from DB state. The per-chunk `import_batches` checkpoint is also not atomic with the chunk commit. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/importPipeline/validate.js` + `commit.js` | `tx_hash` is computed/stored per row but never used; two identical rows in the same CSV are both inserted (intra-batch dedup missing). | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/streamingImportService.js:122-141` | `getOrCreateRecipient` issues `recipient_bank_accounts` INSERT and `recipients` notes UPDATE as fire-and-forget (`.catch` but no `await`) — can still be in flight after the import returns. | BEHAVIOR-CHANGING (timing) |
| `apps/node-backend/src/services/streamingImportService.js:56-68` | `countLines` does `resolve(count + 1)` assuming no trailing newline — a CSV ending in `\n` makes the progress total one too high. | BEHAVIOR-CHANGING (progress % only) |

## 4. Database / connection robustness

| File:line | Issue | Class |
|---|---|---|
| `apps/node-backend/src/database/connection.js:42-76` | `query(text, params, { retries })` retries transient errors for **any** SQL including INSERT/UPDATE/DELETE — a write that committed before an `ECONNRESET` would be re-applied. Restrict retry to reads / explicitly-idempotent callers. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/database/connection.js:117-126` | `withTransaction`: if `ROLLBACK` throws (dead connection) the client is `release()`d back to the pool in an unknown state. Use `client.release(rollbackErr)` to destroy it. | BEHAVIOR-CHANGING (pool lifecycle) |
| `apps/node-backend/src/main.js:436-444` | `shutdown()` calls `closePool()` + `process.exit(0)` without `server.close()` (in-flight requests dropped), has no double-signal guard and no force-exit timeout. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/database/migrate.js:177` | `UPDATE alembic_version SET version_num = $1` has no `WHERE` — rewrites all rows if the table is ever corrupted to >1 row. | BEHAVIOR-CHANGING (negligible) |

## 5. SQL / repository correctness

| File:line | Issue | Class |
|---|---|---|
| `apps/node-backend/src/repositories/investmentRepository.js:542-548` | `updatePrice` calls `updateThroughInheritanceTables` unconditionally — on a flat (non-inheritance) schema it throws instead of falling back to `UPDATE investments`. Live-price scheduler updates would fail there. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/deduplication.js:29-43` | `isDuplicate` / `isDuplicateByFields`: `recipient_id = (SELECT … LIMIT 1)` yields NULL for unknown recipients, so an identical row with `recipient_id IS NULL` is never flagged duplicate; `LIMIT 1` with no `ORDER BY` is non-deterministic on name collisions. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/repositories/splitRepository.js:355-365` | Auto-settle `UPDATE` compares raw `SUM(sp.amount) >= ts.amount` while validation rounds to cents — a split validated as fully paid may not auto-settle (or vice-versa). | BEHAVIOR-CHANGING |
| `apps/node-backend/src/repositories/portfolioTxRepo.common.js:406-415` (+ investmentRepository retry path) | `createThroughInheritanceTables` runs `setval(...)` to `MAX(id)+1` before *every* insert — concurrent creates collide on `23505` (thundering herd) and an extra round-trip per insert. Resync should only happen in the duplicate-id catch path. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/repositories/transactionRepository.js:112-113,418-419` | `getAll` `SUM(t.amount) OVER (ORDER BY …)` runs after WHERE filters with no account partition and a `LIMIT` — `running_balance` is a partial sum of the current page, not a true account balance. | NEEDS DECISION |
| `apps/node-backend/src/repositories/infoRepositoryNetWorth.js:186-196` | `getNetWorthFromSnapshots` doesn't forward-fill `investmentsByDay` — days with no snapshot row show net worth as liquid-only. Latent (masked by daily snapshot job). | BEHAVIOR-CHANGING (latent) |
| `apps/node-backend/src/repositories/recipientBankAccountRepository.js:99-110` | `createOrGet` inserts a new primary then unsets siblings in a *separate* transaction — brief two-primary window; `isFirst` is computed with `activeOnly=true` so a recipient with only soft-deleted accounts gets a surprise primary. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/recurringDetectionService.js:172-175` | `recipient_id = ANY($1)` has no `::int[]` cast — works via inference but inconsistent with the rest of the codebase and fragile for empty arrays. | BEHAVIOR-CHANGING (consistency) |
| `apps/node-backend/src/services/belgianInflationService.js:528-529` | External-fetch `catch` path caches a *date-range-filtered* subset into `memoryCache` instead of the full set — a later wider-range call gets a truncated cache hit. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/prices/priceProviderRegistry.js:62-91` + `priceProviderService.js:341-382` | Kinesis `KAU_EUR`→`KAU_USD` fetches USD prices but persists them into `asset_price_history` for a EUR-currency investment without conversion — historical values off by USD/EUR rate. | BEHAVIOR-CHANGING / NEEDS DECISION |

## 6. API / route handling

| File:line | Issue | Class |
|---|---|---|
| `apps/node-backend/src/jobs/refreshCashflowForecastMc.js:44` | Passes `includeBacktest: true` although the job's docstring says it runs "without backtest" — runs the expensive backtest nightly per user. | NEEDS DECISION |
| `apps/node-backend/src/routes/attachments.js:112` | `res.sendFile(absPath)` with no callback — a missing-on-disk file (DB row exists) surfaces as a raw `ENOENT` 500 instead of a clean 404. | BEHAVIOR-CHANGING (500→404) |
| `apps/node-backend/src/routes/attachments.js:124-127` | DELETE removes the DB row first; if file removal then throws, the file is orphaned with no row to retry from. | NEEDS DECISION |
| `apps/node-backend/src/middleware/rateLimiter.js:38-41` | Trusts `X-Forwarded-For` only from loopback, but behind docker-proxy the source IP is the bridge gateway (`172.x`) — all clients share one rate-limit bucket. Misaligned with `adminAuth`'s own private-IP model. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/routes/aggregations.js:142` | `cashflow-forecast-rolling` hand-rolls a `{ ok:false, … }` envelope inline (non-`ApiErrorCode` code string, no `meta.requestId`) instead of `throw new ValidationError(...)`. | BEHAVIOR-CHANGING (minor) |
| `apps/node-backend/src/controllers/investmentController.js` (translateRepoError) + `middleware/errorHandler.js` | `translateRepoError` can `throw err` where `err` is falsy — partially mitigated by the errorHandler non-Error normalisation already merged, but `translateRepoError` should still normalise. | LOW-CONFIDENCE |
| `apps/node-backend/src/routes/transactions.js:482` | POST `/api/transactions` checks `!data.recipient_id` truthiness only — a non-integer passes through to the DB FK as a 500 instead of a clean 400. | BEHAVIOR-CHANGING (500→400) |
| `apps/node-backend/src/routes/watchlist.js:38,57,63` | `:id` params not run through `validateIdParam` — `NaN` reaches the repository (500/empty instead of 400). | BEHAVIOR-CHANGING |
| `apps/node-backend/src/routes/marketLookup.js:80-86,188-194,223-231` | `symbols`/`symbol` query params can arrive as arrays — `.split` throws, caught as a generic 502 instead of a clean 400. (A `String(...)` coercion was attempted but reverted because existing tests assert the current behaviour — needs a test update.) | BEHAVIOR-CHANGING |
| `apps/node-backend/src/routes/importRoutes.js` (`/csv/stream` etc.) | Various `parseInt` ID parsing accepts negatives/floats; SSE handlers can throw after headers are sent — partially mitigated by the merged `errorHandler` `headersSent` guard, but per-route SSE `catch` blocks still aren't self-guarded. | BEHAVIOR-CHANGING (minor) / LOW |
| `apps/node-backend/src/startup/warmup.js:225-240` | `setInterval(async …)` refresh tasks have no in-flight guard — a slow run can overlap the next tick. | BEHAVIOR-CHANGING (minor) |
| `apps/node-backend/src/services/materializedViewService.js:185-196` | Non-concurrent-refresh fallback only triggers on 3 specific message substrings; any other error is logged and swallowed — `refreshMaterializedViews` resolves "successfully" with a stale view. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/transactionExport.js:130-140` | Export chunk loop calls `res.write(...)` without checking backpressure / awaiting `drain` — rows buffer unboundedly for a slow client on a 50k-row export. | BEHAVIOR-CHANGING (timing) |

## 7. Frontend React correctness / perf

| File:line | Issue | Class |
|---|---|---|
| `apps/frontend/src/hooks/useConfirmDialog.tsx:49-72` | `ConfirmDialog` is a `useCallback` whose deps include `open`/`options` — a new component identity every open/close remounts the whole `AlertDialog`, breaking its enter/exit animation. | RISKS UI/FEEL |
| `apps/frontend/src/hooks/useCountUp.ts:9-43` | On a new `target` mid-animation, `from` is the previous *target*, not the currently-visible value — a visible jump on rapid value changes. | RISKS UI/FEEL |
| `apps/frontend/src/hooks/useStatistics.ts:292-303,328-333` | When only *categories* are excluded, the "filtered" recipient-by-year view silently falls back to unfiltered data. | NEEDS DECISION |
| `apps/frontend/src/features/transactions/components/TransactionsTable.tsx:96-286` | `columns` is rebuilt every render and passed to `VirtualDataTable`, whose `uniqueValues`/`processedRows` memos and `handleResizeStart` list it in deps — the full filter/sort pipeline recomputes on every parent render (e.g. selection change). Needs `useMemo` + memoised `toggleSelect`/`toggleSelectAll` with a complete dep list. | RISKY REFACTOR |
| `apps/frontend/src/components/shared/DataTable.tsx:100-108` | `searchValue`→`localSearchQuery` sync lacks the `isTypingRef` guard `VirtualDataTable` has — a stale `searchValue` prop can revert characters mid-typing. | RISKS UI/FEEL |
| `apps/frontend/src/components/shared/DataTable.tsx:557-583` | Pagination "Previous" on page 0 wraps to the last page and "Next" on the last page wraps to 0 (buttons only disabled when `totalPages <= 1`). | RISKS UI/FEEL |
| `apps/frontend/src/components/shared/VirtualDataTable.tsx:556` | Rows keyed by `virtualRow.key` (virtualizer index), not stable row `id` — on sort/filter reorder, in-progress inline edits and row transitions can attach to the wrong row. | RISKS UI/FEEL |
| `apps/frontend/src/components/shared/VirtualDataTable.tsx:307-325` | `loadRequestedForLengthRef` reset effect can race `maybeLoadMore` — a filter that changes length without new data can re-fire `onLoadMore` for an already-requested page. | RISKS UI/FEEL |
| `apps/frontend/src/components/shared/{DataTable,VirtualDataTable}.tsx` (`columnWidths` init) | `columnWidths` is derived from `columns` in a `useState` initialiser — new `columns` (locale change, added columns) never re-seed `defaultWidth`. | RISKS UI/FEEL |
| `apps/frontend/src/features/ai-chat/ChatMessageList.tsx:52-56` | Auto-scroll effect keyed on `combined.length` — a streaming tool message growing in place (same id, same length) won't keep the view pinned to the bottom. | RISKS UI/FEEL |
| `apps/frontend/src/components/portfolio/WatchlistChartDialog.tsx:51-53` | `selectedRange`/`editingPrice`/`newTargetPrice` not reset when `item` changes — state leaks across items in the persistent dialog. | RISKS UI/FEEL |
| `apps/frontend/src/components/portfolio/AttachmentPanel.tsx:95` | Rapid deletes on different rows overwrite `deletingId`, so the first row's spinner stops while its request is still in flight. | RISKS UI/FEEL (minor) |
| `apps/frontend/src/contexts/WorkspaceContext.tsx:46-60` | The workspace-persist effect writes to sessionStorage on every workspace change, including ones `setWorkspace` already persisted — redundant writes. | MINOR |

## 8. Charts / calculations

| File:line | Issue | Class |
|---|---|---|
| `apps/node-backend/src/utils/downsample.js:27-37` & `apps/frontend/src/utils/downsample.ts:30-41` | `downsampleLTTB` last-bucket average: `avgCount` is computed from clamped bounds while the loop may iterate fewer times — `avgX/avgY` can stay 0, distorting the final triangle-area selection. | BEHAVIOR-CHANGING |
| `apps/frontend/src/utils/forecastMerge.ts:35` | Same class of bug: `avgCount = nextBucketEnd - nextBucketStart` but the loop is bounded by `len` — wrong divisor skews the tail bucket. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/utils/portfolioMath.js:425-431,443` | `computeHeatmap` keeps the last snapshot per `YYYY-MM` and computes returns between *consecutive* month keys — a gap (Jan→Mar) is mislabelled as a one-month return. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/utils/portfolioMath.js:425-431,371-372` | `computeHeatmap`/`computeMetrics` assume `snapshots` is chronologically sorted but never sort defensively. | BEHAVIOR-CHANGING (if any caller passes unsorted) |
| `apps/node-backend/src/utils/portfolioMath.js:97-102` | `calculateCostBasis`: a `split`/`return_of_capital` with `units<=0` is silently a no-op; weighted-avg vs FIFO/LIFO distribute `return_of_capital` differently for the same data. | BEHAVIOR-CHANGING / NEEDS DECISION |
| `apps/node-backend/src/services/prices/priceCache.js:98-109` | `countChangedPointPrices` zips before/after price arrays positionally — after an upsert the after-set can differ in length/membership, so the "changed" count is meaningless. | BEHAVIOR-CHANGING (counts/logs only) |
| `apps/node-backend/src/services/calculations/recurrence.js:66-69` | `"every 0 days"` matches the custom-pattern regex and returns the same date — infinite-loop risk for any "advance until > now" caller; also `isValidPattern` rejects custom patterns entirely (inconsistent). | BEHAVIOR-CHANGING (guard `N >= 1`) |
| `apps/node-backend/src/services/calculations/loanSchedule.js:98-99` | Interest-only loan with 0% rate reports `regular_payment_amount` as `0` (the balloon still repays principal, so the schedule isn't broken — just the headline number). | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/aiChat/tools/portfolio.js:157-158,515-516` | `getReturnsForRange`/`getBestWorstPerformers`/`getDividendIncome` use `new Date(to).getTime()` (UTC midnight) as the upper bound — excludes same-day non-midnight timestamps. `tax.js` does this correctly. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/aiChat/tools/insights.js:165-177` | `getRecipientInsights` caps the scan at `limit: 50_000` with no `truncated` flag in `meta` — silently truncated aggregates for high-volume recipients. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/services/aiChat/tools/expenses.js:574-575` | `pctChange` is `null` when `prev === 0 && curr > 0` (infinite growth) — arguably should be flagged. | BEHAVIOR-CHANGING (minor) |
| `apps/node-backend/src/services/aiChat/tools/_validate.js:21-31` | `parseDate` regex-checks `YYYY-MM-DD` then `new Date(...)` which rolls `2025-02-30` to Mar 2 — the bad string reaches SQL and surfaces as a generic error instead of a clean validation error. | BEHAVIOR-CHANGING (error path only) |
| `apps/node-backend/src/services/_shared.js:68-74` | `parseAmountField` treats `"1,234"` (single comma, 3 trailing digits) as `1.234` — ambiguous US-thousands vs EU-decimal input. | BEHAVIOR-CHANGING / NEEDS DECISION |
| `apps/node-backend/src/services/calculations/forecast/methods/monteCarloBlockBootstrap.js:73-88` | `bands` is built then fully replaced by `bandsByDate` — dead intermediate allocation (cleanup only). | MINOR |
| `apps/node-backend/src/services/calculations/forecast/prng.js:31-37` | `gaussian()` consumes RNG state even when `std === 0` — **do not "fix"**: changing it would alter the seeded MC sequence. | DO NOT FIX (noted for awareness) |

## 9. Minor / low-confidence / hygiene

| File:line | Issue | Class |
|---|---|---|
| `apps/frontend/src/utils/currency.ts:190` | `formatAmountWithSymbol` hardcodes `.toFixed(2)` — ignores the user's decimal-places setting and locale grouping (deliberately a "simpler" variant of `formatCurrency`). | RISKS UI/FEEL |
| `apps/frontend/src/components/shared/dateUtils.ts:54-65` | `formatDistanceToNow` uses inconsistent divisors (`30`/`30.44`, `365`/`365.25`) for bucket cutoff vs displayed value — odd boundary strings. | RISKS UI/FEEL |
| `apps/frontend/src/components/charts/{Sparkline,LineChart,AreaChart}.tsx` | `Math.min(...data)`/`Math.max(...data)` → `[Infinity,-Infinity]` domain on empty data (renders nothing anyway) and a theoretical stack-overflow on very large arrays. Use `d3-array` `extent`. | LOW-CONFIDENCE / MINOR |
| `apps/node-backend/src/lib/csv.js:24` | `escapeCsvValue` quote-trigger covers `,"\n` but not `\r` — a bare CR can corrupt a row for strict parsers. `neutralizeCsvFormula` prefixes leading `\r`/`\t` but doesn't force quoting. | BEHAVIOR-CHANGING (adds quotes) |
| `apps/node-backend/src/lib/csv.js:12-19` | `neutralizeCsvFormula` checks the *trimmed* first char but prefixes the *untrimmed* value — the neutralising quote isn't guaranteed to be the literal first character. | BEHAVIOR-CHANGING |
| `apps/node-backend/src/lib/slugify.js:16-24` | `slugify('Café')→'caf'`, `slugify('日本')→''` — callers using the result as a unique key/URL segment can collide. Needs a call-site policy review. | NEEDS DECISION |
| `apps/node-backend/src/services/currency/currencyConversionService.js:96-109` | When the DB is empty `getRates()` returns fallback without populating `memoryCache` — every subsequent conversion re-runs `loadFromDatabase()` until `warmCache` succeeds. | BEHAVIOR-CHANGING (perf, DB-empty only) |
| `apps/node-backend/src/services/currency/currencyConversionService.js:276,281,310,315` | `!fromResolved.rate` / `!toResolved.rate` treats a `0` rate as "unsupported" — fragile null check (rates are realistically never 0). | LOW-CONFIDENCE |
| `apps/node-backend/src/services/quoteBackfillService.js:438-478` | `refreshActiveHoldingQuotes` counts one `failed`/`refreshed` per investment regardless of how many price windows succeeded — partial-success metrics are misleading. | BEHAVIOR-CHANGING (metrics) |
| `apps/node-backend/src/services/attachmentService.js:100-104` | `resolveAbsolutePath` relies on a `startsWith(root + sep)` check to catch absolute `storedPath` escapes — currently safe (stored paths are always relative) but worth a hard up-front reject. | LOW (defense-in-depth) |
| `apps/node-backend/src/integrations/ollama/client.js:95` | Error response body is read into `_payload` then discarded — could be attached to `OllamaError.details` for debuggability. | MINOR |
| `apps/node-backend/src/routes/admin.js:39-70` | `fetchLatestRelease` can double-settle the promise (`reject` then a later `resolve` on `end`) — harmless with Promises but untidy. | MINOR |
