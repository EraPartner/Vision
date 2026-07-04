# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

## How to use this file

- **Findings** (grouped by domain, ordered by priority) = what to implement. Each carries a `↪ from:` line naming the research pass it came from.
- **Feature work** = designed-but-unbuilt features (specs, not audit findings).
- **Still to research — resume points** = where an audit stopped; pick these up to continue researching.
- **Checked clean — do NOT re-audit** = already verified sound; don't spend time re-checking.
- **Refuted — do NOT re-add** = claims investigated and disproven; don't re-file them.
- **Stale docs** = KB/doc fixes noticed in passing (not code bugs).
- **Research context & coverage notes** = scope/method/caveats from the original passes (archive; safe to trim).

Findings are single-pass research unless a `from:` line says "adversarially verified" (the 2026-06-30 audit) — confirm against current code before acting.

## ⚠️ Binding constraints (read before acting)

**Design direction constraint (from the user — binding):** the rich aesthetic (aurora/WebGL,
glass, jewel accents per ADR-105, hover character) is deliberate and was *re-instated after a
flatten redesign was reverted*. Findings must refine toward "Apple-polished rich", never propose
flattening, removing the aurora, or genericizing toward shadcn defaults. "Less AI slop" here
means *more* intentionality and specificity, not less character.

**⚠️ Visual-impact caveat (added 2026-07-02, per the user's design stance — keep the rich
aurora/glass/hover aesthetic, ADR-105; a flatten redesign was reverted once already):** the
*findings* are invisible GPU/paint costs, but some of the *suggested fixes* would visibly change
the look. Prefer the visually-free fix where one is listed; get user sign-off before applying any
look-changing one.

## Findings

### 🔒 Security

- [ ] **Admin DB data-editor's raw WHERE clause is a SQL-injection oracle, reachable cross-site with no auth by default** 🔺 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Security (backend)_
  - `apps/node-backend/src/services/dbEditor.js:172-178` (`readRows`), `apps/node-backend/src/routes/admin.js:259-279`, mount order `main.js:307`
  - The `where` query param is concatenated into the SQL with only a `;`-block guard (ADR-101's documented "raw WHERE escape hatch"). Because it's a **GET**, the CSRF guard's safe-method exemption lets a cross-site page trigger it; response *timing* (via `pg_sleep()` in the WHERE expr) survives CORS, making this a practical blind-SQLi timing oracle against the whole schema — not just the URL's table. `adminAuthMiddleware` is a no-op when `ADMIN_AUTH_TOKEN` is unset (the default), so if the port is ever exposed beyond loopback this becomes a trivial full-DB-read primitive.
  - Fix: drop the raw-WHERE escape hatch (the structured `filters[]` path already covers safe column/op/value filtering), or at minimum: fail closed (require non-empty `ADMIN_AUTH_TOKEN`) for any route exposing this, and don't rely on the GET/safe-method CSRF exemption for it.
  - Verification (2026-06-30): re-confirmed, if anything understated. A bare `--` in the WHERE clause also silently truncates the rest of the single-line SQL (ORDER BY/LIMIT/OFFSET) — a second bypass the original finding didn't mention. **Bonus finding: `docs/adr/101-db-data-editor.md:45-47` itself asserts "the raw-WHERE escape hatch rejects `;`. A hostile WHERE clause can therefore neither mutate nor hang the database" — that claim is false; the project's own design doc has the same blind spot as the code. Fix the ADR text alongside the code.**

- [ ] **Verbose PostgreSQL error text returned to API clients in production** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Security (backend)_
  - `apps/node-backend/src/services/dbEditor.js:472-480` (`mapDbError`, SQLSTATEs `42601/42703/42883/42P01`)
  - These map to `ValidationError` (4xx), and `errorHandler.js` always shows 4xx text verbatim on the assumption "4xx messages are authored by us" — but here the message is raw driver text, contradicting `docs/security/data-protection.md`'s stated policy of suppressing DB error details, and handing schema/column feedback to anyone probing the injection above.
  - Fix: replace `err.message` with a generic "invalid query" string for these codes (or gate behind `!isProduction()`).

- [ ] **Backend DB role is the Postgres bootstrap superuser — no least-privilege application role** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Security (backend)_
  - `docker-compose.yml:7` (`POSTGRES_USER: ftm_user`), `.env.example:19-20`
  - The runtime connection pool (including the dbEditor path above) runs as the same superuser the official Postgres image bootstraps. Any successful injection or compromised dependency has instance-level reach.
  - Fix: create a non-superuser application role scoped to the app schema; keep DDL/migrations on a separate, more-privileged role used only by Alembic.

- [ ] **Admin auth is optional by default, with only a startup log line as the safety net** 🔼 ✅ *(same root cause as DevOps finding below — fix once)*
  - ↪ _from: Codebase audit 2026-06-30 · Security (backend)_
  - `apps/node-backend/src/middleware/adminAuth.js:36-51`, warning at `main.js:411-414`
  - When `ADMIN_AUTH_TOKEN` is unset, `/api/admin/*` (including destructive routes) has no per-request check; the only safeguard is "the operator kept the port on loopback," signaled by a log line a self-hosted user is unlikely to read.
  - Fix: hard-fail (or visibly banner in the Electron UI) if a non-loopback bind address is detected with no token configured, rather than log-only.
  - Verification (2026-06-30): re-confirmed exactly. **Bonus finding: the startup warning text itself overstates protection — it claims "the CSRF guard blocks cross-site browser requests," which is true only for state-changing methods, not for the GET-based SQLi oracle above. Fix the warning copy alongside the real fix.**

- [ ] **Hardcoded weak default DB credential fallback in source** 🔽 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Security (backend)_
  - `apps/node-backend/src/config/env.js:60` — default `DATABASE_URL` is `postgresql://ftm_user:ftm_password@localhost:5432/financial_transactions`
  - If `DATABASE_URL` is ever unset outside the documented Docker flow, the backend silently connects with a guessable password instead of failing closed.
  - Fix: make `DATABASE_URL` required (no default) outside development, or loudly warn when the literal default is in effect.

### 🐛 Correctness

- [ ] **Vision CSV export mangles negative amounts → re-importing a Vision export silently drops every expense row** 🔺 *(spot-verified by hand 2026-07-02: mechanism confirmed end-to-end)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `apps/node-backend/src/lib/csv.js:10-24` (`neutralizeCsvFormula`, `-` in the dangerous-prefix set) + `services/transactionExport.js:97-112` (`buildCsvRow` maps **every** column through `escapeCsvValue`, incl. `amount`/`balance`/`running_balance`) + `services/importPipeline/adapters/vision.js:19-21`
  - Amount is a pg-NUMERIC string (`"-12.34"`); the formula-injection guard prepends `'` → exports as `'-12.34`. On re-import, vision.js strips only `[€$£,\s]`, leaving the apostrophe → `parseDecimalSafe` → NaN → row counted "skipped". Round-tripping a Vision export imports income and silently drops **all expenses**; negative `Balance` values corrupt the same way.
  - Fix: don't apply the formula guard to numeric columns in `buildCsvRow`; defensively strip a leading `'` in vision.js amount cleanup.

- [ ] **Commit-phase field dedup collapses genuinely distinct same-day transactions (incl. within one import batch)** 🔺
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `apps/node-backend/src/services/importPipeline/commit.js:102-127`
  - Field check = `date + amount + recipient_id + memo` — no `bank_account`, no exclusion of rows inserted by the same batch. Two same-price card payments at the same merchant on the same day (Revolut memo `"CARD_PAYMENT - CURRENT"` is identical, revolut.js:61) pass hash-validate (different balances → different `tx_hash`) but the second hits the first at `dupCheck` inside the same DB transaction → marked `duplicate` → a real transaction is lost. Also collapses identical purchases across two different accounts. The comment at commit.js:103-104 claiming memo discriminates is wrong for card payments.
  - Fix: skip the field-based check when the candidate has a `tx_hash` and the match is same-`import_batch_id` (or both have differing non-null hashes); add `bank_account` to the predicate.

- [ ] **Brokerage cash rows lose their sign — withdrawals credited as deposits** 🔺 *(critical)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `services/portfolioImportPipeline/portfolioGenericAdapter.js:16-21,45` (stores every amount as `Math.abs(n)`) + `services/portfolioImportPipeline/commit.js:93-97` (inserts `Number(row.amount)` verbatim); `importPipeline/brokerageRouting.js:31-37` (`classifyBrokerageRow`) carries no sign
  - Statement row `kind=withdrawal, amount=500` → staged `+500` → `transactions` row `+500` on the cash sleeve. Every withdrawal *raises* sleeve cash; error grows 2× per withdrawal.
  - Fix: stamp direction from the cash kind at validate/commit (deposit/transfer-in → `+|amount|`, withdrawal/transfer-out → `−|amount|`).

- [ ] **Brokerage-batch rollback deletes wrong-table ids — can hard-delete unrelated portfolio trades** 🔺 *(critical; spot-verified by hand 2026-07-02)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `commit.js:100-103` (cash rows store a **`transactions`** id into `committed_txn_id`) + `repositories/portfolioImportBatchRepository.js:134-141` (`getCommittedTxnIds` has no route filter) + `services/portfolioImportBatchService.js:65-76` (feeds every id to `portfolioTransactionRepository.hardDelete` = `DELETE FROM portfolio_transactions[_base]`)
  - The two tables have independent sequences: brokerage deposit → `transactions.id = 812` → rollback hard-deletes **unrelated portfolio trade id 812** and leaves the imported cash row in the ledger. Distinct from the known orphaned-cash-legs finding — this is cross-table id confusion deleting someone else's trade.
  - Fix: persist the route (or `committed_target` column) alongside the id; roll back cash rows via `DELETE FROM transactions`, trades via the repo.

- [ ] **Systemic: `formatDateToYmd` uses UTC extraction on pg-read DATE values — shifts every date back one day, all day, every day (Brussels)** 🔺
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c_
  - `apps/node-backend/src/lib/dateFormat.js:8-9`; its own doc comment (lines 3-6) **falsely claims** UTC extraction is "correct for pg-read DATE values". Affected call sites:
    - `repositories/infoRepo.statistics.js:53` — past-6-months spending buckets every txn one day early; txns on the 1st land in the **previous month**; a txn on the 1st of (month−6) creates a 7th month key → wrong monthly/daily averages
    - `infoRepo.statistics.js:82` — current-month daily map shifted −1; 1st-of-month txns get a previous-month key
    - `repositories/infoRepo.forecast.js:313,423,520` — daily aggregation feeding the forecast engine: entire history shifted one day
    - `repositories/infoRepositoryPlanned.js:109` — non-recurring planned txn dated the 1st of next month → dateStr = last day of current month → fails the `>= startYmd` check (line 112) → **silently dropped** from next-month forecast
    - `routes/info/rates.js:48` — `rate_date` emitted as previous day; `isStale = storedDate < today` → freshly-fetched same-day rates always read stale → spurious staleness/refetch churn
    - `repositories/infoRepositoryNetWorth.js:53` — `first_data_date` one day early (low impact)
    - `services/aiChat/tools/insights.js:161-162`, `aiChat/tools/planned.js:26-31` — dates one day early in AI-chat output
    - `repositories/infoRepo.monthly.js:64` — `month_start` → FX-lookup dateStr = last day of previous month; currently muted (fast path only runs on identity conversion) but latent
  - Fix: make `formatDateToYmd` use local getters for Date inputs (the pattern `importPipeline/commit.js` already documents), or `to_char(col,'YYYY-MM-DD')` in SQL; correct the misleading comment.

- [ ] **Belgian inflation DB-load shifts every month key back one month — each month gets the prior month's inflation rate** 🔺
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c_
  - `services/belgianInflationService.js:79` (`monthKeyFromDatabaseValue`: `value.toISOString().slice(0,7)`), fallback at `:87`; `belgian_inflation_rates.month_date` stores first-of-month
  - pg reads `2026-06-01` as local midnight → `toISOString().slice(0,7)` = `'2026-05'` → `loadFromDatabase` labels every rate with the prior month; downstream (snapshotBuilder compounding) applies the wrong month's rate, and the most recent month appears missing. Only the DB path is affected (Statbel/Eurostat JSON keys are text-parsed and safe), but DB fallback is the designed offline/self-hosted path.
  - Fix: local getters (`getFullYear`/`getMonth+1`) or `to_char(month_date,'YYYY-MM')` in the SELECT.

- [ ] **`moveHoldingService` computes wrong remaining units and cost basis when moving holdings between accounts** 🔺 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Portfolio / investments_
  - `apps/node-backend/src/services/portfolio/moveHoldingService.js:109-114` (netUnits), `:136,156-181` (FIFO lot walk)
  - Two compounding bugs: (a) `netUnits` only sums `buy`/`gift`/`sell` rows — `split` and `return_of_capital` events are silently ignored (unlike `applyEventToLots`/`snapshotBuilder.js`, which do apply them), so post-split unit validation is stale; (b) the FIFO partial-move walk doesn't net out units already consumed by intervening sells, so it can pull from a lot a prior sell already fully consumed, moving the wrong cost basis to the destination account.
  - Fix: replay split/RoC events and prior sells (mirroring `calculateCostBasisFIFO`'s lot-replay) before walking lots for validation or the move.
  - Verification (2026-06-30): re-confirmed by hand-tracing a concrete scenario (buy 10@lotA, buy 10@lotB, sell 8 → true FIFO leaves 2 of A + 10 of B = 12 net). A later partial move physically overwrites the source lot's stored `units`/`amount` columns, which **also retroactively changes the FIFO-replay cost basis of the historical sell that happened before the move** — the bug is more compounding than originally described.

- [ ] **Orphaned trade-linked cash legs on investment delete and on portfolio-import rollback** 🔺 ✅ *(confirmed independently by three audits — API/ADR-drift, backend-performance, and the verification pass)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Portfolio / investments_
  - `apps/node-backend/src/controllers/investmentController.js:373-378` (`deleteInvestment`), `apps/node-backend/src/services/portfolioImportBatchService.js:65-76` (`rollbackBatch`) — vs. the correct cascade at `investmentController.js:464-477` (`deleteTransaction`, which calls `deleteTradeCashLegs` citing ADR-090)
  - Neither `deleteInvestment` nor a rolled-back import batch cleans up the cash-sleeve legs (`portfolio_transaction_id` isn't a real FK, so nothing cascades automatically). This leaves cash legs pointing at deleted/nonexistent trades — silent ledger corruption feeding net worth (ADR-093) and reconciliation (ADR-094).
  - Fix: add the same `deleteTradeCashLegs` cascade to both paths before/alongside the hard-deletes; also add an `import_batch_id` column to the portfolio transaction tables (see Performance section) so rollback can do this in one batched pass instead of a per-row loop.
  - Verification (2026-06-30): re-confirmed — `deleteTradeCashLegs` has exactly one call site in the entire codebase (the one correct path), proving the other two paths genuinely never clean up.

- [ ] **Belgian TOB tax-table cap is wrong in the backend — wrong number on every generated tax report** 🔺 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Belgian tax_
  - `apps/node-backend/src/services/reports/belgianTaxTables.js:9-14` — `TOB_DEFAULT.sharesAndOther.cap = 4000`
  - The canonical source `apps/frontend/src/lib/belgianTax/constants.ts:354,493` has `cap: 1_600`, with an explicit comment confirming 1,600 is correct ("NOT 4,000 — that cap belongs to the 1.32% rate only"). The backend value is a copy-paste of the wrong cap. Every PDF tax report's TOB table currently shows €4,000 instead of €1,600.
  - Fix: delete the duplicated constant table; import/derive from one shared source (e.g. move into `@vision/shared-utils`, as already done for portfolio math), or add a CI diff check between the two tables.
  - **External verification (2026-06-30):** confirmed against (1) FOD Financiën/SPF Finances official page (financien.belgium.be — taks op de beursverrichtingen), (2) curvo.eu's TOB breakdown, and (3) PwC Worldwide Tax Summaries Belgium (general corroboration). All agree: bonds = 0.12%/€1,300 cap; shares & other = 0.35%/**€1,600** cap; capitalization (accumulating) funds = 1.32%/€4,000 cap. The backend's `sharesAndOther` entry is using the capitalization-fund cap. No indexation change explains the discrepancy — these figures haven't moved 2024→2026. Frontend's other 3 tiers (bonds, accumulatingFunds, distributingFunds) already match the backend exactly; only this one field is swapped.

- [ ] **Tax report under-reports sell-side TOB by mislabeling it "Capital Gains / Sell Tax" — materially misleading, not just a rounding gap** 🔺 🔧 *(escalated — verification found the mislabeling is worse than originally described)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Belgian tax_
  - `apps/node-backend/src/services/reports/dataFetcherTax.js:195-212,299-300`
  - For `type === 'sell'`, all of `pt.taxes` is bucketed into `sellTaxTotal` and never into `tobTotal` — confirmed Belgian TOB genuinely applies on **both** the buy and sell leg of a stock-exchange transaction (confirmed via FOD Financiën official guidance — "transfer and acquisition" are both taxable — and curvo.eu: "you pay the TOB every time you buy or sell"). **The accumulators don't just differ internally — they render under distinct labels in the actual PDF**: `tobTotal` is labeled "TOB (Transaction Tax)" and `sellTaxTotal` is labeled "Capital Gains / Sell Tax" (`services/reports/sections/taxExecutiveSummary.js:88-89,97,111,113` and `taxTypeBreakdown.js:18,20`). Belgian capital gains tax was 0% through 2025 and only became 10% in 2026 — a user could see a nonzero "Capital Gains / Sell Tax" line on an older report and reasonably read it as CGT, when it's actually unlabeled TOB. Separately, `taxProfile ?? null`/`precomputedPIT ?? null` violate the "use `undefined`" convention at a non-repository-boundary layer.
  - Fix: split TOB out explicitly at write time instead of inferring from `type`, and route sell-side TOB into the same `tobTotal`/"TOB (Transaction Tax)" line as buy-side, not into a separately-labeled "Capital Gains" line; swap the two `?? null` to `?? undefined`.

- [ ] **Account/Category edit dialogs silently revert in-flight unsaved edits on ANY parent re-render, not just on Save — possible silent data loss** 🔺 🔧 *(broader than originally described)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/features/accounts/AddAccountDialog.tsx:69-84`, `apps/frontend/src/features/categories/AddCategoryDialog.tsx:42-46`
  - `editProps` is just `props`, recreated as a fresh object on every render (function-component args always are). The `useEffect` depends on `[editProps, editProps?.initialValues, editProps?.open]`, so it re-fires on **every re-render of the dialog while it's open in edit mode** — not only when Save flips `isPending`. A background query refetch, an unrelated state change in the parent page, or any other re-render while the dialog is open wipes in-progress edits, since inputs are never disabled during save (only the submit button is). `CategoriesPage.tsx` passes the identical fresh-object-literal pattern to `AddCategoryDialog`.
  - Fix: key the resync on a stable primitive (record id + open/closed transition) instead of the whole props object, or remount via `key={editing.id}`.

- [ ] **Net worth is never invalidated by the common account/investment CRUD mutations** 🔺 🔧 *(scope of the "already correct" exceptions widened)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/hooks/useAccounts.ts:23,40,74` (create/update/delete invalidate only `['accounts']`), `apps/frontend/src/hooks/portfolio/useInvestments.ts:59-64` (`invalidateAll` misses net-worth)
  - No targeted invalidation of `'net-worth'`/`'net-worth-by-account'` exists in any of the common CRUD mutations. `NetWorthPage.tsx` sets an explicit 2-minute `staleTime` on both net-worth queries, plus the global `refetchOnWindowFocus: false` default, so a stale total really does persist for up to 2 minutes after a CRUD edit.
  - Fix: add `['net-worth']`/`['net-worth-by-account']` to account CRUD and `useInvestmentMutations.invalidateAll`.
  - Verification (2026-06-30): `useMergeAccounts`, `CloseAccountDialog.tsx`, and `MoveHoldingDialog.tsx` all already call a blanket `queryClient.invalidateQueries()` (no key) that happens to cover net-worth too — more exceptions than the single one originally noted. These are rare paths, though; the core complaint (common create/update/delete CRUD leaves net worth stale) holds exactly as described.

- [ ] **Ticker collision → silent wrong-investment match that auto-commits with no review** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `portfolioImportPipeline/matchInvestments.js:86-94` (`LOWER(symbol)=LOWER($1) ... ORDER BY id ASC LIMIT 1`, treated as a strong match) + `portfolioImportPipeline/index.js:48-53` (all-symbol-matched batches auto-commit)
  - Two active investments sharing a ticker (dual-listed, or a user placeholder duplicating a real one) → every row silently resolves to the lowest id → wrong holding's cost basis corrupted with zero confirmation — exactly what the file header says it exists to prevent.
  - Fix: >1 case-insensitive symbol match (or row-currency ≠ investment-currency) → mark unresolved / force review.

- [ ] **Trade + cash leg not atomic; a failed leg is silently permanent** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `commit.js:155-165` + `tradeCashLegService.js:59-81` — trade commits on its own connection; leg failure only logs a warning and keeps the trade. ADR-095 requires "fan-out in one DB transaction; all-or-nothing per row group".
  - Leg insert fails → trade exists, sleeve never debited → cash overstated by the full trade cost; re-import can't repair (trade dedups as duplicate, leg never recreated).
  - Fix: one transaction for trade+leg (thread a client through), or delete the trade + mark row `error` on leg failure.

- [ ] **Sell-availability validation ignores `split` — legitimate imported sells rejected** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `repositories/portfolioTxRepo.common.js:241-266,271-290` — `getNetUnitsOnOrBeforeDate` sums only `buy/gift − sell`; `split`/`merger`/`spinoff` ignored
  - Buy 10 → split to 20 → statement sell of 20 → available computed 10 → `'sell units exceed available holdings'` → row errors at commit (then stranded, see below). Same family as the known moveHoldingService finding, different call site — this gates **every** import commit and manual create/update. (The validation also being investment-wide rather than per-account is already tracked in memory.)
  - Fix: replay units the way snapshotBuilder does (split sets new total), ideally via the shared calculator.

- [ ] **Unmarking a false-positive transfer is not sticky — it auto re-pairs ~1s later, making the unmark endpoint a no-op for its documented purpose** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b · Transfer reconciliation (ADR-083)_
  - `services/transferReconciliationService.js:189-205` (`unmarkTransfer` resets both legs fully "open") + `routes/transactions.js:230-233` (route then calls `scheduleReconcile()`); `loadCandidatePairs` (:37-40) only excludes `transfer_source IS NOT NULL`
  - The just-unmarked pair still satisfies every auto-pair condition → re-paired by the very reconcile the unmark triggered. `DELETE /api/transactions/transfers/:id` exists to "handle false positives" and cannot.
  - Fix: persist the dismissal — `transfer_source='dismissed'` (with `is_transfer=false`), or a dismissed-pair table checked in `loadCandidatePairs`/`releaseInvalidAutoPairs`.

- [ ] **`markTransfer` over an already-paired row strands the old peer as a phantom one-way transfer, silently excluded from cash-flow aggregates forever** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b · Transfer reconciliation (ADR-083)_
  - `services/transferReconciliationService.js:173-180` — the two UPDATEs have no `is_transfer=false` guard (unlike the auto path at :100-109)
  - A auto-paired with C; user marks A↔B → C keeps `is_transfer=true, transfer_peer_id=A, transfer_source='auto'`. Nothing releases C: `releaseOrphans` requires `transfer_peer_id IS NULL`; `releaseInvalidAutoPairs` (:70-79) checks amount/currency/account/date vs A (still satisfied) but never **reciprocity** (`p.transfer_peer_id = t.id`). Manual-source marks aren't re-evaluated at all.
  - Fix: inside `markTransfer`'s transaction, first unmark existing peers of both A and B; add `AND p.transfer_peer_id = t.id` to `releaseInvalidAutoPairs`.

- [ ] **Any category/recipient exclusion silently drops ALL uncategorized / recipient-less transactions — shared defect in all three exclusion-clause implementations** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b · Materialized views / aggregations_
  - `services/filterBuilder.js:258-269`, `repositories/infoRepo.monthly.js:128-133`, `repositories/infoRepositoryStatistics.js:99-104` — all emit bare `COALESCE(...) NOT IN ($ids)`; for a row with no category at any level the COALESCE is NULL, `NULL NOT IN (…)` → NULL → row dropped
  - Excluding one category (e.g. GIFTS) from the dashboard vanishes every uncategorized transaction from monthly income/spending totals; excluding one recipient drops every recipient-less transaction. *(The three implementations were compared as requested: textually and semantically identical — this is a shared defect, not a divergence. Minor internal inconsistency in `getCategoryPivot`: display/guard use 2-level COALESCE vs 3-level exclusion — verified no user-visible divergence.)*
  - Fix: `(COALESCE(...) IS NULL OR COALESCE(...) NOT IN (...))` in all three places.

- [ ] **Image-update / dev-rebuild container recreate drops the PORT env → app republishes on 3002, session breaks** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Electron shell (`packaging/electron/main.js`)_
  - `main.js:1315-1318` — `restartAppContainer()` runs `compose up -d --no-deps app` with the default `dockerEnv`, no `PORT` injection, unlike every other compose start path (`startContainers` :1220, `composeStartOrUp` :1273, restore paths :2367,2563); compose interpolates `127.0.0.1:${PORT:-3002}:3002` + `CORS_ORIGINS` (`resources/docker-compose.yml:29,42`)
  - Persisted `appPort` = e.g. 41372; `update:pull-image` (:2399) or the dev hot-rebuild watcher (:3390) recreates the container on **3002** with wrong CORS → Electron keeps polling 41372 → "backend lost"; unusable until relaunch (next boot self-heals, masking the cause).
  - Fix: pass `{ ...dockerEnv, PORT: String(appPort) }` in `restartAppContainer`; also use `composeArgs()` in `pullLatestImage` (:1305).

- [ ] **Embedded compose in userData is never refreshed after first install — the copy-on-update branch is unreachable** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Electron shell (`packaging/electron/main.js`)_
  - `main.js:365-370` (early return when `settings.embeddedDir` exists) vs `:373-380` (the "Overwrite if exists to allow updates on new app versions" branch that can therefore never run)
  - Any compose change shipped in a new version (new named volume, healthcheck, security opt) never reaches upgraded installs — exactly the v1.0.2 data-loss channel: a new volume in `resources/docker-compose.yml` is absent from the old userData copy; with `read_only: true` the backend can't write that path at all.
  - Fix: on every packaged launch, overwrite the embedded compose from `process.resourcesPath` (leave `.env` alone), or hash-compare and refresh on change.

- [ ] **Category resolution is inconsistent between list endpoints and single-row endpoints — alias recipients show as uncategorized on GET/POST but categorized on list views** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Categorization_
  - `apps/node-backend/src/repositories/transactionRepository.js:313-333` (`getById`), `:341-393` (`create`) vs. `:18-24` (`TRANSACTION_JOINS`)
  - `getAll`/`getAllWithCount` resolve category via a 3-level fallback (own → recipient default → recipient's *primary* recipient's default) and expose `effective_category_id`. `getById`/`create` hand-roll separate SQL with only 2 levels, never computing `effective_category_id`. A transaction on an alias recipient is correctly categorized in lists but shows uncategorized when fetched/created via the single-row paths.
  - Fix: extract the category CASE + `effective_category_id` expression into one shared SQL fragment reused by `getAll`, `getById`, and `create`.

- [ ] **`PATCH`-to-clear silently no-ops on 5 account fields** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `apps/node-backend/src/services/accountService.js:44,71-92` (`sanitize()` maps explicit `null` → `undefined`), `apps/node-backend/src/repositories/accountRepository.js:95` (skips any field `=== undefined` when building `SET`)
  - `PATCH /api/accounts/:id` sent to clear e.g. `funding_account_id: null` is silently ignored — no error, no change — for `display_name`, `institution`, `funding_account_id`, `statement_balance`, `statement_balance_date`. The same bug class was already fixed once in `savedCharts.js` per its own comment, and is reintroduced here.
  - Fix: use a sentinel the repository recognizes as "set this column to NULL," not `undefined`.

- [ ] **Exchange-rate query-key mismatch breaks the admin "Refresh rates" action everywhere except its own page** ⏫ 🔧 *(impact list trimmed)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/pages/admin/ExchangeRatesPage.tsx:24,32` (key `["exchangeRates", ...]`, camelCase) vs. `apps/frontend/src/hooks/useExchangeRates.ts:16,28` and `useCurrencyConverter.ts:13,17` (key `['exchange-rates', ...]`, kebab-case)
  - Two literal key namespaces for the same backend data. Admin's refresh invalidation never reaches the kebab-case consumers: Net Worth, Portfolio Overview, Stocks, Crypto, Tax Overview, Portfolio Tax, Real Estate, Savings. Clicking "Refresh rates" only updates its own page.
  - Fix: export one shared `EXCHANGE_RATES_QUERY_KEY` constant; use it everywhere, or invalidate both literal prefixes from the refresh mutation.
  - Verification (2026-06-30): `DashboardPage.tsx` (named in the original impact list) does not actually call either hook — drop it from the affected-surfaces list; everything else named checks out.

- [ ] **FX-exposure gating on Stocks/Crypto pages is dead code — always evaluates false** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/pages/portfolio/StocksPage.tsx:73,362`, `CryptoPage.tsx:44,270` — `(h.currency || 'EUR') !== targetCurrency`
  - `usePortfolioSummaries` always sets `currency` to the *display* currency on every summary, exposing the real native currency separately as `originalCurrency`. This comparison can never be true, so the FX-gain column/banner never renders for any foreign-currency holding — the same currency-confusion bug class already fixed elsewhere (commit `54187c21`, native vs. display currency), left unfixed here. `PortfolioOverviewPage.tsx:87-88` already does this correctly via `originalCurrency`.
  - Fix: compare against `h.originalCurrency` (fall back to `h.currency` only if absent).

- [ ] **Portfolio Performance page shows a misleading empty state on fetch failure** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/pages/portfolio/PerformancePage.tsx:92-98,187-198`
  - The query never reads `isError`/`error`, only `isLoading`. A failed fetch defaults `snapshots` to `[]`, rendering "add holdings or hit Refresh Prices" — wrong when the real cause is a network/API failure.
  - Fix: capture `isError`/`error`; render a distinct error banner before the empty-state check.

- [ ] **Tax Overview page shows "set up your tax profile" on fetch failure, for users who haven't yet saved a tax profile** ⏫ 🔧 *(precision: doesn't affect users who already completed tax-profile setup)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/pages/TaxOverviewPage.tsx:81,355`
  - `useStatistics()` is the same hook `StatisticsPage.tsx` correctly checks `isError` on — here it's never read. The empty-state branch only fires when `hasProfile` is false, so a failed stats fetch makes a user who hasn't yet filled in the tax-profile dialog (but does have real transaction-derived income) see "you haven't set up tax tracking" instead of an error. Users who *have* completed tax-profile setup don't hit this branch.
  - Fix: destructure `isError`/`error`, reuse `StatisticsPage`'s error-banner pattern.

- [ ] **Belgian bank adapters hardcode UTF-8 — windows-1252/latin-1 exports corrupt recipient names** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `adapters/belfius.js:106`, `kbc.js:98`, `ing.js:85`, `bnp.js:97` — all `readFile(filePath, 'utf-8')`, no detection/fallback (only `generic.js:82` accepts an encoding)
  - Belgian bank exports are frequently ANSI: `é` (0xE9) → U+FFFD → `"CAF� REN�"` recipients → wrong/duplicate recipients, degraded pg_trgm matching, and dedup-hash drift vs a correctly-decoded re-import of the same rows.
  - Fix: decode buffer, detect invalid-UTF-8/replacement chars, fall back to `latin1` (or expose encoding option). *(Code-level risk confirmed; live bank CSV samples not inspected — verify with a real export.)*

- [ ] **Naive `split(';')` in Belfius/KBC/ING/BNP — quoted fields containing `;` shift all columns** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `belfius.js:44`, `kbc.js:27`, `ing.js:33`, `bnp.js:37` (Revolut/Wise/SABB/Vision correctly use `csv-parse`)
  - A quoted free-communication field like `"Factuur 123; klant 456"` shifts every later column → date/amount misread → row silently skipped, or worse a shifted numeric field parses as the amount. Quoted fields also keep literal `"` in recipient names, splitting recipient identity.
  - Fix: parse with `csv-parse` (`delimiter: ';'`) like the other adapters.

- [ ] **`parseDateWithFormat` has no round-trip validation — silent date rollover + 2-digit-year misparse in generic/custom imports** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `adapters/_shared.js:97-119`; affects `generic.js` and `portfolioGenericAdapter`
  - User picks `%d/%m/%Y` for a MM/DD file: `"12/25/2024"` → `Date.UTC(2024, 24, 12)` → **2026-01-12** silently imported instead of rejected; `"01/02/24"` → year **1924**. Contrast `parseDayMonthYear` (_shared.js:47-51), which round-trip-validates.
  - Fix: apply the same round-trip check (components must survive `getUTC*`, year ≥ 100).

- [ ] **Revolut collapses multi-currency accounts into one `bank_account` — same class as the fixed KBC collapse** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `adapters/revolut.js:19-24,74` — `bankAccount` = `REVOLUT <PRODUCT>` only, but the export has a Currency column (revolut.js:44); EUR+USD rows book to one account, mixing currencies in one balance series. Wise already does `WISE <CURRENCY>` (wise.js:87).
  - Fix: include currency in the label (`REVOLUT CURRENT EUR`) + ADR-088 merge note for existing data.

- [ ] **BNP imports rejected transactions; SABB imports non-completed rows** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `bnp.js:51,66-68` (parses `Status` + `Reden van weigering` but only stores them in the comment), `sabb.js:39,44` (same for `Status`)
  - A **rejected** direct debit (money never moved) imports as a real expense, corrupting balances and spend totals. Revolut (revolut.js:48) and Wise (wise.js:41) correctly skip non-COMPLETED rows.
  - Fix: skip BNP rows with a non-empty rejection reason / non-executed status; filter SABB non-completed statuses. *(Confirm status vocabulary against a real export first.)*

- [ ] **Revolut fee not applied to amount — imported amounts don't reconcile with imported balances** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `revolut.js:54-57,66` — Revolut's `Amount` excludes `Fee`; actual balance delta is `amount − fee`. Adapter imports `amount` (fee comment-only) *and* the `Balance` column → consecutive balances don't differ by the amounts; total spend understated by all fees.
  - Fix: book `amount − fee` (Decimal arithmetic) or emit a separate fee transaction.

- [ ] **Manual-dedup hash blocks re-adding a transaction forever after deletion (dangling `manual_raw_transactions` row)** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `services/deduplication.js:69-79,105-121` + `routes/transactions.js:552-564`; FK is `ON DELETE SET NULL` (`alembic/versions/0024_add_manual_raw_transaction_fks.py:46`)
  - Deleting a manual transaction leaves its hash row with `transaction_id = NULL`; re-adding the identical transaction → `ConflictError` with `existing_transaction_id: null` (points at nothing), no force/override path. Also blocks a legitimate second identical manual purchase. Inconsistency: the hash includes `bankAccount` but the fallback field query (deduplication.js:88-94) ignores it.
  - Fix: delete/invalidate the manual_raw row on transaction delete (or join `transactions.is_active`); add an explicit "add anyway" override.

- [ ] **Portfolio-import dedup ignores `account_id` — cross-account trades and legitimate repeat fills dropped** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `commit.js:215-234` (trades), `:203-213` (cash) — `isFieldDuplicate` matches (investment, date, type, amount, units) with no account filter, unlike the dormant fanout's `tradeRowExists` (`importPipeline/brokerageFanout.js:72-81`)
  - Identical buy already on the Degiro account → importing the same-shaped IBKR buy drops it as duplicate → IBKR position under-counted. Two identical same-day fills / equal same-day deposits: the second is always dropped.
  - Fix: include `account_id` (and currency) in both predicates; consider an order-reference column for legitimate same-day duplicates.

- [ ] **Commit errors strand staging rows permanently; batch still marked `complete`** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `portfolioImportPipeline/index.js:66-72` (status `'complete'` unconditional) + `portfolioImportBatchRepository.js:100-108` (`overrideInvestment` only touches `status='matched'`; `commitBatch` only drains `'matched'`)
  - E.g. brokerage batch committed with account unset → every cash row errors (`commit.js:76-79`) → batch `'complete'`, no repair path; full re-upload then dedups the already-imported trades, confusing counts further.
  - Fix: `complete_with_errors` state that re-opens review; let override reset `error → matched` and allow re-commit.

- [ ] **Snapshot `value_by_account`: splits never rescale per-account weights → per-account history under-attributes after split-then-sell** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `services/portfolio/snapshotBuilder.js:437-441` (split updates `unitsByInvestment` only) vs `:332-349,398-426` (weights)
  - Account A: 10 units (weight 10) → 2:1 split → sell 10 post-split units → weight 0 though 10 units remain → `splitByAccount` sees `totalW ≤ 0`, attributes nothing → Σ `value_by_account` < aggregate. The parity test only catches this with a split-then-sell fixture.
  - Fix: on split, rescale every account weight by `newTotal/oldTotal`.

- [ ] **`return_of_capital` ignored for non-unit assets (savings/bond/real_estate) — invested + value overstated forever** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `snapshotBuilder.js:442-451` — branch gated on `heldUnits > 0` (always 0 for non-unit classes); never touches `nonUnitState.runningInvested` (contrast sell at `:436`)
  - Bond: buy 10 000, RoC 2 000 → snapshot `invested` and `value` stay 10 000.
  - Fix: add a non-unit branch reducing `runningInvested`, mirroring sell.

- [ ] **UTC-derived "today" instead of `todayAppDateString()` at 5 sites — wrong between 00:00 and 01:00/02:00 Brussels** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c_
  - `repositories/plannedTransactionRepository.js:624` — execution recorded with **yesterday's** date if executed after midnight
  - `services/aiChat/tools/planned.js:52-56,61-62,90-91,~264-271,~338` — upcoming-planned window starts a day early / ends a day short at night
  - `services/aiChat/tools/expenses.js:499-503` — today's transactions excluded from trend queries between midnight and 02:00
  - `services/calculations/forecast/index.js:76-86` (`rollingWindowDates`) — actuals/forecast split sits on yesterday at night
  - `services/reports/index.js:602` — PDF filename date only (cosmetic)
  - Fix: `todayAppDateString()` / `toAppTz` from `lib/timezone.js`.

- [ ] **Recurring-detection emits raw pg Date objects through JSON — consumers slicing the date part see the previous day** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c_
  - `services/recurringDetectionService.js:249-250` — `firstSeen`/`lastSeen` serialize via `toJSON`→`toISOString` → `"2026-06-30T22:00:00.000Z"` for a July-1 transaction. (`predictedNext` at :251 is safe — rebuilt via local getters.) *Frontend consumer not verified — check before fixing.*
  - Fix: format with a local-getter ymd helper before emit.

- [ ] **`period_end` is the second-to-last day of every month on the monthly-summary MV fast path** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c_
  - `repositories/infoRepo.monthly.js:116` — `formatDateToYmd(new Date(m.year, m.month, 0))`: local-midnight last-of-month → UTC extraction → `'2026-06-29'` instead of `'2026-06-30'`. `infoRepositoryPlanned.js:45-47` shows the correct `Date.UTC` pattern.
  - Fix: `new Date(Date.UTC(m.year, m.month, 0))` (subsumed by the `formatDateToYmd` fix above).

- [ ] **Frontend uses no Zod form validation at all, despite CLAUDE.md stating it as the convention** 🔼 *(systemic — root cause of the per-form gaps below)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a_
  - Only `apps/frontend/src/lib/env.ts` imports zod in the entire frontend; every financial form does ad-hoc manual validation of varying quality.
  - Fix: either adopt Zod schemas for the financial forms (transactions, portfolio txns, accounts, tax profile) or update CLAUDE.md to describe the real convention — currently the doc misleads audits and new code.

- [ ] **Garbage input in Fees / Taxes / FX-rate fields silently becomes 0 — corrupts EUR conversion of the transaction** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a_
  - `apps/frontend/src/components/portfolio/AddPortfolioTxnDialog.tsx:132-134` + `lib/decimal.ts:12` (`parseDecimal(value, fallback = 0)`)
  - Amount/units/price use `parsePositive` (NaN fallback + finite/positive check) — but `fees`, `taxes`, `fx_rate_to_eur` use `parseDecimal(v)` with the default-0 fallback. Typing "0,5%" (or any unparseable string) into FX rate submits `fx_rate_to_eur = 0`; garbage fees/taxes silently become €0. *(Note: backend repo guards reject `fx_rate_to_eur ≤ 0` per Wave 1b — so the FX case errors server-side; fees/taxes→0 goes through silently.)*
  - Fix: `parseDecimal(v, NaN)` + reject non-finite (or reuse `parsePositive`), matching the amount fields.

- [ ] **Wrong-word Dutch translation: "Who Owes You" page titled "Openstaande verordeningen" (= outstanding *ordinances*)** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a_
  - `i18n/source/nl.json` key `owesPage.title`; also three different nl renderings of the same concept (`nav.whoOwesYou` = "Verschuldigde Betalingen", `owes.title` = "Wie u iets verschuldigd is")
  - Fix: `owesPage.title` → "Wie u iets verschuldigd is", unify the nav label, regenerate locales (`bun run validate-locales` after).

- [ ] **Auto-pairing can commit a half-pair when the second leg's guarded UPDATE misses (race)** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b · Transfer reconciliation (ADR-083)_
  - `services/transferReconciliationService.js:96-111` — candidates loaded outside the write transaction; if `inId` gets marked concurrently, `r1` succeeds but `r2.rowCount=0` and the code only skips the counter — it never reverts `r1` → `outId` points at a peer that points elsewhere; same non-reciprocity gap means it's never self-healed.
  - Fix: revert the successful UPDATE when `r1.rowCount !== r2.rowCount`; the reciprocity fix above also makes this self-healing.

- [ ] **Monthly-summary MV fast path includes future-dated months; the live path structurally cannot — dashboard month set changes with code path** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b · Materialized views / aggregations_
  - `repositories/infoRepo.monthly.js:49` (lower bound only) vs `:150-155,188-189` (live path ends at current month); MV definition `services/materializedViewService.js:46` has no upper bound
  - A post-dated transaction makes the dashboard show an extra future month on the MV path; the month set flips when exclusions/`includeTransfers` toggle the code path — the exact divergence the zero-fill block (:89-106) exists to prevent.
  - Fix: `AND month_start <= date_trunc('month', CURRENT_DATE)` on the MV-path WHERE.

- [ ] **`getAverageVsCurrentSpending` computes spending stats over an arbitrary row subset via unordered LIMIT** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b · Materialized views / aggregations_
  - `repositories/infoRepo.statistics.js:29` (`LIMIT 10000`), `:38` (`LIMIT 5000`) — no ORDER BY; past 10k transactions in 6 months, averages come from whichever rows the planner returns first — silently wrong, non-deterministic across plans.
  - Fix: aggregate in SQL (SUM/COUNT grouped by date/currency, like infoRepo.monthly's `daily` CTE), drop the LIMITs.

- [ ] **Category/recipient mutations never trigger an MV refresh — stale labels/groupings served indefinitely** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b · Materialized views / aggregations_
  - Grep-verified `scheduleRefresh`/`refreshAggregations` callers: maintenance, importRoutes, dbEditor, transferReconciliation, importPipeline — `routes/categories.js` and `routes/recipients.js` absent. `mv_monthly_summary`/`mv_category_totals` embed `c.general || ':' || c.detail` and `r.default_category_id` (materializedViewService.js:41-44,64-71)
  - Renaming a category / changing a recipient default serves the old name until an unrelated transaction mutation refreshes.
  - Fix: call `scheduleRefresh()` from category/recipient mutation routes or services.

- [ ] **Hard-deleting a transaction leaves its attachment files orphaned on disk — receipt PII persists forever and re-enters every backup** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b · Attachments_
  - `routes/transactions.js:385,567` — DB CASCADE removes `attachments` rows; nothing removes files under `ATTACHMENTS_DIR` (file removal only exists in `DELETE /api/attachments/:id`, routes/attachments.js:132-155)
  - Fix: list attachments before delete, then best-effort `removeAttachmentFile` each path (same log-on-failure pattern as the attachment-delete route); optionally a maintenance orphan sweep.

- [ ] **Persisted appPort never re-validated — a foreign port squatter permanently bricks launch** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Electron shell (`packaging/electron/main.js`)_
  - `main.js:284-294` (`resolveAppPort` returns persisted port unconditionally, ":260 we never re-pick"); failure dialog + `app.quit()` at `:3294-3304`
  - If an unrelated process binds the persisted port while Vision is down, every relaunch fails "port is already allocated" until the user hand-edits settings.json. *(The old crash-recovery port-walk bug from memory is FIXED — no walk logic remains; drift check at :1263-1272 reuses/recreates correctly.)*
  - Fix: on bind-error (or `isPortFree` false with no own container on that port), pick a fresh port, persist, recreate.

- [ ] **Update-installer rollback rsync deletes `.git` and `node_modules`** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Electron shell (`packaging/electron/main.js`)_
  - `main.js:1648-1655` — snapshot excludes `.git`/`node_modules` (:1648) but the rollback `rsync -a --delete` (:1655) lacks those excludes → they're deleted from the install because absent from the snapshot. A mid-update failure (disk full) then costs a repo-mode user their entire local `.git` history.
  - Fix: add `--exclude ".git" --exclude "node_modules"` to the rollback rsync.

- [ ] **settings.json: non-atomic writes + unserialized read-modify-write across five writers** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Electron shell (`packaging/electron/main.js`)_
  - Writer `main.js:242-245`; racing callers :291 (appPort), :1467-1480 (window bounds, debounced), :2724-2729 (`backup:save-settings`), :2758-2762, :3035-3037 (splash theme)
  - Interleaved saves silently revert another writer's key (worst case `backupOnQuit` lost → quit backups silently stop); crash mid-write corrupts JSON → quarantine path (:232) discards **all** settings incl. `appPort` and `backupPassphraseEncrypted`.
  - Fix: single promise-chain mutex doing load→merge→write-temp→rename.

- [ ] **Second ⌘Q (or 45s force-exit) during quit backup exits mid-write — truncated bundle displaces good backups** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Electron shell (`packaging/electron/main.js`)_
  - `main.js:3430-3441` (second `will-quit` passes through) + `backup/bundle.js:119,133` (bundles written directly at final name, no tmp+rename); `cleanupOldBackups` (:700-737) keeps newest-7 → the corrupt newest file ages a valid backup out.
  - Fix: write to `.partial`, rename on success; retention skips/deletes `.partial`.

- [ ] **`runBundleRestore` finally-block: unguarded `pollHealth()` + unconditional attachments swap can strand or destroy the attachments dir** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Electron shell (`packaging/electron/main.js`)_
  - `main.js:2377-2387` — a restore whose boot-time `alembic upgrade` exceeds the 60s health budget reports **failure after psql succeeded** and never runs the swap (attachments stay in `.staging`); the swap shell (:2382-2385) chains the first `mv` with `;` — if staging is missing, live attachments are moved to `.old` and nothing replaces them.
  - Fix: try/catch around `pollHealth` with a bigger budget; guard the swap with `[ -d …staging ] && …`.

- [ ] **Cost-basis calculators silently clamp oversells instead of flagging a data-integrity problem** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Portfolio / investments_
  - `packages/shared-utils/src/portfolio.js:135-150` (weighted-avg), `:219-256` (FIFO), `:321-358` (LIFO)
  - When a sell's recorded lots are insufficient (e.g. an earlier buy was deleted), `sellUnits = min(units, totalUnits)` clamps and shrinks the ratio proportionally — excess gain/fees/taxes are dropped with no warning surfaced anywhere. Deleting a buy while keeping its matching sell silently understates realized gain.
  - Fix: surface a flag (mirroring the existing `_fxFellBack` pattern) when `units.gt(totalUnits)` so the response can warn.

- [ ] **"Uncategorised transactions" queue misses alias-recipient transactions that are already categorized everywhere else** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Categorization_
  - `apps/node-backend/src/repositories/transactionRepository.js:179-204,214-308` (`getUncategorised`/`WithCount`)
  - Checks only `t.category_id IS NULL AND r.default_category_id IS NULL`, never the primary recipient's default — same root cause as the finding above.
  - Fix: join the primary recipient and extend the predicate, matching `getAll`'s fallback chain.

- [ ] **Category display truncates DETAIL text that contains a colon** 🔼 ✅ *(frontend, same root cause as backend issue above is unrelated — separate bug)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Categorization_
  - `apps/frontend/src/pages/DashboardPage.tsx:224-232`, `apps/frontend/src/pages/RecipientsPage.tsx:213-221`
  - `categoryName.split(':')` then uses only `parts[1]` — a category like `general="TRAVEL", detail="FLIGHT: BOOKING.COM"` renders as just "Flight". `CategoryPivotTable.tsx:112-116` already handles this correctly via `split(":")` + rejoin.
  - Fix: apply the same join-back pattern (`const [general, ...rest] = name.split(":"); rest.join(":")`) at both call sites.

- [ ] **Stale fast-cadence recurring planned transactions silently vanish from next-month forecast** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Planned / recurring transactions_
  - `apps/node-backend/src/repositories/infoRepositoryPlanned.js:15` (`MAX_OCCURRENCES = 120`), `:22-36` (`expandRecurringOccurrences`)
  - The function walks forward from the row's stored `planned_date` (not "today") up to 120 hops to find occurrences inside next month's window. A daily-cadence row that hasn't been executed/advanced in >120 days exhausts the cap before reaching next month and returns `[]` — silently disappearing from the forecast, no error or log.
  - Fix: fast-forward `current` directly to the first occurrence ≥ `startYmd` via interval math instead of a flat linear walk.

- [ ] **Planned-transaction name resolution silently drops unmatched category/recipient instead of erroring, unlike live transactions** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Planned / recurring transactions_
  - `apps/node-backend/src/routes/plannedTransactions.js:38-75`
  - `resolveRecipientIdFromName`/`resolveCategoryIdFromName` just delete the field on no match; the equivalent live-transaction logic in `transactions.js` correctly throws `ValidationError` on the same condition. A typo'd `category_name` saves successfully with no category and no indication anything was wrong.
  - Fix: make the planned-transaction route throw `ValidationError` on unresolved lookups, or extract one shared resolver both routes call (also fixes the duplication noted below).

- [ ] **Recurring-transaction detection blends income and expense from the same recipient into one nonsensical pattern** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Planned / recurring transactions_
  - `apps/node-backend/src/services/recurringDetectionService.js:159-170,212-214`
  - Transactions are bucketed solely by `recipient_id`; amounts go through `.abs()` before averaging, with no sign/category partitioning. A recipient who both pays and is paid by the user gets both directions merged into one averaged "pattern" that matches neither real flow.
  - Fix: partition each recipient's transactions by sign (or category) before interval/amount detection.

- [ ] **Route/service boundary (ADR-067) is bypassed via direct DB access in several route files, undetected by the lint gate meant to prevent exactly this** 🔼 🔧 *(citation path corrected)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `routes/transactions.js:8,171-203,318-485`, `routes/plannedTransactions.js:8,45-75`, `routes/attachments.js:22,61` import `query`/`withTransaction` straight from `database/connection.js` and run raw SQL in route handlers. The custom ESLint rule `no-repo-direct-from-route` only blocks `/repositories/` imports, not `database/connection.js` — this larger bypass passes lint clean (verified directly by running `npx eslint` on all three files: exit 0, zero warnings).
  - Fix: move these queries into `transactionService`/`plannedTransactionService`; extend the lint rule to also flag `database/connection.js` imports under `routes/**`.
  - Verification (2026-06-30): corrected citation — the rule lives at **`apps/node-backend/eslint.config.js`** (not a bare `eslint.config.js` at repo root, which doesn't exist), and the actual matching predicate is at **line 43**, not lines 18-32 (which is the rule's JSDoc/meta block).

- [ ] **Duplicated recipient/category-name-resolution logic between `transactions.js` and `plannedTransactions.js` routes has already diverged in error behavior** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `routes/transactions.js:168-205` vs. `routes/plannedTransactions.js:38-75`
  - Near-identical raw SQL copy-pasted across two files; one throws `ValidationError` on no-match, the other silently no-ops (see the planned-transactions finding above — same fix resolves both).
  - Fix: extract one shared `resolveRecipientId`/`resolveCategoryId` helper into `recipientService.js`/`categoryService.js`.

- [ ] **CSV export's `running_balance` is a single global accumulator, not partitioned by account — same bug class already fixed on the list endpoint** 🔼 ✅ *(found incidentally during the performance audit)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Data export_
  - `apps/node-backend/src/services/transactionExport.js:196,211`
  - The main transaction-list endpoint (`transactionRepository.js:121-123`, ADR-088) was explicitly fixed to partition `running_balance` by `account_id` because "a list spanning multiple accounts summed them into one meaningless cross-account total." The CSV export path has the identical unfixed bug. Confirmed reachable via `GET /api/transactions/export/csv?include_balance=true` with no account filter.
  - Fix: partition the export's running-balance accumulator by `account_id`, mirroring the list-endpoint fix.

- [ ] **Cash-flow forecast header is off by a month in timezones behind UTC** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/components/dashboard/CashFlowForecastChart.tsx:207` — `new Date(monthQuery.data.month + "-01T00:00:00Z")` then formatted with local getters
  - Confirmed via concrete trace: month="2026-01", US Pacific (UTC-8) → `2026-01-01T00:00:00Z` reads locally as `2025-12-31T16:00:00-08:00`, so local `getMonth()` returns December 2025. Brussels (UTC+1/+2, ahead of UTC) is unaffected. `NetSummaryCard.tsx:53` already avoids this via numeric year/month construction.
  - Fix: build the `Date` from numeric parts, not a UTC-anchored string.

- [ ] **Recipient merge/unmerge leaves Statistics aggregations stale** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/hooks/useRecipients.ts:82-84,115-117`
  - Both invalidate only `['recipients']`/`['transactions']`; Statistics' recipient breakdowns live under a separate `['aggregations', ...]` namespace that's never touched, so merged/unmerged identities stay split in Top Recipients until staleTime expires.
  - Fix: also invalidate `['aggregations']` in both mutations.

- [ ] **Planned-payment edits don't refresh the global "upcoming payments" banner** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/hooks/usePlannedPayments.ts` (plain `useState`/`fetch`, no React Query), `pages/PlannedPaymentsPage.tsx:100-103`
  - Nothing invalidates `['upcomingPlannedPayments', queryDate]`, the cache backing the app-wide banner. Creating/deactivating/executing a planned payment doesn't update the banner for up to 5 minutes. `ImportReviewPage.tsx:130-131` already invalidates both keys correctly elsewhere, confirming this is an inconsistency.
  - Fix: invalidate `["upcomingPlannedPayments"]` from every mutating path.

- [ ] **Combined investment-create + initial-purchase flow can create duplicate investments on partial failure** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/components/portfolio/AddInvestmentDialog.tsx:76-126`
  - If `addInvestment` succeeds but the chained `addTransaction` fails, the dialog stays open in "create" mode with no indication a server-side row already exists; resubmitting creates a duplicate investment.
  - Fix: track the created investment id in state so a retry only re-attempts the transaction step.

- [ ] **Triple-cast produces a dormant NaN landmine in the account-close flow** 🔼 ✅ *(currently inert — gated behind ADR-103, verified OFF)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/hooks/portfolio/useAccountPositions.ts:90`, `useAccountNetWorth.ts:49`, `features/accounts/CloseAccountDialog.tsx:65`
  - All three bridge `InvestmentSummary` → `Investment` via `as unknown as` (three separate occurrences, not one nested cast). `CloseAccountDialog.tsx:65` passes `today: ''` instead of `todayYmd()` (the other two sites pass it correctly); `''.split('-').map(Number)` then produces `NaN` accrued interest in the holdings-transfer preview. Will surface the moment per-account holdings is enabled.
  - Fix: pass `todayYmd()` consistently; replace the double-cast with a narrower structural type.

- [ ] **Belfius "Laatste saldo" parse breaks at ≥ €1000 → running balances silently absent** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `belfius.js:22-24` — `"12.345,67 EUR"` → `.replace(',', '.')` leaves `"12.345.67"` → NaN → `lastBalance = null` → `applyRunningBalances` no-ops. Fail-safe, but the balance feature silently never works for dot-grouped balances.
  - Fix: use `parseCommaDecimal`.

- [ ] **Belfius running-balance direction heuristic mis-assigns balances for single-day/ambiguous statements** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `belfius.js:32-40` — direction guessed from first-vs-last date; a single-day statement is treated as descending. If actually ascending, every row gets the wrong running balance (walked from the wrong end). Balances anchor accounts per ADR-094, so wrong values are user-visible.
  - Fix: order by statement/transaction number (parts[2]/parts[3]) instead of dates.

- [ ] **`validate.js` reads `tx_date` raw and runs it through `toISOString` — fallback dedup hashes shift a day in UTC+ zones** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `services/importPipeline/validate.js:22,113` vs `lib/importDates.js:8-11`; commit.js:26 already uses `to_char` correctly
  - Only the `raw_data`-missing fallback-hash path consumes it; self-consistent while server TZ is stable, but a TZ change between imports silently changes fallback hashes → missed duplicates.
  - Fix: `to_char(tx_date,'YYYY-MM-DD')` in the SELECT, matching commit.js.

- [ ] **Vision adapter strips commas from Amount — EU-decimal CSVs auto-routed to it get 100× amounts** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a_
  - `vision.js:19` + loose header detection at `vision.js:53-59` (vision precedes sabb/wise in `adapters/index.js:19`)
  - A non-Vision CSV with `date/amount/bank account/recipient` headers routes here; `"12,34"` → comma deleted → `"1234"` — silent 100× error rather than a skip.
  - Fix: use `parseAmountField` instead of comma-stripping.

- [ ] **Same-day replay order can mint phantom units after deleting an earlier buy** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `snapshotBuilder.js:84-86` (`ORDER BY date, id`) + `:423-424` (oversell clamp); enabled by `portfolioTxRepo.writes.js:190-207` (hardDelete never re-validates dependent sells)
  - buy₁ Jan-1 (10u), sell Mar-1 (10u), buy₂ Mar-1 (10u, higher id); delete buy₁ → walk hits sell with 0 held → clamped no-op → buy₂ adds 10 → 10 phantom units valued forever. (Related to the known clamp finding; the day-internal id-ordering is a distinct trigger.)
  - Fix: within a day, order buys/gifts/splits before sells (or allow transient intra-day negatives).

- [ ] **Future-dated portfolio rows pass validate and commit silently — surfaces disagree** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `portfolioImportPipeline/validate.js:128-161` (presence checks only); no date guard in `portfolioTxRepo.common.js:155-234`
  - A typo year (2062) commits; snapshots exclude it (query bounded to today) while cost-basis/summary include it → pages disagree, no error anywhere.
  - Fix: validate `tx_date ≤ today` (or route to review).

- [ ] **Foreign-currency trade legs/cash rows posted onto the sleeve raw; balance SQL sums without FX** 🔽 *(needs confirmation)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `tradeCashLegService.js:66-79`, `commit.js:93-97` vs `repositories/accountBalanceSql.js:37` (`SUM(t2.amount)`, no FX conversion)
  - USD trade on a EUR sleeve posts `−1000` USD; balance sums it as EUR. Only the balance SQL was spot-checked — if conversion happens elsewhere this is moot. Verify before fixing.

- [ ] **Dormant `brokerageFanout` computes leg amount from the raw row, not repo canonicals** 🔽 *(latent — no production callers, verified by grep)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `importPipeline/brokerageFanout.js:132` — `{ ...created, ...row }` lets a null `row.amount` (units+price CSV) overwrite the repo-computed amount → leg = `−(fees+taxes)` instead of `−(units×price+fees+taxes)`. `commit.js:158` does it correctly (prefers `created`).
  - Fix: spread `created` last (or delete the dormant module — it's also flagged in the 2026-06-30 audit context).

- [ ] **Account-level dividend/interest/fee rows without an instrument can never commit** 🔽 *(blocks, doesn't corrupt — design gap)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `importPipeline/brokerageRouting.js:25` routes them `'portfolio'`; `commit.js:111-114` errors "unresolved instrument". Cash interest on the sleeve / custody fees have no representable path.
  - Fix: decide a path, e.g. instrument-less rows → signed cash row.

- [ ] **Native float accumulation on money in report/aggregation paths (beyond already-known sites)** 🔽 *(drift, not gross error — all rounded at the end)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c_
  - `infoRepo.monthly.js:83-85` · `infoRepositoryNetWorth.js:199` · `infoRepo.forecast.js:314,531` · `infoRepo.statistics.js:57,62,85-86` · `services/reports/dataFetcherTax.js:205` (`dividendsReceived +=` — tax report, medium-low) · `reports/sections/portfolioExecutiveSummary.js:33-34`, `portfolioAllocation.js:59-60`, `assetClassDetail.js:58-59` (display-only)
  - Fix: `toDecimal`/`addAll` from `lib/money.js` / shared-utils.

- [ ] **Zero-amount transactions accepted end-to-end** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a_
  - Frontend `components/forms/AddTransactionDialog.tsx:51-57` (`"0"` passes truthiness + `Number.isFinite(0)`); backend `routes/transactions.js:539` only checks `amount == null`
  - In the sign-based model (− expense / + income) a 0-amount row is meaningless and pollutes aggregations.
  - Fix: reject `amountValue === 0` client-side; tighten backend to `Number.isFinite` + non-zero.

- [ ] **Raw English backend error messages leak into toasts on every failed mutation** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a_
  - `hooks/useTransactions.ts:78-81` (toast description = raw `error.message`); no global `MutationCache` onError in `App.tsx:93-101`, so any mutation without a hook-level handler silently swallows errors (none confirmed, hooks unaudited — see residue)
  - Fix: map backend error codes to i18n keys at the toast layer; add a global MutationCache onError as backstop.

- [ ] **Chart tooltips + two pages format via browser locale, not the app language setting** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a_
  - `components/charts/AreaChart.tsx:564`, `LineChart.tsx:481`, `ComposedChart.tsx:346` (no-arg `toLocaleDateString()` fallback); `features/ai-chat/ToolResultCard.tsx:68`, `pages/DbMaintenancePage.tsx:87,91` (no-arg `toLocaleString()`)
  - nl-app user with an en-US browser gets US date order in tooltips. Central helpers (`shared/dateUtils.ts`, `utils/currency.ts`) are correctly locale-parameterized — only these fallbacks bypass them.
  - Fix: thread the app locale into the chart label fallbacks.

- [ ] **Zero-fill month set uses server-local `new Date()` while the SQL paths use Postgres `CURRENT_DATE`** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b · Materialized views / aggregations_
  - `repositories/infoRepo.monthly.js:92-106` — around a month boundary with differing Node/Postgres TZ, the JS zero-fill generates a different 6-month key set than `generate_series` → one month duplicated as all-zero or the newest missing. Project convention (`todayAppDateString`) exists for exactly this.
  - Fix: derive the anchor month from the DB or the shared app-date helper.

- [ ] **Attachment upload orphans the stored file if the DB insert fails after `storeAttachment`** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b · Attachments_
  - `routes/attachments.js:66-74` — existence check at :61 races a concurrent hard delete; FK failure on insert leaves the file on disk with no row, no cleanup.
  - Fix: try/catch around the insert, `removeAttachmentFile(storedPath)` on failure.

- [ ] **`backup:save-settings` IPC skips the sender check and destination validation** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Electron shell (`packaging/electron/main.js`)_
  - `main.js:2724-2736` vs prefix list at `:2581-2584` — no `event.sender === mainWindow.webContents` check (unlike `backup:restore`), dir not checked against `BLOCKED_BACKUP_PREFIXES` (which itself lists nonexistent `/Library/System` but not `/Library`); quit-time backup (:3461) then writes wherever it points.
  - Fix: same sender check + prefix validation as `backup:run`; correct the prefix list.

- [ ] **`compareVersions` compares pre-release tags as plain strings** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Electron shell (`packaging/electron/main.js`)_
  - `main.js:1599` — `"rc.10" < "rc.2"` lexicographically → update prompts mis-order prereleases. Fix: semver §11 numeric-identifier comparison.

- [ ] **Stale `pendingShellUpdate` installed without revalidation — can quit with no update and no error** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Electron shell (`packaging/electron/main.js`)_
  - `main.js:1928-1934` — reuses a bundle prepared arbitrarily long ago; if the OS purged the temp dir, `spawn('open', …)` fails silently *after* `isQuitting = true; app.quit()`. Fix: `existsSync(installerPath)` + re-check latest version before quitting.

- [ ] **Restore schema-guard compares alembic revision ids lexicographically** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Electron shell (`packaging/electron/main.js`)_
  - `main.js:2275` — `metadata.schemaHead > currentHead` only works for zero-padded numeric prefixes; a future hash-style revision silently breaks the "bundle from newer schema" guard both directions. Fix: parse numeric prefix; warn+skip when unparseable.

- [ ] **0062 trigger: blanking `bank_account` on UPDATE leaves a stale `account_id`** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Migrations (only 0061 + 0062 verified this pass)_
  - `alembic/versions/0062_trigger_lookup_only_on_update.py:59-78` — body gated on `acct_name IS NOT NULL AND <> ''`, so an UPDATE clearing `bank_account` keeps the old `account_id`; the row keeps counting toward an account whose label was removed. Fix: decide explicitly (keep or NULL) in the blank-on-UPDATE case.

- [ ] **0062 trigger: account lookup is case-sensitive on INSERT and UPDATE** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Migrations (only 0061 + 0062 verified this pass)_
  - `0062…py:64-67,73` — `WHERE name = acct_name` / `ON CONFLICT (name)`: a casing-only difference ("Kbc" vs "KBC") creates a duplicate account on INSERT or silently keeps the old `account_id` on UPDATE. Fix (deliberate decision — changes onboarding semantics): normalize via `lower(btrim(...))` or case-insensitive unique index.

- [ ] **`findAutoLinkTarget` is dead in production and diverges from the real (stricter) auto-link rule** 🔽 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Planned / recurring transactions_
  - `apps/node-backend/src/services/plannedMatchService.js:85-88` vs. the actual logic at `:130-145`
  - Only checks single-direction uniqueness, not the documented mutual-uniqueness rule the real `autoLinkTransactions` enforces inline. It's covered by its own passing unit tests, creating false confidence — a future editor of the matching rule is likely to "fix" the wrong copy.
  - Fix: delete it (and its tests), or refactor `autoLinkTransactions` to call it as the single-direction primitive with the mutual check layered on top.

- [ ] **In-place `delete` on PATCH fields contradicts the documented immutable-rest sanitization pattern** 🔽 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `routes/transactions.js:153-166,161-163,181`, `routes/plannedTransactions.js:40,53,74`
  - `docs/reference/code-patterns.md:585` states the canonical pattern explicitly ("never in-place delete"); both files mutate a shallow copy directly with `delete fields.x`. Notably, `plannedTransactions.js` has the *correct* pattern right next to the bug (`withoutPatchOnlyReadOnlyFields`, lines 26-36, uses destructured rest), showing the divergence is real and inconsistent even within one file. Not a live bug today (the copy isn't `req.body` itself), but an easy pattern to copy onto a non-copied object later.
  - Fix: rewrite as `const { x, ...rest } = fields; return rest;` in both files.

- [ ] **Amount-sign filter coercion logic is duplicated between list and bulk-action routes** 🔽 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `routes/transactions.js:71-80` (`parseTransactionListQuery`) vs. `services/bulkSelection.js:46-53` (`normalizeBulkFilter`)
  - Both independently reimplement identical `amount_signed`/magnitude coercion; `bulkSelection.js` is documented to "mirror" the list endpoint but a future fix to one won't propagate to the other.
  - Fix: extract a shared `parseAmountFilter(value, signed)` into `filterBuilder.js`, import in both places.

- [ ] **Dead, unguarded `createSplit` bypasses the over-allocation validation its "atomic" siblings exist to enforce** 🔽 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `apps/node-backend/src/repositories/splitRepository.js:65-73`
  - Inserts a split row with no row lock and no `validateSplitAllocation` call; unreferenced in live code (test-mock only). Real call sites use `createSplitAtomic`/`createSplitsBatchAtomic`. (Note: `openapi.yaml`'s `operationId: createSplit` for the POST endpoint is an unrelated naming coincidence, not a real caller of this function.)
  - Fix: delete it, or make it delegate to `createSplitAtomic`.

- [ ] **Dead legacy per-bank dedup repository with its own passing test suite (false confidence)** 🔽 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `apps/node-backend/src/repositories/rawTransactionRepository.js` (323 lines — `belfiusRawRepo`, `kbcRawRepo`, `revolutRawRepo`, `sabbRawRepo`, `wiseRawRepo`, `visionRawRepo`, `rawReferenceRepo`, `isRawDuplicate`)
  - Zero references in `src/` outside itself; only its own test file exercises it (and that test mocks the DB connection entirely, so it passes with zero real wiring). The live dedup path is `services/deduplication.js` against a different table — this older mechanism (including `kbcRawRepo`, backing `kbc_raw_transactions`) is fully disconnected from the import pipeline.
  - Fix: delete module + test, or confirm intent and wire it in.

- [ ] **nl typo + minor wording inconsistencies** ⏬
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a_
  - `addInvFromMarket.option.addTxnDesc`: "verkop" → "verkoop" · `filter.type.income`/`search.suggest.allIncome` use "Ontvangsten" while every other surface uses "Inkomsten" · `tax.profile.field.cadastralIncome` nl reads "Kadastraal inkomen (kadastraal inkomen)" (EN parenthetical was already the Dutch term).

- [ ] **Recurring-detection and forecast aggregates use native float arithmetic instead of the mandatory Decimal helper** ⬇ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Planned / recurring transactions_
  - `apps/node-backend/src/services/recurringDetectionService.js:213,243-244`, `apps/node-backend/src/repositories/infoRepositoryPlanned.js:86-87,125-126`
  - Per `docs/reference/code-patterns.md`, monetary accumulation must route through `addAll()`/Decimal; here amounts are summed/averaged with native `+=`/`reduce` after one `toDecimal().toNumber()` conversion. Final values are cent-rounded so drift is negligible (display-only, not ledger writes), but it's inconsistent with the stated scope.
  - Fix: swap the accumulations for `addAll()` from `lib/money.js`.

- [ ] **`generateLoanRepaymentSchedule` falls back to `null` instead of `undefined`** ⬇ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Planned / recurring transactions_
  - `apps/node-backend/src/services/calculations/loanSchedule.js:154` — `schedule[0]?.due_date ?? null`
  - Dead code in practice (`validateLoanConfig` guarantees a non-empty schedule), but a stray `null` outside the documented repository-row-not-found exception.
  - Fix: remove the defensive fallback, or change to `?? undefined`.

- [ ] **ADR-096 portfolio-income/FIRE-coverage feature has no endpoint wired up — but this is an unimplemented Proposed-status ADR, not a silently-orphaned built feature** ⬇ 🔧 *(reframed after verification)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `apps/node-backend/src/services/portfolio/portfolioIncomeService.js` (`aggregateIncome`, `coverageRatio`) has zero callers anywhere in `src/`, any route, or the frontend.
  - Fix: wire into a portfolio-stats route if this is still wanted, or close the ADR as deferred/not-pursued.
  - Verification (2026-06-30): the original framing ("unlike `brokerageFanout.js`, there's no note explaining why this is unreachable") is misleading — **`docs/adr/096-dividend-income-fire.md:13` has status "Proposed"** (vs. ADR-095 "Implemented" and ADR-103 "Accepted"), which *is* the explanation: this was never built out, not built-and-abandoned. The code-level dead end and the fix suggestion are still valid; only the "documentation discipline gap" framing was wrong.

- [ ] **Systemic `null` instead of `undefined` for optional values in route filter-parsing, beyond the documented exception** ⬇ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - Pervasive: `routes/transactions.js:61-94`, `importRoutes.js:414-524`, `portfolioImportRoutes.js:55-422`, `aggregations.js:234-250`, `categories.js:21`, `tags.js:21`, `research.js:57-146`, `marketLookup.js`
  - Violates the stated convention at scale beyond the documented repository row-not-found exception. Currently harmless (consumers mostly use `!= null` loose checks) but the same pattern class that caused the account-PATCH bug above.
  - Fix: not urgent in isolation — worth a dedicated lint rule / sweep rather than a one-off fix.

### ⚡ Performance

- [ ] **Full-viewport `backdrop-blur-md` on every Dialog/Sheet/AlertDialog overlay, with a second `glass-thick` (28px) blur stacked on top for the content** 🔺
  - ↪ _from: UI/GPU research 2026-07-02 · Wave A_
  - `apps/frontend/src/components/ui/dialog.tsx:23,42`, `apps/frontend/src/components/ui/alert-dialog.tsx:20,40`, `apps/frontend/src/components/ui/sheet.tsx:22,32`
  - The overlay is `fixed inset-0 backdrop-blur-md` — it re-blurs the entire viewport (which already contains 10–15 blurred glass surfaces plus the animating aurora), and the modal content adds a nested 28px `glass-thick` blur sampled from that already-blurred region. Because the aurora blobs (`index.css:589,605`) never stop drifting, the whole-screen blur is recomputed every vsync for as long as any modal is open — the single most expensive standing state in the app; opening a dialog on Transactions/Portfolio is a common, long-lived action. The 420ms `dialog-in` scale animation additionally forces the content blur to re-sample at a new geometry each frame.
  - Fix: replace overlay `backdrop-blur-md` with a plain `bg-background/60` dim (or blur only at the enhanced fx tier), and/or pause aurora drift (`animation-play-state: paused` on `.liquid-canvas::before/::after`) while a modal overlay is mounted.

- [ ] **Portfolio CSV-import commit loop has no transaction batching — 4-6+ sequential round trips per row** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/portfolioImportPipeline/commit.js:70-179`
  - Unlike the bank-import pipeline, this loop is never wrapped in `withTransaction`/chunked. Per row: dup-check SELECT, uncached FX-rate lookup, sell-validation + INSERT (+ a separate `getById` on inheritance-schema installs) + optional cash-leg INSERT + staging-row UPDATE. A 500-1000 row brokerage CSV issues thousands of sequential statements (minutes of latency), with no crash-isolation between rows.
  - Fix: wrap row processing in `withTransaction` chunks (mirror the bank pipeline), cache FX-rate lookups per `(currency, date)` for the batch, run independent rows through a bounded-concurrency pool (`forEachConcurrent` is already used elsewhere, e.g. `quoteBackfillService.js`).

- [ ] **Single-transaction create/edit/delete never clears the 6-hour cashflow-forecast cache — bulk imports already do this correctly, single edits don't** ⏫ 🔧 *(fix direction corrected — the originally-proposed fix wouldn't have worked)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/aggregationRefresh.js` exports two functions: `scheduleAggregationRefresh()` (debounced, delegates only to `materializedViewService.scheduleRefresh()` — legacy MV refresh, **not** Monte Carlo/cashflow-cache clearing) and `refreshAggregations()` (non-debounced, the one that *actually* clears the MC-cache repos). `routes/transactions.js` create/PATCH/DELETE, `transferReconciliationService.js`, and `dbEditor.js` all call `materializedViewService.scheduleRefresh()` directly (or via `scheduleReconcile()`, which wraps it) — none of them call `refreshAggregations()`. Bulk CSV-import paths (`importPipeline/commit.js:244-245`, `importRoutes.js:391`) *do* call `refreshAggregations()` correctly. So the real, narrower gap is: **single-transaction mutations have no path to the MC-cache-clearing logic at all** — editing one transaction can leave the cashflow forecast reflecting pre-edit data for up to 6 hours.
  - Fix: add a (probably debounced) call to the MC-cache-clearing logic from `refreshAggregations()` into the single-transaction mutation paths. **Do not** just "route through `scheduleAggregationRefresh()`" as originally proposed — that wrapper doesn't clear the MC cache either, so it wouldn't fix anything.

- [ ] **Kinesis price-provider fetches are fully serial per holding (15s timeout each); custom JSON provider is also serial (10s timeout, up to 2 fetches/holding on fallback)** ⏫ 🔧 *(custom-provider timeout corrected)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/prices/priceProviderRegistry.js:481-535` (Kinesis), `:439-479` (custom)
  - Unlike Yahoo/Binance (both batched), these run one sequential `await fetch` per holding — a 5-holding Kinesis portfolio issues 5 sequential round trips on every startup/refresh, worst case ~75s if one hangs (Kinesis timeout confirmed exactly 15s via `AbortSignal.timeout(15_000)`). The Kinesis API's plural `symbolIds` param suggests batching is actually supported but unused.
  - Fix: batch via `symbolIds` if supported, else run per-symbol fetches concurrently via `Promise.allSettled`.
  - Verification (2026-06-30): the custom provider's `_fetchJson` helper actually uses a **10s** timeout, not 15s, and can issue up to 2 sequential fetches per holding on its fallback path — the "15s timeout each" claim only holds for Kinesis.

- [ ] **Dashboard fetches `/api/aggregations/monthly-summary` twice under two cache keys on every mount — and both refire after every transaction mutation** ⏫
  - ↪ _from: Performance research 2026-07-02 · Frontend — React Query_
  - `apps/frontend/src/pages/DashboardPage.tsx:88-102`, `apps/frontend/src/hooks/useFilteredDashboardStats.ts:49-65`, `apps/frontend/src/lib/api.ts:157-158`
  - `useFilteredDashboardStats` calls the endpoint under `['filteredDashboardStats', ...]` while DashboardPage itself calls the same endpoint (via `getMonthlyFinancialSummary`, which is literally `getAggregationMonthlySummary(...).then(r => r.data)`) under `['monthlySummary', ...]`. With exclusions off the two requests are byte-identical; with exclusions on a third (unfiltered) call fires too. `useTransactions.invalidateAll` (`useTransactions.ts:111-122`) invalidates both families, so the duplicate pair refires after every transaction create/update/delete.
  - Fix: have DashboardPage consume the envelope already fetched by `useFilteredDashboardStats`, or unify both under one key family (e.g. `['aggregations','monthly-summary', currency, exclusions]`).

- [ ] **Chart primitives rebuild every series path on every hover/scrub pointermove** ⏫
  - ↪ _from: Performance research 2026-07-02 · Frontend — runtime rendering_
  - `apps/frontend/src/components/charts/AreaChart.tsx:198,213-222,387-406`; same hover-in-state pattern in `LineChart.tsx:154`, `ComposedChart.tsx:143`, `BarChart.tsx:173`, `StackedBarChart.tsx:128`
  - Hover index is component state and nothing between it and the path layer is memoized — visx regenerates the `d` string for N points × S series (monotone curve fit included) plus framer-motion re-render on **every pointermove**. Heavy consumers parse dates inside `xAccessor` per point per render: `NetWorthChart.tsx:84` (`parseLocalDateFromYmd` at full daily resolution, 4 series → ~4,000+ date parses + 4 curve fits per mousemove at "all" period), `PerformancePage.tsx:305,345` (`parseISO`, ~400 pts × 7 and × 5 series, both scrubbable). `LineChart.tsx:150` also keys its bisector memo on raw `xAccessor` identity (missing AreaChart's `xAccessorRef` stabilizer at `AreaChart.tsx:130-133`).
  - Fix: extract the series-path layer into a `memo` child keyed on `(data, xScale, yScale, series)`; render crosshair/tooltip in a sibling overlay so hover never touches paths; precompute epoch-ms in the page-level `chartData` memo instead of parsing in `xAccessor`.

- [ ] **`ChartSyncContext` broadcasts pointermove-rate state to every chart under the provider (whole dashboard)** ⏫
  - ↪ _from: Performance research 2026-07-02 · Frontend — runtime rendering_
  - `apps/frontend/src/components/charts/ChartSyncContext.tsx:25-28`, `AreaChart.tsx:218` (`publishHover` per move), `pages/DashboardPage.tsx:364` (provider wraps the whole dashboard)
  - Hover lives in `useState` in the provider and `useChartSync` is an unconditional `useContext`, so every chart on the dashboard re-renders per pointermove when any synced chart is hovered — including `BankBalancesWidget`'s stacked `AreaStack` (~365 daily points × N accounts, stack layout + curves recomputed per move via the finding above). Each mirrored chart also runs an O(n) nearest-point scan per move (`AreaChart.tsx:244-258`).
  - Fix: rAF-throttle `publish`; move hover out of context state into a ref + subscriber set (or selector store) so only charts sharing the active `syncId` update.

- [ ] **Every single transaction edit triggers a full-corpus transfer reconcile + refresh of all 4 materialized views (two are all-time aggregates)** ⏫
  - ↪ _from: Performance research 2026-07-02 · Backend — HTTP / infrastructure_
  - `apps/node-backend/src/routes/transactions.js:225,232,378,402,493,601,633,645` → `services/transferReconciliationService.js:229-237` (1s trailing debounce → `reconcileTransfers()` = 3 UPDATE scans + self-join over the whole corpus) → `.finally(() => scheduleRefresh())` → `services/materializedViewService.js:232-240` refreshing all 4 MVs, of which `mv_category_totals` and `mv_bank_balances` are **all-time** aggregates (`materializedViewService.js:62-77,104-115`)
  - The 1s debounce only coalesces edits <1s apart — human editing cadence (a save every 2-10s) pays the full reconcile + 4-view rebuild per edit, forever, in the background, competing for the 10-connection pool. Off the request path, but repeated full-table work that grows with corpus size.
  - Fix: raise the debounce to ~5s **with a max-wait cap** (see grouped item below), and/or per-mutation refresh only the month-scoped views while the all-time views move to trigger-maintained agg tables (pattern already exists: `TRIGGER_MAINTAINED_TABLES` in `aggregationRefresh.js:27-30`).

- [ ] **`getAverageVsCurrentSpending`: `LIMIT 10000/5000` with no `ORDER BY` — nondeterministic silent truncation of dashboard numbers + JS aggregation** ⏫
  - ↪ _from: Performance research 2026-07-02 · Backend — reports & aggregations_
  - `apps/node-backend/src/repositories/infoRepo.statistics.js:22-39` (and `:51-58,80-87` for the JS sums)
  - A LIMIT without ORDER BY lets Postgres drop *whichever* rows it likes once the 6-month window exceeds 10k rows — the dashboard "avg vs current" figures become nondeterministically wrong; the row streaming is the same should-be-SQL aggregation as the forecast finding below. Only manifests above ~10k rows/6 months.
  - Fix: `GROUP BY t.date, t.currency` with sign-split `SUM(...) FILTER` (bounds the output by days×currencies, dropping the need for any LIMIT), or at minimum `ORDER BY t.date` so truncation is deterministic.

- [ ] **Forecast MC cache key omits `historyMonths` — stale-parameter cache hits both ways** ⏫
  - ↪ _from: Performance research 2026-07-02 · Backend — reports & aggregations_
  - `apps/node-backend/src/services/calculations/forecast/index.js:237-241` (`filterHash` = currency|cats|recs|includePlanned; upsert at `:389-393`), key `(user_id, month, filter_hash)` per `0013_cashflow_forecast_mc.py:31`
  - `isDefaultMcParams` guards `mcPaths`/`mcPercentiles` but nothing guards `historyMonths` — a request with `history_months=120` happily returns a cached 36-month forecast (payload even carries the old value), and non-default history *does* cache, colliding both directions. Perf-adjacent correctness: the expensive recompute the user asked for silently doesn't happen.
  - Fix: fold `historyMonths` into `filterHash` (one line; existing rows self-expire in 6h).

- [ ] **Infinite CSS aurora drift defeats blur caching: every persistent backdrop-filter surface recomposites on every vsync, forever, on normal-size displays** ⏫
  - ↪ _from: UI/GPU research 2026-07-02 · Wave A_
  - `apps/frontend/src/index.css:589,605` (64s/76s `infinite alternate` blob animations), `index.css:1119-1122` (static-atmosphere escape), `apps/frontend/src/components/layout/VisualEffectsController.tsx:23-26` (escape gated to `largeDisplay` only), `apps/frontend/src/components/layout/AppSidebar.tsx:214` + `components/ui/sidebar.tsx:137` (permanent `glass-chrome` 24px sidebar), `index.css:491-495` (topbar 16px blur when scrolled), `apps/frontend/src/styles/tokens.css:98-103` (blur radii 12–32px)
  - The blob transforms are compositor-only and cheap in isolation, but they sit behind every `backdrop-filter` region, so the compositor can never cache blur output: sidebar (full viewport height, 24px), topbar, and all page glass re-blur at 60/120Hz even when the app is fully idle. Dashboard has ~13-15 concurrent blur surfaces (NetSummaryCard + 3 StatCards at `glass-elevated` 32px, BankBalancesWidget + 5 inner `glass-regular` tiles, 2 chart cards, sidebar, topbar); NetWorthPage has 8 explicit `glass-regular` + a 6-tile Card grid. `fx-static-atmosphere` only kicks in on large displays with auto-adapt; laptops burn GPU permanently, and nothing pauses drift on window blur/occlusion (relevant for the always-open Electron app).
  - Fix: extend the `fx-static-atmosphere` freeze to window-blur/`document.hidden` (a tiny controller toggling the class), or make static atmosphere the default at the standard tier and reserve drift for `fx-enhanced`.

- [ ] **Card primitive animates large box-shadows + translates a backdrop-filter element on every hover — paint storm sweeping any card grid** ⏫
  - ↪ _from: UI/GPU research 2026-07-02 · Wave A_
  - `apps/frontend/src/components/ui/card.tsx:9` (`hover:-translate-y-0.5 hover:shadow-glass-elevated` on the base Card), `apps/frontend/src/index.css:685-728` (`premium-frame`/`micro-lift` transition `box-shadow`+`border-color` 260ms), `apps/frontend/tailwind.config.ts:124-125` (`glass-elevated` shadow = 22px/48px spread), `components/dashboard/StatCard.tsx:42-46`, `components/dashboard/NetSummaryCard.tsx:68`, `components/dashboard/BankBalancesWidget.tsx:184`, `pages/AccountsPage.tsx:132`, `pages/portfolio/SavingsPage.tsx:163`, `pages/research/ResearchHomePage.tsx:308`
  - Every Card (all pages) runs a 260ms box-shadow interpolation — box-shadow is a paint property, so each hover enter/leave repaints the card plus its 48px shadow extent every frame — while simultaneously translating an element that owns a `backdrop-filter`, forcing the blur to re-sample per frame of the move. Sweeping the cursor across the Dashboard bento (~10 cards) or the NetWorth 6-tile grid triggers overlapping multi-hundred-ms paint storms. StatCard adds a 128px decorative circle scaling on group-hover (compositor-only, fine) on top.
  - Fix: pre-render the hover shadow on a `::after` pseudo-element and transition only its `opacity`; keep the translate (compositor) but drop `box-shadow`/`border-color` from the transition list on grid-scale cards.

- [ ] **WebGL aurora rAF loop keeps drawing at ~30fps when the app window is visible but unfocused — no blur/occlusion gating beyond rAF's implicit hidden-tab pause** ⏫
  - ↪ _from: UI/GPU research 2026-07-02 · Wave B_
  - `apps/frontend/src/components/layout/ShaderAurora.tsx:185-191` (frame loop has no `visibilitychange`/`blur` handling), `apps/frontend/src/components/layout/AppLayout.tsx:104-108` (canvas sits in `.liquid-canvas` under every backdrop-filter glass surface)
  - Electron's default `backgroundThrottling` (not overridden, `packaging/electron/main.js:1503-1509`) stops rAF only when the window is hidden/minimized/fully occluded; a desktop app left visible behind other windows keeps the WebGL draw + full-screen composite + re-blur of every glass region running at 30fps indefinitely. `visualEffectState: 'followWindow'` pauses only the OS vibrancy material on blur, not this in-page loop.
  - Fix: in the effect, listen for `window` `blur`/`focus` (and `visibilitychange` for browser use) and cancel/restart the rAF loop; optionally also gate via `webContents` focus IPC.

- [ ] **ChartTooltip re-measures layout (getBoundingClientRect + offsetWidth/offsetHeight) in a dependency-less useLayoutEffect on every render, then setPos triggers a second render+measure — two forced synchronous reflows per chart-hover frame, app-wide** ⏫
  - ↪ _from: UI/GPU research 2026-07-02 · Wave C_
  - `apps/frontend/src/components/charts/ChartTooltip.tsx:116-143` (effect intentionally has no dep array, per comment at 110-115; reads `anchorParent.getBoundingClientRect()` at 122, `tip.offsetWidth/offsetHeight` at 123-124, then `setPos` at 141)
  - Every chart pointermove already re-renders the chart (filed); that render also re-renders ChartTooltip with new items, so this layout effect fires per frame against a just-mutated DOM — a forced synchronous reflow before paint — and when the position changes >0.5px the `setPos` schedules a second render whose layout effect measures again. Net: 2 renders + 2 forced layouts per hover frame on every chart on Dashboard/Statistics/Portfolio/NetWorth. This is a distinct compounding cost on top of the filed re-render storm and the filed glass-blur paint cost.
  - Fix: measure only when `open`, `title`, `items`, `left`, `top`, or size actually change (deps + a ResizeObserver on the tip for content-size changes), or position via `transform: translate3d` updated in a rAF from a ref without React state; cache the anchor parent rect per hover session instead of re-reading it per frame.

- [ ] **Bank-transaction CSV import commit issues exactly 5 sequential statements per row inside its transaction chunks** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/importPipeline/commit.js:79-213`
  - Chunking (1000 rows/txn) amortizes BEGIN/COMMIT but not per-row round trips: dup-check SELECT, SAVEPOINT, single-row INSERT, staging UPDATE, RELEASE SAVEPOINT = 5 statements, confirmed exact. A 2,000-row CSV (the most common operation in the app) issues ~10,000 sequential statements.
  - Fix: pre-load existing rows for the chunk's date range once, dedupe in JS, bulk-insert via `INSERT...SELECT UNNEST(...) ON CONFLICT DO NOTHING` (pattern already proven in `importPipeline/match.js:88-94`).

- [ ] **Default (magnitude) amount filter can't use the existing amount index — the index predates and is unrelated to the amount_signed feature** 🔼 🔧 *(provenance corrected)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/filterBuilder.js:142` — `amountSigned ? 't.amount' : 'ABS(t.amount)'`; the only amount index (`idx_transactions_amount_date`, `alembic/versions/0044_add_transfer_pairing.py:63`) is a plain btree that can't service the `ABS()` expression in the **default**/legacy magnitude-filter mode (likely the more common one), forcing a sequential scan when not narrowed by other indexed predicates.
  - Fix: add `CREATE INDEX ON transactions (ABS(amount), date)` if amount-only filtering proves hot; otherwise document as accepted given typical co-filtering by date/category.
  - Verification (2026-06-30): the index's provenance was backwards in the original write-up — migration 0044 (2026-06-18) was added for transfer-pairing matching (ADR-083), **10 days before** the `amount_signed` filter feature (commit `eff2da4f`, 2026-06-28). The signed-filter feature didn't add this index; it just happened to be able to reuse a pre-existing one, leaving the older/more-common default path with no usable index — same conclusion, different (correct) history.

- [ ] **JS-side aggregation regression in category-breakdown live fallback** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/repositories/infoRepositoryStatistics.js:33-62` (`getCategoryBreakdown`)
  - When the materialized-view path is unavailable, or whenever `includeTransfers=true`, this pulls every active transaction into Node with no date bound/LIMIT and sums in a JS loop. Its sibling `getCategoryPivot` 25 lines below (same file) was explicitly rewritten to aggregate in SQL via `GROUP BY` — this one was never migrated.
  - Fix: mirror `getCategoryPivot`'s SQL-aggregation pattern.

- [ ] **`dataImportService.js` recipients CSV import is fully sequential and unbatched (~5 queries/row); categories import is lighter (~1-2 queries/row) but has the same sequential/untransacted shape** 🔼 🔧 *(query-count split between the two sub-paths)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/dataImportService.js:80-146` (recipients), `:186-220` (categories)
  - Both are plain sequential loops with no `withTransaction`, no batching. A multi-thousand-row migration CSV means thousands of sequential round trips either way.
  - Fix: pre-fetch existing recipients/categories in one query, bulk-insert new ones via the same `UNNEST(...) ON CONFLICT DO NOTHING` pattern used in the bank-import pipeline.
  - Verification (2026-06-30): "~5 queries/row" only fits the recipients loop (`createOrGet` + optional notes UPDATE + optional bank-account `createOrGet` + optional category `createOrGet` + default-category UPDATE); the categories loop is just one `createOrGet` call per row (~1-2 queries).

- [ ] **Portfolio import rollback is a per-row DELETE loop — no `import_batch_id` column on portfolio transaction tables** 🔼 ✅ *(schema gap also blocking the cash-leg cleanup fix above)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/portfolioImportBatchService.js:65-76`, `apps/node-backend/src/repositories/portfolioTxRepo.writes.js:190-207`
  - Bank-import rollback is one `DELETE ... WHERE import_batch_id = $1`; no migration ever added the equivalent column to the portfolio transaction tables (confirmed: `import_batch_id` exists only on `transactions`, added by `0003_import_batch_id_on_transactions.py` — never on `portfolio_transactions`/`portfolio_transactions_base`, including in the later `0052_portfolio_transactions_account_id.py` which touched the same tables for a different column). Rollback instead calls `hardDelete(id)` once per row.
  - Fix: add an `import_batch_id` column (+ index) to the portfolio transaction tables for a single bulk DELETE; short-term, batch with `WHERE id = ANY($1::int[])` and call `deleteTradeCashLegs` in the same pass (fixes the orphaned-cash-leg correctness bug above too).

- [ ] **`refreshPrices` issues one UPDATE per investment instead of a single batched upsert** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/controllers/investmentController.js:257-301`
  - Uses bounded concurrency (10) but still N round trips where one `UNNEST`-based batch UPDATE (pattern already used in `priceCache.js:saveHistoricalPointsToDatabase:250-258`) would do it in one statement.
  - Fix: replace the per-investment loop with one `UPDATE ... FROM (SELECT * FROM UNNEST(...))` statement.

- [ ] **Unbounded, unvirtualized row rendering in portfolio import review** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/pages/portfolio/PortfolioImportReviewPage.tsx:121-176`
  - Every group's rows render directly into the DOM — no collapse/accordion (unlike the sibling `ImportReviewPage`), no pagination, no virtualization. A multi-year brokerage import can produce 500-2000+ rows mounted simultaneously.
  - Fix: wrap per-group rows in a collapsible (mirror `ImportReviewPage`'s `Accordion`), or virtualize via the existing `VirtualDataTable`/`@tanstack/react-virtual`.

- [ ] **Unbounded grid of glass-blur cards on the Watchlist page** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/pages/research/WatchlistPage.tsx:145-168`
  - Each item is a full `Card` with `backdrop-filter: blur(20px) saturate(180%)` in an uncapped, unvirtualized grid — compositor cost scales linearly with item count.
  - Fix: cap/paginate past ~24 items, or use a cheaper flat surface (no `backdrop-filter`) for this dense-grid case.

- [ ] **`framer-motion` is pulled into the always-loaded app shell, not just lazy chart routes** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/components/layout/AppLayout.tsx:19,220`, `PageTransition.tsx`, `AppSidebar.tsx:68`, `components/ui/tabs.tsx:78`
  - `AppLayout` wraps every route and is statically imported, so framer-motion ships in the initial bundle regardless of route, for animations CSS transitions could likely replace. (The library's other 9 usage sites, in `components/charts/*`, are correctly confined to lazy routes.)
  - Fix: replace shell-level motion with CSS transitions, or adopt `LazyMotion`/the tree-shaken `m` API.

- [ ] **`ImportReviewPage` mounts a live, query-subscribed combobox per group unconditionally** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/pages/ImportReviewPage.tsx:320-367`
  - Each accordion group's trigger unconditionally mounts a `RecipientCombobox` regardless of expansion state (it sits in `AccordionTrigger`, not `AccordionContent`). A year of bank CSV import can produce 100-300+ groups → that many live component instances/subscriptions at once.
  - Fix: lazy-mount the combobox only when its accordion item opens, or virtualize the groups list.

- [ ] **Column-resize drag re-renders the full table on every `mousemove`, unthrottled** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/components/shared/VirtualDataTable.tsx:265-287` (`handleMouseMove`)
  - `setColumnWidths` fires synchronously on every native mousemove during a drag, with no rAF batching/throttle; rows aren't individually memoized, so every pixel of drag re-renders the header plus all visible+overscan rows.
  - Fix: throttle via `requestAnimationFrame`, or track width in a ref + CSS transform during drag, committing to state only on `mouseup`.

- [ ] **StatisticsPage fetches `/api/aggregations/recipient-insights` twice under two unrelated key families — and the tab's copy is missed by mutation invalidation** 🔼
  - ↪ _from: Performance research 2026-07-02 · Frontend — React Query_
  - `apps/frontend/src/hooks/useStatistics.ts:229-233,294-307` (`['aggregations','recipient-insights',...]`) vs. `apps/frontend/src/components/statistics/RecipientInsightsTab.tsx:68-74` (`["recipient-insights", ...]`)
  - Identical URL with no exclusions; the tab's key sits outside the `['aggregations']` prefix so `useTransactions.invalidateAll` never reaches it (stale until staleTime expiry). `RecipientInsightsPage.tsx:50` shares the tab's key, so that pair dedupes — the page/hook split is the problem.
  - Fix: move the tab/page key under `['aggregations','recipient-insights', currency, catIds, recIds]` and share it.

- [ ] **Exchange-rates endpoint cached under three keys; `useCurrencyConverter` needlessly parameterizes by target currency** 🔼
  - ↪ _from: Performance research 2026-07-02 · Frontend — React Query_
  - `apps/frontend/src/hooks/useCurrencyConverter.ts:17-19` (`['exchange-rates', targetCurrency]`, 60s staleTime), `hooks/useExchangeRates.ts:28-33` (`['exchange-rates']`, 10min), `pages/admin/ExchangeRatesPage.tsx:24` (`["exchangeRates", {dbOnly:true}]`)
  - All three issue the same `getExchangeRates({dbOnly:true})`; the response doesn't depend on `targetCurrency` at all, so each distinct display currency fetches and caches a duplicate copy of the identical payload. (The `exchangeRates`-vs-`exchange-rates` *invalidation* mismatch is already filed above — this is the separate duplicate-fetch/cache-fan-out angle.)
  - Fix: drop `targetCurrency` from the key; converge all three on one shared constant key + one staleTime.

- [ ] **`includeTransfers` settings toggle triggers a blanket `queryClient.invalidateQueries()` refetch storm** 🔼
  - ↪ _from: Performance research 2026-07-02 · Frontend — React Query_
  - `apps/frontend/src/components/settings/sections/StatisticsSection.tsx:65-70`; same pattern in `AboutSection.tsx:142-144` (rare one-shot reset — low on its own)
  - Every flip of the switch refetches *every* query in the cache — settings usually open as an overlay over a mounted page, so all active queries (dashboard aggregations, transactions, portfolio, research quotes…) refire per toggle. The setting only affects server-side aggregation/cash-flow outputs.
  - Fix: scope to the affected families (`['aggregations']`, `['monthlySummary']`, `['filteredDashboardStats']`, cashflow-forecast keys).

- [ ] **Virtualized transaction/recipient list queries lack `placeholderData` — pending flash + list reset on every filter/search/sort change** 🔼
  - ↪ _from: Performance research 2026-07-02 · Frontend — React Query_
  - `apps/frontend/src/features/transactions/hooks/useTransactionListData.ts:79-123`, `apps/frontend/src/pages/RecipientsPage.tsx:65-69`
  - Every filter/search/sort value is in the query key with no `placeholderData: (prev) => prev`, so each (debounced) keystroke creates a fresh cache entry and blanks to loading UI until the round trip completes. The sibling `useTransactions.ts:36` sets it explicitly with a comment — these two hooks missed the convention.
  - Fix: add `placeholderData: (prev) => prev` to both (the existing `initialData`-sync effects already handle repopulation). Same one-liner for the admin table editor (`pages/admin/TableDataEditorPage.tsx:161-171`, admin-only).

- [ ] **`dashboardRecentTransactions` queryFn runs an unbounded pagination loop, re-run after every transaction mutation** 🔼
  - ↪ _from: Performance research 2026-07-02 · Frontend — React Query_
  - `apps/frontend/src/pages/DashboardPage.tsx:113-159`
  - The queryFn loops `getTransactions({limit: 200, offset})` pages until 5 non-excluded rows are found, with no page cap — a user whose recent history is dominated by excluded categories (e.g. transfers) triggers many sequential 200-row round trips, and `invalidateAll` refires the whole loop after every transaction create/update/delete.
  - Fix: pass exclusion IDs server-side with `limit: 5`, or at minimum cap the loop (~3 pages).

- [ ] **VirtualDataTable: every search keystroke re-renders the whole table and re-runs the O(n) row pipeline** 🔼
  - ↪ _from: Performance research 2026-07-02 · Frontend — runtime rendering_
  - `apps/frontend/src/components/shared/VirtualDataTable.tsx:134,164-175,346-384,677-810`
  - The 300ms debounce only covers the API call; `setLocalSearchQuery` fires per keystroke and re-renders the entire table. `processedRows` lists `localSearchQuery` in its deps and re-maps **all loaded rows** even in server-search mode (filter branch skipped, `deferredData.map` not); the ~25-40 visible virtual rows then all re-render (no row memoization), each carrying a Radix ContextMenu root, badges, `TagChip`s, and a closed `SplitTransactionDialog` whose body still executes Decimal math every render (`components/splits/SplitTransactionDialog.tsx:57-77`).
  - Fix: colocate the search input + suggestions in a child component; drop `localSearchQuery` from `processedRows` deps when `isServerSearch`; extract a memoized Row keyed on `(row, isEditing, columnWidths)`; gate SplitTransactionDialog's derived math behind `open`.

- [ ] **`Intl.NumberFormat`/`DateTimeFormat` constructed per formatted value on TaxOverviewPage (and 6 smaller sites) — re-run at chart-hover rate** 🔼
  - ↪ _from: Performance research 2026-07-02 · Frontend — runtime rendering_
  - `apps/frontend/src/pages/TaxOverviewPage.tsx:89-96` (`fmt()` constructs a formatter per call: 7 cards + 16 PIT rows + ~12 profile fields + both BarCharts' tick/tooltip formatters at `:588-589,715-716`), `:207` (`formatMonthTick`); same per-call pattern at `RealEstatePage.tsx:36-40`, `MarketLookupPage.tsx:133-137`, `CustomChart.tsx:78`, `CustomChartBuilderModal.tsx:89`, `ResearchFundamentalsTab.tsx:106`, `CloseAccountDialog.tsx:52`
  - Formatter construction is ~50-200µs each — low-ms per render, repeated at hover rate via the chart findings above. (Distinct from the already-filed "24 files use raw Intl.NumberFormat" *consistency* item — this is the per-render instantiation cost angle.)
  - Fix: one `useMemo`'d formatter per page (the pattern `NetWorthPage.tsx:95-102` already uses) or the cached `useCurrencyFormatter`. Related: the shared `Money` component builds its formatter inside a memo keyed on `amount` (`components/shared/Money.tsx:29-41`) — 30-50 ctors per virtual-scroll batch; use a module-level `Map` keyed `${locale}:${currency}:${digits}:${signed}` and memo only `formatToParts(amount)`.

- [ ] **Documented LTTB downsampling has zero frontend call sites; Net Worth renders full daily resolution and grows unbounded** 🔼
  - ↪ _from: Performance research 2026-07-02 · Frontend — runtime rendering_
  - `docs/performance/chart-downsampling.md:79-83` names "Net Worth daily snapshots spanning multiple years" as a target; `apps/frontend/src/utils/downsample.ts` is a re-export with no frontend consumers (only the Performance backend endpoint downsamples, per ADR-008). `NetWorthPage.tsx:88-94` deliberately opts out ("Full daily resolution … so scrubbing stays day-granular") — the "all" period grows ~+365 pts/yr × 4 series and is the main amplifier of the chart-hover finding above; `NetWorthByAccountChart` adds a second full-resolution stacked chart when per-account holdings are enabled.
  - Fix: either fix the chart-hover finding (making full res cheap) and update the doc to say frontend downsampling is intentionally unused, or keep full data for scrub hit-testing while downsampling only the rendered path geometry.

- [ ] **No bundle-size regression guard anywhere** 🔼
  - ↪ _from: Performance research 2026-07-02 · Frontend — bundle / loading_
  - `apps/frontend/package.json` (no size-limit/bundlesize/visualizer), `.github/workflows/ci.yml:249` (build job only verifies compilation)
  - The team already suffered one silent regression — recharts dragged into the preload graph, documented as a post-mortem comment in `apps/frontend/vite.config.ts:71-76`.
  - Fix: add `size-limit` (or a gzip-size assertion script) on the entry graph + total, wired into CI.

- [ ] **Blanket `radix-ui` manualChunk forces all 27 Radix packages into the boot graph (49.8 KB gz preloaded)** 🔼
  - ↪ _from: Performance research 2026-07-02 · Frontend — bundle / loading_
  - `apps/frontend/vite.config.ts:77-79`; `dist/index.html:22` modulepreloads `radix-ui-*.js` (164.7 KB raw / 49.8 KB gz)
  - Because one shell component touches any Radix primitive, the blanket `@radix-ui/*` rule ships menubar, navigation-menu, context-menu, hover-card, accordion, slider, etc. at boot even where only lazy pages use them — the exact failure mode the file's own recharts comment warns about. Same mechanism, smaller scale: the `icons` chunk (`vite.config.ts:86-88`, 14.8 KB gz preloaded) hoists every lucide icon used anywhere into boot.
  - Fix: delete both blanket rules (let Rollup split naturally) or restrict the named chunks to shell-used primitives (dialog, dropdown, tooltip, select, slot, label).

- [ ] **`en` fallback locale always downloaded — nl users pay ~105 KB gz of translations** 🔼
  - ↪ _from: Performance research 2026-07-02 · Frontend — bundle / loading_
  - `apps/frontend/src/contexts/LanguageContext.tsx:75-84` eagerly imports `en` as fallback regardless of active language; measured `en-*.js` 50.4 KB gz + `nl-*.js` 54.5 KB gz. Locale chunks are otherwise correctly lazy (dynamic import per language, not in the preload graph).
  - Fix: merge en-fallbacks into each generated locale at build time in `scripts/generate-locales.js` (only missing keys need the en value), or fetch the en dict lazily on first lookup miss.

- [ ] **Pool-wide `statement_timeout: 30s` also applies to MV refreshes — past a data-size threshold every refresh silently fails and views go permanently stale** 🔼
  - ↪ _from: Performance research 2026-07-02 · Backend — HTTP / infrastructure_
  - `apps/node-backend/src/database/connection.js:27` + `services/materializedViewService.js:185` (same pool); errors caught and only logged (`:210-211`)
  - `REFRESH MATERIALIZED VIEW CONCURRENTLY` on a large transactions table can exceed 30s; the failure mode is silent staleness with no recovery. Same exposure for snapshot computation and MC-cache queries on the shared pool. Theoretical today, guaranteed later.
  - Fix: run maintenance statements with a per-statement override (`SET LOCAL statement_timeout = 0` in a transaction, or a dedicated client).

- [ ] **Non-hashed files in `dist/` served with `Cache-Control: max-age=1y, immutable` — an explicit `GET /index.html` never sees an app update again** 🔼
  - ↪ _from: Performance research 2026-07-02 · Backend — HTTP / infrastructure_
  - `apps/node-backend/src/main.js:349` — `express.static(distPath, { index: false, maxAge: '1y', immutable: true })`; `dist/` root holds non-hashed `index.html`, `favicon.ico`, etc. `index: false` only disables directory-index resolution; the SPA fallback's `no-cache` (`main.js:354`) covers only non-file paths.
  - Fix: `setHeaders` in the static options — `no-cache` for anything not under `/assets/`.

- [ ] **Forecast repo streams raw per-transaction rows to JS instead of SQL `GROUP BY (date, currency)` — all four query paths** 🔼
  - ↪ _from: Performance research 2026-07-02 · Backend — reports & aggregations_
  - `apps/node-backend/src/repositories/infoRepo.forecast.js:256-263` (`getCashflowForecastData`), `:376-392` (Rolling), `:486-501` (ByCategory), `:57-78` (Comparison); JS aggregation at `:310-317`; per-row `{...row}` copies in `infoRepositoryHelpers.js:144-151`
  - No GROUP BY, no LIMIT; `historyMonths` clamps at 120, so a 10-year window ships every transaction row through Node per request. The sibling `infoRepo.monthly.js:139-180` already proved the fix is FX-semantics-preserving (grouped by date+currency with an explicit comment). `ByCategory` is worse: re-run on every `include_breakdown` request even on MC-cache hits (`forecast/index.js:284-287`). *(Note: the 2026-06-30 "verified optimized" entry covered `services/calculations/aggregation/cashflowForecast.js`, which contains no SQL — this is the separate `infoRepo.forecast.js` layer.)*
  - Fix: mirror the monthly-summary shape — `GROUP BY t.date, t.currency` with `SUM(amount)` in all four queries.

- [ ] **All-time pivot endpoints ship near-transaction-cardinality intermediate rows per request — no default date bound, no cache** 🔼
  - ↪ _from: Performance research 2026-07-02 · Backend — reports & aggregations_
  - `infoRepositoryStatistics.js:113-133` (`getCategoryPivot`: groups by `t.date` over the whole table, then **doubles** the set in JS — two conversion legs pushed per row at `:139-144`), `infoRepositoryRecipients.js:183-200` (`getRecipientByYear`, no date filter), `:274-292` (`getRecipientPivot`, dates optional/default null), `infoRepositoryTags.js:53-70` (`getTagPivot` with `allTags=true`)
  - Grouping by `t.date` is deliberate (per-date FX, documented at `:106-112`), but the intermediate set ≈ distinct (entity, day, currency) pairs ≈ transaction count for sparse data, growing forever; all are `source:'live'` on every statistics-page load.
  - Fix (cheapest first): default `startDate` to a rolling window in the routes; add a short in-process TTL cache keyed on (endpoint, currency, exclusions) invalidated by the existing transaction-mutation hook; longer term, month-grain pre-aggregation for the ≥1-year-old portion. **Shared root cause with the two findings above (per-date FX forcing row-grain work) — a single "grain policy" decision (exact FX for recent months, month-grain beyond) would resolve all three; ADR-worthy if pursued.**

- [ ] **aiChat tools: 50k-100k full-row fetches per tool call, re-fetched within the same chat turn** 🔼
  - ↪ _from: Performance research 2026-07-02 · Backend — reports & aggregations_
  - `services/aiChat/tools/expenses.js:22` (`MAX_ROWS = 50_000`), `:652-658` (`limit: 100_000`), `tax.js:77-83,257-263` (`limit: 100_000`), `insights.js:128-134` (`SCAN_LIMIT = 50_000`; `:137-140` documents its own no-ORDER-BY truncation hazard rather than fixing it)
  - `fetchTransactionsInRange` (`expenses.js:24-34`) does **not** use the per-turn `memoizeAsync` cache — that cache exists but only wraps portfolio fetches (`_portfolioFetch.js:19-42`). One chat turn calling e.g. `getSpendByCategory` + `getTopRecipients` + `getMonthlySpend` over the same range runs three identical 50k-row scans with per-row `toDecimal` allocations.
  - Fix: route `fetchTransactionsInRange` through `memoizeAsync(cache, ...)` (the plumbing already passes `cache` into `run()`); push category/recipient/month aggregations into SQL where the tool doesn't need raw rows.

- [ ] **`getNetWorthByAccount` replays the entire multi-year snapshot history live, per request, on the event loop** 🔼
  - ↪ _from: Performance research 2026-07-02 · Database layer_
  - `apps/node-backend/src/services/portfolio/snapshotBuilder.js:43-593` (`computeDailySnapshots`: day-walk over `O(days × investments)` with Decimal math, fully synchronous; `computeAndStoreSnapshots` always DELETEs + reinserts the whole series at `:660`), called live from `infoRepositoryNetWorth.js:292`
  - Only a 5-min TTL response cache (`routes/info/_cache.js:7`) sits in front, and `invalidatePortfolioCaches()` clears it on every investment/transaction write — so each portfolio edit + page view replays the full history (7 bulk queries + the day walk). The headline `getNetWorth` correctly reads the persisted snapshots table instead (`infoRepositoryNetWorth.js:66-77`).
  - Fix: persist the per-account split alongside the snapshots (side table) so by-account reads hit the table like the headline does; make rebuilds incremental from the last snapshot date, full replay only on backdated mutations.

- [ ] **Brokerage fan-out commit is a per-row N+1 (≥2N sequential round trips) — not covered by the known import-loop findings** 🔼
  - ↪ _from: Performance research 2026-07-02 · Database layer_
  - `apps/node-backend/src/services/importPipeline/brokerageFanout.js:96-135` (+ `cashRowExists` `:62-70`, `tradeRowExists` `:72-81`)
  - Two sequential loops: per cash row one dedup SELECT + one single-row INSERT; per trade another SELECT + `portfolioTransactionRepository.create` + cash-leg creation — each insert also firing the transactions trigger stack. The dedup lookups themselves are indexed.
  - Fix: batch the existence check with one `unnest()` anti-join, then multi-row INSERTs (same pattern as `settingsRepository.setMany`).

- [ ] **Import staging/batch tables are never pruned — every import's full raw CSV payload is retained forever** 🔼
  - ↪ _from: Performance research 2026-07-02 · Database layer_
  - `alembic/versions/0001_initial_database_schema.py:599-643` (`import_batches`, `import_staging_rows` incl. `raw_data TEXT` per row), `0040_add_portfolio_import_staging.py:66-95` (portfolio equivalents)
  - No `DELETE FROM import_batches/import_staging_rows/portfolio_import_*` anywhere in `apps/node-backend/src` (grepped all *.js). 0040's own comment calls staging rows "transient — cascade-drop with their batch," but batches are never deleted. Grows scans (incl. the FK-check scans below), review-query joins (`importBatchRepository.js:98-116`), and backup size.
  - Fix: retention pass (startup or the existing daily interval in `startup/warmup.js`) deleting batches with `status IN ('complete','failed','aborted')` older than N days — `ON DELETE CASCADE` on `batch_id` clears the rows for free.

- [ ] **CategoryPivotTable creates one backdrop-filter region per row: `glass-sticky-col` (12–16px blur) is applied per sticky `<td>`, all re-blurred on every horizontal scroll frame** 🔼
  - ↪ _from: UI/GPU research 2026-07-02 · Wave A_
  - `apps/frontend/src/components/statistics/CategoryPivotTable.tsx:239,263,317,356`, `apps/frontend/src/index.css:430-446` (blur 12px standard / 16px fx-enhanced)
  - Each category/subcategory row's frozen first cell is its own `backdrop-filter` element, so a pivot with dozens of expanded rows holds dozens of simultaneous blur regions, and horizontally scrolling the table (its core interaction) re-samples every one per frame while value cells stream underneath. (The already-filed DOM-size item is a different axis — this is compositor cost that persists even after DOM slimming.)
  - Fix: blur once — wrap the column in a single sticky container (or absolutely-positioned column overlay) carrying one `glass-sticky-col`, cells transparent; or drop to the opaque `hsl(var(--card))` fallback at the standard tier.

- [ ] **Chart tooltip is a `glass-thick` (28px blur + saturate + elevated shadow) surface repositioned on every mousemove, multiplied across sync-linked charts** 🔼
  - ↪ _from: UI/GPU research 2026-07-02 · Wave A_
  - `apps/frontend/src/components/charts/ChartTooltip.tsx:169`
  - Moving a backdrop-filter element forces the blur to be re-sampled at each new position every frame; while scrubbing a chart on Dashboard/NetWorth/Performance the tooltip re-blurs continuously, and ChartSync shows one such tooltip per linked chart simultaneously. This is compositor cost on top of (distinct from) the already-filed React hover re-render storm — fixing the re-renders won't remove it.
  - Fix: use an opaque `bg-popover` (or `glass-thin` without saturate) for chart tooltips; frequently-moving surfaces should never carry backdrop-filter.

- [ ] **Enhanced tier runs two animators simultaneously: the drifting CSS aurora blobs are never paused while the WebGL aurora animates on top of them** 🔼
  - ↪ _from: UI/GPU research 2026-07-02 · Wave B_
  - `apps/frontend/src/components/layout/ShaderAurora.tsx:10-11` ("CSS aurora blobs (always rendered underneath)"), `apps/frontend/src/index.css:589,605` (blob `animation:` lines), `apps/frontend/src/index.css:1085-1122` (tier rules — only `fx-reduced` hides and `fx-static-atmosphere` freezes the blobs; there is no `:root.fx-enhanced` pause rule)
  - Relationship clarified: the layers are tiered as fallback (WebGL failure leaves CSS blobs), but at the enhanced tier BOTH animate concurrently — two independent invalidation sources under every backdrop-filter, and on electron-mac enhanced additionally stacks the vibrancy-translucent body (`index.css:541-543`) on the same frames. The CSS drift is redundant work whenever the WebGL layer is actually drawing.
  - Fix: add `:root.fx-enhanced .liquid-canvas::before/::after { animation: none; }` (keep them as the static under-wash), or have ShaderAurora set a class on successful GL init so the CSS pause only applies when WebGL really runs.

- [ ] **`fx-static-atmosphere` freezes the CSS blobs but not ShaderAurora — the ADR-075 large-display mitigation is defeated at the enhanced tier** 🔼
  - ↪ _from: UI/GPU research 2026-07-02 · Wave B_
  - `apps/frontend/src/components/layout/VisualEffectsController.tsx` (`fx-static-atmosphere` set when `largeDisplay && tier !== 'reduced'`), `apps/frontend/src/components/layout/AppLayout.tsx:106` (ShaderAurora gated only on `tier === 'enhanced'`), `apps/frontend/src/index.css:1119-1122` (freeze rule targets only the CSS pseudo-elements)
  - On a >6MP display with auto-adapt off (or session override) and enhanced tier, the CSS blobs stop "so the compositor can go idle between frames" — but the WebGL canvas keeps redrawing at 30fps, upscaled across the whole 4K backdrop, forcing exactly the per-vsync recomposite the class exists to avoid.
  - Fix: pass the static-atmosphere state into ShaderAurora (or read the root class) and draw a single static frame instead of looping, mirroring the reduced-motion branch.

- [ ] **DataTable (non-virtual) column resize sets React state per document mousemove with no rAF batching, re-rendering the whole table every mouse event** 🔼
  - ↪ _from: UI/GPU research 2026-07-02 · Wave C_
  - `apps/frontend/src/components/shared/DataTable.tsx:154-161,173` (`handleMouseMove` → `setColumnWidths(prev => ({...prev, ...}))` per move, listener attached at 173)
  - Same defect class as the already-filed VirtualDataTable column-resize, but in the separate non-virtual `DataTable` used for Dashboard "Recent transactions" (`apps/frontend/src/pages/DashboardPage.tsx:495`); each mousemove (~60-120Hz) creates a new widths object and re-renders header + all rows, and width changes reflow the table each frame. Bounded by the small row count, but it's a second copy of the bug that will be missed if only VirtualDataTable is fixed.
  - Fix: during drag, write the width to a CSS variable / inline style on the `<col>`/`<th>` via ref per rAF; commit to React state once on mouseup (same fix as VirtualDataTable — fix both together).

- [ ] **Unbounded-looking report-data fetches actually are date-bounded, but still lack a defensive hard cap for pathological custom periods** 🔽 🔧 *(toned down + citation fixed)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/reports/dataFetcherTax.js:89-110`, `dataFetcherPortfolio.js:73-89`
  - Both queries are bounded by the report's date range and aggregate in JS after that — not literally unbounded. The real gap is the missing defensive LIMIT for pathological multi-year custom periods, mirroring the precedent in `infoRepo.statistics.js` (note: **not** `infoRepositoryStatistics.js`, a different, similarly-named file — the original citation was wrong).
  - Fix: add a defensive LIMIT for pathological multi-year custom periods.

- [ ] **`matchInvestments.js` resolves distinct symbol/name keys one at a time instead of batched** 🔽 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/portfolioImportPipeline/matchInvestments.js:51-67,86-106`
  - Each distinct `(symbol, name)` pair triggers up to 2 sequential SELECTs (per-key cached, but distinct keys aren't batched) — contrast with the bank pipeline's recipient resolution, which batches all distinct names into one `pg_trgm` query.
  - Fix: batch with `WHERE LOWER(symbol) = ANY($1::text[])`, then one batched query for unresolved names.

- [ ] **`GET /api/info/recurring-patterns` does uncached synchronous recomputation, including from AI chat** 🔽 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/recurringDetectionService.js:129-277`; also called from `aiChat/tools/insights.js:288`
  - Query is bounded (3 years) but the grouping/sorting/interval-detection runs synchronously on the event loop with no caching; the AI-chat tool can trigger it repeatedly within one chat session.
  - Fix: cache the result short-term (a few minutes), invalidate on transaction mutation.

- [ ] **`Card` primitive defaults every instance to the most expensive glass-blur tier** 🔽 ✅ *(root cause of the Watchlist finding above)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/components/ui/card.tsx:9`
  - Blur tier is baked unconditionally into the base `className`, with no variant prop to opt out — only an additive override is possible.
  - Fix: default `Card` to a flat surface; require an explicit `glass-*` className for hero/standalone cards.

- [ ] **`SettingsPreloadContext` provider value is an unmemoized object literal at the app root** 🔽 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/contexts/SettingsPreloadContext.tsx:70`, used at `App.tsx:168`
  - `value={{ rawSettings, isLoading }}` is a fresh object every render in the outermost provider — the one provider not following the `useMemo` pattern used elsewhere (`LanguageContext`, `BelgianTaxProfileContext`, `PageTitleContext`).
  - Fix: `useMemo(() => ({ rawSettings, isLoading }), [rawSettings, isLoading])`.

- [ ] **Attachment thumbnails fetch full-resolution images for a 24px icon, not lazy-loaded** 🔽 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/components/shared/AttachmentPanel.tsx:64-68`
  - Points at the original download endpoint (receipt photos can be several MB) to render a 24×24px thumbnail; no `loading="lazy"`, no server-side thumbnail variant.
  - Fix: add `loading="lazy"` at minimum; ideally serve a server-generated thumbnail.

- [ ] **Minor React Query hygiene (grouped)** 🔽
  - ↪ _from: Performance research 2026-07-02 · Frontend — React Query_
  - Full category list double-fetched under `['categories','all']` (`StatisticsSection.tsx:25-29`) vs. `['categories','all-for-exclusions']` (`useExcludedIds.ts:48-62`) — identical `getCategories({limit:1000})`, two cache entries; share one key/hook.
  - `useAdapters` is plain useEffect+fetch (`features/imports/useAdapters.ts:17-25`): two cards on the import page each issue their own request per visit, and `t` in the deps refires it on language switch, for a near-static list. Convert to `useQuery({queryKey:['supported-parsers'], staleTime: Infinity})`.
  - MarketLookupPage quote poll not gated on online state (`pages/research/MarketLookupPage.tsx:200-202`) — keeps firing failing requests every 60s while offline, unlike all five sibling pages that gate on `isOnline`.
  - `useOllamaStatus` polls every 30s while chat/settings mounted even when the integration is disabled/unreachable (`hooks/useOllamaStatus.ts:11-14`); optional backoff when down.
  - `usePortfolioPrefetch` (`hooks/usePortfolioPrefetch.ts:37-42`, mounted in AppSidebar) fires net-worth + full-period performance on every app boot for all users, documented as intentional (backend warms these) — verify backend cache-hit cost before changing; flagged as a trade-off, not a bug.

- [ ] **Minor render hygiene (grouped)** 🔽
  - ↪ _from: Performance research 2026-07-02 · Frontend — runtime rendering_
  - `CategoryPivotTable.tsx:76,242-360` defaults to "all" years and renders every period × category eagerly — multi-year data ≈ 3-4k `<td>`s rebuilt per valueMode/collapse/year toggle (computation memos are fine; cost is DOM size). Default to latest year or window the period columns.
  - `BankBalancesWidget.tsx:113-147` builds its ~365-point × N-accounts chart dataset in the render body unmemoized — fresh `data` identity per dashboard re-render, which would also defeat any chart-level memoization added for the findings above. Wrap in `useMemo` keyed on `data`.

- [ ] **decimal.js bundled twice (~12-13 KB gz each copy)** 🔽
  - ↪ _from: Performance research 2026-07-02 · Frontend — bundle / loading_
  - `grep -l DecimalError dist/assets/*.js` → both `money-*.js` and `AIChatPage-*.js` carry a full copy. Cause: `packages/shared-utils/package.json:35` declares its own `decimal.js` dep (consumed via `@vision/shared-utils`) while `src/utils/currency.ts` imports `decimal.js` directly — two module IDs, no shared chunk.
  - Fix: `resolve.dedupe: ['decimal.js']` in `apps/frontend/vite.config.ts`.

- [ ] **theme-flash script silently merged into the main bundle in prod — dark-theme flash-of-light during load** 🔽
  - ↪ _from: Performance research 2026-07-02 · Frontend — bundle / loading_
  - Source `apps/frontend/index.html:13` declares `/src/theme-flash.ts` as a separate early module; built `dist/index.html` has no such script — `vision_theme` handling lives inside the main `index-*.js`, so the dark class is applied only after the full ~300 KB gz boot graph executes. The "runs before React mounts" comment at `index.html:12` is misleading in prod.
  - Fix: inline the theme snippet as a plain non-module `<script>` in `index.html` so it survives bundling and runs pre-paint.

- [ ] **Minor bundle/loading items (grouped)** 🔽
  - ↪ _from: Performance research 2026-07-02 · Frontend — bundle / loading_
  - No font preloading: 6 static weights imported via `main.tsx:9-14` (latin-subset — good) but no `<link rel="preload" as="font">` in `index.html` → FOUT on cold load; also both woff+woff2 emitted (~168 KB dist bloat, browsers fetch woff2 only). Preload Inter 400/600 woff2; consider variable fonts.
  - `AIChatPage` is the largest chunk (373 KB raw / 104 KB gz, correctly lazy): contains recharts + the duplicate decimal.js; nesting `ToolResultCard`'s chart rendering behind its own `lazy()` would cut /ai-chat time-to-interactive substantially.
  - `zod` + API client (18.3 KB gz) and `BelgianTaxProfileContext` (6.5 KB gz) sit in the boot graph — defensible (runtime validation, global provider); the tax context could defer its data tables to tax routes. `@types/d3-sankey` listed in runtime `dependencies` (`package.json:56`) — no bundle impact, move to devDependencies.

- [ ] **Minor infra items (grouped)** 🔽
  - ↪ _from: Performance research 2026-07-02 · Backend — HTTP / infrastructure_
  - MV/reconcile debounces are trailing-only with no max-wait (`materializedViewService.js:232-240`, `transferReconciliationService.js:229-237`): a machine-cadence mutation stream (<1s apart) defers refresh indefinitely. Add a max-wait (fire at ≥10s regardless).
  - SSE streams have no heartbeat (`lib/sse.js:44-72`; consumers `routes/ai.js:285-359`, `importRoutes.js:238-301`, `portfolioImportRoutes.js:184`): behind a reverse proxy with default idle timeout (nginx 60s), a silent stream (e.g. Ollama cold-load >60s before first token) gets killed → reconnect loop. Add a 15-30s `:hb` comment interval, cleared on close.
  - gzip middleware never sets `Vary: Accept-Encoding` and Express's weak ETag is computed pre-compression (`main.js:148-214`) — wrong behind a shared cache/proxy; harmless on loopback. Append the Vary header in `setup()`.
  - Hashed assets are re-gzipped on the fly per request (`main.js:169`) — emit `.gz` siblings at build time or cache compressed buffers for `/assets/`.
  - `getLogLevel()` re-parses `process.env` on every log call (`config/logger.js:13-20`, invoked per request and per DB query); and the slow-query log (`connection.js:67-68`, >1s) is debug-level so invisible in production. Compute level once at module load; log slow queries at `warn`.

- [ ] **Puppeteer browser-launch race + unbounded report concurrency** 🔽
  - ↪ _from: Performance research 2026-07-02 · Backend — reports & aggregations_
  - `services/reports/puppeteerRenderer.js:14-35` — `getBrowser()` checks `browser?.connected` then launches with no in-flight promise memoization: two concurrent first renders both launch Chromium, the second assignment overwrites `browser`, the first process leaks. `routes/reports.js:105-118` has no rate limit/queue, so N concurrent POSTs = N Chromium pages + N full data fetches.
  - Fix: `launchPromise ??= puppeteer.launch(...)`; optionally serialize renders with p-limit(1-2). (Rendering itself verified fine: page-per-render, closed in `finally`, bounded content.)

- [ ] **`fetchFinancialData` fetches all 7 data sources regardless of which report sections were requested — and ignores `period`** 🔽
  - ↪ _from: Performance research 2026-07-02 · Backend — reports & aggregations_
  - `services/reports/index.js:478-494` computes `valid` sections then calls `fetchFinancialData` (`dataFetcher.js:55-68`) which unconditionally runs all-time monthly summary, category breakdown, recipient insights, bank balances, avg-vs-current, and planned expenses in parallel; sections trim months client-side via `filterMonthsByPeriod`, so a 3-month bank-balances-only report costs the same as an all-time everything report.
  - Fix: pass `valid` into the fetcher, map section→source, replace unneeded sources with `Promise.resolve(null)` (renderers already handle null).

- [ ] **`agg_recipient_totals` per-row trigger is pure write-side overhead — its only reader is a trivial existence check** 🔽
  - ↪ _from: Performance research 2026-07-02 · Backend — reports & aggregations_
  - `alembic/versions/0035_add_recipient_aggregations.py:161-166` (`FOR EACH ROW` on every transactions INSERT/UPDATE/DELETE; UPDATE = two upserts); sole reader `recipientRepository.js:43` (`SELECT 1 FROM agg_recipient_totals ...`)
  - The insights endpoints can't use the table (net-not-spend totals, no transfer exclusion — the reason the sibling MV was dropped in `0038`). Every CSV bulk import pays a plpgsql upsert per row for a table whose one query could be an indexed `EXISTS` against `transactions`.
  - Fix: replace the reader with `EXISTS(SELECT 1 FROM transactions ...)` (covered by existing indexes) and drop table+trigger in a new migration — or wire it into a real fast path; either way stop paying for nothing.

- [ ] **Historical-FX conversion loads the full `exchange_rates` history per call; zero-rate currencies can trigger per-(currency,date) DB/HTTP fetches inside the conversion loop** 🔽
  - ↪ _from: Performance research 2026-07-02 · Backend — reports & aggregations_
  - `services/currency/currencyConversionService.js:252-258` (duplicated at `services/reports/dataFetcherTax.js:148-155`) — no date lower bound, no cross-request cache: every historical-converting endpoint re-reads ~all stored rates per currency (ECB backfill ≈ 6.9k rows/currency) and rebuilds `buildHistoricalRateIndex` per request. Edge: a currency with zero stored rows falls into `getRateToEurForDate` per unique (currency,date) — `rateFetcher.js:395-434` does a DB point query and potentially an ECB HTTP fetch inside the loop (memoized only per-call).
  - Fix: bound the history query by the data's min date; add a small process-level rate-index cache invalidated by the existing 12h `warmCache` cycle.

- [ ] **Six unindexed FK columns get seq-scanned on every recipient/pattern/category/investment delete** 🔽 *(amplified by the unpruned staging tables above)*
  - ↪ _from: Performance research 2026-07-02 · Database layer_
  - `import_staging_rows.matched_pattern_id` + `.user_override_recipient_id` (`0015_recipient_match_patterns.py:83-90`, `ON DELETE SET NULL`, no index); `manual_raw_transactions.recipient_id` + `.category_id` (`0024:51,56`); `portfolio_import_staging_rows.resolved_investment_id` + `.user_override_investment_id` (`0040:132-143`)
  - Postgres scans these tables in full to enforce `SET NULL` on each parent delete — and recipients *are* deleted in bulk (import rollback `DELETE ... WHERE id = ANY(...)` at `importBatchRepository.js:215`, plus merges).
  - Fix: partial indexes (`... WHERE <col> IS NOT NULL`) on the six columns, or rely on the staging-retention fix keeping the tables small.

- [ ] **Import commit blocks its HTTP response on 4 full MV recomputes (incl. the all-time `mv_category_totals`)** 🔽
  - ↪ _from: Performance research 2026-07-02 · Database layer_
  - `services/importPipeline/commit.js:245` + `routes/importRoutes.js:391` both `await refreshAggregations()` → awaited `REFRESH ... CONCURRENTLY` on all 4 views. Partially deliberate (the >100-row path awaits so the review page lands on fresh data — `importPipeline/index.js:95-101`), and storm risk itself is well-handled (in-flight coalescing + queued re-run).
  - Fix: respond first, refresh after (`scheduleRefresh()`), keeping only the MC-cache invalidation synchronous — weigh against the deliberate fresh-on-landing behavior before changing.

- [ ] **`sync_account_id_from_bank_account` trigger does an INSERT-attempt + SELECT per inserted transaction row — SELECT-first would halve the common path** 🔽
  - ↪ _from: Performance research 2026-07-02 · Database layer_
  - `0051` (narrowed by `0062_trigger_lookup_only_on_update.py:56-85`): on every INSERT it runs `INSERT INTO accounts ... ON CONFLICT DO NOTHING` **plus** `SELECT id FROM accounts WHERE name = ...`. Both hit `uq_accounts_name` on a tiny table so per-row cost is bounded, but the insert-attempt arm takes a write lock and burns an `accounts.id` sequence value per row even when the account exists. A 5,000-row import executes ~15k extra indexed statements across the full trigger stack (the other two triggers verified fine).
  - Fix: SELECT-first, insert only on miss.

- [ ] **Skeleton shimmer animates `background-position` — a paint-property infinite animation repainting every skeleton's full area each frame** 🔽
  - ↪ _from: UI/GPU research 2026-07-02 · Wave A_
  - `apps/frontend/src/components/ui/skeleton.tsx:7`, `apps/frontend/src/components/charts/ChartSkeleton.tsx:41` (300px-tall shimmer overlay), `apps/frontend/tailwind.config.ts:158-161,183` (shimmer keyframes = backgroundPosition, 2.4s infinite)
  - `background-position` is not compositor-animatable, so each of the 8+ concurrent skeletons on Dashboard load (statSkeleton grid at `pages/DashboardPage.tsx:305-320` + two 300px ChartSkeletons) repaints per frame; runs while offscreen too (no visibility gating). Transient (loading states only), hence low.
  - Fix: shimmer via `transform: translateX()` on an absolutely-positioned gradient pseudo-element/child instead of background-position.

- [ ] **Nested blur-inside-blur on permanent chrome: workspace tab strip carries `backdrop-blur-sm` inside the already-blurred `glass-chrome` sidebar; chat table headers/composer blur inside glass cards** 🔽
  - ↪ _from: UI/GPU research 2026-07-02 · Wave A_
  - `apps/frontend/src/components/layout/AppSidebar.tsx:301`, `apps/frontend/src/features/ai-chat/ToolResultCard.tsx:135` (sticky `<thead>` blur re-sampled per scroll frame), `features/ai-chat/ChatComposer.tsx:71`
  - A backdrop-filter element inside another forces the browser to resolve the outer blur before computing the inner one; the sidebar case is mounted permanently on every page. Regions are small, so cost is modest — but it is pure waste: the tab strip sits on an already-frosted surface where the extra blur is visually invisible.
  - Fix: drop the inner `backdrop-blur-sm` (keep `bg-sidebar-accent/60`); use an opaque/tinted sticky thead in ToolResultCard.

- [ ] **`transition-all` on width-animating elements makes data updates and hovers trigger layout+paint transitions** 🔽
  - ↪ _from: UI/GPU research 2026-07-02 · Wave A_
  - `apps/frontend/src/components/portfolio/TotalValueCard.tsx:115`, `components/tax/MultiYearTrendStrip.tsx:136`, `components/dashboard/CashFlowForecastDiagnostics.tsx:262` (progress-bar fills animating inline `width`), `components/shared/DataTable.tsx:457` + `components/shared/VirtualDataTable.tsx:643` (`hover:w-0.5` resize handles), `pages/research/MarketOverviewPage.tsx:1015` (movers heat-grid: up to dozens of tiles each with `transition-all` + `micro-lift`)
  - `transition-all` opts every property change — including layout ones like width — into animation, so each transition frame is a layout+paint, and any incidental class/prop change animates unintentionally. All sites are small elements or hover-scoped, so real cost is low; the MarketOverview grid is the widest (6-col × N tiles, each animating border/background on hover).
  - Fix: replace with explicit lists (`transition-[width]` where wanted, or animate fills via `transform: scaleX()`); on the heat tiles use `transition-colors`.

- [ ] **No `webglcontextrestored` handler — after a GPU-process restart the aurora goes permanently blank while its listeners keep running** 🔽
  - ↪ _from: UI/GPU research 2026-07-02 · Wave B_
  - `apps/frontend/src/components/layout/ShaderAurora.tsx:194-198` (contextlost cancels rAF; nothing re-inits on restore)
  - In Electron a GPU process crash/driver reset fires `webglcontextlost` then `restored`; the component cancels the loop and never rebuilds shaders/buffers, so the effect silently dies until full reload — and the MutationObserver + resize listener keep doing dead work. AppLayout mounts once for the app's lifetime, so no remount ever rescues it.
  - Fix: handle `webglcontextrestored` by re-running program/buffer setup and restarting the loop (or force a remount via a state key).

- [ ] **GL context requests no `powerPreference: 'low-power'` and no `failIfMajorPerformanceCaveat` for a purely decorative layer** 🔽
  - ↪ _from: UI/GPU research 2026-07-02 · Wave B_
  - `apps/frontend/src/components/layout/ShaderAurora.tsx:106` (`getContext("webgl", { alpha: true, antialias: false, depth: false, stencil: false })`)
  - The default power preference can activate the discrete GPU on dual-GPU machines for background ambiance (battery cost), and without `failIfMajorPerformanceCaveat` a blocklisted-GPU/SwiftShader environment runs the fbm shader on CPU at 30fps instead of falling back to the cheap CSS blobs.
  - Fix: add `powerPreference: 'low-power', failIfMajorPerformanceCaveat: true` to the context attributes.

- [ ] **Under prefers-reduced-motion, a window resize clears the one static frame and nothing redraws — aurora blanks until reload (theme changes also leave stale colors)** 🔽
  - ↪ _from: UI/GPU research 2026-07-02 · Wave B_
  - `apps/frontend/src/components/layout/ShaderAurora.tsx:155-164` (resize sets `canvas.width`, which wipes the backing store, without scheduling a draw), `:182-183` (reduced-motion branch draws exactly once)
  - Setting `canvas.width` resets the drawing buffer to transparent; in the animated branch the next 33ms frame repaints, but in the reduced-motion branch no draw is ever scheduled again, so the first resize permanently blanks the enhanced-tier WebGL layer; `refreshColors()` similarly updates `c1`/`c2` without a redraw.
  - Fix: call `draw(0)` at the end of `resize()` and in `refreshColors()` when in the reduced-motion (or future static) mode.

- [ ] **NetSummaryCard sparkline scrub calls getBoundingClientRect on every pointermove and re-renders the full hero card (RollingNumber + Sparkline path rebuild) per index change** 🔽
  - ↪ _from: UI/GPU research 2026-07-02 · Wave C_
  - `apps/frontend/src/components/dashboard/NetSummaryCard.tsx:34-41,133` (`scrubFromEvent` does `e.currentTarget.getBoundingClientRect()` per move → `setScrubIndex`; `chartData` rebuilt in render body at 52-55 so Sparkline gets a fresh array each render)
  - GBCR runs on every pointermove during scrub (rect never changes mid-drag), and each index change re-renders the whole Card — RollingNumber digit animation restarts and Sparkline recomputes scales/curves from a newly-allocated array. Cost is bounded by React's same-index setState bailout (with ~12-24 history points most moves bail), so this is a polish item, not a storm.
  - Fix: cache the rect on pointerdown (in a ref) and reuse it for the drag; hoist `chartData`/the `data` array into `useMemo` so Sparkline's memoizable inputs are referentially stable.

- [ ] **ChatMessageList forces a layout flush (scrollHeight read + scrollTop write) and re-renders every unmemoized ChatBubble on each streamed token chunk** 🔽
  - ↪ _from: UI/GPU research 2026-07-02 · Wave C_
  - `apps/frontend/src/features/ai-chat/ChatMessageList.tsx:60-64` (effect keyed on `assistantDraft`/`streamingToolContentLength` → `el.scrollTop = el.scrollHeight` per chunk); `ChatBubble` is not memoized (`apps/frontend/src/features/ai-chat/ChatBubble.tsx:11`)
  - During streaming, every chunk re-renders the entire unvirtualized message list (O(conversation length)) and the effect reads `scrollHeight` on the freshly-mutated container, forcing a synchronous reflow per chunk. Also pins scroll unconditionally — the user can't scroll up while streaming (UX side effect of the same code). Chat page only, so bounded blast radius.
  - Fix: `React.memo(ChatBubble)`; render the streaming draft in a leaf component so only it re-renders per chunk; guard auto-scroll with an "is pinned to bottom" check and scroll via `el.scrollTo({top: el.scrollHeight})` inside rAF.

- [ ] **`planned_transactions` and `portfolio_transactions` have only single-column indexes where queries filter on multiple columns together** ⬇ 🔧 *(`exchange_rates` dropped from this finding — already adequately indexed)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `planned_transactions` (queried 3-column), `portfolio_transactions` (queried with `investment_id = ANY(...)` + window function), `moveHoldingService.js` filters by `(investment_id, account_id)` — all single-column only.
  - Low impact at current personal-finance scale; not urgent.
  - Fix: composite indexes if/when these tables grow — `(is_active, is_executed, planned_date)`, `(investment_id, date, id)`, `(investment_id, account_id)`.
  - Verification (2026-06-30): the `exchange_rates` sub-claim is **wrong and removed** — `alembic/versions/0001_initial_database_schema.py` defines `CONSTRAINT uq_currency_date UNIQUE (currency_code, rate_date)` inline in the table definition, which Postgres backs with a real composite index covering exactly the access pattern (`rateFetcher.js:308-326` filters `currency_code = $1 AND rate_date <= $2`). Two independent verification passes initially missed this by only grepping for `CREATE INDEX` statements and not inline `CONSTRAINT ... UNIQUE` clauses — a useful lesson for future index audits in this codebase.

- [ ] **Minor pagination/cache hygiene gaps** ⬇ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `routes/tags.js:19-24` + `tagRepository.js:15-29` (unbounded list, no LIMIT, unlike every sibling route); `recipients.js:23-26` → `recipientClusterService.js:36-43` (loads every active recipient before bucketing, output capped but scan isn't); `infoRepositoryHelpers.js:80-82` `clearMvCache()` exported/documented as "used after bulk import" but has zero actual callers (self-heals via 60s negative TTL; comment is stale).
  - Fix: add `parsePagination` to the tags route; wire up or remove the dead `clearMvCache()` export.

- [ ] **FX-backfill helper runs on every backend startup (not literally "one-time"), but is self-limiting and not request-path** ⬇ 🔧 *(re-characterized)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/currency/currencyConversionService.js:475-494` (`backfillPortfolioHistoricalRates`)
  - `for (const row of missingResult.rows) { await getRateToEurForDate(...); await query(exactCheck...) }` — a genuine N+1, confirmed. Its sole caller is `startup/warmup.js:230-235`, invoked unconditionally on every boot (when online) — not a manually-triggered one-time migration script as originally described, though it stays cheap after the first run since its own query is gated to only rows genuinely missing a rate.
  - Fix: low priority given the self-limiting behavior; batch if it ever shows up in startup-time profiling.

- [ ] **Accordion height animation has no `prefers-reduced-motion` guard** ⬇ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `config/tailwind.config.ts:71-91` (keyframes), `apps/frontend/src/index.css:977-1005` (reduced-motion block doesn't include these)
  - Animates layout-triggering `height`; unlike every other animation class, `animate-accordion-down/-up` is missing from the existing reduced-motion override list, and there's no JS-level `useReducedMotion` check either (unlike `ThemeContext`/`ShaderAurora`/`useCountUp`/`RollingNumber`, which all do their own check).
  - Fix: add `.animate-accordion-down, .animate-accordion-up { animation: none; }` to the existing block.

- [ ] **Minor DB-layer items (grouped)** ⏬
  - ↪ _from: Performance research 2026-07-02 · Database layer_
  - Transactions list uses OFFSET pagination + `SELECT t.*` with the `running_balance` window evaluated over the entire filtered set before LIMIT/OFFSET (`transactionRepository.js:126-140`) — tens of ms at current scale; keyset `(date, id)` (already used by the export streamer) would cap the worst case if it ever shows up.
  - Forecast MC caches are wiped on every import (`aggregationRefresh.js:43-47`) and a cache-miss recompute includes a synchronous 12-month walk-forward backtest (`forecast/index.js:265`, `includeBacktest=true` default) — bounded (~low hundreds of ms) at the current horizon; yield between methods if it grows.
  - `db_editor_audit` (0059) and `ai_messages`/`ai_conversations` grow unboundedly (deleted only on explicit conversation delete) — user-action-rate tables, backup-size concern only; optional retention setting.

- [ ] **Dark-mode double text-shadow (2px + 14px blur) applies to every heading and every `p/span/div` inside `.canvas-text` subtrees** ⏬
  - ↪ _from: UI/GPU research 2026-07-02 · Wave A_
  - `apps/frontend/src/index.css:59-68` (`.dark .canvas-text :is(h1, h2, h3, p, span, div)`)
  - `.font-display` includes every CardTitle, so effectively all titles app-wide paint two blurred text-shadows in dark mode, and the `:is(span, div)` arm matches broadly inside PageHeader subtrees (selector-matching + rasterization cost on first paint and any content change). Cost is static paint, not per-frame — hence lowest.
  - Fix: scope the halo to direct heading/subtitle elements of PageHeader rather than all descendant spans/divs; consider a single shadow.

- [ ] **macOS window-level vibrancy material is created unconditionally and never removed when the effective tier is below enhanced** ⏬
  - ↪ _from: UI/GPU research 2026-07-02 · Wave B_
  - `packaging/electron/main.js:1497-1502` (`vibrancy: 'under-window'` set at window creation), `apps/frontend/src/components/layout/ElectronBridge.tsx:117-121` (renderer only toggles the `.vibrancy` CSS class; no IPC to `setVibrancy(null)`)
  - At standard/reduced tiers the page paints opaque so the NSVisualEffectView is invisible, but the window server still maintains the under-window blur material behind the window (sampled on move/desktop changes) — wasted (small) compositor/battery work for the common non-enhanced case; `followWindow` limits it to the active window only.
  - Fix: expose an IPC that calls `mainWindow.setVibrancy(effectiveTier === 'enhanced' ? 'under-window' : null)` from the same effect that toggles the CSS class.

- [ ] **ChatComposer textarea autosize does a write-read-write (`height='auto'` → `scrollHeight` → `height=…`) per keystroke — one forced reflow per character typed** ⏬
  - ↪ _from: UI/GPU research 2026-07-02 · Wave C_
  - `apps/frontend/src/features/ai-chat/ChatComposer.tsx:48-53`
  - Canonical autosize pattern; the interleaved style write + scrollHeight read forces a synchronous layout per keystroke. Single small textarea on the chat page, so real cost is minimal — noted for completeness.
  - Fix: use CSS `field-sizing: content` (Chromium/Electron supports it) and drop the effect, or accept as-is.

- [ ] **PieChart reads getBoundingClientRect on slice pointerenter but never uses the rect — dead forced layout read** ⏬
  - ↪ _from: UI/GPU research 2026-07-02 · Wave C_
  - `apps/frontend/src/components/charts/PieChart.tsx:102-110` (`rect` fetched at 103-104, used only as a truthiness guard; `setHover` uses centroid coords `centerX + cx` / `centerY + cy`)
  - Per-enter (not per-move) so frequency is low; it's dead code that forces a layout read for nothing.
  - Fix: delete the GBCR call and the guard.

### 🎨 UI/UX & Design

> **Meta-finding (Design authenticity 2026-07-03):** the design *system* is genuinely crafted (Fraunces/Inter/mono type roles, the `Money`/`RollingNumber`/`DeltaPill` components, token-driven WebGL aurora, jewel chart palette). Almost all "AI-slop" here is **adoption gaps + paste-drift** — a crafted component with ~3 consumers while ~30 sites hand-roll the generic version. So the fix direction is mostly to **systematize onto what already exists, not design new things**. An eyes-on Demo-app pass is the top remaining residue.

- [ ] **Dutch UI mixes formal "u/uw" and informal "je/jouw" — two voices in one app, the top machine-translation tell for a Dutch reader** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/nl.json` — 118 lines use u/uw vs 30 lines je/jouw (grep `\b(je|jouw|jij)\b` / `\b(u|uw)\b`). The je-lines cluster in 2026 features (accounts:26, aiChat:278-279, dbEditor:728,741, research:2112-2365, tax:2943-3299, rebalance:1937, settings:2396,2579,2624) against the older u-core (onboarding, import, dashboard:694, insights:1074). Same-concept clashes: `addWatchlist.notesPlaceholder`:213 "Waarom volgt u dit actief?" vs `research.entry.watchlist`:2163 "Volg effecten die je nog niet bezit"; `customChart.createFirst`:607 "Maak uw eerste grafiek" vs `research.builder.emptyTitle`:2112 "Bouw je grafiek". (Dead `scripts/auto-translate-nl.js` — already filed by Wave D3 — corroborates the MT origin.)
  - Fix: pick **je** app-wide (single power user, personal finance, matches Apple's Dutch register) and sweep nl.json u/uw→je/jouw with verb agreement; add the rule to the i18n skill. Run `bun run validate-locales` after.

- [ ] **63 strings use " -- " (double hyphen) as an em dash — renders literally in daily-visible headers and stat labels** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json` — `grep ' -- '` → 63 hits, 0 real "—" in the file; mirrored in nl.json. Daily surfaces: `dashboard.stat.lastMonthIncome`:683 "Last Month -- Income", `rebalance.subtitle`:1981, `research.subtitle`:2358, `aiChat.emptyState`:278, `addPortTxn.title`:183 "Record Transaction -- {symbol}", `dbEditor.subtitle`:738. The strings pass straight through `t()` (e.g. `pages/portfolio/RebalancePage.tsx:194`), so the UI shows raw "--" — a markdown/source-code habit, not typography.
  - Fix: replace " -- " with " — " (U+2014, spaced) in en.json + nl.json (mechanical sed; validate-locales checks parity, not glyphs); add "real em dashes in UI copy" to the docs style note.

- [ ] **Onboarding is the AI-enthusiasm hotspot: "Welcome to Vision!", "Let's get you set up", "You're all set!" ×2 — and the Dutch renders it as "Laten we u instellen" (= "let's configure you")** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json` — 9 of the app's 12 exclamation strings live in onboarding: `onboarding.welcome.title`:1442 "Welcome to Vision!", `onboarding.welcome.desc`:1441 "Let's get you set up in a few easy steps.", `onboarding.tour.title`:1439 "You're all set!", `onboarding.toast.categoriesCreated`:1434 "Created {n} categories!", `onboarding.toast.imported`:1437, `onboarding.import.success`:1385. Worse in Dutch: `nl.json:1441` "Laten we u in een paar eenvoudige stappen instellen." and `:1356` "Uw persoonlijke financiebeheerder. Laten we u instellen." — "u instellen" reads as configuring the *user*, a literal MT calque; `:1429` "Verbind uw banken" is a "connect"-calque (Dutch: "koppel"). Also a dead parallel copy set drifts alongside the live one: `onboarding.importStep.*`, `onboarding.title.*`, `onboarding.desc.*`, `onboarding.setup`, `onboarding.welcome` are referenced nowhere in `apps/frontend/src` (only `onboarding.import.*`, `onboarding.welcome.title/.desc`, `onboarding.step.*.label`, `onboarding.tour.*` are used) — e.g. dead "Import Your Transactions":1390 vs live "Import your transactions".
  - Fix: rewrite the first-run flow in the app's calm register — title "Welcome to Vision", desc "Set up your accounts, categories, and first import in a few steps.", done-step "Setup complete" / toasts "Created {n} categories" (no "!"); nl: "Welkom bij Vision" / "Stel je rekeningen, categorieën en eerste import in een paar stappen in."; delete the dead key families so future sweeps edit one copy.

- [ ] **AI-chat charts use a stock Tailwind hue dump instead of the jewel chart tokens — the most "AI" surface renders the most AI-default palette** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - `apps/frontend/src/features/ai-chat/ToolResultCard.tsx:41-49` — local `CHART_COLORS` hardcodes `hsl(217, 91%, 60%)` (= Tailwind `blue-500` exactly), `hsl(142, 76%, 36%)` (= `green-600`), `hsl(45, 93%, 47%)`, `hsl(280, 87%, 65%)`, `hsl(340, 82%, 52%)`… — the literal shadcn/Tailwind default series, applied at lines 210/240/279 to line, bar, and pie fills. It ignores the canonical `components/charts/palette.ts:5` `CHART_TOKEN_COLORS` (jewel-tuned `--chart-1..8` with light/dark + theme-variant adaptation), so AI-chat charts clash hue-family with every other chart and don't follow Dracula/Nord/etc.
  - Fix: delete the local array and import `getChartColor`/`CHART_TOKEN_COLORS` from `@/components/charts` — one-line swap, instant theme/dark adaptation.

- [ ] **Category colors are positional-by-rank — the same category changes hue between charts, pages, and months (no color identity)** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - `apps/frontend/src/components/statistics/CategoryPieChart.tsx:35-41` colors the top-10 by *spend rank* (`hsl(var(--chart-${(index % 8) + 1}))` after `.sort((a,b) => b.value - a.value)`); `components/dashboard/CategoryPieChart.tsx:21` does `getChartColor(i)` over a differently-ordered list; `components/statistics/SankeyChart.tsx:44-46` cycles its own palette by node index. So FOOD:GROCERIES is green on the dashboard, blue in statistics, and shifts color whenever its rank moves — the tell of colors assigned by loop index, not by meaning. Meanwhile the one place built for category identity is a dead husk: `apps/frontend/src/utils/categoryColors.ts:5-49` — the entire mapping body is commented out and *every* category returns the same `bg-muted/15` chip (used by `TransactionsTable`, `TransactionQuickLook`, `DashboardPage`).
  - Fix: one deterministic category→color assignment (stable hash of the GENERAL part → `--chart-N` token index, as `TagInput.tsx` already does per-tag) shared by chips and all charts; resurrect or delete the commented `categoryColors.ts` corpse.

- [ ] **The copy-pasted "corner orb" decorative gradient appears ~10× in three drifting dialects — one motif, no rule, raw `white` bypassing tokens** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - `grep -rn "rounded-full -mr-16 -mt-16" apps/frontend/src` — the same `absolute top-0 right-0 w-32 h-32 bg-gradient-to-br … rounded-full -mr-16 -mt-16` blob is pasted into `components/shared/DataTable.tsx:309`, `shared/VirtualDataTable.tsx:497`, `dashboard/MonthlyTrendsChart.tsx:153`, `dashboard/CategoryPieChart.tsx:58,78` (all `from-white/50 … dark:from-white/10` — raw white, not a glass token), vs `dashboard/StatCard.tsx:45` + `dashboard/NetSummaryCard.tsx:71` (`from-background/40`, w-48 on the latter) vs `dashboard/CashFlowForecastChart.tsx:392` + `dashboard/BankBalancesWidget.tsx:155` (`from-primary/10`). Identical decorative intent, three color values, two sizes — classic generated-UI paste-drift, and it encodes nothing about the card's content.
  - Fix: keep the sheen (it suits the glass language) but make it a system: one `<CardSheen/>`/`.card-sheen` class reading glass tokens (`--glass-highlight`), one size rule, and a deliberate policy for which card tier gets it (hero/KPI only, per ADR-105's elevation hierarchy) — then delete the 10 pastes.

- [ ] **Every Card hover-lifts, glows primary, and jumps to the elevated shadow — ADR-105's card/hero hierarchy is erased on hover, and 38 sites stack a second conflicting lift** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - `apps/frontend/src/components/ui/card.tsx:9` bakes `hover:-translate-y-0.5 hover:shadow-glass-elevated` plus `premium-frame` into *every* Card; `index.css:698-703` (`.premium-frame:hover`) additionally recolors every card border to `primary/0.4` on hover. Net effect: a static disclaimer card reacts identically to a clickable KPI tile — uniform affordance = no affordance, and the glass-regular/glass-elevated distinction ADR-105 built collapses whenever the pointer moves. On top, 38 call sites re-add `.micro-lift` (`index.css:725-728`, `translateY(-1px)`) which fights the base `-translate-y-0.5` (−2px) — two transforms, cascade-order winner, inconsistent lift depth across pages.
  - Fix: keep the lift/glow character but make it *hierarchical*: an `interactive`/`elevated` Card variant (cva) carries the lift + primary border + elevated-shadow hover; plain content cards keep the material but sit still. Remove `micro-lift` from Card call sites (it becomes the variant).

- [ ] **The main transactions table's amount column is left-aligned — the one column where alignment is the whole point** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S3_
  - `apps/frontend/src/features/transactions/components/TransactionsTable.tsx:221-232` — the amount column def passes no `className`, so header and cells fall through to the default left alignment (`components/shared/VirtualDataTable.tsx:594,736` applies `col.className` to both — the mechanism exists); same omission in `pages/OwesPage.tsx:438-448`. The digits are tabular (via `Money`), but left-aligned varying-width amounts never form a column — magnitudes can't be compared at a glance, the core reading task of a finance table. The app already knows the rule: `pages/DashboardPage.tsx:293` (recent-transactions widget) and `pages/RecipientInsightsPage.tsx:99-124` set `className: "text-right"`, and the StocksPage holdings table right-aligns every numeric `<td>` (`pages/portfolio/StocksPage.tsx:306-380`).
  - Fix: `className: "text-right"` on the amount coldefs (TransactionsTable, OwesPage) — and make `type: "number"` columns default to right alignment in VirtualDataTable/DataTable so the next table can't forget.

- [ ] **Three sign dialects for the same minus: ASCII hyphen "-" on the most-viewed money surfaces, true "−" on a few, and `Money`'s own Intl `signDisplay` used exactly once** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S3_
  - Hyphen-as-minus concatenated by hand at `apps/frontend/src/features/transactions/components/TransactionsTable.tsx:230`, `features/transactions/components/TransactionQuickLook.tsx:48` (the 4xl hero amount), `features/transactions/components/TransactionInfoDialog.tsx:145`, `pages/DashboardPage.tsx:296`, `pages/OwesPage.tsx:445` — while `components/planned/ExecutionHistoryDialog.tsx:152`, `components/planned/LinkTransactionDialog.tsx:261`, `components/charts/scrub.tsx:46-52` (also "±") and `components/shared/CommandPalette.tsx:346` use the true U+2212. Meanwhile `components/shared/Money.tsx:36` already does this right (`signDisplay: "exceptZero"` → locale-correct glyph, sign inside the tabular `whitespace-nowrap` span) but has one consumer (`pages/PlannedPaymentsPage.tsx:477`); everywhere else the sign is a separate text node outside Money's span — wrong glyph, wrong font context, and it can line-wrap away from its number.
  - Fix: sweep the five `amount >= 0 ? '+' : '-'` sites (grep hits exactly this pattern) to `<Money signed amount={row.amount}/>` (drop the `Math.abs`); rule: sign glyphs never hand-concatenated — they come from Intl or a shared formatter.

- [ ] **The app designed an Apple-Wallet money treatment (`Money`: raised small symbol, de-emphasized cents) — then 29 files with 60 raw `formatCurrency()` strings bypass it, including every hero number** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S3_
  - `apps/frontend/src/components/shared/Money.tsx:44-61` renders symbol at 0.85em/raised and decimals at 0.88em/75% via `formatToParts` — genuinely crafted micro-typography. Adoption: 34 uses in 13 files vs 60 plain `formatCurrency(` calls in 29 files (grep `--include=*.tsx`). The bypassers are the *flagship* numbers: `components/dashboard/NetSummaryCard.tsx:62,89` (the 5xl dashboard net, via `formatCompact`→`RollingNumber` plain string), `components/dashboard/StatCard.tsx:53`, `pages/portfolio/StocksPage.tsx:216-289` stat tiles (`fmt()`), `pages/portfolio/net-worth/NetWorthPage.tsx:361-370` peak/trough, `components/portfolio/TotalValueCard.tsx`, plus ~10 local `const fmt = useCurrencyFormatter(...)` per-page helpers. Net effect: the crafted treatment shows on secondary rows while heroes render full-size "€" and full-weight cents — hierarchy inverted.
  - Fix: adopt `Money` on stat tiles/detail dialogs; for the two `RollingNumber` heroes, make RollingNumber parts-aware (accept `Intl.formatToParts` output so symbol/decimals keep the Money treatment inside the odometer) — raw strings stay only for chart axes/ticks.

- [ ] **Four stat-tile anatomies for one role — and the genuinely designed one (StatCard) has 3 app consumers while ~30 tiles are hand-rolled, including the verbatim shadcn-example anatomy** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4_
  - `apps/frontend/src/components/dashboard/StatCard.tsx` (RollingNumber odometer + DeltaPill + TrendHue — the crafted tile) is used by exactly 3 pages (`pages/DashboardPage.tsx:411-417`, `pages/DbMaintenancePage.tsx:193-198`, `pages/portfolio/net-worth/NetWorthPage.tsx:239-274`). Beside it: **dialect B** = the shadcn dashboard-example anatomy verbatim (`CardHeader flex flex-row items-center justify-between pb-2` + `CardTitle text-sm font-medium text-muted-foreground` + bare `h-4 w-4` icon right + `text-2xl font-bold` + `text-xs` desc) hand-built in 8 files (`pages/TaxOverviewPage.tsx:452-462`, `pages/portfolio/PortfolioOverviewPage.tsx:300-313`, `pages/portfolio/PerformancePage.tsx:446-449`, `pages/RecipientInsightsPage.tsx` ×3, `pages/portfolio/net-worth/NetWorthPage.tsx` ×3, `components/statistics/RecipientInsightsTab.tsx` ×3, `pages/portfolio/tax/TaxSummaryCard.tsx`) — the single most recognizable template composition on the internet; **dialect C** = icon-chip-in-title (`inline-flex h-6 w-6 … rounded-md bg-gradient-to-br` chip inside CardTitle, 12 pastes across `pages/portfolio/StocksPage.tsx:205-294`, `CryptoPage.tsx:124-189`, `SavingsPage.tsx:97-160`, `RealEstatePage.tsx:112+`, `pages/PlannedPaymentsPage.tsx:446-492`, h-7 variant in `components/statistics/SummaryCards.tsx:60-70`); **dialect D** = `PortfolioForecastPage.tsx:223-246`'s local `SummaryCard`. Within-row proof it's paste not intent: StocksPage tiles 1–3 get icon chips, tiles 4–6 (`:262-293`) don't; PlannedPaymentsPage tile 1 "Pending" (`:446-453`) is bare while tiles 2–4 get chips. *(A4 filed the asset-pages code duplication; S2/S3 filed the glass classes and CardTitle type — this is the missing composition ruling.)*
  - Fix: crown StatCard as *the* stat tile — add cva variants it demonstrably needs (`size: default|compact` for the dense 5–6-up portfolio rows, optional icon chip vs icon-right slot, `hint` line), then sweep dialects B/C/D onto it. One anatomy, page-specific *content*; the odometer/DeltaPill character every tile currently lacks comes free.

- [ ] **Statistics, Planned, Performance and Forecast all open with the identical [PageHeader → 4-stat grid → big card] scaffold — and two of the stat slots are filler minted to complete the grid** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4_
  - `pages/StatisticsPage.tsx:84` + `components/statistics/SummaryCards.tsx:59`, `pages/PlannedPaymentsPage.tsx:445`, `pages/portfolio/PerformancePage.tsx:218`, `pages/research/PortfolioForecastPage.tsx:222` — same `sm:grid-cols-2 lg:grid-cols-4` opening; even the loading skeletons hardcode the template (`[...Array(4)]` cards at `PlannedPaymentsPage.tsx:394-401`, `StatisticsPage.tsx:85-91`). Filler tells: Statistics' 4th tile is "Months tracked" (`SummaryCards.tsx:49` — metadata, desc "N years", icon BarChart3 = the page's own icon) and its first three (income/spending/net) restate the dashboard hero row the user just left; Dashboard's own 4th StatCard is "Total transactions" (`DashboardPage.tsx:417`) — a DB row count among money. Swap any two of these pages' openings and nothing breaks — the definition of interchangeable scaffold.
  - Fix: make each opening earn its stats — Statistics: drop the dashboard-duplicate row and lead with the monthly-trends story (its actual content); Planned: replace the count tiles ("Pending: 7") with a *next-7-days strip* (the one thing a bills page is for — due items on a mini timeline, amount + day), keeping est-monthly as a single side figure; Forecast's four are genuinely content-derived (p50/return/vol/prob-target) — keep, just re-anatomy per finding 1.

- [ ] **TaxOverviewPage is composed as a generic KPI dashboard when its content is a year-document — the one page with a real-world document metaphor ignores it** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4_
  - `pages/TaxOverviewPage.tsx:360-464` — PageHeader → three key-value *badges* (`:389-391` "Region: X", "Marginal rate: 50%", "Effective burden: 32.1%" as outline Badge chips — facts dressed as status chips, decoration not semantics) → banner → info card → 3 generic stat cards (`:450-463`, shadcn dialect) → parallel 2-col breakdown cards (`:466+`). The year's identity is scattered across TaxYearSwitcher, the badges, and HistoricalYearBanner. A Belgian tax year has a native composition the page never uses: the assessment notice (aanslagbiljet) — a top-to-bottom computation. *(A4 filed the 700-line decomposition; this is the layout direction to decompose toward.)*
  - Fix: give the page a *filing-year masthead* (big Fraunces year + region + status: estimate/frozen/filed + effective burden as the single hero figure — absorbing the three badges and banner) and present the computation as one connected flow (gross → deductions → PIT → municipal → net) reading downward like the document it models, instead of parallel same-weight cards. More specific, more character, zero flattening.

- [ ] **Every route entrance is double-animated — PageTransition and page-root `.animate-in` slide the same content on the same axis with different physics (dashboard: triple)** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S5_
  - `apps/frontend/src/components/layout/PageTransition.tsx:24-33` (framer: y:14→0, scale .995, 520ms, outExpo `[0.16,1,0.3,1]`) wraps every route — but 15 pages *also* put the CSS `.animate-in` (`index.css:798-812`: y:10→0, scale .992, 420ms, `--ease-out-quint`) on their root div (29 sites: `pages/TransactionsPage.tsx:361,380,393`, `StatisticsPage.tsx:82-142`, `RecipientsPage.tsx:314-378`, `ImportReviewPage.tsx:271`, all 6 research pages…). Result: ~24px of travel from two concurrent, differently-eased, differently-timed slides — the mushy "everything drifts" feel of stacked defaults. `pages/DashboardPage.tsx:365+401` nests a third layer (`animate-stagger` children each replay `animate-in`). Meanwhile TaxOverview, Accounts, RecipientInsights, AIChat, and every portfolio page have *no* root class — so the app has two entrance dialects assigned at random.
  - Fix: one owner per axis — PageTransition is the page-level move; strip `.animate-in` from page roots (keep it for *conditionally appearing* in-page content like `EmptyState.tsx:12`), and let at most ONE featured grid per page stagger inside the single page entrance.

- [ ] **The easing tokens are a facade: `--ease-out-expo` and `--ease-out-quint` are the *same curve* in CSS, and Framer uses two different real curves under the same names — physics forks by implementation layer** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S5_
  - `apps/frontend/src/styles/tokens.css:115-117` — both tokens = `cubic-bezier(0.32, 0.72, 0, 1)` (which is actually Apple's sheet easing, neither expo nor quint). `lib/motion.ts:13-18` — despite its docstring "Mirrors CSS duration/easing tokens in styles/tokens.css", defines the *true* curves: outExpo `[0.16,1,0.3,1]`, outQuint `[0.22,1,0.36,1]`. Consumers split ~50/50: 30 tsx sites use `ease-[var(--ease-out-expo)]`, every `index.css` utility uses quint (same thing), while charts/tabs/sidebar/PageTransition run the framer values — so a card hover, a tab-pill move, and a chart draw each decelerate on a different curve while claiming one system.
  - Fix: one curve table, two names max (e.g. keep `0.32,0.72,0,1` as an honestly-named `--ease-glide` for hovers, real out-expo for entrances); make `lib/motion.ts` and `tokens.css` read from the same source (or add a test asserting equality) and delete the duplicate alias.

- [ ] **Nothing in the app responds to press except Button — every clickable card/tile/row is hover-alive but click-dead** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S5_
  - `.press-feedback` (`index.css:730-736`, scale .97/90ms) has exactly one consumer (`components/ui/button.tsx:8`); repo-wide `active:scale` = 0 hits, framer `whileTap` = 0 hits, and `lib/motion.ts`'s `microLift`/`pressFeedback` tap variants are unused. So the interactive cards that hover-lift with full character — `pages/research/WatchlistPage.tsx:166`, `ResearchHomePage.tsx:308`, `MarketOverviewPage.tsx:1015`, onboarding option tiles `components/onboarding/OnboardingWizard.tsx:323,412,469`, sidebar items, clickable table rows — give zero acknowledgment at the moment of commitment. Hover-only life is the "demo reel" tell; press response is what makes UI feel physical.
  - Fix: one press physics app-wide — anything that lifts on hover settles on press: add `.press-feedback` (or `active:translate-y-0 active:scale-[0.98]`) to the interactive-Card variant S2 proposed, list rows, and tile buttons; Button already models the pattern (`hover:-translate-y-px` + `active:translate-y-0` + scale).

- [ ] **The browser tab shows Lovable-template scrap while a genuinely crafted brand mark sits unused in packaging** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S6_
  - `apps/frontend/index.html` — no `<link rel="icon">` at all, no `theme-color` meta; the browser falls back to `apps/frontend/public/favicon.ico`, which is a 73×74 PNG masquerading as .ico (template leftover, dated with the scaffold), next to a dead `public/placeholder.svg` (the stock Lovable placeholder, 0 references in src). Meanwhile `packaging/electron/build/icon.svg` is a *designed* mark — obsidian glass body, emerald→champagne gradient, aurora washes, its comments even name the app's glass tokens — and it never reaches the web surface.
  - Fix: export the mark from `icon.svg` as `favicon.svg` (+ PNG fallbacks) and add `<link rel="icon" type="image/svg+xml">` + apple-touch-icon + a light/dark `theme-color` pair to index.html; delete `placeholder.svg` and the stale favicon.ico. (Per-route `document.title` is Wave U3's finding at TODO ~line 756 — land the title scheme there, not here.)

- [ ] **The app's logo appears nowhere inside the app — every identity surface improvises with the lucide `Wallet` glyph or nothing** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S6_
  - `apps/frontend/src/components/layout/AppSidebar.tsx:221-222` — the sidebar "logo" tile is generic `Wallet` in a primary→accent gradient; `components/onboarding/OnboardingWizard.tsx:222,224` repeats the same Wallet-tile + plain `font-bold` "Vision" (not even `font-display`) as the wizard's brand header; and the *same Wallet glyph* is simultaneously every bank-adapter tile two steps later (`OnboardingWizard.tsx:329`) — the brand icon and a checkbox-list icon are the same drawing. The Electron splash (`packaging/electron/main.js:1409-1411`) and boot-error page (`packaging/electron/assets/error.html`) show no mark at all, and `pages/NotFound.tsx:20-22` uses generic `FileQuestion`. One crafted identity exists (`packaging/electron/build/icon.svg`) and zero product surfaces render it.
  - Fix: a small `<VisionMark />` SVG component (the emerald/champagne mark from icon.svg, currentColor-able) used at the identity moments — sidebar tile, onboarding header, splash, boot-error page, 404 — freeing `Wallet` to mean "bank/account" exclusively.

- [ ] **The first-run wizard is the least on-brand surface in the app — none of the aurora/glass/Fraunces language survives into the moment that sets expectations** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S6_
  - `apps/frontend/src/components/onboarding/OnboardingWizard.tsx` — all seven step headings are `text-2xl/text-xl font-bold` (`:255,279,311,345,386,461,488`), the only headings in the app that skip `font-display`; the welcome hero is a generic `Sparkles` in a flat `from-primary to-primary/60` tile with `shadow-lg` (`:252-254`) — no glass tile, no aurora halo (compare `components/shared/EmptyState.tsx:14-17`, which gives a *routine* empty list more atmosphere than the app's first screen gets); step content is plain borders and `bg-muted/30` throughout; and the bank-picker grid renders every bank as the identical Wallet icon (`:329`) — six tiles, one face. Copy is S1's, finish-motion is S5's — this is the composition: a competent generic wizard where the app's one guaranteed first impression should be its most Vision-looking surface.
  - Fix: welcome step becomes the brand moment — VisionMark in a glass tile with the EmptyState aurora halo, Fraunces title, and `font-display` on all step headings (they're h2s; the app's own rule is Fraunces for h1–h3); give bank tiles a monogram treatment (two-letter initial in the bank's slot) so the grid reads as choices, not clones.

- [ ] **CsvDropzone file picking is impossible by keyboard on every import surface** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - `apps/frontend/src/features/imports/CsvDropzone.tsx:48-70` — the click target is a plain `<div onClick>` with no `role`, no `tabIndex`, no keydown handler, and the real `<input type="file">` is `className="hidden"` (display:none → unfocusable). Once a file is selected the Remove button is reachable, but *selecting* one never is.
  - Affects keyboard-only and switch users on all four import surfaces (transactions, portfolio, recipients, categories) — the CSV import flow cannot be started at all.
  - Fix: make the dropzone a real `<button type="button">` (or add `role="button" tabIndex={0}` + Enter/Space → `inputRef.current?.click()`), or swap the hidden input for a visually-hidden-but-focusable input/label pair.

- [ ] **TagInput trigger is not keyboard-focusable — tags can't be added without a mouse** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - `apps/frontend/src/components/shared/TagInput.tsx:156-173` — `PopoverTrigger asChild` wraps a `<div role="combobox">` with `onClick` only; Radix merges aria/click props onto the child but does not add focusability, and the div has no `tabIndex`/keydown. Chip *remove* buttons are focusable, so a keyboard user can delete tags but never add one.
  - Affects every surface embedding TagInput (transaction dialogs etc.).
  - Fix: give the trigger `tabIndex={0}` + Enter/Space-to-open (or render it as a button styled like an input); bonus: the swatch `aria-label`s at `TagInput.tsx:226` are raw `hsl(...)` strings — give them color names.

- [ ] **Hover-revealed action buttons are fully invisible when keyboard-focused (opacity-0 hides the focus ring too)** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - Systemic `opacity-0 group-hover:opacity-100` on focusable controls with no `focus-visible:opacity-100`/`group-focus-within:opacity-100`: `pages/portfolio/StocksPage.tsx:380` and `pages/portfolio/CryptoPage.tsx:285` (view/add-txn/**delete** row actions), `features/ai-chat/ChatConversationList.tsx:140` (conversation menu), `components/shared/AttachmentPanel.tsx:74` (attachment delete), `components/shared/VirtualDataTable.tsx:622` + `components/shared/DataTable.tsx:435` (column-filter buttons).
  - Sighted keyboard users tab onto invisible buttons — focus indicator disappears entirely (WCAG 2.4.7 fail), and one of the hidden controls is a destructive delete.
  - Fix: add `focus-visible:opacity-100 group-focus-within:opacity-100` wherever `opacity-0 group-hover:opacity-100` sits on (or wraps) an interactive element.

- [ ] **Comma-as-decimal entry only works in Add Transaction — the other 71 numeric inputs (25 files) are `type="number"` and reject "12,50"** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2_
  - `components/forms/AddTransactionDialog.tsx:108` does it right (`type="text" inputMode="decimal" pattern` accepting `[.,]` + `parseLocaleNumber`), but every other money field is `type="number"`: `components/planned/PlannedPaymentForm.tsx:145,232,236`, `components/splits/SplitTransactionDialog.tsx:192-198`, `features/accounts/AddAccountDialog.tsx:269`, `components/tax/profile-steps/IncomeStep.tsx:43-129` + `ExemptionsStep.tsx:128-202`, `components/portfolio/AddPortfolioTxnDialog.tsx:212-266`, `components/portfolio/AddToWatchlistDialog.tsx:276-284`, `features/portfolio/MoveHoldingDialog.tsx:96` (adding `inputMode="decimal"` doesn't help). `index.html:2` hardcodes `lang="en"` and nothing updates `documentElement.lang` (grep), so browsers parse number inputs as en (dot-only) even in the nl UI: typing "12,50" yields an empty/invalid value, and the comma support in `lib/decimal.ts` `parseDecimal` is unreachable dead code behind these inputs.
  - Affects the primary audience (Belgian users, comma-decimal habit) in planned payments, splits, portfolio, tax profile, accounts — the amount silently fails to register or drops the decimal part.
  - Fix: adopt the AddTransactionDialog pattern (`type="text" inputMode="decimal"` + `parseDecimal`) for all money fields; also set `document.documentElement.lang` from the active locale.

- [ ] **Seven dialogs wipe all typed input on ANY close — a stray outside-click or Escape destroys the work, and no dialog anywhere has an unsaved-changes guard** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2_
  - Reset-on-close: `components/portfolio/AddPortfolioTxnDialog.tsx:156`, `AddInvestmentFromMarketDialog.tsx:174`, `EditInvestmentDialog.tsx:123`, `EditPortfolioTxnDialog.tsx:169`, `features/portfolio/MoveHoldingDialog.tsx:66`, `features/recipients/MergeRecipientsDialog.tsx:81`, `features/transactions/components/bulk/BulkTagDialog.tsx:45` — all call `reset()` in `onOpenChange(false)`, which Radix fires on overlay click and Escape. Repo-wide there are zero `onInteractOutside`/`onEscapeKeyDown`/`beforeunload` guards and zero "unsaved changes" confirms (grep); `hooks/useFormState.ts:35-67` even ships an `isDirty` flag but has zero consumers.
  - Worst case is AddPortfolioTxnDialog (~10 fields: units, price, fees, taxes, date, account, recurrence); a mis-click next to the dialog erases everything with no recovery.
  - Fix: when dirty, `event.preventDefault()` in `onInteractOutside`/`onEscapeKeyDown` and ask via the existing `useConfirmDialog`; or minimally stop resetting on dismissal (reset only on success/Cancel, as AddTransactionDialog and PlannedPaymentForm already do by staying mounted).

- [ ] **No per-route document.title — every page, history entry and bookmark is "Vision - Financial Management"** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3_
  - `apps/frontend/index.html:7` is the only title in the app; repo-wide grep finds zero `document.title` writes, no title hook, no react-helmet.
  - Back-button dropdown, browser history, bookmarks, and multiple open tabs are all indistinguishable; screen-reader users get no page announcement on SPA navigation either.
  - Fix: small `useEffect` in `AppLayout` (or a `useDocumentTitle` hook) mapping `location.pathname` to the localized nav label (the sidebar already has the route→label table) — `document.title = \`${pageName} · Vision\``.

- [ ] **ScrollToTop fires on back/forward too — list scroll position is never restored** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3_
  - `apps/frontend/src/components/shared/ScrollToTop.tsx:7-9` — `window.scrollTo(0)` on every `pathname` change with no `useNavigationType()` guard; the window is the app's real scroller (`AppLayout.tsx:217` plain `<main>`, window scroll listeners at `AppLayout.tsx:84-88`), so this also overrides the browser's native POP restoration.
  - Drill from a long transactions/recipients list into any page and press Back → you land at the top and must re-scroll (and re-load, for infinite-scroll lists) to find your row. Affects every back navigation in the app.
  - Fix: `const navType = useNavigationType();` and skip the scroll when `navType === "POP"` (browser restoration then works for same-height pages), or move to react-router's `<ScrollRestoration>`.

- [ ] **Market Lookup: picking a symbol never updates the URL, and a stale `?investmentId=` keeps serving the OLD holding's data** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3_
  - `apps/frontend/src/pages/research/MarketLookupPage.tsx:241-244` — `handleSelect` only does `setSelectedSymbol(symbol)`; `:158-159` `effectiveSelectedSymbol = selectedSymbol || symbolFromQuery`; `:167` `investmentId` is read fresh from the URL every render and is never cleared on select; `:181` `useYahoo = !!effectiveSelectedSymbol && !isProviderAsset && …`.
  - Two user-facing effects: (a) after searching a symbol, reload/share/bookmark reverts to the previous URL symbol (or blank) — the looked-up view is unshareable; (b) arrive via a non-Yahoo holding deep-link (`?symbol=X&investmentId=N`, Kinesis/custom/binance) then search any other symbol → `isProviderAsset` stays true, Yahoo is never queried, and the chart/quote shown under the NEW symbol's name is the OLD holding's price history.
  - Fix: in `handleSelect`, `setSearchParams({ symbol })` (dropping `investmentId`) instead of local state; derive selection from the URL only.

- [ ] **Transactions: every new search/filter/sort combination replaces the ENTIRE page — including the search box being typed in — with a skeleton** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U4_
  - `apps/frontend/src/features/transactions/hooks/useTransactionListData.ts:79-123` — the `'transactions-virtual'` queryKey embeds search + all ten filters + sort and has **no `placeholderData`**, so any not-yet-cached combination flips `isLoading` true; `pages/TransactionsPage.tsx:359-376` then early-returns a full-page skeleton (no filter banner, no table, no search input). The search input lives inside the table (`components/shared/VirtualDataTable.tsx:133-175`, debounced), so it unmounts mid-typing — focus and keystrokes typed during the fetch are lost, and typing a longer term with a pause re-blanks the page at each debounce boundary. `handleSortChange` additionally hard-clears the rows (`useTransactionListData.ts:191-201`). The sibling plain-list query already does this right (`hooks/useTransactions.ts:36` `placeholderData: (prev) => prev`).
  - Affects the app's most-used page on every search pause and every first use of a filter (URL quick-filters included).
  - Fix: add `placeholderData: (prev) => prev` to the virtual query, reserve the skeleton for the true no-data-yet first load, show a slim inline `isFetching` indicator instead, and stop clearing rows in `handleSortChange`.

- [ ] **Double-click is the only pointer path into ~10 drill-down/edit surfaces — dead on touch, and the context-menu fallback is also dead on iOS** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U6_
  - `components/shared/VirtualDataTable.tsx:708-714` (row open + inline-edit entry are `onDoubleClick`; touch alternative is the Radix ContextMenu at `:806`, but iOS Safari never fires `contextmenu` on long-press), `components/dashboard/BankBalancesWidget.tsx:185`, `pages/AccountsPage.tsx:133`, `pages/OwesPage.tsx:232`, `pages/CategoriesPage.tsx:204` (fallback is keyboard-only `onActivateKeyDown`), `pages/research/WatchlistPage.tsx:169`, `pages/DbMaintenancePage.tsx:82`, `pages/portfolio/StocksPage.tsx:327`, `pages/portfolio/CryptoPage.tsx:240`, `components/portfolio/InvestmentDetailDialog.tsx:164`. Mobile browsers consume double-tap as the zoom gesture (viewport is user-scalable and no element sets `touch-action: manipulation` — grep: zero occurrences), so `dblclick` rarely fires on tablets/phones. Two sites DO have a tap path (TransactionsTable's always-visible Info button `features/transactions/components/TransactionsTable.tsx:249-257`; AccountsPage's per-card dropdown menu `:169-180`) — the other eight have none: on an iPad you cannot open a watchlist chart, a category drill-down, a holding's market lookup, a bank-card's transactions, or start an inline table edit at all.
  - Affects every tablet/phone LAN user on core drill-down flows; U1 filed the keyboard angle of BankBalancesWidget — this is the systemic touch angle.
  - Fix: give each dblclick surface a single-tap activation for coarse pointers (`matchMedia('(pointer: coarse)')` → treat single click as open) or an always-visible button like TransactionsTable's Info column; if dblclick is kept, add `touch-action: manipulation` on the rows so double-tap can reach the handler on Android at least.

- [ ] **Scrubbable charts set `touch-action: none` over the entire plot — 320-380px-tall scroll traps on the dashboard, Net Worth and Performance pages for touch users** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U6_
  - `components/charts/AreaChart.tsx:515` and `components/charts/LineChart.tsx:432` — the full-plot hover-capture `<rect>` gets `style={{ touchAction: "none" }}` whenever `scrubbable`; consumers: dashboard forecast `components/dashboard/ForecastInner.tsx:49-54` (height 320) + `ForecastInnerRolling.tsx:74`, `pages/portfolio/net-worth/NetWorthChart.tsx:82-91` (height 380), `pages/portfolio/PerformancePage.tsx:303,343`, `components/dashboard/BankBalancesWidget.tsx:227`. With `touch-action:none` a finger landing on the chart can never pan the page — on a tablet the dashboard scroll "sticks" whenever the swipe starts on the forecast card.
  - The repo already has the correct pattern one file over: `components/dashboard/NetSummaryCard.tsx:132` uses `touchAction: "pan-y"` for its pointer-event scrub, keeping vertical page panning alive while horizontal scrubs still work.
  - Fix: change the scrubbable rects to `touchAction: "pan-y"` (matching NetSummaryCard), or only suppress panning after `pointerdown` + `setPointerCapture` while a scrub drag is actually in progress.

- [ ] **Tax Overview page conflates "loading" with "no data" — shows a false empty-state CTA** ⏫ 🔧 *(citation corrected)*
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `apps/frontend/src/pages/TaxOverviewPage.tsx:578` (`monthlyIncomeTax.length === 0`) and `:705` (`yearlyIncome.length === 0`)
  - These branches derive from `stats.data?.categoryPivot` and render "no income tracked, add some" whenever the data is `undefined` — true during the initial fetch, not just when genuinely empty, because `stats.isLoading` (from `useStatistics()`) is never read anywhere in this file. A user on a slow connection briefly sees a misleading CTA before real numbers load.
  - Fix: gate on `stats.isLoading` with a skeleton before falling through to the real empty/error checks.
  - Verification (2026-06-30): the originally-cited lines (`:562-573`/`:689-700`) were the wrong branch — those render an unrelated CTA gated by a tax-*profile* income-sources setting, not by fetch timing. Corrected to the actual loading-conflated-with-empty branches above.

- [ ] **Transaction table header and data desync on horizontal scroll** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `apps/frontend/src/components/shared/VirtualDataTable.tsx:578` (header) and `:663-665` (body) — two independent scroll containers, no synchronization
  - Fixed pixel column widths mean any viewport narrower than total column width (phone, or a narrowed desktop window) lets the body scroll horizontally while headers stay put, in the app's most-used view.
  - Fix: drive both containers from one shared scroll position (shared ref + synced `scrollLeft`, or one wrapping scrollable element).

- [ ] **Portfolio buy/sell/dividend dialogs have no pending-state guard — double-submit risk on money-affecting actions** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `AddPortfolioTxnDialog.tsx:315`, `AddInvestmentDialog.tsx`, `EditInvestmentDialog.tsx`, `EditPortfolioTxnDialog.tsx`, `AddInvestmentFromMarketDialog.tsx` (two-step flow, both buttons)
  - All five submit buttons lack `disabled`/`isPending` wiring — a double-click/double-Enter before the mutation resolves can fire two buy/sell/dividend transactions; the underlying hooks don't even expose `isPending` today. `AddTransactionDialog.tsx` already does this correctly for regular transactions.
  - Fix: apply the same `disabled={mutation.isPending}` + spinner pattern to all five dialogs.

- [ ] **Attachment delete has zero confirmation step** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `apps/frontend/src/components/shared/AttachmentPanel.tsx:130-133`
  - `handleDelete` calls `mutate(id)` directly — every other delete flow checked (Accounts, Recipients, Planned Payments, Categories) confirms first via `useConfirmDialog`.
  - Fix: wrap in the existing `useConfirmDialog` pattern.

- [ ] **Form validation errors are toast-only — the one accessible field-association primitive in the codebase is fully dead code, used nowhere** ⏫ 🔧 *(worse than originally reported)*
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `toast.error(...)` is used for validation in 59 files (not "40+"); `aria-invalid`/`aria-describedby` wiring exists in exactly one primitive (`components/ui/form.tsx:93-94`), and **zero files import `Form`/`FormField`/`FormControl` from it** — `react-hook-form`, which the primitive depends on, isn't used anywhere else in the app. A screen-reader user who misses the transient toast has no way to discover which field failed, anywhere in the app.
  - Fix: route field-level errors through the existing `Form`/`FormField`/`FormMessage` primitives, starting with Add/Edit Transaction and Planned Payment.

- [ ] **Most (not all) loading states have no screen-reader announcement — a correct pattern exists but is under-adopted** ⏫ 🔧 *(corrected — not literally zero occurrences)*
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - A working pattern already exists: `SectionLoader.tsx:11` has `role="status" aria-busy="true" aria-label="Loading"`, which correctly gets an implicit `aria-live="polite"` — but it's used in only ~11 files. 36 other files import the bare `Skeleton` primitive (`components/ui/skeleton.tsx`) directly, which carries no ARIA attributes at all, so most (not all) loading states are silent to screen readers.
  - Fix: migrate the 36 bare-`Skeleton` call sites to wrap in `SectionLoader` (or equivalent), or add the status-wrapper behavior to `Skeleton` itself so it's the default rather than opt-in.

- [ ] **Shared `PageHeader` doesn't wrap at narrow widths — clips the primary action button / forces an ugly multi-line title** ⏫
  - ↪ _from: UI clutter review 2026-07-01 · Real issues_
  - `apps/frontend/src/components/shared/PageHeader.tsx:24` (outer `flex items-start justify-between gap-4`, **no `flex-wrap`**) + `:36` (actions block is `flex items-center gap-2 shrink-0` — can't shrink or wrap). One shared component imported by ~30 pages, so this is systemic, not per-page.
  - At tablet width (≤~768px) the title + actions stay on one non-wrapping row: **Portfolio Overview** (4 actions: Export PDF / Widgets / Refresh Prices / Add Investment) pushes the primary **"+ Add Investment" button off the right edge (clipped)**; **Tax** (3 actions + long title) squeezes "Belgian Personal Tax Overview" into a **4-line, one-word-per-line wrap**. Observed on both; any page with several/long actions is affected.
  - Fix: let the header wrap or stack — e.g. `flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between` on `:24` (and/or `flex-wrap` on the actions at `:36`) so actions drop below the title under `sm`/`md`. One change fixes all ~30 pages.

- [ ] **19 validation/error strings open with "Please …" boilerplate — the Dutch versions already prove the plain-imperative register works** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json` — grep `'"[^"]*Please '` → 19: `importPage.toast.noBank`:1017 "Please select a bank source.", `.noConfig`:1018, `.noFile`:1019, `.noFileSel`:1020, `import.bankRequired`:883, `import.fileRequired`:891, `plannedForm.requiredFieldsHint`:1647 "Please fill in all required fields (Name, Amount, Due Date, Bank Account)", `plannedPage.link.selectTx`:1710, `settings.backup.noDir`:2490, `networth.tryAgain`:1296 "Please try again later.", `common.errorBoundaryDetail`:518, etc. nl.json already drops the courtesy filler (`nl.json:883` "Selecteer eerst een bank voordat u importeert") — the English is the odd one out.
  - Fix: drop "Please" and state the requirement/action: "Select a bank before importing", "Choose a backup directory first", "Fill in Name, Amount, and Due Date". Rule for docs: imperatives, no courtesy padding.

- [ ] **Fallback errors are vague where the app already knows better: "Something went wrong" heads every failed portfolio page** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json:516` `common.error` "Something went wrong" is the `<h3>` of `components/shared/PageError.tsx:17` (used by SavingsPage:60, RealEstatePage:75, StocksPage:162, CryptoPage:81 — the detail line only shows if `error.message` exists); `:517` `common.errorBoundary` "Something went wrong in this section."; `:518` "An unexpected error occurred. Please reload the page."; `importPage.failed`:970 "Import failed. Please try again." (no reason, though the parser knows it). Contrast the house-quality error the app is capable of: `app.errorPageMessage`:305 "Vision couldn't reach its backend. Try again, or check the logs to see what happened." and `csvHeaders.unreadable`:579 "Couldn't read columns -- is this a CSV file?".
  - Fix: give PageError a per-surface subject ("Couldn't load your portfolio") via a `title` prop defaulting to a rewritten `common.error` = "Couldn't load this page"; error strings name the thing that failed + one next step, never bare "Something went wrong".

- [ ] **Two user-facing errors tell the user to "check console" — developer voice leaking into product copy** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json:1725` `plannedPage.saveFailed` "Failed to save payment. Please check console for details." and `:1701` `plannedPage.link.executeFailed` "Failed to execute planned payment. Check console for details." A power user is not a devtools user; 28 other strings already interpolate the real server reason via `{msg}`.
  - Fix: adopt the `{msg}` pattern here ("Couldn't save the payment: {msg}") and reserve console-speak for the devtools panels.

- [ ] **Success-toast register drift: "…successfully!" vs calm past-tense — the same export action toasts two different personalities** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json:1014` `importPage.toast.exportSuccess` "Transactions exported successfully!" vs `:3451` `txPage.toast.exportSuccess` "Transactions exported" — identical action, two voices. `:1016` `importPage.toast.importSuccess` "Successfully imported {n} transactions! {dups} duplicates skipped, {total} total processed" leads with the adverb and dumps stats; `merge.success`:1207 "Recipients merged successfully", `split.success`:2682 "Transaction split successfully". The established house style is object-first past tense with no adverb: "Transaction added" (:865), "{type} recorded for {name}" (:184), "Updated {n} transactions" (:3405).
  - Fix: sweep "successfully" (5 hits) and toast "!" to the house pattern — "Imported {n} transactions ({dups} duplicates skipped)", "Recipients merged", "Transaction split".

- [ ] **Create-flow verb drift: dialog says "Add", button says "Save" or "Create", toast says "added" or "created"** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json` — Add Transaction flow: title "Add Transaction":880 → button "Save":879 → toast "Transaction added":865 (three verbs, one flow); same Save-button pattern at `form.addCategory.save`:855 and `form.addRecipient.save`:862. Meanwhile `addInv.title`:153 "Add Investment" → button "Create":92; and categories has both "Category added":393 and "Category created":397 for creation.
  - Fix: one verb per flow — button repeats the dialog verb ("Add transaction" → toast "Transaction added"); reserve "Save"/"Save changes" for edit mode (the keys already split add/edit: `editTitle`/`updateSuccess`).

- [ ] **Class-soup: 119 call sites re-add `glass-regular` and 47 re-add `premium-frame` that Card already applies — intent signal lost** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - `apps/frontend/src/components/ui/card.tsx:9` already includes both, yet `grep -rn 'Card className="[^"]*glass-regular'` → 119 and `premium-frame` → 47 (e.g. `components/dashboard/CategoryPieChart.tsx:77`, `dashboard/MonthlyTrendsChart.tsx:152`, `dashboard/BankBalancesWidget.tsx:64,84,154`, `statistics/RecipientInsightsTab.tsx:184-223`). When every card restates its material, a reader (or the next agent) can't tell which surfaces were *deliberately* promoted — the exact patchwork feel this research targets, and a divergence trap if the base ever changes.
  - Fix: mechanical sweep deleting redundant `glass-regular`/`premium-frame`/`micro-lift` from Card call sites; after the sweep, an explicit material class on a Card means "intentional override" again.

- [ ] **SankeyChart ships its own 12-color ad-hoc palette outside the chart token system** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - `apps/frontend/src/components/statistics/SankeyChart.tsx:27-42` — `NODE_COLORS` hardcodes 12 `hsl(220 70% 50%)`-style mid-lightness hues (generic evenly-spaced wheel, not the jewel family), sandwiched between two token entries (`--primary`, `--muted-foreground`). Fixed ~50% lightness in both modes: reads muddy against dark glass, loud against light, and ignores theme variants — visibly "a different app" next to token-colored charts on the same statistics page.
  - Fix: cycle `CHART_TOKEN_COLORS` from `components/charts/palette.ts` (repeat with opacity steps if 12+ distinct nodes are needed), keeping `--primary` for the root node.

- [ ] **"Warning" is improvised as raw amber/yellow in ~6 files although the `--warning` token exists and is used 74×** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - `apps/frontend/src/features/accounts/MergeAccountDialog.tsx:74` `text-amber-600 dark:text-amber-500`; `components/research/ResearchAnalystTab.tsx:21,62` `text-yellow-500 dark:text-yellow-400` + `:78` `bg-yellow-400` (hold-verdict bar); `pages/portfolio/RebalancePage.tsx:282` `text-amber-600 dark:text-amber-500`; `pages/DbMaintenancePage.tsx:90` `text-yellow-600` (no dark variant); `pages/admin/TableDataEditorPage.tsx:79,302,376` amber-500/700 set. Four different hues for one meaning, against 74 correct `-warning` usages elsewhere — semantic drift that makes caution states feel per-page instead of per-app.
  - Fix: sweep to `text-warning` / `bg-warning/…` (`--warning: 38 80% 50%` light, `38 88% 62%` dark already close to these ambers); grep guard: `(amber|yellow)-[0-9]` should end at 0 outside charts.

- [ ] **There is no `--info` token, so "informational" blue is improvised raw per file — visible daily on import-review badges** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - Semantic tokens cover success/warning/destructive/gain/loss but not info, so: `apps/frontend/src/pages/ImportReviewPage.tsx:55,300` pattern badges `border-blue-400 text-blue-600 dark:text-blue-400`; `features/recipients/RecipientPatternsDialog.tsx:334` `text-blue-600 dark:text-blue-400`; `components/layout/AppLayout.tsx:192` `Moon … text-blue-400` (no light variant — washed out on the light theme); devtools/admin method colors `components/devtools/RequestList.tsx:14-17` (`text-sky-500`/`text-orange-500`) and `pages/admin/EndpointLivenessPage.tsx:17` (`bg-blue-500/10 text-blue-700`). Each site picked its own blue — the app has no *voice* for "neutral information".
  - Fix: add an `--info` token pair to `styles/tokens.css` + `tailwind.config.ts` (tuned to the jewel family — `--chart-3` (204 68% 48% / 204 78% 62%) is the natural candidate) and route these sites through it; theme variants inherit via `themes.ts`.

- [ ] **Icon-tile glow is always primary-tinted even when the tile itself is gain/loss/chart-4/orange — copy-pasted shadow that contradicts its subject** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - The pasted `shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.25)]` sits under tiles whose fill is a *different* hue: `apps/frontend/src/components/dashboard/NetSummaryCard.tsx:82` (gain/loss gradient tile, emerald glow even when red/orange), `components/dashboard/StatCard.tsx:48` (`iconBg` may be loss), `pages/DashboardPage.tsx:461` (`from-chart-4/20` purple tile, emerald glow), `components/shared/PageHeader.tsx:27` (glow fixed to primary while `iconColor` is a prop — and `pages/DbMaintenancePage.tsx:163` passes `from-orange-500/20 to-orange-500/5 text-orange-500`, also the app's only raw-palette gradient). A crafted version would never halo a red tile in green.
  - Fix: make the glow follow the tile hue — set the tile's `color` to its semantic token and use `shadow-[0_2px_8px_-2px_currentColor]`-style (or a `--tile-glow` var per tone); replace DbMaintenance's orange with `warning` (its true meaning).

- [ ] **Two numeric voices for the same money: transactions/owes/recipient tables render amounts in `font-mono` (SF Mono), dashboard/portfolio in Inter `tabular-nums`** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S3_
  - `apps/frontend/src/features/transactions/components/TransactionsTable.tsx:228`, `features/transactions/components/TransactionQuickLook.tsx:47` (mono + `tracking-tight` on a 4xl amount), `pages/OwesPage.tsx:444`, `components/statistics/RecipientInsightsTab.tsx:119,130` + `pages/RecipientInsightsPage.tsx:100,111` all wrap `<Money>` in `font-mono` — overriding the Inter-tabular voice `Money` itself establishes (`components/shared/Money.tsx:44`) and that every dashboard/portfolio/net-worth figure uses. Same content type, two typefaces, page by page. The app *does* have a deliberate mono role — identifiers: tickers (`components/shared/SymbolSearchResultItem.tsx:39`, `components/portfolio/PortfolioTicker.tsx:169`), IBANs (`pages/RecipientsPage.tsx:182`), SQL/devtools — which this money-in-mono usage dilutes.
  - Fix: one numeric voice for money = Inter + `tabular-nums` (what `Money` already emits); strip `font-mono` from the six money sites; document the mono role as "identifiers, not amounts" next to the `--font-mono` token (`styles/tokens.css:124`).

- [ ] **`CardTitle`'s default (Fraunces display, 2xl) is a fiction — 78 of 130 call sites downsize it to xs–base, putting the display serif on 12–14px stat labels** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S3_
  - `apps/frontend/src/components/ui/card.tsx:29` sets `font-display text-2xl font-semibold`; only 24 sites use `<CardTitle>` bare, 78 override to `text-sm`/`text-base`-class sizes (grep) — e.g. `components/dashboard/StatCard.tsx:47`, `components/dashboard/NetSummaryCard.tsx:75`, `components/statistics/SummaryCards.tsx:63` re-style it into a muted eyebrow-label but keep the `font-display` class, so "LAST MONTH — NET" renders in Fraunces at 14px (a text-optical serif doing UI-chrome duty; no `font-sans` override exists anywhere). The display face is meant for brand moments (h1–h3, per `index.css:39-46`); spread over every stat label at micro sizes it stops being special — and each of the 78 overrides improvises its own size/weight/color combo.
  - Fix: give CardTitle cva size variants — `default` (display 2xl, unchanged), `sm` (display lg for chart cards), and a `label` variant (`font-body` — this is the S3-eyebrow, below) — then sweep the 78 overrides onto variants; rule: Fraunces never below `text-lg`.

- [ ] **~20 eyebrow/section-label recipes: 42 uppercase labels across 7 tracking values, 3 sizes, 3 weights, 4 muted tints — per-file improvisation of one role** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S3_
  - grep `uppercase` in `apps/frontend/src` → 42 uses whose tracking splits `tracking-wide`×16 / `tracking-[0.12em]`×11 / `tracking-[0.08em]`×5 / `tracking-wider`×4 / `tracking-[0.14em]`×2 / `tracking-[0.16em]`×1 / `tracking-[0.18em]`×1 / none×2, on `text-[10px]`/`text-[11px]`/`text-xs`, `font-medium`/`font-semibold`/regular, and `text-muted-foreground` vs `/70` vs `/80`. The class-string dump shows ~20 distinct full recipes for the identical role (section eyebrow) — the exact "each file rolls its own" texture that reads generated. The most-repeated designed variant (`text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70`, sidebar) is a good candidate keeper.
  - Fix: one `.eyebrow` utility class in `index.css` (pick ~`text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/80`) + optional `.eyebrow-strong`; sweep all 42 sites; grep guard: `uppercase tracking-` outside the utility definition → 0.

- [ ] **Percent/delta presentation is rebuilt inline ~54× with drifting sign and precision rules — while `DeltaPill` ("replaces ad-hoc colored delta text") has 4 consumers** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S3_
  - grep `toFixed(N)}%` → 54 inline constructions plus ≥5 local `fmtPct` helpers (`pages/portfolio/StocksPage.tsx:30` and `pages/portfolio/CryptoPage.tsx:26` are byte-identical copies; `pages/research/PortfolioForecastPage.tsx:53`, `pages/research/ResearchComparePage.tsx:208`, `components/research/ResearchFundamentalsTab.tsx:101`). Drift within the same meaning: zero gets a "+" at `components/portfolio/TotalValueCard.tsx:72` (`>= 0`) but not at `components/tax/YearComparisonCard.tsx:246` (`> 0`); precision wobbles 0/1/2 dp between neighboring surfaces (`pages/research/WatchlistPage.tsx:236` 1dp vs `ResearchHomePage.tsx:174` 2dp). Meanwhile the crafted standard exists — `components/shared/DeltaPill.tsx` (tinted pill + arrow + tabular, invertible) — but only StatCard and 3 portfolio pages use it.
  - Fix: shared `formatSignedPercent(v, dp=1)` (true −, explicit +, one zero rule) in `utils/` or shared-utils; adopt `DeltaPill` for change-vs-reference chips (research quotes, year comparison, watchlist since-added); delete the copy-pasted `fmtPct`s.

- [ ] **Below-scale micro-type sprawl: 105 arbitrary `text-[10px]`/`text-[11px]` plus 606 `text-xs` — three competing "small" with no token, and 10px is dense-chrome territory** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S3_
  - grep across `pages components features`: `text-[10px]`×72, `text-[11px]`×33 — arbitrary values minted per file below the Tailwind scale, on badges, eyebrows, axis labels, ticker chips (`components/portfolio/PortfolioTicker.tsx`, sidebar group labels, `components/shared/DeltaPill.tsx` uses `text-xs`…). Combined with `text-xs`×606 vs `text-sm`×495 vs everything-larger×175, the sub-14px band is 86% of all explicit sizing — dense finance UI justifies small type, but *three unnamed sizes* in that band means adjacent labels differ by 1px accidentally, not by role.
  - Fix: name the band — add `text-2xs` (11px/14px line-height) to the Tailwind `fontSize` scale (`config/tailwind.config.ts`), map the 10px cases up to it or down to a deliberate `text-3xs` if truly needed (chart ticks only); ban `text-[NNpx]` via grep guard once swept.

- [ ] **ResearchHomePage's 6-card EntryCard grid is a second sidebar — icon+title+description feature-tour composition inside a working app** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4_
  - `pages/research/ResearchHomePage.tsx:188-224` (+ `EntryCard` def `:297-310`): six cards whose icons and destinations are exactly the research nav items (`components/layout/AppSidebar.tsx:192-203` — Globe/LineChart/GitCompareArrows/CandlestickChart/TrendingUp/Target), each with a one-line description. A launcher grid that duplicates always-visible navigation is the canonical generated "landing hub" trope — it tells the user what the sidebar already tells them.
  - Fix: keep the hub, make every card *report live content* from its destination: Watchlist → top mover + distance-to-target; Compare → last comparison pair; Chart Builder → last saved chart sparkline; Forecast → current p50; Markets → today's index move. Cards become glanceable state, not a table of contents.

- [ ] **DollarSign is the app's money icon in a EUR-default Belgian app — 12 files; lucide's Euro icon: 0 uses** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4_
  - `components/dashboard/NetSummaryCard.tsx:83` (the dashboard hero tile), portfolio-value tiles (`pages/portfolio/StocksPage.tsx:210`, `CryptoPage.tsx:129`, `SavingsPage.tsx:102`, `RealEstatePage.tsx:117`), `components/statistics/SummaryCards.tsx:44` (net balance), `components/portfolio/TotalValueCard.tsx:230`, `pages/portfolio/PerformancePage.tsx:449`, `pages/OwesPage.tsx:269` (the record-payment *action* button), `components/portfolio/InvestmentDetailDialog.tsx:211`, `pages/RecipientInsightsPage.tsx:199`, `components/statistics/RecipientInsightsTab.tsx:199`. The $ reflex is a pure template inheritance — the app itself renders € everywhere via `Money`.
  - Fix: one shared `CurrencyIcon` that picks `Euro`/`DollarSign`/`PoundSterling` from `appSettings.defaultCurrency` (or sidestep the coin metaphor with `Wallet`/`Banknote` where the tile means "value", and a check/receipt metaphor for OwesPage's *pay* action, which isn't about currency at all).

- [ ] **Icon identity drift: 4 pages wear a different icon in the sidebar than in their own header, and BarChart3/Landmark/Database/TrendingUp each mean 2–3 unrelated things** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4_
  - Nav↔header mismatches: Crypto `Coins` (`components/layout/AppSidebar.tsx:161`) vs `Bitcoin` (`pages/portfolio/CryptoPage.tsx:113`); Market lookup `LineChart` (`:194`) vs `BarChart3` (`pages/research/MarketLookupPage.tsx:285`); Exchange rates `ArrowLeftRight` (`:146`) vs `Database` (`pages/admin/ExchangeRatesPage.tsx:105`); Portfolio dashboard `LayoutDashboard` (`:153`) vs `PieChartIcon` (`pages/portfolio/PortfolioOverviewPage.tsx:226`). Collisions: `BarChart3` is the identity of Statistics (nav `:127` + page), Performance (nav `:175` + `PerformancePage.tsx:190`), *and* MarketLookup's header; `Landmark` = both tax pages/nav (`:130,:177`) *and* AccountsPage (`pages/AccountsPage.tsx:94`) — taxes and bank accounts share a face; `Database` = DB maintenance (nav `:143` + `DbMaintenancePage.tsx:162`) and exchange rates; `TrendingUp` = Stocks nav (`:160`), Forecast nav (`:202`), plus generic stat-tile duty (`SavingsPage.tsx:133` interest, `StocksPage.tsx:250` unrealized P&L, `SummaryCards.tsx:28` income). Icons assigned per-file from whatever lucide name came to mind — no identity system.
  - Fix: a `lib/pageIcons.ts` map (one icon per destination, one destination per icon) imported by both AppSidebar and each page's PageHeader/EmptyState; resolve collisions by content (Statistics keeps BarChart3; Performance → Gauge/ChartSpline; MarketLookup keeps nav's LineChart; ExchangeRates keeps ArrowLeftRight; Accounts → Wallet2/CreditCard, leaving Landmark to tax).

- [ ] **Icon-decorated-heading reflex: ~60% of all CardTitles carry an icon that restates the adjacent word — including a trends chart iconed with TrendingDown** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4_
  - 43 CardTitles use the leading-icon pattern (`grep 'CardTitle className="flex items-center gap-2'`) + ~17 more take dialect-B's icon-right slot, against 130 total — plus PageHeader puts an icon tile on all 38 pages, so effectively every heading in the app is icon-decorated and the icons stop carrying signal. The give-away mismatch: the dashboard's neutral income-vs-expense chart gets a *decline* icon in its 11×11 gradient tile (`pages/DashboardPage.tsx:434-435` `TrendingDown` on "Monthly Trends"), and CategoryPie's `Tags` tile (`:461-462`) restates the word "category". Import cards' icons (`features/imports/SimpleImportCard.tsx:85-88`, `ExportCard.tsx:70-73`) do the same one-icon-per-title ritual.
  - Fix: rule, not sweep — icons on *identity* surfaces (PageHeader, nav, empty states) and on tiles where they disambiguate siblings at a glance (the 4 import cards qualify); chart cards drop the icon tile (a chart is its own picture — fixes the TrendingDown lie for free); section CardTitles inside an already-identified page go bare. Fewer icons = the remaining ones read as chosen.

- [ ] **ImportPage stacks six same-weight full-width cards — the daily task, one-time setup, and static reference all get identical density** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4_
  - `pages/ImportPage.tsx:23-28`: TransactionImportCard (THE recurring task) → RecipientsImportCard → CategoriesImportCard (both one-time setup imports) → ExportCard → ImportHistoryCard → SupportedBanksCard (static reference list), each an equal Card in one column. Uniform density regardless of importance is a generated-page texture; a crafted import page knows what you came for.
  - Fix: transaction import as the page's hero (drop zone + bank picker front and center, history beside/below it since it answers "did my last import work"); demote recipients/categories import + supported banks into a collapsed "Setup & reference" group or side rail; ExportCard keeps secondary weight.

- [ ] **Dialogs got the signature genie exit; every other overlay ships stock shadcn zoom with untokened timing and no reduced-motion gate** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S5_
  - Crafted layer: `components/ui/dialog.tsx:42` + `alert-dialog.tsx:40` — 420ms overshoot spring in (`tailwind.config.ts:185`, `cubic-bezier(0.34,1.45,0.64,1)`) and a 200ms genie-out that shrinks toward the opening pointer (`lib/dialogGenie.ts`), `motion-reduce:animate-none` gated. Default layer: `popover.tsx:20`, `dropdown-menu.tsx:40`, `select.tsx:69`, `tooltip.tsx:20`, `context-menu.tsx`, `sheet.tsx:22` all run tailwindcss-animate's boilerplate `fade-in-0 zoom-in-95 slide-in-from-*-2` at the plugin's defaults — no `--duration-*`/`--ease-*` token, and none has a `motion-reduce` gate (grep: 0 across all six). The modal layer feels Vision; the menu layer feels like every shadcn app.
  - Fix: keep the hierarchy (menus quicker + quieter than dialogs is right) but own it: add `duration-[var(--duration-fast)] ease-[var(--ease-out-expo)]` and `motion-reduce:data-[state=open]:animate-none` (+ closed) to the six overlay content classes.

- [ ] **The dashboard's full arrival choreography replays on every navigation — the app's best moment is spent as noise, while real completions get none** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S5_
  - `components/shared/RollingNumber.tsx:29-36` rolls every digit from 0 on *every mount*; `PageTransition.tsx:26` is keyed on pathname; `DashboardPage.tsx:401` re-staggers — so dashboard→transactions→dashboard re-runs the whole ~1s reveal each trip, training the user to ignore it. Meanwhile the events that *deserve* a moment end flat: committing an import batch is `toast.success` + `navigate("/import")` (`pages/ImportReviewPage.tsx:120-139` — the highest-stakes completion in the app), and finishing onboarding just closes the dialog (`components/onboarding/OnboardingWizard.tsx:208`). The vocabulary already exists (`icon-success-bounce`, stagger, odometer) — it's aimed at the wrong events.
  - Fix: gate the full dashboard choreography (stagger + odometer roll) to once per session (sessionStorage flag; returns get a quiet fast fade); spend the saved budget on completions — import commit lands on a success panel whose imported-count rolls up (RollingNumber) with the existing bounce check, and onboarding completion hands off into the dashboard's (once-per-session) staggered reveal.

- [ ] **Dead motion vocabulary in two of three layers — Tailwind keyframes and Framer variants that nothing uses** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S5_
  - `apps/frontend/tailwind.config.ts:146-157,180-182` — `fade-up`/`fade-in`/`scale-in` keyframes + animations: 0 uses in src. `lib/motion.ts` — `fadeUp`/`fadeIn`/`scaleIn`/`dialogVariants`/`staggerContainer`/`microLift`/`pressFeedback` variants and `springs.soft`/`springs.bouncy`: imported only by `lib/__tests__/motion.test.ts` (live consumers import only `durations`/`easings`/`springs.snappy`/`springs.dialog`). Three parallel entrance systems exist (CSS `.animate-in`, Tailwind `animate-fade-up`, Framer `fadeUp`) and one is used — the next contributor flips a three-sided coin, which is exactly how the double-entrance above happened.
  - Fix: delete the unused Tailwind animations and Framer variants (tests included), leaving one documented entrance API per layer (CSS utility for static mounts, framer for layout/gesture work).

- [ ] **The three moment-of-truth components are visual strangers: EmptyState got the designed treatment, PageError half of it, the crash fallback none** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S6_
  - `apps/frontend/src/components/shared/EmptyState.tsx:13-19` — glass tile + aurora glow halo + `font-display` title (the crafted anatomy). `components/shared/PageError.tsx:14-18` — same 16×16 tile *shape* but flat `from-destructive/15` gradient + `shadow-sm`, no halo, title NOT `font-display`. `components/shared/ErrorBoundary.tsx:22-24` (the whole-section crash fallback) — a naked `AlertTriangle` with no tile at all, `text-lg font-semibold` plain. Three siblings for "this area has no content / failed / crashed", three anatomies — the state a user hits at their worst moment is the least designed. (2026-06-30 filed *pages bypassing PageError*; this is the shared components' own visual drift — S4 explicitly deferred it here.)
  - Fix: one `StateBlock` anatomy (tile + optional halo + font-display title + description + action slot) with a `tone` variant (`neutral` = current EmptyState, `destructive` = tinted tile, halo in destructive/10); PageError and ErrorFallback become thin wrappers over it, so every no-content moment shares one crafted face.

- [ ] **~10 hand-rolled empty states beside the designed component — including the tax feature's entire first-run screen** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S6_
  - The bare-icon-plus-text clone (no glass tile, no halo, no `font-display`): `pages/TaxOverviewPage.tsx:431-445` (the no-tax-profile screen — a whole feature's front door, `Landmark h-12 w-12 text-muted-foreground/40` + plain h3) and `:560,687` (checklist empties); `components/statistics/SavedChartsSection.tsx:71-76` (dashed box, plus its own bootleg `bg-muted animate-pulse` skeleton at `:66-69` instead of `Skeleton`/`SectionLoader`); `components/portfolio/PortfolioNewsFeed.tsx:50,72`; `pages/research/ResearchHomePage.tsx:279`; `pages/research/PortfolioForecastPage.tsx:209`; `pages/portfolio/PerformancePage.tsx:57`; `pages/AIChatPage.tsx:125-133` (glass but dashed-border, h-6 icon, its own recipe); `pages/research/MarketOverviewPage.tsx:1074` (a bare `<p>` in a dashed box). Each is a page where 17 sibling surfaces already render the crafted `EmptyState` — the difference is visible page-to-page as "designed here, shrugged there".
  - Fix: adopt `EmptyState` at all ten sites (it already takes `action`); add a `compact` size variant for in-card slots (news feed, saved-charts, forecast) so density isn't the excuse; the TaxOverview no-profile screen deserves the full treatment + its existing setup CTA.

- [ ] **Table zero-states default to one dead muted line — and the app's own best practice proves the slot accepts better** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S6_
  - `components/shared/DataTable.tsx:480-484` / `components/shared/VirtualDataTable.tsx:670-674` render empties as bare `text-center text-muted-foreground py-12` text, defaulting to `table.noData` = "No data to display" (`i18n/source/en.json:2839`). `features/transactions/components/TransactionsTable.tsx:384-393` shows the ceiling: it passes a full `EmptyState` (contextual icon, search-aware description, Import CTA) through the same `emptyMessage` prop — but `pages/PlannedPaymentsPage.tsx:504`, `pages/DashboardPage.tsx:500`, and `pages/OwesPage.tsx:472` pass plain strings, so a first-run Planned Payments page (a primary nav destination) greets the user with one grey sentence in an empty grid. (U4 owns CTA *presence*; this is the visual rank of the slot.)
  - Fix: pass compact `EmptyState`s (with the page's identity icon) on the primary tables; make the shared default a compact EmptyState with the table's title icon rather than raw text, so no future table ships the dead line.

- [ ] **Boot splash and backend-error page — the two moments the app stands naked, before any CSS loads — wear another app's colors** 🔼
  - ↪ _from: Design authenticity 2026-07-03 · Wave S6_
  - Splash: `packaging/electron/main.js:1399-1405` — a generic 26px border-spinner + system-font app name; the no-saved-theme fallback palette (`:1383-1387`) is literal Tailwind slate (`#0f172a/#94a3b8/#e2e8f0/#f8fafc`), the default-scaffold tell, and no brand mark. Error page: `packaging/electron/assets/error.css:1-21` mints its own palette with an arbitrary blue accent (`--accent: #5b8cff` dark / `#2c5cff` light) — nothing in the app is blue; primary is emerald (`tokens.css:33,149`), so the first thing a user sees when the backend hiccups is off-brand in the one color that matters. (S1 praised this page's *copy* as house-quality; the mechanics — theme persistence via `readSplashTheme`, reduced-motion, CSP, i18n — are genuinely good. Only the character is borrowed.)
  - Fix: reuse `deriveSplashPalette`'s persisted theme in error.css (inject the same CSS vars), swap the blue accent for the brand emerald/champagne pair, and put the VisionMark above the spinner/title on both — boot and failure then look like Vision within 100ms.

- [ ] **Global single-key shortcuts still fire while a modal dialog is open — navigation happens underneath and can discard dialog state** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - `apps/frontend/src/hooks/useGoToShortcuts.ts:50-68` (g-sequences) and `:86-96` (`[`/`]`), `components/shared/ShortcutsOverlay.tsx:29-37` (`?`) — the only guards are modifier keys + `isTypingTarget` (`lib/keyboard.ts:3-8`). Radix dialogs don't stop keydown propagation to `document`, so with focus on any button/checkbox inside an open Dialog/AlertDialog, `[`, `]`, `?` or a `g`-sequence navigates the page behind the modal; the route change unmounts the page-owned dialog, losing in-progress edits.
  - Fix: bail out when an overlay is open, e.g. `if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;` in the shared guard (extend `isTypingTarget` into an `isShortcutSafeTarget`).

- [ ] **Per-point chart values are unreachable without a pointer (tooltip/scrub is pointer-only everywhere)** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - `components/charts/LineChart.tsx:433-437`, `AreaChart.tsx:516-520`, `BarChart.tsx:278-317` (hover/scrub via onPointer* only), `components/dashboard/NetSummaryCard.tsx:131-141` (sparkline scrub div: onPointer* only, no tabIndex/keydown), `components/charts/scrub.tsx` (drag-only range compare). Charts do have localized `role="img"` summaries (`chartAria.ts`) — good for SR overview — but a sighted keyboard user gets no way to read individual data points or use the advertised range-compare (`shortcuts.chartScrub` tip, `i18n/source/en.json:2650`, documents a drag-only interaction).
  - Fix: make interactive charts focusable (`tabIndex={0}`) and map ←/→ to step `hoverIndex` (Shift+←/→ to extend a scrub range), reusing the existing tooltip/readout rendering; same arrow-key pattern for the NetSummaryCard scrub div.

- [ ] **CategoryPivotTable drill-down cells are plain `<td onClick>` — mouse-only** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - `apps/frontend/src/components/statistics/CategoryPivotTable.tsx:298,310,332,344,367,378` — cells styled `cursor-pointer` with onClick drill-down to transactions, but no `role`, `tabIndex`, or keydown; keyboard users cannot open any pivot drill-down.
  - Fix: wrap the cell content in a focusable element using the existing `onActivateKeyDown` helper (as OwesPage/CategoriesPage/WatchlistPage already do), or add `role="button" tabIndex={0}` + the helper on the td.

- [ ] **BankBalancesWidget account cards open transactions on double-click only — no keyboard path, no click affordance** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - `apps/frontend/src/components/dashboard/BankBalancesWidget.tsx:182-187` — `Card` has `onDoubleClick` + `cursor-pointer` + title tooltip, but no `role`/`tabIndex`/keydown. Keyboard users can't open an account's transactions from the dashboard; double-click is also undiscoverable for mouse users.
  - Fix: add `role="button" tabIndex={0} onKeyDown={onActivateKeyDown(...)}` (Enter = open), matching the OwesPage card pattern.

- [ ] **No skip-to-content link and no `<nav>` landmark — full sidebar traversal on every page** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - `components/ui/sidebar.tsx:136-210` renders the entire sidebar as `<div>`s (no `<nav>`/`role="navigation"`); `components/layout/AppSidebar.tsx` adds none either. `AppLayout.tsx:104-221` has `<header>` + `<main>` but no skip link, and the sidebar precedes `<main>` in DOM order — keyboard users tab through the workspace switcher + ~10 nav items + topbar on every page before reaching content; SR users can't jump by navigation landmark.
  - Fix: wrap `SidebarContent`'s menus in `<nav aria-label={t('nav.…')}>` and add a visually-hidden-until-focused "Skip to content" link as the first child of the layout targeting `<main id="main">`.

- [ ] **Enter never submits in the button-only dialogs — ~15 input dialogs have no `<form>`, while 9 sibling dialogs submit on Enter** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2_
  - No `<form>` and no Enter keydown handler (grep confirmed zero `onKeyDown`): `components/planned/PlannedPaymentForm.tsx:323` (submit is a bare Button onClick), `components/splits/SplitTransactionDialog.tsx:231`, `components/portfolio/AddToWatchlistDialog.tsx`, `features/recipients/RecipientPatternsDialog.tsx`, `components/tax/TaxProfileDialog.tsx`, `components/tax/MarkAsFiledDialog.tsx`, bulk dialogs, `features/portfolio/MoveHoldingDialog.tsx`. Meanwhile AddTransactionDialog/AddAccountDialog/AddRecipientDialog/AddCategoryDialog/portfolio add-edit dialogs are real `<form onSubmit>` (Enter works).
  - Pressing Enter in the amount field of a planned payment does nothing — muscle memory trained by the other half of the app fails silently.
  - Fix: wrap the field stacks in `<form onSubmit={handleSubmit}>` with the footer button as `type="submit"` (footer Cancel buttons already carry `type="button"` in the form dialogs, so the pattern is established).

- [ ] **Add Transaction's Currency field is labeled "Bank"** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2_
  - `components/forms/AddTransactionDialog.tsx:118` — `<Label htmlFor="tx_currency">{t('form.addTransaction.bank')}</Label>`; `i18n/source/en.json:868` `"form.addTransaction.bank": "Bank"`, over an input whose placeholder is "EUR" (`addTxn.currencyPlaceholder`).
  - Every user of the core add-transaction dialog sees a field captioned "Bank" that actually wants a currency code; free-typed junk goes to the backend as `currency` (maxLength 10, no code validation).
  - Fix: label it with a currency key (e.g. `accounts.field.currency`), and consider a Select of known codes like PlannedPaymentForm:149-156.

- [ ] **Add Transaction recipient/category pickers are plain Selects capped at 200 items with no search — the searchable comboboxes already exist but aren't used here** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2_
  - `components/forms/AddTransactionDialog.tsx:26-27` fetches `{limit: 200, active: true}`; `:125-144` renders plain Radix Selects. `components/shared/RecipientCombobox.tsx:23-29` / `CategoryCombobox.tsx` (used by PlannedPaymentForm) do debounced server-side search with limit 1000 plus an explicit "none" clear item.
  - With more than 200 recipients (real dataset qualifies) the needed recipient may not even be in the list, and scanning 200 unsearchable options is the slowest interaction in the app's most-used form. No free-text creation either — a new recipient forces abandoning the dialog for the Recipients page (same dead-end in SplitTransactionDialog:185).
  - Fix: swap in RecipientCombobox/CategoryCombobox; consider a "create '<query>'" CommandItem for the recipient case.

- [ ] **`bank_account` is free-typed text in Add Transaction and Planned Payment forms — typos mint phantom accounts** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2_
  - `components/forms/AddTransactionDialog.tsx:115` (`tx_bank`, plain Input) and `components/planned/PlannedPaymentForm.tsx:204` (`pp-bank`, plain Input) — no picker, no validation, despite `components/shared/BankAccountMultiCombobox.tsx` existing for filters and the backend deriving `account_id` from this string (cf. the 2026-06-25 KBC account-collapse incident, which was exactly a bank_account labeling defect).
  - One transposed IBAN digit silently creates a new account bucket and splits balances.
  - Fix: single-select combobox over existing accounts with explicit free-text escape hatch, or at least IBAN-shape validation + suggestions from known accounts.

- [ ] **Mouse wheel silently changes focused amount fields while scrolling long dialogs** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2_
  - `components/ui/input.tsx` has no `onWheel` guard (grep: zero `onWheel` anywhere) and 71 inputs are `type="number"`; the tall dialogs are scroll containers (`PlannedPaymentForm.tsx:128` `max-h-[85vh] overflow-y-auto`, AddAccountDialog:151, AddInvestmentFromMarketDialog:181), so scrolling the form while the cursor rests over a focused units/price/fees field increments the value instead — a classic silent-corruption footgun in a finance app.
  - Fix: in the shared Input, `onWheel={(e) => (e.target as HTMLElement).blur()}` when `type === "number"` — or moot it by migrating money fields to `type="text" inputMode="decimal"` (finding above).

- [ ] **Watchlist remove and research-mapping delete fire instantly with no confirm (and no undo)** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2_
  - `pages/research/WatchlistPage.tsx:246-257` — trash icon click → `deleteMutation.mutate(item.id)` directly; destroys the user-typed notes and target price with only a "Removed from watchlist" toast (`en.json:3505`), no undo. `components/research/ResearchMappingDialog.tsx:256` — same direct `deleteMutation.mutate(m.id)` for provider mappings. Every comparable surface (transactions, categories, recipients, planned, splits, conversations, portfolio txns) goes through `useConfirmDialog`.
  - Fix: route both through `useConfirmDialog` (destructive variant), or add an undo action to the toast.

- [ ] **DatePicker has no typed entry and no month/year jump — backfilling old dates is a click marathon; it also can't carry an `id`** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2_
  - `components/shared/DatePicker.tsx:10-21` — props accept no `id`; the control is a button + `components/ui/calendar.tsx` popover with default caption (no `captionLayout="dropdown"`/`fromYear` — grep), so reaching a 2019 portfolio buy date means ~80 month-arrow clicks and there is no way to just type the date. Native fallback exists only at `AddAccountDialog:273` (`type="date"`).
  - Affects every dated form (transactions, planned, portfolio txns) whenever the date isn't near today.
  - Fix: add year/month dropdowns (`captionLayout="dropdown"`) and a text input accepting the app date format that parses into the calendar; forward `id` to the trigger button so labels associate.

- [ ] **Statistics tabs (and other page-level tabs) are uncontrolled — reload/back always resets to the first tab, no deep-link** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3_
  - `apps/frontend/src/pages/StatisticsPage.tsx:159` `<Tabs defaultValue="overview">` (6 tabs incl. Categories/Recipients/Yearly); same pattern `pages/research/ResearchComparePage.tsx:385` and `pages/admin/ExchangeRatesPage.tsx:172`; `MarketLookupPage.tsx:155` keeps `activeTab` in `useState`.
  - A user on Statistics→Categories who drills into a pivot cell (`CategoryPivotTable.tsx:292` navigates to /transactions) and presses Back lands on Statistics→Overview — their analysis context is gone. Tabs also can't be shared/bookmarked.
  - Fix: sync the tab to a `?tab=` param with `{ replace: true }` — the codebase already has the exact pattern in `components/dashboard/CashFlowForecastChart.tsx:96-107` (`forecastMode`/`rollingDays`).

- [ ] **Tax year being viewed is context-only state — refresh silently jumps back to the live year** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3_
  - `apps/frontend/src/contexts/BelgianTaxProfileContext.tsx:227` — `viewedYear` is `useState(profile.taxYear)`; neither `/tax` nor `/portfolio/tax` reads or writes a year param.
  - Reviewing a historical year (e.g. 2023 snapshot) and reloading — or wanting to share/bookmark "taxes 2023" — silently lands on the current year; with the historical banner this is easy to miss and figures differ.
  - Fix: mirror `viewedYear` into `?year=` on the two tax routes (validate against available snapshot years, fall back to live year).

- [ ] **Opening AI Chat from the Portfolio/Research workspace flips the sidebar to Budgeting and persists it** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3_
  - `apps/frontend/src/contexts/WorkspaceContext.tsx:40` — `isAgnostic` covers only `/admin` and `/accounts`; `/ai-chat` (declared workspace-agnostic at `App.tsx:229` and rendered above the workspace switcher, `AppSidebar.tsx:249`) falls through to `workspace = "budgeting"`, and the effect at `:52` writes that to sessionStorage.
  - A portfolio user clicking AI Chat sees the sidebar swap to Budgeting nav items, and their stored workspace is overwritten — subsequent agnostic routes (/accounts, /admin) also show Budgeting.
  - Fix: add `path.startsWith("/ai-chat")` to the `isAgnostic` predicate.

- [ ] **Import commit navigates without `replace` — Back returns to the consumed batch's review page** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3_
  - `apps/frontend/src/pages/ImportReviewPage.tsx:139` and `pages/portfolio/PortfolioImportReviewPage.tsx:49` — post-commit `navigate("/import")` / `navigate("/portfolio")` push a new entry, leaving the review URL of the now-committed batch in history.
  - Pressing Back after an import re-opens the review screen for a batch that no longer previews (error state or stale cached preview) — confusing right after a successful commit, and re-inviting a second commit click.
  - Fix: `navigate(target, { replace: true })` in both `onSuccess` handlers (the review page is a one-shot flow, like `StartupRedirect.tsx:64` already does).

- [ ] **Transactions: filters survive reload/share but search text and sort silently don't** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3_
  - `apps/frontend/src/pages/TransactionsPage.tsx:30` — `search` is `useState` (the `?search=` param is only read, `:33-36`, never written back on typing); sort lives in `features/transactions/hooks/useTransactionListData.ts:60-61` (`useState`, no param).
  - All ten filter params (recipient_id, category_ids, dates, amounts, tags, …) are URL-first, so users learn views are shareable — then a shared/reloaded URL drops the search term and sort order, showing a different result set than what the sender saw.
  - Fix: debounce-write `search` (already `SEARCH_DEBOUNCE_MS`-debounced for the query) and `sort_key`/`sort_dir` into the params with `{ replace: true }`, initializing from them.

- [ ] **Silent mutation failures (watchlist delete, research-mapping delete/audit, attachment delete) — and no global mutation onError safety net** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U4_
  - QueryClient (`apps/frontend/src/App.tsx:93-102`) sets query defaults only — no `MutationCache`/mutation `onError` default exists (grep), so any `useMutation` without explicit `onError` fails with zero user feedback. Confirmed instances: `pages/research/WatchlistPage.tsx:58-64` (remove-from-watchlist: on failure the row just stays, nothing at all happens), `components/research/ResearchMappingDialog.tsx:107-118` (mapping delete + audit mutations, no onError), `components/shared/AttachmentPanel.tsx:111-120` (delete `onError` only resets the spinner — the attachment remains with no message).
  - A failed destructive action that looks like a no-op makes users click again or wrongly believe the item was removed.
  - Fix: add `onError` toasts to the three call sites, and register a `MutationCache` global `onError` fallback toast in App.tsx so future mutations can never fail silently.

- [ ] **Infinite-scroll page-2+ load failure is silent — the transactions list quietly truncates** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U4_
  - `apps/frontend/src/features/transactions/hooks/useTransactionListData.ts:180-188` — `loadMore`'s catch is `logger.error` only: the footer spinner disappears, the list stops short of `totalItems`, and there is no toast, no inline error row, no retry affordance (scrolling again does retry, but nothing tells the user rows are missing).
  - A network blip mid-scroll leaves a finance list silently incomplete — worse than an error, because it looks like the end of the data.
  - Fix: on catch, show an inline "couldn't load more — retry" row (or toast with retry action) instead of only logging.

- [ ] **Belgian tax surfaces ship hardcoded English copy — untranslated for nl users on an otherwise fully-translated feature** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5_
  - `components/tax/profile-steps/ExemptionsStep.tsx:140-141` — pension-scheme SelectItems are literal `"Standard: €1,050 (30% credit)"` / `"Alternative: €1,350 (25% credit)"` amid siblings that all use `t()`. `components/tax/SuggestedDeductionsCard.tsx:48-108` — every suggestion `title:` is hardcoded ("Pension savings", "Life insurance", "Employee group insurance", "Charitable donations", "Childcare costs", "Domestic help", "Alimony paid") while the `desc:` beside each IS translated — nl users get mixed-language rows. `pages/TaxOverviewPage.tsx:389-391` — three header badges are literal: `Region: {profile.region}` (also prints the raw lowercase enum `flanders`/`wallonia`/`brussels`), `Marginal rate: …`, `Effective burden: …`. Bonus: the PIT breakdown labels in `lib/belgianTax/pit.ts:522-563` ("Gross Income", "Bracket 1 (25%)", …) are English-only and flow into the report export (`components/reports/ExportDialog.tsx:201`).
  - Affects every Dutch-language user on /tax — the app's most Belgium-specific feature is the one with English leaking through.
  - Fix: move the four surfaces to i18n keys (region label can reuse `tax.profile.region.{value}.label`, which already exists for both languages — `RegionStep.tsx:44` proves the pattern); run `bun run validate-locales` after.

- [ ] **Percentages are never locale-formatted — "12.5%" (dot) next to "1.234,56" (comma) in the eu/nl number format, plus digit/sign drift** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5_
  - No percent formatter exists (`grep style: 'percent'` → only `utils/currency.ts` currency use); ~57 component sites render percents via `toFixed()` string-concat, which always emits a dot decimal regardless of the `numberFormat` setting that all money amounts obey. Representative: `components/portfolio/TotalValueCard.tsx:71-74` (+sign, 1dp), `components/portfolio/PortfolioTicker.tsx:151` (+sign, 2dp), `pages/research/WatchlistPage.tsx:236` (+sign, 1dp), `components/tax/YearComparisonCard.tsx:82` (no sign, 1dp), `components/tax/MultiYearTrendStrip.tsx:131`, `components/dashboard/NetSummaryCard.tsx:96`, `components/charts/PieChart.tsx:127` (0dp), `components/shared/CommandPalette.tsx:346` — while `pages/portfolio/RebalancePage.tsx:92` alone uses `toLocaleString(undefined,…)` (browser locale, a third convention).
  - A Belgian user with the default eu format sees comma-decimal currency and dot-decimal percentages on the same card; +prefix and decimal count also vary between adjacent gain/loss chips.
  - Fix: add `formatPercent(value, {digits, signed})` to `utils/currency.ts` built on `Intl.NumberFormat(locale, {style:'percent'})` (locale from `numberFormatToLocale` like `formatCurrency`), then sweep the toFixed-% sites onto it; standardize signed 1dp for gain/loss deltas.

- [ ] **Chart month names ignore the app language — statistics/dashboard/portfolio charts show "Jan/May/Oct" in the Dutch UI** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5_
  - `components/shared/dateUtils.ts:5` `formatDate(date, pattern, locale = "en-US")` — callers that omit the locale get English month names: `components/statistics/NetTrendChart.tsx:39`, `CategoryTrendChart.tsx:62`, `CustomChart.tsx:51,250`, `components/dashboard/BankBalancesWidget.tsx:236,238`, `pages/portfolio/PerformancePage.tsx:320,356` (all "MMM"-pattern axis ticks/tooltips). Sibling charts do it right (`components/dashboard/ForecastInnerRolling.tsx:36-53`, `components/portfolio/PerformanceBreakdown.tsx:59` map language→locale first). The chart primitives' fallbacks also use raw browser `toLocaleDateString()` (`components/charts/AreaChart.tsx:564`, `LineChart.tsx:481`, `ComposedChart.tsx:346`) — a third source of truth.
  - nl users see Dutch month names on the cash-flow forecast but English ones on Statistics and Performance — same dashboard, two languages.
  - Fix: thread the language→locale mapping through the remaining `formatDate` call sites (or change `formatDate` to require the locale param so omission can't compile), and give the chart fallbacks the app locale.

- [ ] **Settings dialog keeps its fixed 208px sidebar at all widths — content pane shrinks to ~120px on phones** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U6_
  - `components/settings/DashboardSettingsDialog.tsx:83-119` — `DialogContent` is `w-full max-w-3xl h-[82vh]` with a `<nav className="w-52 shrink-0 …">` (208px) beside the ScrollArea content. At 375px viewport: 375 − 208 − px-6 padding ≈ 120px for every settings control (theme pickers, backup passphrase, API keys) — effectively unusable; at 768px (tablet portrait) it fits. No `sm:`/`md:` variant anywhere in the file. (Needs live viewport check for exact clipping behavior.)
  - Fix: below `md`, collapse the section nav to a top bar (horizontal scrolling chips or a Select) and let the content take full width — the section state is already plain `useState`, so only the layout classes change.

- [ ] **TabsList never wraps or scrolls — 5-7-tab pages overflow the viewport at phone widths** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U6_
  - `components/ui/tabs.tsx:50` — `TabsList` is `inline-flex h-10 …` with `whitespace-nowrap` triggers (`:72`) and no `overflow-x-auto`/`flex-wrap` (grep: zero in tabs.tsx). `pages/StatisticsPage.tsx:160-167` renders 6 triggers (~550px wide), `pages/research/PortfolioForecastPage.tsx` 5, `pages/admin/ExchangeRatesPage.tsx` 5, `pages/research/MarketLookupPage.tsx` 4 — at 375px the list overhangs the viewport and drags the whole page into horizontal panning; the last tabs (Flow/Custom on Statistics) are off-screen by default.
  - Fix: add `max-w-full overflow-x-auto` to the TabsList base classes (one-line primitive fix covers all pages); optionally hide the scrollbar with the existing scrollbar utility styling.

- [ ] **Essential info lives in native `title=` tooltips — invisible on touch (and Radix tooltips don't open on tap either)** 🔼
  - ↪ _from: UI/UX research 2026-07-03 · Wave U6_
  - Info-bearing (not merely redundant) `title`-only carriers: compact-currency full values — 16 sites render `title={r.isCompact ? r.full : undefined}` around abbreviated amounts (`components/dashboard/BankBalancesWidget.tsx:166,202`, `components/statistics/SummaryCards.tsx`, `CategoryPivotTable.tsx`, `YearlySummaryTable.tsx`, `components/dashboard/NetSummaryCard.tsx`, `pages/DashboardPage.tsx`) — a touch user can never see the exact figure behind "€1.2M"; `components/portfolio/StalePriceIndicator.tsx:33-38` — the *when* of a stale price exists only as `title`/`aria-label` on a 12px clock icon; `pages/portfolio/StocksPage.tsx:370-372` — the FX-fallback-rate warning (`portfolio.fxFallbackNote`) is a `title` on a `<td>` plus a bare "⚠" glyph; `pages/AccountsPage.tsx:135,155,164` — open-transactions hint, drift explanation, balance-provenance tooltip. Radix `Tooltip` (used app-wide via `TooltipProvider`, `App.tsx:174`) does not open on touch by design, so converting `title` → Radix tooltip alone would not fix touch.
  - Affects tablet users reading portfolio/dashboard figures — the compacted exact amounts and stale-price timestamps are core financial data, not decoration.
  - Fix: for compact currency, reveal the full value on tap (wrap in a Popover-on-coarse-pointer, or toggle full/compact on click); for stale-price/FX warnings, render the date/note as visible text on coarse-pointer layouts or make the indicator a tap-toggled Popover.

- [ ] **Six+ pages roll bespoke error UI instead of the shared `PageError` component** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `AccountsPage.tsx:109-111` (plain `<p>`, no icon/retry), `DbMaintenancePage.tsx:206-212`, `RecipientInsightsPage.tsx:145-151`, `PlannedPaymentsPage.tsx:438-443`, `ImportReviewPage.tsx:256-264`, `DashboardPage.tsx:344-348`
  - `PageError` already supports icon/heading/message/`onRetry` but is used in only 6 consumer pages; the rest produce several visually different treatments, several with no retry action.
  - Fix: converge all of these on `PageError`.

- [ ] **Icon-only action buttons missing accessible names** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `AccountsPage.tsx:171-178` (account-row "more options" menu, icon-only), `RecipientPatternsDialog.tsx:281-289` (delete-pattern button, unlike the adjacent edit button which has `sr-only` text)
  - Primary entry points for account management and a destructive action, exposed with no name to assistive tech.
  - Fix: add translated `aria-label`s mirroring the existing edit-button pattern.

- [ ] **Add/edit transaction dialog can overflow viewport height with no scroll** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `components/ui/dialog.tsx:39-46` (base `DialogContent`, no `max-h`/`overflow-y-auto`), inherited by `forms/AddTransactionDialog.tsx:91`
  - On a short viewport (landscape phone, or keyboard open), the submit button can be pushed off-screen with no way to reach it. Other dialogs (`AddInvestmentDialog.tsx`, `TaxProfileDialog.tsx`, `SnapshotHistoryDialog.tsx`) already self-apply a scroll workaround per-dialog.
  - Fix: fix once in the shared `DialogContent` (`max-h-[90vh] overflow-y-auto`).

- [ ] **Status badges reimplemented ad hoc in several places instead of the shared `Badge` primitive** 🔼 🔧 *(focus-ring half of this finding mostly retracted — see correction)*
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `admin/ProviderHealthPage.tsx:25-29,65,73` (local `statusBadgeClass()`), `devtools/ApiInspector.tsx:46`, near-byte-identical duplicated count-pill markup in `DataTable.tsx:360`/`VirtualDataTable.tsx:545`.
  - Fix: route status pills through `<Badge variant=...>` (add a compact size variant if needed).
  - Verification (2026-06-30): the companion "focus rings reimplemented ad hoc" claim mostly doesn't hold — `index.css:79-83` defines a global `:focus-visible` ring that `ChartPeriodSelector.tsx`, `DashboardSettingsDialog.tsx`, and `OnboardingWizard.tsx` (all three checked) already inherit by default; they don't set `outline-none` and were wrongly listed. Only **`TagInput.tsx:63`'s remove button is a genuine gap** — it sets `focus:outline-none` via a Tailwind utility class, which (per CSS layer ordering) wins over the global base-layer rule even on `:focus-visible`. Fix: add `focus-visible:ring-2 focus-visible:ring-ring` to `TagInput.tsx`'s remove button only; the other three sites need no change.

- [ ] **`/planned` front-loads four stacked advisory sections before the actual payments table — the clearest "piling up"** 🔼
  - ↪ _from: UI clutter review 2026-07-01 · Real issues_
  - `apps/frontend/src/pages/PlannedPaymentsPage.tsx` — above "All Payments" the page stacks: global upcoming-payments notification → "1 suggested match(es)" (`components/planned/MatchSuggestionsBanner.tsx`, `PlannedPaymentsPage.tsx:495`) → a red **"Amount Changes Detected"** card (3 rows) → **"Detected Recurring Patterns"** (`RecurringDetectionPanel.tsx`, 10 full-height rows, **default-expanded**). Page is ~2990px tall; the user scrolls past all four advisory blocks to reach their own planned payments.
  - Fix: collapse "Detected Recurring Patterns" by default (or cap its rows with a "show more"); make "Amount Changes Detected" and "Suggested matches" more compact/dismissible so primary content sits higher.

- [ ] **"Market News" feed renders 25 uncapped articles beside a much shorter column → huge empty void** 🔼
  - ↪ _from: UI clutter review 2026-07-01 · Real issues_
  - `apps/frontend/src/components/portfolio/PortfolioNewsFeed.tsx:22` fetches **25** articles and `:79` renders **all** of them (no `slice`/cap, no internal max-height). Placed in `pages/portfolio/PortfolioOverviewPage.tsx:384-444` as a 2:1 grid (`grid-cols-3`, `lg:items-stretch`) beside "All Investments", and on `pages/research/ResearchHomePage.tsx` beside "From your watchlist". The 25-item feed makes that row ~4000px tall while the neighbor fills ~700px → ~2700–3000px of empty space next to the feed (page reaches 4131px on Portfolio Overview). Systemic: same component, two pages, both lopsided. It's the toggleable `news` widget (`isVisible('news')`), on by default — so it shows **when that widget is enabled**.
  - Fix: cap the rendered list (e.g. top ~6 with "View all"), or give the feed its own `max-h` + internal scroll, or make it full-width below the row instead of a stretched grid column.

- [ ] **Five strings separate clauses with a stray spaced period " . " — reads as a rendering bug** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json:280` `aiChat.enterHint` "Enter to send . Shift+Enter for a new line", `:990` `importPage.progressSummary` "{imported} imported . {duplicates} duplicates . {errors} errors", `:995`, `:1041`, `:1428` `onboarding.stepOf` "Step {n} of {total} . {label}" — same artifact in nl.json (same lines). All render verbatim (`TransactionImportCard.tsx:441`, `ChatComposer.tsx:146`, `OnboardingWizard.tsx:241`). Almost certainly a mangled middle dot.
  - Fix: replace " . " with " · " (U+00B7) in all five en+nl pairs.

- [ ] **Mood-only empty states in surfaces that could invite action — against the app's own good examples** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json:1153` `market.noNews` / `:1302` `newsFeed.noNews` "No news available" (dead-end shrug; could say what would populate it), `:751` `dbMaintenance.noTables` "No tables found", and a duplicate pair on one page family: `categories.noCategories`:411 "No categories yet." vs `categoriesPage.empty`:425 "No categories found." The app's crafted counterexamples show the bar: `accounts.emptyDescription`:26, `portfolio.noInvestmentsDesc`:1819, `statsPage.noDataDesc`:2767 ("Import your bank transactions to see statistics."). (Wave U4 filed CTA *mechanics*; this is the copy itself.)
  - Fix: news: "No recent news for your holdings — headlines appear once your portfolio has tickers with coverage."; unify the two categories strings to one voice ("No categories yet — add one or import a bank CSV to start.").

- [ ] **Cheerleader glyphs: the app's only emoji ("All settled! 🎉") and ✓-prefixed advice-bot toasts on watchlist** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json:1459` `owesPage.allSettled` "All settled! 🎉" (sole emoji in UI copy, `pages/OwesPage.tsx`); `:3499` `watchlist.atTarget` "✓ Price is at or below your target!" and `:3513` `watchlistChart.atTarget` "…your target! Consider buying." — glyph-in-string (the ✓ should be the badge's icon, not text), exclamation enthusiasm, and "Consider buying" is chatbot advice voice inside a price chip.
  - Fix: "All settled." / "At or below your target price" (badge tone, ✓ as an icon element if wanted); drop "Consider buying." — the target-hit state already says it.

- [ ] **Three filler subtitles ("View and manage…", "Manage your…", "Overview of…") on the app's most-visited pages, next to genuinely crafted ones** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json:3446` `txPage.subtitle` "View and manage all your transactions", `:1729` `plannedPage.subtitle` "Manage your recurring and scheduled payments", `:694` `dashboard.subtitle` "Overview of your finances" — textbook filler that restates the nav item. The same file proves the house can write: `rebalance.subtitle`:1981 "Deploy spendable cash into underweight sleeves toward a target allocation -- without selling.", `research.compare.subtitle`:2151, `insights.subtitle`:1074.
  - Fix: say something the title doesn't — e.g. txPage: "Search, filter, and categorize every imported transaction"; plannedPage: "Upcoming bills and the recurring payments Vision watches for you"; dashboard: drop the subtitle (the cards are the overview).

- [ ] **A few "Enter X" placeholders against the app's established "e.g. <real value>" exemplar pattern** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json:219` `addWatchlist.targetPlaceholder` "Enter target price" (a price field should show a price), `:939` `importPage.customBankName` "Enter your bank name...", `:2581` `settings.research.placeholder` "Enter API key", `:721` `dbEditor.filterPlaceholder` "filter..." (lone lowercase). The dominant pattern is exemplary and specific: "e.g. Rent, Netflix":1634, "e.g. KBC Checking or an IBAN":37, "e.g. Groceries vs Transport":635, "0.00":867.
  - Fix: "e.g. 85.00", "e.g. Argenta", "sk-... (from your provider dashboard)", "Filter rows...".

- [ ] **The app's only gradient text is a financial figure — the headline number fades into `muted-foreground`** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - `apps/frontend/src/components/dashboard/BankBalancesWidget.tsx:165` — `text-3xl font-bold tabular-nums bg-gradient-to-br from-foreground to-muted-foreground bg-clip-text text-transparent` on the net-position amount. `bg-clip-text` gradient headings are the canonical generated-UI signature; here it's also anti-hierarchical (the most important digits render *lower-contrast* at the end) and a one-off — no other number or heading in the app gets this treatment (repo-wide grep: this is the sole `bg-clip-text`).
  - Fix: solid `text-foreground` like every sibling KPI (NetSummaryCard, StatCard); if a lux treatment is wanted for hero figures, design it once as a system (e.g. the champagne `--accent` on the currency symbol) — not a gradient fade on one widget.

- [ ] **Gain/loss card-wash gradient has four dialects despite `TrendHue` declaring itself the single source of truth** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - `apps/frontend/src/components/shared/TrendHue.tsx:3-7` defines the wash as `from-gain/10 to-gain/5` ("the single source of truth for the card tint") and is used by 4 surfaces — but siblings inline their own stops: `components/statistics/SummaryCards.tsx:67-69` `/20→/5 + ring`, `components/dashboard/StatCard.tsx:31-33` `/20→/10`, `components/dashboard/NetSummaryCard.tsx:57` duplicates TrendHue's exact gradient inline instead of rendering it, `pages/portfolio/RealEstatePage.tsx:190` `/15→/5`, `pages/portfolio/StocksPage.tsx:226` `/20→/5`. Same meaning, four intensities — the tint reads as accident, not signal.
  - Fix: give `TrendHue` an `intensity` prop (`subtle` = 10/5 card wash, `strong` = 20/5 icon-tile fill) and route all six sites through it; inline `from-(gain|loss)/` outside TrendHue becomes the grep guard.

- [ ] **`glass-thin` is a fully-maintained material tier with zero consumers, while three surfaces hand-roll exactly what it's for** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - `apps/frontend/src/index.css:205,404-407,888,933-939` define, fallback, hairline, and fx-reduce `.glass-thin` — but `grep -rn "glass-thin" --include=*.tsx` → 0 hits. Meanwhile `features/ai-chat/ChatComposer.tsx:71` (`bg-background/40 … backdrop-blur-sm`), `features/ai-chat/ToolResultCard.tsx:135` (`bg-muted/40 backdrop-blur-sm` sticky header), and `components/layout/AppSidebar.tsx:301` (`bg-sidebar-accent/60 … backdrop-blur-sm`) improvise ad-hoc thin glass with raw utility combos. The 5-tier material system ships 4 tiers plus 3 bootlegs.
  - Fix: adopt `.glass-thin` at those three sites (they gain the hairline + fx-reduced handling for free) — or, if thin is genuinely unwanted, remove the tier so the system's documentation matches reality.

- [ ] **Gain/loss setting swatches hardcode dark-mode hues — in light mode the preview doesn't match what the setting produces** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - `apps/frontend/src/components/settings/sections/AppearanceSection.tsx:219,225` — inline `hsl(24 90% 62%)` and `hsl(358 82% 62%)` are the *dark* `--loss` values (`styles/skin-v2.css:30`, `styles/tokens.css:160`); the light-mode values are `24 85% 45%` / `358 74% 48%`. On the light theme the swatch shows a pastel that the UI never renders — a small honesty gap exactly where the user is choosing colors.
  - Fix: derive the swatches from the tokens (e.g. a `.amount-loss` dot inside a scoped `[data-skin]` preview, or read the mode-correct pair from `skin-v2.css`/`tokens.css` values in one shared constant).

- [ ] **Two parallel identities for the same semantic: `.amount-gain/.amount-loss` (60 uses) vs `text-gain/text-loss` (106) — plus two local re-derivations of the chart palette** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2_
  - `apps/frontend/src/index.css:901-905` defines `.amount-gain/.amount-loss` and `apps/frontend/tailwind.config.ts:75-76` maps `gain`/`loss` utilities to the same tokens — both correct, but split ~60/106 across the codebase (e.g. `dashboard/BankBalancesWidget.tsx:167` uses `amount-gain`, `statistics/SummaryCards.tsx:30` uses `text-gain`), so the next component flips a coin. Same pattern in charts: `components/statistics/CustomChart.tsx:22` and `CustomChartBuilderModal.tsx:25` each locally rebuild `Array.from({length:16}, … --chart-N)` instead of importing `components/charts/palette.ts`.
  - Fix: standardize on the Tailwind utilities (they compose with `/opacity`, `bg-`, `ring-`), shrink `.amount-*` to a deprecated alias or sweep it out; replace the two local arrays with `CHART_TOKEN_COLORS`.

- [ ] **Every table cell wraps with `[overflow-wrap:anywhere]` — long recipient/investment names break mid-word at arbitrary letters in the app's primary tables** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S3_
  - `apps/frontend/src/components/shared/VirtualDataTable.tsx:736` and `components/shared/DataTable.tsx:496` apply `whitespace-normal break-words [overflow-wrap:anywhere]` to *every* cell, so "Intervest Offices & Warehouses" can render "Warehou / ses" wherever the column edge falls — anywhere-breaking is a last-resort for unbreakable tokens (IBANs, refs), not prose names. Cells that need protection already self-defend with `whitespace-nowrap` (amounts) — the rest get typographic roulette.
  - Fix: default text columns to `truncate` + `title` attr (one-line rows keep the virtualizer's fixed row height honest too); reserve `[overflow-wrap:anywhere]` as an opt-in `col.wrap: "anywhere"` for raw-reference columns.

- [ ] **The portfolio section's headline number has two different hero compositions two clicks apart — a shared TotalValueCard and a same-named local clone** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4_
  - `components/portfolio/TotalValueCard.tsx` (liquid-glass bento: allocation split + best/worst performers + sparkline) is consumed only by `pages/portfolio/PortfolioOverviewPage.tsx:279`; `pages/portfolio/PerformancePage.tsx:430-470` defines its *own* `TotalValueCard` (different anatomy: DollarSign tile icon-right, invested/net-P&L inline row, FX attribution) for the same "total portfolio value" concept. Same name, same meaning, two visual identities on sibling pages. *(A4's dedup list didn't catch this pair; the layout drift is the user-visible half.)*
  - Fix: one hero composition with slots — the Performance page's extras (FX attribution, invested row) become optional sections of the shared card, so the portfolio's headline number always looks like itself.

- [ ] **Page-level vertical rhythm is a coin flip: 45× `space-y-6` vs 12× `space-y-8` with no rule** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4_
  - grep page roots: `space-y-6` ×45 (14 with `animate-in`) vs `space-y-8 animate-in` ×12 — e.g. TransactionsPage/PlannedPaymentsPage/OwesPage/RecipientsPage breathe at 8 while Dashboard-adjacent Accounts/Tax/Statistics/portfolio pages sit at 6; sibling pages in the same nav group differ arbitrarily. Sub-perceptual per page, but it's why the app feels subtly "differently assembled" page to page. (The half-missing `animate-in` entrance is S5's motion axis — left to it.)
  - Fix: one page-shell rhythm token (pick `space-y-6`; grant `space-y-8` only to deliberately airy pages like Dashboard, as a decision not an accident) — trivially enforced if pages share a `<PageShell>` wrapper, which would also carry the entrance animation once.

- [ ] **Skeleton screens hardcode the 4-card template even where the loaded page won't show 4 cards** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4_
  - `pages/PlannedPaymentsPage.tsx:394-401` and `pages/StatisticsPage.tsx:84-92` render `[...Array(4)]` stat-card skeletons + one big block; `pages/OwesPage.tsx:43-47` `[...Array(3)]`. The skeletons encode the scaffold, not the content — if finding 2's re-compositions land, these lie; today they already mismatch (OwesPage loads into a hero card + recipient grid, not 3 tiles).
  - Fix: derive each skeleton from the page's real loaded composition (hero-sized block where a hero renders, table-row strips where a table renders) — skeletons are part of the page's identity, not a shared placeholder.

- [ ] **19 `transition-all` stragglers inside a system that carefully enumerates properties — one overrides its own micro-lift physics** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S5_
  - Base components declare property lists (`button.tsx:8` `transition-[background-color,box-shadow,transform,color]`; `micro-lift`/`premium-frame` per-property with split fast/normal durations, `index.css:692-695,718-722`), but 19 sites use blanket `transition-all`: `pages/research/WatchlistPage.tsx:166` stacks it *on top of* `micro-lift`, replacing the curated multi-duration transition with one-size 150ms-default-ease; also `components/onboarding/OnboardingWizard.tsx:323,412,469`, `components/charts/ChartPeriodSelector.tsx:37`, progress fills (`components/portfolio/TotalValueCard.tsx:115`, `CashFlowForecastDiagnostics.tsx:262`).
  - Fix: property lists per the base-component convention (`transition-colors`, `transition-[width]` for meters); grep guard: `transition-all` → 0 outside `ui/sidebar.tsx`'s rail edge case.

- [ ] **Raw duration literals and system-adjacent one-off timings orbit the fast/normal/slow scale** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S5_
  - 46 token uses (`duration-fast` ×30, `normal` ×14, `slow` ×2) vs 15 literals: `duration-300` ×6, `200` ×3, `500` ×2 (the decorative corner-orb zooms, `components/dashboard/StatCard.tsx:45`, `NetSummaryCard.tsx:71`), `700` ×2 (`NetSummaryCard.tsx:107,112` income/expense meters), `150` ×1, `1000` ×1. Plus hardcoded ms inside the system's own utilities: `RollingNumber.tsx` 600ms, `icon-success-bounce` 600ms (`index.css:835`), `press-feedback` 90ms (`:731`), `premium-icon-action` 120ms (`:745`) — a shadow scale of 90/120/600 that no token names.
  - Fix: extend the scale honestly (`--duration-press: 90ms`, `--duration-reveal: 600ms`) and map the 15 literals onto tokens; the corner-orb zoom's motion should ride along with S2's `CardSheen` consolidation.

- [ ] **Reduced-motion coverage is excellent except for four systematic leaks — the same shimmer is gated in two places and ungated in the third** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S5_
  - `components/ui/skeleton.tsx:7` — `animate-shimmer` with no `motion-reduce:animate-none`, while the identical shimmer IS gated at `App.tsx:109` and `components/charts/ChartSkeleton.tsx:40` (and `animate-shimmer` is absent from the `index.css:977` reduced-motion block). Same leak class: all six non-dialog overlays (finding above), `components/ui/accordion.tsx:43` accordion-up/down, `input-otp.tsx:44` caret blink, and one ungated pulse `components/research/ResearchMappingDialog.tsx:233` (the other pulses correctly use `motion-safe:`).
  - Fix: add `animate-shimmer`, `animate-accordion-*`, `animate-caret-blink`, and the tailwindcss-animate `data-[state]` enter/exits to the global `prefers-reduced-motion` block in `index.css` (one CSS rule beats six per-component gates); adopt `motion-safe:` as the stated convention for decorative pulses.

- [ ] **The identity corner is three unaligned version strings and an About with no "about"** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S6_
  - `components/layout/AppSidebar.tsx:405` hardcodes "Vision v1.0" — but `packaging/electron/package.json` says 1.0.2 and `apps/frontend/package.json` says 1.0.0, so the wordmark's only version claim is already false and frozen. `components/settings/sections/AboutSection.tsx:148+` is titled "About" yet contains only an update-checker + developer toggles — the current version renders *only after* clicking "Check for updates" (`:171`); no app mark, no license line (the app is AGPL-3.0), no repo/docs link. Electron side: bare `{ role: 'about' }` (`main.js:2895`) with no `setAboutPanelOptions` (0 hits — no copyright/website in the native panel), and the Help menu (`:2971-2977`) holds a single item. Crafted apps sign their work; this one forgot its own name-plate.
  - Fix: one build-time version constant (vite `define` from package.json) → sidebar footer + an identity header in AboutSection (VisionMark, name in Fraunces, version, AGPL-3.0 + source link); `app.setAboutPanelOptions({ applicationVersion, copyright, website })`; Help menu gains the repo/docs link.

- [ ] **The 404 is composed but characterless — the one page where the display face costs nothing skips it** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S6_
  - `apps/frontend/src/pages/NotFound.tsx:23` sets the giant "404" in `text-6xl font-bold tracking-tight` — *not* `font-display`, so the app's single largest piece of type is the only jumbo heading not in Fraunces; the tile (`:20-22`) is the flat-gradient dialect with generic `FileQuestion`, no aurora halo. Mechanics are fine (U3 verified: localized, logs the path, home CTA) — but a 404 is where personality is cheapest and most memorable, and this one is interchangeable with any dashboard template's.
  - Fix: Fraunces on the 404 numeral, EmptyState's glass-tile + halo treatment (or the VisionMark), and — since the sidebar stays alive around it — a quiet secondary link pair (Transactions · Import) under the primary CTA; keep the existing copy.

- [ ] **Table column resize is mouse-only (no keyboard or touch path)** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - `components/shared/VirtualDataTable.tsx:642-649` and `components/shared/DataTable.tsx:455-462` — resize handles are `<div onMouseDown>` with document mousemove tracking; not focusable, no keydown, and touch users get nothing (mouse events only).
  - Fix: make the handle a focusable `role="separator"` with ←/→ adjusting width (and switch to pointer events for touch); low urgency since defaults are usable without resizing.

- [ ] **VirtualDataTable puts `tabIndex={0}` on every rendered row — tab order flooded** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - `components/shared/VirtualDataTable.tsx:699` — all ~25+ mounted interactive rows are tab stops, so Tab from the search box walks row-by-row before escaping the table (arrow-key nav already exists at `:715-728`, making per-row tab stops redundant).
  - Fix: roving tabindex — only the active/first row gets `0`, others `-1`; arrows already move focus.

- [ ] **ChartPeriodSelector claims `role="tablist"`/`tab` but implements none of the tabs keyboard pattern** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - `components/charts/ChartPeriodSelector.tsx:26-34` — `aria-selected` buttons without roving tabindex, arrow-key movement, or `aria-controls`; SRs announce "tab" and users expect arrow navigation that doesn't exist. Operable (they're real buttons) but the semantics lie.
  - Fix: either drop the tab roles (plain group + `aria-pressed`) or implement roving tabindex + ←/→.

- [ ] **ChartBuilderPage indicator-period input suppresses the global focus ring** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - `pages/research/ChartBuilderPage.tsx:521-526` — `<input type="number" className="… outline-none">` overrides the global `:focus-visible` ring (`index.css:79-83`); the input is also unlabeled. (This is the only remaining `outline-none`-without-replacement on a form control found outside the already-filed TagInput case.)
  - Fix: remove `outline-none` (or add a `focus-visible:ring-2` replacement) and give it an `aria-label`.

- [ ] **VirtualDataTable filter-chip clear button has no accessible name** 🔽 *(additional instance of the already-filed icon-only-name class)*
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1_
  - `components/shared/VirtualDataTable.tsx:562-564` — the chip's `<button>` contains only an `X` icon; the chip text lives outside the button, so SRs announce "button" with no name.
  - Fix: `aria-label={t('aria.clearFilter', { name: col?.header })}`-style name.

- [ ] **59 of 248 `<Label>` uses have no `htmlFor`, and split/watchlist-search inputs have placeholder-only labels** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2_
  - Grep: 59 `<Label>` without `htmlFor` (e.g. `components/forms/AddTransactionDialog.tsx:124,136`, `components/portfolio/AddToWatchlistDialog.tsx:193,245,260,275,295`, `features/imports/ExportCard.tsx:88-119`, `components/planned/PlannedPaymentForm.tsx:162,197,219,264,288`); many wrap DatePicker/combobox components that can't accept an id at all. `components/splits/SplitTransactionDialog.tsx:192-204` amount + note inputs have no label element (placeholder-as-label), same for the watchlist symbol search (`AddToWatchlistDialog.tsx:196-201`).
  - Click-to-focus doesn't work and SRs announce unnamed fields; placeholders vanish on input.
  - Fix: plumb `id` through DatePicker/comboboxes (trigger button), add `htmlFor` everywhere, real labels (or `aria-label`) on the split entry fields.

- [ ] **PlannedPaymentForm validates with native `alert()` — the only three call sites in the app** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2_
  - `components/planned/PlannedPaymentForm.tsx:59,65,70` — blocking OS alert box (in Electron a native modal) for required-fields and loan-term errors, while the rest of the app uses toasts; the submit button is *also* disabled for the same base conditions (`:323`), so the alert paths mostly fire for the loan sub-fields.
  - Fix: replace with inline field errors or at minimum the toast pattern.

- [ ] **Delete confirms for categories/recipients don't say what happens to their transactions** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2_
  - `i18n/source/en.json:423` (`categoriesPage.delete.desc`) and `:2058` (`recipientsPage.delete.desc`) are bare "Are you sure … cannot be undone" — nothing about whether the category's/recipient's transactions are blocked, orphaned, or recategorized. Contrast the good ones: `tags.deleteConfirm` (en.json:2858, "will remove it from all transactions") and `aiChat.deleteConfirm` (en.json:274).
  - Users can't judge blast radius before confirming on entities referenced by hundreds of transactions.
  - Fix: state the consequence and include the affected-transaction count (both pages already have counts nearby).

- [ ] **Cross-page drill-downs are all `onClick` + `navigate()` — none are real links (no cmd/middle-click, no href preview)** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3_
  - `pages/RecipientsPage.tsx:392`, `pages/CategoriesPage.tsx:205`, `pages/OwesPage.tsx:235,474`, `components/statistics/CategoryPivotTable.tsx:292-377`, `pages/research/WatchlistPage.tsx:75`, `pages/research/MarketOverviewPage.tsx:997`, `pages/research/ResearchHomePage.tsx:108,193-223`, `components/dashboard/BankBalancesWidget.tsx:51`, `pages/AccountsPage.tsx:86`, `components/portfolio/InvestmentDetailDialog.tsx:141` — every entity drill-down is a programmatic `navigate()` on div/row/button click; `<Link>` appears on only 6 pages (mostly empty-state CTAs).
  - In the self-hosted web deployment, open-in-new-tab (cmd/middle-click) fails everywhere, and the status bar never previews where a click leads. (Electron is unaffected, browser use is.)
  - Fix: for pure-navigation clicks render `<Link to=…>` (or Button `asChild`), keeping `navigate()` only where the click has side effects; row-level clicks can wrap the primary cell text in a Link.

- [ ] **Dashboard stat cards and category pie invite drill-down but dead-end (only BankBalances rows navigate)** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3_
  - `apps/frontend/src/pages/DashboardPage.tsx:411-417` (last-month income / spending / transaction-count StatCards) and `:477` (CategoryPieChart) have no onClick/Link; `BankBalancesWidget.tsx:51` on the same page does navigate to filtered transactions.
  - Users click the "Last month spending" card expecting last month's expenses and nothing happens — inconsistent affordance on the app's landing page, and the equivalent filtered views already exist (`/transactions?start_date=…&end_date=…&transaction_type=expense`).
  - Fix: link StatCards to the matching pre-filtered /transactions URL and pie slices to the category drill (reuse `CategoryPivotTable`'s `buildDrillUrl` param shape).

- [ ] **ResearchMappingDialog: a failed auto-resolve masquerades as "No proposals found"** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U4_
  - `apps/frontend/src/components/research/ResearchMappingDialog.tsx:67-72` — `resolveMutation` has no `onError`, and the render at `:166-169` is `isPending ? skeleton : proposals.length === 0 ? noProposals` — a provider outage/rate-limit during the auto-resolve on open (`:79-84`) renders exactly the same "No proposals" line as a genuine no-match, steering users to conclude the instrument is unmappable.
  - Fix: add a `resolveMutation.isError` branch with the error message + the existing Re-resolve button as the retry affordance.

- [ ] **Dashboard customization silently fails to persist — applied locally, gone on next launch** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U4_
  - `apps/frontend/src/contexts/SettingsContext.tsx:85-88` (dashboardSettings persist → `logger.error` only) and `hooks/useWidgetVisibility.ts:40-44` (widget hide/show persist → `logger.error` only), while app settings got exactly this treatment fixed via the save-error nonce toaster (`contexts/AppSettingsContext.tsx:84-120`). The change appears applied (local state updates), then silently reverts on the next launch.
  - Fix: route both through the same save-error nonce/toast pattern as appSettings.

- [ ] **Price data age is invisible until the 24h stale threshold — no "as of" anywhere on portfolio values** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U4_
  - `apps/frontend/src/components/portfolio/StalePriceIndicator.tsx:23-25` returns null unless `isPriceStale` (24h fixed threshold, `utils/priceStaleness.ts:8`; manual-provider holdings are never flagged), and `price_updated_at` is rendered nowhere else (grep: only StocksPage:344 / CryptoPage:256 pass it, both into this indicator). Portfolio Overview/Net Worth totals carry no timestamp at all.
  - During a market day the user cannot tell 5-minute-old from 23-hour-old prices, and totals give no cue when they were last computed — notable for an app whose refresh is manual.
  - Fix: a small "prices as of <time>" caption (oldest `price_updated_at` among live-provider holdings) near the portfolio total, plus the same in the holdings-table header tooltip.

- [ ] **A handful of number displays use the browser locale instead of the app numberFormat setting** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5_
  - `features/ai-chat/ToolResultCard.tsx:68-69` (`value.toLocaleString()` / `toLocaleString(undefined,…)` for every numeric cell in AI-chat tool result tables), `pages/portfolio/RebalancePage.tsx:92` (percent), `pages/DbMaintenancePage.tsx:70,87,91` (admin timestamps + row counts). Separately, six statistics charts hand-build axis ticks as `` `${currencySymbol}${(v/1000).toFixed(0)}k` `` (`NetTrendChart.tsx:40`, `TopRecipientsChart.tsx:60`, `CategoryTrendChart.tsx:63`, `MonthlyChart.tsx:92`, `YearlyComparisonChart.tsx:38`, `CustomChart.tsx:249`) even though the same hook already exposes locale-aware `formatCompact` (`hooks/useChartCurrencyFormatter.ts:45-48`) — symbol-first ordering and dot decimals regardless of locale.
  - Users whose OS locale differs from their in-app numberFormat get inconsistent grouping/decimal separators between AI-chat tables, rebalance %, and the rest of the app.
  - Fix: pass `numberFormatToLocale(appSettings.numberFormat)` at the three toLocaleString sites; switch the axis ticks to `formatCompact(v).display`.

- [ ] **Two period-selector implementations: shared ChartPeriodSelector vs four bespoke RANGES button rows — different casing, options, and translation** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5_
  - `components/charts/ChartPeriodSelector.tsx:1-4` is documented as "segmented time-range control shared by every chart … One look, one feel" and is used with translated labels (`pages/portfolio/PerformancePage.tsx:107-114,210-214`, NetWorthPage). But `pages/research/MarketLookupPage.tsx:36-44,425-433`, `pages/research/ResearchComparePage.tsx:31-37`, `pages/research/ChartBuilderPage.tsx:25-31`, and `components/portfolio/WatchlistChartDialog.tsx:28-33` each define their own RANGES array rendered as default/ghost Buttons.
  - Visible drift: portfolio charts show a muted segmented control labeled `1m 3m 6m 1y 3y All` (localized), research charts show pill Buttons labeled `1M 3M 6M 1Y 5Y` (+`1D/5D/MAX` on Market Lookup only, untranslated) — different look, casing, and option sets for the same concept, sometimes one navigation step apart.
  - Fix: render the research/watchlist range pickers through `ChartPeriodSelector` (it's generic over the period type), with `t()`-backed labels; keep the per-page range values.

- [ ] **Terminology drift: "Investment" vs "Holding" for the same entity — including one control whose key says investment and label says holding** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5_
  - `i18n/source/en.json`: 55 values say "investment", 35 say "holding", across the same features. Same-surface clashes: portfolio page has section "Holdings" (`portfolio.holdings`, en.json:1787) opened by button "Add Investment" (`portfolio.addInvestment`:1741); `combobox.investment.placeholder` (:473) reads "Select a holding..."; delete flow says "Delete Investment" (:1772) while move flow says "Move '{holding}'" (:1799); accounts pages are all-holdings (`accounts.close.transferTo`:16), Net Worth mixes both (:1270-1273).
  - Users meet two names for one thing, and translators must guess whether the distinction is intentional (nl parity drift compounds it).
  - Fix: pick one term per audience surface (suggest "holding" for positions-in-an-account contexts, "investment" for the instrument entity), document it in `docs/glossary.md`, and sweep en+nl values — keys can stay.

- [ ] **Button/title case drift: newer features use sentence case, core dialogs use Title Case** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5_
  - Measured on "Add …" labels in `i18n/source/en.json`: Title Case ×16 ("Add Investment":153, "Add Transaction":880, "Add Category":392, "Add Recipient":2015, "Add Payment":1548, "Add Pattern":1988, "Add Person":2684, "Add Entry":1444, "Add All":1547…) vs sentence case ×10 ("Add account":2, "Add row":707, "Add sleeve":1943, "Add part":2670, "Add residence":3046, "Add to Watchlist" mixed:217). The split tracks feature age — accounts/rebalance/db-editor/splits (2026 work) went sentence-case against the older Title-Case core.
  - Adjacent dialogs visibly disagree ("Add account" next to "Add Transaction" in the same header area).
  - Fix: pick one convention (sentence case matches the Apple-refine direction), add it to the i18n skill/docs style note, and sweep en.json button/title values (nl mostly already reads sentence-case naturally).

- [ ] **Tax "frozen year" sky palette (and admin yellow) lack dark-mode variants — low-contrast in dark theme; rest of the app is raw-palette-clean** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5_
  - No `dark:` pair on: `components/tax/TaxYearSwitcher.tsx:89` (`text-sky-600`), `:112` (`text-sky-700 border-sky-500/40`), `components/tax/YearComparisonCard.tsx:168,198`, `components/tax/YearActionsMenu.tsx:84`, `components/tax/MultiYearTrendStrip.tsx:121`, `components/tax/HistoricalYearBanner.tsx:37,44`, `components/tax/SnapshotHistoryDialog.tsx:36` (`text-sky-700` badge) — sky-600/700 on the dark background is well under 4.5:1 for the tiny snowflake/badge text. Same class of miss: `pages/DbMaintenancePage.tsx:90` (`text-yellow-600`). Counterexamples in the same folders pair correctly (`features/accounts/MergeAccountDialog.tsx:74`, `pages/admin/EndpointLivenessPage.tsx:17`).
  - This CLOSES the 2026-06-30 "raw palette not re-checked" item with specifics: repo-wide there are ZERO raw gray/white/black text/bg classes and only ~28 colored-palette sites, most correctly dark-paired — the frozen-year sky family is the main gap.
  - Fix: add `dark:text-sky-400` (and `dark:text-yellow-400` on DbMaintenance) or fold the frozen-year styling into a semantic token like the gain/loss pair.

- [ ] **Hover-revealed row actions on touch rely on undiscoverable sticky tap-hover** 🔽 *(touch delta of the U1 keyboard finding — same sites)*
  - ↪ _from: UI/UX research 2026-07-03 · Wave U6_
  - The `opacity-0 group-hover:opacity-100` action clusters (U1's list: `pages/portfolio/StocksPage.tsx:380`, `CryptoPage.tsx:285`, `features/ai-chat/ChatConversationList.tsx:140`, `components/shared/AttachmentPanel.tsx:74`, `VirtualDataTable.tsx:622`, `DataTable.tsx:435`) only appear on touch after a first tap sets the browser's emulated :hover on the row — nothing signals this, and the first tap may trigger the row's own handlers. U1's fix (`focus-visible`/`group-focus-within`) does not help touch.
  - Fix: additionally reveal on coarse pointers — Tailwind `[@media(pointer:coarse)]:opacity-100` on the same elements (or `pointer-coarse:` plugin variant), keeping the hover choreography for mouse users.

- [ ] **Sub-40px touch targets on repeated small controls — against the app's own 40px `icon-touch-target` convention** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U6_
  - `index.css:765` defines a 2.5rem `icon-touch-target` used in 21 files (good), but misses: `components/charts/ChartPeriodSelector.tsx:24-37` period pills (`px-2 py-1 text-xs` ≈ 24px tall, on every chart); `components/shared/TagInput.tsx:60-67` tag-chip remove × (12px icon in an unpadded button); `components/shared/VirtualDataTable.tsx:562` filter-chip clear × (icon-only, no padding); `pages/admin/TableDataEditorPage.tsx:419,446,490,495` h-6/h-7 icon buttons; checkbox is 18px (`components/ui/checkbox.tsx:14`) with click area not extended by labels where `htmlFor` is missing (59 sites, filed in U2).
  - Fix: extend hit areas without visual growth (padding + negative margin, or `before:` pseudo-element ≥40px) on the chip ×s and period pills; admin-page buttons are desktop-only and can stay.

- [ ] **105 arbitrary `text-[10px]`/`text-[11px]` sites ignore browser font-size scaling** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U6_
  - Grep: 105 occurrences across portfolio/research/tax/AI-chat surfaces (e.g. `pages/portfolio/PerformancePage.tsx:388,490,533,546`, `features/ai-chat/ToolResultCard.tsx:134,291`, `pages/TaxOverviewPage.tsx:498,723`). Tailwind's `text-xs` is rem-based and honors the user's browser font-size preference; `text-[10px]` is frozen — users who raise their default font size get a UI where body text grows but these micro-labels (often the data-bearing ones: table cells in ToolResultCard, chart annotations) stay at 10px.
  - Fix: define a rem-based `text-2xs` (0.6875rem) token in `config/tailwind` and sweep the arbitrary px values onto it / `text-xs`.

- [ ] **Hardcoded English `aria-label`s in shared UI primitives override already-correctly-localized visible text — Dutch screen-reader users hear English, not just "alongside" it** 🔽 🔧 *(severity nuance: this is worse than "tooltip stays English")*
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `components/ui/pagination.tsx:56,72` (`aria-label="Go to previous/next page"`), `components/shared/SectionLoader.tsx:11` (`aria-label="Loading"`), `components/ui/sidebar.tsx:246,249` (`aria-label`/`title="Toggle Sidebar"`)
  - These hardcoded labels sit on elements whose **visible text is already correctly localized** via `t('pagination.previous'/'next')`. Per accessible-name computation rules, an explicit `aria-label` overrides visible text content for the accessible name — so a Dutch screen-reader user hears the English label instead of the correctly-localized Dutch text that's right there on screen, not merely "in addition to" it. (i18n coverage is otherwise excellent — full `en`/`nl` key parity — these are the exception.)
  - Fix: add `common.loading`, `pagination.previous/next`, `sidebar.toggle` keys to both locale files, regenerate, swap literals for `t()`.

- [ ] **Net Worth hero card has a large empty lower region** 🔽
  - ↪ _from: UI clutter review 2026-07-01 · Minor / cosmetic_
  - `apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx` — the top-left "Net Worth" card is height-matched (grid) to the 3-card right column (Liquid Assets / Investments / Liabilities) but only its top ~15% is filled (value + "+x this month"), leaving a big void inside the card.
  - Fix: don't stretch the hero to the right column's height, or add content (mini trend/sparkline) to fill it.

- [ ] **`/recipients` repeats its title verbatim** 🔽
  - ↪ _from: UI clutter review 2026-07-01 · Minor / cosmetic_
  - `apps/frontend/src/pages/RecipientsPage.tsx` — the `PageHeader` H1 "All Recipients / 53 recipients" is immediately repeated as the card header right below it (identical text + count). Redundant stacked titles.
  - Fix: drop or differentiate the inner card header (e.g. omit it, or use it only for the toolbar).

- [ ] **`/ai-chat` shows the Ollama status twice** 🔽
  - ↪ _from: UI clutter review 2026-07-01 · Minor / cosmetic_
  - `apps/frontend/src/pages/AIChatPage.tsx` panel subtitle "Local AI model unreachable" duplicates the `features/ai-chat/OllamaStatusBanner.tsx` warning banner text directly below it.
  - Fix: keep the actionable banner (Retry / Setup guide); drop the duplicate subtitle status line.

- [ ] **The global "upcoming payments" notification renders on *every* page (~150px, 3 rows)** 🔽 *(same root cause already noted at the AI-insight section above)*
  - ↪ _from: UI clutter review 2026-07-01 · Minor / cosmetic_
  - `apps/frontend/src/components/layout/AppLayout.tsx:218-219` mounts `FxStatusBanner` + `UpcomingPaymentsNotification` above every page with no priority/arbiter, so any page-specific banner stacks beneath it. This is the stacking vector; see the existing note that `SuggestionCard` was removed once (commit `6785a3eb`) for exactly this "already covered on every page" redundancy.
  - Fix: consider a single notification arbiter/host so at most one advisory shows at a time (would also bound the `/planned` and portfolio stacks above). Design-level, not urgent.

- [ ] **RecipientInsightsPage is unrouted dead code — insights only exist as a Statistics tab** ⏬
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3_
  - `apps/frontend/src/pages/RecipientInsightsPage.tsx` — absent from the route table (`App.tsx:184-232`); its only importers are two test files (`pages/__tests__/RecipientInsightsPage.integration.test.tsx`, `LanguageSwitch.integration.test.tsx`), while the live UI ships `components/statistics/RecipientInsightsTab.tsx`.
  - No user impact today, but it's an IA trap for maintainers (two divergent insights implementations) and its integration tests exercise a page nobody can reach.
  - Fix: delete the page + retarget its tests at `RecipientInsightsTab`, or route it and link it from RecipientsPage rows.

- [ ] **Amount-display drift: Money micro-typography on half the surfaces, plain strings on the rest — and two different minus glyphs between the two biggest lists** ⏬
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5_
  - `components/shared/Money.tsx` (Apple-Wallet treatment: raised small symbol, dimmed decimals) is used in 13 files (transactions table/quick-look, dashboard, planned, owes, performance) while 36 files render plain `formatCurrency`/`useCurrencyFormatter` strings for the same kind of figure (`pages/portfolio/StocksPage.tsx:77`, `pages/AccountsPage.tsx:31`, statistics, tax). Sign glyphs also differ: `features/transactions/components/TransactionsTable.tsx:230` prefixes ASCII `'-'` while `pages/PlannedPaymentsPage.tsx:218`, `components/planned/ExecutionHistoryDialog.tsx:152`, `LinkTransactionDialog.tsx:261`, `MatchSuggestionsBanner.tsx:46` prefix typographic `'−'` (U+2212) around the identical `<Money amount={Math.abs(…)}>` pattern.
  - Transactions and Planned Payments — visually adjacent money lists — hyphenate negatives differently; portfolio tables look flatter than transaction tables for no reason.
  - Fix: pick one glyph (Money already supports `signed` via Intl `signDisplay` — use it and drop the manual prefixes), and adopt Money in the portfolio/accounts tables as a follow-up polish pass.

- [ ] **Dialog field grids (`grid-cols-2`/`grid-cols-3`) never collapse at phone widths** ⏬ *(needs live viewport check)*
  - ↪ _from: UI/UX research 2026-07-03 · Wave U6_
  - Non-responsive multi-column form rows inside dialogs: `components/forms/AddTransactionDialog.tsx:97,112`, `components/planned/PlannedPaymentForm.tsx:142` (`grid-cols-3`), `components/tax/profile-steps/IncomeStep.tsx:138` (`grid-cols-3`), `features/accounts/AddAccountDialog.tsx:182,225,266`, `components/portfolio/InvestmentFormFields.tsx:81-360` (8 rows), `EditPortfolioTxnDialog.tsx:182`, `AddPortfolioTxnDialog.tsx:170` — at 375px each column gets ~100-160px, so labels truncate and date/select triggers compress; still operable, just cramped (hence lowest priority given desktop-primary use).
  - Fix: `grid-cols-1 sm:grid-cols-2` (resp. `sm:grid-cols-3`) on the dialog field rows.

- [ ] **`/import` is a single narrow centered column — wide empty side margins on desktop** ⏬
  - ↪ _from: UI clutter review 2026-07-01 · Minor / cosmetic_
  - `apps/frontend/src/pages/ImportPage.tsx` — all sections (CSV/Recipients/Categories import, Export, History, Supported Banks) stack in one ~680px centered column, leaving large empty left/right gutters at ≥1440px. Cosmetic; a deliberate form-centering choice.
  - Fix (optional): widen the column, or use a 2-column arrangement for the independent import blocks.

### 🏛️ Architecture & API

- [ ] **Repository layer cannot participate in transactions — transactional services bypass it with raw SQL** 🔺
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `withTransaction(fn)` hands out a client (`apps/node-backend/src/database/connection.js:126`) but only 4 repository functions in the whole layer accept a client (`repositories/plannedTransactionRepository.js:51,80`, `repositories/splitRepository.js:477`, `repositories/transactionRepository.js:61`). Consequently every multi-step write service inlines raw SQL against the client instead of calling repos: `services/accountMergeService.js:28-60`, `services/recipientMergeService.js:50-80`, `services/transferReconciliationService.js:96,152,190`, `services/portfolio/moveHoldingService.js:84`, `services/importPipeline/commit.js:73`. 37 service files import `database/connection.js` directly, so the service→repository boundary of ADR-006/ADR-067 exists only for simple CRUD paths.
  - fix: adopt an optional `client` (or `db = pool`) last-parameter convention on repository methods so services compose repos inside `withTransaction` instead of duplicating table SQL.

- [ ] **Half-finished components/→features/ migration leaves two competing feature-location conventions plus a layering inversion** 🔺
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: docs/architecture/frontend-architecture.md:29-34 states dialogs/forms are "organized by feature in `features/`", but only 7 features moved (accounts, ai-chat, categories, imports, portfolio, recipients, transactions) while 10 equally feature-shaped dirs remain in `components/` (portfolio 27 files, tax 20, statistics 19, settings 13, dashboard 9, planned 7, research 7, splits, reports, onboarding). `features/portfolio/` holds exactly 1 file (MoveHoldingDialog.tsx) vs `components/portfolio/` 27 — split-brain for one feature. Layering inverts: apps/frontend/src/components/portfolio/InvestmentDetailDialog.tsx:19 imports `@/features/portfolio/MoveHoldingDialog` and components/onboarding/OnboardingWizard.tsx:21 imports `@/features/imports/CsvDropzone`. `components/forms/` is a legacy stub whose only component (AddTransactionDialog.tsx) is consumed from features/transactions/components/TableActions.tsx.
  - fix: pick one rule (feature dirs live in `features/`, `components/` = truly shared), move the 10 stragglers (start with portfolio to heal the split-brain), and lint-ban `components/* → features/*` imports.

- [ ] **DataTable is an 611-line near-duplicate of VirtualDataTable kept alive for a single consumer** 🔺
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: apps/frontend/src/components/shared/DataTable.tsx (611 lines) vs VirtualDataTable.tsx (835 lines); plain diff shows ~40% of the combined 1446 lines textually identical (858 differing) — shared search/column-filter/sort/inline-edit scaffolding maintained twice. DataTable has exactly one importer: pages/DashboardPage.tsx:9; VirtualDataTable has 6 (TransactionsTable, RecipientsPage, OwesPage, PlannedPaymentsPage, RecipientInsightsPage, SnapshotDataTable).
  - fix: port DashboardPage to VirtualDataTable (or a non-virtual mode flag) and delete DataTable.

- [ ] **ADR-067 route→service boundary has a `database/connection.js` loophole — 5 route files run raw SQL** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: eslint rule `no-repo-direct-from-route` only flags import sources containing `/repositories/` or `Repository` (apps/node-backend/eslint.config.js:41-50), so importing `query`/`withTransaction` from the database layer passes lint at ERROR level. Violators: routes/transactions.js:8 (11 SQL statements — the worst), routes/plannedTransactions.js:8 (2), routes/admin.js:17 (table stats + VACUUM, arguably legitimately DB-level), routes/attachments.js:22,61 (1 existence check), routes/info/rates.js:10,38 (FX rates SELECT). ADR-067's "all route files go through service seams" claim is therefore only true for the repository path, not the DB path.
  - fix: extend the ESLint rule to also ban `/database/` imports from `src/routes/**`, then move the offending queries behind services (grant admin.js an explicit documented exemption if desired).

- [ ] **Reverse layering: services and controller import from routes/ (portfolio cache lives in the routes layer)** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: controllers/investmentController.js:20 and services/portfolioImportPipeline/index.js:26 both do `import { invalidatePortfolioCaches } from '../routes/info/_cache.js'`. The shared response-cache module plus real business helpers (`_liveSummary.js`, `_performanceHelpers.js` with payload building) live under routes/info/, and routes/info.js:52-60 owns boot-time cache warming (`warmInfoCaches`) consumed by startup/warmup.js — a startup/service concern hosted in a route barrel.
  - fix: move `routes/info/_cache.js` (and the `_liveSummary`/`_performanceHelpers` logic) into `services/info/`, leaving routes/info/* as thin handlers; imports then all point downward.

- [ ] **Layer inversion: 13 repository→service imports, including repos that invoke a transaction-opening service** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: 8 info repos import `convertRowsToEur`/`convertToCurrency` from `services/currency/currencyConversionService.js` (e.g. `repositories/infoRepo.monthly.js:7`, `repositories/infoRepositoryNetWorth.js:9`, `repositories/infoRepositoryTags.js:17`); `repositories/infoRepositoryNetWorth.js:7` imports `computeDailySnapshots` from `services/portfolio/snapshotBuilder.js`, which itself runs `withTransaction` (`snapshotBuilder.js:659`) — a repository call can open a service-owned transaction. `repositories/transactionRepository.js:15` imports SQL-builder logic from `services/filterBuilder.js` (whose own header says it consolidates code *from* repositories), and `repositories/recipientRepository.js:16`, `repositories/splitRepository.js:15` import other service modules.
  - fix: move pure helpers (filterBuilder, textNormalization, calculations/splits) out of `services/` into `lib/`, and lift row-currency-conversion out of repositories into the info service layer.

- [ ] **Portfolio math services duplicate each other's inline SQL and bypass repositories entirely** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `services/portfolio/portfolioSummaryService.js:60-82` and `services/portfolio/snapshotBuilder.js:65-100` contain near-identical `investments` + `portfolio_transactions` loading queries (same COALESCE/`to_char(pt.date::date,'YYYY-MM-DD')`/JOIN shape, drifting only in columns/filters); neither file imports `investmentRepository` or `portfolioTransactionRepository`.
  - fix: extract one shared portfolio-rows read (in `portfolioTxRepo.reads.js`) parameterized by date window/asset-class filter and use it from both services.

- [ ] **info repository cluster is over-fragmented with two coexisting naming schemes and double barrels** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: 11 `info*` files in `repositories/` mix `infoRepositoryX.js` and `infoRepo.x.js` naming; `repositories/infoRepository.js` (barrel) re-exports `repositories/infoRepositoryMonthly.js`, which is itself only a 24-line barrel over `infoRepo.monthly.js`/`infoRepo.statistics.js`/`infoRepo.forecast.js` (see its header). Same dir also has the third scheme `portfolioTxRepo.{common,reads,writes}.js` under barrel `portfolioTransactionRepository.js:1-9`.
  - fix: pick one split convention (subdirectory `repositories/info/` with one barrel), delete the pass-through middle barrel, and rename dot-files to match.

- [ ] **No query-key factory: cache keys are ~240 inline string arrays across hooks AND components, with hand-maintained invalidation fan-out lists** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A3_
  - evidence: no `queryKeys`/factory module exists anywhere in `lib/` or `hooks/` (grep clean). Keys are ad-hoc inline arrays: `apps/frontend/src/hooks/useTransactions.ts:33` `['transactions', params]`, plus per-hook local constants with three different conventions (`QUERY_KEY` in `hooks/useCustomParserConfigs.ts:12`, `EXCHANGE_RATES_QUERY_KEY_PREFIX` in `hooks/useCurrencyConverter.ts:17`, `INVESTMENTS_QUERY_KEY` in components). Cross-domain invalidation is a hand-maintained list — `hooks/useTransactions.ts:110-122` invalidates 7 sibling keys (`transactions`, `transactions-virtual`, `monthlySummary`, `filteredDashboardStats`, `aggregations`, `dashboardRecentTransactions`, …) that every new dependent surface must remember to join; naming style also drifts (camelCase `monthlySummary` vs kebab `research-scorecard` vs `['admin','db-stats']` tuples).
  - fix: introduce a central `lib/queryKeys.ts` factory (per-domain key builders + an `invalidateTransactionData(qc)` helper) and migrate call sites mechanically.

- [ ] **Asset-class pages copy-paste ~2/3 of StocksPage even though StocksPage is already parameterized** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: pages/portfolio/MetalsPage.tsx is a 13-line wrapper passing `assetClasses`/`titleKey`/empty-state keys into StocksPage — proving the reusable shape exists — yet CryptoPage.tsx (328 lines) and SavingsPage.tsx (298 lines) duplicate the table+summary+dialog scaffolding: Stocks↔Crypto differ in only 241 of ~751 combined lines after name normalization; Crypto↔Savings 388.
  - fix: convert CryptoPage/SavingsPage (and evaluate RealEstatePage, 359 lines) to MetalsPage-style wrappers, pushing genuine deltas behind props.

- [ ] **Add/Edit dialog pairs duplicate whole form bodies instead of sharing fields** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: components/portfolio/AddPortfolioTxnDialog.tsx (321) vs EditPortfolioTxnDialog.tsx (363): ~half identical after Add/Edit name normalization (350 differing of 684) — txn-type filtering per asset class, recurrence labels, unit-math fields all repeated. components/portfolio/InvestmentFormFields.tsx (418 lines) was extracted for sharing but its only importer is AddInvestmentDialog.tsx; EditInvestmentDialog.tsx (307) re-implements the same name/symbol/provider field set inline (EditInvestmentDialog.tsx:26-63).
  - fix: extract a PortfolioTxnFormFields component and make EditInvestmentDialog consume InvestmentFormFields, keeping only mode-specific submit logic per dialog.

- [ ] **TaxOverviewPage and PortfolioTaxPage are ~700-line single-component pages mixing tax domain math with layout** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: pages/TaxOverviewPage.tsx:58 opens one component running to line 754 — taxable-income-by-month/year aggregation memos (lines ~112-140), portfolio-tax accumulation, currency formatting, and widget-visibility layout all in one function; pages/portfolio/tax/PortfolioTaxPage.tsx is 722 lines in the same shape. Domain aggregation partially lives in lib (comment cites lib/belgianTax/portfolioTax.ts) but the page-side memo chains don't.
  - fix: move the aggregation memos into a `useTaxOverviewData` hook (or lib/belgianTax) and split widget sections into components/tax/ children.

- [ ] **Domain enums hand-mirrored FE/BE despite @vision/types existing for exactly this** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: `@vision/types` (packages/types/src/index.js) ships only the envelope typedefs + `ApiErrorCode` (62+31 lines) though its package.json:5 says "shared type definitions and runtime constants". Asset classes are defined 4×: BE `apps/node-backend/src/lib/assetClasses.js:6` (`ASSET_CLASSES = ['stock','etf','crypto','metals','real_estate','savings','bond']`), BE `apps/node-backend/src/repositories/portfolioTxRepo.common.js:82` (`UNIT_BASED_ASSET_CLASSES`), FE `apps/frontend/src/types/portfolio.ts:6` (union type), FE `apps/frontend/src/utils/assetClass.ts:5,7` (same arrays incl. UNIT_BASED/FIXED_INCOME re-derived). Portfolio txn types duplicated: BE `services/portfolioImportPipeline/portfolioTypeNormalizer.js:13` vs FE `types/portfolio.ts:43` (`PortfolioTxnType`).
  - fix: move the runtime constant lists (asset classes, unit-based subsets, portfolio txn types) into `@vision/types` and make both sides' current files thin re-export shims, mirroring the money/slugify pattern already proven in `@vision/shared-utils`.

- [ ] **Three coexisting pagination conventions + six unbounded list route files** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: `@vision/types` packages/types/src/api.js:15-32 documents `meta.pagination {total,limit,page|offset,hasMore}` as THE convention, but exactly one route uses it (`apps/node-backend/src/routes/info/netWorth.js:61`). The flagship list endpoint embeds pagination in the data body instead (`routes/transactions.js:256-262` → `{items,total,limit,offset,links}`), a shape FE re-declares ad hoc (e.g. `BatchListResponse`, apps/frontend/src/lib/api/types.ts:163). `lib/pagination.js` (`parsePagination`) is imported by only 9 of 24 route files; `investments.js:29`, `tags.js`, `savedCharts.js`, `accounts.js`, `splits.js`, `attachments.js` list endpoints take no limit/offset at all (unbounded arrays — growth smell for transactions-adjacent tables like splits/tags).
  - fix: pick one convention (meta.pagination, since it's the one the shared package documents), migrate data-embedded totals to it, and add parsePagination to the unbounded list endpoints.

- [ ] **openapi.yaml documents a 200+JSON body for 5 DELETE endpoints that actually return 204 No Content** ⏫ 🔧 *(undercounted — a 5th instance found during verification)*
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - `watchlist.js:89`, `savedCharts.js:169`, `investmentController.js:377`, `investmentController.js:483`, and **`routes/ai.js:217` (`DELETE /api/ai/conversations/:id`)** (all `res.status(204).send()`) vs. `openapi.yaml:4457-4468,2408-2418,4080-4090,4012-4022,5007-5017` (all declare 200 + Envelope body)
  - Sibling endpoints (only 2 in the whole spec: `deleteCustomParser`/`deletePortfolioParser`) correctly document 204, confirming this is inconsistent application, not deliberate.
  - Fix: update openapi.yaml to 204 for all 5 paths.

- [ ] **`GET /api/market/quote` — spec parameter name doesn't match the handler** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - `routes/marketLookup.js:264-267` reads `req.query.symbols` (plural) vs. `openapi.yaml:4294-4315` documenting singular `symbol` + an unused `currency` param; the real `detail=basic|full` param is documented in the matrix but missing from the spec.
  - A client built strictly from openapi.yaml gets a 400.
  - Fix: correct param name to `symbols`, drop `currency`, add `detail`.

- [ ] **`GET /api/transactions` — openapi.yaml documents 11 of ~25 real query params (14 undocumented, not ~6)** ⏫ 🔧 *(undercounted significantly — scope corrected)*
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - `routes/transactions.js:45-105,238` accepts `transaction_id, category_ids, recipient_group_id, recipient_name, active, include_balance, transaction_type, amount_min, amount_max, amount_exact, amount_signed, uncategorised, normalize_to_eur, target_currency` (14 params) on top of the 11 openapi.yaml documents (`limit, offset, start_date, end_date, bank_account, category_id, recipient_id, search, sort_by, sort_dir, tags`) — 25 total. `docs/api/transactions.md` has most of these correctly; openapi.yaml, the file the KB calls "authoritative," never got them. This is the most heavily-used endpoint in the app.
  - Fix: sync openapi.yaml's parameter list from `docs/api/transactions.md`.
  - Verification (2026-06-30): the original "~17 total / ~6 missing" framing was both internally inconsistent (its own missing-params list already named 13 params) and an undercount — the real total is ~25, and the original list also missed the `uncategorised` param entirely, plus cited too-narrow a line range (`normalize_to_eur`/`target_currency`/`uncategorised` are read at line 238, outside the originally-cited `:45-105`).

- [ ] **routes/transactions.js is a 680-line fat route with inline SQL construction and orchestration** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: routes/transactions.js:468-492 builds `SET` clauses and runs `UPDATE transactions … RETURNING` inside the handler; :318-360 resolves tag slugs and does `INSERT INTO transaction_tags … unnest/CROSS JOIN` inline in `withTransaction`; :168-205 name→id resolution SQL; :594-597 post-create auto-link orchestration. This is exactly the repository/service work ADR-067 moved out of every other route.
  - fix: extract bulk-update/bulk-tag/name-resolution into `transactionService` (or a `transactionBulkService`) and shrink the route to validate→call→`res.ok`.

- [ ] **controllers/ is a one-file orphan layer that dodges the boundary rule** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: controllers/investmentController.js (524 lines) is the only controller in the codebase; its exports are `(req, res)` Express handlers with 17 `res.ok()` calls (e.g. :180-201, :253-254), i.e. route code by another name — but because it sits outside `src/routes/**` the ESLint files-glob (eslint.config.js:118) never applies, so its direct `investmentRepository`/`portfolioTransactionRepository` imports (:14-15) are unlinted. routes/investments.js is a thin dispatch table over it.
  - fix: consolidate toward the codebase-wide pattern — extract the logic into `services/investmentService.js` (+ existing services/portfolio/*), turn the handlers into routes/investments.js bodies, and delete controllers/; alternatively at minimum add `src/controllers/**` to the ESLint boundary glob.

- [ ] **Duplicated, semantically divergent name→id resolution between transactions and planned-transactions routes** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: routes/transactions.js:168-205 matches recipients on `normalized_name` and **throws ValidationError** on unknown names; routes/plannedTransactions.js:~44-75 reimplements the same pair of helpers matching on `UPPER(name)` and **silently drops** unknown names. Both mutate `fields` via in-place `delete fields.recipient_name` — the documented PATCH pattern mandates immutable destructuring (docs/reference/code-patterns.md "PATCH sanitization", never in-place delete).
  - fix: one shared service-level `resolveNamesToIds(fields, {strict})` used by both routes, returning a new object.

- [ ] **middleware/validation.js is 90% pure helpers, and repositories import from middleware/** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: of its 10 exports (middleware/validation.js:49-154) only `validateIdParam` is Express middleware; the rest (`sanitizeUpdateFields`, `validateId`, `assertYmd`, `validatePagination`, …) are pure validators. repositories/transactionRepository.js:14 and repositories/plannedTransactionRepository.js:8 import `sanitizeUpdateFields` from middleware/ — the data layer depending on the HTTP-middleware layer.
  - fix: move the pure validators to `lib/validation.js` and keep only `validateIdParam` in middleware/.

- [ ] **Repository export/API style split: 19 of 42 files abandon the documented default-export-object pattern** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `docs/reference/code-patterns.md:369+` prescribes a default-exported `entityRepository` object with `getAll/getById/create/update/hardDelete` and `rows[0] || null`. 19 repo files have no default export and use loose named functions with divergent verbs: `importBatchRepository.js:15,52` (`listBatches`/`getBatch`), `providerApiKeyRepository.js:15,27,43` (`listAll`/`upsert`/`remove`), `rawTransactionRepository.js:29-311` (seven per-bank repo objects + free functions). Deletion is named `hardDelete` (6), `delete` (4), `softDelete` (2), `remove` (2), `deleteById` (2) across the layer.
  - fix: document the named-function style as an accepted second form (or converge), and standardize get/list and delete verb naming in a mechanical rename pass.

- [ ] **Business/validation logic living inside repositories** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `repositories/portfolioTxRepo.common.js:271` (`validateSellUnitsAvailability`) plus `normalizeTransactionPayload` per its header — domain validation/normalization in the repo layer; `repositories/splitRepository.js:18` is the only repo importing HTTP-flavored `ValidationError/NotFoundError` from `middleware/errorHandler.js` and also owns audit writing (`splitRepository.js:477`); `repositories/plannedTransactionRepository.js:507` (`updateWithLoanSchedule`) coordinates a multi-entity write that belongs in a service.
  - fix: hoist validation/normalization and audit orchestration into the corresponding services, leaving repos as parameterized SQL only.

- [ ] **YMD date helpers re-implemented locally ~15 times despite canonical lib/timezone.js** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `lib/timezone.js:96-137` exports `toAppDateString/todayAppDateString/addDaysYmd`, yet local UTC-slice helpers recur: `services/plannedMatchService.js:33,45` (`toYmd`,`ymdDiffDays`), `services/quoteBackfillService.js:348` (`_daysBetween`), `services/aiChat/tools/planned.js:30`, `services/prices/priceCache.js:33`, `services/research/quotaGovernor.js:42`, `services/research/adapters/finnhubAdapter.js:28`, `services/calculations/forecast/_densify.js:24`, `services/calculations/forecast/methods/prophetLite.js:109`, plus inline `toISOString().split('T')[0]` in `deduplication.js:13,44`, `recurringDetectionService.js:251`, `importPipeline/adapters/revolut.js:69`.
  - fix: add `ymdDiffDays`/`msToYmdUtc` to `lib/timezone.js` (or a `lib/ymd.js`) and sweep the local copies.

- [ ] **Two import pipelines are parallel-evolution clones with no shared machinery** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `services/importPipeline/{stage,validate,commit,index}.js` and `services/portfolioImportPipeline/{stage,validate,commit,index}.js` mirror each other file-for-file — same `STAGE_INSERT_CHUNK = 500`, same batch-row lifecycle (`importPipeline/stage.js:1-30` vs `portfolioImportPipeline/stage.js:1-30`), duplicated createBatch/chunked-insert/status-transition scaffolding against parallel `import_batches`/`portfolio_import_batches` tables.
  - fix: extract shared staging/batch-lifecycle helpers (chunked insert, batch create/transition) parameterized by table names; keep domain validate/commit logic separate.

- [ ] **Service error signaling is a four-way mix** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: services throw 53 `ValidationError`/14 `NotFoundError`/5 `ConflictError` (from `middleware/errorHandler.js:22-71`) but also 40 generic `Error` — concentrated in `services/attachmentService.js` (5), `services/prices/priceProviderRegistry.js` (5), `services/dataImportService.js` (3), research adapters — plus two parallel hierarchies that do NOT extend `AppError`: `services/aiChatService.js:29` (`AiChatServiceError`) and `services/aiChat/tools/_validate.js:11` (`ToolValidationError`), which need bespoke handling instead of the central error middleware mapping.
  - fix: make the aiChat error classes extend `AppError` and convert user-facing generic `Error` throws to typed errors; reserve bare `Error` for programmer errors.

- [ ] **Server-state queries defined inline in components/pages instead of hooks (146 `useQuery` call sites outside hooks/)** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A3_
  - evidence: `grep -rn 'useQuery' components pages features` (excl. tests) = 146 hits with 93 inline `queryKey:` literals, e.g. `["research-scorecard", symbol]`, `['admin','provider-health']`, `["recipient-insights", …]` — versus the documented pattern (docs/reference/code-patterns.md:667-749) of domain hooks wrapping `useQuery`. Two layering conventions coexist with no rule for which applies; the admin/research surfaces mostly skip the hooks layer entirely. (Import-pattern check only — component internals are Wave A4.)
  - fix: adopt a rule ("every server resource gets a hook in hooks/ or features/*/hooks/") and fold the admin/research inline queries into hooks as they're touched; pairs with the key factory above.

- [ ] **BelgianTaxProfileContext is a 611-line context holding server-persisted domain state, exempt from both the zustand consolidation and React Query** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A3_
  - evidence: `apps/frontend/src/contexts/BelgianTaxProfileContext.tsx:1-100` — profile + per-year snapshots + audit metas persisted via `apiClient` with hand-rolled debounced saves (same machinery Settings/AppSettings/Theme had before `stores/settingsStore.ts:1-16` consolidated them); it stayed a raw context providing ~15 values (profile, calculation, snapshots, snapshotMetas, viewedYear, …) so any consumer re-renders on all of them. It also acts as a barrel, re-exporting ~25 pure-lib symbols (`BELGIAN_TAX_BRACKETS` etc.) at lines 44-85 behind an eslint-disable for react-refresh.
  - fix: move the persisted blob into the settings store (or React Query on the settings key) with the existing provider-for-side-effects pattern, and point constant importers at `@/lib/belgianTax` directly.

- [ ] **VirtualDataTable is a ~25-prop god-component and TransactionsTable forwards ~29 props through it** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: apps/frontend/src/components/shared/VirtualDataTable.tsx props interface spans ~25 props with two operating modes multiplexed (local-sort vs server-sort via `onSortChange`/`sortKeyProp`/`sortDirProp`; local vs server search) plus 8 row-interaction callbacks. features/transactions/components/TransactionsTable.tsx declares ~29 props, most drilled untouched from pages/TransactionsPage.tsx:425 into VirtualDataTable (search, pagination, sort, suggestions).
  - fix: split into a table core + a `serverMode` config object (or context provider for search/sort/pagination) so intermediate components stop re-declaring the pass-through surface.

- [ ] **ImportReviewPage and TableDataEditorPage orchestrate 4-5 inline mutations each — worst pages/ data-layer offenders** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: pages/ImportReviewPage.tsx:96-117 (1 useQuery + 4 useMutations: override, categoryOverride, persistDefault, commit) and pages/admin/TableDataEditorPage.tsx:161-267 (useQuery + preview/commit mutations amid a 544-line page); pages/research/{WatchlistPage,ResearchHomePage,MarketLookupPage}.tsx each hold 5 query/mutation sites. Complements A3's inline-useQuery count — these are the pages where a feature module (`features/imports` already exists next door) would absorb the most.
  - fix: move ImportReviewPage's query+mutations into features/imports hooks; give admin/research thin data hooks per page.

- [ ] **MarketOverviewPage carries ~850 lines of static market-view config inside the page file** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: pages/research/MarketOverviewPage.tsx is 1111 lines but the component starts at line 929; lines 46-916 are constant data (`REGION_VIEWS` at :46, `SECTOR_VIEWS` at :323, option tables at :893-916). Cohesive logic, wrong altitude — config swamps the code.
  - fix: move the view/option constants to a `marketViews.ts` data module beside the page.

- [ ] **FE hand-written DTOs live in three homes; contract-guard covers only one** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: hand types split across `apps/frontend/src/types/api.ts` (594 lines, guarded by `types/contract-guard.ts:25-35` against generated.ts), `types/{portfolio,research,watchlist,splits,aiChat}.ts` (~760 lines, unguarded), and `lib/api/types.ts` (177 lines, unguarded, imported by 9 modules vs 29 for types/api). Structural duplicate found: `MarketNewsArticle` (lib/api/types.ts:170-177) is field-identical to `ResearchNewsArticle` (types/research.ts:128-135).
  - fix: consolidate lib/api/types.ts into types/ (one DTO home) and extend contract-guard assertions to the portfolio/research families; delete the MarketNewsArticle duplicate.

- [ ] **Root config/ is half-dead: orphaned drifted copies of frontend configs** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: `config/tailwind.config.ts` (96 lines, last commit 2026-03-10 a63216eb), `config/eslint.config.js` (27 lines), `config/tsconfig{,.app,.node}.json`, `config/postcss.config.cjs`, `config/components.json` are referenced by nothing — the frontend carries its own actively-maintained copies (apps/frontend/tailwind.config.ts 191 lines, last commit 2026-06-24 6785a3eb; eslint 52 lines) that neither extend nor import them. CLAUDE.md documents `config/` as "shared tsconfig/vite/eslint/tailwind", which is false today; the directory also holds genuinely load-bearing files (`config/alembic.ini` via root package.json:37-42, config.py, gitleaks.toml, commitlint.config.mjs), so live and dead configs are interleaved.
  - fix: delete the dead frontend-config copies (or make apps/frontend actually extend them) and correct the CLAUDE.md description of config/.

- [ ] **Recurrence vocabulary forked: 'bi-weekly' vs 'biweekly', plus in-FE duplicate enum** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: portfolio recurrence uses `'bi-weekly'` (apps/frontend/src/types/portfolio.ts:63, types/api.ts:348 — identical `RecurrenceInterval` declared twice in FE — and generated.ts:3352), while planned-transaction recurrence uses `'biweekly'` (apps/node-backend/src/services/calculations/recurrence.js:20 `SUPPORTED_PATTERNS`, FE hooks/usePlannedPayments.ts:22). Two hand-maintained vocabularies for the same concept, differing only in a hyphen — a standing trap for anyone unifying planned/portfolio recurrence.
  - fix: define one shared recurrence-token list in `@vision/types` (breaking-change note: aligning the wire value needs a compat mapping) and delete the duplicate FE declaration.

- [ ] **`PATCH /api/investments/{id}` — accepted `show_in_ticker` missing from the request schema** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - `investmentController.js:359-371` forwards `req.body` (upserts `show_in_ticker` per `docs/api/investments.md:246-251`) vs. `openapi.yaml:4051-4067`'s PATCH body, which lists only `name, symbol, asset_class, currency, is_active`
  - A prior commit added `show_in_ticker` to the **response** schema but never the request schema — a half-finished fix.
  - Fix: add `show_in_ticker: boolean` to the PATCH requestBody schema.

- [ ] **`POST /api/investments/{id}/move` — undocumented `strategy` field** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - `investmentController.js:452-458` reads `strategy` (`'fifo'|'proportional'`) vs. `openapi.yaml:4217-4232` documenting only `from_account_id, to_account_id, units`.
  - Fix: add `strategy` enum to the requestBody schema.

- [ ] **`api-endpoint-matrix.md` self-contradicts on operation count, invisible to CI** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - Frontmatter says 211 (`:11`, confirmed currently correct/CI-verified by running `scripts/check-endpoint-matrix.js` directly), body text says "210" (`:20`), Summary table sums to 219 but omits the Cross-Workspace group entirely (despite it existing correctly at `:45-49` and in openapi.yaml). The check script only validates the frontmatter number, never the body text or table.
  - Fix: fix body text to 211, add the missing Cross-Workspace row; consider extending the CI script to validate the table total too.
  - Verification (2026-06-30): found a bonus instance of the same disease while re-checking — the matrix's Aggregations section header says "(15 endpoints)" (15 actual rows counted), but the Summary table row for Aggregations says 14.

- [ ] **utils/ is vestigial: one dead shim + one misfiled calculation module; lib/ vs utils/ has no actual distinction** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: utils/ contains exactly two files. utils/downsample.js is a re-export shim of `@vision/shared-utils/downsample` with **zero consumers** (the only backend LTTB call site was removed — routes/info/_performanceHelpers.js:74-76 comment). utils/portfolioMath.js is a 300+-line portfolio calculation module (computeMetrics, computeHeatmap, toYmd) consumed by services, repositories, and routes/info — functionally a `services/calculations/` module. Everything else helper-shaped lives in lib/ (17 files, all with ≥1 consumer).
  - fix: delete utils/downsample.js, move portfolioMath.js to services/calculations/ (its documented home per code-patterns.md), remove utils/.

- [ ] **One-line re-export "seam" services are aliased back to repository names at import sites** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: services/plannedTransactionService.js is solely `export { default } from '../repositories/plannedTransactionRepository.js'`, and routes/plannedTransactions.js:9 imports it as `plannedTransactionRepository` — so the seam adds a hop without changing what the route "sees"; same import-aliasing in routes/info.js:18 (`infoRepository` from infoService). The seam files themselves are intended (ADR-067), but the aliasing erases the boundary in the code readers actually read.
  - fix: rename import bindings to `…Service` at route call sites; consider making seams that stay pure re-exports for >1 release into real service modules or documenting them as permanent.

- [ ] **routes/aggregations.js hand-rolls its 400 response instead of throwing ValidationError** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: routes/aggregations.js:135 `res.status(400).json({ ok:false, error:{ code:'BAD_REQUEST', … } })` — the only hand-rolled error response in routes/ backend-wide; bypasses createErrorHandler and invents an ad-hoc `BAD_REQUEST` code (canonical typed errors emit `VALIDATION_ERROR`, middleware/errorHandler.js:41-45) and omits `meta.requestId`.
  - fix: `throw new ValidationError('days_back + days_forward must be <= 730')`.

- [ ] **routes/savedCharts.js skips the shared validateIdParam middleware on /:id routes** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: routes/savedCharts.js:125,165 declare `/:id` handlers without `validateIdParam` (used by 11 other route files per the documented route pattern); it hand-rolls `parseChartId` at :25 instead.
  - fix: add `validateIdParam` to the three `/:id` routes and drop the bespoke parser.

- [ ] **lib/parserConfigRoutes.js: route-layer helpers living in lib/** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: lib/parserConfigRoutes.js exports `parseParserId(req)` (takes an Express `req`) plus ValidationError-throwing normalizers, shared by routes/importRoutes.js and routes/portfolioImportRoutes.js — HTTP-coupled code in the "pure helpers" dir, with "Routes" in a lib filename.
  - fix: move to `services/customParserConfig…` or a shared module under routes/; lib/ should stay HTTP-agnostic.

- [ ] **Intent docs drifted from the actual error/calculation layout** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: docs/reference/code-patterns.md tells agents to import typed errors `from '../lib/errors.js'` (§Typed Error Classes) — that file does not exist; classes live in middleware/errorHandler.js:22-71. Same doc's "Migration Status (Phase 9)" still claims `services/loanRepaymentService.js`/`recurrenceService.js` are the live implementations — they are deleted and routes/plannedTransactions.js:12-13 imports `services/calculations/` directly. Doc's error envelope `{detail, error_code}` also predates the actual `{ok:false, error:{code,message}}` emitted at middleware/errorHandler.js:126-133. *(Overlaps with the 2026-06-30 §Stale docs code-patterns.md item — fix together.)*
  - fix: refresh those three sections of code-patterns.md (or actually create lib/errors.js and re-export, matching the documented layout).

- [ ] **Flat 44-file top-level services/ namespace with domain strays outside their subdirs** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `services/` top level mixes orchestrators, pure calc (`textNormalization.js`, `deduplication.js`, `bulkSelection.js`), infra (`routeManifest.js`, `materializedViewService.js`, `dbEditor.js`) and ADR-067 seams. Domain strays: `priceProviderService.js`, `providerHealthService.js`, `quoteBackfillService.js` sit beside (not in) `prices/`; `portfolioPerformanceSnapshotService.js`, `portfolioImportBatchService.js` outside `portfolio/`; `aiChatService.js` outside `aiChat/`.
  - fix: move domain strays into their subdirectories and relocate pure-calc/infra modules to `lib/` or `calculations/`; keep top level for cross-domain orchestrators and seams only.

- [ ] **Dead exports (spot-check of biggest modules)** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `services/currency/currencyConversionService.js:179` `convertToEur` has no callers anywhere in src (only `convertRowsToEur`/`convertToCurrency` are used); `services/calculations/recurrence.js:88` `getSupportedPatterns` has no callers; `services/quoteBackfillService.js:593` `refreshQuotesForInvestment` is reachable only via the orphan `controllers/investmentController.js:16` (orphan itself reported in A1).
  - fix: delete the two unused exports; fold `refreshQuotesForInvestment` removal into the A1 controller cleanup.

- [ ] **Recurrence horizon-expansion loop re-implemented per consumer** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: the step function `calculateNextDate` is properly shared, but the guard-bounded expand-to-horizon loop exists twice with different date semantics: `services/aiChat/tools/planned.js:298-320` (UTC `toISOString().slice(0,10)`, guard 500) vs `services/calculations/aggregation/cashflowForecast.js:129` (APP_TIMEZONE-aware per its header comment at lines 22-30).
  - fix: export an `expandOccurrences(row, horizonYmd)` helper from `calculations/recurrence.js` and use it in both.

- [ ] **contexts/ directory is misnamed post-zustand-migration: only 4 of 8 files create a context; one is a plain hook** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A3_
  - evidence: `grep -l createContext contexts/*.tsx` → only Language, BelgianTaxProfile, PageTitle, SettingsPreload. `contexts/SettingsContext.tsx:34-47`, `contexts/AppSettingsContext.tsx:45-47`, ThemeContext are hydrate/persist shims that read `useSettingsStore` (documented design, settingsStore.ts:9-15 — not overlap, but the files keep context-era names and re-export types "so existing consumers don't change imports", SettingsContext.tsx:21). `contexts/WorkspaceContext.tsx:31` exports `useWorkspace()` — a route+sessionStorage hook with no context at all. `LanguageContext` is a second source for `appSettings.language`, bridged in `App.tsx:115-133`.
  - fix: rename/relocate (WorkspaceContext → hooks/useWorkspace; settings shims → e.g. `stores/hydration/`), and fold LanguageContext into a store selector to remove the bridge.

- [ ] **Currency formatting has three parallel implementations plus module-global mutable defaults; formatDate lives in components/** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A3_
  - evidence: (1) `utils/currency.ts:127` `formatCurrency` reads process-wide mutable defaults set by `configureCurrencyFormatDefaults` from an `App.tsx:120-126` effect (hidden temporal coupling — wrong output before settings hydrate); (2) `hooks/useCurrencyFormatter.ts:20` re-derives locale/currency from settings with its own Intl cache; (3) `hooks/useChartCurrencyFormatter.ts:19` wraps the same again for charts. Date: `components/shared/dateUtils.ts:5` `formatDate` is a pure util misfiled under components/, and `pages/ImportReviewPage.tsx:81` defines a private `formatDate` besides it.
  - fix: make `useCurrencyFormatter` the single settings-aware entry (chart variant composes it), keep `utils/currency` pure-args-only, move dateUtils into utils/ and delete the page-local copy.

- [ ] **Seven shadcn ui primitives are dead (zero importers)** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: grep sweep over all src imports found no consumers for components/ui/{aspect-ratio,input-otp,hover-card,navigation-menu,breadcrumb,avatar,menubar}.tsx.
  - fix: delete them; they can be re-scaffolded from shadcn if ever needed.

- [ ] **Confirm-dialog pattern split: 16 files use useConfirmDialog, 6 hand-roll AlertDialogContent** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: `hooks/useConfirmDialog` adopted in 16 files, but features/imports/ImportHistoryCard.tsx, features/ai-chat/ChatConversationList.tsx, pages/portfolio/RebalancePage.tsx, components/statistics/SavedChartsSection.tsx, components/settings/sections/BackupSection.tsx, components/onboarding/RestoreFromBackupCard.tsx each rebuild AlertDialog markup inline.
  - fix: migrate the 6 hand-rolled sites to useConfirmDialog.

- [ ] **Category `GENERAL:DETAIL` string composed/split ad hoc with no shared helper** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: FE joins `` `${general}:${detail}` `` inline in ≥4 components (components/forms/AddTransactionDialog.tsx, shared/CategoryCombobox.tsx, shared/CategoryMultiCombobox.tsx, tax/profile-steps/IncomeSourcesStep.tsx) and splits with raw `categoryName.split(':')` in pages/RecipientsPage.tsx:215 and pages/DashboardPage.tsx:226; no helper exists in `@vision/shared-utils` or FE utils. Backend stores general/detail as separate columns (repositories/categoryRepository.js:10,63) so the composed string is a pure interchange/display format — exactly the kind of tiny pure function shared-utils was built for.
  - fix: add `formatCategoryName/parseCategoryName` to @vision/shared-utils and sweep the inline call sites.

- [ ] **No lint guard against hardcoded user-facing strings** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: apps/frontend/eslint.config.js:1-52 has no `react/jsx-no-literals` or i18next plugin rule; `scripts/validate-locales.js` (379 lines) validates key parity en↔nl, placeholder-token parity, and source↔generated consistency — but nothing catches a new component shipping raw English text, so drift enters upstream of the validator.
  - fix: enable an i18n literal-string lint rule (warn-level, scoped to src/components + src/pages) so hardcoded strings surface in `bun run lint`.

- [ ] **Electron/compose/backend triplicate stack constants with comment-only sync** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: internal port 3002, `ftm_user`, `financial_transactions` are hardcoded independently in packaging/electron/main.js:120,304,411,558-560, docker-compose.yml:7,13,26,59, and apps/node-backend/src/config/env.js:56; main.js:398 relies on a "mirror from this single file" comment (plus `.claude/rules/packaging.md`) rather than any mechanical check.
  - fix: extract the stack constants into one sourced file (or a compose env include) that electron main.js and compose both interpolate from.

- [ ] **`api-endpoint-matrix.md` stale on `amount_signed`** 🔽 ✅
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - `:55` (GET /api/transactions row) still lists only `amount_min/max/exact`. Commit `692fd9b1` added `amount_signed` to `docs/api/transactions.md`/`docs/features/transactions.md` but never touched the matrix.
  - Fix: append `amount_signed` to the matrix row.

- [ ] **main.js carries ~120 lines of inline CORS + gzip middleware beside a middleware/ dir of 8 modules** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: main.js:90-125 (CORS) and main.js:148-215 (hand-rolled gzip with backpressure) are inline `app.use` closures while every other cross-cutting concern is a middleware/ module; main.js totals 582 lines. Documented as a deliberate Phase 5 dependency slim-down, so this is a consistency nit, not a defect.
  - fix: extract to middleware/cors.js and middleware/compression.js purely for symmetry; keep zero-dependency implementations.

- [ ] **`return null` is the de-facto sentinel in import adapters and rateFetcher (undocumented exception to the no-null convention)** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: the whole CSV-adapter subsystem returns `null` for unparseable rows (`services/importPipeline/adapters/wise.js` 6×, `_shared.js` 6×, `revolut.js` 5×, `belfius.js` 5×, `kbc.js` 4×, `sabb.js` 4×) and `services/currency/rateFetcher.js` has 9 `return null`. code-patterns.md documents the null exception only for the *repository* boundary (code-patterns.md:373-376).
  - fix: either extend the documented null-exception to "parse/fetch miss" sentinels or sweep these to `undefined`; don't leave the convention ambiguous.

- [ ] **lib/ vs utils/ split has no discernible rule; stray React hooks and a dead shim in the wrong tree** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A3_
  - evidence: pure helpers sit in both (`lib/slugify.ts`, `lib/decimal.ts`, `lib/csv.ts` vs `utils/sanitize.ts`, `utils/rollingAverage.ts`); `@vision/shared-utils` re-export shims split across both (`lib/money.ts:7` vs `utils/downsample.ts:5` — the latter has **zero importers**, dead). Four React hooks live in lib/: `lib/dialogGenie.ts:40` `useGenieOrigin`, `lib/devtools/apiRequestLog.ts:42`, `lib/devtools/devtoolsHotkey.ts:21`, `lib/devtools/queryMetrics.ts:135`. No doc defines the lib/utils boundary (grep of docs/ found none).
  - fix: declare one rule (e.g. utils/ = pure domain helpers, lib/ = infrastructure), delete `utils/downsample.ts`, move `useGenieOrigin` to hooks/ (devtools hooks can stay colocated).

- [ ] **Hooks live in three places with no placement rule; apiClient facade is bypassed by 21 direct domain-module imports** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A3_
  - evidence: domain hooks split across flat `hooks/` (~45 files), `hooks/portfolio/`, and `features/*/hooks/` (`features/transactions/hooks/useTransactionListData.ts`, `features/imports/useAdapters.ts` — the latter not even in a hooks/ subdir); `useTransactions` (hooks/) and `useTransactionListData` (features/) serve the same resource under different key families, their coupling documented only in a comment (`hooks/useTransactions.ts:93`). Separately, `lib/api.ts:1-38` builds the `apiClient` facade for back-compat, but 21 call sites in components/pages/features/hooks import `@/lib/api/<domain>` modules directly — two sanctioned access paths.
  - fix: pick one convention for hook placement (feature-first or domain-dir) and one API access path (direct domain modules; shrink the facade), then codemod stragglers.

- [ ] **@vision/shared-utils scope creep: 687-line domain module in a "pure utility" package** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: packages/shared-utils/src/portfolio.js is 687 lines of portfolio math (>half the package) inside a package described as "Pure utility helpers (money, slugify, downsample)" (packages/shared-utils/package.json:5); consumers are FE hooks/portfolio/* and BE utils/portfolioMath.js. Sharing is correct; the package identity is now blurred, inviting further dumping.
  - fix: either rename/re-describe the package as shared FE/BE logic or split domain calc into a `@vision/portfolio-calc` sibling; no code change needed otherwise.

- [ ] **FE ymd/date helpers scattered; canonical toYmd lives under components/** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: apps/frontend/src/lib/timezone.ts:9 re-exports `parseYmd/toYmd` from `@/components/shared/dateUtils` (a util homed in the components tree) and hand-rolls `todayYmd` at lines 19-25; BE lib/timezone.js is intentionally different (APP_TIMEZONE business math per ADR-009), so this is FE-internal organization, not FE/BE drift. *(Overlaps with A3's dateUtils-misfiled finding — fix together.)*
  - fix: move dateUtils out of components/shared into lib/ and make timezone.ts the single FE date-string module.

- [ ] **FX fallback in portfolio P&L hook silently uses the current (not point-in-time) rate, with no acknowledging comment** ⬇ ✅
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - `apps/frontend/src/hooks/portfolio/useFxAwarePnl.ts:48-50` falls back to live-rate `getRateToEur` when `fx_rate_to_eur` is missing/zero
  - `docs/adr/085-belgian-tax-point-in-time-fx.md` sanctions an identical fallback for the *tax* path as "a transient approximation that self-corrects" — confirmed via official FOD Financiën guidance that point-in-time FX is indeed the technically correct convention for Belgian capital-gains/TOB valuation. The portfolio P&L hook has the same trade-off with no equivalent comment, and silently blends current-rate legs into an EUR cost pool used for gain math. This is a third surface with this pattern, distinct from the one ADR-085 already explicitly waves off (the portfolio-summary "current value display," which is intentionally out of scope).
  - Fix: add a short comment/doc note acknowledging the fallback and its accuracy trade-off; not urgent enough for a code change or new ADR on its own.

### 🏗️ DevOps / CI-CD / Packaging

- [ ] **`CI Complete` goes green when the whole Docker tier is skipped — gate bypass, actively triggered by the known artifact-quota failures** 🔺
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/ci.yml:656-670` — `ci-complete` runs with `if: always()` and greps `needs.*.result` for `failure|cancelled` only. When `build-image` fails (which it does today on artifact quota), `trivy-scan`, `docker-verify`, and `test-live-api-contracts` all come back `skipped`, the grep matches nothing, and the single required status check passes — silently waiving the Trivy CVE gate, the compose /health boot check, and the migration-reversibility round-trip (the check that exists because of the v1.0.2 data-loss class of bug).
  - Fix: include `"skipped"` in the failure grep in `ci-complete` (and keep draft-PR skipping working by special-casing only `test-live-api-contracts`, e.g. check it separately or gate on `needs.build-image.result == 'success'`).

- [ ] **Nightly E2E workflow cannot succeed: no `.env` is created before `docker compose up`** ⏫
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/e2e.yml:56-57` vs `docker-compose.yml:5,24` — both compose services declare `env_file: .env` (hard-required; compose v2 aborts with "env file not found" when missing, and the app needs `POSTGRES_PASSWORD`/`DATABASE_URL`/`SECRET_KEY` regardless). `ci.yml:530-532` writes a stub `.env` first; `e2e.yml` never does, so the compose-up step fails every night. The header (`e2e.yml:8-11`) admits the workflow has never had a live run.
  - Fix: copy the stub-`.env` step from `ci.yml:530-532` into `e2e.yml` before compose up, then trigger a `workflow_dispatch` run to confirm green end to end.

- [ ] **Release verify runs `bun audit` without the CVE ignores CI has — next release is blocked by the two accepted fast-uri advisories** ⏫
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/release.yml:98-99` vs `.github/workflows/ci.yml:77-83` — CI ignores GHSA-v39h-62p7-jpjc and GHSA-q3j6-qgpj-74h6 (dev-only, documented as unreachable), but the release `verify` job runs plain `bun audit --audit-level=high`. As long as those advisories are open, every tag push fails at verify and no release can ship.
  - Fix: extract the audit command (with ignores + justification comment) into a single shared script/reusable step used by both workflows so accepted-risk lists can't drift.

- [ ] **`.env` (real secrets) is not in `.dockerignore` and ships in every build context** ⏫
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `.dockerignore:13-17` — excludes `.env.local` / `.env.*.local` but not `.env` itself; `/Users/computer/Code/Vision/.env` (mode 600, contains `POSTGRES_PASSWORD` + `DATABASE_URL`) is sent to the Docker daemon on every `docker compose build`. Today no `COPY` grabs it, but a single future broad `COPY` (or a remote/buildx builder) would bake the DB password into an image layer or upload it off-host.
  - Fix: add `.env` (and `.env.*`, re-allowing `.env.example` with `!.env.example`) to `.dockerignore`.

- [ ] **In-app shell updater requires a release asset the pipeline never publishes** ⏫
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `packaging/electron/main.js:1725-1728` — `pickSourceLauncherZip` only accepts an asset matching `vision-source-launcher-.*-arm64\.zip`; `.github/workflows/release.yml:333-338` uploads only `Vision-*.dmg`, `Vision-*.zip`, `vision-setup.command`, `README.md`, `*.sha256` — nothing anywhere in the repo builds or uploads a source-launcher zip (`grep -r source-launcher` hits only main.js).
  - `packaging/electron/main.js:1940-1980,3336-3338` + `apps/frontend/src/components/settings/sections/AboutSection.tsx:116`, `components/notifications/UpdateNotification.tsx:111` — in source/repo mode (how the user's own `Vision.app` runs via `install.sh`), the startup dialog announces the new version, the user clicks Download, `prepareShellUpdateInstaller` returns `{ up_to_date: true, error: 'No compatible source launcher update asset found.' }`, and the flow silently exits — the update can never install and the prompt recurs every launch after any newer tag. The Settings/notification buttons hit the same dead end.
  - Fix: add a release.yml step that zips `unsigned/Vision/` (source tree) + `unsigned/launch.command` as `vision-source-launcher-<ver>-arm64.zip` with a `.sha256`, or delete the source-launcher updater path and fall back to opening `html_url`.

- [ ] **Devcontainer writes platform-specific state into the shared host workspace (node_modules, venv, .env)** ⏫
  - ↪ _from: DevOps research 2026-07-03 · Wave D4_
  - `.devcontainer/post-create.sh:67-74` — first container boot detects the host's macOS venv as broken, `rm -rf ./venv` and rebuilds it with Linux CPython **on the bind mount**, so back on the host `bun run db:upgrade` (`package.json:37` → `venv/bin/alembic`) dies with "cannot execute binary file" until you manually rebuild the venv.
  - `.devcontainer/post-create.sh:98` + `.devcontainer/bin/claude:93` — `bun install --frozen-lockfile` runs inside the bind-mounted workspace with no volume over `node_modules/`, replacing macOS platform binaries (esbuild/rollup/lightningcss) with Linux ones; every host↔container switch breaks the other side's dev loop until a reinstall.
  - `.devcontainer/post-create.sh:78-91` — on a fresh clone it also writes a repo-root `.env` with `POSTGRES_PASSWORD=localdev` that host-side `docker compose` (`env_file`) and `loadDotenv` would silently consume.
  - Fix: put the container's venv and node_modules outside the mount (named volumes over `./venv` and `./node_modules`, or `/home/dev/venv` + change `ALEMBIC_BIN` in `bin/claude:82`), and write the generated env file to a container-local path.

- [ ] **No enforced branch protection / required status checks on `main`** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - The repo is private on a plan tier without classic branch protection or rulesets (`gh api .../branches/main/protection` and `.../rulesets` both 403 "Upgrade to GitHub Pro"). None of the 13 CI gates can structurally block a merge or direct push — they only report. Mitigated today by solo-dev discipline + the "commit to main" workflow, but no backstop if that lapses or a token is compromised.
  - Fix: upgrade to GitHub Team/Pro (or make public) to enable rulesets; require `CI Complete` + CodeQL before merge.
  - Verification (2026-06-30): re-confirmed live — `gh api repos/EraPartner/Vision/branches/main` returns `"protected": false` today, independently corroborating the 403s.

- [ ] **Dependabot auto-merge has no required-checks backstop** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - `.github/workflows/auto-merge.yml:28` — `gh pr merge --auto` only waits on checks marked *required*, and (per above) none are. A patch/minor dependency PR can complete its auto-merge independent of whether tests/lint/Trivy passed or even failed.
  - Fix: either fix branch protection above, or have the workflow explicitly `gh pr checks --watch` and gate on the result before calling `gh pr merge`.
  - Verification (2026-06-30): re-confirmed with live evidence — PR #73 merged via auto-merge on 2026-06-23 while its "Build Docker Image" check was failing. (That specific failure is a known artifact-quota false-positive, not a real defect — but the structural finding stands: nothing distinguishes a benign failure from a real one before merge.)

- [ ] **Precedent: an auto-applied migration shipped a destructive DROP ahead of its coupled code and crashed boot — no automated guard against recurrence** ⏫ ✅
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - `alembic/versions/0055_drop_bank_account_string.py` (now neutered to a no-op) + recovery in `0056_restore_bank_account_after_premature_drop.py`; doctrine in ADR-088
  - The app runs `alembic upgrade head` unconditionally on every boot. 0055 originally dropped columns/a trigger/a matview; because it ran before the dependent app code shipped, it crashed startup. The fix was manual (a docstring + convention), not tooling-enforced — there's still no CI check flagging destructive DDL (`DROP TABLE/COLUMN`, narrowing `ALTER COLUMN TYPE`) landing without an explicit marker. Self-hosted users with no DB expertise have nothing protecting them from this recurring beyond developer memory of this one incident.
  - Fix: add a CI check (parallel to `verify-compose-sync`) that flags destructive DDL in new migrations and requires an explicit marker/ADR reference.

- [ ] **E2E/accessibility CI workflow has been failing on every single nightly run for a month with zero alerting** ⏫ 🔧 *(escalated — confirmed worse than originally reported)*
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - `.github/workflows/e2e.yml:8-11` claims "has not yet had a live run on GitHub Actions" — that comment is **stale**. Live `gh run list --workflow=e2e.yml` shows it has run on its nightly schedule every day since at least 2026-06-01 (30/30 fetched runs) and **failed every single time**. Root cause confirmed from an actual job log: the workflow never writes a `.env` file before `docker compose -f docker-compose.yml up -d --build`, so the stack never comes up (`env file ... not found`). The only failure handling (`if: failure()` at `:86-88`) dumps logs into the run's own output — no issue creation, no Slack/email — so this has been silently red for ~30 consecutive days.
  - Fix: have the workflow write a minimal `.env` before `docker compose up` (mirror `ci.yml`'s pattern at lines 532/601), re-verify via `workflow_dispatch`, then add failure notification (issue auto-creation or similar). Also fix the stale in-file comment.

- [ ] **`VISION_IMAGE=vision:ci` is a no-op — the "build once, reuse" image artifact is never used; docker-verify and live-contracts each rebuild from scratch** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/ci.yml:534-537,603-606` export `VISION_IMAGE` before `docker compose up`, but `docker-compose.yml:22` defines the app service as `build: .` with no `image:` key, so compose ignores the variable, ignores the loaded `vision:ci` image, and rebuilds the image (uncached) in both jobs. The build-image job + tar upload/download (the thing hitting the artifact quota) buys nothing for these two jobs — only trivy-scan actually consumes the artifact.
  - Fix: add `image: "${VISION_IMAGE:-vision-app:local}"` to the app service in `docker-compose.yml` (mirror in the electron resources compose per packaging rules) and pass `--no-build` in CI so the loaded image is provably reused.

- [ ] **Release quality gate is a drifted re-implementation of CI, missing several gates** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/release.yml:37-131` — the `verify` job copy-pastes CI steps but omits `typecheck-backend` (JSDoc tsc), all of `verify-generated` (validate-locales, OpenAPI type drift, endpoint-matrix count), `secrets-scan`, and the docker-verify migration-reversibility round-trip; the compose-volume-sync shell is duplicated verbatim (`release.yml:63-73` = `ci.yml:383-393`). A tag can also be pushed on a commit that never passed CI, so these gaps are the only gate.
  - Fix: convert ci.yml's quality tier to a reusable `workflow_call` and have release `verify` invoke it (or at minimum add the missing four checks and de-duplicate the compose-sync script).

- [ ] **Release image is pushed to GHCR (including `latest`) before Trivy scans it** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/release.yml:176-194` — `docker/build-push-action` pushes all tags first; the Trivy HIGH/CRITICAL scan runs afterwards, so a failing scan leaves the vulnerable image already published and `latest` already moved — users pulling `ghcr.io/...:latest` get it anyway.
  - Fix: build with `push: false` + `load: true` (or push only a candidate digest), scan, then push/tag `latest` only on a clean scan.

- [ ] **Dependabot auto-merge safety rests entirely on branch-protection settings that aren't codified or verified anywhere** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/auto-merge.yml:24-31` — `gh pr merge --auto` merges as soon as *required* checks pass; nothing in the repo asserts that "CI Complete" (and CodeQL) are actually required (`ci.yml:652-655` only asks in a comment). If protection is missing/renamed, patch/minor dependabot PRs merge with zero CI; combined with the `ci-complete` skipped-tier bug above, a dependabot bump that breaks the Docker image can auto-merge today.
  - Fix: verify branch protection requires `CI Complete` + `Analyze (javascript-typescript)`, and codify it (repository ruleset in-repo, or a step that queries the branch-protection API and fails if the required-check list is wrong).

- [ ] **Build context is ~1.2 GB of irrelevant files** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `.dockerignore:1-5` — `node_modules/` patterns only cover root/apps/packages; `packaging/electron/node_modules` (605 MB), `packaging/electron/dist` (503 MB), `venv/` (76 MB), `.playwright-mcp/` (31 MB), plus `docs/`, `.claude/`, `.idea/`, `.obsidian/`, `.github/`, `TODO.md` all enter the context. Every cold `docker:dev`/Electron local build transfers >1 GB to the daemon for a Dockerfile that only COPYs ~7 paths.
  - Fix: switch `.dockerignore` to an allowlist (`*` then `!package.json`, `!apps/`, `!packages/`, `!i18n/source/`, `!alembic/`, `!config/alembic.ini`, `!scripts/…`, `!docker-entrypoint.sh`, `!bun.lock`), or at minimum add `packaging/`, `venv/`, `docs/`, `.playwright-mcp/`, `**/node_modules`.

- [ ] **Dev↔packaged-app DB sharing silently depends on the repo directory being named "Vision"** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `docker-compose.yml:1` vs `packaging/electron/resources/docker-compose.yml:2` — the packaged compose pins `name: vision`; the root compose has no `name:` key, so its project name (and thus `vision_postgres_data`) derives from the checkout dirname. Clone the repo as `vision-2` (or a worktree) and `docker:dev` quietly creates a fresh empty DB instead of the "single source of truth" that `docker-compose.dev.yml:4-6` promises — or worse, users think data vanished.
  - Fix: add `name: vision` to the root `docker-compose.yml` (and to the CI compose-sync guard's checked keys).

- [ ] **`install.sh` requires `node` but only ever installs `bun`** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `install.sh:110-114,157-170` — the settings-merge branch shells out to `node -e`. On a machine where the script itself installed Bun (its own premise), `node` may not exist; with `set -e` the script dies at the very last step after the .app is already installed, leaving `repoPath` unwritten so the packaged app pulls GHCR instead of building locally — a confusing half-configured state.
  - Fix: use `bun -e` (already guaranteed present) or fall back: `command -v node || node() { bun "$@"; }`.

- [ ] **`APP_IMAGE_TAG` is never set — packaged app tracks `:latest`, contradicting the compose file's own comment** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `packaging/electron/resources/docker-compose.yml:21-24` — comment claims "Electron sets APP_IMAGE_TAG to the exact version tag so `docker compose pull` fetches the correct image", but `APP_IMAGE_TAG` appears nowhere in `packaging/electron/main.js`, `install.sh`, or the workflows; the image resolves to `${APP_IMAGE_TAG:-latest}` → always `:latest`.
  - Consequences: shell version and backend image are never tied (an image prune + reboot silently pulls a newer `:latest` and auto-runs irreversible migrations against an older shell); rolling back to an older DMG cannot roll back the image; `packaging/release/README.md:143` uninstall (`docker rmi ghcr.io/erapartner/vision:__VERSION__`) leaves the actually-used `:latest` tag behind; the `vision-setup.command:13` pinned-tag pre-pull only warms layers by coincidence of digest equality.
  - Fix: have main.js export `APP_IMAGE_TAG` = its own package.json version into the compose env (bump it in the docker-image-update path), or delete the false comment and pin `:latest` intentionally with a documented rollback story.

- [ ] **Two competing lockfiles in packaging/electron; shipped artifact and local builds resolve deps differently** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `packaging/electron/bun.lock` + `packaging/electron/package-lock.json` are both committed. Release CI installs with `npm ci --ignore-scripts` (`.github/workflows/release.yml:260`), while `install.sh:123` (`bun run dist` after root `bun install`), `install-demo.sh:46` (`bun install`, unfrozen), and the shipped updater/launcher (`main.js:1673` `bun install --ignore-scripts`, `unsigned/launch.command`) all use bun. A dep bump landing in one lockfile but not the other means the .dmg you ship was built against a different electron/electron-builder tree than the one you tested locally — silent until a build or runtime break.
  - Fix: pick one lockfile (npm, since it feeds the shipped artifact), delete the other, and make `install-demo.sh`/`install.sh` use the same frozen install (`npm ci` or `bun install --frozen-lockfile` against the kept lockfile).

- [ ] **Compose-volume sync guard exists only as inline CI shell, duplicated twice, with no local equivalent** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `.github/workflows/ci.yml:383-393` and `.github/workflows/release.yml:63-74` carry byte-identical copies of the awk volume-name diff; `.claude/rules/packaging.md` tells humans to "check on EVERY compose edit" by hand. The v1.0.2 data-loss class of bug is only caught after push, and the two inline copies can drift from each other (e.g. one gets a fix for the fragile `awk '/^volumes:/'` parsing that breaks the moment a compose file gains a second top-level block after `volumes:`).
  - Fix: extract to `scripts/check-compose-sync.js` (parse YAML properly), call it from both workflows and from `.githooks/pre-push` (or pre-commit when compose files are staged).

- [ ] **Global `*.json` gitignore silently drops new JSON source files; 18 tracked files only survive by historical accident** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D4_
  - `.gitignore:57-64` — `*.json` is ignored repo-wide with narrow negations; `git ls-files -ci --exclude-standard` shows 18 tracked-but-ignored files including root `package.json`, `apps/frontend/package.json`, `apps/node-backend/package.json`, all tsconfigs, and `i18n/source/{en,nl}.json`. Any NEW json at an un-negated path (a new `apps/*` workspace `package.json`, a new config) is silently excluded from commits — local works, fresh clone/CI breaks with no warning — and ripgrep/agent tools skip these files by default.
  - `.gitignore:62-63` — negations reference `.devcontainer/devcontainer.json` / `devcontainer-lock.json`, which no longer exist (the sandbox is devcontainer-CLI-free).
  - Fix: replace the blanket `*.json` with the specific patterns it was meant to catch (e.g. `.playwright-mcp/**/*.json`, report dumps), and delete the two stale devcontainer negations.

- [ ] **No aggregate local check command — nothing runs what CI runs in one shot** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D4_
  - `package.json:12-58` — `lint`, `lint:backend`, `typecheck`, `test`, `test:frontend`, `validate-locales`, `check-endpoint-matrix`, `build` all exist but there is no `check`/`verify` aggregate, and `docs/common-tasks.md` documents none; the pre-push hook covers typecheck+locales+matrix+backend tests only, so lint and frontend-test regressions routinely surface first in CI.
  - Fix: add `"check": "bun run lint && bun run lint:backend && bun run typecheck && bun run validate-locales && bun run check-endpoint-matrix && bun run test && bun run test:frontend"` and reference it in `docs/common-tasks.md`.

- [ ] **Desktop app's backend update path pulls a mutable image tag with no signature verification** 🔼 ✅
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - `packaging/electron/resources/docker-compose.yml:24` (`image: ...vision:${APP_IMAGE_TAG:-latest}`), pulled via `docker compose pull` in `packaging/electron/main.js:1305,3192`
  - No digest pin, no cosign/sigstore check — contrast with the separate shell-updater path in the same file, which does checksum + SHA256 verification correctly. A compromised registry/pipeline would silently propagate to every running instance.
  - Fix: pin `APP_IMAGE_TAG` to a digest resolved from release metadata, and/or `cosign verify` before `compose up`.

- [ ] **Bun version `1.3.14` is hardcoded in 12 workflow steps with no single source of truth** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/ci.yml` (9×), `release.yml` (2×), `e2e.yml:38` — a Bun upgrade requires editing 12 sites; missing one gives version-skewed CI (e.g. release building with a different Bun than CI tested).
  - Fix: commit a `.bun-version` file and switch every `setup-bun` step to `bun-version-file: .bun-version`.

- [ ] **Nightly E2E failures alert nobody** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/e2e.yml:14-18` — scheduled-run failures only email the last editor of the workflow file and don't gate anything, so a broken critical-flow/a11y suite can stay red for weeks unnoticed (compounded by it never having run — see the ⏫ finding).
  - Fix: add an `if: failure()` step that opens/updates a pinned issue (e.g. `gh issue create`) on nightly failure.

- [ ] **`paths-ignore: "*.md"` only matches root-level markdown, and docs-only PRs strand the required check** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/ci.yml:6-13`, `.github/workflows/codeql.yml:6-13` — nested markdown (`apps/frontend/README.md`, `.github/*.md`, `packaging/release/README.md`) still triggers the full pipeline; conversely a `docs/**`-only PR skips the workflow entirely, leaving a required "CI Complete" check permanently "Expected" and the PR unmergeable.
  - Fix: change the glob to `"**/*.md"` and add a same-name no-op success workflow with inverted `paths` (GitHub's documented pattern) so docs-only PRs can merge.

- [ ] **CodeQL workflow has no concurrency group** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/codeql.yml:1-19` — rapid successive pushes/PR updates run duplicate ~10–30 min security-extended analyses; every other workflow in the repo has a concurrency block.
  - Fix: add `concurrency: { group: codeql-${{ github.ref }}, cancel-in-progress: true }`.

- [ ] **`cancel-in-progress: true` also applies to pushes on main, leaving main commits with no CI verdict** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/ci.yml:15-17` — the workflow (and the user) commits directly to main; two pushes in quick succession cancel the first run, so intermediate main commits get no full-pipeline result (gaps when bisecting a regression to a "cancelled" commit).
  - Fix: `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.

- [ ] **Dependabot doesn't cover compose-file images or the devcontainer base image** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/dependabot.yml:42-48` — the `docker` ecosystem at `/` covers only the root `Dockerfile`; `postgres:18-alpine` in `docker-compose.yml:3` and `packaging/electron/resources/docker-compose.yml:5`, and the SHA-pinned `debian:bookworm-slim` in `.devcontainer/Dockerfile:15`, get no update PRs — pinned digests silently age (security patches missed).
  - Fix: add `docker-compose` ecosystem entries for `/` and `/packaging/electron/resources`, plus a `docker` entry for `/.devcontainer`.

- [ ] **Release artifacts ship checksums but no provenance/SBOM attestations** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/release.yml:176-186,281-296` — `build-push-action` doesn't enable SBOM, and the dmg/zip get only self-hosted `.sha256` files (which an attacker who can replace the asset can also replace); no `actions/attest-build-provenance` for either.
  - Fix: add `provenance: mode=max` + `sbom: true` to the docker build and an `actions/attest-build-provenance` step (with `id-token: write`, `attestations: write`) for the mac artifacts.

- [ ] **No `depends_on` at all — partial `up` targets never create the db container** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `docker-compose.yml:61-73` — the health-gate removal is sound, but dropping `depends_on` entirely means `docker compose up app` / `docker compose up -d app --build` (a natural iterate-on-app command) starts only the app, which crash-loops on `getaddrinfo db` until the user figures out db was never created.
  - Fix: add `depends_on: { db: { condition: service_started } }` — keeps the parallel-start win, restores dependency creation.

- [ ] **Postgres runs with the default 64 MB `/dev/shm`** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `docker-compose.yml:2-19` — no `shm_size:` on the db service; parallel workers / matview refreshes (this app refreshes finance-aggregation matviews) on a grown DB can abort with `could not resize shared memory segment … No space left on device`. The app container is covered (`--disable-dev-shm-usage` in `puppeteerRenderer.js:29`), the db is not.
  - Fix: add `shm_size: 256mb` to the db service in both root and packaged compose (sync rule applies).

- [ ] **No container log rotation — unbounded json-file growth on an always-on self-host** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `docker-compose.yml:2-73`, `packaging/electron/resources/docker-compose.yml` — neither service sets `logging:` limits; the backend logs structured JSON per request/boot and postgres logs too, so a long-lived packaged install grows daemon logs indefinitely unless the user configured the daemon globally.
  - Fix: add `logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }` to both services in both compose files.

- [ ] **Broken migration = silent eternal crash-loop with repeated Alembic invocations** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `docker-compose.yml:23` + `apps/node-backend/src/main.js:440,495-499` — a failing migration exits 1 and `restart: unless-stopped` relaunches forever (Docker backoff caps ~1 min), re-running `alembic upgrade head` each time; nothing distinguishes "migration failed, human needed" from "db not up yet", so the Electron user just sees an endless spinner.
  - Fix: on migration failure, write a distinct marker/log line (or exit after N attempts via a boot-attempt counter in `/app/.vision-cache`) that the Electron orchestrator can surface as an actionable error.

- [ ] **Local `dist` can accidentally publish to GitHub Releases via dead `publish` config** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `packaging/electron/package.json:74-78` declares `publish: {provider: github, owner, repo}` even though the project deliberately avoids electron-updater (main.js:1564-1566) and CI builds with `--publish never` (release.yml:261). electron-builder's CLI default is `onTagOrDraft` when `GH_TOKEN`/`GITHUB_TOKEN` is set — a local `npm run dist` on a tagged commit with a token in the environment uploads unsigned artifacts to the real release.
  - Fix: delete the `publish` block (nothing consumes it) or hard-code `"publish": null`.

- [ ] **install-demo.sh swallows the two failures that matter most for its purpose** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `install-demo.sh:30` — regen failure only prints `WARN` and bakes the stale `01-demo.sql`, so a demo audit can silently run on last month's schema/data snapshot while you believe it reflects HEAD.
  - `install-demo.sh:62-65` — `xattr`/`codesign --force --deep -s -` both end in `|| true`; the script's own comment says arm64 refuses to launch without the ad-hoc signature, so a codesign failure produces a "successfully installed" app that won't open.
  - Drift note: the Docker-wait/preflight/copy logic is hand-duplicated from `install.sh` (and waits 60s vs 120s in `vision-setup.command`) — three copies to keep aligned.
  - Fix: make regen failure prompt/abort unless `SKIP_DEMO_DATA_REGEN=1`, drop `|| true` from codesign and verify with `codesign -v` before declaring success.

- [ ] **No Alembic heads guard and no local migration-fidelity check; `db:*` scripts hardwired to a fragile venv path** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `package.json:37-42` — all `db:*` scripts call `venv/bin/alembic`, which `packaging/electron/demo-db/regenerate.sh:37-41` already documents as broken on the host when the venv was built in the devcontainer (it carries its own fallback; the npm scripts don't). There is no `alembic heads`-count check anywhere (a parallel-branch merge creating two heads only surfaces indirectly when CI's `upgrade head` errors), and downgrade fidelity is checked only in CI and only for the top revision (`ci.yml:559-567`) — nothing local, echoing the multiple-stamped-heads demo-volume incident.
  - Fix: add a `db:check` script (single-head assert + `downgrade -1`/`upgrade head` round-trip) reusing regenerate.sh's alembic-resolution fallback, and wire the head-count assert into pre-push.

- [ ] **docs claim the release is signed and notarized — it is neither** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `docs/reference/scripts.md:39` says `dist` "signs + notarises on macOS in CI", but `packaging/electron/package.json:54-56` sets `identity: null, hardenedRuntime: false` and `release.yml:253` sets `CSC_IDENTITY_AUTO_DISCOVERY: "false"`; `packaging/release/README.md:149-155` correctly documents the ad-hoc posture. Anyone doing release ops from scripts.md will mis-state the security posture (e.g. when a user reports Gatekeeper errors).
  - Fix: correct the scripts.md row to "unsigned/ad-hoc; no notarization (see packaging/release/README.md)".

- [ ] **`.devcontainer/README.md` has drifted from the implementation on security-relevant points** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D4_
  - `.devcontainer/README.md:17` (claude "installed via the devcontainer feature" — actually npm-pinned at `Dockerfile:128`), `:79-87` + `:279-282` (allowlist "in squid.conf, Debian/PostgreSQL apt, *.visualstudio.com" — actual list is `allowlist.txt` via sync.sh, and NO apt hosts are allowlisted), `:77,100` (`dmesg | grep vision-deny` — real prefix is `egress-deny:`, `init-firewall.sh:87`), `:168-176` (push-on-exit "runs automatically" — `bin/claude:148` defaults `VISION_AUTOSYNC` to **0**/opt-in, so an operator trusting the README silently loses in-container config), `:106-108` (caps list includes `SETPCAP`; `bin/claude:65-66` doesn't grant it), `:216-217` (token forwarded as `-e KEY=…` — code deliberately forwards name-only).
  - Fix: one re-sync pass of README.md against `bin/claude` + `Dockerfile`; the autosync paragraph is the priority line.

- [ ] **In-container Playwright E2E is advertised but cannot actually install** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D4_
  - `.devcontainer/allowlist.txt:63-65` allowlists `cdn.playwright.dev` for "E2E in apps/frontend", but `bunx playwright install --with-deps` needs `apt-get` (no Debian mirror is allowlisted, and `squid.conf:31` denies port 80) and the image bakes no browser system libraries — so `bun run test:e2e` inside the sandbox fails at setup, not by policy choice.
  - Fix: bake the Playwright deps into `.devcontainer/Dockerfile` (`npx playwright install-deps` equivalent apt list) or drop the two CDN hosts + document E2E as host-only next to the Electron limitation.

- [ ] **`docs/common-tasks.md` documents root commands that don't exist** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D4_
  - `docs/common-tasks.md:104,109,145` — `bun run test:mutation` and `bun run test:e2e:update-snapshots` are only defined in `apps/frontend/package.json`; at the repo root they fail with `error: Script not found` (verified).
  - Fix: change to `bun run --filter 'vision-frontend' …` or add root pass-through scripts.

- [ ] **`.env.example` research-provider block omits `FRED_API_KEY`** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D4_
  - `.env.example:26-35` declares itself the "single home for the research provider API keys" but lists only 4 of the 5 keyed providers; `apps/node-backend/src/services/research/providerKeys.js:23` also wires `FRED_API_KEY` (ADR-082). A user enabling macro research won't find the key documented in the template.
  - Fix: add a commented `# FRED_API_KEY=` line with the free-tier note.

- [ ] **`SECRET_KEY` documented and seeded in CI but never read by any backend code** 🔽 ✅
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - `docs/guides/deployment.md:55,434,447`, `.github/workflows/ci.yml:532,601` vs. zero references in `apps/node-backend/src`
  - Operators are told to "set a secure SECRET_KEY" for an auth system that doesn't exist (the real gate is `ADMIN_AUTH_TOKEN`, documented separately and correctly). False sense of configuration.
  - Fix: remove from the deployment checklist + CI stub, or mark explicitly reserved/unused.
  - Verification (2026-06-30): re-confirmed, and the "never read" claim holds repo-wide (grepped all `.js/.ts/.tsx/.py`, not just the backend), so the underlying claim is if anything stronger than stated.

- [ ] **`pip-audit` is installed unpinned at run time in both workflows** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/ci.yml:103`, `release.yml:107` — `pip install pip-audit` pulls latest from PyPI on every run: non-reproducible and a (small) supply-chain surface, inconsistent with the repo's otherwise strict SHA-pinning.
  - Fix: pin it (`pip install pip-audit==X.Y.Z`) or use the pinned `pypa/gh-action-pip-audit` action.

- [ ] **`test:e2e` hardcodes six spec files — new e2e specs are silently never run, and `visual.spec.ts` runs nowhere** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `apps/frontend/package.json:17-18` — a new `e2e/*.spec.ts` added without updating the script is dead code in the nightly run; visual regression specs aren't executed by any workflow.
  - Fix: run `playwright test` with `testIgnore` for visual specs (so new files are included by default) and decide whether visual specs join the nightly job.

- [ ] **`latest` Docker tag moves on every tag push, even a re-release of an older version** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/release.yml:171-174` — `type=raw,value=latest` is unconditional; pushing `v1.0.3` after `v1.2.0` exists would point `latest` at the older image.
  - Fix: use `type=raw,value=latest,enable={{is_default_branch}}`-style guarding or a semver comparison step before applying `latest`.

- [ ] **`workflow_dispatch` tag input is interpolated unquoted into shell and used as checkout ref without format validation** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/release.yml:46,77,266` — `${{ github.event.inputs.tag }}` is expanded directly into `run:` scripts; only write-access users can dispatch, so exposure is low, but a malformed input produces confusing mid-pipeline failures rather than a clean early error.
  - Fix: first step validates `[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]` (via `env:` mapping, not inline `${{ }}`) and fails fast.

- [ ] **Unhealthy app container is never restarted** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `Dockerfile:114-115` — the HEALTHCHECK is defined, but plain Docker (non-Swarm) takes no action on `unhealthy`; a hung-but-alive backend (event-loop stall, deadlocked pool) stays down until manual intervention since `restart: unless-stopped` only fires on exit.
  - Fix: accept and document, or have the Electron orchestrator poll container health and restart on sustained `unhealthy`.

- [ ] **Entrypoint boot-trace resolution is whole seconds — `%N` unsupported on busybox/musl** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `docker-entrypoint.sh:9,25-28` — verified in `oven/bun:1-alpine`: `date +%s.%N` prints `1783030579.` (empty nanoseconds), so `entrypoint_total` ms is quantized to 0/1000, making the startup metric useless for its stated charting purpose.
  - Fix: use `%s%3N`-capable coreutils, or drop sub-second precision claims and measure entrypoint time from the bun side instead.

- [ ] **`install.sh` clobbers a possibly-running Vision.app and copies the bundle with `cp -r`** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `install.sh:143-150` — `rm -rf /Applications/Vision.app` doesn't check whether the app (and its Docker stack) is running, and `cp -r` is not the canonical way to copy .app bundles (symlink/xattr fidelity); `ditto` is.
  - Fix: `osascript -e 'quit app "Vision"'` (or warn) before replacing, and use `ditto "$APP_SRC" "$APP_DEST"`.

- [ ] **`env_file: .env` hands every app secret to the postgres container** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `docker-compose.yml:5` — the db service only needs `POSTGRES_PASSWORD`, but inherits the full `.env` (API keys, `DATABASE_URL`, etc.), needlessly widening blast radius if the db container is compromised.
  - Fix: drop `env_file` on db and set `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}` under `environment:` instead (mirror in packaged compose).

- [ ] **Version bumping is manual across two enforced + three unenforced locations, caught only after tagging** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - Version lives in root `package.json:4` (1.0.2), `packaging/electron/package.json:3` (1.0.2, enforced pair per `.claude/rules/packaging.md`), plus stale/unenforced copies: `apps/frontend/package.json:3` and `apps/node-backend/package.json:3` (both 1.0.0) and `openapi.yaml:5` ("1.0"). The release.yml verify job (lines 75-90) catches a mismatch only after the tag is pushed — failure means delete/re-tag churn; there is no `version:bump` script and no CHANGELOG `[Unreleased]` → section automation.
  - Fix: add a `bun run version:bump <ver>` script that edits both enforced files (and optionally rolls the CHANGELOG heading) in one step.

- [ ] **scripts/ contains unwired one-off tools and a committed generated report** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `scripts/auto-translate-nl.js`, `scripts/auto-translate-nl-pass2.js`, `scripts/locales-capitalizer.js` are referenced by no package.json script, workflow, hook, or docs page (`scripts.md` omits them); `scripts/locales-capitalizer-report.json` is a generated output artifact committed next to the tooling. Dead tools invite running against current locale sources they may no longer match.
  - Fix: delete them (git history keeps them) or document them in `docs/reference/scripts.md` with a "one-off, verify before reuse" note; drop the report JSON.

- [ ] **Minor packaging config nits** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `packaging/electron/package.json:6` — `"packageManager": "bun"` is not a valid corepack value (must be `name@version`); breaks the build the day corepack is enabled on the runner.
  - `packaging/electron/demo-db/regenerate.sh:24` — `PGBIN` hardcoded to `/opt/homebrew/opt/postgresql@18/bin`; fails on any machine without that exact keg (no PATH fallback like the alembic resolution above it has).
  - Fix: remove the `packageManager` field (or set `bun@<version>`); resolve `psql` via `command -v` with the homebrew path as fallback.

- [ ] **Generated locale artifacts are committed in triplicate — growth vector, not yet a problem** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D4_
  - `i18n/source/*.json` + `apps/frontend/src/locales/*.ts` + `packaging/electron/i18n/*.json` (~1.2 MB total, all rewritten by `scripts/generate-locales.js`) plus the periodically re-dumped `packaging/electron/demo-db/01-demo.sql` (1.1 MB) are the main repo-churn sources; pack is still only 17 MiB so this is informational. Note the committed copies are load-bearing (`package.json:21` skips generation in CI), so don't untrack without changing CI.
  - Fix: none needed now; if pack size ever matters, generate electron/i18n copies at package time instead of committing them.

- [ ] **Postgres image pinned by floating tag, inconsistent with digest-pinning everywhere else** ⏬ ✅
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - `docker-compose.yml:3`, `packaging/electron/resources/docker-compose.yml:5` — `postgres:18-alpine`
  - The app `Dockerfile` and devcontainer `Dockerfile` are both digest-pinned; Postgres (holding all user financial data) isn't.
  - Fix: pin to a digest; Dependabot's `docker` ecosystem entry already exists to manage bumps.

- [ ] **`.dockerignore` omits the plain `.env` file** ⬇ ✅
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - `.dockerignore:16-17` — only `.env.local`/`.env.*.local` excluded. Currently harmless (`Dockerfile` uses explicit `COPY <path>`, not `COPY . .`), but no defense-in-depth if that ever changes.
  - Fix: add `.env`/`.env.*` to `.dockerignore`.

## 🧩 Feature work

### AI insight / anomaly agent (scoped from brainstorm — 2026-07-01, redesigned — 2026-07-01)

Two independent layers, split by *cost*, not by feature:
1. **Detection layer (deterministic, runs on normal page load)** — plain-code computation, same cost
   class as any other page in the app (`recurringDetectionService` already runs this way today), so
   no privacy/hardware concern running it automatically. Surfaces directly in the UI with zero LLM
   involvement.
2. **Narration layer (local LLM, on-demand only)** — the *only* part gated behind an explicit user
   click, because it's the only part that spends inference. Never runs unprompted, on any hardware —
   that's the whole reason the earlier scheduled-background design was dropped, and that reasoning is
   scoped to this layer only, not the detection layer above.

**Privacy constraint (non-negotiable, no exceptions):** local model only, via the existing Ollama
integration (`apps/node-backend/src/integrations/ollama/`) — transactions never leave the box, not
even for "non-sensitive synthesis." Extends the no-external-calls guarantee in ADR-024 /
`docs/security/ai-data-access.md`; does not weaken it. Applies only to the narration layer — the
detection layer never touches an LLM, so it's unaffected either way.

**Architecture — two strictly separate stages, do not blur them:**
1. **Deterministic / precalculated (detection layer).** Every *finding* (new subscription, price
   change, category outlier, forecast figure) is computed by plain code — the recurring-pattern diff,
   the outlier z-score, the cached cashflow forecast. No LLM involved, fully reproducible, no
   hallucination risk. Runs automatically on relevant page views (Statistics page, a lightweight badge
   check elsewhere) — *not* gated behind a button. Also exposed as one read-only tool (working name
   `insightsDigest`, alongside `getRecurringDetected`/`getSpendingPace`/`getRecipientInsights` in
   `apps/node-backend/src/services/aiChat/tools/insights.js`) so the narration layer reads the same
   findings instead of recomputing them. Return contract (this is the sole interface between the two
   layers — worth pinning down so two engineers building either side don't diverge):
   `{ subscriptionCreep: { new: [...], priceChanges: [...] }, categoryOutliers: [...], cashForecast:
   {...} }`, each finding array pre-capped per the per-item limits specified below, undismissed
   findings only.
2. **Local LLM analysis (narration layer).** The model only ever sees the *already-computed* findings
   from stage 1 — it never touches raw transactions and never computes a number itself. Its job is to
   prioritize, explain, and phrase, not to detect (same "never cite figures not returned by a tool"
   rule ADR-024 already enforces for interactive chat). **Resolved 2026-07-01: tool-augmented, by
   construction, not a separate choice to make.** Triggered on-demand inside a normal interactive chat
   turn, so it already runs through the existing `dispatchTool` loop with tools enabled — the model
   can call the other read-only Insights tools for extra context (e.g. "how unusual is this recipient
   historically") exactly like it would for any other query.

- [ ] Write ADR: detection-layer/narration-layer split for local-LLM insights 🔼
    - Records the two-layer split above: detection always runs on normal page load (no privacy/
      hardware concern, it's plain code); narration only ever runs on an explicit user click (the only
      part that spends local inference)
    - Records why a scheduled background *narration* job was rejected (unprompted-inference-on-
      unknown-hardware risk), and explicitly notes that reasoning does **not** extend to the detection
      layer — a future reader should not assume the whole feature is gated behind a click
    - Records the surfacing decision below (Statistics panel + button badge, no new dashboard
      banner/card) and its rationale
    - Explicitly extends the no-external-calls guarantee + CI fetch-spy test to the new narration tool

- [ ] Surfacing: Statistics page panel + button badge, no new banner or dashboard card 🔼
    - New panel on the Statistics page mirroring `RecurringDetectionPanel.tsx`'s *UI* pattern only
      (today it only lives on `PlannedPaymentsPage.tsx`) — full card, expand/collapse, default
      expanded. **Not** the same dismiss data structure: the real panel dismisses via one permanent
      `Set<recipientId>` with no expiry (`RecurringDetectionPanel.tsx:36,131-135`), which doesn't fit
      this feature (see key shapes below) — reuse the Card/X-button UI, write new dismiss-tracking
      underneath it
    - Per-item dismiss key shapes (replaces the earlier "diff against a saved last-run snapshot" idea
      for subscription-creep, below): `{recipientId, findingType: 'new' | 'priceChange'}` — new-
      subscription and price-change dismiss *independently*, unlike the recurring panel's single
      shared set, since dismissing one must not silently clear the other; `{categoryId, monthKey,
      dismissedAt, deviationAtDismiss}` for category outliers, so the 14-day suppression window and
      "worsened since dismissal" re-alert (below) can both be computed from the stored record
    - Badge semantics: reflects *undismissed findings only* — the exact predicate the panel itself
      filters on, no separate "last viewed" state. It clears when the underlying finding is dismissed,
      not when the Statistics page is merely opened
    - Badge data source: reads a persisted count from the same cached detection results the Statistics
      panel renders (see caching note below) — it does not independently re-run detection just to
      render a dot; that's what keeps checking it from the AI-chat page cheap
    - Explicitly **not** a new dashboard banner or card. Two reasons found by direct inspection:
      (1) `FxStatusBanner` and `UpcomingPaymentsNotification` already render on every page via
      `AppLayout.tsx` and simply stack with no priority/arbiter mechanism — a third one repeats that
      problem app-wide, not just on the dashboard; (2) `SuggestionCard` was already removed from the
      dashboard once (commit `6785a3eb`) specifically for being "redundant — the upcoming-payments
      banner already covers every page," the same objection that applies to adding a new one here
    - Dependency: the detection layer now runs on every Statistics-page view, not just behind an
      on-demand click — this promotes the existing "`GET /api/info/recurring-patterns` does uncached
      synchronous recomputation" perf finding (TODO.md:360-363 as of this writing) from optional
      cleanup to a prerequisite, since it will now run far more often. The new category-outlier
      detector (below) needs the same caching treatment from day one — don't ship a second uncached
      hot path alongside the fix for the first one

- [ ] On-demand narration: chat button + insights tool 🔼
    - New read-only tool (detection layer above) registered in the existing `TOOLS` map
      (`apps/node-backend/src/services/aiChat/tools/index.js`)
    - New button in the AI chat UI (`apps/frontend/src/features/ai-chat/ChatComposer.tsx` or the empty
      state in `AIChatPage.tsx` — neither currently has any quick-action/canned-prompt pattern, this
      would be the first one) that sends a fixed prompt (e.g. "Give me my insights digest for today")
      into a normal chat turn with tools enabled
    - Tool-call reliability is genuinely unresolved, not "already solved elsewhere" — `prompts.js`
      only does soft, generic steering ("call tools when you need numbers"); nothing in this codebase
      today reliably forces one specific tool for one specific prompt. Pick one before coding, in the
      ADR above: (a) soft system-prompt hint, accept occasional misses; (b) Ollama's forced
      `tool_choice` pinned to the new tool, if the client library supports it; (c) bypass `dispatchTool`
      entirely and call the tool server-side before the model turn, feeding its result into context so
      the model only ever narrates, never decides whether to fetch
    - Reuse the user's already-configured default model (`OLLAMA_DEFAULT_MODEL`/conversation model);
      no new model-selection UI for v1
    - Delivery: no pinned system conversation — the reply lands as a normal assistant message
      (existing `ToolResultCard` + message rendering) in whichever conversation the user clicked the
      button from. Discovery of "something's new" is handled by the badge above, not by this reply, so
      there's no separate notification problem to solve here

- [ ] Subscription-creep digest 🔽
    - Diff layer only, not new detection — `recurringDetectionService.detectRecurringPatterns()`
      already recomputes full history and already flags amount changes (`detectAmountChanges`)
    - Flag `recipientId`s without a matching `{recipientId, findingType:'new'}` dismiss record as new
      subscriptions; flag `amountChanges` without a matching `{recipientId, findingType:'priceChange'}`
      dismiss record as price changes — independently dismissible, per the key shape in the surfacing
      item above (replaces the earlier snapshot-diff approach)
    - Cap the alert list (e.g. top 5 by confidence) so a long gap since the panel was last opened
      doesn't dump a wall of "news"

- [ ] Category-level spend-outlier detection (new service) 🔽
    - Sibling to `recurringDetectionService.js`, not folded into it — different concern (magnitude
      distribution vs. interval pattern)
    - Baseline: median + MAD of monthly category totals over the last 6-7 months. Precedent is
      `quoteBackfillService.js:132-166` + `lib/math.js`'s `median()` helper — **not**
      `detectAmountChanges`, which despite the surface similarity only does a flat ±5% band and has no
      MAD or z-score anywhere in it
    - Compare like-for-like — day-1-through-day-N this month vs. the same window in prior months, not
      a full-month pace projection (avoids "it's the 2nd and you're 15x over" false positives)
    - Flag via modified z-score (`0.6745 × (current − median) / MAD`), threshold 3.5, with an
      absolute-euro floor guard for near-zero-MAD categories; require ≥4 of the last 6 months
      populated before trusting a baseline. This formula/threshold is net-new, not reused from
      anywhere in the codebase — **backtest against real category histories before shipping**, since
      3.5 is uncalibrated for the n=4-6 sample sizes in play here
    - Suppress re-alerting a dismissed category outlier for ~14 days using its own `dismissedAt` field
      (key shape in the surfacing item above); reactivate early if the current deviation visibly
      exceeds `deviationAtDismiss`
    - Cache the result the same way the recurring-patterns prerequisite fix above does — this also
      runs on every Statistics-page view

- [ ] Month-end cash forecast surfacing 🔽
    - No new detection — call `computeCashflowForecast` from
      `services/calculations/forecast/index.js:255` (the Monte Carlo version the nightly
      `refreshCashflowForecastMc` job uses, which already checks `cashflowForecastMcRepository.get()`
      internally and only recomputes on a cache miss). **Not** the differently-scoped, non-MC function
      of the same name in `services/calculations/aggregation/cashflowForecast.js:142` — two files
      export a same-named function, easy to import the wrong one
    - Only call it out prominently when P50 crosses zero (overdraft risk) or moves meaningfully since
      the last digest; otherwise a standing one-line read

---

### Belgian tax pre-fill (deterministic — independent of the insight agent above) 🔽

Decoupled on purpose: no LLM needed, no scheduling machinery, ships on its own.

- [ ] Replace `getDeductibles`'s keyword-substring heuristic with a category→CIR-92-deduction-type
      mapping table 🔽
    - `apps/node-backend/src/services/aiChat/tools/tax.js:20-30` currently matches 9 hardcoded
      substrings against `category_name`; its own code comment already flags this as unreliable
      ("not every hit is actually deductible... genuine deductibles without a matching keyword will
      be missed")
    - Map `category_id` → the specific deduction types the tax calculator already models
      (`apps/frontend/src/lib/belgianTax/constants.ts` — pension savings, life/group insurance,
      charitable donations, childcare, alimony), not fuzzy name matching

- [ ] Surface mapped candidates as a reviewable list on the Tax Overview page (same pattern as
      `RecurringDetectionPanel.tsx`) instead of chat-only 🔽
    - Confirm/reject per deduction-type group, not per transaction
    - A confirmed total writes into the existing `BelgianTaxProfile` field (e.g. `childcareCosts`,
      `apps/frontend/src/lib/belgianTax/types.ts:108` — verify each target field name against
      `types.ts` rather than trusting this list, several are illustrative not exhaustive)
      that `computeBelgianPIT` already consumes — no new tax-calculation logic

- [ ] Out of scope for v1: LLM-assisted reclassification of mis-categorized deductibles (e.g. a
      childcare payment filed under `SHOPPING:MISC`) ⏬
    - Higher risk than the rest of this list — a false positive here feeds a real tax filing, not just
      a dashboard nudge. Keep opt-in/confirm-per-item if ever built, never auto-applied

---

## Still to research — resume points

Where each audit stopped. Pick these up to continue researching.

### 🐛 Correctness

**Correctness research 2026-07-02**

**Biggest remaining gaps (not audited by either audit):** backend `settings` routes/service ·
migrations 0044–0060/0063/0064 downgrade fidelity · frontend date/numeric convention sweep ·
remaining financial forms' validation.

**Wave 1a unchecked residue (resume points):** *(partially closed 2026-07-03 — see §Residue follow-up research; real-export verification remains BLOCKED on user-provided exports)* legacy `bankAdapters.js` shim + `rawTransactionRepository.js` per-bank hash tables (liveness + hash agreement with `tx_hash` — note the repo itself is already flagged dead in the 2026-06-30 audit) · adapter unit tests not read line-by-line (`revolutAdapter.test.js`, `visionAdapter.test.js`, `bankAdapterFactory.test.js`) · real-export verification of BNP/SABB status vocabulary and Belfius/KBC encoding · `transactionExport.js:99` passes a pg Date through `String()` — export `Date` column formatting worth a follow-up check.

**Wave 1b unchecked residue (resume points):** *(closed 2026-07-03 — see §Residue follow-up research)* `portfolioTxRepo.reads.js` (`mapPortfolioTxRow` coercion, `getById` round-trip via `createThroughInheritanceTables`) · full read of `accountBalanceSql.js` (confirms/clears the FX-on-sleeve finding) · `utils/portfolioMath.js` `sanitizeSnapshotSpikes` (could mask or invent discontinuities) · `lib/importDates.js` `parsedDateToYmd` TZ behavior in validate's hash fallback · test suites not read/run (`brokerageFanout`, `portfolioImportCommit`, `tradeCashLegService`, snapshot parity) · adjacent: `portfolioSummaryService`/`allocationAnalytics` parity with the snapshot walk (RoC on the live-summary side — blast radius of the RoC finding).

**Wave 1c unchecked residue (resume points — the frontend half was NOT swept):** frontend date arithmetic (chart/date-axis code, `new Date(` on date-only strings + local getters, `.getTime()` on date-only values, month-boundary math, `todayYmd()` bypasses) · frontend numeric (`parseFloat`/`Number(` on API amounts; TS `number` types where NUMERIC strings could leak past `coerceNumericFields`) · systemic sweep for other routes emitting raw pg Dates through `res.json` (only recurringDetection spotted) · frontend consumer of `firstSeen`/`lastSeen` · remaining `aiChat/tools/*` (portfolio, transactions) for the UTC-today pattern.

**Wave 2a unchecked residue (resume points):** hardcoded-English sweep beyond toasts (`aria-label`, `placeholder`, `title` attributes, literal JSX empty-state/error strings) · remaining financial forms' validation (`EditPortfolioTxnDialog`, add/edit investment, planned-transaction form, `AddAccountDialog`, `TaxProfileDialog` steps, split dialog, `PortfolioCsvColumnMapper`, watchlist target-price) · frontend-optional vs backend-required contract diff beyond `POST /api/transactions`; max-length vs DB varchar widths · money precision (`parseLocaleNumber` + `deriveUnitMath` float multiplication, `.toFixed` before send) · date-field edge cases in planned-transaction/DatePicker flows · nl semantic review beyond the 218 financial-term keys (~3,600 keys not eyeballed).

**Wave 2b unchecked residue (resume points):** **settings scope item skipped entirely** — `routes/settings.js`, `settingsService.js`, `settingsRepository.js`, frontend default copies; specifically jsonb type coercion (`getIncludeTransfers` uses strict `=== true`, infoRepositoryHelpers.js:19 — confirm the write path can never store `"true"` as string) and backend-vs-frontend default drift · backup restore mechanics in `packaging/electron/main.js` (pg_dump flags, FK restore order, sequence `setval`, legacy investments-VIEW installs at dump time — `bundle.js` is fully reviewed) · `attachmentService.js` internals (`storeAttachment` path generation, `resolveAbsolutePath` traversal guard, multer limits) · `infoRepo.forecast.js`/`infoRepositoryNetWorth.js` aggregation paths.

**Wave 2c unchecked residue (resume points):** **migrations 0044–0060, 0063, 0064 unswept** — downgrade fidelity / backfill assumptions / constraint validation, specifically: 0046 vs 0049 (NOT VALID CHECKs then validated?), 0047 partial-unique backfill, 0048 FK ON DELETE semantics, 0050–0054 accounts-epic backfills + dual-write trigger 0051 (downgrade interplay 0062→0051), 0056 downgrade residuals, 0057–0060, 0063/0064 saved-charts `server_default` vs app default · `packaging/electron/assets/error.html` + electron-builder configs not read · backend `/health/detailed` contract vs `pingReady`'s `caches.materializedViews` assumption not cross-checked.

### ⚡ Performance

**Codebase audit 2026-06-30**

**Open gap:** the React Query per-hook configuration audit (staleTime/gcTime overrides on individual hooks, duplicate/overlapping queries across components, mutation-invalidation scope) did not complete in either pass. The verified global default (`App.tsx:93-102`: `staleTime: 30s`, `gcTime: 5min`, `refetchOnWindowFocus: false`, `retry: 1`) is sensible — per-hook overrides are unverified and should be checked separately. *(Closed 2026-07-02 — see the "Performance Research — 2026-07-02" section below.)*

**UI/GPU research 2026-07-02**

**Wave A unchecked residue (resume points):** per-page reads of remaining `glass-regular` hotspots (RealEstatePage 8, TaxOverviewPage 7, MarketLookupPage 7, StocksPage 7 — counted, contexts not read for nesting) · framer-motion `whileHover`/`animate` props outside the filed app-shell set · Electron `vibrancy` tier interaction with glass surfaces (`html.electron-mac.vibrancy`, index.css:541-543) *(partially closed by Wave B's vibrancy finding)* · CommandPalette and OnboardingWizard surfaces · Recharts/visx internal SVG paint cost · no runtime profiling was performed (all findings are static analysis — frame-cost numbers unverified).

**Wave B unchecked residue (resume points):** Electron boot/loading HTML around main.js:1370-1410 (CSS spinner + gradient — likely fine, runs only during boot, not read in full) · whether any full-screen opaque page/dialog ever fully occludes the aurora long enough to justify draw-pausing (dialog overlays appear translucent, not surveyed exhaustively) · Recharts per-chart animation gating (out of this wave's canvas scope) · preload.js beyond vibrancy grep.

**Wave C unchecked residue (resume points):** BarChart/StackedBarChart/PieChart mount-stagger motion.rect/path animation cost at high element counts (large Statistics datasets) · ToolResultCard rendering cost per streaming tool chunk (ai-chat) · Radix Select/Dropdown portal churn in edit-mode table rows · `use-mobile`/matchMedia hooks · SankeyChart in-place layout mutation (`SankeyChart.tsx:6`) render cost.

### 🎨 UI/UX & Design

**Design authenticity 2026-07-03**

**Wave S1 unchecked residue (resume points):** full nl.json read-through beyond the ~150 strings spot-checked (je/u sweep will force one anyway) · hardcoded literals in `packaging/electron/main.js` dialogs (Docker prompts — en.json has `app.*` keys but Electron-side usage not verified) and `apps/node-backend` API error messages that surface in toasts (U4 residue overlaps) · aria-label copy quality (`aria.*` keys) · AI-chat system/tool-result microcopy (`features/ai-chat/` beyond ToolResultCard) · devtools panels intentionally skipped (English-only by design per U5) · keyboard-shortcut help overlay copy (`shortcuts.*`) · date-picker/calendar strings · whether `common.ok`:537 and other orphan keys (`onboarding.importStep.*` family confirmed dead, but no full dead-key sweep was run — pairs with Wave A5's i18n architecture notes).

**Wave S2 unchecked residue (resume points):** light-vs-dark *designed-first* parity needs an eyes-on pass in the Demo app (grep can't judge washed-out light glass; the token structure suggests dark-first tuning of `--glass-*` alphas) · `index.css` 400-1100 region (aurora blobs, film grain, `fx-reduced`) not line-audited for raw color literals beyond the glass/hairline blocks · email/PDF/export color surfaces (CSV export has none, but check any print stylesheets) · `packaging/electron` icons/dock/menubar color language · devtools panels' raw palette (RequestList sky/orange) deliberately left as-is pending a "devtools are exempt by design" decision (they're English-only by design per U5 — a matching color exemption should be made explicit) · hover/focus *state* color consistency (focus rings vs `--ring`) belongs to Wave S5's motion/interaction pass · per-theme-variant visual QA (Dracula/Nord chart-token contrast against glass) untested.

**Wave S3 unchecked residue (resume points):** eyes-on Demo-app pass — grep can't judge Fraunces' optical size at 14px (finding 5), actual decimal alignment in rendered tables, or RollingNumber reel alignment against Money parts · tax surfaces (`TaxOverviewPage.tsx:89` local `fmt`, `components/tax/` tables) and ImportReviewPage numeric columns not alignment-audited · chart tick/axis label typography (`components/charts/` fontSize props, recharts defaults) unswept · date-column typography (month-name truncation, weekday abbreviations) skipped · `text-xs`×606 not triaged into legit-dense vs chrome-creep (sampled only) · line-height/leading discipline unmeasured · `formatCurrencyCompact`'s 9-char threshold (`utils/currency.ts:151`) means the dashboard hero silently goes compact ("€12.3K") for large balances — flagged, not filed (may be deliberate; check with user) · Electron-side native font surfaces (menus, about panel) skipped · `RebalancePage.tsx:87` `Intl.NumberFormat(undefined, …)` ignores the app numberFormat setting — locale correctness = Wave U5's axis, left to it.

**Wave S4 unchecked residue (resume points):** settings sheet/sections composition (`components/settings/` — section anatomy uniformity unaudited) · AIChatPage and admin pages (TableDataEditorPage's 16-icon import list noted but not composition-audited) · MarketOverviewPage's ~1000-line body and its heat-grid composition · research pages beyond ResearchHomePage/Forecast (WatchlistPage, ResearchComparePage table anatomies) · `components/tax/` sub-widgets (MultiYearTrendStrip, YearComparisonCard) not read — the year-masthead fix above should absorb them · hand-rolled empty/error-state anatomy convergence (PageError vs EmptyState vs 5 inline clones — deliberately left to S6, moments-of-truth axis) · eyes-on Demo-app pass to confirm the stat-dialect visual clash and EntryCard grid feel (grep-verified only) · dashboard widget-visibility system (`useWidgetVisibility`) as a composition tool — whether hidden-widget layouts still compose well was not tested.

**Wave S5 unchecked residue (resume points):** eyes-on Demo pass to *feel* the double-entrance mush and the menu-vs-dialog physics mismatch (grep/read-verified only) · sonner toast enter/exit/swipe physics beyond the icon bounce (library defaults unaudited) · command palette (cmdk, if present) and combobox open animations · `animate-stagger`'s 12-child delay cap (`index.css:818-829`) vs actual max child counts of its 3 grids — children 13+ would animate *first* (delay 0); unverified whether any grid exceeds 12 · ChartTooltip follow/cursor physics not judged for feel · sheet slide direction/duration asymmetry (open slow / close normal is deliberate per `sheet.tsx:32` — but slide-from-side character unreviewed) · loading-state *character* (Loader2-everywhere ×32 files vs one bootleg `bg-muted animate-pulse` skeleton at `SavedChartsSection.tsx:67`) deliberately left to S6's moments-of-truth axis · the 4 stray `focus-visible:ring-primary/50` sites (color drift, S2 residue) noted but not filed.

**Wave S6 unchecked residue (resume points):** eyes-on Demo-app pass — everything above is grep/read-verified; the splash→app handoff (no `backgroundColor` on the BrowserWindow — potential flash before the splash data-URL paints on cold boot) and first-run dashboard-behind-wizard feel need real eyes · Windows/Linux window icon (`BrowserWindow` sets no `icon` option; electron-builder config for non-mac icons not inspected) and the Demo-app icon variant (`resources-demo/`, `electron-builder-demo.json`) not compared against the main mark · settings sections beyond AboutSection not audited for identity/craft · print styles: zero `@media print` repo-wide — a print/PDF-clean TaxOverviewPage is a plausible crafted touch for a Belgian tax feature but was not scoped · PWA manifest / installable-web-app identity (no manifest.json) noted, not evaluated · AI-chat tool-result loading/error sub-states (`features/ai-chat/`) beyond the page empty state · `common.notFound`/`common.notFoundDesc` (`en.json:533-534`) look like a dead parallel copy of the `notFound.*` family — dead-key sweep pairs with S1's residue.

**UI/UX research 2026-07-03**

**Wave U1 unchecked residue (resume points):** Electron native-menu accelerators (`packaging/electron/main.js`) vs in-page handler overlap · DatePicker/Calendar keyboard operability · combobox family (CategoryCombobox, RecipientCombobox, BankAccountMultiCombobox, TagFilterCombobox, SymbolSearchBox) · OnboardingWizard focus flow · DashboardSettingsDialog tab keyboard nav · sonner toast keyboard/focus access · TransactionsPage quick-look (Space) end-to-end wiring · route-change focus management (does focus reset to top after PageTransition navigation?) · mobile Sheet-sidebar focus behavior · whether rowContextMenu-only actions are reachable via keyboard context-menu key (Radix ContextMenu) · admin pages · settings sections.

**Wave U2 unchecked residue (resume points):** MarkAsFiledDialog / ExportDialog / LinkTransactionDialog / BulkRecategorizeDialog / BulkRecipientDialog / BulkExportDialog field-level detail · settings sections input semantics (GeneralSection, BehaviorSection, AppearanceSection, StatisticsSection) · OnboardingWizard forms · autocomplete-attribute sweep (autofill on name/address-like fields) · focus-on-first-field per dialog (Radix default assumed, not verified per-dialog) · TaxProfileDialog wizard step-validation flow + `value={x || ''}` controlled-number quirks (typing "0", partial "12.") · admin forms (ExchangeRatesPage, AdminOverviewPage token field) · import parser-config forms · CategoryCombobox free-text creation parity · RecipientCombobox stale `displayLabel` when search filters out the selected item (RecipientCombobox.tsx:31-33).

**Wave U3 unchecked residue (resume points):** portfolio page-internal state URL-sync (NetWorth/Performance range pickers, rebalance inputs) · ResearchComparePage compared-symbols + ChartBuilderPage config shareability · RecipientsPage/PlannedPaymentsPage/CategoriesPage sort+search URL-sync (same class as the transactions finding) · browser-back-while-dialog-open behavior (should dialogs close on popstate?) · document.title ↔ Electron window title interplay · scroll position within virtualized tables on back-nav (separate from window scroll) · OnboardingWizard navigation flow · CommandPalette recents vs URL params · settings surfaces deep-linking (can you link to Settings→Appearance?) · `/import` vs `/portfolio/import` IA duplication.

**Wave U4 unchecked residue (resume points):** AI-chat streaming interruption/partial-stream recovery UX (aiChatStreamStore) · 401'd admin sub-pages guidance (do ExchangeRates/ProviderHealth errors point at the /admin token card?) · FX rate age display / FxStatusBanner content detail · background `isFetching` indicators on placeholderData'd lists (stale-while-revalidate shows no spinner anywhere) · success-toast consistency on update ops (accounts/categories/tags update succeed silently — change visible inline, not verified per-surface) · `lib/api/reports.ts` consumers (report/PDF export surfaces not traced) · raw network-error copy leaking into toast descriptions ("Failed to fetch" / "Request timed out" — U5 copy territory) · OnboardingWizard step-level feedback · per-widget query-error rendering on dashboard (blank vs error text) · sonner Toaster configuration/SR announcement behavior.

**Wave U5 unchecked residue (resume points):** nl.json terminology parity for the investment/holding decision (belegging vs positie) · truncation/overflow sweep of long entity names (only spot-checked AccountsPage/BankBalancesWidget) · button variant/size drift for primary dialog-footer actions · spacing/card-padding system drift · date *pattern* drift ("MMM yy" vs "d MMM yy" vs "dd MMM yyyy" across chart tooltips) · OnboardingWizard + settings-sections copy tone · Electron native menu strings (packaging/electron/main.js) vs in-app language · empty-state copy tone consistency · raw network-error copy in toasts (carried from U4 residue) · en/nl full-file re-validation (`bun run validate-locales`) after any fixes.

**Wave U6 unchecked residue (resume points):** live-device verification of all of the above (this wave is static-only) · on-screen-keyboard vs fixed-centered dialogs (does the keyboard cover the focused field at 50%-top positioning?) · landscape-phone short-viewport behavior of `h-[82vh]`/`max-h` dialogs · 125-150% browser-zoom sweep for `h-[Npx]` text-container clipping · Radix Select/Popover/DropdownMenu content widths vs 375px viewport · chart-tooltip dismissal on touch (tap-away behavior after a tap opens it) · OnboardingWizard, ImportReviewPage, OwesPage detail and planned-payments surfaces at 375px (not individually swept) · whether the app should ship a PWA manifest + safe-area insets for home-screen tablet use · dialog rounded-corner/edge-flush cosmetics at exactly 375px · Electron minimum-window-size vs these breakpoints.

### 🏛️ Architecture & API

**Code/architecture 2026-07-03**

**Wave A1 unchecked residue (resume points):**
- Deep internals of the 174 services/ files (Wave A2) — only seam files, routeManifest, and import sites touched.
- repositories/ (42 files) internals beyond the two middleware-import spot checks; backup/ dir not examined at all.
- Per-export dead-code analysis inside lib modules (only file-level consumer counts checked); utils/portfolioMath.js export-by-export usage.
- Full reads of routes/importRoutes.js, portfolioImportRoutes.js, ai.js, marketLookup.js, research.js, crossWorkspace.js (skimmed for SQL/catch style only — their multi-step orchestration may hide more service-shaped logic).
- middleware/rateLimiter.js and requestMetrics.js internals; config/ dir quality.

**Wave A2 unchecked residue (resume points):**
- `services/calculations/aggregation/*` (sankey etc.), `calculations/forecast/methods/*`, and `research/adapters/*` internals read only at header level.
- `services/reports/sections/*`, `puppeteerRenderer.js`, `themeCss.js` not read.
- Dead-export scan was a spot check (recurrence, currencyConversionService, quoteBackfill only) — no exhaustive export-vs-import diff across the 42 repositories or remaining services.
- Return-shape audit (`rows[0] || null` vs throw) verified against the pattern doc for ~8 repos only; per-repo row coercion (`coerceNumericFields`) coverage not re-verified (June 2026 pass claims it done).
- `bankAdapters.js`, `dataImportService.js`, `attachmentService.js`/`attachmentRecordService.js` pair, and the ADR-067 seam files not individually read (seam style covered by A1).

**Wave A3 unchecked residue (resume points):**
- `lib/belgianTax/` internals (pit.ts 620 lines, constants.ts 615) — read only headers; pure-logic organization not assessed.
- `lib/aiChatStreamStore.ts` (275 lines, a hand-rolled non-zustand store) and `lib/research/`, `lib/tax/`, `lib/devtools/` module internals — topology noted, contents unread.
- Full dead-file sweep of lib/ (only 7 suspects import-counted; a systematic knip/depcheck run not done).
- `hooks/useStatistics.ts` (390 lines) and `hooks/usePlannedPayments.ts` (302) — largest hooks unread; possible internal duplication with aggregations API module.
- The 146 component-level useQuery sites were counted, not individually reviewed (Wave A4 territory).
- `types/research.ts`/`types/portfolio.ts` overlap with `lib/api/types.ts` (177 lines) not diffed — possible duplicate DTO definitions between the two type homes.

**Wave A4 unchecked residue (resume points):**
- Dead sweep is grep-by-filename: misses dynamically referenced/lazy-loaded names; ui deadlist not cross-checked against docs/storybook references.
- Not read file-by-file: components/{settings,statistics,tax} subtrees, pages/admin scaffolding overlap (ExchangeRates vs ProviderHealth), OwesPage/PlannedPaymentsPage/OnboardingWizard/CommandPalette internal cohesion, components/ui/sidebar.tsx (630, presumed stock shadcn).
- Prop drilling only traced on the TransactionsPage tree; DashboardPage and portfolio-overview trees not traced.
- research/ pages (ResearchComparePage 616, ChartBuilderPage 606, MarketLookupPage 571) not diffed against each other for shared symbol-search/table scaffolding.

**Wave A5 unchecked residue (resume points):**
- Field-level fidelity of types/{splits,watchlist,aiChat}.ts vs backend response shapes (only name/structure-level dedup checked; A3/openapi passes cover generated drift).
- Per-module inline interfaces inside lib/api/*.ts (accounts/admin/info etc.) — not swept for further structural dupes against types/.
- packaging/electron i18n generation internals and whether commitlint/gitleaks configs in config/ are wired into CI.
- madge on FE may under-detect cycles introduced via dynamic `import()`.
- Backend route files under routes/info/* beyond netWorth.js not individually checked for pagination shape.

**Codebase audit 2026-06-30**

**ADR / architecture drift gaps (not findings — explicitly incomplete checks, don't treat as "passed")** *(re-confirmed 2026-06-30: all six ADR pairs are real, and none are answered elsewhere in this document — genuinely unresolved, accurately scoped)*

- [ ] Re-run: ADR-090 (cash-sleeve-trades-as-transfers) vs. ADR-083 (internal-transfer-detection) contradiction check 🔽

- [ ] Re-run: ADR-092 (liabilities-as-negative-accounts) vs. ADR-089 (account-typed-model) contradiction check 🔽

- [ ] Re-run: ADR-099/104/105 sidebar/visual-redesign vs. current code check 🔽

- [ ] Re-run: ADR-102 unified-tax dead-code grep (confirm fully removed) 🔽

- [ ] Re-run: ADR-103 flag-default verification across all surfaces 🔽

- [ ] Re-run: net-worth/liquid-assets calc vs. ADR-093 independent re-verification (prior fix verified 2026-06-19/21 — likely low risk, just not re-checked in this pass) ⬇

### 🏗️ DevOps / CI-CD / Packaging

**DevOps research 2026-07-03**

**Wave D1 unchecked residue (resume points):** Actual branch-protection / ruleset configuration on GitHub (which checks are required, whether "Allow auto-merge" is on, whether CodeQL gates merges) — not inspectable from the repo, needs `gh api repos/.../branches/main/protection` · whether the two ignored fast-uri GHSAs are still open (determines if the release-audit-drift finding is currently blocking) · live behavior of the e2e workflow (never run — the `.env` fix needs a dispatch run to confirm the rest of the job, browser install, `PLAYWRIGHT_BASE_URL` wiring) · whether `vitest-coverage-report-action` behaves cleanly on push (non-PR) events and when coverage JSON is missing (`if: always()` at `ci.yml:313,361`) · gitleaks config quality (`config/gitleaks.toml` not reviewed) · commitlint exists only as a local git hook (not CI-enforced) — accepted, not assessed · stryker mutation testing (`test:mutation`) runs in no workflow — presumed deliberate, not assessed · whether GHA artifact-quota pressure could be relieved by replacing the image tar hand-off with a registry or cache-based hand-off (design sketch only, not validated).

**Wave D2 unchecked residue (resume points):** `alembic/env.py` (URL construction from env, transactional-DDL behavior on retry) not read · Electron orchestrator (`packaging/electron/main.js`) — how it surfaces app crash-loops/migration failures and whether it monitors container health · GHCR image publish/release workflow (CI side — Wave D1 territory) · backup/restore story for the `postgres_data` volume (app-level backup covers tables, volume-level DR not assessed) · semantics of running `docker:dev` while packaged Vision.app is up (same project name → compose recreates the packaged containers with dev config — intended per comments, but not exercised) · bun-as-PID-1 signal delivery assumed from `exec` + `bun run <file>` direct execution, not empirically verified in-container.

**Wave D3 unchecked residue (resume points):** `packaging/electron/backup/bundle.js` (backup bundling helper — never audited in any wave) · `packaging/electron/demo-db/generate.mjs` internals (synthetic-data correctness) · `packaging/electron/preload.js` and `assets/error.*` · frontend update UI behavior around `update_mode`/`source_launcher_available` rendering (only wiring confirmed) · `.githooks/pre-commit` body beyond the first ~80 lines · `apps/node-backend/scripts/` (index-stats, check-precision-drift, densify-asset-history) · i18n script internals (`generate-locales.js`, `sync-nl-with-en.js`) · full accuracy sweep of `docs/reference/scripts.md` (only spot-checked) · `packaging/electron/unsigned/launch.command` fallback-scan behavior (picks the first sibling dir with a package.json — could launch the wrong project).

**Wave D4 unchecked residue (resume points):** `~/.config/fish/functions/vision-claude-sync.fish` and `vision-claude.fish` (host-side, outside the repo — sync/merge logic not audited) · host `~/.claude/hooks/guard.mjs` + `managed-settings.json` (mounted into the sandbox, contents not reviewed) · the upstream `devcontainer-egress/` sync source repo · `apps/frontend/.env.local.example` + `packaging/electron/resources/.env.example` completeness vs docs (only root `.env.example` spot-checked) · `docs/reference/environment-variables.md` accuracy vs actual `process.env` reads (69 documented vars not cross-verified) · whether `.vscode/`-less repo + no `devcontainer.json` matters for any non-CLI workflow.

**Codebase audit 2026-06-30**

- [x] Backend code-design: route→service boundary full sweep beyond the ADR-067 spot-check above, dead-shim sweep, empty-catch-block check 🔽 — **closed 2026-07-03**, see "Code Design & Architecture Research — 2026-07-03" Wave A1 (boundary loophole + reverse-layering findings; empty-catch check came back clean)
- [x] Backend performance: full systematic pass over `services/reports/sections/*` and the complete `aggregations.js` index cross-check (spot-checked only, lower-confidence-clean) 🔽 — **closed 2026-07-02**, see "Performance Research — 2026-07-02" below
- [x] Frontend performance: React Query per-hook config audit (staleTime/gcTime overrides, duplicate queries, invalidation scope per individual hook — see gap note above) 🔽 — **closed 2026-07-02**, see "Performance Research — 2026-07-02" below

## Checked clean — do NOT re-audit

Already verified sound in the passes below.

### 🐛 Correctness

**Correctness research 2026-07-02**

**Wave 1a checked clean (don't re-audit):** `parseDayMonthYear` + `parseDateFlexibleUtc` (round-trip validated, UTC-midnight, no TZ shift; SABB guards the DD/MM trap explicitly) · amount-parsing core (`parseDecimalSafe`/`parseCommaDecimal`/`parseAmountField` — Decimal throughout, EU/US formats, parentheses; lone `1.234`/`1,234` ambiguity is a documented fixed choice) · BOM/CRLF handling · IBAN propagation in Belfius/KBC/ING/BNP (KBC collapse class fixed in all IBAN adapters; SABB has no account column) · sign/direction in all adapters (Wise Direction handling correct) · stage/commit date paths · hash dedup + SAVEPOINT race-safety at commit · skipped-row counters surfaced · generic adapter fail-fast on bad date_format · match-phase recipient upsert.

**Wave 1b checked clean (don't re-audit):** repo choke-point numeric guards (zero/negative units/price/amount, `|units×price − amount| ≤ 0.01` cross-check, `fx_rate_to_eur ≤ 0` rejected) · FX stamping at commit (row rate wins; on-or-before rate for correct currency at row date) · ADR-095 double-count guard in the staged path · `computeTradeCashLegAmount` signs match ADR-090 exactly, Decimal-based · type normalization (unknown types error, no silent default) · dedup hash includes route+type · snapshot date boundaries (todayAppDateString both sides; txn-date FX for invested, valuation-day FX for value; Decimal accumulators; latest day reconciles with live summary; `'unassigned'` covers NULL-account lots) · snapshot persistence (DELETE+INSERT in one txn) · orchestrator failure path marks batch `failed` · `commitBrokerageFanout` confirmed no production callers.

**Wave 1c checked clean (don't re-audit):** import-pipeline dates (`wise.js`/`revolut.js`/`_shared.js`/`importDates.js`/`commit.js`; `deduplication.js:13,44` `toISOString` is safe on adapter-produced UTC-midnight Dates) · `loanSchedule.js` (fully `Date.UTC`) · `snapshotBuilder.js:324` (consistent UTC roundtrip) · `aiChat/tools/_validate.js:30` · provider-timestamp→ymd paths (`priceCache.js`, `rateFetcher.js:200`, `quotaGovernor.js`, `finnhubAdapter.js`, forecast toIso — light check) · benign ISO timestamps (backend main/logger/admin/warmup, filename stamps, frontend timestamp-only hits) · backend `parseFloat`-on-NUMERIC sites (`sankey.js`, `normalization.js:112`, `rateFetcher.js:62`, `priceProviderRegistry.js:365`, `belgianInflationService.parseNumeric`) — per-site coercion before arithmetic, not the canonical helper but no correctness bug · `infoRepositoryPlanned.js:40-47` month-window construction.

**Wave 2a checked clean (don't re-audit):** NO semantic inversions in nl — all 218 financial-term keys (income/expense, buy/sell, gain/loss, deposit/withdraw, owed, realized/unrealized) reviewed side-by-side, directions correct · all dynamic-key families enumerated and present (portfolio.assetClass 7/7, txnType 9/9, accounts.*, research.scorecard/metric, tax.history.kind 6/6, tax.profile.*, cashflow.window, performance.*, export.*, rebalance.* incl. unknown-sleeve fallback) · all 6 `tc()` plural families correct in both languages (nl/en share CLDR one/other, no category gap possible) · no English-literal `toast.*()` calls · no hardcoded `Intl.*Format('en-US')` locales · `AddPortfolioTxnDialog` amount/units/price validation (≤0/NaN/Infinity rejected, buy/sell 2-of-3 consistency, gift-zero intentional) · single-brace interpolation matches runtime (`LanguageContext.tsx:104-108`) · backend `recipient_id` positive-int validation.

**Backup coverage: verified in sync (not a finding)** — the agent RAN `tests/backup-coverage.test.js`: 6/6 pass; the test derives the table set from all Alembic migrations, so accounts-epic tables, `portfolio_import_*`, `db_editor_audit`, `watchlist` are covered. Only staleness: `backup/coverage.js:23` header says "Last verified against: 0035" — update the comment.

**Wave 2b checked clean (don't re-audit):** transfer date-window inclusivity consistent (SQL BETWEEN vs JS ±3d) · same-account pairing excluded on both paths; `findTransferMatches`' bank_account comparison is test-only (no production callers) · sign handling consistent (zero-amount rows counted as income everywhere, deliberately) · hard-delete of one leg correctly releases the survivor via FK-NULL + `releaseOrphans` · edit-invalidation symmetric for reciprocal auto pairs · `resolveTransferMatches` mutual-unambiguity correct (contended matches demote to suggestions) · live-path month boundaries half-open (no double count) · MV transaction_count halving exact · MV fast-path gating on `includeTransfers`/currency homogeneity/exclusions consistent with live paths · `mvAvailable` allowlist + negative-TTL recovery · attachment download filename sanitization + 404s · attachment upload content-sniffing before store.

**Wave 2c checked clean (don't re-audit):** ADR-026 envelope unwrapping correct in both `httpGet` consumers · the memory-noted crash-recovery port-walk bug is FIXED · health-poll vs window-load race handled (splash → matview-gated `pollReady` → watchdog) · quit ordering (backup before `compose stop`, SIGTERM graceful) · IPC path-traversal guards on restore/zip-extract/update-ZIP + sender checks on restore/badge/accent/splash · update download (mandatory checksum, SHA256, cleanup, timeout) · single-instance lock + macOS activate · contextIsolation/sandbox/preload posture · compose volume parity root↔resources · backup crypto streams (v1/v2, GCM tag, keys zeroed) · migration 0061 (side-table design safe on legacy investments-VIEW installs, re-run-safe, documented no-FK) · 0062 otherwise (NULL-safe `IS DISTINCT FROM`, BEFORE UPDATE row trigger, split-guard tolerance + ERRCODE, downgrade is a true reverse restoring the 0056 function verbatim).

### ⚡ Performance

**Performance research 2026-07-02**

- **React Query:** global defaults respected everywhere (no `staleTime: 0` / `refetchOnMount: 'always'` in src); PortfolioTicker polling is exemplary (IntersectionObserver + `document.hidden` + online gating); dialog-scoped queries properly `enabled`-gated (Merge/Patterns/Watchlist/Research dialogs, CommandPalette); research-tab staleTimes correct; no unstable query keys found (exclusion arrays deduped+sorted+memoized); portfolio mutations invalidate scoped prefixes; watchlist/market polls online-gated and deduped across pages.
- **Runtime:** `useCountUp` rAF-driven with reduced-motion snap; `RollingNumber` pure CSS; `ThemeContext`/`UpdateNotification` timers gated; zero `JSON.parse(JSON.stringify)`/`structuredClone` in the frontend; `useStatistics` fully server-aggregated; DashboardPage/RecipientsPage/PlannedPaymentsPage/PortfolioOverview/Stocks derived data memoized; `useCurrencyFormatter` caches correctly.
- **Bundle:** sourcemaps off in prod; no moment/lodash/jspdf/xlsx anywhere; date-fns in a non-preloaded chunk; visx isolated in a lazy chunk; all 38 routes lazy with sidebar hover-prefetch (`lib/routePreload.ts:51-58`); devtools env-gated and absent from prod chunks; Tailwind content globs tight (25 KB gz total CSS); `public/` is tiny.
- **Backend infra:** gzip wrapper is SSE-exempt + backpressure-correct; `express.json` 1MB limit; SPA shell preloaded into memory at boot; per-request middleware all O(1) with bounded memory; in-memory rate limiter O(1) with unref'd sweep; `/health` DB-free (detailed probe 1s-cached); PG pool sizing/withTransaction-release/poisoned-client handling all correct; startup fully parallelized post-listen with an offline short-circuit and an alembic skip-at-head cache; MV refresh CONCURRENTLY + coalesced (only the scheduling/timeout issues above); background jobs overlap-guarded with cleared intervals; graceful shutdown drains correctly; Electron health watchdog cheap (10s, keep-alive agent, no execSync anywhere).
- **Reports:** Puppeteer page-per-render closed in `finally` (only the launch race above); all 21 section renderers are pure string builders over pre-aggregated data with top-N caps, zero DB access; `dataFetcherTax` FX loop uses a binary-searched rate index (no per-row queries); sankey fully SQL-aggregated; `mvAvailable` probe cached; MC paths clamped at the route; backtest doesn't forward user `paths`.
- **DB:** systematic FK-index pass over migrations 0001→0064 found all *other* queried FK columns indexed (transactions, planned, splits, attachments, tags junctions, staging batch ids, portfolio 0052 columns, recipients); all 4 MVs have the unique indexes CONCURRENTLY requires with a correct non-concurrent fallback; `asset_price_history` pruned to holding windows; `rateFetcher`/`belgianInflationService`/`settingsRepository.setMany`/`cleanupStaleQuotes` all batch correctly; raw bank tables grow by design (dedup source of truth, indexed).

**UI/GPU research 2026-07-02**

**Wave A checked clean (don't re-audit):** theme switch (theme-flash.ts flips `.dark` class pre-paint; no `* { transition }`, no root/body color transition — switch is one style-recalc + single repaint, no animation wave) · `will-change`/layer-promotion (only 3 sites in index.css:573,727,941 — aurora blobs, micro-lift hover, ticker — all justified, no `translateZ(0)` hacks) · PortfolioTicker marquee gating (IntersectionObserver + visibilitychange + hover pause + conditional will-change, PortfolioTicker.tsx:83-95 — exemplary) · `drop-shadow()`/SVG filters (single 3.5px star icon at MarketOverviewPage.tsx:1025, no feGaussianBlur anywhere) · no `background-attachment: fixed`/`bg-fixed` · no transitions on `filter`/`backdrop-filter` anywhere · form controls & button variants use explicit `transition-[...]` property lists rather than transition-all (button/input/select/switch/checkbox/toggle/slider) · reduced-motion + reduced-transparency + prefers-contrast + fx-tier fallbacks comprehensive and mutually consistent (index.css:977-1122) · `animate-in`/`animate-stagger`/dialog enter-exit keyframes finite, opacity/transform-only · `animate-spin`/`animate-pulse` instances are transient loading spinners (compositor-friendly) · app-topbar correctly drops its backdrop-filter at scroll-top (index.css:500-503) · sonner toasts/popovers/menus glass-thick (transient, bounded) · scrollbar styling.

**Wave B checked clean (don't re-audit):** single ShaderAurora instance for app lifetime (AppLayout mounted once outside `<Routes>`, App.tsx:181, no per-route remount/context churn) · no GL context re-creation on theme change (MutationObserver color refresh only, ShaderAurora.tsx:152-153) · context attrs otherwise sane (`preserveDrawingBuffer` default false, `antialias:false`, `depth/stencil:false`, cleanup calls `WEBGL_lose_context.loseContext()` + cancels rAF + removes listeners) · DPR deliberately ignored in canvas sizing (0.25×/640px blurry-noise cap makes DPR moot; window `resize` catches cross-monitor moves) · no `backgroundThrottling:false`, no `appendSwitch`, no `disableHardwareAcceleration`, no `powerSaveBlocker`, single BrowserWindow, sandbox/contextIsolation on (main.js:1485-1510) — Electron default throttling does stop rAF+CSS animation when hidden/minimized/fully-occluded (so the always-running auroras are saved there, just not on blur-while-visible) · no other `<canvas>`/`getContext`/`OffscreenCanvas` anywhere in apps/frontend/src · no canvas-based chart/animation libs (Recharts is SVG; no confetti/three/pixi) · VirtualDataTable.tsx:409-411 rAF is a bounded 5-attempt focus retry, not a loop · RollingNumber.tsx:32 is a single settle rAF · no `<video>`/GIF/`image-rendering` usage · RemoteNewsImage.tsx:51 already has `decoding="async"` · useLargeDisplay 5s poll is 4 property reads (negligible).

**Wave C checked clean (don't re-audit):** AppLayout window-scroll topbar effect (`AppLayout.tsx:82-90` — passive, boolean setState with React same-value bailout, `children` element reference stable so page subtree doesn't re-render on threshold crossings) · VirtualDataTable infinite-scroll handler (`VirtualDataTable.tsx:414-449` — passive, ref-guarded, no per-scroll setState) and its single-instance document mousedown/keydown listeners (198-213) · ShaderAurora (rAF capped 30fps, 0.25× res, resize handler only sets canvas dims, getComputedStyle only on mount/theme MutationObserver, full cleanup) · useLargeDisplay/useVisualEffectsTier (resize listener + 5s poll, boolean bailout) · PageTransition (animates opacity/y/scale = transform-only, no AnimatePresence, no layout props, reduced-motion bypass) · tabs.tsx active pill and AppSidebar ActiveRail (layoutId FLIP on discrete tab/route change only, transform-based) · dialogGenie (one module-level passive pointerdown listener + single GBCR at dialog mount) · ElectronBridge window dragover/drop (guarded, no state) · CommandPalette forceMount (bounded: ≤5 recipient hits + single result items, palette mounted only while open) and its single ⌘K document listener · sidebar/ShortcutsOverlay/useGoToShortcuts/AppLayout keydown — all single-instance app-shell listeners, no per-row listeners anywhere · DonutChart hover (event-driven enter/leave, AnimatePresence center swap is one small node) · ResizeObserver usage (only visx ParentSize per chart, one element each, library-managed disconnect) · themeTokens getComputedStyle (report-export one-shot only) · no window `resize` setState storms found · no framer `layout` prop usage on motion components · no Radix tooltips/hover-cards on table rows (HoverCard imported nowhere; TooltipTrigger only in sidebar/ExclusionToggle/TaxOverviewPage at low counts) · CsvDropzone dragover (boolean state, import page only) · no measurement→state→layout feedback loops beyond the ChartTooltip one reported above.

### 🎨 UI/UX & Design

**Design authenticity 2026-07-03**

**Wave S1 checked clean (don't re-audit):** zero "Oops/Whoops/Uh oh/Awesome/Great!" anywhere (en.json, nl.json, and all of `apps/frontend/src` — only a code comment in `lib/undo.ts:4`) · no marketing-speak: 0× seamless/effortless/powerful/easily, and only 2 "Manage your"-type subtitles (filed above) · portfolio buy/sell flow verb-consistent (button "Record":174 → toast "{type} recorded for {name}":184) · "OK" exists only as unused `common.ok`:537, no "Submit" anywhere · placeholders are overwhelmingly the good "e.g. <real value>" pattern (~20 sites) with real examples, incl. `dbEditor.rawWherePlaceholder`:732 showing an actual WHERE clause · the 4 tooltip strings (`accounts.balanceTooltip`:6, `accounts.driftTooltip`:24, `portfolio.stalePriceTooltip`:1843, `tax.pit.tooltip`:3039) all add information, none restates a label · nl.json has no "Gelieve" (over-formal Flemish) and no meaningful untranslated-English leakage (the 103 identical en=nl values are legit shared terms: Type, Status, Dashboard, Crypto, MACD…) · destructive confirms mostly name the object and consequence (`accounts.mergeWarning`:58 is exemplary); the weak category/recipient ones are already filed by Wave U2 (TODO ~line 492) · Title Case vs sentence case drift already filed by Wave U5 — not re-measured · error strings largely interpolate real reasons via `{msg}` (28 sites) · onboarding restore-flow copy (`onboarding.restore.*`:1404-1412) is precise and consequence-stating.

**Wave S2 checked clean (don't re-audit):** zero raw indigo/purple/violet/fuchsia/pink/rose/teal/cyan classes anywhere in `apps/frontend/src` (the classic gradient-slop hues are simply absent); only one `bg-clip-text`/`text-transparent` in the whole app (filed above) and zero `from-blue→to-purple` gradients — all 68 `bg-gradient-to-*` sites except the corner-orb family and DbMaintenance orange use tokens (`primary/accent/gain/loss/chart-N`) · hardcoded hex in TS/TSX: only `charts/BarChart.tsx:360` (`var(--background, #fff)` fallback — fine) · `ShaderAurora.tsx:146-150` reads `--primary`/`--accent` live from the theme (WebGL is token-driven, one gradient language with the CSS aurora) · `TagInput.tsx:13-26` palette is a *designed*, named jewel-tone wheel with `color-mix` tinting — a model, not a violation · `components/charts/palette.ts` + `ChartTooltip`/`ChartLegend`/axis neutrals are fully token-routed; recharts defaults nowhere · gain/loss token discipline is genuinely good: `--gain/--loss` → 166 combined uses, sign-conditional `text-success:text-destructive` ternaries = 0 (ADR-104 colorblind toggle is respected on every money surface checked, incl. WatchlistChartDialog's inverted below-target=gain logic) · `--warning` correctly adopted in 74 places (the 6 stragglers filed above) · theme variants in `styles/themes.ts` define the full token surface incl. all 8 chart colors and glass tokens (no partial-variant gaps) · dialog/popover/dropdown/sheet uniformly `glass-thick` and sidebar `glass-chrome` — the chrome/overlay tiers ARE hierarchical · onboarding wizard section colors are token-based (`chart-3`/`primary`) · overlay scrims consistent (`bg-background/40 backdrop-blur-md` ×3).

**Wave S3 checked clean (don't re-audit):** the font system itself is real, not templated — three deliberate roles (`styles/tokens.css:120-124`): Fraunces Variable display for h1–h3 with `dlig` + −0.02em (`index.css:39-46`), Inter body with `ss01/ss02/cv11` + −0.005em, SF Mono for identifiers; self-hosted via @fontsource with weights matching usage (400/600/700 Fraunces, 400/500/600 Inter — `main.tsx:9-14`), no Google-Fonts CDN, no generic single-stack tell · `.tabular-nums` is *overridden* to add −0.006em numeric tracking (`index.css:879-882`) — a real craft touch — with 234 uses; StocksPage holdings table (`pages/portfolio/StocksPage.tsx:306-380`) and NetWorthPage account rows/stat tiles are right-aligned + tabular throughout · `Money.tsx` and `RollingNumber.tsx` (odometer with reduced-motion + aria-label fallback) and `DeltaPill.tsx` are each genuinely designed components — the findings above are *adoption* gaps, don't redesign the components · `components/charts/scrub.tsx:46-52` sign handling (true −/±, sign-stripped abs) is exemplary · PageHeader h1 (Fraunces 3xl + `canvas-text` legibility halo, `index.css:59-68`) is deliberate and consistent across pages · ticker symbols uniformly `font-mono font-bold` (SymbolSearchResultItem, PortfolioTicker, ChartBuilderPage) — a coherent identifier convention · no gradient text on any heading (S2 filed the sole `bg-clip-text`, a number) · dashboard recent-transactions amount column is right-aligned (`pages/DashboardPage.tsx:293`) · heading size ladder h1 3xl → CardTitle 2xl → overridden lg for chart cards is coherent *where the defaults are used*.

**Wave S4 checked clean (don't re-audit):** dialog sizing is NOT uniform — 6 deliberate width tiers across 24 sized DialogContents (sm→4xl; quick actions like OwesPage pay = `sm:max-w-sm`, editors = lg/2xl, review surfaces = 4xl) — genuinely task-scaled · Dashboard and PortfolioOverview both use real asymmetric bento compositions (featured 2×-span hero + secondary tiles, `DashboardPage.tsx:401-419`, `PortfolioOverviewPage.tsx:275-325`) — the app's two hubs are *not* interchangeable scaffolds · `MetalsPage.tsx:1-13` re-exports a parameterized StocksPage — the correct anti-paste pattern exists in-repo (A4 tracks making Crypto/Savings/RealEstate follow it) · RealEstatePage's body (`:208-300+`) is truly content-specific: per-property cards with location, MapPin, cadastral income, municipality tax, appreciation/rent split — the best page-specific composition in the app · OwesPage composition is content-derived (outstanding-total hero card `:63-77` + per-person progress cards with paid/total meters, not stat tiles) · badge usage is broadly semantic, not soup — 123 total `<Badge` app-wide; worst page (ImportReviewPage, 10) uses them correctly as match-status chips (`:43-67`); only the TaxOverview key-value trio filed above misuses them · Separator count is low (19) — no divider-decoration habit · no numbered-step decoration outside the onboarding wizard, where order is real · `EmptyState` (16 consumers) has designed character (glass tile + aurora glow halo, `components/shared/EmptyState.tsx:12-18`) and its icons mostly match page identity (hand-rolled empty-state clones are S6's axis) · TransactionsPage's utilitarian [header → FilterBanner → dense table] is *right* for its job — density variation between it and the dashboard is intentional and good.

**Wave S5 checked clean (don't re-audit):** the motion *system* is real, not aspirational — token durations/easings in `tokens.css:112-117` are mapped into Tailwind (`tailwind.config.ts:127-136`) and consumed by every `index.css` interaction utility · all 8 chart components are framer-driven off `lib/motion.ts` `durations`/`easings` with `useReducedMotion` (12 files) — zero recharts default entrances, and `ToolResultCard` explicitly sets `isAnimationActive={false}` ×3 · tabs active pill (`ui/tabs.tsx:78-81`) and sidebar rail (`AppSidebar.tsx:68-72`) magic-move via layoutId + `springs.snappy` with reduced-motion zero-duration — shared physics, genuinely crafted · dialog genie exit toward the opening pointer with keyboard fallback (`lib/dialogGenie.ts`) is signature-quality and shared by alert-dialog · Button has full press choreography (hover lift → active settle + `press-feedback` scale, enumerated transition properties, token timing) · sonner success toasts get the SF-Symbols icon bounce globally (`index.css:859-861`) and `TransactionImportCard.tsx:437` reuses it · `animate-pulse` restraint: 8 sites, mostly `motion-safe:`-gated micro-dots, no pulsing content cards · `hover:scale` restraint: 8 sites, all small icon-tile/knob scales (1.04-1.10), zero card-level zoom slop; arrow-nudge `group-hover:translate-x` only 6 · `animate-bounce` is only the chat typing ellipsis with designed 900ms/300ms-offset timing (`ChatMessageList.tsx:107-109`) · ticker tape: constant pixel speed via `--ticker-duration`, hover-to-read pause, offscreen freeze, reduced-motion none (`index.css:928-953`) · the reduced-motion story overall: broad CSS block (`:977-1010`) + `useReducedMotion` in PageTransition/charts/tabs/sidebar + `ShaderAurora.tsx:176-182` renders a static frame + `fx-static-atmosphere` freezes CSS blobs · focus rings are largely one pattern (`ring-2 ring-ring/70 ring-offset-2`; only 4 stray `ring-primary/50`).

**Wave S6 checked clean (don't re-audit):** `ShortcutsOverlay.tsx` is a genuinely crafted shortcuts sheet — real inventory (not aspirational), platform-aware ⌘/Ctrl + ⇧/⌃, explicitly mirrors the Electron menu accelerators, styled `<kbd>` keys, bound to `?` with typing-target guard · Electron chrome is deeply considered: `hiddenInset` traffic lights + vibrancy + fullscreen inset handoff (`main.js:1497-1517`), persisted+clamped window bounds, macOS dock menu (New transaction / Dashboard, `:2983-2994`), ⌘1-9 route accelerators with a documented `before-input-event` reliability fix, notifications titled APP_NAME · splash *mechanics* (as opposed to character, filed above): `readSplashTheme`/`deriveSplashPalette` persist the user's palette so boot matches their theme, spinner hidden under reduced-motion, tabular-nums status line · `theme-flash.ts` applies theme *and* palette variant pre-mount (no FOUC) · the loading system is a coherent three-tier hierarchy, not spinner soup: `App.tsx:105-112` hairline top-edge shimmer for route chunks (designed, motion-reduce fallback) → `SectionLoader` shimmer stack (`role="status"`) for sections → `Loader2` reserved for inline button-busy (all 32 files checked; zero full-page centered spinners) · `TransactionsTable.tsx:384-393` empty state is the house exemplar (contextual icon, search-aware copy, Import CTA) · boot-error page bones: strict CSP, en/nl i18n, retry + view-logs actions, light/dark (`packaging/electron/assets/`) · onboarding offers restore-from-backup on the welcome step AND the backup step — genuinely considerate for migrating users · `SUGGESTED_CATEGORIES` per-category emoji (`OnboardingWizard.tsx:81-97`) is a warm human touch worth keeping · sidebar footer's glowing accent dot (`AppSidebar.tsx:403`) is charming — keep it, just fix the version string beside it.

**UI/UX research 2026-07-03**

**Wave U1 checked clean (don't re-audit):** dialog/sheet/alert-dialog focus return — Radix defaults intact, zero `onOpenAutoFocus`/`onCloseAutoFocus` overrides repo-wide (grep) · dialogGenie is animation-only (transform-origin CSS vars, no focus impact) · no positive `tabIndex` anywhere (only 0/−1) · CommandPalette: ⌘K toggle, labeled input, cmdk arrow nav, recents, forceMount only on groups · ShortcutsOverlay discoverability good (`?` key, palette action, topbar ⌘K hint, list generated from real `GO_TO_ROUTES` so it can't drift) · `g`-sequence/`[`/`]`/⌘Z/⌘B all correctly inert while typing or with modifiers (modal gap filed above) · VirtualDataTable rows: ↑/↓/Enter/Space nav, `aria-sort`, sort headers are real `<button>`s, inline-edit Enter/Escape · OwesPage:86-94, CategoriesPage:195-210, WatchlistPage:160-171 clickable cards done right (`role="button"` + `tabIndex` + shared `onActivateKeyDown`) · charts ship localized SR summaries via `chartAria.ts` · `<header>`/`<main>` landmarks present · Escape closes search-suggestion dropdown + inline edit consistently.

**Wave U2 checked clean (don't re-audit):** AddTransactionDialog amount pattern (`type="text" inputMode="decimal"` + pattern + `parseLocaleNumber`) and TransactionInfoDialog inline amount edit (`:68` parseLocaleNumber) · `parseFloat` centralized (only `utils/currency.ts:55`, `utils/sanitize.ts:77` — no raw locale-string parseFloat) · `parseLocaleNumber`/`parseDecimal` comma/thousands heuristics solid · date defaults to today via `todayYmd` in `createAddTransactionFormState` · footer buttons in all 9 `<form>` dialogs correctly `type="button"`/`type="submit"` (no accidental default-submit; Radix Select/cmdk swallow Enter) · zero `window.confirm` · confirm coverage good on TransactionsPage:217, CategoriesPage:262, RecipientsPage:295, PlannedPaymentsPage:345, OwesPage:283, BulkActionsBar:93,107, ChatConversationList, InvestmentDetailDialog, BackupSection restore AlertDialog:350, TableDataEditorPage (staged deletes + op-count commit summary :208-219) · RecipientCombobox/CategoryCombobox have search + explicit "none" clear item · required fields marked "*" in PlannedPaymentForm labels (en.json:1594,1636) · API keys `type="password" autoComplete="off"` (ResearchKeysSection:104-109) · AddTransactionDialog/SplitTransactionDialog/AddRecipientDialog/AddCategoryDialog submit buttons disable on `isPending` · AddTransactionDialog + PlannedPaymentForm(new) keep typed state across accidental close (stay mounted, `key={editing?.id ?? "new"}` at PlannedPaymentsPage:512).

**Wave U3 checked clean (don't re-audit):** catch-all 404 route exists, localized, logs the path, offers a home link (`App.tsx:231`, `pages/NotFound.tsx`) · legacy-route redirects preserve query strings and use `replace` (`RedirectWithQuery`/`RedirectSymbolToMarket`, `App.tsx:148-162`; `/portfolio/market`, `/portfolio/watchlist`, `/research/symbol/:symbol`, `/portfolio/exchange-rates`) · `StartupRedirect` uses `replace` (`:64`) · sidebar active-state prefix matching is correct for nested routes incl. exact-match workspace roots and the `/admin` special case (`AppSidebar.tsx:85-91,374-376`), so `/import/:batchId/review` and `/admin/db/:table` highlight the right item · `?new=1` deep-link is consumed with `replace` so back/refresh don't re-open the dialog (`AddTransactionDialog.tsx:33-43`) · AI-chat `?conversation` and forecast `forecastMode`/`rollingDays` params replace-synced (`AIChatPage.tsx:28-46`, `CashFlowForecastChart.tsx:86-107`) · transactions filter changes push history entries (back steps through filter states — sensible) and quick-filters merge params additively (`TransactionsPage.tsx:262-271`) · bad/missing `:batchId` → disabled query → error panel with back-to-import buttons (`ImportReviewPage.tsx:96-99,256-273`); `TableDataEditorPage` has a back button (`:288`) + `query.error` panel (`:349`) · ScrollToTop keys on `pathname` only, so same-page query-param filtering doesn't yank scroll · Electron deep-link payloads validated (`ElectronBridge.tsx:52` `startsWith('/')`) · planned payment → matched transaction link exists (`ExecutionHistoryDialog.tsx:161`), portfolio holding → Market Lookup exists (`StocksPage.tsx:84`, `CryptoPage.tsx:53`, `InvestmentDetailDialog.tsx:141`).

**Wave U4 checked clean (don't re-audit):** all domain mutation hooks carry onError toasts with `error.message` (useTransactions/useAccounts/useCategories/useRecipients/useTags/useSplits/useInvestments/useSavedCharts/useAIChat/useCustomParserConfigs/usePortfolioParserConfigs/RecipientPatternsDialog/MoveHoldingDialog/CloseAccountDialog/PortfolioTicker/ProviderHealthPage/DbMaintenancePage/TableDataEditorPage/ExchangeRatesPage/PortfolioImportReviewPage) · transactions CRUD fully optimistic with snapshot rollback + delete Undo toast + ⌘Z one-slot undo (`lib/undo.ts`, AppLayout.tsx:60) + broad invalidation fan-out (useTransactions.ts:110-123) · ImportReviewPage overrides use mutateAsync + try/catch + state rollback, commit toast reports imported/duplicates/errors and button is isPending-guarded · TransactionImportCard has phase progress + cancel + complete/error panels; SimpleImportCard/ExportCard toast success/fail and disable while running · refreshPrices reports partial failure (stale-source count) via warning toast with stable id (no stacking), buttons disabled while pending and offline-aware (useOnlineStatus) · backup restore has schema-mismatch/passphrase-specific errors + submitting-disabled dialogs (useRestoreBackup.tsx) · ErrorBoundary per-route keyed (App.tsx:140-143) + shell-level, fallback offers Retry + Reload · API errors normalized into ApiClientError (envelope/legacy/422-field-list/429-retry-after, client.ts:112-184) with requestId correlation · app-settings persist failures toasted via save-error nonce (AppSettingsContext.tsx:84-120) · placeholderData keeps old data on transactions/accounts/categories/recipients/bankAccounts/aiChat plain lists + PerformancePage keepPreviousData · empty states with guidance on StatisticsPage (noData), PortfolioOverview (isEmpty), accounts/networth/performance (title+desc), dashboard recent-transactions (CTA); first run gated by OnboardingWizard (AppLayout.tsx:233) · planned-payments CRUD/execute call sites all catch + toast (PlannedPaymentsPage, LinkTransactionDialog) · RebalancePage compute renders its error inline (:347-348).

**Wave U5 checked clean (don't re-audit):** lucide icon semantics — Trash2=delete (20 files), X=close/clear-chip only, Pencil=edit (8, no `Edit` icon), Plus=create; zero raw `text-gray/bg-white/text-black` classes repo-wide · gain/loss color always routes through `--gain`/`--loss` tokens (`text-gain` 25 files + `.amount-gain` 26 files, tailwind.config.ts:75 + index.css:900 — colorblind toggle covers all) with no sign-conditional `text-success` misuse (only non-money verdict at ResearchAnalystTab:62) · currency formatting centralized (`utils/currency.ts` configured from AppSettings at App.tsx:121; Money/useCurrencyFormatter/useChartCurrencyFormatter all app-locale-aware) · ~35 Intl.NumberFormat/DateTimeFormat call sites verified passing the app locale · datetime formatters (`formatDateTimeStringWithAppSettings`, `formatMonthYearWithAppSettings`, `formatDistanceToNow`) all receive locale at their call sites · JSX hardcoded-string sweeps (bare text, placeholder=, label:/title: props, toast messages) found nothing user-facing outside the tax items above — devtools panels (`components/devtools/*`) are English-only by design (developer surface) · confirm dialogs uniform (18× useConfirmDialog + 2 bespoke AlertDialogs share the same primitives/variants; destructive variant used at all destructive call sites) · search inputs centralized in DataTable/VirtualDataTable (icon + clear + focus styling) · en.json ellipsis style consistent (131× "...", 0× "…") · "Bank Account" naming consistent across forms/import/planned.

**Wave U6 checked clean (don't re-audit):** viewport meta correct — `width=device-width, initial-scale=1.0`, no `user-scalable=no`/`maximum-scale` so pinch-zoom stays available (`index.html:6`) · mobile sidebar done right — `useIsMobile()` at 768px (`hooks/use-mobile.tsx:3`) swaps to a Sheet drawer (18rem, `ui/sidebar.tsx:146-162`) and `SidebarTrigger` is always in the topbar (`AppLayout.tsx:114`) · Sheet panels `w-3/4 sm:max-w-sm` — viewport-safe (`ui/sheet.tsx:39-41`) · dashboard grids fully breakpointed (`DashboardPage.tsx:306,401,414,426`; BankBalances cards `sm:grid-cols-2 lg:grid-cols-3`) · wide-content overflow handled: `ui/table.tsx` wraps in `overflow-auto`, StocksPage:300/CryptoPage:210 `overflow-x-auto`, CategoryPivotTable `min-w-[800px]` inside ScrollArea WITH `<ScrollBar orientation="horizontal"/>` (:388) · no fixed widths ≥400px outside that contained pivot (grep) · Button default h-10 / `size="icon"` 40px, and the 40px `icon-touch-target` utility is adopted in 21 files incl. transaction-row Info/Delete (always visible → transactions DO have a touch path to details) · NetSummaryCard sparkline scrub is touch-correct (`touchAction: "pan-y"` + pointer events, :132) · charts are visx with pointer-event handlers, so tap shows tooltips (BarChart per-bar `onPointerEnter`, no touch-action lock) · DialogContent width overrides all `max-w-sm…4xl` over `w-full` — no fixed-px dialog widths · DialogFooter stacks buttons column-reverse below `sm` (`ui/dialog.tsx:65`) · sonner toasts default bottom placement (full-width bottom on small screens — thumb-reachable) · `overscroll-behavior-y: none` on body kills the pull-to-refresh seam (`index.css:36`) · no PWA manifest/apple-touch-icon, so iOS safe-area-inset handling is currently N/A.

**UI clutter review 2026-07-01**

- **Clean pages** (single top notification, well-aligned cards/tables): Dashboard, Transactions, Statistics, Categories, Accounts, Owes, Performance, Rebalance, Stocks/Crypto (shared asset-page template), Research › Markets (heat-map grid), Research › Compare (empty-state tool), Tax (dense but organized).
- **Blank chart bodies in full-page screenshots are a lazy-render artifact, NOT a bug** — charts draw on scroll-into-view (verified on Dashboard *and* Statistics: chart rendered ~90 SVG elements once in viewport). Use in-viewport captures to judge charts.
- **Banner spacing is fine where it fires** — banners use `mb-4` + parent `space-y-*` and `return null` when idle; the only multi-banner case that actually triggered on demo data (`/tax` viewing a past year → `HistoricalYearBanner`) spaced cleanly under the global notification. Honest caveat: `FxStatusBanner` and `StalePricesBanner` never triggered on synthetic data, so their stacking is **inferred from code**, not visually observed — the only observed pile-up is `/planned`'s advisory *cards*.
- **`/import` faint top-overlap** seen in one full-page shot was a full-page compositing artifact (no overlap in the in-viewport capture) — not a real z-index bug.

---

### 🏛️ Architecture & API

**Code/architecture 2026-07-03**

**Wave A1 checked clean (don't re-audit):**
- Route mounting: all 23 top-level routers are imported and mounted (main.js:300-332, ai gated); routes/info/* sub-routers composed via the routes/info.js barrel; **no dead/unmounted route files**.
- Middleware composition order (main.js:80-298): requestId → requestMetrics → CORS → json(1mb) → security headers → gzip → request log → `wrapResponse` envelope → globalRateLimiter on /api → routers → 404 → createErrorHandler; admin stack gets rateLimiter+CSRF+auth (main.js:307). All 8 middleware/ files have consumers — no dead middleware.
- Error handling is genuinely centralized: Express-5 async-throw (no asyncHandler needed), typed AppError subclasses, headersSent guard, non-Error normalization, prod message suppression (middleware/errorHandler.js:85-137). Sampled try/catch in importRoutes.js (:81-86, :204-226, :292-297, :392-394) all translate to typed errors, rethrow, or log with context — **no silent empty catches found**; bare `catch {` sites sampled carry intent comments per convention.
- ESLint boundary rule IS enforced in CI (`bun run lint:backend`, .github/workflows/ci.yml:136 and release.yml:113) — not a dead rule, just narrow (see finding 1).
- lib/: all 17 modules have ≥1 external consumer (money 41, timezone 16, pagination 9 …); shared-utils shims lib/money.js & lib/slugify.js are live and intended (ADR-069).
- startup/warmup.js (344 lines, tri-state status feeding /health/detailed) and jobs/refreshCashflowForecastMc.js (wired from warmup.js:309) — clean separation.
- services/routeManifest.js `mountRouter` introspection for /api/admin/endpoints — reasonable, routes-agnostic.
- No `res.status(500)` hand-rolling anywhere in routes/; only the single aggregations.js:135 4xx (finding above).

**Wave A2 checked clean (don't re-audit):**
- Recurrence *step* math centralized: `calculateNextDate` is the single advance implementation, reused by plannedExecutionService, cashflowForecast, aiChat planned tool, and routes.
- `crossWorkspaceAnalytics.js` (pure) vs `crossWorkspaceDataService.js` (IO) split is deliberate and well-documented in both headers — good cohesion, not duplication.
- No true god modules: the biggest files are cohesive — `aiChat/tools/expenses.js` (710) is 11 same-domain tool defs; `reports/sectionHelpers.js` (615) is report HTML/SVG formatting; `quoteBackfillService.js` (693) is one backfill domain.
- `aggregationRefresh.js` vs `materializedViewService.js` is orchestrator-over-manager, not overlap (headers explain the split).
- `priceProviderService.js` is a documented thin orchestrator over `prices/` (header lines 1-6); pattern itself is fine — only its file placement is flagged above.
- Core repo verb set (getAll/getById/getCount/create/update) is consistent where the object pattern is used; parameterization is uniformly positional `$n` — no string-concatenation SQL found in either layer.
- Pagination clamping exists once (`services/dbEditor.js:162`) — no duplication.
- Subdirs with clear cohesion stories: `portfolio/`, `currency/`, `prices/`, `importPipeline/`, `portfolioImportPipeline/`, `reports/`, `research/`, `aiChat/`, `calculations/`.

**Wave A3 checked clean (don't re-audit):**
- API transport layer (`lib/api/client.ts`): single wrapper — **zero ad-hoc `fetch(` outside lib/api/** in hooks/contexts/lib/utils/stores/components/pages/features; base URL centralized (client.ts:30-34, same-origin prod / proxy dev); envelope normalization complete with legacy `{detail}/{message}` fallbacks and typed `ApiClientError` carrying code/status/requestId (client.ts:72-184); timeout/retry/correlation-id/abort-all uniform (client.ts:219-363).
- `lib/api/` domain split: 26 domain modules composed into a documented back-compat barrel (`lib/api.ts`) — coherent design (aside from the dual-path finding above).
- `types/`: well-organized — `types/generated.ts` is openapi-typescript output (CI drift-checked), `types/api.ts:1-13` hand-written ergonomic mirror, `types/contract-guard.ts:1-22` compile-time assertions making generated.ts load-bearing. No god-file problem (generated.ts's 9.4k lines are machine output). **For A5:** generation pipeline exists and is guarded; assess only the shared `@vision/types` package boundary.
- `stores/settingsStore.ts`: no overlap with contexts — store owns state, contexts own hydration/persistence/DOM side-effects, exactly as documented (code-patterns.md:2800-2873); slice selectors + useShallow used correctly.
- Provider nesting: 8 levels in `App.tsx:166-245` but each layer justified (preload → theme → settings×2 → tax → language bridge → tooltip); no context provides >4 unrelated values except BelgianTax (reported above).
- hooks/: every non-test hook imports React/react-query/router — none are misfiled lib functions; single-consumer hooks sampled (useRecipientPivot, useTagPivot) are page-scoped extraction, acceptable.
- `PageTitleContext`, `SettingsPreloadContext` (single startup fetch feeding hydration — deliberate, documented), `utils/currency.ts` internals, `lib/utils.ts` (cn only).

**Wave A4 checked clean (don't re-audit):**
- No cross-feature imports between `features/*` subdirs — all `features/` internal imports stay within their own feature (grep of alias + relative paths).
- `components/ui/` primitives are modified in place via cva variants (e.g. badge/alert `success` at components/ui/badge.tsx:20, alert.tsx:17) consistently with the documented token convention — no wrap-vs-modify drift found.
- Zero-importer sweep of `components/` (non-ui) and `features/` found no dead components outside the 7 ui primitives above.
- Chart primitives AreaChart/LineChart top out at 5 optional booleans each — below variant-smell threshold; format hooks are function props, appropriate.
- pages/TransactionsPage.tsx correctly delegates data to features/transactions/hooks/useTransactionListData.ts (the model other pages should copy).
- InvestmentDetailDialog.tsx (643) is cohesive for its size: one Dialog+Tabs with injectable sub-dialog callbacks (:37-41); decomposition optional, not urgent.
- MetalsPage.tsx confirmed as the correct thin-wrapper pattern.

**Wave A5 checked clean (don't re-audit):**
- Envelope adoption: 0 direct `res.json(` in routes/ + controllers/ (all via `res.ok` from middleware/envelope.js:29); the only non-envelope endpoints are deliberate infra contracts in main.js:236/267/284 (/health, /ready, /api/) with documented backward-compat shapes.
- Error codes genuinely shared: `ApiErrorCode` lives once in packages/types/src/errors.js:8, consumed by BE envelope.js/errorHandler.js and FE lib/api/client.ts — no FE re-declaration found.
- money/slugify/downsample duplication resolved: FE lib/money.ts, lib/slugify.ts, utils/downsample.ts and BE lib/money.js, lib/slugify.js, utils/downsample.js are all thin `export * from '@vision/shared-utils/...'` shims (though both downsample shims are consumer-less — flagged in A1/A3).
- Circular imports: madge clean on backend (284 files from src/main.js) and frontend (584 files, --ts-config alias-resolved).
- Deep relative imports: zero `../../` or deeper in apps/frontend/src — `@/*` alias fully adopted.
- Env centralization: apps/node-backend/src/config/env.js is a Zod schema (ADR-030), "all env reads flow through this module"; only 6 files touch process.env outside it (main.js, database/migrate.js, config/loadDotenv.js, config/logger.js — documented exceptions — plus services/research/providerKeys.js, services/reports/puppeteerRenderer.js).
- i18n pipeline: single source of truth i18n/source/{en,nl}.json (flat but dot-namespaced: 3529 keys, 98 namespaces, `tax` largest at 437) → generated FE locales + packaging/electron/i18n; validate-locales.js checks en↔nl key parity both directions, placeholder-token parity, and generated-output consistency across both targets.
- Workspace topology: root package.json workspaces = apps/frontend, apps/node-backend, packages/* (exactly @vision/types + @vision/shared-utils, both private, subpath-exported JS+.d.ts, 31 import sites).

### 🏗️ DevOps / CI-CD / Packaging

**DevOps research 2026-07-03**

**Wave D1 checked clean (don't re-audit):** All actions in all five workflows are SHA-pinned with version comments, and dependabot's `github-actions` ecosystem keeps them updated (grouped, weekly). Every workflow has top-level `permissions: {}` deny-all with per-job least-privilege opt-ins (`security-events: write` only for SARIF uploads, `packages: write` only for the GHCR push, `contents: write` only for release creation); no `pull_request_target` anywhere; auto-merge's dependabot token-elevation pattern matches GitHub's documented recipe and `github.actor` gating is safe. Every job has `timeout-minutes`; ci/e2e/release have sane concurrency groups (release correctly uses `cancel-in-progress: false`). Bun cache (`~/.bun/install/cache` keyed on `bun.lock`) present in all bun jobs; docker builds in ci/release use `type=gha` layer cache. CI genuinely runs all the quality gates that exist as scripts: frontend+backend lint, frontend `tsc` typecheck, backend JSDoc `tsc --checkJs`, frontend tests+coverage gate, backend vitest+coverage thresholds (85/75/85/88 in `apps/node-backend/vitest.config.js`), frontend prod build, `validate-locales`, OpenAPI-type drift, endpoint-matrix count, compose-volume sync (the v1.0.2 guard), gitleaks, bun audit, pip-audit, Trivy. Backend vitest is unit-level (no PG service container) but real-Postgres coverage exists: `docker-verify` boots the real compose stack (migrations run to head on boot), round-trips `alembic downgrade -1 && upgrade head`, and `test-live-api-contracts` runs MSW fixture schemas against the live backend. Playwright config has CI retries (2) and trace-on-first-retry; e2e report artifact retention 14 days is reasonable. Root `Dockerfile` base images are digest-pinned. Release verifies tag == root `package.json` == electron `package.json` (per packaging rules) and stages sha256 checksums. Draft-PR skip logic evaluates correctly on push events. Deliberate-by-design (per known context, not re-reported): CodeQL JS/TS-only/security-extended/build-mode-none, artifact-quota reds on Build Docker Image, patch/minor-only auto-merge.

**Wave D2 checked clean (don't re-audit):** Dockerfile multi-stage layer ordering (manifests-before-`bun install`, sources after — dependency layer not busted by source edits; both stages `--frozen-lockfile`, stage 2 `--production`); non-root runtime end-to-end (`USER bun` + `chown` + compose `user: 1000:1000`, `read_only: true` with explicit tmpfs/volumes, `cap_drop: ALL`, `no-new-privileges`, ports bound to `127.0.0.1`); entrypoint hygiene (`set -e`, `exec bun` so signals reach the app; `main.js:548-549` handles SIGTERM/SIGINT with re-entrancy-guarded drain); DB wait + migration-at-boot design (checkConnection retry loop, skip-at-head cache in `migrate.js` with fingerprint invalidation, legacy-revision normalization); Puppeteer setup (system Chromium, `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD`, `--disable-dev-shm-usage`); postgres 18 volume path `/var/lib/postgresql` (correct for the v18 image layout); app HEALTHCHECK endpoint/params sane (`/health`, start_period 20s); root↔packaged compose volume lists in sync (postgres_data/attachments_data/vision_cache_data — no drift beyond the `name:` finding above); `docker-compose.clean.yml` properly isolates via named `vision_postgres_data_clean`; `.env.example` ships placeholders, no default credentials; `install.sh` overall (bash strict mode, refuses blind curl|bash with checksum/confirm path, Docker daemon wait loop, idempotent re-run).

**Wave D3 checked clean (don't re-audit):** release.yml verify job's tag==root==electron package.json version guard (lines 75-90) and compose-volume sync gate at release time; CI migration reversibility check (`ci.yml:559-567`, downgrade -1 → upgrade head); git-hook machinery (`scripts/setup-git-hooks.js` idempotent/CI-safe; `.githooks/commit-msg` commitlint, `.githooks/pre-push` typecheck×2 + endpoint-matrix + locales + backend tests with sane skip/bypass semantics); `scripts/check-endpoint-matrix.js` and `scripts/validate-locales.js` (sound, wired into CI + pre-push); `packaging/release/vision-setup.command` (robust: strict mode, arch detection, Docker wait, graceful pull failure) and `packaging/release/README.md` accuracy vs the embedded compose (`name: vision` project + volume names all match); update-ZIP handling security (mandatory sha256 verify, zipinfo path-traversal check, rsync rollback in the generated installer); `packaging/electron/demo-db/regenerate.sh` design (throwaway DB, wide alembic_version workaround, reload-validate + sanity checks); `electron-builder-demo.json` isolation (separate appId/output/resources-demo); all `bun run`/`node scripts/` targets referenced by workflows exist (no missing scripts); embedded vs root compose volume parity is currently green.

**Wave D4 checked clean (don't re-audit):** `.devcontainer/init-firewall.sh` (fail-closed default-deny before flush, proxy-UID-only OUTPUT, 3-invariant verification + sentinel), `squid.conf` (peek/splice SNI allowlist, HTTPS-only, metadata-IP deny, no MITM), `entrypoint.sh` (firewall-before-network ordering, squid supervision + log rotation, graceful SIGTERM, empty-volume Postgres adoption), `perms-fix.sh`, `launcher-common.sh` (staging strips `.credentials.json`/`.oauthAccount`/`.projects`/hooks; token forwarded name-only, never in argv), `bin/claude` (RO `.devcontainer`/`.git` mounts, mandatory verify-pins gate, opt-in autosync, RO memory seed + interactive-only pushback), `bin/doctor`, `bin/verify-pins`, `.devcontainer/.dockerignore`; version parity is GOOD — bun 1.3.14 = CI, PostgreSQL 18 = prod, both SHA-pinned; full dev loop (dev server, backend tests, alembic migrations) works in-container. No generated dirs tracked (`coverage/`, `dist/`, `venv/`, `node_modules/`, `.playwright-mcp/` all 0 tracked files); `.env`/`.env.local`/`.env.production` ignored, `.env.example` placeholder-only; secrets grep over tracked files clean; no `*.sha256`/`.DS_Store`/`__pycache__` tracked; `*.csv` global ignore is a deliberate PII guard (no CSV fixtures exist — adapter tests use inline strings); repo pack 17 MiB / .git 24 MB, largest blobs are the demo SQL + icon.icns (acceptable).

## Refuted — do NOT re-add

Investigated and disproven; kept for transparency.

**Codebase audit 2026-06-30**

- **"'Failed to load' copy shown for legitimately empty data, not just real errors" (`RecipientInsightsPage.tsx:145-151`)** — **REFUTED.** The guard `if (isError || !filteredData)` was claimed to fire on legitimate emptiness, but the backend (`infoRepositoryRecipients.js:161`) always returns a defined object (`{topMerchants: [], monthOverMonth: []}`) even with zero recipients — never `undefined`/`null` — and React Query only returns `data === undefined` when the query is actually in an error state. So `!filteredData` never fires independently of `isError` given the current API shape; a fresh install with zero recipients renders the real (mostly-empty) page, not a false "failed to load." The `!filteredData` check is redundant dead code worth removing for clarity, but it is not causing the user-facing bug originally described.

---

**Performance research 2026-07-02**

- **"Manual transaction edits never reach the MV-refresh scheduler; `scheduleAggregationRefresh` has zero transaction-route callers, so MVs go stale until the next import/restart"** — **REFUTED** by direct grep: `routes/transactions.js` calls `scheduleReconcile()` at 9 sites (lines 225-645), and `transferReconciliationService.js:233-235` chains `reconcileTransfers().finally(() => scheduleRefresh())`. The real situation is the *opposite* problem — every edit triggers a full reconcile + 4-view refresh (filed as the ⏫ infra finding above). The narrower, still-true gap (single-transaction mutations never clear the *Monte Carlo* cashflow cache) was already filed in the 2026-06-30 audit and stands unchanged.

## Stale docs — KB updates (not code bugs)

**Codebase audit 2026-06-30**

- [ ] `docs/reference/code-patterns.md` still warns about old shim duplication (`loanRepaymentService.js`/`recurrenceService.js` vs. their `calculations/` replacements) that was fully removed in the Phase 9 cutover (commit `65d3dac0`) — doc is stale, code is clean. Update the doc. ⬬ ✅ *(re-confirmed during verification: code is clean, doc is the only thing stale)*
- [ ] `docs/adr/101-db-data-editor.md:45-47` makes a false security claim ("a hostile WHERE clause can therefore neither mutate nor hang the database") — see the SQL-injection finding at the top of this document. Correct the ADR text alongside the code fix. ⏫ *(found during verification)*

## Research context & coverage notes

_Scope, method, sub-topic labels, and caveats from the original research passes. Archive — safe to trim once findings are triaged._

### Design authenticity 2026-07-03

**Scope:** make the app look and feel *human-crafted* rather than AI-generated/templated —
"slop tells" in copy voice, color/token choices, typography, layout tropes, motion character,
and moments-of-truth (empty/error/onboarding) polish. This is about *design taste and
authenticity*, NOT accessibility/interaction mechanics (2026-07-03 UI/UX waves), NOT rendering
performance (2026-07-02 UI/GPU research), NOT locale/number formatting correctness (Wave U5).
Findings are single-pass research, not adversarially verified — confirm against current code
before acting.

**Prior coverage — do NOT re-report (already filed elsewhere in this file):**
- *2026-07-03 §UI/UX Wave U5:* locale formatting (percent/month/decimal), hardcoded-English tax
  strings, terminology drift en/nl, tax `sky-600/700` missing dark variants.
- *2026-07-03 §UI/UX Wave U4:* empty-state CTA *consistency* and mutation feedback mechanics
  (this section may still file empty-state *copy/character* quality — different axis).
- *2026-07-01 §UI Clutter/Layout Review:* PageHeader clipping, stacked advisories, NetWorth hero
  void, duplicate titles/status, uncapped news feed.
- *2026-07-02 §UI/GPU Rendering:* all blur/aurora/shadow *performance* items.
- *2026-06-30 §UI/UX & Accessibility:* skeleton/error-UI mechanics, ad-hoc status badges.

**Method note for the next agent:** run waves SEQUENTIALLY (one subagent at a time, not fanned
out — rate-limit conservation). Each wave-agent writes its findings, checked-clean list, and
unchecked residue directly under "### Findings" below and ticks its checkbox *before* returning,
so progress survives a context/session loss. Resume from the first unchecked wave.

*(appended per wave as each completes — if a wave's checkbox is ticked but findings are missing here, the wave was lost mid-write; re-run it)*

### Code/architecture 2026-07-03

**Scope:** code design and architecture improvements — layering/boundaries, module cohesion,
duplication, dead code, error-handling patterns, state-management architecture, API-contract
*patterns* (envelope/pagination consistency), dependency structure. NOT correctness bugs
(2026-07-02 correctness waves), NOT performance (2026-07-02 performance research), NOT UI/UX
(2026-07-03 UI/UX research), NOT openapi.yaml field-level drift (2026-06-30 §Architecture & API
Contract). Findings are single-pass research, not adversarially verified — confirm against
current code before acting.

**Prior coverage — do NOT re-report (already filed elsewhere in this file):**
- *2026-06-30 §Architecture & API Contract:* openapi.yaml schema-accuracy drift (5×DELETE 204,
  market/quote param, transactions params, show_in_ticker, move strategy), endpoint-matrix
  self-contradictions, ADR contradiction re-run list.
- *2026-06-30 §Other open audit gaps:* the route→service boundary full sweep / dead-shim sweep /
  empty-catch check was open there — **Wave A1 below closes it** (mark it done when A1 lands).
- *2026-06-30 §Stale docs:* code-patterns.md stale shim warning, ADR-101 false security claim.

**Method note for the next agent:** run waves SEQUENTIALLY (one subagent at a time, not fanned
out — rate-limit conservation). After each wave completes, immediately append its findings under
"### Findings" below and tick the checkbox, so progress survives a context/session loss.

*(appended per wave as each completes — if a wave's checkbox is ticked but findings are missing here, the wave was lost mid-write; re-run it)*

### UI/UX research 2026-07-03

**Scope:** UI/UX improvements — interaction design, accessibility, forms, navigation, feedback,
consistency, responsiveness. NOT rendering performance (see "UI/GPU Rendering Research —
2026-07-02") and NOT correctness bugs (see the 2026-07-02 correctness waves). Findings are
single-pass research, not adversarially verified — confirm against current code before acting.

**Prior coverage — do NOT re-report (already filed elsewhere in this file):**
- *2026-06-30 §UI/UX & Accessibility:* TaxOverview loading-conflated-with-empty · VirtualDataTable
  header/body horizontal-scroll desync · portfolio buy/sell/dividend dialogs double-submit ·
  attachment delete without confirm · toast-only validation errors / dead `form.tsx` primitives ·
  bare `Skeleton` with no SR announcement (36 files) · bespoke per-page error UI vs `PageError` ·
  icon-only buttons missing accessible names (AccountsPage menu, RecipientPatternsDialog delete) ·
  shared `DialogContent` lacking max-h/scroll · ad-hoc status badges + TagInput focus-ring gap ·
  hardcoded English `aria-label`s (pagination/SectionLoader/sidebar toggle) · TaxOverview heading
  hierarchy · search-suggestions combobox ARIA.
- *2026-07-01 §UI Clutter/Layout Review:* PageHeader no-wrap clipping actions · /planned
  four-stacked-advisories · PortfolioNewsFeed 25 uncapped articles · NetWorth hero void ·
  /recipients duplicate title · /ai-chat duplicate Ollama status · /import narrow column ·
  global UpcomingPaymentsNotification on every page (no arbiter).
- *2026-07-02 §UI/GPU Rendering:* all blur/aurora/reflow perf items; ChatMessageList
  unconditional scroll-pinning during streaming was already noted there as a UX side effect.

*(all 6 waves complete — per-wave 'unchecked residue' lists below are the resume points for any follow-up pass)*

*(static code research only — findings marked "needs live viewport check" were not verified on a device)*

### DevOps research 2026-07-03

**Scope:** DevOps improvements only — CI/CD workflows, Docker images/compose, release &
packaging ops, dev environment, repo hygiene. NOT app correctness (see the 2026-07-02 waves).
Findings are single-pass research, not adversarially verified — confirm against current files
before acting.

**Known context (don't re-report as findings):** CodeQL config is deliberately JS/TS-only,
security-extended, build-mode none, GHAS default setup OFF · "Build Docker Image" CI red =
artifact quota, not a defect · dependabot auto-merges patch/minor only; bun.lock conflicts
need manual `bun install` regen · local git SSH is broken — push goes via gh-HTTPS with
`--no-gpg-sign`.

### Correctness research 2026-07-02

**Scope:** areas UNDER-covered by the 2026-06-30 audit (below). Six research agents audited the
areas in the checklist; every wave's findings are recorded in full, each with a "checked clean"
list (don't re-audit) and an "unchecked residue" list (precise resume points for a follow-up
pass). Skip anything already listed in the 2026-06-30 audit or marked audited-clean there / in
memory (cost-basis math, loan formulas, splits, money lib core, PIT/TOB estimators, backup crypto,
adapter *detection*, AI-chat SQL usage).

**Caveat:** unlike the 2026-06-30 section, these findings are single-pass research and NOT
adversarially re-verified. Two of the worst were hand-verified during the session (marked inline):
the Vision-CSV-export negative-amount corruption and the brokerage-rollback cross-table delete.
Verify each finding against current code before fixing.

*(single-pass research, NOT yet adversarially verified like the 2026-06-30 section — spot-checks noted inline)*

*(The agent empirically verified the core mechanism before reporting: with no `setTypeParser` override anywhere in `apps/node-backend` — grep-confirmed — pg parses a `DATE` as local-midnight JS Date, and under `TZ=Europe/Brussels`, `.toISOString()` on `'2026-06-01'` yields `'2026-05-31…'`. `transactions.date`, `planned_date`, `month_date`, `mv_monthly_summary.month_start` are all DATE columns.)*

*(Baseline: `scripts/validate-locales.js` already catches en/nl key parity, `{var}` placeholder parity, generated-file drift, static `t()` key existence — findings below are what it CANNOT catch.)*

**Transfer reconciliation (ADR-083)**

**Materialized views / aggregations**

**Attachments**

**Electron shell (`packaging/electron/main.js`)**

**Migrations (only 0061 + 0062 verified this pass)**

### Codebase audit 2026-06-30

Eight parallel research agents (several spawned their own sub-agent forks) audited `apps/frontend` and
`apps/node-backend` for correctness, performance, UI/UX, architecture, code design, security, and DevOps.

**A second fleet of 8 independent agents then adversarially re-verified every finding** — re-reading the
cited code from scratch trying to refute each claim, with one agent doing live web research against
authoritative external sources (FOD Financiën/SPF Finances official guidance, PwC Worldwide Tax Summaries,
curvo.eu) for the Belgian-tax-specific claims. Verification tags below: **✅** = re-confirmed as written,

**🔧** = real finding, description/fix corrected after verification (corrected text is already applied below,
not left as a diff), **❌** = refuted, moved to the appendix at the end with reasoning. Of ~100 findings,
the large majority were confirmed outright; ~16 needed a correction (mostly wrong file/line citations, an
undercounted scope, or a wrong fix direction — not false claims); 1 was refuted outright (appendix below).

This is a **backlog**, not a sprint: triage before batch-fixing, and re-run `vision-kb-updater` after any fix
that touches a documented feature/ADR.

🔺 items below have direct financial-data-correctness or security impact in a finance app and should be
looked at first.

*(Context: Vision is intentionally single-user/local-first with no login — `docs/security/data-protection.md` lists auth as a "Planned" roadmap item. That's a documented design choice, not a gap. CORS, rate limiting, CSV/file-upload handling, SSRF guards on price-provider URLs, HTML/CSV escaping, and SQL parameterization everywhere *except* the dbEditor path above were all checked and found solid.)*

Overall this pipeline is unusually mature for a self-hosted project (deny-all default permissions, SHA-pinned
actions, Trivy + gitleaks + dependency audit, digest-pinned base images, migration round-trip testing in CI,
a backup-coverage test that currently passes 6/6). Real gaps below.

*(macOS distribution being unsigned/ad-hoc/non-notarized is a known, documented trade-off — restated for completeness, not a new finding.)*

**Portfolio / investments**

**Belgian tax** *(verified 2026-06-30 against FOD Financiën/SPF Finances official guidance, curvo.eu, and PwC Worldwide Tax Summaries — see citations below)*

**Categorization**

**Planned / recurring transactions**

**Architecture / route-service boundary / dead code (backend)**

**Sequencing note (found during a clarity audit, 2026-07-01):** the three items above all target the
same code (`transactions.js:153-206`, `plannedTransactions.js:38-75`) with two uncoordinated
destination modules — the boundary-bypass fix says move these queries into
`transactionService`/`plannedTransactionService`; the duplication fix says extract the resolver into
`recipientService.js`/`categoryService.js`. Do the duplication fix first (resolver →
`recipientService`/`categoryService`), then scope the boundary-bypass fix to exclude that
already-extracted resolver logic, then apply the delete-pattern rewrite inside the resolver's new
home — its `plannedTransactions.js:40,53,74` citations go stale once either refactor lands, since the
code moves out of the route files entirely.

**Data export**

*(KBC bank-CSV import adapter — previously flagged as collapsing every row onto `bank_account='KBC'` — was re-verified and is **already fixed in code** (`importPipeline/adapters/kbc.js:70`, commit `277628a0`, with a regression test asserting multi-account IBAN parsing). No action needed; won't recur.)*

*(Lower-priority items, verified 2026-06-30: optimistic-insert-ignoring-filters, currency-formatting-via-raw-Intl, SSE-double-casts, TransactionsTable-unused-props, and ExecutionHistoryDialog-mount-guard all **✅ confirmed** as described — currency formatting was actually undercounted, 24 files use raw `Intl.NumberFormat` not "10+". One correction: the "silent `onError`-less delete mutations" claim is **🔧 narrower than stated** — `AttachmentPanel.tsx` does have an `onError` handler, it just shows no toast (silent-to-the-user, but not literally onError-less); `WatchlistPage.tsx` and `ResearchMappingDialog.tsx` are genuinely onError-less as claimed.)*

*(Extensively verified as already well-optimized — don't re-audit: main transaction-list pagination/tag-batching, the 19+ transaction indexes, MV refresh parallelization, portfolio-summary's fixed query shape, balance recompute via single LATERAL join, daily snapshot batched upserts, Yahoo/Binance batching, CSV/NDJSON export's keyset streaming, FX/price caches' TTL bounds, `cashflowForecast.js`'s query shape, report data-fetchers operating on pre-batched results, the `exchange_rates` composite index found during verification.)*

All 9 findings in this section were independently re-verified 2026-06-30 against current code with **zero refutations and zero corrections** — every cited file:line, behavior, and contrast held up exactly as described.

*(Verified already optimized — don't re-audit: `TransactionsTable`/`VirtualDataTable` virtualization + server pagination; full route-level code-splitting; `recharts` confined to one lazy component; `lucide-react` tree-shaken everywhere; the `ShaderAurora` WebGL background (0.25× res, 640px cap, ~30fps throttle, static under reduced-motion); most context providers already memoized; `AppSettingsContext`/`ThemeContext` bypass the re-render problem via Zustand + `useShallow`.)*

*(Minor items, verified 2026-06-30: heading hierarchy skipping h2 on TaxOverviewPage and the search-suggestions-panel missing combobox ARIA on VirtualDataTable are both **✅ confirmed**. Duplicate-transaction stacked toasts, icon-button sizing drift in AppSidebar, and raw Tailwind palette colors bypassing theme tokens were not independently re-checked this pass — not refuted, just unverified. Glass-panel text contrast against the aurora background remains honestly flagged as "needs a manual browser check," not asserted as a finding — no issue with how that one is written.)*

**API ↔ openapi.yaml drift** *(no fully undocumented or stale-removed routes found across the 211-operation surface — these are schema-accuracy gaps)*

### UI clutter review 2026-07-01

Visual pass over every major page/card for "clutter, banners piling up, weird/ugly layouts."

**Method:** drove the **Vision Demo app** (synthetic data, isolated) with Playwright at desktop
(1440×900) plus a tablet (768×1024) reflow pass, cross-referenced against a code map of every
banner/notification that can mount per route. 22 views captured spanning every section
(shots under `.playwright-mcp/audit/`, gitignored). Findings are ordered real → minor/cosmetic;
transparency notes (what was checked-and-cleared, and honest caveats) follow at the end.

**Caveats:** findings reflect the demo's `vision-app:latest` image (committed `main`; recent commits aren't layout-structural → low drift risk). Not individually screenshotted (templated or interactive-empty, lower priority): Watchlist, Market Lookup, Chart Builder, Portfolio Forecast, Metals/Real Estate/Savings, Import Review, Portfolio Tax, admin/*.

### Performance research 2026-07-02

Six parallel research agents swept the codebase for performance improvements **not already filed in
the 2026-06-30 audit above** — each agent was given that audit's findings and its "verified
optimized — don't re-audit" lists and instructed to skip them, so nothing below duplicates the
Performance sections above. Scope: the two performance gaps the prior audit explicitly left open
(React Query per-hook config; `services/reports/sections/*` + `aggregations.js` index cross-check —
both now closed and checked off above), plus four areas the prior audit never covered at all
(HTTP/middleware/pool infrastructure, bundle/build/loading, runtime chart-and-render hot paths, and
the DB layer: FK indexes, matview mechanics, triggers, retention). Every finding cites file:line
evidence read from current code; the production build was actually run for the bundle numbers
(Vite 8/rolldown, `dist/` total 3.8 MB, cold-load ≈ 372 KB gz measured). One agent claim failed
cross-verification against the code and is recorded in the refuted appendix at the end of this
section. Priorities follow the file's emoji scheme; nothing here is financial-data-incorrect —
the closest are the two ⏫ items whose *displayed numbers* can be wrong (nondeterministic LIMIT
truncation; stale-parameter forecast cache hits).

### UI/GPU research 2026-07-02

**Scope:** UI/GPU rendering performance NOT covered by the two performance sections above. The
2026-06-30 audit already filed: Card glass-blur default + Watchlist glass grid, framer-motion in
the app shell, accordion reduced-motion gap, unvirtualized import-review pages, column-resize
mousemove, SettingsPreloadContext memo, attachment thumbnails. The 2026-07-02 Performance Research
already filed: chart hover path rebuilds + ChartSyncContext broadcast, VirtualDataTable search
re-render, per-call Intl formatters, LTTB unused / NetWorth full-res, CategoryPivotTable DOM size,
BankBalancesWidget unmemoized data, all bundle/loading items. Checked clean (don't re-report):
ShaderAurora *internals* (0.25× res, 640px cap, ~30fps throttle, reduced-motion static), useCountUp,
RollingNumber, route-level lazy loading, transactions-table virtualization.

**This section covers the remaining ground** — findings below are single-pass research, NOT
adversarially verified; check against current code before fixing.

- **Look-changing fixes (do NOT apply without user approval):** dialog/sheet overlay → plain
  `bg-background/60` dim (loses the frosted-modal backdrop — most noticeable change in the set) ·
  chart tooltip → opaque `bg-popover` (loses glass on a constantly-watched surface; `glass-thin`
  is the middle ground) · making `fx-static-atmosphere` the default at the standard tier (stops
  the signature aurora drift for most users) · CategoryPivotTable sticky column → opaque
  `hsl(var(--card))` fallback · rescoping/reducing the dark-mode text halo (subtle glow change on
  all titles) · `failIfMajorPerformanceCaveat: true` (software-GL machines get CSS blobs instead
  of the WebGL aurora — arguably correct, still a look change on those machines).
- **Visually-free fixes (safe for the aesthetic):** all "pause when nobody can see it" variants —
  freeze aurora/WebGL on window blur / `document.hidden` / while a modal overlay is up (blurred
  background is static-looking anyway; resumes on focus) · Card hover shadow pre-rendered on a
  `::after` and crossfaded via opacity (visually identical) · shimmer via `transform` instead of
  `background-position` (identical) · dropping the redundant nested blurs (sidebar tab strip, chat
  thead/composer — invisible blur-on-blur) · single-container sticky-column blur (same look,
  one region) · `transition-all` → explicit property lists · not running CSS blobs under an active
  WebGL aurora (WebGL draws on top; freeze only on confirmed GL init) · everything in Wave B
  (context-restore, low-power hint, resize redraw, vibrancy teardown below enhanced tier) and all
  of Wave C (memoization/rect-caching/rAF — behavior-preserving).

---

## Residue follow-up research — 2026-07-03

_Follow-up pass finishing the "Still to research — resume points" residues above. Run
sequentially per the method notes; each wave appends its subsection here (findings ·
checked clean · remaining residue) and annotates its original residue paragraph before
returning. Single-pass research, NOT adversarially verified — confirm against current
code before fixing._

### Correctness Waves 1a+1b residue — closed 2026-07-03

**Findings**

- ⏫ **Vision CSV export → re-import silently drops every negative-amount row (all expenses)** — the formula-injection guard (`apps/node-backend/src/lib/csv.js:11,26` `neutralizeCsvFormula`, applied by `escapeCsvValue` to ALL columns) prefixes the leading `-` of the pg-NUMERIC `amount` string with `'` → exported cell `'-42.5000` (`transactionExport.js:97-112`). Re-import strips only `[€$£,\s]` (`adapters/vision.js:19`), so `parseDecimalSafe("'-42.5000")` → NaN (verified empirically) → row skipped (`vision.js:21-22,76`); only the skipped counter hints at it. Negative `Balance` hits the same guard → silently nulled (`vision.js:44`), row kept, balance lost. Fix: exempt numeric columns from the guard, or strip a leading `'` before `parseDecimalSafe`.
- ⏫ **Exported Date column is `String(pg Date)`; NDJSON date is the previous day** — `transactionExport.js:99` feeds the raw pg DATE (no `setTypeParser` override exists anywhere in the backend) into `escapeCsvValue`'s `String(value)` → `"Wed Jul 01 2026 00:00:00 GMT+0200 (Central European Summer Time)"` in every CSV. Same-TZ re-import survives via `parseDateFlexibleUtc`'s engine fallback (`adapters/_shared.js:77-79`), but cross-TZ re-import shifts a day and the column is unusable in Excel/tools. NDJSON is worse: `buildNdjsonRow` (`transactionExport.js:117`) serializes via `toISOString` → `"2026-06-30T22:00:00.000Z"` for a July-1 row. Fix: `toYmd(row.date)` — already imported at `transactionExport.js:12` for the keyset cursor.
- 🔽 **FX-on-sleeve CONFIRMED (upgrade the existing entry from *needs confirmation*)** — `tradeCashLegService.js:66-79` posts the cash leg in the trade's native currency (`portfolioTxn.currency || 'EUR'`); `accountBalanceSql.js:37` `SUM(t2.amount)` sums with no currency discrimination, and both consumers (`accountRepository.js:46`, `crossWorkspaceDataService.js:61`) receive the single collapsed number — no conversion happens anywhere downstream. A USD trade on a EUR sleeve is summed as EUR.
- 🔽 **RoC-for-non-unit blast radius: the live summary is equally blind — a fix must patch BOTH surfaces** — `packages/shared-utils/src/portfolio.js:510-522` (`buildInvestmentSummaryCore` txn switch has no `return_of_capital` case) and `:566,:583` (non-unit `totalInvested = buys − sells`) ignore non-unit RoC exactly like `snapshotBuilder.js:442-451`. Surfaces agree today (consistent overstatement, no parity break), but fixing only the snapshot walk would CREATE a live-vs-snapshot disagreement. Unit-based RoC is handled on both sides via `applyEventToLots`. Adjacent design gap: `computeTradeCashLegAmount` has no RoC case → RoC cash never reaches the sleeve.
- 🔽 **`sanitizeSnapshotSpikes` breaks the `Σ value_by_account == value` invariant and can falsify real history** — `utils/portfolioMath.js:48-86` smooths `value` + per-class extras but neither `value_by_account` nor `cash_value`; the "Σ value_by_account == value by construction" comment (`snapshotBuilder.js:574-577`) no longer holds after sanitize at `:582`. A genuine 2-day V-swing of ≥18% with recovery (plausible for crypto-heavy portfolios — detection runs on TOTAL value) is permanently smoothed into persisted history; a real 1-day cash transit (deposit, next-day withdrawal) gets `value` smoothed while `invested` stays → fabricated loss day. First/last rows are never smoothed, so a latest-day needle passes through and then mutates retroactively on the next build.
- 🔽 **Portfolio-tx API emits raw pg DATEs** — `portfolioTxRepo.reads.js:11-12` coerces the 6 NUMERIC fields but not `date`/`recurrence_end_date` → `investmentController.js` `listTransactions` (`:382-390`) and the bulk endpoint (`:315-335`) serialize local-midnight Dates as previous-day ISO timestamps (`"2026-06-30T22:00:00.000Z"` for a July-1 txn). Same class as the recurringDetection finding; frontend consumer unverified (Wave 1c residue).
- 🔽 **`vision.detect()` false-positive** — `adapters/vision.js:53-60` is substring-only: `'Booking Date,Recipient Bank Account,Amount,Reference'` → true (verified). Current first-match-wins order (`adapters/index.js:19,53-58`) shields the five earlier adapters, but any unknown bank's CSV containing those words auto-detects as a Vision self-import, and nothing pins the ordering.
- ⬇ **validate.js hash fallback is TZ-shifted and its header comment lies** — `importPipeline/validate.js:113` calls `parsedDateToYmd` on `tx_date` read back from the staging `DATE` column (local-midnight Date → `toISOString` → day-1 under Europe/Brussels; `lib/importDates.js:7-11` explicitly forbids exactly this use). Latent only because all 10 adapters set `raw_data`; if one ever stops, every hash silently changes (mass duplicate re-imports on the next upload) with a wrong date inside. The header (`validate.js:5`) claims it uses `deduplication.createTransactionHash` — it doesn't; that function has zero production callers.
- ⏬ **Dead legacy modules kept alive only by tests** — `services/bankAdapters.js` shim: zero production importers (7 adapter test files + one route-test mock only; it is a pure re-export so test coverage still hits shipped code). `repositories/rawTransactionRepository.js`: zero production imports (own test only); the per-bank raw tables are never written by the current pipeline — dead-in-prod confirmed. Hash agreement is moot on live paths; note the legacy literal-line hashes could never match pipeline `tx_hash` for vision/generic/sabb/wise/revolut anyway (those adapters rebuild `rawData` instead of hashing the literal line). Also returns `null` (convention violation). Deletion candidates together with their tests.
- ⏬ **Test-quality gaps: all four suites pass (36/36) but mask the filed bug classes** — `brokerageFanout.test.js` fixtures always set `row.amount` and stub the cash leg asserting call-counts only → the `{...created, ...row}` spread bug (fanout.js:132) is doubly masked; no error-path/`errors`-counter test. `accountSnapshotParity.test.js`'s headline Σ==value assertion is near-tautological (`splitByAccount` normalizes weights to sum 1 by construction); no split/RoC/oversell fixtures; despite the name there is no cross-check against `portfolioSummaryService`; 8 order-coupled `mockResolvedValueOnce` calls make the mock define the query contract. `portfolioImportCommit.test.js` never tests `commitPortfolioImport` (batch-status-after-error unasserted) and its dispatch regex leaves the success-path `status='committed'` UPDATE and batch counters entirely unasserted. No suite anywhere posts a non-EUR trade or asserts the leg's currency param (FX-on-sleeve invisible to tests). `visionAdapter.test.js` feeds only clean `YYYY-MM-DD` dates and unprefixed amounts — formats the real export never produces — and never tests `vision.detect()`, the `skipped` counter, or `balance`. `revolutAdapter.test.js` malformed-row tests assert only `toHaveLength(3)`, not which row survived. `bankAdapterFactory.test.js` covers detect for only 2 of 8 banks, with no ambiguity/ordering pin and 3 banks missing from the `getSupportedBanks` assertion.

**Checked clean (don't re-audit)** — `accountBalanceSql.js` anchor+delta logic itself (sound for single-currency accounts; only FX-blind) · `portfolioTxRepo.reads.js` NUMERIC coercion (6 tx fields + summary fields + counts) · `getById` round-trip via `createThroughInheritanceTables` (create returns through `getByIdFn` → identical mapped shape; duplicate-id sequence resync sound) · `getAllWithCount`/`getAllByInvestmentIds` SQL (aliasing, ranked-CTE limits) · `buildInvestmentSummaryCore` unit-based RoC/split handling (applied in all three cost-basis methods) · `allocationAnalytics.js` (pure weight math, no snapshot/RoC involvement) · `sanitizeIsolatedValueSpikes` bridge guard (sustained repricings kept; no chain-smoothing of 2-day plateaus) · `transactionExport.js` keyset pagination + `toYmd` cursor + Decimal running balance + backpressure · `stage.js` `parsedDateToYmd` use (adapter-UTC Dates — safe side of the boundary) · `rawTransactionRepository` ON-CONFLICT dedup pattern (internally sound, just dead) · suites RUN `brokerageFanout`/`portfolioImportCommit`/`tradeCashLegService`/`accountSnapshotParity`: 4 files, 36/36 pass · `computeTradeCashLegAmount` unit tests (real math, ADR-090 signs) · plan-side fanout tests (importActual, non-over-mocked) · ING/BNP factory tests (exact field values).

**Remaining residue**
- **BLOCKED — real-export verification of BNP/SABB status vocabulary and Belfius/KBC encoding:** zero real bank-export fixtures exist in the repo (no `*.csv` outside `node_modules`; every adapter test uses inline synthetic strings). Needs user-provided real exports — do not fabricate.
- Frontend consumers of the portfolio-tx `date` ISO-timestamp emissions (and `firstSeen`/`lastSeen`) — belongs to the Wave 1c frontend sweep, not re-opened here.

