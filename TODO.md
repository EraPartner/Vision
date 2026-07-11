# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

## Status markers (implementation tracking)

Use these to tell *implemented* from *still open* at a glance. A checkbox is only the truth when it is backed by a code-level check:

- `- [ ]` — **open**; not yet implemented.
- `- [x]` — **implemented and verified in code.** Stamp it `✅ YYYY-MM-DD · <commit>` as proof. Never tick a box without confirming the fix exists in the current tree.
- `🔎 verified-present YYYY-MM-DD` — the finding was re-checked against current code on that date and the bug is **still present** (confirmed real, *not* done). This is a live work queue, not a completion mark.
- `🔎 partial-#NN YYYY-MM-DD (…)` — PR #NN addresses part of the finding but a described sub-case still remains; kept **open** on purpose, with a note on what's done vs. left.
- `🔎 needs-GitHub-check YYYY-MM-DD` — cannot be confirmed from the repo alone (e.g. GitHub branch-protection / ruleset settings); check the platform side.
- _no status marker_ — open finding, not re-verified since it was filed.

> **History note:** a bare `✅` on an *unchecked* item used to mean "confirmed real finding." Because that reads as "done," it was misleading. On **2026-07-11** all 71 such items were re-verified — first against `main` (every one still present) — then against **PR #82** (`accounts-feature`, the branch where the backlog is being implemented). Result: **8 are fixed by #82** (now ticked `- [x]` with #82's commit), **2 are partially fixed** (`partial-#82`, kept open), and the remaining **61 are still open** (`🔎 verified-present` / one `needs-GitHub-check`). `✅` is now reserved for the Obsidian done-date on completed (`- [x]`) items only.

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

- [x] **Admin DB data-editor's raw WHERE clause is a SQL-injection oracle, reachable cross-site with no auth by default** 🔺 ✅ 2026-07-11 · 8555ede (#82)
  - ↪ _from: Codebase audit 2026-06-30 · Security (backend)_
  - `apps/node-backend/src/services/dbEditor.js:172-178` (`readRows`), `apps/node-backend/src/routes/admin.js:259-279`, mount order `main.js:307`
  - The `where` query param is concatenated into the SQL with only a `;`-block guard (ADR-101's documented "raw WHERE escape hatch"). Because it's a **GET**, the CSRF guard's safe-method exemption lets a cross-site page trigger it; response *timing* (via `pg_sleep()` in the WHERE expr) survives CORS, making this a practical blind-SQLi timing oracle against the whole schema — not just the URL's table. `adminAuthMiddleware` is a no-op when `ADMIN_AUTH_TOKEN` is unset (the default), so if the port is ever exposed beyond loopback this becomes a trivial full-DB-read primitive.
  - Fix: drop the raw-WHERE escape hatch (the structured `filters[]` path already covers safe column/op/value filtering), or at minimum: fail closed (require non-empty `ADMIN_AUTH_TOKEN`) for any route exposing this, and don't rely on the GET/safe-method CSRF exemption for it.
  - Verification (2026-06-30): re-confirmed, if anything understated. A bare `--` in the WHERE clause also silently truncates the rest of the single-line SQL (ORDER BY/LIMIT/OFFSET) — a second bypass the original finding didn't mention. **Bonus finding: `docs/adr/101-db-data-editor.md:45-47` itself asserts "the raw-WHERE escape hatch rejects `;`. A hostile WHERE clause can therefore neither mutate nor hang the database" — that claim is false; the project's own design doc has the same blind spot as the code. Fix the ADR text alongside the code.**

- [x] **Verbose PostgreSQL error text returned to API clients in production** ⏫ ✅ 2026-07-11 · 66a42fb (#82)
  - ↪ _from: Codebase audit 2026-06-30 · Security (backend)_
  - `apps/node-backend/src/services/dbEditor.js:472-480` (`mapDbError`, SQLSTATEs `42601/42703/42883/42P01`)
  - These map to `ValidationError` (4xx), and `errorHandler.js` always shows 4xx text verbatim on the assumption "4xx messages are authored by us" — but here the message is raw driver text, contradicting `docs/security/data-protection.md`'s stated policy of suppressing DB error details, and handing schema/column feedback to anyone probing the injection above.
  - Fix: replace `err.message` with a generic "invalid query" string for these codes (or gate behind `!isProduction()`).

- [ ] **Backend DB role is the Postgres bootstrap superuser — no least-privilege application role** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Security (backend)_
  - `docker-compose.yml:7` (`POSTGRES_USER: ftm_user`), `.env.example:19-20`
  - The runtime connection pool (including the dbEditor path above) runs as the same superuser the official Postgres image bootstraps. Any successful injection or compromised dependency has instance-level reach.
  - Fix: create a non-superuser application role scoped to the app schema; keep DDL/migrations on a separate, more-privileged role used only by Alembic.

- [ ] **Admin auth is optional by default, with only a startup log line as the safety net** 🔼 🔎 partial-#82 2026-07-11 (8555ede fixed the misleading warning copy; non-loopback hard-fail still missing) *(same root cause as DevOps finding below — fix once)*
  - ↪ _from: Codebase audit 2026-06-30 · Security (backend)_
  - `apps/node-backend/src/middleware/adminAuth.js:36-51`, warning at `main.js:411-414`
  - When `ADMIN_AUTH_TOKEN` is unset, `/api/admin/*` (including destructive routes) has no per-request check; the only safeguard is "the operator kept the port on loopback," signaled by a log line a self-hosted user is unlikely to read.
  - Fix: hard-fail (or visibly banner in the Electron UI) if a non-loopback bind address is detected with no token configured, rather than log-only.
  - Verification (2026-06-30): re-confirmed exactly. **Bonus finding: the startup warning text itself overstates protection — it claims "the CSRF guard blocks cross-site browser requests," which is true only for state-changing methods, not for the GET-based SQLi oracle above. Fix the warning copy alongside the real fix.**

- [ ] **Hardcoded weak default DB credential fallback in source** 🔽 🔎 verified-present 2026-07-11
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
  - Verification (2026-07-03): the negative-`Balance` corruption confirmed at a specific site — `vision.js:44` silently nulls the balance (rather than NaN-dropping the row like amount does), so the row is kept but its balance is lost, distinct from the expense-dropping mechanism above.

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
  - Verification (2026-07-03): reconfirmed all listed call sites end-to-end against the correct reference implementation (`utils/portfolioMath.js:97-104 toYmd`, which uses local getters). Widens the `infoRepositoryNetWorth.js` reach: `first_data_date` (`:33-53`) isn't just a display stat — it's reused as the series START BOUND at `:120,:182,:202`, so the whole net-worth history series can begin one day early, not merely mislabel the header stat. aiChat specifics: `tools/planned.js:26-31`'s `toIsoDate` (`toISOString().slice(0,10)` on pg `planned_date`) is the mechanism behind the already-listed insights/planned dates, also reaching `:69,:287` and the recurrence-expansion base at `:300-306`; `tools/insights.js:38-41` does the equivalent conversion correctly elsewhere in the same file via `toYmd`, showing the fix pattern is already established in-repo. Not line-by-line re-read in this pass (pattern-matched only, confirm exact lines before fixing): the `formatDateToYmd` call sites inside `rates.js`/`infoRepositoryPlanned`/`infoRepo.statistics`/`infoRepositoryNetWorth` themselves, and none of this was driven against a live demo-app request — a quick `GET /api/transactions`/`GET /api/investments/:id/transactions` check would empirically pin the wire shapes before fixing.

- [ ] **Belgian inflation DB-load shifts every month key back one month — each month gets the prior month's inflation rate** 🔺
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c_
  - `services/belgianInflationService.js:79` (`monthKeyFromDatabaseValue`: `value.toISOString().slice(0,7)`), fallback at `:87`; `belgian_inflation_rates.month_date` stores first-of-month
  - pg reads `2026-06-01` as local midnight → `toISOString().slice(0,7)` = `'2026-05'` → `loadFromDatabase` labels every rate with the prior month; downstream (snapshotBuilder compounding) applies the wrong month's rate, and the most recent month appears missing. Only the DB path is affected (Statbel/Eurostat JSON keys are text-parsed and safe), but DB fallback is the designed offline/self-hosted path.
  - Fix: local getters (`getFullYear`/`getMonth+1`) or `to_char(month_date,'YYYY-MM')` in the SELECT.

- [x] **`moveHoldingService` computes wrong remaining units and cost basis when moving holdings between accounts** 🔺 ✅ 2026-07-11 · 1e671a8 (#82)
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Portfolio / investments_
  - `apps/node-backend/src/services/portfolio/moveHoldingService.js:109-114` (netUnits), `:136,156-181` (FIFO lot walk)
  - Two compounding bugs: (a) `netUnits` only sums `buy`/`gift`/`sell` rows — `split` and `return_of_capital` events are silently ignored (unlike `applyEventToLots`/`snapshotBuilder.js`, which do apply them), so post-split unit validation is stale; (b) the FIFO partial-move walk doesn't net out units already consumed by intervening sells, so it can pull from a lot a prior sell already fully consumed, moving the wrong cost basis to the destination account.
  - Fix: replay split/RoC events and prior sells (mirroring `calculateCostBasisFIFO`'s lot-replay) before walking lots for validation or the move.
  - Verification (2026-06-30): re-confirmed by hand-tracing a concrete scenario (buy 10@lotA, buy 10@lotB, sell 8 → true FIFO leaves 2 of A + 10 of B = 12 net). A later partial move physically overwrites the source lot's stored `units`/`amount` columns, which **also retroactively changes the FIFO-replay cost basis of the historical sell that happened before the move** — the bug is more compounding than originally described.

- [ ] **Orphaned trade-linked cash legs on investment delete and on portfolio-import rollback** 🔺 🔎 partial-#82 2026-07-11 (ffb13d7 fixed the import-rollback path; deleteInvestment path still orphans cash legs) *(confirmed independently by three audits — API/ADR-drift, backend-performance, and the verification pass)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Portfolio / investments_
  - `apps/node-backend/src/controllers/investmentController.js:373-378` (`deleteInvestment`), `apps/node-backend/src/services/portfolioImportBatchService.js:65-76` (`rollbackBatch`) — vs. the correct cascade at `investmentController.js:464-477` (`deleteTransaction`, which calls `deleteTradeCashLegs` citing ADR-090)
  - Neither `deleteInvestment` nor a rolled-back import batch cleans up the cash-sleeve legs (`portfolio_transaction_id` isn't a real FK, so nothing cascades automatically). This leaves cash legs pointing at deleted/nonexistent trades — silent ledger corruption feeding net worth (ADR-093) and reconciliation (ADR-094).
  - Fix: add the same `deleteTradeCashLegs` cascade to both paths before/alongside the hard-deletes; also add an `import_batch_id` column to the portfolio transaction tables (see Performance section) so rollback can do this in one batched pass instead of a per-row loop.
  - Verification (2026-06-30): re-confirmed — `deleteTradeCashLegs` has exactly one call site in the entire codebase (the one correct path), proving the other two paths genuinely never clean up.

- [ ] **Belgian TOB tax-table cap is wrong in the backend — wrong number on every generated tax report** 🔺 🔎 verified-present 2026-07-11
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
  - Verification (2026-07-03): the canonical `buildExclusionClauses` (`services/filterBuilder.js:243-278`) and every inline copy were re-confirmed, and the affected-surfaces list is wider than originally filed — also hits recipients insights (`infoRepositoryRecipients.js:36,39,170,176,241`) and all four forecast queries (`infoRepo.forecast.js:44,52,244,251,363,370,462,467`). Not reproduced against a live stack — a demo-app dashboard check with one excluded category would pin the exact user-visible magnitude before fixing.

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

- [x] **Category resolution is inconsistent between list endpoints and single-row endpoints — alias recipients show as uncategorized on GET/POST but categorized on list views** ⏫ ✅ 2026-07-11 · 1449bf7 (#82)
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Categorization_
  - `apps/node-backend/src/repositories/transactionRepository.js:313-333` (`getById`), `:341-393` (`create`) vs. `:18-24` (`TRANSACTION_JOINS`)
  - `getAll`/`getAllWithCount` resolve category via a 3-level fallback (own → recipient default → recipient's *primary* recipient's default) and expose `effective_category_id`. `getById`/`create` hand-roll separate SQL with only 2 levels, never computing `effective_category_id`. A transaction on an alias recipient is correctly categorized in lists but shows uncategorized when fetched/created via the single-row paths.
  - Fix: extract the category CASE + `effective_category_id` expression into one shared SQL fragment reused by `getAll`, `getById`, and `create`.

- [x] **`PATCH`-to-clear silently no-ops on 5 account fields** ⏫ ✅ 2026-07-11 · 9a2db72 (#82)
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `apps/node-backend/src/services/accountService.js:44,71-92` (`sanitize()` maps explicit `null` → `undefined`), `apps/node-backend/src/repositories/accountRepository.js:95` (skips any field `=== undefined` when building `SET`)
  - `PATCH /api/accounts/:id` sent to clear e.g. `funding_account_id: null` is silently ignored — no error, no change — for `display_name`, `institution`, `funding_account_id`, `statement_balance`, `statement_balance_date`. The same bug class was already fixed once in `savedCharts.js` per its own comment, and is reintroduced here.
  - Fix: use a sentinel the repository recognizes as "set this column to NULL," not `undefined`.
  - Verification (2026-07-03): the frontend never sends `null` for these fields either (`AccountsPage.tsx:57-69`, `AddAccountDialog.tsx:110-122`) — fixing only the backend half described above won't actually restore clearing from the UI; the frontend submit path needs the matching change (send explicit `null` for cleared fields, the same pattern used elsewhere for `account_id`). This is one instance of a systemic cleared-field-becomes-`undefined`-becomes-dropped-key class also found in `TransactionsPage.tsx`/`TransactionInfoDialog.tsx`/`EditPortfolioTxnDialog.tsx` (see the "Systemic cleared-field" finding below).

- [ ] **Exchange-rate query-key mismatch breaks the admin "Refresh rates" action everywhere except its own page** ⏫ 🔧 *(impact list trimmed)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/pages/admin/ExchangeRatesPage.tsx:24,32` (key `["exchangeRates", ...]`, camelCase) vs. `apps/frontend/src/hooks/useExchangeRates.ts:16,28` and `useCurrencyConverter.ts:13,17` (key `['exchange-rates', ...]`, kebab-case)
  - Two literal key namespaces for the same backend data. Admin's refresh invalidation never reaches the kebab-case consumers: Net Worth, Portfolio Overview, Stocks, Crypto, Tax Overview, Portfolio Tax, Real Estate, Savings. Clicking "Refresh rates" only updates its own page.
  - Fix: export one shared `EXCHANGE_RATES_QUERY_KEY` constant; use it everywhere, or invalidate both literal prefixes from the refresh mutation.
  - Verification (2026-06-30): `DashboardPage.tsx` (named in the original impact list) does not actually call either hook — drop it from the affected-surfaces list; everything else named checks out.

- [x] **FX-exposure gating on Stocks/Crypto pages is dead code — always evaluates false** ⏫ ✅ 2026-07-11 · a899a72 (#82)
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/pages/portfolio/StocksPage.tsx:73,362`, `CryptoPage.tsx:44,270` — `(h.currency || 'EUR') !== targetCurrency`
  - `usePortfolioSummaries` always sets `currency` to the *display* currency on every summary, exposing the real native currency separately as `originalCurrency`. This comparison can never be true, so the FX-gain column/banner never renders for any foreign-currency holding — the same currency-confusion bug class already fixed elsewhere (commit `54187c21`, native vs. display currency), left unfixed here. `PortfolioOverviewPage.tsx:87-88` already does this correctly via `originalCurrency`.
  - Fix: compare against `h.originalCurrency` (fall back to `h.currency` only if absent).

- [x] **Portfolio Performance page shows a misleading empty state on fetch failure** ⏫ ✅ 2026-07-11 · a899a72 (#82)
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
  - Verification (2026-07-03): blast radius is wider than the snapshot walk alone — the LIVE summary is equally blind. `packages/shared-utils/src/portfolio.js:510-522` (`buildInvestmentSummaryCore` txn switch has no `return_of_capital` case) and `:566,:583` (non-unit `totalInvested = buys − sells`) ignore non-unit RoC the same way; unit-based RoC IS handled correctly on both sides via `applyEventToLots`. The two surfaces agree today (consistent overstatement, no parity break), but fixing only the snapshot walk would CREATE a live-vs-snapshot disagreement — any fix must patch both `snapshotBuilder.js` and `buildInvestmentSummaryCore` together. Adjacent design gap: `computeTradeCashLegAmount` has no RoC case either, so RoC cash never reaches the sleeve.

- [ ] **UTC-derived "today" instead of `todayAppDateString()` at 5 sites — wrong between 00:00 and 01:00/02:00 Brussels** 🔼
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c_
  - `repositories/plannedTransactionRepository.js:624` — execution recorded with **yesterday's** date if executed after midnight
  - `services/aiChat/tools/planned.js:52-56,61-62,90-91,~264-271,~338` — upcoming-planned window starts a day early / ends a day short at night
  - `services/aiChat/tools/expenses.js:499-503` — today's transactions excluded from trend queries between midnight and 02:00
  - `services/calculations/forecast/index.js:76-86` (`rollingWindowDates`) — actuals/forecast split sits on yesterday at night
  - `services/reports/index.js:602` — PDF filename date only (cosmetic)
  - Fix: `todayAppDateString()` / `toAppTz` from `lib/timezone.js`.
  - Verification (2026-07-03): two more sites found, same class — `infoRepo.forecast.js:21-23` (local `new Date()` day-of-month vs SQL `CURRENT_DATE`) and `infoRepositoryNetWorth.js:203-204` (UTC-midnight end anchor). Edge-hour only; masked in Docker-UTC like the others.

- [ ] **Recurring-detection emits raw pg Date objects through JSON — consumers slicing the date part see the previous day** ⏫ 🔧 *(escalated — confirmed systemic across 12 route surfaces, not just recurringDetection)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c_
  - `services/recurringDetectionService.js:249-250` — `firstSeen`/`lastSeen` serialize via `toJSON`→`toISOString` → `"2026-06-30T22:00:00.000Z"` for a July-1 transaction. (`predictedNext` at :251 is safe — rebuilt via local getters.) *Frontend consumer not verified — check before fixing.*
  - Fix: format with a local-getter ymd helper before emit.
  - Verification (2026-07-03): full enumeration of the systemic passthrough — no `setTypeParser` override exists anywhere in the backend and the envelope (`middleware/envelope.js:20-36` `res.ok`) does no Date normalization, so every route below emits a DATE column as a previous-day ISO timestamp under non-UTC TZ. 12 confirmed surfaces: **main transactions** `routes/transactions.js:659-660` `formatTransaction` (`date`/`transaction_date`, all CRUD responses) · **planned** `routes/plannedTransactions.js:328,343,349,352,355,366` (`planned_date`, `last_executed_date`, `loan_start_date`, `loan_first_payment_date`, schedule `due_date`, `execution_date` — see the date−1 round-trip finding below for its save-path consequence) · **portfolio-tx** `portfolioTxRepo.reads.js:11-12` (coerces NUMERICs but not `date`/`recurrence_end_date`) → `investmentController.js:315-335,382-390` (also drives the date−1 round-trip finding) · **recurringDetection** (this finding; also reaches aiChat `insights.js:288`) · **recipient insights** `infoRepositoryRecipients.js:49-50,79-86` (`firstSeen`/`lastSeen`, `GET /api/aggregations/recipient-insights`) · **monthly summary** `infoRepo.monthly.js:77` MV path + `:223-224` live path (mixed with ymd-string zero-filled months in the same payload, `GET /api/aggregations/monthly-summary`) · **portfolio performance** `routes/info/_performanceHelpers.js:31-33` (a `toYmd` conversion at `:60` is computed then discarded) · **accounts** `accountRepository.js:14-16` → `routes/accounts.js:25,31` (`statement_balance_date`) · **investments** `portfolioSummaryService.js:296-297` + `investmentRepository.js:12` (`maturity_date`) · **bank-import preview** `importBatchRepository.js:94` → `routes/importRoutes.js:454` (`tx_date` — its portfolio-import sibling uses `to_char` and is clean) · **saved charts** `savedChartsRepository.js:3-15` (`date_range_start/end`) · **split payments** `splitRepository.js:389,403-410` (`paid_at`). The portfolio-performance/accounts/bank-import-preview/saved-charts/split-payments surfaces were pattern-matched, not individually re-read line-by-line — confirm exact lines before fixing.

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

- [ ] **Cost-basis calculators silently clamp oversells instead of flagging a data-integrity problem** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Portfolio / investments_
  - `packages/shared-utils/src/portfolio.js:135-150` (weighted-avg), `:219-256` (FIFO), `:321-358` (LIFO)
  - When a sell's recorded lots are insufficient (e.g. an earlier buy was deleted), `sellUnits = min(units, totalUnits)` clamps and shrinks the ratio proportionally — excess gain/fees/taxes are dropped with no warning surfaced anywhere. Deleting a buy while keeping its matching sell silently understates realized gain.
  - Fix: surface a flag (mirroring the existing `_fxFellBack` pattern) when `units.gt(totalUnits)` so the response can warn.

- [ ] **"Uncategorised transactions" queue misses alias-recipient transactions that are already categorized everywhere else** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Categorization_
  - `apps/node-backend/src/repositories/transactionRepository.js:179-204,214-308` (`getUncategorised`/`WithCount`)
  - Checks only `t.category_id IS NULL AND r.default_category_id IS NULL`, never the primary recipient's default — same root cause as the finding above.
  - Fix: join the primary recipient and extend the predicate, matching `getAll`'s fallback chain.

- [ ] **Category display truncates DETAIL text that contains a colon** 🔼 🔎 verified-present 2026-07-11 *(frontend, same root cause as backend issue above is unrelated — separate bug)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Categorization_
  - `apps/frontend/src/pages/DashboardPage.tsx:224-232`, `apps/frontend/src/pages/RecipientsPage.tsx:213-221`
  - `categoryName.split(':')` then uses only `parts[1]` — a category like `general="TRAVEL", detail="FLIGHT: BOOKING.COM"` renders as just "Flight". `CategoryPivotTable.tsx:112-116` already handles this correctly via `split(":")` + rejoin.
  - Fix: apply the same join-back pattern (`const [general, ...rest] = name.split(":"); rest.join(":")`) at both call sites.

- [ ] **Stale fast-cadence recurring planned transactions silently vanish from next-month forecast** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Planned / recurring transactions_
  - `apps/node-backend/src/repositories/infoRepositoryPlanned.js:15` (`MAX_OCCURRENCES = 120`), `:22-36` (`expandRecurringOccurrences`)
  - The function walks forward from the row's stored `planned_date` (not "today") up to 120 hops to find occurrences inside next month's window. A daily-cadence row that hasn't been executed/advanced in >120 days exhausts the cap before reaching next month and returns `[]` — silently disappearing from the forecast, no error or log.
  - Fix: fast-forward `current` directly to the first occurrence ≥ `startYmd` via interval math instead of a flat linear walk.

- [ ] **Planned-transaction name resolution silently drops unmatched category/recipient instead of erroring, unlike live transactions** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Planned / recurring transactions_
  - `apps/node-backend/src/routes/plannedTransactions.js:38-75`
  - `resolveRecipientIdFromName`/`resolveCategoryIdFromName` just delete the field on no match; the equivalent live-transaction logic in `transactions.js` correctly throws `ValidationError` on the same condition. A typo'd `category_name` saves successfully with no category and no indication anything was wrong.
  - Fix: make the planned-transaction route throw `ValidationError` on unresolved lookups, or extract one shared resolver both routes call (also fixes the duplication noted below).

- [ ] **Recurring-transaction detection blends income and expense from the same recipient into one nonsensical pattern** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Planned / recurring transactions_
  - `apps/node-backend/src/services/recurringDetectionService.js:159-170,212-214`
  - Transactions are bucketed solely by `recipient_id`; amounts go through `.abs()` before averaging, with no sign/category partitioning. A recipient who both pays and is paid by the user gets both directions merged into one averaged "pattern" that matches neither real flow.
  - Fix: partition each recipient's transactions by sign (or category) before interval/amount detection.

- [ ] **Route/service boundary (ADR-067) is bypassed via direct DB access in several route files, undetected by the lint gate meant to prevent exactly this** 🔼 🔧 *(citation path corrected)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `routes/transactions.js:8,171-203,318-485`, `routes/plannedTransactions.js:8,45-75`, `routes/attachments.js:22,61` import `query`/`withTransaction` straight from `database/connection.js` and run raw SQL in route handlers. The custom ESLint rule `no-repo-direct-from-route` only blocks `/repositories/` imports, not `database/connection.js` — this larger bypass passes lint clean (verified directly by running `npx eslint` on all three files: exit 0, zero warnings).
  - Fix: move these queries into `transactionService`/`plannedTransactionService`; extend the lint rule to also flag `database/connection.js` imports under `routes/**`.
  - Verification (2026-06-30): corrected citation — the rule lives at **`apps/node-backend/eslint.config.js`** (not a bare `eslint.config.js` at repo root, which doesn't exist), and the actual matching predicate is at **line 43**, not lines 18-32 (which is the rule's JSDoc/meta block).

- [ ] **Duplicated recipient/category-name-resolution logic between `transactions.js` and `plannedTransactions.js` routes has already diverged in error behavior** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `routes/transactions.js:168-205` vs. `routes/plannedTransactions.js:38-75`
  - Near-identical raw SQL copy-pasted across two files; one throws `ValidationError` on no-match, the other silently no-ops (see the planned-transactions finding above — same fix resolves both).
  - Fix: extract one shared `resolveRecipientId`/`resolveCategoryId` helper into `recipientService.js`/`categoryService.js`.

- [ ] **CSV export's `running_balance` is a single global accumulator, not partitioned by account — same bug class already fixed on the list endpoint** 🔼 🔎 verified-present 2026-07-11 *(found incidentally during the performance audit)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Data export_
  - `apps/node-backend/src/services/transactionExport.js:196,211`
  - The main transaction-list endpoint (`transactionRepository.js:121-123`, ADR-088) was explicitly fixed to partition `running_balance` by `account_id` because "a list spanning multiple accounts summed them into one meaningless cross-account total." The CSV export path has the identical unfixed bug. Confirmed reachable via `GET /api/transactions/export/csv?include_balance=true` with no account filter.
  - Fix: partition the export's running-balance accumulator by `account_id`, mirroring the list-endpoint fix.

- [ ] **Cash-flow forecast header is off by a month in timezones behind UTC** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/components/dashboard/CashFlowForecastChart.tsx:207` — `new Date(monthQuery.data.month + "-01T00:00:00Z")` then formatted with local getters
  - Confirmed via concrete trace: month="2026-01", US Pacific (UTC-8) → `2026-01-01T00:00:00Z` reads locally as `2025-12-31T16:00:00-08:00`, so local `getMonth()` returns December 2025. Brussels (UTC+1/+2, ahead of UTC) is unaffected. `NetSummaryCard.tsx:53` already avoids this via numeric year/month construction.
  - Fix: build the `Date` from numeric parts, not a UTC-anchored string.
  - Verification (2026-07-03): two more surfaces hit the same west-of-UTC-only class (Brussels users unaffected either way): `PortfolioForecastPage.tsx:79` (`new Date(ymd).getTime()` + local-getter formatting at `:273`) and `forecastMerge.ts:247` (UTC-midnight points) vs `ForecastInnerRolling.tsx:62` (local-midnight today-line) — the marker sits 1-2h off its day's point; both only shift labels/markers west of UTC.

- [ ] **Recipient merge/unmerge leaves Statistics aggregations stale** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/hooks/useRecipients.ts:82-84,115-117`
  - Both invalidate only `['recipients']`/`['transactions']`; Statistics' recipient breakdowns live under a separate `['aggregations', ...]` namespace that's never touched, so merged/unmerged identities stay split in Top Recipients until staleTime expires.
  - Fix: also invalidate `['aggregations']` in both mutations.

- [ ] **Planned-payment edits don't refresh the global "upcoming payments" banner** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/hooks/usePlannedPayments.ts` (plain `useState`/`fetch`, no React Query), `pages/PlannedPaymentsPage.tsx:100-103`
  - Nothing invalidates `['upcomingPlannedPayments', queryDate]`, the cache backing the app-wide banner. Creating/deactivating/executing a planned payment doesn't update the banner for up to 5 minutes. `ImportReviewPage.tsx:130-131` already invalidates both keys correctly elsewhere, confirming this is an inconsistency.
  - Fix: invalidate `["upcomingPlannedPayments"]` from every mutating path.

- [x] **Combined investment-create + initial-purchase flow can create duplicate investments on partial failure** 🔼 ✅ 2026-07-11 · 750022d (#82)
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Frontend_
  - `apps/frontend/src/components/portfolio/AddInvestmentDialog.tsx:76-126`
  - If `addInvestment` succeeds but the chained `addTransaction` fails, the dialog stays open in "create" mode with no indication a server-side row already exists; resubmitting creates a duplicate investment.
  - Fix: track the created investment id in state so a retry only re-attempts the transaction step.
  - Verification (2026-07-03): a concrete, deterministic everyday trigger was found (not previously filed) — `AddInvestmentDialog.tsx:101-119` unit-based initial purchase with units left empty submits an amount-only buy that fails `portfolioTxRepo.common.js:109-116`'s 2-of-3 check, producing a raw 400 *after* the investment row has already been committed — a guaranteed hit of this bug, not just a network-failure edge case. See the new "AddInvestmentDialog: initial purchase silently dropped" finding for the sibling amount-skipped-entirely case.

- [ ] **Triple-cast produces a dormant NaN landmine in the account-close flow** 🔼 🔎 verified-present 2026-07-11 *(currently inert — gated behind ADR-103, verified OFF)*
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
  - Verification (2026-07-03): the file's own header comment (`validate.js:5`) claims it uses `deduplication.createTransactionHash` — it doesn't; that function has zero production callers, so the header is misleading about which hashing path is actually live. Latent only because all 10 adapters currently set `raw_data`; if one ever stops, every hash silently changes (mass duplicate re-imports on the next upload) with a wrong date baked in.

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

- [ ] **Foreign-currency trade legs/cash rows posted onto the sleeve raw; balance SQL sums without FX** 🔽 🔎 verified-present 2026-07-11 *(CONFIRMED 2026-07-03 — was "needs confirmation")*
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b_
  - `tradeCashLegService.js:66-79`, `commit.js:93-97` vs `repositories/accountBalanceSql.js:37` (`SUM(t2.amount)`, no FX conversion)
  - USD trade on a EUR sleeve posts `−1000` USD; balance sums it as EUR.
  - Verification (2026-07-03): confirmed end-to-end — `tradeCashLegService.js:66-79` posts the cash leg in the trade's native currency (`portfolioTxn.currency || 'EUR'`); `accountBalanceSql.js:37` sums with no currency discrimination, and both consumers (`accountRepository.js:46`, `crossWorkspaceDataService.js:61`) receive the single collapsed number — no conversion happens anywhere downstream. The anchor+delta balance logic itself is otherwise sound (fine for single-currency accounts) — only the currency-blindness is the bug.
  - Fix: convert each leg's amount to the account's currency at read time (or stamp a converted amount at write time), matching the FX handling already done for the transactions table.

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
  - Verification (2026-07-03): two more nuances found on the same guard — `getSchemaHead`'s `LIMIT 1` (`:2115`) picks an arbitrary row under the known multi-head `alembic_version` drift (rather than a deterministic head), and an empty `currentHead` (DB down at guard-check time) skips the guard entirely rather than failing safe.

- [ ] **0062 trigger: blanking `bank_account` on UPDATE leaves a stale `account_id`** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Migrations (only 0061 + 0062 verified this pass)_
  - `alembic/versions/0062_trigger_lookup_only_on_update.py:59-78` — body gated on `acct_name IS NOT NULL AND <> ''`, so an UPDATE clearing `bank_account` keeps the old `account_id`; the row keeps counting toward an account whose label was removed. Fix: decide explicitly (keep or NULL) in the blank-on-UPDATE case.

- [ ] **0062 trigger: account lookup is case-sensitive on INSERT and UPDATE** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c · Migrations (only 0061 + 0062 verified this pass)_
  - `0062…py:64-67,73` — `WHERE name = acct_name` / `ON CONFLICT (name)`: a casing-only difference ("Kbc" vs "KBC") creates a duplicate account on INSERT or silently keeps the old `account_id` on UPDATE. Fix (deliberate decision — changes onboarding semantics): normalize via `lower(btrim(...))` or case-insensitive unique index.

- [ ] **`findAutoLinkTarget` is dead in production and diverges from the real (stricter) auto-link rule** 🔽 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Planned / recurring transactions_
  - `apps/node-backend/src/services/plannedMatchService.js:85-88` vs. the actual logic at `:130-145`
  - Only checks single-direction uniqueness, not the documented mutual-uniqueness rule the real `autoLinkTransactions` enforces inline. It's covered by its own passing unit tests, creating false confidence — a future editor of the matching rule is likely to "fix" the wrong copy.
  - Fix: delete it (and its tests), or refactor `autoLinkTransactions` to call it as the single-direction primitive with the mutual check layered on top.

- [ ] **In-place `delete` on PATCH fields contradicts the documented immutable-rest sanitization pattern** 🔽 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `routes/transactions.js:153-166,161-163,181`, `routes/plannedTransactions.js:40,53,74`
  - `docs/reference/code-patterns.md:585` states the canonical pattern explicitly ("never in-place delete"); both files mutate a shallow copy directly with `delete fields.x`. Notably, `plannedTransactions.js` has the *correct* pattern right next to the bug (`withoutPatchOnlyReadOnlyFields`, lines 26-36, uses destructured rest), showing the divergence is real and inconsistent even within one file. Not a live bug today (the copy isn't `req.body` itself), but an easy pattern to copy onto a non-copied object later.
  - Fix: rewrite as `const { x, ...rest } = fields; return rest;` in both files.

- [ ] **Amount-sign filter coercion logic is duplicated between list and bulk-action routes** 🔽 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `routes/transactions.js:71-80` (`parseTransactionListQuery`) vs. `services/bulkSelection.js:46-53` (`normalizeBulkFilter`)
  - Both independently reimplement identical `amount_signed`/magnitude coercion; `bulkSelection.js` is documented to "mirror" the list endpoint but a future fix to one won't propagate to the other.
  - Fix: extract a shared `parseAmountFilter(value, signed)` into `filterBuilder.js`, import in both places.

- [ ] **Dead, unguarded `createSplit` bypasses the over-allocation validation its "atomic" siblings exist to enforce** 🔽 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `apps/node-backend/src/repositories/splitRepository.js:65-73`
  - Inserts a split row with no row lock and no `validateSplitAllocation` call; unreferenced in live code (test-mock only). Real call sites use `createSplitAtomic`/`createSplitsBatchAtomic`. (Note: `openapi.yaml`'s `operationId: createSplit` for the POST endpoint is an unrelated naming coincidence, not a real caller of this function.)
  - Fix: delete it, or make it delegate to `createSplitAtomic`.

- [ ] **Dead legacy per-bank dedup repository with its own passing test suite (false confidence)** 🔽 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `apps/node-backend/src/repositories/rawTransactionRepository.js` (323 lines — `belfiusRawRepo`, `kbcRawRepo`, `revolutRawRepo`, `sabbRawRepo`, `wiseRawRepo`, `visionRawRepo`, `rawReferenceRepo`, `isRawDuplicate`)
  - Zero references in `src/` outside itself; only its own test file exercises it (and that test mocks the DB connection entirely, so it passes with zero real wiring). The live dedup path is `services/deduplication.js` against a different table — this older mechanism (including `kbcRawRepo`, backing `kbc_raw_transactions`) is fully disconnected from the import pipeline.
  - Fix: delete module + test, or confirm intent and wire it in.
  - Verification (2026-07-03): dead-in-prod reconfirmed by a full re-read — the per-bank raw tables are never written by the current pipeline. Also: `isRawDuplicate` returns `null` instead of `undefined` (convention violation), and its literal-line hashes could never agree with the pipeline's `tx_hash` anyway even if wired back in (vision/generic/sabb/wise/revolut adapters rebuild `rawData` rather than hash the literal CSV line, so hash-agreement is moot). The same false-confidence-via-passing-tests class also applies to the sibling `services/bankAdapters.js` shim (zero production importers; only adapter test files and one route-test mock exercise it) — already filed separately as an Architecture-domain doc/dead-code finding, not refiled here.

- [ ] **nl typo + minor wording inconsistencies** ⏬
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a_
  - `addInvFromMarket.option.addTxnDesc`: "verkop" → "verkoop" · `filter.type.income`/`search.suggest.allIncome` use "Ontvangsten" while every other surface uses "Inkomsten" · `tax.profile.field.cadastralIncome` nl reads "Kadastraal inkomen (kadastraal inkomen)" (EN parenthetical was already the Dutch term).

- [ ] **Recurring-detection and forecast aggregates use native float arithmetic instead of the mandatory Decimal helper** ⬇ 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Planned / recurring transactions_
  - `apps/node-backend/src/services/recurringDetectionService.js:213,243-244`, `apps/node-backend/src/repositories/infoRepositoryPlanned.js:86-87,125-126`
  - Per `docs/reference/code-patterns.md`, monetary accumulation must route through `addAll()`/Decimal; here amounts are summed/averaged with native `+=`/`reduce` after one `toDecimal().toNumber()` conversion. Final values are cent-rounded so drift is negligible (display-only, not ledger writes), but it's inconsistent with the stated scope.
  - Fix: swap the accumulations for `addAll()` from `lib/money.js`.

- [ ] **`generateLoanRepaymentSchedule` falls back to `null` instead of `undefined`** ⬇ 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Planned / recurring transactions_
  - `apps/node-backend/src/services/calculations/loanSchedule.js:154` — `schedule[0]?.due_date ?? null`
  - Dead code in practice (`validateLoanConfig` guarantees a non-empty schedule), but a stray `null` outside the documented repository-row-not-found exception.
  - Fix: remove the defensive fallback, or change to `?? undefined`.

- [ ] **ADR-096 portfolio-income/FIRE-coverage feature has no endpoint wired up — but this is an unimplemented Proposed-status ADR, not a silently-orphaned built feature** ⬇ 🔧 *(reframed after verification)*
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - `apps/node-backend/src/services/portfolio/portfolioIncomeService.js` (`aggregateIncome`, `coverageRatio`) has zero callers anywhere in `src/`, any route, or the frontend.
  - Fix: wire into a portfolio-stats route if this is still wanted, or close the ADR as deferred/not-pursued.
  - Verification (2026-06-30): the original framing ("unlike `brokerageFanout.js`, there's no note explaining why this is unreachable") is misleading — **`docs/adr/096-dividend-income-fire.md:13` has status "Proposed"** (vs. ADR-095 "Implemented" and ADR-103 "Accepted"), which *is* the explanation: this was never built out, not built-and-abandoned. The code-level dead end and the fix suggestion are still valid; only the "documentation discipline gap" framing was wrong.

- [ ] **Systemic `null` instead of `undefined` for optional values in route filter-parsing, beyond the documented exception** ⬇ 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Correctness — Backend · Architecture / route-service boundary / dead code (backend)_
  - Pervasive: `routes/transactions.js:61-94`, `importRoutes.js:414-524`, `portfolioImportRoutes.js:55-422`, `aggregations.js:234-250`, `categories.js:21`, `tags.js:21`, `research.js:57-146`, `marketLookup.js`
  - Violates the stated convention at scale beyond the documented repository row-not-found exception. Currently harmless (consumers mostly use `!= null` loose checks) but the same pattern class that caused the account-PATCH bug above.
  - Fix: not urgent in isolation — worth a dedicated lint rule / sweep rather than a one-off fix.

- [ ] **`GET /index.html` bypasses the no-cache SPA fallback and gets `Cache-Control: max-age=1y, immutable` — a stale-shell-after-upgrade edge** 🔽
  - ↪ _from: UI/GPU performance research 2026-07-05 · Wave G3 (filed under Correctness — broken-app edge, not a perf cost)_
  - `apps/node-backend/src/main.js:359` `express.static(distPath, { index: false, maxAge: '1y', immutable: true })` vs `:363-366` fallback (`no-cache`, in-memory shell)
  - `index: false` only disables *directory-index resolution* — a request for the literal path `/index.html` is still a real file in `distPath` and is served by `express.static` **with the 1-year immutable header**. A client pinned to that URL keeps the old shell after an upgrade; its old hashed chunk URLs then 404 → broken app until hard refresh. Exposure is honestly low: the SPA always navigates via `/` and nothing in the app links `/index.html` — it takes a user bookmark or an external tool hitting the literal path. Same header also applies to the non-hashed `public/` passthroughs (`dist/favicon.ico`, `robots.txt`, `placeholder.svg`) — stale favicon after upgrade, trivial.
  - Fix: exclude it from the static root — e.g. `setHeaders: (res, path) => { if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); }` in the `express.static` options (2 lines), optionally same short-max-age for the three non-hashed public files. **Visually free**

- [ ] **Exported Date column is `String(pg Date)`; NDJSON export shifts every date to the previous day** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a (residue, closed 2026-07-03)_
  - `transactionExport.js:99` feeds the raw pg DATE (no `setTypeParser` override exists anywhere in the backend) into `escapeCsvValue`'s `String(value)` → e.g. `"Wed Jul 01 2026 00:00:00 GMT+0200 (Central European Summer Time)"` in every CSV row. Same-TZ re-import survives via `parseDateFlexibleUtc`'s engine fallback (`adapters/_shared.js:77-79`), but cross-TZ re-import shifts a day and the column is unusable in Excel/other tools. NDJSON is worse: `buildNdjsonRow` (`transactionExport.js:117`) serializes via `toISOString` → `"2026-06-30T22:00:00.000Z"` for a July-1 row — every NDJSON date is the previous day.
  - Fix: `toYmd(row.date)` — already imported at `transactionExport.js:12` for the keyset cursor.

- [ ] **`sanitizeSnapshotSpikes` breaks the `Σ value_by_account == value` invariant and can falsify real portfolio history** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 1b (residue, closed 2026-07-03)_
  - `utils/portfolioMath.js:48-86` smooths `value` + per-class extras but neither `value_by_account` nor `cash_value`; the "Σ value_by_account == value by construction" comment (`snapshotBuilder.js:574-577`) no longer holds after sanitize at `:582`.
  - A genuine 2-day value swing of ≥18% with recovery (plausible for crypto-heavy portfolios — detection runs on TOTAL value) is permanently smoothed into persisted history; a real 1-day cash transit (deposit, next-day withdrawal) gets `value` smoothed while `invested` stays → a fabricated loss day. First/last rows are never smoothed, so a latest-day needle passes through and then mutates retroactively on the next build.
  - Fix: also smooth/reconcile `value_by_account` and `cash_value` in lockstep with `value`, or skip smoothing when it would break the per-account sum invariant.

- [ ] **`vision.detect()` is substring-only — any unknown bank CSV containing its header words auto-routes to the Vision self-import adapter** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a (residue, closed 2026-07-03)_
  - `adapters/vision.js:53-60` matches on `'Booking Date,Recipient Bank Account,Amount,Reference'` as a substring, not an exact header match (verified). Current first-match-wins order (`adapters/index.js:19,53-58`) shields the five earlier adapters, but nothing pins that ordering, and any future/unknown bank export containing those words would silently misdetect as a Vision export.
  - Fix: require an exact header match (or a stronger positive signal) in `vision.detect()`.

- [ ] **Import/portfolio test suites pass (36/36) but use unrealistic fixtures that mask several filed bug classes** ⬇
  - ↪ _from: Correctness research 2026-07-02 · Wave 1a/1b/1c (residue, closed 2026-07-03)_
  - `brokerageFanout.test.js` fixtures always set `row.amount` and stub the cash leg asserting call-counts only → the `{...created, ...row}` spread bug (`brokerageFanout.js:132`) is doubly masked; no error-path/`errors`-counter test. `accountSnapshotParity.test.js`'s headline Σ==value assertion is near-tautological (`splitByAccount` normalizes weights to sum 1 by construction); no split/RoC/oversell fixtures; despite the name there is no cross-check against `portfolioSummaryService`; 8 order-coupled `mockResolvedValueOnce` calls make the mock define the query contract. `portfolioImportCommit.test.js` never tests `commitPortfolioImport` (batch-status-after-error unasserted) and its dispatch regex leaves the success-path `status='committed'` UPDATE and batch counters entirely unasserted. No suite anywhere posts a non-EUR trade or asserts the leg's currency param (FX-on-sleeve invisible to tests). `visionAdapter.test.js` feeds only clean `YYYY-MM-DD` dates and unprefixed amounts — formats the real export never produces — and never tests `vision.detect()`, the `skipped` counter, or `balance`. `revolutAdapter.test.js` malformed-row tests assert only `toHaveLength(3)`, not which row survived. `bankAdapterFactory.test.js` covers detect for only 2 of 8 banks, with no ambiguity/ordering pin and 3 banks missing from the `getSupportedBanks` assertion. `EditPortfolioTxnDialog.test.tsx:24,71` feeds plain `"2025-01-10"` dates the real API never sends (it sends ISO timestamps), so the date−1 round-trip shift filed below is invisible to the suite.
  - Fix: add fixtures for the failure modes above (non-EUR trades, error paths, realistic wire-shape dates/formats) to each suite named.

- [ ] **Portfolio-tx and planned-tx edit dialogs persist date−1 on every save (non-UTC backend)** 🔺
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c (residue, closed 2026-07-03)_
  - Portfolio tx: wire `date` is a raw pg Date (`portfolioTxRepo.reads.js:12` coerces only NUMERICs over `SELECT *`; `investmentController.js:380-390` + bulk `:318-335` emit it) → `EditPortfolioTxnDialog.tsx:38-52` `normalizeYmdInput` takes `split('T')[0]` of the already-shifted ISO → prefill `:72` → save `:144` writes the previous day back. Planned tx identically: `routes/plannedTransactions.js:328` emits `planned_date` raw → `usePlannedPayments.ts:78-81` T-split → `:140`/`:166` send it back as `planned_date` on create/update.
  - Editing ANY field (e.g. amount) silently moves the date one day earlier per round-trip. Masked on the packaged Docker app (no `TZ` set in compose → backend runs UTC); live on `bun run dev` (Europe/Brussels) and any non-UTC self-hosted deployment. (The 2026-06-19 "edit-save date 400" fix made the dialogs *accept* the ISO wire shape — the shift got baked in at that point.)
  - Fix: emit `date`/`planned_date` as ymd strings from the backend (see the raw-pg-Date passthrough finding above), or parse via a TZ-safe helper before re-submitting on the frontend.

- [ ] **DB price-history cache silently returns EMPTY on every read — TZ-independent data loss** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c (residue, closed 2026-07-03)_
  - `priceCache.js:150-176,186-210` select raw `price_date` and feed it to `dateOnlyToTimestampMs` (`:36-41`), which does `String(dateOnly).split('-')` expecting `"YYYY-MM-DD"`; `String(pgDate)` is `"Wed Jul 01 2026 …"` — no parseable y-m-d substring in ANY timezone → `NaN` → `normalizeHistoryPoints` (`:45-60`) filters every row.
  - Every DB-cached price-history read yields `[]`: a silent re-fetch from live providers (quota burn) or an empty chart when running `db_only`. Unlike most findings in this wave, this one is NOT masked by a UTC-TZ Docker deployment — it's broken in every deployment.
  - Fix: convert `price_date` with a local-getter ymd helper (or `to_char` in the SELECT) instead of `String()`-ing the pg Date object.

- [ ] **Frontend `parseLocalDateFromYmd` returns Invalid Date on ISO-timestamp wire values — TZ-independent** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c (residue, closed 2026-07-03)_
  - `dateUtils.ts:71-77` `parseLocalDateFromYmd` yields `Date(NaN)` for any `'T'`-suffixed string, which is exactly what the raw-pg-Date passthrough (above) sends it.
  - `PortfolioOverviewPage.tsx:166-174` — every transaction is skipped by the NaN date, so the 30-day cost-basis sparkline is flat-zero and permanently hidden (`:184`) in ALL deployments, not just non-UTC ones. `SavingsPage.tsx:22-24` — `daysUntil(maturityDate)` = NaN → `:268` renders "NaN days remaining", and the maturing-soon/matured badges (`:158-159`) never fire.
  - Latent secondary bug in the same component: `PortfolioOverviewPage.tsx:152,172` buckets days via raw `86_400_000` ms against local-midnight anchors, which mis-buckets transactions by one day across a DST boundary — moot today because the NaN bug above drops all transactions first, but it will surface once that's fixed.
  - Fix: fix at the source (stop emitting ISO timestamps for date-only columns), and/or harden `parseLocalDateFromYmd` to also accept a `'T'`-suffixed value defensively.

- [ ] **Jan-1 income/portfolio transactions are misattributed to the PREVIOUS tax year (non-UTC backend)** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c (residue, closed 2026-07-03)_
  - Frontend: `belgianTax/portfolioTax.ts:55` `yearOf = date.slice(0,4)` operates on the already date−1-shifted ISO (used at `:67,:82,:130,:167,:277`), and `useAvailableTaxYears.ts:33` inherits the same shift — both put a Jan-1 portfolio transaction in the PREVIOUS tax year.
  - aiChat: `tools/tax.js:48-51` `inYear` compares pg local-midnight Dates against `Date.UTC` year bounds — Jan-1 income lands in the prior year's taxable summary; `tools/portfolio.js:23-33,163-165,258-260,482-483` is the same class — every transaction dated exactly on a range's START day is excluded from income/costs/fees aggregations.
  - Fix: same root cause as the raw-pg-Date passthrough finding — convert to ymd strings at the backend boundary before any year-slicing.

- [ ] **Several date-display consumers show a day-early date (non-UTC backend)** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 1c (residue, closed 2026-07-03)_
  - All T-split/format the pre-shifted date part: `InvestmentDetailDialog.tsx:540` (portfolio txn list), `PlannedPaymentsPage.tsx:40-68` `dueBadge` (overdue shown a day early, "today" shown as yesterday) + `:139-147` upcoming-count, `SavingsPage.tsx:261`, `RecurringDetectionPanel.tsx:22` (`predictedNext` et al.).
  - `firstSeen`/`lastSeen` consumers (`RecipientInsightsTab.tsx:137,145`, `RecipientInsightsPage.tsx:118,126`) are the exception: `parseISO` on the full ISO string + local formatting self-corrects when browser TZ == server TZ; off-by-one only surfaces cross-TZ.
  - Fix: same root cause as the raw-pg-Date passthrough finding — fix at the backend boundary.

- [ ] **Clearing a portfolio txn's Fees/Taxes/Note/FX silently keeps the old value — success toast, silently wrong cost basis** 🔺 *(verified)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `EditPortfolioTxnDialog.tsx:148-151` maps emptied fields to `undefined` → JSON drops the keys → backend merge keeps existing (`portfolioTxRepo.writes.js:99-115` `{...existing, …}`). "Delete the €7.50 fee → Save → success" leaves the fee in the DB; cleared FX likewise persists unless date/currency changed (`investmentController.js:492-503`). The same submit already does it right for `account_id` (`:142-152` sends explicit `null`, with a comment documenting the null-vs-undefined semantics).
  - Not a duplicate of the other filed EditPortfolioTxnDialog items (date−1 round-trip / reset-on-close / duplication).
  - Fix: send explicit `null` for cleared Fees/Taxes/Note/FX fields, matching the existing `account_id` pattern.

- [ ] **Systemic cleared-field → `undefined` → dropped-key → silent-keep class (4 surfaces, one fix pattern)** 🔺
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - Same class as the portfolio-txn finding above, also in: `TransactionsPage.tsx:313,331` — clearing category/recipient inline: `CategoryCombobox.tsx:48-55` emits `null`, the page maps `?? undefined` → PATCH body `{}` → `onSuccess` (`:315-320,333-339`) re-applies the old value over the optimistic patch, so the clear **visually reverts**. `TransactionInfoDialog.tsx:76-88` — clearing memo/comment/currency/bank sends an empty PATCH but `onApplyLocal(…,'')` updates the visible row → silent divergence until reload. The accounts null-clear finding above is the fourth surface.
  - Fix pattern (all four): send explicit `null` for cleared fields — the transactions backend already honors it (`transactionRepository.js:479-485` skips only `undefined`).

- [ ] **Planned-payment "End date" / "Max occurrences" are dead UI — bounded recurrences recur forever** ⏫ *(verified; three independent traces converged)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - The form collects + submits them (`PlannedPaymentForm.tsx:288-302`, payload `:105-110`) but `usePlannedPayments.ts` `mapToCreateAPI:139-159` / `mapToUpdateAPI:163-197` never map them and `mapFromAPI:85-119` never restores them (reopening the editor shows the recurrence as endless — the loss is invisible). The backend has no such columns (`plannedTransactionRepository.js:334-347`; no alembic hits; `routes/plannedTransactions.js:204-205` even `delete`s them in the loan branch) and `plannedExecutionService.js:37-48` advances unconditionally — no termination check exists anywhere.
  - "Monthly, ends Dec 2026, max 12" generates due bills forever.
  - Fix: add `recurrence_end_date`/`max_occurrences` columns, thread them through `mapToCreateAPI`/`mapToUpdateAPI`/`mapFromAPI`, and check them in `plannedExecutionService`'s advance logic.

- [ ] **Planned amount has no sign control — a positive "bill" renders as income and can never auto-match** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - Bare unsigned input (`PlannedPaymentForm.tsx:145`), stored as typed (`usePlannedPayments.ts:144`); loans are force-negated server-side (`plannedTransactions.js:194`), implying expenses-negative. Typing `150` for rent → "+€150" (`PlannedPaymentsPage.tsx:219`), inflates cashflow forecasts, and `plannedMatchService.js:64` (sign mismatch) guarantees it never matches the real −150 txn.
  - **Caveat: the intended sign convention for non-loan planned payments is undocumented — confirm intent before fixing.**
  - Fix: add an explicit income/expense toggle to the form and negate on save for expenses, once intent is confirmed.

- [ ] **AddInvestmentDialog: initial purchase silently dropped (success toast) — or guaranteed 400 after the investment row already exists** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - Buy leg only sent `if (amount > 0)` (`AddInvestmentDialog.tsx:101-119`): amount empty/0 with "add initial purchase" ON → investment created, buy skipped, success toast `:121` (amount labeled required at `InvestmentFormFields.tsx:226` but no `required` attr `:228-237`); unit-based with units empty → amount-only buy fails `portfolioTxRepo.common.js:109-116` → raw 400 with the investment already committed (see the enrichment on the duplicate-investment finding above). `initialDate` clearable to `''` → 400 (`investmentController.js:404-406`).
  - Sibling: `AddInvestmentFromMarketDialog.tsx:132-157,317-321` has no 2-of-3 consistency gate and no date guard — inconsistent triplets / cleared prefilled price go straight to backend 400s with raw English toasts.
  - Fix: require a non-zero amount when "add initial purchase" is on, validate 2-of-3 client-side before submit, and guard `initialDate` against empty.

- [ ] **Investments create/update have NO backend numeric validation at all** ⏫ *(verified on create)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `investmentController.js:204-251` (create: only name/asset_class presence + provider-URL SSRF) and `:359-371` (update: none) pass `current_price`, `interest_rate`, `cadastral_income`, `municipality_tax_rate` unchecked into `investmentRepository.js` INSERT/UPDATE: negative, `1e15`, JSON `"Infinity"` reach the DB; non-numeric garbage → pg cast error → 500 not 400. `municipality_tax_rate` has no max even in HTML (`InvestmentFormFields.tsx:176-184`) — a 5000% rate submits cleanly end-to-end and corrupts Belgian property-tax calc.
  - `routes/watchlist.js:13-38` is the in-repo reference implementation of exactly the missing guards (its own comment names the 500-vs-400 problem).
  - Fix: add the same numeric range/type guards `watchlist.js` already has, to both the investment create and update controllers.

- [ ] **Belgian tax profile persists with ZERO server-side validation; communal surcharge % unclamped — a negative surcharge becomes a tax credit** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `routes/settings.js:190-207` `validateSettingValue` covers only 5 known keys — `belgian_tax_profile` (and the supposedly-immutable frozen-snapshot keys) upsert as arbitrary JSON; the load side blind-casts and shallow-spreads (`BelgianTaxProfileContext.tsx:246-249`) so wrong-typed values flow straight into PIT math.
  - `RegionStep.tsx:57-64` stores any surcharge (`min=0 max=9` is advisory-only); `pit.ts:488` multiplies it unclamped — `-7` flips the surcharge into a tax credit, `70` (a fat-fingered "7.0") multiplies it 10×, no error anywhere. All money steps store raw negatives/`1e15` (`IncomeStep.tsx:47,63,111,129,151,264,280`, `ExemptionsStep.tsx:128-202`); `pit.ts:359` clamps gross ≥0 but `socialSecurity.ts:12` multiplies the raw negative (negative social security) and deduction-side fields are unclamped; `childcareEligibleDays` accepts negatives (`ExemptionsStep.tsx:183`).
  - Fix: add a server-side Zod/validator schema for `belgian_tax_profile` (and the frozen-snapshot keys), clamping surcharge to 0-9% and all money fields to ≥0.

- [ ] **Debounced tax-profile saves fail silently — edits lost with zero feedback** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `BelgianTaxProfileContext.tsx:280-284` (+ twins `:297-299,:314-316`) `.catch(logger.error)` only: a failed PUT still looks saved until reload. Distinct from the filed raw-error-toast class elsewhere in the doc — this shows the user nothing at all.
  - Fix: surface a toast/banner on the debounced save's catch path.

- [ ] **`PATCH /api/transactions/:id` validates nothing its POST sibling does — inline date-clear → raw 500** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `routes/transactions.js:610-636` whitelist-filters only: no `assertYmd` on `transaction_date`, no amount/`recipient_id` guards (vs POST `:542-547`). UI-reachable: the inline row edit's native date input cleared to `""` (`VirtualDataTable.tsx:750-762`, `DataTable.tsx:498-513` → `TransactionsPage.tsx:279`) survives the whitelist (`middleware/validation.js:10-19`; `normalizeTransactionPatchFields` `transactions.js:156-159` remaps only truthy `date`) → `UPDATE … SET "date"=''` → PG 22007 → 500 from pressing Enter.
  - Systemic pattern across the API: PATCH paths validate far less than their POST siblings.
  - Fix: apply the same `assertYmd`/amount/`recipient_id` guards used by POST to the PATCH handler.

- [ ] **Portfolio CSV import: bad column mapping → silent zero-row import with success toast** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - Neither side verifies mapped column names against the parsed header (`PortfolioImportPage.tsx:77-79`; `portfolioImportRoutes.js:75-92`). A nonexistent date column (free-typed `PortfolioCsvColumnMapper.tsx:116-125`, or a saved parser reused on a reshaped export) → every row null-parses → skipped (`portfolioGenericAdapter.js:30-33`); the `skipped` count is returned by stage (`stage.js:54`) but **dropped** by the pipeline result (`portfolioImportPipeline/index.js:106`), and there is no zero-row guard → batch auto-completes `{imported: 0, errors: 0}` → success toast (`PortfolioImportPage.tsx:141-143`).
  - Fix: propagate the `skipped` count through the pipeline result and fail/warn on a zero-row batch instead of reporting success.

- [ ] **nl: 49 live keys ship a literal `[NL] ` prefix on screen; the 32-key bulk-actions block is raw English behind it** ⏫ *(verified: count + live usage)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `txPage.bulk.*` (32 keys, e.g. `"[NL] Deactivate {n} transactions?"` — untranslated), `tags.*` (13, proper Dutch behind the marker), `filter.tags.clearAll/label`, `txPage.col.tags`, `txPage.field.tags`; rendered by `BulkActionsBar.tsx`, the four `Bulk*Dialog`s, `TagInput.tsx`, `TagFilterCombobox.tsx`, `FilterBanner.tsx`. Looks like a feature that shipped before its Dutch pass.
  - This is the only systemic nl defect found: file-wide mechanical screens show 3,529/3,529 key parity, 0 placeholder-token mismatches, no other en-left-in-nl.
  - Fix: translate the 32 `txPage.bulk.*` keys and strip the `[NL] ` marker from all 49.

- [ ] **Portfolio unit-math tolerance: frontend 100× stricter than backend — legitimately cent-off broker statements are un-enterable** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `portfolioUnitMath.ts:17` `UNIT_MATH_TOLERANCE = 0.0001` vs backend `≤ 0.01` (`portfolioTxRepo.common.js:140`). €100.00 for 3 units @ €33.33 (product 99.99 — exactly the 1-cent case the backend tolerance exists to allow) hard-blocks with the "twoOfThree" error (`AddPortfolioTxnDialog.tsx:109`, `EditPortfolioTxnDialog.tsx:123`); the helper's header claim "matches the backend normalizer" (`portfolioUnitMath.ts:11`) is true for the 4/8/6 dp, false for the tolerance.
  - Fix: widen `UNIT_MATH_TOLERANCE` to match the backend's `0.01`.

- [ ] **Backend units×price cross-check compares FLOATS at the boundary — the exactly-one-cent case its own tolerance intends to accept gets a 400** 🔽 *(verified)*
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `portfolioTxRepo.common.js:138-140`: `roundMoney` returns `.toNumber()` (`packages/shared-utils/src/money.js:86-88`), so `:140` is float−float: `Math.abs(100.00−99.99) = 0.010000000000005116 > 0.01` → units=3, price=33.33, amount=100.00 rejected.
  - Reachable via AddInvestmentFromMarketDialog / CSV import / raw API (the Add/Edit dialogs block earlier per the tolerance item above). Boundary-only refinement of the Wave 1b "repo numeric guards sound" checked-clean verdict.
  - Fix: compare with a Decimal `.lte()`, not a float subtraction.

- [ ] **AddInvestmentFromMarketDialog computes the submitted amount with raw float × + `.toFixed(2)`, bypassing `deriveUnitMath`** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `:128-130` `(parseDecimal(units) * parseDecimal(price)).toFixed(2)`, submitted when amount is left blank (`:136`): 2dp truncation (3 × 0.3333 → stores 1.00 vs true 0.9999 — within backend tolerance → silent sub-cent cost-basis skew) plus the `(1.005).toFixed(2) === "1.00"` float half-down behavior vs the shared path's Decimal banker's rounding. Max error ≤ half-cent, so silent skew, not 400s.
  - Fix: route this computation through `deriveUnitMath` like the other portfolio dialogs.

- [ ] **Custom frequency with blank/0 interval → guaranteed raw 400** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - No client guard (`PlannedPaymentForm.tsx:58,323` skip `customDays`); `usePlannedPayments.ts:126-131` (create) and `:187-194` (edit — same falsy-zero bug) send `recurrence_pattern:"custom"` → rejected (`recurrence.js:77-86`; `plannedTransactions.js:211-213,277-279`). Loan numeric sub-fields likewise presence-checked only (`PlannedPaymentForm.tsx:64`; min/max attrs inert — no `<form>`) → backend 400s (`loanSchedule.js:36-52`).
  - Fix: validate a positive `customDays` client-side before submit for the `custom` pattern.

- [ ] **`fx_rate_to_eur = 0` passes the frontend → raw 400** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `EditPortfolioTxnDialog.tsx:150,290-298` (`min="0"` permits 0) vs `portfolioTxRepo.common.js:164-166` ("must be positive").
  - Fix: change the field's `min` to just above 0 (or validate `> 0` client-side).

- [ ] **Currency free-text class: multiple surfaces let malformed currency codes reach a raw 400/500** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - AddAccountDialog: `<3` letters/digits → `accountService.js:48-51` `^[A-Z]{3}$` raw 400 (`AddAccountDialog.tsx:194-199`; the `|| "EUR"` at `:101` rescues empty only). Transaction PATCH: free text, no check either side in code (`TransactionInfoDialog.tsx:78-79,158`) — the 0046 DB CHECK turns `"euro"`/`"€"` into a raw 500. `AddTransactionDialog.tsx:119` `maxLength={10}` vs `transactions.currency` VARCHAR(3) (`0001_initial_database_schema.py:190`) + ISO CHECK (`0046_currency_integrity.py:65`) → 4-10 chars = PG 22001/CHECK 500.
  - Fix: validate ISO-4217 client-side (regex or a fixed currency list) before submit on all three surfaces.

- [ ] **Watchlist target price: 0 accepted end-to-end, `1e15` → NUMERIC(18,6) overflow 500, `1e999` silently saves 0** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - No max client-side (`AddToWatchlistDialog.tsx:276-284`, `WatchlistChartDialog.tsx:165-172`) or server-side (`watchlist.js:20-24`, `min: 0` inclusive — a 0 alert target is meaningless for the at/below check `WatchlistPage.tsx:149-150`); column `0001…py:542` caps ~1e12; `1e999` → `Infinity` → `parseDecimal` fallback 0 → PATCH sets 0 with a success toast (`lib/decimal.ts:13-17`, `WatchlistChartDialog.tsx:95`). Negative target: frontend allows it, backend 400s.
  - Fix: reject `≤0` and cap at the column's max both sides; reject non-finite instead of falling back to 0.

- [ ] **Investments API hygiene: unknown asset_class 500s, symbol uniqueness only enforced on update, empty-name Save silently no-ops** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - Unknown `asset_class` → plain `Error` → 500 not 400 (`investmentRepository.js:220`; legacy view-schema installs insert arbitrary classes `:476-509`). Symbol uniqueness + trim/uppercase normalization enforced on **update only** (`:537-541` vs create `:417`; no DB unique index on symbol; `EditInvestmentDialog.tsx:94` uppercases, `AddInvestmentDialog.tsx:79` doesn't — compounds the filed duplicate-on-retry bug). Empty-name Save silently no-ops (`EditInvestmentDialog.tsx:85` bare `return`, no feedback; backend would accept `''` — `investmentRepository.js:95-110` has no non-empty check).
  - Fix: validate `asset_class` against the enum before insert (400 not 500), apply the same normalization at create time as update, and give empty-name Save an explicit rejection with feedback.

- [ ] **Negative CSV skipRows → raw 500** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `PortfolioImportPage.tsx:211-217` (`min="0"` attr only; `parseInt || 0` keeps negatives) and `portfolioImportRoutes.js:100`; csv-parse throws `Invalid Option: from must be a positive integer` (verified by executing csv-parse).
  - Fix: clamp to `Math.max(0, n)` client-side and/or validate server-side before passing to csv-parse.

- [ ] **Backend has ZERO length validation anywhere — `sanitizeString` is dead code** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `middleware/validation.js:78` `sanitizeString` has no call sites (`validateDateString` likewise dead) — an intended-but-unwired sanitization layer; the only real protection is frontend `maxLength` + the DB column width. Real exposure is narrow (core text columns are TEXT): `manual_raw_transactions.bank_account` VARCHAR(100) (`0001:431`) — frontend cap is exact-match, so an API-length overflow 500s the raw-mirror insert *after* the main insert already succeeded (mid-operation failure; `transactions.bank_account` is TEXT, so the sinks diverge); `watchlist.name/symbol/price_provider_id` (200/20/200, `0001:539-545`) and `investments.name` (200, `0001:473`) are provider-/market-prefilled — HTML `maxLength` doesn't clamp programmatic values.
  - Fix: wire `sanitizeString`/`validateDateString` into the routes they were built for, or delete them if genuinely superseded.

- [ ] **No upper bound on any money input; backend `validateNumber` passes `Infinity` through** ⬇
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - `1e15` is typeable in every number field (no `max` anywhere; PG14+ NUMERIC even accepts `Infinity` on the unchecked investments path); `middleware/validation.js:87-96` defaults `max = Infinity`, and `Infinity > Infinity` is false, so a JSON `"Infinity"` passes every no-max call-site and then 500s at the DB. API-only siblings: negative fees/taxes accepted (`portfolioTxRepo.common.js:155-234` — fees/taxes unchecked except gift; the final dividend/interest/fee/tax/rent branch accepts `amount ≤ 0`).
  - Fix: add a sane upper bound to `validateNumber`'s default and to money fields specifically.

- [ ] **nl semantic lows: several small meaning/consistency issues beyond the 218 financial-term keys** ⬇
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - Restore flow asks for a "wachtwoord" where backup set a "wachtzin" (same secret, two different names, in a security-critical flow: `settings.restore.passphrase*` vs `settings.backup.passphrase.*`) · `importReview.toast.persistDefaultFailed` "Standaard ontvanger opslaan mislukt" — wrong referent (reads "failed to save the default recipient"; sibling `importReview.persistDefault` gets it right) · `recurring.loading` "Terugkerende detectie" (modifier on the wrong noun) · `transactions.memo` "Omschrijving" collides with the Description label (also "Omschrijving") · `dashboard.greetingAfternoon` "Goedenmiddag" should be "Goedemiddag".
  - Fix: correct each string; unify the backup/restore passphrase terminology first (security-critical UX).

- [ ] **Backlog batch: assorted low-severity validation/consistency gaps across planned/portfolio-tx/splits/watchlist/accounts/tax** ⏬
  - ↪ _from: Correctness research 2026-07-02 · Wave 2a (residue, closed 2026-07-03)_
  - Planned: API-only `is_recurring:true` without a pattern stores and is perpetually due after execution (`plannedTransactions.js:211` guard fires only when a pattern is present; `recurrence.js:55`) · `reminder_days_before` creatable + returned but missing from the PATCH whitelist → updates silently dropped (`validation.js:26-33`) · zero/absurd amounts end-to-end (`PlannedPaymentForm.tsx:58` blocks only empty; `plannedTransactions.js:181` null-check only; zero at least excluded from auto-match, `plannedMatchService.js:63`).
  - Portfolio-tx: `type`/`currency`/`recurrence_interval` have no backend whitelist or DB CHECK (`type:'banana'` inserts and is invisible to units replay, `common.js:222-266`) · recurrence fields are stored-but-inert metadata — grep finds NO backend consumer of `is_recurring`/`recurrence_interval`/`recurrence_end_date` for portfolio txns (verify "badge-only" is the intended design before filing more; `end < start` also unvalidated but inert) · turning recurrence off leaves stale interval/end-date stored (`EditPortfolioTxnDialog.tsx:153-155`).
  - Splits (API-only; UI pre-filters): `/batch` silently drops malformed rows, all-dropped → 201 `{total: 0}` instead of 400 (`routes/splits.js:43-51`, `splitRepository.js:121`) · `transaction_id`/`recipient_id` truthiness-checked only → pg FK/type 500s (`splits.js:87-108`; contrast `/pay`'s own numeric validation `:136-138`).
  - Watchlist: PATCH accepts `name:''`; `added_price` passes PATCH validation but isn't in the update allowed-list — dead validation, silently ignored (`watchlist.js:26-30` vs `watchlistRepository.js:80`).
  - Accounts: `statement_balance` storable without `statement_balance_date` (ADR-094 drift badge then anchors to an undated figure; `accountService.js:80-98`) and unbounded.
  - Tax dialog: `mortgageStartYear` unbounded (downstream clamps degrade to "new loan", `pit.ts:195,209`) · final Save sets `profileConfigured: true` unconditionally (`TaxProfileDialog.tsx:102-110`; transient-session only).
  - CSV mapper: the same CSV column is selectable for multiple fields → plausible-valid corruption (amount also mapped to fees → every row `fees = amount`; `PortfolioCsvColumnMapper.tsx:104-126`).
  - `balance` still in the frontend update type + sent by `handleUpdate` while the backend deliberately drops it (`types/api.ts:216`, `TransactionsPage.tsx:284`, `validation.js:11-17`) · inline amount-clear `parseDecimal("") → 0` saves a legit-looking 0.00 (`VirtualDataTable.tsx:756-757`).
  - nl cosmetics: accounts merge "samengevoegd met" loses into-directionality (mergeWarning restores it) · casing drift (`dashboard.accounts`, `settings.app.current`, `transactions.total`, rows/rijen, `recurring.avgAmount`) · "Annuitaire lening" → "Annuïtair" + suffix inconsistency vs siblings · onboarding calques ("Laten we u instellen", "financiebeheerder") · Investeringen/Beleggingen + begunstigden/ontvangers + bronaccount/rekening + u/je terminology drift · `settings.numberFormat.us` "(Amerikaans)" drops UK · `planned.detectedDescription` copies `recurring.description` instead of translating its own en sentence.
  - Fix: low-priority sweep — batch these into a single cleanup pass rather than fixing individually.

- [ ] **Restore runs psql without `-v ON_ERROR_STOP=1` — a partial/corrupt dump restores partially and reports SUCCESS after the old DB was already dropped** 🔺
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b (residue, closed 2026-07-03)_
  - Both restore paths: bundle restore `packaging/electron/main.js:2335-2336` and plain-SQL `runRestore` `:2541-2545`. psql's default is continue-on-error + exit 0, so a truncated dump file, an encoding hiccup, or any per-statement failure yields a silently partial financial database; the preceding `DROP DATABASE`/`CREATE DATABASE` (`:2296-2307`, `:2492-2503`) has already destroyed the original.
  - Fix: add `-v ON_ERROR_STOP=1` (psql then exits 3 on first error and the existing nonzero-exit rejection at `:2343-2346`/`:2554-2557` fires); consider `--single-transaction` too.
  - Not reproduced against a live stack — a demo-app restore of a deliberately truncated dump would confirm the exact failure mode before fixing.

- [ ] **`cost_basis_method` is a dead settings key — the Settings→cost-basis choice never reaches the backend** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b (residue, closed 2026-07-03)_
  - `portfolioSummaryService.js:37` reads top-level key `cost_basis_method` (route validates it `routes/settings.js:198-202`, defaults it `:171`), but NOTHING ever writes it: the frontend persists the user's choice inside the `app_settings` blob instead (`BehaviorSection.tsx:56-57` → `appSettings.costBasisMethod`; zero frontend references to the string `'cost_basis_method'`).
  - Every server-computed surface is therefore permanently `weighted_avg` — including the Portfolio overview headline totals (`PortfolioOverviewPage.tsx:69-80` takes totalGain/unrealized/realized from `/api/info/portfolio-summary` as "source of truth"), performance snapshots, cross-workspace AI data, and research projections — while client-side surfaces honor FIFO/LIFO (`useAccountPositions.ts:91`, `useAccountNetWorth.ts:40`, `CloseAccountDialog.tsx:66`). A FIFO/LIFO user sees method-inconsistent gain/loss between the overview headline and account views.
  - Fix: either save the top-level `cost_basis_method` key from `BehaviorSection`, or make the backend read `app_settings.costBasisMethod` instead. Not reproduced live — a demo-app FIFO toggle compared against `/api/info/portfolio-summary` would confirm the divergence before fixing.

- [ ] **Plain `.sql` restore has NO newer-schema guard** ⏫
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b (residue, closed 2026-07-03)_
  - The bundle restore path blocks newer bundles (`main.js:2272-2283` via `metadata.schemaHead`) but `runRestore` (`:2456+`) restores any plain dump; a dump taken on a newer install restores cleanly at the psql level, then boot-time `alembic upgrade head` hits the unknown revision → the backend crash-loops with no user-facing message.
  - Fix: parse the dump's `alembic_version` COPY line, or call `getSchemaHead` on the just-restored DB before restarting the app, and reject/warn on a newer schema the same way the bundle path does.

- [ ] **`PUT /api/settings/dashboard_settings` with `value: null` → 500 instead of 400** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b (residue, closed 2026-07-03)_
  - `assertDashboardSettingsValue` (`routes/settings.js:57-60`) checks `typeof value !== 'object' || Array.isArray(value)` but not `null` (the theme validator at `:33` does it right); `null.excludedCategoryIds` throws a TypeError.
  - Fix: add an explicit `value === null` check alongside the existing type/array checks.

- [ ] **Settings write route validates only 5 keys — every other settings key accepts arbitrary JSON** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b (residue, closed 2026-07-03)_
  - `validateSettingValue` (`routes/settings.js:190-207`) covers dashboard/theme/cost-basis/includeTransfers/rebalance_plans; `app_settings`, `backup_settings`, `widget_visibility`, `onboarding_complete`, tax-profile blobs, and ANY unknown key accept arbitrary JSON (≤1MB body, key ≤100 chars, unbounded key count).
  - No backend consumer ingests settings into SQL/math unguarded (`plannedMatchService.js:92-95` tolerant, `portfolioSummaryService` set-membership, `getIncludeTransfers === true`), so exposure today is garbage-in for frontend blobs (e.g. `defaultPageSize:"abc"` survives the `migrateAppSettings` spread) — low severity on a single-user install, but the Belgian-tax-profile finding above shows the concrete cost when a settings blob DOES feed real math.
  - Fix: not urgent on its own (see the tax-profile finding for the concrete instance worth prioritizing); consider a per-key Zod schema registry longer-term.

- [ ] **`includeTransfers` missing from `SETTING_DEFAULTS`** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b (residue, closed 2026-07-03)_
  - `routes/settings.js:143-173` — `GET /api/settings/includeTransfers` 404s until the first toggle; `StatisticsSection.tsx:35-47` happens to treat the query error as `false` (matches the intended backend default), but react-query fires and retries a failing request on every settings visit.
  - Fix: add `includeTransfers` to the `SETTING_DEFAULTS` map.

- [ ] **Admin DB editor can store jsonb number `1`/`0` for `includeTransfers`; string-`"true"` storage is otherwise closed off on all paths** ⬇
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b (residue, closed 2026-07-03)_
  - A jsonb number `1`/`0` stored via the admin DB editor makes `getIncludeTransfers` (`infoRepositoryHelpers.js:19` `=== true`) silently read `false` — conservative direction, and the UI toggle agrees, so this is low severity. The resume question this closes ("can a jsonb string `"true"` be stored and silently misread?") is answered NO on every other path: the API validates boolean on single+bulk PUT (`settings.js:203-205,230-232`), restore preserves jsonb types, db-editor text params are jsonb-parsed by pg (`'true'` → boolean), and a jsonb-string `"true"` self-heals on read via `settingsRepository.get:39-41`'s JSON.parse normalization.
  - Fix: optional — reject non-boolean jsonb for `includeTransfers` in the admin DB editor's write path too, for consistency.

- [ ] **`settingsRepository.get`'s JSON.parse-on-string normalization type-flips any legit string value that happens to parse as JSON** ⬇
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b (residue, closed 2026-07-03)_
  - `settingsRepository.js:39-43,53-55`: a stored string `"123"` reads back as the number `123`, `"true"` reads back as the boolean `true`. No current key stores such strings, so this is a latent trap for any future string-valued setting rather than a live bug.
  - Fix: scope the JSON.parse normalization to known non-string-valued keys, or drop it in favor of explicit typing per key.

- [ ] **Backend/frontend settings default-copy drift (shape only, no value mismatches)** ⬇
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b (residue, closed 2026-07-03)_
  - `SETTING_DEFAULTS.app_settings` (`routes/settings.js:146-155`) lacks `costBasisMethod`/`adminMode`/`visualEffects`/`autoAdaptDisplay`/`startupSection`/`colorblindGainLoss`; `dashboard_settings`'s default lacks `exclusionScope`. Harmless today because the frontend merges over its own defaults (`settingsStore.ts:93-133`, `SettingsContext.tsx:53`), but any new non-frontend consumer of the GET default would inherit the gap.
  - Fix: keep `SETTING_DEFAULTS` in sync with the frontend default shapes as new settings keys are added.

- [ ] **Unknown attachment extension bypasses the extension-vs-content-type match** ⬇
  - ↪ _from: Correctness research 2026-07-02 · Wave 2b (residue, closed 2026-07-03)_
  - `attachmentService.js:52-56`: `extensionMime('.exe')` → `undefined` → the check is skipped. A valid PNG named `x.exe` stores as `uuid.exe`; the served MIME is the sniffed one, so the practical effect is cosmetic (filename extension only), not a content-type confusion.
  - Fix: treat an unrecognized extension as a mismatch (reject or normalize) rather than skipping the check.

- [ ] **0052 migration downgrade is broken on legacy inheritance installs** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c (residue, closed 2026-07-03)_
  - `alembic/versions/0052_portfolio_transactions_account_id.py:93-110` runs `CREATE OR REPLACE VIEW portfolio_transactions` with the `account_id` column *removed* (`_VIEW_WITHOUT_ACCT`, `:66`); PostgreSQL cannot drop columns via `CREATE OR REPLACE VIEW` (42P16 "cannot drop columns from view"), so the downgrade aborts on exactly the schema shape the migration was written to support. The flat-schema branch downgrades fine.
  - Loud failure, atomic (alembic per-migration transaction) — no partial state. Not reproduced against a scratch DB (a `upgrade head` → seed the legacy-inheritance schema → `downgrade -N` run would confirm the 42P16 before fixing).
  - Fix: use `DROP VIEW` + `CREATE VIEW` instead of `CREATE OR REPLACE VIEW` in the downgrade.

- [ ] **0053 migration downgrade aborts on any DB containing trade cash legs** 🔽
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c (residue, closed 2026-07-03)_
  - `alembic/versions/0053_trade_cash_legs.py:59-70` re-adds `ck_transactions_transfer_source CHECK (... IN ('auto','manual'))` as a plain (validating) constraint while rows with `transfer_source='trade'` (every ADR-090 trade leg) still exist → `ADD CONSTRAINT` fails, downgrade aborts.
  - A faithful downgrade must first neutralize/delete trade legs (they also lose their `portfolio_transaction_id` link in the same migration) or re-add the CHECK `NOT VALID`. Loud failure, atomic. Not reproduced against a scratch DB (seed a trade leg, then `downgrade -N`, would confirm before fixing).
  - Fix: re-add the CHECK as `NOT VALID` in the downgrade, or neutralize trade-leg rows first.

- [ ] **0045 migration downgrade silently corrupts `agg_recipient_totals` on DBs with marked transfers** ⬇
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c (residue, closed 2026-07-03)_
  - `alembic/versions/0045_exclude_transfers_from_aggregations.py:83-118` restores the pre-transfer trigger function (byte-identical to 0035's, verified) but never re-adds the transfer rows that were *subtracted* from the aggregate while 0045+ was live; worse, the first UPDATE of a former-transfer row under the restored function subtracts an OLD amount that was never counted → negative drift. No reseed path exists anywhere (`agg_recipient_totals` is trigger-maintained only, `services/aggregationRefresh.js:27-30`).
  - Implausible path (requires a multi-step downgrade past 0045), silent when hit.
  - Fix: document as a known downgrade limitation, or add a reseed step to the 0045 downgrade that recomputes the aggregate from scratch.

- [ ] **0049 migration's `VALIDATE CONSTRAINT` is boot-blocking on a legacy DB with un-normalisable currency codes** ⬇
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c (residue, closed 2026-07-03)_
  - Migrations fail-fast on boot (`apps/node-backend/src/main.js:450`), so a `VALIDATE CONSTRAINT` failure (values like `'EURO'`/`''` that trim+upper can't fix, `0049_validate_currency_checks.py:63-71`) leaves an Electron end-user at the error page with manual-psql-only recovery (documented in the migration's own docstring, but no guided UX). Hypothetical — this user's own DB was audited clean on 2026-06-25.
  - Fix: add a guided-recovery path in the Electron error page for this specific failure mode, or a pre-migration currency-code sanity check with a clearer message.

- [ ] **0050 migration's account-currency backfill ignores `planned_transactions`** ⬇
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c (residue, closed 2026-07-03)_
  - `alembic/versions/0050_add_accounts_entity.py:150-161` copies each account's currency from its most recent row in `transactions` only; an account that exists solely via `planned_transactions` strings keeps the `'EUR'` default even when its planned rows carry another valid ISO code.
  - Cosmetic-scale (currency is display metadata at that layer).
  - Fix: extend the backfill query to also consider `planned_transactions` rows when `transactions` has none for the account.

- [ ] **Demo build's shell-update check is not `__IS_DEMO`-gated** ⬇
  - ↪ _from: Correctness research 2026-07-02 · Wave 2c (residue, closed 2026-07-03)_
  - `packaging/electron/main.js:1886` (`checkForShellUpdate`) / `:1910` (install) run in the demo build too — `__IS_DEMO` is only used for name/userData at `:80-116` — so once a newer real release is tagged, **Vision Demo** offers to download/install the real Vision shell ZIP over itself.
  - Demo-only, self-inflicted-update quirk.
  - Fix: gate the update-check/install IPC surface behind `!__IS_DEMO`.

### ⚡ Performance

- [ ] **migrate.js's 120s execFile hard-kill + single-transaction alembic chain → a >120s upgrade migration rolls back entirely and re-runs identically on every boot, forever** 🔺
  - ↪ _from: Performance research 2026-07-09 · Wave F1 (migration-at-upgrade boot cost — first-ever audit of the pending-migration boot path; spot-verified: timeout, env.py single txn, and poll budgets confirmed by hand)_
  - `apps/node-backend/src/database/migrate.js:17` (`DEFAULT_TIMEOUT_MS = 120_000`, no override at `main.js:450`), spawn at `migrate.js:211-220`; `alembic/env.py:128` wraps `context.run_migrations()` in ONE `begin_transaction()` with no `transaction_per_migration`, so the whole pending chain is a single Postgres transaction
  - If cumulative migration work on a large install (years of `transactions`, multi-GB `asset_price_history`, never-pruned staging tables) exceeds 120s, `execFile` SIGTERMs alembic, Postgres rolls the entire chain back, `alembic_version` is unchanged — and the next boot re-runs the identical chain into the same wall. No partial progress, no degradation path: a genuinely >120s upgrade is an unrecoverable boot loop. Note the app pool's 30s `statement_timeout` (`connection.js:27`) does NOT reach the separate alembic process — the 120s execFile cap is the sole limiter.
  - Fix: raise/remove the alembic execFile timeout (boot migration, not a query), and set `transaction_per_migration=True` in `env.py` so each migration commits independently and a kill only loses the in-flight one (also unlocks `CREATE INDEX CONCURRENTLY` via autocommit blocks — see the 0050 finding below).

- [ ] **Packaged app-update boots get only the 60s Electron poll budget — a long migration fires the error dialog + error page while alembic is still working, and nothing re-navigates when it finishes** ⏫
  - ↪ _from: Performance research 2026-07-09 · Wave F1_
  - `packaging/electron/main.js:121-127` (`HEALTH_POLL_ATTEMPTS = 200×300ms = 60s` vs `HEALTH_POLL_BUILD_ATTEMPTS = 600`), `pollAndLoad` at `:1121-1147`, launch `:3291-3333`; `main.js:450→480` (backend awaits `runMigrations()` before `app.listen()`, so `/health` stays red throughout)
  - In packaged mode every `composeStartOrUp` path returns `built:false` (`:1287` — `!skipBuild && (!app.isPackaged || useRepoMode)`), so an image-pull update polls with the 60s budget, not the 3-minute build budget. A migration pushing backend-listen past ~56s → `pollReady` rejects → `loadErrorPage()` + blocking "taking longer than expected" dialog *mid-migration*; when alembic later finishes, nothing re-navigates (watchdog only starts after a successful `pollReady`, `:1128`) — the user is stranded on the error page until manual Retry.
  - Fix: treat "new image pulled / pending migrations" as `building`, or expose a backend "migrating" signal (splash status line) and extend the poll budget while it's set.

- [ ] **Transaction search requests are never aborted — superseded keystrokes leave the expensive OR-chain scans running to completion server-side, and nothing gates 1-character queries client-side** ⏫
  - ↪ _from: Performance research 2026-07-09 · Wave F3 (frontend residues)_
  - `apps/frontend/src/features/transactions/hooks/useTransactionListData.ts:102-121` (main query), `:149-168` (loadMore) — `queryFn` never receives/forwards React Query's abort `signal`; `apps/frontend/src/lib/api/transactions.ts:16-52` (`getTransactions`) has no `signal` param even though `client.ts:229-259` fully supports `options.signal`
  - Each debounced (300ms) keystroke changes the queryKey and starts a fresh backend search; React Query drops the stale query client-side but the HTTP request is NOT aborted, so the known-unindexable OR-chain scan (see the filed ⏫ search finding) runs to completion for every intermediate term — fast typing stacks N concurrent full scans server-side, competing for the 10-connection pool. Compounding it, `VirtualDataTable.tsx:164-175` forwards ANY non-empty value with no minimum-length gate, so typing "a" issues a search matching nearly every row (the filed backend search finding already lists a server-side min-length as part of its fix — the client half is missing too).
  - Fix: thread React Query's `signal` into `queryFn` and add a `signal?: AbortSignal` param to `getTransactions` forwarded to `client.ts` (which already honors it); gate `handleSearchInput` on `value.trim().length >= 2`, resetting via `onSearchChange("")` below the threshold.

- [ ] **Migration 0050 rewrites the entire `transactions` heap (account_id backfill on every row) and builds two non-concurrent indexes on it — the most expensive migration in the recent update window** ⏫
  - ↪ _from: Performance research 2026-07-09 · Wave F1_
  - `alembic/versions/0050_add_accounts_entity.py:122-131` (3× `CREATE INDEX`, incl. partial B-tree `idx_transactions_account_date_active` over all active rows), `:167-183` (`UPDATE transactions SET account_id = a.id ... WHERE account_id IS NULL` — touches every row), `:134-164` (several full `DISTINCT`/`DISTINCT ON` scans)
  - On a 500k-row table: full heap rewrite (500k dead + 500k new tuples, full WAL, maintenance of the just-built indexes) plus two full index builds under a write-blocking lock — inside the single boot transaction of the finding above. Anyone updating from a pre-ADR-088 version crosses this.
  - Fix: batch the backfill UPDATE in id ranges; build the indexes `CONCURRENTLY` (requires `transaction_per_migration` + an autocommit block).
  - ↪ _from: UI/GPU research 2026-07-02 · Wave A_
  - `apps/frontend/src/components/ui/dialog.tsx:23,42`, `apps/frontend/src/components/ui/alert-dialog.tsx:20,40`, `apps/frontend/src/components/ui/sheet.tsx:22,32`
  - The overlay is `fixed inset-0 backdrop-blur-md` — it re-blurs the entire viewport (which already contains 10–15 blurred glass surfaces plus the animating aurora), and the modal content adds a nested 28px `glass-thick` blur sampled from that already-blurred region. Because the aurora blobs (`index.css:589,605`) never stop drifting, the whole-screen blur is recomputed every vsync for as long as any modal is open — the single most expensive standing state in the app; opening a dialog on Transactions/Portfolio is a common, long-lived action. The 420ms `dialog-in` scale animation additionally forces the content blur to re-sample at a new geometry each frame.
  - Fix: replace overlay `backdrop-blur-md` with a plain `bg-background/60` dim (or blur only at the enhanced fx tier), and/or pause aurora drift (`animation-play-state: paused` on `.liquid-canvas::before/::after`) while a modal overlay is mounted.

- [ ] **Demo compose db healthcheck lacks `start_interval` — ~5s of pure idle on every demo warm boot (83% of the measured 6.8s total)** ⏫ 📏 *(measured live — demo shell only; the real .app has no `depends_on` and dodges the 5s)*
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S1 (live instrumented boot, demo app)_
  - `packaging/electron/resources-demo/docker-compose.yml:20-25` (db healthcheck + `depends_on: service_healthy`), mirrored in the installed `~/Library/Application Support/Vision Demo/embedded_compose/docker-compose.yml`
  - Measured (3 warm runs): Postgres accepts connections ~100ms after container start, but Docker's first health probe fires only at +5.0s — with `start_period` set but no `start_interval`, probes during the start period run at the `start-interval` **default of 5s** (the `interval: 3s` doesn't apply yet) — so `depends_on: service_healthy` holds the app container until +5.6s; `compose_up` = 5.9s of a 6.8s warm boot, all idle. Verified by hand: bare `docker compose start` = 5.8s; `docker events` shows db `start` +0.18s → first health exec +5.18s → healthy +5.25s → app start +5.80s.
  - Fix: add `start_interval: 250ms` to the db healthcheck (Docker Engine 25+) — projected demo warm boot ~2.0s instead of ~6.8s. Do NOT remove `service_healthy` here: the compose file's comment documents a real crash-loop edge case (db image rebuild → new IP) it guards against. The real app's composes (`packaging/electron/resources/docker-compose.yml`, root `docker-compose.yml:61-73`) deliberately have no `depends_on`, so they don't pay this — but their healthcheck stanzas (root `:12-19`) should gain `start_interval` too for anything that consumes health status.

- [ ] **Portfolio CSV-import commit loop has no transaction batching — 4-6+ sequential round trips per row** ⏫ 🔎 verified-present 2026-07-11
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
  - 📏 **Behavior confirmed live (2026-07-06, Wave D2):** plan is `Limit 10000` directly above an *unordered* Bitmap Heap Scan (via `idx_transaction_date_recipient`) — past 10k rows in the window the dropped rows are arbitrary heap order, as claimed.

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

- [ ] **Free-text transaction search is a 15-branch cross-join OR chain that structurally cannot use the pg_trgm indexes that exist for exactly this purpose** ⏫
  - ↪ _from: Performance research 2026-07-05 · Wave P1 (backend query paths)_
  - `apps/node-backend/src/services/filterBuilder.js:174-203`, `apps/node-backend/src/routes/transactions.js:94`, `alembic/versions/0001_initial_database_schema.py:688-712`
  - `search` emits one `%term%` ILIKE OR-chain spanning `t.memo/comment/bank_account/currency`, `CAST(t.amount AS TEXT)`, `CAST(t.date AS TEXT)`, plus columns of 5 LEFT-JOINed relations plus a correlated tag-EXISTS with `tg.slug ILIKE`. GIN trgm indexes exist (`idx_transactions_memo_trgm`, `idx_transactions_comment_trgm`, `idx_recipients_name_trgm` — 0001:688,711,712, never dropped) but the planner can't push an OR referencing joined relations down to any scan, so every search is a full seq scan of transactions + all 5 joins + per-row amount/date casts + per-row tag probe. The import pipeline gets index-served pg_trgm matching (`services/calculations/normalization.js`); the interactive path does not. The route enforces only a 200-char max — a 1-character search matches nearly every row at full cost; exports and bulk-selection filters forward `search` too (`bulkSelection.js`).
  - Fix: restructure as a UNION/`t.id IN (…)` of per-relation indexable branches (memo/comment/recipient-name via trgm, tags via slug lookup → junction), gate the amount/date CAST branches on numeric/date-shaped input, and enforce a minimum search length (2-3 chars).
  - 📏 **Verdict CONFIRMED structural (2026-07-06, Wave D2 live EXPLAIN, demo DB):** with `enable_seqscan=off` the OR is applied as a post-join `Filter` (Rows Removed: 992); no trgm index ever gets an `Index Cond`. Control: an isolated `memo ILIKE '%Loon%'` DOES hit `idx_transactions_memo_trgm` (Bitmap Index Scan, Index Cond) — the UNION-restructure fix direction is capability-proven. Benefit at real scale not measurable on the 1,051-row demo corpus.

- [ ] **Bank-transaction CSV import commit issues exactly 5 sequential statements per row inside its transaction chunks** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/importPipeline/commit.js:79-213`
  - Chunking (1000 rows/txn) amortizes BEGIN/COMMIT but not per-row round trips: dup-check SELECT, SAVEPOINT, single-row INSERT, staging UPDATE, RELEASE SAVEPOINT = 5 statements, confirmed exact. A 2,000-row CSV (the most common operation in the app) issues ~10,000 sequential statements.
  - Fix: pre-load existing rows for the chunk's date range once, dedupe in JS, bulk-insert via `INSERT...SELECT UNNEST(...) ON CONFLICT DO NOTHING` (pattern already proven in `importPipeline/match.js:88-94`).

- [ ] **Default (magnitude) amount filter can't use the existing amount index — the index predates and is unrelated to the amount_signed feature** 🔼 🔧 *(provenance corrected)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/filterBuilder.js:142` — `amountSigned ? 't.amount' : 'ABS(t.amount)'`; the only amount index (`idx_transactions_amount_date`, `alembic/versions/0044_add_transfer_pairing.py:63`) is a plain btree that can't service the `ABS()` expression in the **default**/legacy magnitude-filter mode (likely the more common one), forcing a sequential scan when not narrowed by other indexed predicates.
  - Fix: add `CREATE INDEX ON transactions (ABS(amount), date)` if amount-only filtering proves hot; otherwise document as accepted given typical co-filtering by date/category.
  - Verification (2026-06-30): the index's provenance was backwards in the original write-up — migration 0044 (2026-06-18) was added for transfer-pairing matching (ADR-083), **10 days before** the `amount_signed` filter feature (commit `eff2da4f`, 2026-06-28). The signed-filter feature didn't add this index; it just happened to be able to reuse a pre-existing one, leaving the older/more-common default path with no usable index — same conclusion, different (correct) history.
  - 📏 **Verdict CONFIRMED structural (2026-07-06, Wave D2 live EXPLAIN):** seqscan-off leaves `abs(amount) >= 100` as a Filter (Rows Removed: 756); control `t.amount >= 100` gets `Index Cond` on `idx_transactions_amount_date`. The signed path (`amountSigned=true`) correctly uses the index.

- [ ] **JS-side aggregation regression in category-breakdown live fallback** 🔼 🔎 verified-present 2026-07-11
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

- [ ] **Portfolio import rollback is a per-row DELETE loop — no `import_batch_id` column on portfolio transaction tables** 🔼 🔎 verified-present 2026-07-11 *(schema gap also blocking the cash-leg cleanup fix above)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/portfolioImportBatchService.js:65-76`, `apps/node-backend/src/repositories/portfolioTxRepo.writes.js:190-207`
  - Bank-import rollback is one `DELETE ... WHERE import_batch_id = $1`; no migration ever added the equivalent column to the portfolio transaction tables (confirmed: `import_batch_id` exists only on `transactions`, added by `0003_import_batch_id_on_transactions.py` — never on `portfolio_transactions`/`portfolio_transactions_base`, including in the later `0052_portfolio_transactions_account_id.py` which touched the same tables for a different column). Rollback instead calls `hardDelete(id)` once per row.
  - Fix: add an `import_batch_id` column (+ index) to the portfolio transaction tables for a single bulk DELETE; short-term, batch with `WHERE id = ANY($1::int[])` and call `deleteTradeCashLegs` in the same pass (fixes the orphaned-cash-leg correctness bug above too).

- [ ] **`refreshPrices` issues one UPDATE per investment instead of a single batched upsert** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/controllers/investmentController.js:257-301`
  - Uses bounded concurrency (10) but still N round trips where one `UNNEST`-based batch UPDATE (pattern already used in `priceCache.js:saveHistoricalPointsToDatabase:250-258`) would do it in one statement.
  - Fix: replace the per-investment loop with one `UPDATE ... FROM (SELECT * FROM UNNEST(...))` statement.

- [ ] **Unbounded, unvirtualized row rendering in portfolio import review** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/pages/portfolio/PortfolioImportReviewPage.tsx:121-176`
  - Every group's rows render directly into the DOM — no collapse/accordion (unlike the sibling `ImportReviewPage`), no pagination, no virtualization. A multi-year brokerage import can produce 500-2000+ rows mounted simultaneously.
  - Fix: wrap per-group rows in a collapsible (mirror `ImportReviewPage`'s `Accordion`), or virtualize via the existing `VirtualDataTable`/`@tanstack/react-virtual`.

- [ ] **Unbounded grid of glass-blur cards on the Watchlist page** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/pages/research/WatchlistPage.tsx:145-168`
  - Each item is a full `Card` with `backdrop-filter: blur(20px) saturate(180%)` in an uncapped, unvirtualized grid — compositor cost scales linearly with item count.
  - Fix: cap/paginate past ~24 items, or use a cheaper flat surface (no `backdrop-filter`) for this dense-grid case.

- [ ] **`framer-motion` is pulled into the always-loaded app shell, not just lazy chart routes** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/components/layout/AppLayout.tsx:19,220`, `PageTransition.tsx`, `AppSidebar.tsx:68`, `components/ui/tabs.tsx:78`
  - `AppLayout` wraps every route and is statically imported, so framer-motion ships in the initial bundle regardless of route, for animations CSS transitions could likely replace. (The library's other 9 usage sites, in `components/charts/*`, are correctly confined to lazy routes.)
  - Fix: replace shell-level motion with CSS transitions, or adopt `LazyMotion`/the tree-shaken `m` API.

- [ ] **`ImportReviewPage` mounts a live, query-subscribed combobox per group unconditionally** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/pages/ImportReviewPage.tsx:320-367`
  - Each accordion group's trigger unconditionally mounts a `RecipientCombobox` regardless of expansion state (it sits in `AccordionTrigger`, not `AccordionContent`). A year of bank CSV import can produce 100-300+ groups → that many live component instances/subscriptions at once.
  - Fix: lazy-mount the combobox only when its accordion item opens, or virtualize the groups list.

- [ ] **Column-resize drag re-renders the full table on every `mousemove`, unthrottled** 🔼 🔎 verified-present 2026-07-11
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

- [ ] **Every transactions-list page load scans the entire filtered set — `COUNT(*) OVER ()` defeats LIMIT top-N even on the unfiltered default view** 🔼
  - ↪ _from: Performance research 2026-07-05 · Wave P1 (backend query paths)_
  - `apps/node-backend/src/repositories/transactionRepository.js:452-457,277-299`, `apps/node-backend/src/routes/transactions.js:243-250`
  - `getAllWithCount` appends `COUNT(*) OVER () AS total_count`, forcing full materialization of the filtered 6-way join before LIMIT/OFFSET on every page request — including page 1 of the plain unfiltered list, paid even when `include_balance=false`. Distinct from the filed OFFSET+running_balance item (keyset wouldn't remove this: the count itself is the full-set scan). `getUncategorisedWithCount` is worse: its total CTE runs a second, semantically different full count (full TRANSACTION_JOINS + list filters) alongside the uncategorised row query, per request. Growth linear in table size on the app's hottest read endpoint.
  - Fix: compute total only when `offset === 0` (or on filter change) and let the client carry it forward; alternatively cache count per filter-hash briefly. For the uncategorised path, count with the same reduced join set as the rows.
  - 📏 **Verdict CONFIRMED (2026-07-06, Wave D2 live EXPLAIN):** with `COUNT(*) OVER ()` the WindowAgg materializes all rows before Sort→Limit; removing it flips the plan to a pipelined Nested Loop + Memoize over `idx_transactions_active` that stops at 50 rows (rows=50 at every node). Plan-flip demonstrated even at demo scale.

- [ ] **Category filter wraps `category_id` in cross-table COALESCE, making all four category indexes on transactions unusable** 🔼
  - ↪ _from: Performance research 2026-07-05 · Wave P1 (backend query paths)_
  - `apps/node-backend/src/services/filterBuilder.js:122-136` (categoryId/categoryIds), `:258-264` (exclusion NOT IN, same shape), `alembic/versions/0001_initial_database_schema.py:699,705,708,710`
  - `COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = $/IN (…)` requires joining every transaction to recipients before the predicate can be evaluated, so `idx_transactions_category_id` / `category_date` / `category_date_active` / `category_recipient_active` never serve a category-filtered list or aggregation — always a full scan+join. Same shape in the exclusion clauses used by dashboard/info queries (the NULL-drop correctness bug there is already filed; this is the separate index-defeat aspect). Manifests on every category drill-down; linear growth.
  - Fix: rewrite as an indexable disjunction of semi-joins (`t.category_id = $ OR (t.category_id IS NULL AND t.recipient_id IN (SELECT … WHERE effective default = $))` — the recipient-id list is small and probes `idx_transactions_recipient_id`), or precompute an `effective_category_id` column maintained by the existing trigger machinery.
  - 📏 **Verdict CONFIRMED structural (2026-07-06, Wave D2 live EXPLAIN):** seqscan-off still evaluates the COALESCE as a top-join Filter (Rows Removed: 1021); control `t.category_id = 10` gets a real `Index Cond` on `idx_transactions_category_recipient_active`.

- [ ] **`recipientId`/`recipientGroupId` filters OR across two tables, defeating `idx_transactions_recipient_id`** 🔼
  - ↪ _from: Performance research 2026-07-05 · Wave P1 (backend query paths)_
  - `apps/node-backend/src/services/filterBuilder.js:151-169`
  - `(t.recipient_id = $ OR r.primary_recipient_id = $)` (and the 4-branch recipientGroupId variant) reference both the base table and the joined recipients row, so no BitmapOr on transactions is possible — every recipient drill-down scans and joins the full transactions table despite indexes existing on both columns individually. The equivalent set of matching recipient ids is tiny and resolvable from recipients alone.
  - Fix: rewrite as `t.recipient_id IN (SELECT id FROM recipients WHERE id = $ OR primary_recipient_id = $ [OR …group branches])` — a small semi-join that probes `idx_transactions_recipient_id` / `idx_transactions_recipient_date_active`.
  - 📏 **Verdict CONFIRMED structural (2026-07-06, Wave D2 live EXPLAIN):** seqscan-off evaluates the OR as a join Filter (Rows Removed: 1021); recipient indexes never get an `Index Cond`.

- [ ] **`LanguageBridge` recreates `setLanguage` every render, so ANY app-settings change re-publishes the LanguageContext value and re-renders every `useLanguage` consumer app-wide** 🔼
  - ↪ _from: Performance research 2026-07-05 · Wave P3 (frontend state/i18n runtime)_
  - `apps/frontend/src/App.tsx:115-133` (`setLanguage` is a fresh arrow at :118), `apps/frontend/src/contexts/LanguageContext.tsx:130-133` (`value` memo deps include `setLanguage`), `apps/frontend/src/components/layout/AppLayout.tsx:231` (settings render as a Dialog over the live page), `components/settings/sections/GeneralSection.tsx:43-109` + `BehaviorSection.tsx:41,57` + `AppearanceSection.tsx:213` (per-toggle `updateAppSettings` calls)
  - `updateAppSettings` replaces the whole `appSettings` object, so `LanguageBridge` (subscribed via `useAppSettings`) re-renders on every settings change — including keys unrelated to language (decimals, startup section, AI model, colorblind toggle). Each re-render mints a new `setLanguage` identity, invalidating the `useMemo`'d context value and forcing every `useLanguage` consumer (virtually every text-bearing component) to re-render. Because settings is a modal over the mounted page, each toggle re-renders the full page + shell behind the dialog. `t`/`tc` themselves are stable — the unstable arrow is the sole leak. (TODO's existing LanguageBridge item files it as a naming/altitude issue only — this is the separate perf leak.)
  - Fix: `const setLanguage = useCallback((lang) => updateAppSettings({ language: lang }), [updateAppSettings])` in `LanguageBridge` (the zustand action is referentially stable), or select `language` straight from the store inside LanguageProvider.

- [ ] **First navigation is gated on a full materialized-view refresh every boot, even when the MVs are already fresh — refresh duration is added serially to splash time ahead of SPA load** 🔼
  - ↪ _from: Performance research 2026-07-05 · Wave P4 (boot latency)_
  - `packaging/electron/main.js:1022-1065` (pingReady/pollReady), `:1121-1126` (pollAndLoad navigates only after ready); `apps/node-backend/src/main.js:234-235,279` (`caches.materializedViews` = warmup settled); `apps/node-backend/src/startup/warmup.js:202-207`; `apps/node-backend/src/services/materializedViewService.js:171-209`
  - The Electron shell refuses to `loadURL(APP_URL)` until `/health/detailed` reports `caches.materializedViews === true`, which only flips when `refreshMaterializedViews()` (4× `REFRESH … CONCURRENTLY`, deliberately the slower concurrent form) settles post-listen. MVs persist in Postgres and data only changes through the app, so on every normal warm boot they are already fresh from the previous session — yet the gate serializes refresh-duration (est. 0.3-2s on a grown DB, plus ≤300ms poll quantization) *before* SPA bundle fetch/parse/settings fetch, which could fully overlap it. First-ever boot is worse: CONCURRENTLY fails on unpopulated views and retries non-concurrently (two serial attempts, materializedViewService.js:185-199). The empty-dashboard problem the gate solves only exists when views were never populated.
  - Fix: gate on "populated" instead of "refreshed this boot" — e.g. backend reports `pg_matviews.ispopulated` (instant query) as the readiness key, or Electron navigates on plain `/health` and the refresh overlaps SPA load; keep the strict gate only for the first-run/unpopulated case.
  - **📏 Measured 2026-07-05 (Wave S1, demo app, 31 months data): 33–38ms gate cost, not 0.3-2s — recommend CLOSING as "keep the gate, cost negligible".** A 25ms-resolution poller saw `caches.materializedViews:true` 33–38ms after the first HTTP response in all three warm runs; backend logs "Materialized views refreshed in 31ms". Even at the real DB's ~4× data scale this projects well under the Electron 100ms poll quantum. The gate buys a guaranteed non-empty first dashboard paint for ~0 cost. (Caveat: demo DB is ~¼ of the real month span — re-check only if a real-data instrumented boot ever shows the refresh above ~200ms.)

- [ ] **Docker Desktop not running → dialog + `app.quit()`, forcing a manual relaunch instead of waiting for the daemon** 🔼
  - ↪ _from: Performance research 2026-07-05 · Wave P4 (boot latency)_
  - `packaging/electron/main.js:3263-3275` (dialog → `shell.openPath('/Applications/Docker.app')` → `app.quit()`); `:1156-1200` (cheap socket ping already available)
  - On every post-reboot launch (Docker Desktop rarely autostarts), the boot path dead-ends: the user clicks "Open Docker", Vision quits, Docker takes ~20-45s to come up, and the user must remember to relaunch Vision — and gets the same dialog again if they relaunch too early. The app already has a sub-50ms daemon probe (`pingDockerSocket`) it could poll; instead the single largest wall-clock event in the boot story requires two manual user actions.
  - Fix: after opening Docker.app, keep the splash up with a "waiting for Docker" status and poll `pingDockerSocket` (e.g. 1s cadence, 90s budget, cancel button), then continue `launch()` automatically instead of quitting.

- [ ] **Serial 2s-timeout Docker-socket probing turns a Docker-daemon wake into a multi-second `check_docker` stall on the first launch after idle** 🔼 📏 *(measured live)*
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S1 (live instrumented boot, demo app)_
  - `packaging/electron/main.js:1175-1190` (socket candidates tried serially), `:1159` (`pingDockerSocket` 2000ms timeout per candidate)
  - Measured: first launch after ~45min Docker Desktop idle (resource-saver) → `check_docker` = 2227ms; every subsequent launch = 15–21ms. Real-world launches usually happen *after* idle, so the 2.2s wake path is more representative of what the user feels than the 19ms best case — and each dead socket candidate can stack another 2s serially before the live one answers. (Attribution to daemon wake is inferred from idle time + both parallel Docker calls being uniformly slow in that run — not independently confirmed.)
  - Fix: race all socket candidates in parallel (`Promise.any`) and/or drop the per-candidate timeout to ~500ms with one retry — bounds the wake path near the daemon's actual response time instead of stacking serial timeouts.

- [ ] **Backup feature's `archiver`/`yauzl` chain (65 modules) loads at Electron module eval — ~56ms+ of the pre-splash window for functionality that only runs post-boot** 🔼
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S2 (main-process cold-start static sweep)_
  - `packaging/electron/main.js:11` (`require('./backup/bundle')` at module scope) → `packaging/electron/backup/bundle.js:23` (`require('archiver')`), `:32` (`require('yauzl')`)
  - bundle.js is only used by backup IPC handlers (main.js:2596-2747), restore, and the will-quit backup (main.js:3462) — all post-boot — yet its require pulls 65 modules (archiver → zip-stream → compress-commons → readable-stream → archiver-utils → lodash pieces, glob, cross-spawn…). Measured 56ms warm-FS-cache in plain node; inside the asar on a cold launch it's plausibly worse. That's ~15-25% of the app-controlled pre-splash time (S1 measured module eval → splash ≈ 150ms app-controlled), pure waste for boot.
  - Fix: lazy-require inside bundle.js — move the `archiver`/`yauzl` requires into the functions that use them (or a memoized `getArchiver()`), or lazy-require `./backup/bundle` at its main.js call sites. Zero behavior change; the first backup pays the 56ms instead.

- [ ] **Dashboard first-data render sits behind up to 3 serial round trips (settings → categories → aggregations), with the settings fetch itself starting only after the full boot graph executes** 🔼
  - ↪ _from: Performance research 2026-07-05 · Wave P4 (boot latency)_
  - `apps/frontend/src/contexts/SettingsPreloadContext.tsx:34-67` (fetch starts in a post-mount useEffect); `apps/frontend/src/hooks/useExcludedIds.ts:48-62,83` (`enabled: needsHidden`, `isReady = !needsHidden || categoriesQuery.isSuccess`); `apps/frontend/src/hooks/useFilteredDashboardStats.ts:53` (`enabled: isReady`)
  - The chain: index.html → boot JS parse/execute (~372 KB gz) → React mount → effect fires `GET /api/settings` → settings hydrate → (when `excludeHiddenCategories` is on) `GET /api/categories?limit=1000` becomes enabled → only then the gating dashboard query fires (internally parallel, correctly). Each hop is a full round trip that could not start earlier; alternatively when settings defaults differ from hydrated values the query fires twice (queryKey embeds the exclusion arrays). Hits every boot; skeletons do render immediately, so this is data-latency, not blank-screen.
  - Fix: kick off the `/api/settings` fetch at module scope in main.tsx (a shared promise the provider awaits) so it overlaps JS execution/mount; consider having `/api/settings` embed the hidden-category id list (or cache last-known exclusions in localStorage) to collapse the categories hop.

- [ ] **Blank "second splash": index.html has zero content between splash→SPA navigation and React mount — the splash's visual language dies mid-handoff** 🔼
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S3 (splash→SPA handoff)_
  - `apps/frontend/index.html:16-18` (`<div id="root"></div>` only, no inline placeholder), `apps/frontend/src/index.css:28-29` (body bg from the render-blocking stylesheet), `packaging/electron/main.js:1126` (`loadURL(APP_URL)`)
  - When the navigation commits, Chromium holds the splash frame until the new document's first paint; that paint is theme-correct (render-blocking CSS + theme-flash verified) but *empty* — spinner+logo → bare colored void → shell pops in after the ~372 kB gz entry graph parses and React commits.
  - Fix (visually free, likely the best handoff win): inline a static placeholder inside `#root` that mirrors the Electron splash (same spinner + wordmark, colors via `prefers-color-scheme`/theme-flash CSS vars); `createRoot(...).render()` replaces it atomically → splash → identical in-page splash → shell = perceived continuity across the whole JS-parse window. Alternative on record (main-process surgery, ~90% achieved by the placeholder anyway): keep a WebContentsView splash overlay until the existing `app:renderer-ready` signal (`ElectronBridge.tsx:102` → main.js:2817-2825) instead of navigating the splash away.

- [ ] **Locale chunk discovered late — raw i18n keys (`nav.dashboard`…) flash on every cold boot before the en dict arrives** 🔼
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S3 (SPA boot sequence)_
  - `apps/frontend/src/contexts/LanguageContext.tsx:73-97` (dict starts empty; the `en` dynamic import only starts in a post-mount `useEffect`), `:103` (`t()` falls back to the key itself)
  - The code comment claims "<1 render cycle" but shell first paint renders literal keys until the ~189 kB raw / 50 kB gz chunk fetches+parses, then everything reflows with real strings.
  - Fix: hoist the fetch to module scope (`const enPromise = englishLoader()` started at import time; the effect just awaits it) — starts the chunk request during entry execution instead of after React commit, overlapping it with mount. One-file change, zero visual cost.

- [ ] **Dutch users get a triple text flash every boot: raw keys → English → Dutch, with the nl chunk serialized behind the settings API round trip** 🔼
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S3 (SPA boot sequence)_
  - `apps/frontend/src/stores/settingsStore.ts:100` (`language: 'en'` default), `apps/frontend/src/contexts/AppSettingsContext.tsx:59-67` (language flips to `nl` only after the settings API fetch hydrates), `LanguageContext.tsx:86-97` (nl import starts only after that flip); no client-side language cache exists (grep: only `vision_theme`/`vision_theme_variant`/skin are mirrored)
  - Chain: entry JS → mount → settings HTTP round trip → language flip → nl chunk fetch → Dutch text. An nl user watches English (or raw keys) repaint to Dutch on every single boot.
  - Fix: mirror `language` to localStorage on change (same pattern as theme/skin), read it at module scope in `main.tsx`/LanguageContext, and kick off the right locale import immediately; server value still wins on hydration.

- [ ] **Hide-on-close instead of destroy — reopen becomes ~0ms with route/scroll state intact (option — user decision, recommended first; the cheapest large win of the whole pass)** 💡🔼
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S3 (architecture options)_
  - `packaging/electron/main.js:1561` (`closed` handler nulls the window — red-button close destroys the booted renderer), `:3512-3514` (`window-all-closed` no-op on darwin: app + containers + health watchdog already keep running), `:3430-3488` (only Cmd+Q reaches `will-quit` → `stopContainers`)
  - macOS close *already* keeps everything warm — the app just throws away the fully-booted renderer, so reopening re-runs the entire SPA boot against a hot backend. Standard macOS convention fixes it: `close` → `event.preventDefault(); mainWindow.hide()` unless `isQuitting` (set in `before-quit`); `activate`/`second-instance` → `show()`.
  - Trade-offs for the user: renderer RAM stays resident while hidden (containers already do — no new container cost); users who expect close-to-free-memory lose that. Settings home if made toggleable: `BehaviorSection.tsx:38-49` already hosts the startup group.

- [ ] **"Keep services running on quit" toggle — next launch takes the measured 0.6-1.1s hot path instead of ~2-2.5s warm (option — user decision)** 💡🔼
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S3 (architecture options)_
  - `packaging/electron/main.js:3479` (`will-quit` → `stopContainers`), `:1296-1298` (`compose stop`); no skip setting exists (only `backupOnQuit` — preload.js:91-97); `:1268` (all-running fast path returns immediately for packaged builds); dual-read settings pattern to copy: `:3446-3454`
  - A toggle (Electron settings.json mirror + DB, same pattern as the backup settings) that skips `stopContainers` on quit puts every next launch on the S1-measured hot path. Backup-on-quit still works since containers stay up; compose restart policy governs reboot behavior; image updates still hot-swap via the updater.
  - Trade-off for the user: idle Postgres + bun RAM while the app is "closed" (unmeasured — see residue). Settings home: `BehaviorSection.tsx:38-49` startup group, bridged main-process-side like `backup:save-settings`.

- [ ] **Packaged installs never receive Postgres minor/security updates — the updater pulls only the `app` image, so the db image is frozen at install time forever** 🔼
  - ↪ _from: DB performance research 2026-07-06 · Wave D1 (Postgres server & container config — first-ever audit)_
  - `packaging/electron/main.js:1305` (`docker compose pull app`), `:3192` (`'pull', '--quiet', 'app'`); db service has no `pull_policy` in `packaging/electron/resources/docker-compose.yml:4-18` (compose default `missing` = never re-pull once present)
  - A user who installed at PG 18.0 stays on 18.0 — missing minor-release bugfixes, security patches, and occasional perf fixes — for the lifetime of the install, on the one component holding all user data. (Demo shows 18.4 only because its image was built recently.) Not a query-speed issue today; a slow-burning currency/security gap.
  - Fix: include `db` in the update-time pull (`docker compose pull app db` at both sites). Same-major minor bumps are drop-in for Postgres (no pg_upgrade); the `postgres:18-alpine` major pin already prevents accidental major jumps.

- [ ] **Unbounded-looking report-data fetches actually are date-bounded, but still lack a defensive hard cap for pathological custom periods** 🔽 🔧 *(toned down + citation fixed)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/reports/dataFetcherTax.js:89-110`, `dataFetcherPortfolio.js:73-89`
  - Both queries are bounded by the report's date range and aggregate in JS after that — not literally unbounded. The real gap is the missing defensive LIMIT for pathological multi-year custom periods, mirroring the precedent in `infoRepo.statistics.js` (note: **not** `infoRepositoryStatistics.js`, a different, similarly-named file — the original citation was wrong).
  - Fix: add a defensive LIMIT for pathological multi-year custom periods.

- [ ] **`matchInvestments.js` resolves distinct symbol/name keys one at a time instead of batched** 🔽 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/portfolioImportPipeline/matchInvestments.js:51-67,86-106`
  - Each distinct `(symbol, name)` pair triggers up to 2 sequential SELECTs (per-key cached, but distinct keys aren't batched) — contrast with the bank pipeline's recipient resolution, which batches all distinct names into one `pg_trgm` query.
  - Fix: batch with `WHERE LOWER(symbol) = ANY($1::text[])`, then one batched query for unresolved names.

- [ ] **`GET /api/info/recurring-patterns` does uncached synchronous recomputation, including from AI chat** 🔽 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/recurringDetectionService.js:129-277`; also called from `aiChat/tools/insights.js:288`
  - Query is bounded (3 years) but the grouping/sorting/interval-detection runs synchronously on the event loop with no caching; the AI-chat tool can trigger it repeatedly within one chat session.
  - Fix: cache the result short-term (a few minutes), invalidate on transaction mutation.

- [ ] **`Card` primitive defaults every instance to the most expensive glass-blur tier** 🔽 🔎 verified-present 2026-07-11 *(root cause of the Watchlist finding above)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/components/ui/card.tsx:9`
  - Blur tier is baked unconditionally into the base `className`, with no variant prop to opt out — only an additive override is possible.
  - Fix: default `Card` to a flat surface; require an explicit `glass-*` className for hero/standalone cards.

- [ ] **`SettingsPreloadContext` provider value is an unmemoized object literal at the app root** 🔽 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `apps/frontend/src/contexts/SettingsPreloadContext.tsx:70`, used at `App.tsx:168`
  - `value={{ rawSettings, isLoading }}` is a fresh object every render in the outermost provider — the one provider not following the `useMemo` pattern used elsewhere (`LanguageContext`, `BelgianTaxProfileContext`, `PageTitleContext`).
  - Fix: `useMemo(() => ({ rawSettings, isLoading }), [rawSettings, isLoading])`.

- [ ] **Attachment thumbnails fetch full-resolution images for a 24px icon, not lazy-loaded** 🔽 🔎 verified-present 2026-07-11
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
  - Verification (2026-07-03, residue): the `combined` memo (`ChatMessageList.tsx:27-50`) keeps message object identities stable during draft streaming, so `React.memo(ChatBubble)` would bail out all completed messages for free — the unmemoized `ChatBubble` re-runs on every chunk for every completed bubble too, not just the streaming draft, including `ToolResultCard`'s full `<table>` reconciliation and its recharts views. Existing mitigants: no markdown lib (plain `whitespace-pre-wrap` text), `useMemo` on `asRows`, and recharts animations disabled (`isAnimationActive={false}`). Cost scales with conversation length × chunk rate — worst on long tool-heavy chats. Still open: no runtime profiling of AI-chat streaming has been performed (a DevTools pass on a streaming chat with 2-3 tool tables would pin the real cost).

- [ ] **Exact bank-account filter executed as unanchored `ILIKE '%…%'`, skipping `idx_transactions_bank_account` and risking substring over-match** 🔽
  - ↪ _from: Performance research 2026-07-05 · Wave P1 (backend query paths)_
  - `apps/node-backend/src/services/filterBuilder.js:111-113`, `apps/node-backend/src/routes/transactions.js:88`, `apps/frontend/src/features/transactions/hooks/useTransactionListData.ts:118`
  - The frontend sends an exact account string picked from a dropdown, but the builder wraps it as `t.bank_account ILIKE '%v%'` — seq scan instead of an index probe on `idx_transactions_bank_account`/`idx_transactions_bank_date_active`, plus a latent correctness edge (one account label being a substring of another matches both). The export path already supports exact `bank_accounts IN (…)` (`:114-121`); the list path never uses it.
  - Fix: use exact (or prefix-anchored, case-normalized) matching for the list endpoint's account filter, or route the frontend's dropdown value through the existing exact `bankAccounts` branch.

- [ ] **Sorting by memo/recipient/category/currency computes expression sort keys over the fully materialized set with no supporting index** 🔽
  - ↪ _from: Performance research 2026-07-05 · Wave P1 (backend query paths)_
  - `apps/node-backend/src/repositories/transactionRepository.js:27-40,428-434`
  - `TRANSACTION_SORT_COLUMNS` maps recipient → `COALESCE(pr.name, r.name)` and category → a 3-branch CASE with string concatenation; memo and currency have no btree index. Any non-date sort string-computes a sort key per row and sorts the entire filtered set each page (compounded by the `COUNT(*) OVER ()` materialization filed above). Interpolation itself is safe — whitelist map + ternary direction, values parameterized.
  - Fix: low priority at current scale; if non-date sorts get hot, add btree indexes on `(memo)`, `(currency, date)` and consider sorting by the joined name only after restricting to page candidates.

- [ ] **marketLookup per-symbol quote cache has no sweeper — expired entries persist forever for symbols never re-queried** 🔽
  - ↪ _from: Performance research 2026-07-05 · Wave P2 (memory boundedness)_
  - `apps/node-backend/src/routes/marketLookup.js:19-22,231-248`, `apps/node-backend/src/services/research/researchCache.js:43-51,74-79`
  - `quoteCache = createResearchCache()` is a private instance; the 5-min sweep interval in researchCache.js:76-79 only sweeps the exported `researchCache` singleton, and `createResearchCache` itself attaches no timer. Expired entries are removed only on a `get()` of the same key, so every unique `basic:SYM`/`full:SYM` key ever quoted leaves a dead entry (full quotes ~2-5 KB each). Growth is user-driven and slow — weeks of research browsing → hundreds-thousands of stale entries, single-digit MB worst case — but strictly monotonic on a never-redeployed process. (`inFlightQuotes` is fine — deleted in `finally` at :247.)
  - Fix: sweep in the factory (attach the unref'd interval inside `createResearchCache` so every instance gets it), or have marketLookup call `quoteCache.sweep()` per request.

- [ ] **InvestmentDetailDialog transactions tab renders every portfolio transaction for the holding unvirtualized** 🔽
  - ↪ _from: Performance research 2026-07-05 · Wave P3 (frontend state/i18n runtime)_
  - `apps/frontend/src/components/portfolio/InvestmentDetailDialog.tsx:524-556` (`investment.transactions.map` into a `max-h-[400px] overflow-y-auto` div)
  - Genuinely unbounded — grows with every buy/sell/dividend forever (a DCA'd dividend holding accumulates hundreds of rows over years). All rows mount on tab open, and every dialog-level state change (tag edits, price refetch replacing the `investment` object) re-renders the full list. Rows are moderately heavy (Badge, date formatting, per-row `fmt` calls).
  - Fix: slice with a "show more" cap (e.g. 50) or reuse the existing virtual-list machinery; rows are fixed-height so virtualization is trivial.

- [ ] **StartupRedirect waits for settings hydration before redirecting, so non-default startup sections mount + fetch the Dashboard first, then discard it — even though the target is already in localStorage** 🔽
  - ↪ _from: Performance research 2026-07-05 · Wave P4 (boot latency)_
  - `apps/frontend/src/components/shared/StartupRedirect.tsx:49-66` (`if (isLoading) return` before redirect), `:20-28` (LAST_ROUTE read synchronously from localStorage)
  - A user configured for `startupSection: 'portfolio'|'research'|'last'` still gets `/` rendered first: the DashboardPage chunk loads and its queries fire, then after `GET /api/settings` returns the app navigates away, discarding that work and adding a visible page swap. For `'last'`, the target path is already available synchronously (localStorage LAST_ROUTE) but the redirect still waits on the settings round trip. Cost per boot: one wasted route chunk + its query fan-out + the settings RTT serialized before the real page starts loading.
  - Fix: mirror `startupSection` into localStorage on change and redirect synchronously before first route render (initial router entry), falling back to settings-driven redirect only when no mirror exists.

- [ ] **Hot-boot's longest phase is a `docker compose images -q` CLI spawn (143–249ms of a ~620ms boot) that runs even when containers are already up** 🔽 📏 *(measured live)*
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S1 (live instrumented boot, demo app)_
  - `packaging/electron/main.js:3182-3187` (`pre_pull_image` inside `parallel_init`)
  - Measured: 143–249ms in every scenario, always the slowest member of `parallel_init` (so it sets that phase's duration); the socket `/_ping` beside it takes 15–21ms. It runs unconditionally, even when `composeStartOrUp`'s all-running fast path is about to no-op.
  - Fix: check image presence via the Docker socket HTTP API (`GET /images/json`, same pattern as `pingDockerSocket`) or skip the check when containers are already running. Saves ~150–250ms; hot boot is already sub-second, hence low.

- [ ] **Splash becomes visible at ~340ms typical / ~650ms after-idle — above the 300ms "perceived instant" bar, but only ~150ms of it is app-controlled** 🔽 📏 *(measured live — limited headroom, filed for completeness)*
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S1 (live instrumented boot, demo app)_
  - `packaging/electron/main.js:3118-3127` (menu/dock setup before `createWindow()`)
  - Measured spawn→`create_window` end: 337/339ms warm-typical, 646–653ms on first-launch-after-idle; actual pixel paint of the data-URL splash adds an unmeasured few tens of ms. Composition: ~190–430ms Electron framework init before module eval (fixed cost, untraced) + ~60ms `app.whenReady`/menus + 87–124ms `create_window`. Only the last ~150ms is app-controlled.
  - Fix: move menu/dock setup after `createWindow()`; real gain ≤100ms — don't prioritize over the items above.

- [ ] **No `backgroundColor` on the BrowserWindow — the first visible frames paint the default backdrop (white / vibrancy material) before the data-URL splash renders, a visible flash in dark mode** 🔽
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S2 (main-process cold-start static sweep)_
  - `packaging/electron/main.js:1485-1510` (BrowserWindow options — no `backgroundColor`, default `show:true`), splash loaded via data-URL at `:3127`
  - Show-immediately is the right strategy for perceived speed, but until the splash HTML paints, the window shows the default backdrop — against a near-black splash in dark mode that's a flash. The splash base color is already computed synchronously (`readSplashTheme()`/`deriveSplashPalette()`, main.js:1340-1370) before window creation.
  - Fix: pass `backgroundColor` derived from the same palette (fallback `#0f172a`) into the BrowserWindow options so frame 1 matches the splash. One line; makes splash-visible *feel* instant even before the HTML paints.

- [ ] **Splash status is honest but frozen through the dominant phase — "Starting services..." covers the entire compose span (87% of warm boot) as one static string** 🔽
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S3 (splash→SPA handoff)_
  - `packaging/electron/main.js:3143` (`splash.checkingDocker`), `:3189` (`splash.downloading`, first-run only), `:3287` (`splash.startingServices`), `:3332` (`splash.waitingApp`); strings `i18n/source/en.json:2665-2669`
  - Nothing lies, but nothing progresses either — the spinner is the only motion for seconds during the phase S1 measured as the bulk of warm boot. A splash that visibly progresses feels faster.
  - Fix: cheap sub-progress inside `composeStartOrUp` — parse compose stderr progress events, or a timed rotation ("Starting database…" → "Starting Vision engine…" keyed off elapsed time). Pure `setSplashStatus` work; its data:-URL guard (`:1419`) already makes this safe.

- [ ] **Dock-reactivate reopen path skips splash AND poll — blank window while the SPA reloads, connection error if the backend died meanwhile** 🔽
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S3 (splash→SPA handoff)_
  - `packaging/electron/main.js:3504-3509` (`activate` with `mainWindow === null` → `createWindow()` + bare `loadURL(APP_URL)`); same pattern in the `sendToApp` recovery path `:2800-2806`
  - After a red-button close (window destroyed, app + containers still alive), reopening paints an empty window and re-runs the entire SPA boot unguarded.
  - Fix: the hide-on-close option above makes this path disappear entirely; short of that, load `splashDataUrl()` first and reuse `pollAndLoad()`.

- [ ] **Login-item background prelaunch — true cold-login-to-instant, but weakest value-for-effort of the three keep-alive options (option — user decision, recommend skipping unless asked)** 💡🔽
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S3 (architecture options)_
  - No `setLoginItemSettings`/launchd code exists anywhere in main.js (grep confirmed)
  - Feasible via `app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })` + a launch flag that runs the container path without showing a window. Appears in System Settings › Login Items (consent UX needed), always-on RAM, and mostly duplicates what hide-on-close + keep-services-running achieve on the first manual open.

- [ ] **yahoo-finance2 is statically imported into the pre-listen module graph (~100ms of every backend boot) while the analogous heavy dep (puppeteer) is already lazy** 🔽
  - ↪ _from: Performance research 2026-07-05 · Wave P4 (boot latency)_
  - `apps/node-backend/src/routes/marketLookup.js:6`, `apps/node-backend/src/services/research/adapters/yahooAdapter.js:18`, `apps/node-backend/src/services/prices/priceProviderRegistry.js:9`
  - `main.js` imports the full router graph before `listen()`; three modules statically import `yahoo-finance2`, measured ~102ms to import under bun on the dev machine (likely similar or slower in the Alpine container) — paid on every container start, before /health can go green. Puppeteer in the same codebase is already handled with `await import('puppeteer')` at first use (puppeteerRenderer.js:17), so the pattern exists.
  - Fix: lazy-import yahoo-finance2 behind a shared `getYahoo()` accessor (module-level cached dynamic import) in the three call sites.
  - **📏 Measured 2026-07-05 (Wave S1, demo app): the untraced entrypoint→first-trace-mark gap is ~490ms — 5× the entire traced backend boot (92ms).** `docker logs`: `entrypoint_total ms:0` at T, first backend mark (`db_poll`) at T+~490ms, consistent across runs. That window = bun process start + the full ESM import graph (incl. this static yahoo-finance2), invisible to `VISION_BOOT_TRACE` because marks start inside `start()` (`apps/node-backend/src/main.js:418`). Additional fix: emit a mark at module-eval top (or log the delta from an env-passed entrypoint timestamp) so the import graph becomes a first-class traced phase, then attack the biggest importers. Once the demo healthcheck ⏫ item lands, this ~490ms becomes the #2 warm-boot cost.

- [ ] **`transactions` carries 24 indexes (1,288 kB index vs 200 kB heap, 6.4×) including 2 exact duplicates, 5 strict-prefix redundancies, and 3 full/partial same-column twins — every row write maintains all 24** 🔽 📏 *(catalog-structural — valid despite demo scale)*
  - ↪ _from: DB performance research 2026-07-06 · Wave D2 (live index-usage pass, demo DB)_
  - Catalog-derived from `pg_indexes`/`pg_stat_user_indexes` on the live demo DB; index definitions live across `alembic/versions/` (0001 + later)
  - **Exact duplicates (pure waste, safe to drop the non-unique twin):** `idx_asset_price_history_investment_date` ≡ `uq_asset_price_history_investment_date` (same columns; the non-unique one even carries the scans while the unique twin serves constraint duty) · `idx_pps_date_currency` ≡ `uq_pps_date_currency` on portfolio_performance_snapshots. **Strict prefixes (single-column ⊂ wider btree):** `idx_transactions_bank_account` ⊂ `idx_transactions_bank_date` · `idx_transactions_category_id` ⊂ `idx_transactions_category_date` · `idx_transactions_recipient_id` ⊂ `idx_transactions_recipient_date` · `idx_categories_general` ⊂ `uq_general_detail` · `idx_exchange_rates_currency` ⊂ `uq_currency_date`. **Full/partial twins (full answers everything the partial does):** `idx_transactions_bank_date`(_active) · `idx_transactions_category_date`(_active) · `idx_transactions_recipient_date`(_active) — keep one of each pair. Write amplification hits exactly the hot paths other findings batch (CSV import commit loops).
  - Usage-zero note: 18 of 24 transactions indexes show idx_scan=0 on demo, but demo stats reflect only audit usage — **verify idx_scan on the real DB before dropping anything beyond the 2 exact duplicates**. `idx_transactions_active` carries essentially the whole demo read load (286k scans).
  - Fix: migration dropping the 2 exact duplicates now; prefix/twin candidates after a real-install `pg_stat_user_indexes` check (pairs with the pg_stat_statements item below).

- [ ] **Small tables are never ANALYZEd — restore/init/migration paths don't run ANALYZE and autovacuum's threshold means low-churn tables run on default planner estimates forever** 🔽 📏
  - ↪ _from: DB performance research 2026-07-06 · Wave D2 (live pass, demo DB)_
  - Live `pg_stat_user_tables`: `categories` (33 rows), `investments`, `planned_transactions`, `accounts`, `tags`, `recipient_bank_accounts`, `mv_category_totals` + 7 more have data but `last_analyze` AND `last_autoanalyze` both NULL; visible in every plan — `Seq Scan on categories … rows=560` estimated vs 33 actual (×17 overestimate propagating through the 3 category joins in every list query)
  - Small tables never cross autovacuum's analyze threshold, so misestimates persist for the install's lifetime; join misestimates compound on real installs where they can flip plans.
  - Fix: run a database-wide `ANALYZE` once after initdb-load/restore/migration completes — one statement in the boot path (could piggyback where MVs are created) and in the Electron restore path.

- [ ] **pg_stat_statements available (1.12) but not installed — the next perf pass on a real install has no query-level evidence** 🔽 *(observability)*
  - ↪ _from: DB performance research 2026-07-06 · Wave D2_
  - Live `pg_available_extensions`: default_version 1.12, installed_version NULL
  - Needs `shared_preload_libraries=pg_stat_statements` in the db `command:` + `CREATE EXTENSION IF NOT EXISTS` (idempotent, could live with the MV create-if-not-exists boot block). Piggybacks on the `random_page_cost` compose `command:` change filed by Wave D1 — one combined compose edit covers both.
  - Fix: `command: postgres -c random_page_cost=1.1 -c shared_preload_libraries=pg_stat_statements` + boot-time `CREATE EXTENSION`; then real-install perf work becomes evidence-based.

- [ ] **Zero Postgres tuning anywhere — stock `random_page_cost=4.0` models spinning disks on an all-SSD deployment, biasing the planner toward seq scans as tables grow** 🔽
  - ↪ _from: DB performance research 2026-07-06 · Wave D1_
  - No `command:`/custom postgresql.conf/`POSTGRES_INITDB_ARGS` in any compose (`docker-compose.yml:2-19`, `packaging/electron/resources/docker-compose.yml:4-18`, `packaging/electron/resources-demo/docker-compose.yml:8-25`); live-verified on demo DB: every setting `source=default`
  - At today's demo size (18 MB total DB) any plan is fast, but `random_page_cost` is the setting most likely to flip a plan wrong as a real user's `transactions`/`asset_price_history` grow over years — and it interacts with the trigram/GIN and report-aggregation indexes other waves audited. Zero-risk to change. (All other stock defaults were assessed and genuinely don't matter at this scale — see §Checked clean.)
  - Fix: add to the db service in all three composes: `command: postgres -c random_page_cost=1.1` (applies on restart, no re-init). Optionally fold in the `idle_in_transaction_session_timeout` and `shm_size` items below.

- [ ] **No `idle_in_transaction_session_timeout` anywhere (server-side 0, nothing pool-side) — a transaction stalled on a non-DB await holds locks + a pool slot indefinitely** 🔽
  - ↪ _from: DB performance research 2026-07-06 · Wave D1_
  - Live `pg_settings`: `idle_in_transaction_session_timeout | 0`; pool options at `apps/node-backend/src/database/connection.js:22-28` set only `statement_timeout`/`idleTimeoutMillis`/`connectionTimeoutMillis`; `withTransaction` (`connection.js:126-148`) holds a client across arbitrary `await fn(client)`
  - `statement_timeout` does NOT fire while a session is idle *in* transaction — if `fn` stalls on a network call or hung stream, the lock + pool slot are held until restart, and autovacuum's xmin horizon stalls (table bloat). Single-user blast radius = "app wedges until restart". Low likelihood, cheap insurance.
  - Fix: add `idle_in_transaction_session_timeout: 60000` to the `pg.Pool` options (node-postgres passes it per-connection), or server-side via the same `command:` as the finding above.

- [ ] **db service has no `shm_size` — 64 MiB `/dev/shm` compose default will break parallel queries once tables outgrow ~8 MB (future-proofing, not a current bug)** 🔽
  - ↪ _from: DB performance research 2026-07-06 · Wave D1_
  - No `shm_size` key on the db service in any of the three composes; live: `df -h /dev/shm` → 64.0M, `HostConfig.ShmSize` = 67108864
  - Parallel workers allocate DSM under `/dev/shm` and die with "could not resize shared memory segment" when it's exhausted. Honest framing: parallelism is never even *planned* today (`min_parallel_table_scan_size` 8 MB > largest table 2.1 MB on demo) — this only bites once a real install's tables pass ~8 MB heap and a report query goes parallel with hash joins. One line, zero cost.
  - Fix: `shm_size: 256mb` on the db service in all three composes (per `.claude/rules/packaging.md`, mirror root → packaged).

- [ ] **`planned_transactions` and `portfolio_transactions` have only single-column indexes where queries filter on multiple columns together** ⬇ 🔧 *(`exchange_rates` dropped from this finding — already adequately indexed)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `planned_transactions` (queried 3-column), `portfolio_transactions` (queried with `investment_id = ANY(...)` + window function), `moveHoldingService.js` filters by `(investment_id, account_id)` — all single-column only.
  - Low impact at current personal-finance scale; not urgent.
  - Fix: composite indexes if/when these tables grow — `(is_active, is_executed, planned_date)`, `(investment_id, date, id)`, `(investment_id, account_id)`.
  - Verification (2026-06-30): the `exchange_rates` sub-claim is **wrong and removed** — `alembic/versions/0001_initial_database_schema.py` defines `CONSTRAINT uq_currency_date UNIQUE (currency_code, rate_date)` inline in the table definition, which Postgres backs with a real composite index covering exactly the access pattern (`rateFetcher.js:308-326` filters `currency_code = $1 AND rate_date <= $2`). Two independent verification passes initially missed this by only grepping for `CREATE INDEX` statements and not inline `CONSTRAINT ... UNIQUE` clauses — a useful lesson for future index audits in this codebase.

- [ ] **Minor pagination/cache hygiene gaps** ⬇ 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `routes/tags.js:19-24` + `tagRepository.js:15-29` (unbounded list, no LIMIT, unlike every sibling route); `recipients.js:23-26` → `recipientClusterService.js:36-43` (loads every active recipient before bucketing, output capped but scan isn't); `infoRepositoryHelpers.js:80-82` `clearMvCache()` exported/documented as "used after bulk import" but has zero actual callers (self-heals via 60s negative TTL; comment is stale).
  - Fix: add `parsePagination` to the tags route; wire up or remove the dead `clearMvCache()` export.

- [ ] **FX-backfill helper runs on every backend startup (not literally "one-time"), but is self-limiting and not request-path** ⬇ 🔧 *(re-characterized)*
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Backend_
  - `apps/node-backend/src/services/currency/currencyConversionService.js:475-494` (`backfillPortfolioHistoricalRates`)
  - `for (const row of missingResult.rows) { await getRateToEurForDate(...); await query(exactCheck...) }` — a genuine N+1, confirmed. Its sole caller is `startup/warmup.js:230-235`, invoked unconditionally on every boot (when online) — not a manually-triggered one-time migration script as originally described, though it stays cheap after the first run since its own query is gated to only rows genuinely missing a rate.
  - Fix: low priority given the self-limiting behavior; batch if it ever shows up in startup-time profiling.

- [ ] **Accordion height animation has no `prefers-reduced-motion` guard** ⬇ 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Performance — Frontend_
  - `config/tailwind.config.ts:71-91` (keyframes), `apps/frontend/src/index.css:977-1005` (reduced-motion block doesn't include these)
  - Animates layout-triggering `height`; unlike every other animation class, `animate-accordion-down/-up` is missing from the existing reduced-motion override list, and there's no JS-level `useReducedMotion` check either (unlike `ThemeContext`/`ShaderAurora`/`useCountUp`/`RollingNumber`, which all do their own check).
  - Fix: add `.animate-accordion-down, .animate-accordion-up { animation: none; }` to the existing block.

- [ ] **Full ECB history cache (~7k days × ~31 currencies) is retained for the life of the process after a single pre-90-day FX lookup** ⬇
  - ↪ _from: Performance research 2026-07-05 · Wave P2 (memory boundedness)_
  - `apps/node-backend/src/services/currency/rateFetcher.js:23-24,159-177,423-430`
  - `historicalEcbFullCache` holds the parsed full ECB daily history back to 1999 (~7,000 Map entries × ~31 rates — order 10-20 MB of JS objects, plus a transient ~6 MB XML string during parse). The 24h "TTL" only gates re-fetch; nothing frees the stale copy, and during a refresh old+new coexist. Bounded (grows ~250 entries/year), so footprint rather than leak — but in a memory-constrained container a one-off old-date lookup permanently costs those MBs. The 90-day cache is the same pattern at negligible size.
  - Fix: null out `historicalEcbFullCache` some interval after last access (unref'd timer set on fetch), or keep only currencies actually present in the user's portfolio transactions.

- [ ] **db container logs are unrotated `json-file`** ⬇
  - ↪ _from: DB performance research 2026-07-06 · Wave D1_
  - Live `HostConfig.LogConfig` = `{"Type":"json-file","Config":{}}`; no `logging:` key in any of the five compose files
  - Negligible in steady state (Postgres logs almost nothing at default verbosity), but the known demo failure mode — migrate crash-loop on stale `alembic_version` (documented in CLAUDE.md) — is exactly the scenario that spews unbounded log growth into the Docker VM disk. Disk-space nit, not query perf.
  - Fix: `logging: { driver: json-file, options: { max-size: "5m", max-file: "3" } }` on db (and arguably app) in all composes.

- [ ] **Alpine/musl collation hazard: DB reports `en_US.utf8` (libc provider) on a musl image — swapping the image variant (alpine↔debian) on an existing volume would silently corrupt all text btree indexes** ⬇ *(packaging rule, not a perf fix)*
  - ↪ _from: DB performance research 2026-07-06 · Wave D1_
  - Live `pg_database`: `datcollate=en_US.utf8, datlocprovider=c` on `postgres:18-alpine` (`docker-compose.yml:3`, `packaging/electron/resources/docker-compose.yml:5`); devcontainer runs *Debian* glibc PG 18 (`.devcontainer/Dockerfile:49`) but on its own datadir — no shared volume today
  - Under musl, `en_US.utf8` collates as byte order (accented Dutch recipient names sort "wrong" — cosmetic; marginally *faster* sorts, no perf harm). The real hazard: a future "switch off Alpine for CVE reasons" image change on an existing `postgres_data` volume changes collation order silently — text btree indexes become corrupt without erroring.
  - Fix: none needed today; add a line to `.claude/rules/packaging.md` that the db image musl/glibc variant must never change on an existing volume without `REINDEX`.

- [ ] **Boot-trace instrumentation bugs: `pre_pull_image` double-emits its mark and the `launch` mark never closes** ⏬ 📏 *(found live — cosmetic, but skews any tooling that sums marks)*
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S1 (live instrumented boot, demo app)_
  - `packaging/electron/main.js:3188` (early `return` after `end()` inside a `try` whose `finally` at `:3198-3199` calls `end()` again → duplicate mark in every run), `:3105` (`endLaunch` never invoked → a `launch` phase exists but never emits)
  - Fix: drop the early `end()` or guard `bootMark` closures against double invocation; call `endLaunch` where launch actually completes.

- [ ] **Single-instance lock acquired at the END of module eval — a second launch evaluates the whole 3514-line module (incl. the archiver chain) before quitting** ⏬
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S2 (main-process cold-start static sweep)_
  - `packaging/electron/main.js:3491` (`requestSingleInstanceLock` in the last 25 lines) vs `migrateLegacyUserData()` IIFE at `:90-113`; second-instance handler `:3495-3500` is clean (restore/show/focus only)
  - A second launch pays full module eval before discovering the lock; two simultaneous first launches can also both enter the `renameSync` migration before either takes the lock (theoretical race, non-fatal).
  - Fix: move the lock acquisition to immediately after `app.setName(...)` (main.js:84 — must stay after setName since the lock lives in userData) and before the migration IIFE. Combined with the archiver lazy-require this makes second-launch focus near-instant.

- [ ] **Asar ships 2128 node_modules files (incl. full lodash via archiver-utils) for the backup feature alone; 4 transitive deps redundantly listed as direct** ⏬
  - ↪ _from: Startup/Electron performance research 2026-07-05 · Wave S2 (main-process cold-start static sweep)_
  - `packaging/electron/package.json:12-19`; built-app asar listing: 2137 entries, 2128 under `/node_modules/`, 11MB (lodash, glob, cross-spawn, wrap-ansi arrive via `archiver-utils`)
  - Asar index parse scales with entry count but 2137 is still small (~low single-digit ms) — footprint/hygiene more than boot time; the boot cost is the archiver eval finding above. `archiver-utils`, `compress-commons`, `readable-stream`, `zip-stream` are transitive deps of archiver listed as direct.
  - Fix (opportunistic only): swap archiver for a lean zip writer (e.g. `yazl`, sibling of the already-used `yauzl`) to cut the tree ~10×; at minimum prune the redundant direct deps.

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

- [ ] **quotaGovernor `dayMirror` accumulates one key per metered provider per UTC day, never evicted** ⏬
  - ↪ _from: Performance research 2026-07-05 · Wave P2 (memory boundedness)_
  - `apps/node-backend/src/services/research/quotaGovernor.js:66,91,116-118,127-133`
  - `dayMirror` is keyed `${provider}:${dayKey}` and past-day entries are never deleted — up to 5 entries/day for process lifetime; weeks of uptime = a few hundred `[string, number]` entries (KBs) and a `snapshot()` payload that grows to include every historical day. Functionally harmless; hygiene only.
  - Fix: on `spend`/`dayCount`, delete mirror keys whose dayKey ≠ today (2-line prune).

- [ ] **ChatConversationList maps all conversations with no pagination** ⏬
  - ↪ _from: Performance research 2026-07-05 · Wave P3 (frontend state/i18n runtime)_
  - `apps/frontend/src/features/ai-chat/ChatConversationList.tsx:98` (`conversations.map`), `apps/frontend/src/hooks/useAIChat.ts:15-22` (`getConversations` fetches all)
  - Conversation count grows unboundedly with usage, and the same component re-renders per streamed token via `useActiveStreams`/`ChatConversationList` (that identity-churn half is filed separately as "aiChatStreamStore emits a new `activeIds` array on every token, not just on membership change", 🏛️ Architecture & API) — so N light rows × per-token frequency multiply. Growth is slow, rows are light; minimal on its own, but that already-filed compare-before-swap fix increases in value as the list grows.
  - Fix: the filed `activeIds` compare-before-swap fix removes the multiplier; pagination optional later.

- [ ] **Zero CSS containment anywhere — every below-fold dashboard/statistics section is fully laid out and painted on mount; `content-visibility: auto` is an untapped, visually-free win** 🔼
  - ↪ _from: UI/GPU performance research 2026-07-05 · Wave G1_
  - `grep contain:/content-visibility/contain-intrinsic across apps/frontend/src → 0 hits` · `apps/frontend/src/pages/DashboardPage.tsx:485-511` (CashFlowForecastChart + recent-transactions DataTable, below the fold on typical viewports) · `apps/frontend/src/pages/StatisticsPage.tsx:169-283` (stacked ChartCards + CategoryPivotTable per tab) · `apps/frontend/src/features/ai-chat/ChatMessageList.tsx:82-97` (plain column of ChatBubbles in an overflow-y scroller)
  - The repo uses no `contain:` or `content-visibility:` at all. Dashboard mounts 5 stacked widget sections and paints all of them (including two glass chart cards, the forecast chart, and a DataTable) even though the lower half starts offscreen; Statistics tabs stack 2+ chart cards plus the pivot table; long AI chats paint every bubble on each update. `content-visibility: auto` + `contain-intrinsic-size` (matching the existing skeleton heights) on the below-fold section wrappers and on chat bubbles skips their layout+paint until scrolled near — a real cut to first-render and update cost on the two heaviest pages. Interactions verified: no `position: sticky` inside any proposed target (DataTable/CashFlowForecastChart/ChartCard grep clean; CategoryPivotTable's sticky column lives inside its own scroll container, so wrapping the whole table is safe — just don't apply it per-row there). Caveat to verify at runtime: visx `ParentSize` (ResizeObserver) inside a skipped subtree may measure 0 until unskip, which defers chart SVG generation to scroll-into-view — that is the desired lazy behavior and matches the app's already-documented blank-until-scrolled screenshot artifact, and it composes with the already-filed chart mount-stagger fix (whileInView gating). **Runtime-verified 2026-07-05 (Wave G2, demo app): PASS** — tested both post-mount application and the faithful variant (property applied in the same mutation batch the chart node was inserted, so ParentSize's first ResizeObserver measurement happened while skipped); in both, scrolling into view produced a fully rendered 1284×300 visx SVG with real geometry (screenshots `.playwright-mcp/cv-*.png`). The measure-0-while-skipped state recovers on unskip.
  - Fix: add a utility (e.g. `.cv-auto { content-visibility: auto; contain-intrinsic-size: auto 320px; }`) and apply to Dashboard's forecast + recent-transactions wrappers, Statistics ChartCard/pivot wrappers, and ChatBubble roots. **Visually free**

- [ ] **RecipientCombobox renders up to 1000 CommandItems and filters twice — cmdk re-scores and re-renders the full list synchronously on every keystroke while the debounced server search does the same filtering again** 🔼
  - ↪ _from: UI/GPU performance research 2026-07-05 · Wave G1_
  - `apps/frontend/src/components/shared/RecipientCombobox.tsx:23-29` (`limit: 1000, active: false`, `useDebounce` server search) · `:51-55` (`CommandInput` drives `setSearch` per keystroke) · `:69-84` (all items rendered as CommandItems) · same shape at `CategoryCombobox.tsx:21` and `CategoryMultiCombobox.tsx:20` (`limit: 500`, client-only filtering)
  - Every keystroke sets `search` immediately, re-rendering `Command` and making cmdk score/sort/filter all rendered items synchronously (against the *stale* pre-debounce list), then 300ms later the server query re-filters and swaps the list — double filtering with a rank flash, plus a ~1000-item (~3-4k DOM node) mount inside a glass popover every time it opens. This combobox sits on transaction edit surfaces, so it's a hot path. React 19 note: no `useTransition`/`useDeferredValue` is used here (the only `useDeferredValue` in the app is VirtualDataTable's).
  - Fix: set `shouldFilter={false}` on `Command` (the server search is already the filter — kills the per-keystroke cmdk pass and the double-filter inconsistency), and cap the unsearched initial fetch (50-100 rows) or virtualize `CommandList`; the category comboboxes can keep cmdk filtering but deserve the same render cap if category counts grow. **Visually free**

- [ ] **Fonts: `font-display: swap` with no preload and no metric-compatible fallback — Fraunces headings FOUT/reflow on web cold loads; font stack names variable fonts that aren't installed** 🔽
  - ↪ _from: UI/GPU performance research 2026-07-05 · Wave G1_
  - `apps/frontend/src/main.tsx:9-14` (6 static @fontsource latin subsets: Fraunces 400/600/700, Inter 400/500/600, ~18-24 KB woff2 each) · `node_modules/@fontsource/*/latin-400.css` (`font-display: swap`) · `apps/frontend/index.html` (no `<link rel="preload" as="font">`) · `apps/frontend/src/styles/tokens.css:120-124` (stack lists `"Fraunces Variable", "Inter Variable"` first — those packages aren't installed, so the names never match; harmless but misleading)
  - Subsetting is already good (latin-only, 3 weights each). But the woff2 files are discovered only from the bundled CSS, and `swap` with no `size-adjust`/ascent-override means Fraunces (display serif) first paints as Iowan/Palatino/Georgia and then reflows every heading on swap — visible CLS on web cold loads. In Electron the files are local so the swap window is near-zero; this is a web-deployment polish item, honestly modest.
  - Fix: preload the two critical files (Inter 400, Fraunces 600) — needs a tiny Vite plugin or manual hashed-asset injection since names are hashed; and/or add metric-override fallback `@font-face` rules (fontaine does this automatically). Drop the dead `"* Variable"` names from tokens.css, or actually switch to `@fontsource-variable` (2 requests instead of 6). **Visually free** (strictly reduces visual instability)

- [ ] **AreaChart/LineChart/ComposedChart hover handlers call `getBoundingClientRect` on every pointermove — one forced layout per hover frame, on top of the already-filed tooltip reflows** 🔽
  - ↪ _from: UI/GPU performance research 2026-07-05 · Wave G1_
  - `apps/frontend/src/components/charts/AreaChart.tsx:202-211` · `LineChart.tsx:158-167` · `ComposedChart.tsx:145-153` (all: `indexAtClientX`/`handleMove` → `event.currentTarget.getBoundingClientRect()` per pointermove)
  - Each pointermove GBCRs the overlay rect immediately after the previous hover frame's DOM writes (hover-index state → path/tooltip re-render), forcing a layout flush per frame. Distinct mechanism and fix from the filed "hover path rebuilds" and "ChartTooltip double-reflow" findings — this is the third layout read stacking in the same hot frame, and via ChartSync it repeats per synced chart. Small on its own; cheap to remove.
  - Fix: cache the rect in a ref on `pointerenter`/`pointerdown` and invalidate on scroll/resize (or use `event.nativeEvent.offsetX`, which needs no rect at all for a rect-aligned overlay). **Visually free**
  - Runtime note (2026-07-05, Wave G2): at demo density (31 months) a 60Hz hover sweep held a perfect 60fps with 0 long tasks — no measurable cost on a fast machine at DPR 1. Keep as cheap hygiene; cost at ~120-month bar density (~5px/bar) and DPR 2 remains unmeasured.

- [ ] **Default route not modulepreloaded — Dashboard's entire chunk graph (incl. the 34 kB gz shared chart chunk) waits one full serial hop behind the 119 kB gz entry bundle on every cold web load** 🔽
  - ↪ _from: UI/GPU performance research 2026-07-05 · Wave G3_
  - `dist/index.html` (built, Vite 8.0.16/rolldown): `<link rel="modulepreload">` covers only the entry's *static* graph — 12 chunks (`rolldown-runtime`, `icons`, `router`, `query`, `LanguageContext`, `apiEventBus`, `client`, `dialogGenie`, `utils`, `radix-ui`, `dist`, `react-vendor`). `DashboardPage-*.js`, `charts-*.js`, and the locale chunks (`en`/`nl`, 50/55 kB gz) are absent. `apps/frontend/src/App.tsx:29` (`lazy(routeLoaders["/"])`) + `lib/routePreload.ts:8` — Dashboard is a dynamic import; the sidebar hover-prefetch can't help the *initial* load of `/`. `contexts/LanguageContext.tsx:27-28` — the active locale is a second dynamic import on the same critical path.
  - Mechanism: cold load of `/` = fetch+parse+execute `index-*.js` (429 kB / 119 kB gz) → React mounts → router resolves → *then* `__vite__mapDeps` fetches `DashboardPage-*.js` + its 25 deps (verified in the built entry chunk: charts, time, money, StatCard, card, popover…) in parallel. So it's exactly **one extra network round-trip plus main-bundle execute time** before dashboard code starts downloading — not a multi-hop waterfall (Vite's preload helper parallelizes the deps). Honest magnitude: ~1 RTT + ~50-200 ms on a real web deployment; **≈0 in Electron and LAN-docker** (assets are local), which is the dominant deployment. Verified the chart chunk is the visx/framer one: `charts-*.js` contains framer/visx and zero `recharts` (recharts correctly isolated inside `AIChatPage` — the vite.config.ts:71-76 isolation comment holds).
  - Fix: a ~15-line inline plugin in `apps/frontend/vite.config.ts` with a `transformIndexHtml(html, ctx)` hook (`order: 'post'` — `ctx.bundle` is available in build mode): scan the bundle for chunks whose names start with `DashboardPage-` and `charts-` and inject `<link rel="modulepreload">` for them. **The same plugin closes the G1 font-preload finding**: match assets `inter-latin-400-normal-*.woff2` / `fraunces-latin-600-normal-*.woff2` (hashed names, stable prefixes — all 6 woff2 confirmed in `dist/assets/`) and inject `<link rel="preload" as="font" type="font/woff2" crossorigin>`. This is the simplest workable approach for this repo: `experimental.renderBuiltUrl` only rewrites URLs (can't inject links), `build.rollupOptions` can't touch HTML, and an external plugin dep would need an audit for nothing. Don't preload a locale chunk — the language is a runtime setting (preloading `en` unconditionally wastes 50 kB gz for the nl user; leave it). **Visually free**

- [ ] **db healthcheck runs `pg_isready` (fork + connect) every 3s for the container's lifetime** ⏬
  - ↪ _from: DB performance research 2026-07-06 · Wave D1_
  - `docker-compose.yml:12-19`, `packaging/electron/resources/docker-compose.yml:13-18`, `packaging/electron/resources-demo/docker-compose.yml:20-25` (`interval: 3s`, no post-start relaxation)
  - Measurable only as a tiny constant background wakeup — a battery nit on laptops where the packaged app runs 24/7 with hide-on-close. Distinct from the already-filed `start_interval` boot-latency finding.
  - Fix: raise steady-state `interval:` to 30s, keep fast boot probing via `start_period`/`start_interval`.

- [ ] **Chart mount-stagger delay is unbounded in N — worst-case Statistics mounts run ~4s of concurrent JS-driven SVG animation** 🔼
  - ↪ _from: UI/GPU research 2026-07-02 · Wave C (residue closed 2026-07-03; runtime-verified 2026-07-05 · Wave G2)_
  - `components/charts/BarChart.tsx:276,312` (`delay: (di * series.length + si) * 0.015`) and `StackedBarChart.tsx:196-201` (`delay: bar.index*0.02 + stack.index*0.03`) grow linearly with datapoint count; `MonthlyChart.tsx:29-43` feeds every month in the DB unwindowed into BarChart.
  - A decade of data ≈ 130 months × 2 series = ~260 `motion.rect` instances, last-bar delay ≈ 3.9s → ~4.2s of framer rAF-driven SVG `y`/`height` attribute animation (not compositor transforms) on every Statistics mount/tab return, plus 260 spring instances alive concurrently. `CustomChart.tsx` stacked mode (TOP_N=8+Other series × months) reaches similar counts. None of the visx/framer charts gate the entrance animation on viewport visibility — charts below the fold animate invisibly on mount (pure waste). Reduced-motion is handled correctly everywhere (initial=final, duration 0). `PieChart.tsx:100` (`delay: i*0.04`) is fine — slice counts are ≤10 at all call sites.
  - Fix (visually near-identical — the stagger tail past ~0.5s is already imperceptible): clamp total stagger (`delay: Math.min(i * step, 0.4)`), and/or start the animation via `whileInView`/IntersectionObserver instead of mount.
  - **Runtime verdict (2026-07-05, Wave G2, demo app, 31 months = 62 bars): mechanism confirmed exactly** (measured 1.16s attr-animation tail, 1054 rect y/height mutations; extrapolates to ~3.9s on a decade — the static estimate holds), **but the frame-cost half deflates: the entire mount ran at 60fps with 0 dropped frames and 0 long tasks.** Reclassified ⏫→🔼: this is a settle-latency/UX issue (bars still popping in seconds after data arrived), not rendering load. The stagger-clamp fix stands; note it technically changes long-range timing (visible only on >33-month ranges) so flag to the user. Caveat: the ~130-month worst case is inferred from the user's data span (2015→2026), not read from the live DB — if Statistics is typically viewed period-filtered rather than all-time, real-world severity is lower than the decade estimate.

- [ ] **CommandPalette bare-ticker heuristic fires a market-quote fetch for any 2-5-letter word typed while the palette is open** ⏬
  - ↪ _from: UI/GPU research 2026-07-02 · Wave A (residue closed 2026-07-03)_
  - `apps/frontend/src/components/shared/CommandPalette.tsx:148` (`BARE_TICKER_QUERY`) + `:242-250`
  - Typing e.g. "food" issues a debounced `/market/quotes` request per candidate word while the palette is open. Network/API-quota churn, not a render cost (the result card only renders on a live quote, 30s staleTime).
  - Fix: require the `$` cashtag prefix or ≥1 uppercase char before treating a query as a ticker candidate.

- [ ] **Completed `ToolResultCard`s (incl. their Recharts trees) re-reconcile on every streamed AI-chat token** 🔼
  - ↪ _from: Performance research 2026-07-09 · Wave F3 (frontend residues; distinct from the filed ChatMessageList scroll-flush/unmemoized-ChatBubble item — this is the Recharts-subtree half)_
  - `apps/frontend/src/features/ai-chat/ToolResultCard.tsx:93` (no `React.memo`), `ChatMessageList.tsx:84-86` (re-maps all bubbles per render)
  - During an assistant stream, every token re-renders `AIChatPage` → `ChatMessageList` → fresh `ChatBubble` elements → every prior `ToolBubble`/`ToolResultCard` re-renders and its Recharts tree reconciles per token (the `useMemo(asRows, [result])` at `:94` keeps data stable, so it's pure reconcile cost). A conversation with several chart/table tool results pays a full Recharts reconcile of the whole backlog per token.
  - Fix: `React.memo` `ToolResultCard` (props stable for completed messages) and/or memoize completed `ChatBubble`s so only the streaming draft bubble re-renders.

- [ ] **Enhanced-tier macOS vibrancy stacks the OS under-window blur beneath unchanged in-page glass blur — double blur pass over the same pixels, and the window can never be treated as opaque** 🔽 *(static analysis; needs a macOS device to confirm empirically — closes the UI/GPU Wave A vibrancy residue)*
  - ↪ _from: Performance research 2026-07-09 · Wave F3_
  - `packaging/electron/main.js:1500-1501` (`vibrancy: 'under-window'` + `followWindow`), `ElectronBridge.tsx:117-121` (`.vibrancy` class added only at enhanced tier), `index.css:541-543` (body becomes `hsl(var(--background)/0.72)` — 28% transparent), `index.css:400-423` (glass tokens unchanged — no `.vibrancy .glass{...}` override exists)
  - Over transparent body regions the compositor produces OS-vibrancy-blurred desktop pixels, which the in-page `backdrop-filter` then samples and blurs *again* at full glass radii; the translucent body also forfeits any opaque-region compositor short-circuit. Enhanced tier thus adds the vibrancy pass on top of unchanged glass cost rather than trading it down.
  - Fix: under `.vibrancy`, reduce or drop `backdrop-filter` on large surfaces (let the OS material substitute) or lower `--glass-*-blur`. ⚠️ Look-changing — needs user sign-off per the binding design constraint.

- [ ] **Transaction export fetches tags via a per-row correlated subquery** 🔽
  - ↪ _from: Performance research 2026-07-09 · Wave F2 (backend residues)_
  - `apps/node-backend/src/services/transactionExport.js:82-88`
  - The chunk SELECT computes each row's tags with a correlated `SELECT array_agg(...) FROM transaction_tags JOIN tags WHERE tt.transaction_id = t.id` — one index probe per output row for a full-history export, instead of one set-based aggregate folded into the join. Behind a 30 req/min limiter and inherently heavy, so a scaling wrinkle, not a hot path.
  - Fix: `LEFT JOIN` a pre-aggregated `(SELECT transaction_id, array_agg(slug) ... GROUP BY transaction_id)` keyed to the chunk, or `LEFT JOIN LATERAL`.

- [ ] **Owed-detail / owed-export aggregate the entire `split_payments` table per call** 🔽
  - ↪ _from: Performance research 2026-07-09 · Wave F2_
  - `apps/node-backend/src/repositories/splitRepository.js:237-239` (`getOwedByRecipient`), `:286-290` (`getOwedExportRowsByRecipient`)
  - Both join a derived `(SELECT split_id, SUM(amount) FROM split_payments GROUP BY split_id)` that aggregates ALL payments across every recipient, then discard everything outside the requested recipient. Tiny table today; grows with every recorded payment.
  - Fix: correlate the sum to the recipient's splits (`LEFT JOIN LATERAL ... WHERE split_id = ts.id`) or push the recipient filter into the aggregate subquery.

- [ ] **DB-editor table browser runs an unbounded `COUNT(*)` + LIMIT/OFFSET on every page load (admin-only)** 🔽
  - ↪ _from: Performance research 2026-07-09 · Wave F2_
  - `apps/node-backend/src/services/dbEditor.js:196,204` (count alongside every data page, same READ-ONLY txn), `:195` (`LIMIT/OFFSET` paging)
  - With no filter the count is a full scan of the table (worst: `transactions`) re-executed on every page/sort/filter change, racing the 15s `READ_TIMEOUT_MS`; deep offsets scan-and-discard.
  - Fix: skip the exact count when `offset===0 && rows<limit`, use `pg_class.reltuples` estimates for large tables or cache the count per filter signature; keyset paging for deep pages.

- [ ] **`db_editor_audit` grows unbounded — full before/after JSONB images per changed row, no retention** 🔽
  - ↪ _from: Performance research 2026-07-09 · Wave F2_
  - `apps/node-backend/src/services/dbEditor.js:372-380` (writer), `alembic/versions/0059_db_editor_audit.py`; grep confirms nothing ever deletes from it
  - Every committed data-editor change inserts a row carrying full `before_json` + `after_json` + rendered statement text; a bulk edit of N rows writes N fat JSONB rows, forever. Indexed so reads stay fast — slow-burn disk growth (same family as the filed unpruned import-staging finding).
  - Fix: retention sweep (90-180 days or last-N cap) on a low-cadence job; truncate oversized payloads.

- [ ] **FIFO/LIFO cost-basis lot tracking reallocates the entire lots array on every buy/sell — O(B²) per investment, run twice per portfolio-summary compute** ⏬
  - ↪ _from: Performance research 2026-07-09 · Wave F4 (adversarial fresh-ground sweep)_
  - `packages/shared-utils/src/portfolio.js:215` (`lots = [...lots, {…}]` per buy), `:233,240-247` (FIFO `slice(1)`/head-rebuild per consumed lot), `:317,335-349` (LIFO tail equivalents); invoked twice per investment by `portfolioSummaryService.js:117` + `:161` (`aggregateByAccount`)
  - A holding with B buys does ~B²/2 array-element copies; only affects non-default cost-basis users (`weighted_avg` at `:106` is O(N) and unaffected) and is served through the TTL'd info-response cache, so it bites only on cache-miss recompute. Pathological single-holding DCA history (~1-2k txns) ≈ low-tens-of-ms; below that negligible.
  - Fix: track lots with a head index (FIFO) / `pop` (LIFO) and `push` new lots instead of spreading — trivially O(N), zero behavior change.

- [ ] **DB-editor issues ~5 uncached catalog/introspection round-trips per page read (admin-only)** ⏬
  - ↪ _from: Performance research 2026-07-09 · Wave F2_
  - `apps/node-backend/src/services/dbEditor.js:158-204` (`listUserTables` via `assertEditableTable` :57-63, `getTableMeta` 2 catalog queries :84-103, then data + count); `applyMutations` re-runs the 3 introspection queries
  - Column/PK metadata is static within a session but re-fetched on every browse tick. Correctness-motivated (the catalog IS the injection allowlist), so keep the allowlist semantics.
  - Fix: memoize `getTableMeta`/`listUserTables` behind a short TTL keyed by table name.

- [ ] **Cold/big-jump upgrades stack multiple O(table) full-scan migrations on `transactions` and `asset_price_history` (grouped)** 🔼
  - ↪ _from: Performance research 2026-07-09 · Wave F1_
  - All run inside the single boot transaction (see the 🔺 finding at the top of this section); costs are cache-miss/first-boot-after-update only (skip-at-head cache already verified working):
    - `0022_updated_at_not_null_defaults.py:32-56` — 9 tables incl. `transactions` and `asset_price_history`: full-row `UPDATE ... SET updated_at = COALESCE(...)` backfill (full rewrite — column had no default) then `SET NOT NULL` (full verification scan even on PG18 without a pre-validated CHECK). The single heaviest touch of `asset_price_history` in the chain.
    - `0025_fix_numeric_precision.py:140-143` — `ALTER COLUMN amount TYPE NUMERIC(18,4)` = full table+index rewrite of `transactions` under ACCESS EXCLUSIVE, then `:131-134` recreates all 4 MVs (full aggregation scans each).
    - `0044:56-60` + `0053:51-55` each DROP+ADD a *validated* CHECK on `transactions` (full scan each time, just to widen an IN-list); `0046:71` `SET NOT NULL` on `transactions.currency` (full scan); `0049:63` `VALIDATE CONSTRAINT` (full scan, non-blocking lock but O(table) IO). An 0044→0053 update stacks ~4 full scans.
    - Partial-index builds `0036:39-43`, `0044:66-69`, `0053:47-49` — tiny indexes but each full-scans the heap non-concurrently under SHARE lock.
    - `0026_asset_price_history_fk.py:36-44` — anti-join DELETE + validated FK over `asset_price_history` (narrow: guarded to fresh-baseline installs where the table is typically small).
  - Fix pattern for future migrations: add CHECKs/FKs `NOT VALID` + validate out-of-band, batch backfills in id ranges, `CREATE INDEX CONCURRENTLY` once per-migration commit lands (env.py change filed above). Nothing to do for already-applied installs.

- [ ] **Cold/first boot: MV *creation* + index build run pre-listen — full aggregation scans over `transactions` added to the pre-`/health` window the 60s Electron budget is racing** 🔼
  - ↪ _from: Performance research 2026-07-09 · Wave F1_
  - `apps/node-backend/src/main.js:455-458` — `createMaterializedViews()` + `ensureMaterializedViewIndexes()` run after alembic, before `app.listen()`. Distinct from the already-measured steady-state cost (Wave S1 measured the `IF NOT EXISTS` no-op path at 9-15ms): on a boot where the views don't exist yet (first boot, or any migration that recreates them, e.g. 0025), creation = 4 full aggregation scans over `transactions` serialized ahead of listen. Only the *refresh* was deferred post-listen (`main.js:460-462`), not creation/indexing.
  - Fix: defer MV create+index behind listen too — the first-navigation gate already reads `/health/detailed`'s `materializedViews` flag (`packaging/electron/main.js:1036`), so the mechanism exists.

- [ ] **No `ANALYZE` after full-table rewrites/backfills anywhere in the migration chain — first post-upgrade queries run on stale planner stats** 🔼
  - ↪ _from: Performance research 2026-07-09 · Wave F1_
  - Grep over `alembic/**/*.py` + `migrate.js`: zero `ANALYZE`/`VACUUM`. After 0050 rewrites `transactions` (new `account_id` column + 3 indexes) or 0025's type rewrite, statistics are stale until autoanalyze happens to fire — not during the boot transaction — so the first dashboard/statistics queries after a heavy upgrade can misplan. Distinct from the already-filed "small tables are never ANALYZEd" (⏫ that one is about low-churn tables never crossing autovacuum thresholds; this one is about big tables immediately after a rewrite).
  - Fix: `ANALYZE <table>` at the end of the heavy migrations, or have `migrate.js` run a targeted ANALYZE after any non-cached upgrade.

### 🎨 UI/UX & Design

> **Meta-finding (Design authenticity 2026-07-03):** the design *system* is genuinely crafted (Fraunces/Inter/mono type roles, the `Money`/`RollingNumber`/`DeltaPill` components, token-driven WebGL aurora, jewel chart palette). Almost all "AI-slop" here is **adoption gaps + paste-drift** — a crafted component with ~3 consumers while ~30 sites hand-roll the generic version. So the fix direction is mostly to **systematize onto what already exists, not design new things**. An eyes-on Demo-app pass is the top remaining residue.

- [ ] **Dutch UI mixes formal "u/uw" and informal "je/jouw" — two voices in one app, the top machine-translation tell for a Dutch reader** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/nl.json` — 118 lines use u/uw vs 30 lines je/jouw (grep `\b(je|jouw|jij)\b` / `\b(u|uw)\b`). The je-lines cluster in 2026 features (accounts:26, aiChat:278-279, dbEditor:728,741, research:2112-2365, tax:2943-3299, rebalance:1937, settings:2396,2579,2624) against the older u-core (onboarding, import, dashboard:694, insights:1074). Same-concept clashes: `addWatchlist.notesPlaceholder`:213 "Waarom volgt u dit actief?" vs `research.entry.watchlist`:2163 "Volg effecten die je nog niet bezit"; `customChart.createFirst`:607 "Maak uw eerste grafiek" vs `research.builder.emptyTitle`:2112 "Bouw je grafiek". (Dead `scripts/auto-translate-nl.js` — already filed by Wave D3 — corroborates the MT origin.)
  - Fix: pick **je** app-wide (single power user, personal finance, matches Apple's Dutch register) and sweep nl.json u/uw→je/jouw with verb agreement; add the rule to the i18n skill. Run `bun run validate-locales` after.
  - Verification (2026-07-03): a regex-complete sweep of all 3,529 keys refines the counts — 99 formal (u/uw/kunt u/wilt u/heeft u) vs 34 informal (je/jouw), split by feature age (older core formal: `onboarding` ×32, `tax` ×22, `importPage` ×7, dashboard/txPage/statsPage/insights/metals/crypto/stocks…; newer features informal: `research` ×8, accounts, aiChat, dbEditor, rebalance, transfers, parts of settings). Mixed on one surface even within `tax` itself: 22 formal vs 12 informal (`tax.profile.description` "uw belastingsituatie" vs `tax.trendStrip.description` "die je hebt bijgehouden" — adjacent widgets); `settings` splits 4 vs 4.

- [ ] **63 strings use " -- " (double hyphen) as an em dash — renders literally in daily-visible headers and stat labels** ⏫
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1_
  - `i18n/source/en.json` — `grep ' -- '` → 63 hits, 0 real "—" in the file; mirrored in nl.json. Daily surfaces: `dashboard.stat.lastMonthIncome`:683 "Last Month -- Income", `rebalance.subtitle`:1981, `research.subtitle`:2358, `aiChat.emptyState`:278, `addPortTxn.title`:183 "Record Transaction -- {symbol}", `dbEditor.subtitle`:738. The strings pass straight through `t()` (e.g. `pages/portfolio/RebalancePage.tsx:194`), so the UI shows raw "--" — a markdown/source-code habit, not typography.
  - Fix: replace " -- " with " — " (U+2014, spaced) in en.json + nl.json (mechanical sed; validate-locales checks parity, not glyphs); add "real em dashes in UI copy" to the docs style note.
  - Verification (2026-07-03): a literal `--` recount (not just the space-padded ' -- ' pattern) finds 66 affected keys per locale, en/nl consistent with each other — confirms this is a typography fix, not a translation gap.

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
  - Addendum (2026-07-03): a PWA manifest is a separate, undecided call — Electron-first distribution makes it optional, but self-hosted web use is real; if wanted, a minimal `manifest.json` + `theme-color` rides on this same favicon work (no new investigation needed, just a scope decision).

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
  - Verification (2026-07-03): Electron pins the window title to `APP_NAME` (`main.js:386,1491`, no `page-title-updated` listener) — no mismatch today, but every tab/history entry and the Electron window itself all read "Vision".

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

- [ ] **Transaction table header and data desync on horizontal scroll** ⏫ 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `apps/frontend/src/components/shared/VirtualDataTable.tsx:578` (header) and `:663-665` (body) — two independent scroll containers, no synchronization
  - Fixed pixel column widths mean any viewport narrower than total column width (phone, or a narrowed desktop window) lets the body scroll horizontally while headers stay put, in the app's most-used view.
  - Fix: drive both containers from one shared scroll position (shared ref + synced `scrollLeft`, or one wrapping scrollable element).

- [ ] **Portfolio buy/sell/dividend dialogs have no pending-state guard — double-submit risk on money-affecting actions** ⏫ 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `AddPortfolioTxnDialog.tsx:315`, `AddInvestmentDialog.tsx`, `EditInvestmentDialog.tsx`, `EditPortfolioTxnDialog.tsx`, `AddInvestmentFromMarketDialog.tsx` (two-step flow, both buttons)
  - All five submit buttons lack `disabled`/`isPending` wiring — a double-click/double-Enter before the mutation resolves can fire two buy/sell/dividend transactions; the underlying hooks don't even expose `isPending` today. `AddTransactionDialog.tsx` already does this correctly for regular transactions.
  - Fix: apply the same `disabled={mutation.isPending}` + spinner pattern to all five dialogs.

- [ ] **Attachment delete has zero confirmation step** ⏫ 🔎 verified-present 2026-07-11
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
  - Verification (2026-07-03): triage of ~60/607 `text-xs` sites finds it's actually two families, not one uniform problem — ~75-80% is legitimate dense-data/caption dialect. The real demotion is form `Label` at `text-xs` vs the house `ui/label.tsx:8` `text-sm`, concentrated in the portfolio form-dialog cluster (`InvestmentFormFields.tsx:216,225,244,257,266,300`, `EditInvestmentDialog` ×8, `PortfolioTaxAdjustmentsDialog` ×5 — ~30-45 sites); plus ⬇ `TabsTrigger` `text-xs` ×8 (`CashFlowForecastChart.tsx:224-270`) and ⬇ `OnboardingWizard.tsx:295` item titles.

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
  - Verification (2026-07-03): the same missing-`captionLayout`/no-typed-entry gap also affects inline-edit date cells (`VirtualDataTable.tsx:744`), not just dialog forms.

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
  - Verification (2026-07-03): the same bypass-canonical-formatting class also hits date *text*, not just chart locale — `ImportReviewPage.tsx:81-83`'s local `formatDate` is a raw ISO `slice(0,10)` in a user-facing review table, and `WatchlistPage.tsx:157`'s `toLocaleDateString(locale)` bypasses the `dateFormat` setting entirely (both distinct from the `formatDateStringWithAppSettings` convention already adopted in 20+ other files).

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

- [ ] **Six+ pages roll bespoke error UI instead of the shared `PageError` component** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `AccountsPage.tsx:109-111` (plain `<p>`, no icon/retry), `DbMaintenancePage.tsx:206-212`, `RecipientInsightsPage.tsx:145-151`, `PlannedPaymentsPage.tsx:438-443`, `ImportReviewPage.tsx:256-264`, `DashboardPage.tsx:344-348`
  - `PageError` already supports icon/heading/message/`onRetry` but is used in only 6 consumer pages; the rest produce several visually different treatments, several with no retry action.
  - Fix: converge all of these on `PageError`.

- [ ] **Icon-only action buttons missing accessible names** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `AccountsPage.tsx:171-178` (account-row "more options" menu, icon-only), `RecipientPatternsDialog.tsx:281-289` (delete-pattern button, unlike the adjacent edit button which has `sr-only` text)
  - Primary entry points for account management and a destructive action, exposed with no name to assistive tech.
  - Fix: add translated `aria-label`s mirroring the existing edit-button pattern.
  - Verification (2026-07-03): the same gap recurs on `TableDataEditorPage.tsx:419` (delete new row) and `:490,:495` (pager) — `:446` alone has a `title`.

- [ ] **Add/edit transaction dialog can overflow viewport height with no scroll** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · UI/UX & Accessibility — Frontend_
  - `components/ui/dialog.tsx:39-46` (base `DialogContent`, no `max-h`/`overflow-y-auto`), inherited by `forms/AddTransactionDialog.tsx:91`
  - On a short viewport (landscape phone, or keyboard open), the submit button can be pushed off-screen with no way to reach it. Other dialogs (`AddInvestmentDialog.tsx`, `TaxProfileDialog.tsx`, `SnapshotHistoryDialog.tsx`) already self-apply a scroll workaround per-dialog.
  - Fix: fix once in the shared `DialogContent` (`max-h-[90vh] overflow-y-auto`).
  - Verification (2026-07-03): re-confirmed and scoped wider — `DialogContent` (`ui/dialog.tsx:41-42`) centers via `translate-y` with no global `max-h`/`overflow`, so on a short/landscape viewport both ends of a tall dialog clip and the submit button is unreachable. The same missing-cap pattern recurs in 11 more dialogs: `AddRecipientDialog:42`, `MergeAccountDialog:45`, `CloseAccountDialog:105`, `MoveHoldingDialog:67`, `AddCategoryDialog:78`, `AddToWatchlistDialog:184`, `EditPortfolioTxnDialog:175`, `AddPortfolioTxnDialog:164`, `EditInvestmentDialog:129`, `SplitTransactionDialog:105`, `LinkTransactionDialog:164` (AddPortfolioTxn/EditInvestment are the tallest) — the shared-primitive fix covers all twelve.

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

- [ ] **`font-bold` on Inter body/number text never renders a true 700 — Inter latin-700 isn't loaded, so ~108 sites (incl. every hero number) silently render the 600 face and the app's "bold" tier ≡ "semibold"** 🔽
  - ↪ _from: UI/GPU performance research 2026-07-05 · Wave G3 (filed under UI/UX — design-integrity, zero GPU cost)_
  - `apps/frontend/src/main.tsx:12-14` loads Inter 400/500/600 only. `grep font-bold` excluding `<h1-h3>` (Fraunces, 700 *is* loaded) and same-line `font-mono` (SF Mono is a local system font with a real bold) → **108 sites**, including the largest numbers in the app: `components/dashboard/StatCard.tsx:53` (`text-3xl font-bold`), `components/dashboard/NetSummaryCard.tsx:89` (`text-4xl md:text-5xl font-bold`), `components/statistics/SummaryCards.tsx:76`, `components/portfolio/TotalValueCard.tsx:227`, `components/shared/DataTable.tsx:360` / `VirtualDataTable.tsx:545` (filter-count pills), `components/statistics/CategoryPivotTable.tsx:247,310,355`, `pages/TaxOverviewPage.tsx:458,509,667`, etc.
  - Mechanism: CSS font-matching maps requested 700 → nearest loaded face (600) and uses it as-is (engines don't synthesize when a ≥600 face exists) — so this is **not** faux-bold ugliness, it's a weight-hierarchy collapse: `font-bold` and `font-semibold` are pixel-identical, and the intended emphasis tier on money/stat surfaces doesn't exist at render time. GPU-irrelevant; design-integrity only. Related micro-issue, same family: **true faux-italic** at 3 sites — `components/shared/RecipientCombobox.tsx:67`, `CategoryCombobox.tsx:55`, `pages/admin/TableDataEditorPage.tsx:122` (`italic` on Inter; no italic face loaded → synthesized oblique — visible but tiny, all three are muted empty/null placeholders).
  - Fix, two options: (a) add `import "@fontsource/inter/latin-700.css"` to main.tsx (+~24 kB woff2, +1 request) — **LOOK-CHANGING — needs user approval** (every one of the 108 sites gets visibly heavier; arguably this *restores* the designed look, but it changes what renders today); or (b) sweep `font-bold`→`font-semibold` on non-heading/non-mono text — **visually free** (formalizes what already renders) but bakes in a flatter weight scale. The italics: either load the italic faces or drop `italic` for the 3 placeholders (visually free-ish either way; too small to matter).

- [ ] **nl terminology drift on core domain nouns: "begunstigde" vs "ontvanger", and target price translated three different ways** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1 (residue, closed 2026-07-03)_
  - `i18n/source/nl.json` — "begunstigde" ×7 (exactly the `recipients.*FailedTitle` create/delete/merge/unmerge/update family + `plannedPage.link.includesLinked` + `importPage.recipientColPlaceholder`) vs "ontvanger" ×114; "target price" is translated three ways: "doelkoers" ×9 vs "streefprijs" (`watchlist.updateFailed` — same page!) vs "richtprijzen" (`research.entry.watchlist`). Plus machine-translation tells: `onboarding.desc.welcome` "Laten we u instellen" (calqued) + "financiebeheerder" (malformed compound); `tax.markFiled.description` "Je kan" vs the standard "je kunt" used elsewhere.
  - Fix: standardize on "ontvanger" (already the dominant term) and one target-price term; fix the two calques and the kan/kunt slip as part of any nl.json sweep.

- [ ] **~589 dead i18n keys (~17% of 3,529), each with a dead nl twin** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1 (residue, closed 2026-07-03)_
  - Dominated by superseded parallel namespaces: `planned.*` ×44 (→plannedPage/plannedForm), `transactions.*` ×44 (→txPage), `statistics.*` ×33 (→statsPage), `research` ×48, `tax` ×37, `onboarding` ×34 (incl. the confirmed-dead `onboarding.importStep.*` ×11), `form` ×22, `shadowDivergences.*` ×19 (feature removed), `notifications.*` ×8, 35 `common.*` one-worders, `common.notFound`/`notFoundDesc` (superseded by `notFound.*`). All 25 template-literal `t()`-families + 12 `tc()` plural keys were re-derived and excluded honestly; the scan covered frontend + packaging/electron + node-backend. Correction to an earlier checked-clean note: `common.ok` is NOT dead — `packaging/electron/main.js` has its own `t()` (55 call sites) and uses it at `:385/:1141/:3298`.
  - Fix: a pruning pass gated on `bun run validate-locales`; verify individually first (10/10 spot checks held, but only 10 were made — don't bulk-delete off the scanner alone).

- [ ] **The one untranslated Electron dialog is the destructive one** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1 (residue, closed 2026-07-03)_
  - `packaging/electron/main.js:2647-2656` — the restore-backup confirm hardcodes English ('Restore Backup', 'This will permanently replace all current data and cannot be undone.', 'Restore'/'Cancel') while every other Electron dialog (Docker prompts `:3251/:3264`, updates `:1946/:1963`, slow-boot `:1139`, embedded-prep `:383`) correctly uses the main-process `t()` loader (`:12-56`). Nearby IPC error strings ('Backup file not found' etc.) also return English to the renderer.
  - Fix: route the restore-confirm strings through the existing `t()` loader like every sibling dialog; for the backend toast-English addendum (already filed in Correctness), `errorHandler.js` ships stable `ApiErrorCode` codes, so a client-side code→i18n mapping is feasible without touching message strings.

- [ ] **Calendar/DatePicker never pass a locale to react-day-picker — English month captions and weekday abbreviations render in the Dutch app** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1 (residue, closed 2026-07-03)_
  - `components/ui/calendar.tsx` (crafted: Fraunces caption, Monday week start) and `shared/DatePicker.tsx` never forward a `locale` prop to react-day-picker, so month names and weekday headers stay English regardless of the active app language — an i18n-adoption gap on an otherwise crafted component.
  - Fix: pass the active-language date-fns locale object into `<DayPicker locale={...}>`.

- [ ] **~26 files hand-roll `Intl.NumberFormat` currency clones instead of `formatCurrency`/`Money`** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S3 (residue, closed 2026-07-03)_
  - Tax cluster worst: `TaxOverviewPage.tsx:90`, `components/tax/MultiYearTrendStrip.tsx:47`, `YearComparisonCard.tsx:75`, `SuggestedDeductionsCard.tsx:17` (also DashboardPage, RebalancePage, NetWorthPage…). Alignment itself is clean (all tax tables are right-aligned + tabular); ⬇ `SuggestedDeductionsCard.tsx:144` is the only tax amount missing `tabular-nums`.
  - Fix: adopt `formatCurrency`/`Money` at these sites (the copy-paste angle on the same three tax files is tracked separately as an Architecture-domain dedup finding — this entry is the UI-typography angle only).

- [ ] **Chart tick typography: the shared axis spec exists but misses numerics, and ai-chat charts drift off it entirely** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S3 (residue, closed 2026-07-03)_
  - `charts/ChartAxis.tsx:22-37` is a real one-spec axis (fontSize 11, Inter, token colors) used by Area/Bar/Line/StackedBar/Composed, but lacks `fontVariantNumeric: 'tabular-nums'` on numeric ticks (one-line fix). `ToolResultCard.tsx:201-202,232-233` (recharts) sets fontSize 10 with no `fill` → recharts falls back to its hardcoded `#666`, off-token and weak in dark mode.
  - Fix: add the tabular-nums variant to ChartAxis; give ToolResultCard's recharts ticks a token `fill`.

- [ ] **MarketOverviewPage heat grid hardcodes `rgb(34,197,94)`/`rgb(239,68,68)` instead of the gain/loss tokens** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2 (residue, closed 2026-07-03)_
  - `heatStyle`, `MarketOverviewPage.tsx:919-927` — bypasses `--gain`/`--loss` and the ADR-104 colorblind setting on a money-signal surface, in an otherwise *designed* grid (saturation cap, dual-stop gradient, written colorblind rationale). Same class: 🔽 `YearComparisonCard.tsx:237-238` favorable/unfavorable money deltas use `text-accent`/`text-destructive` instead of gain/loss (`DeltaPill` exists for exactly this); ⏬ `ResearchComparePage.tsx:126-132` correlation cells hardcode hsl hues 145/0 (non-money, lower stakes).
  - Fix: derive the heat-grid triplets from `--gain`/`--loss`; route YearComparisonCard's deltas through `DeltaPill`.

- [ ] **AI settings tab is the one Settings anatomy hold-out** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4 (residue, closed 2026-07-03)_
  - `SettingsPrimitives.tsx` (SettingsSection→SettingsGroup→SettingRow) is adopted by all 7 `sections/`, but `AIChatSettingsSection.tsx:35-40` and `ResearchKeysSection.tsx:48-53` hand-roll icon-in-h3 headers + bare `rounded-lg border` cards (zero primitives), nested inside a proper SettingsSection by `AiSection.tsx` → doubled heading hierarchy. ⏬ `AppearanceSection.tsx:93-96`'s variant-picker heading also sits outside any group.
  - Fix: refit both sections onto `SettingsPrimitives` like their 7 siblings. (The code-duplication angle on the same two files is tracked separately as an Architecture-domain finding — this entry is the UX-anatomy-consistency angle.)

- [ ] **`AIChatPage.tsx:178` conversation title is an `h1` rendered at `text-base`** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S3 (residue, closed 2026-07-03)_
  - Renders the Fraunces display serif at 16px, off the type-role ladder (h1-h3 are meant to be display sizes only — the house rule is Fraunces never below `text-lg`).
  - Fix: bump to at least `text-lg`, or move the conversation title off the h1/display role onto a plain label if 16px is the intended size.

- [ ] **Hidden dashboard widgets leave orphan gutters in multi-column rows** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S4 (residue, closed 2026-07-03)_
  - Bento heroes toggle atomically (good), but `DashboardPage.tsx:426-458` (`lg:grid-cols-5`, span-3 + span-2 independently hideable) leaves a permanent 2/5 or 3/5 hole when only one is hidden; same class at `StatisticsPage.tsx:196-216` and `PortfolioOverviewPage.tsx:327+`.
  - Fix: a full-span fallback keyed off the sibling's `isVisible`, so hiding one widget lets the other take the full row.

- [ ] **4 stray `focus-visible:ring-primary/50` sites break from the house `ring-2 ring-ring/70 ring-offset-2` pattern** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2 (residue, closed 2026-07-03)_
  - `WatchlistPage.tsx:166`, `OwesPage.tsx:91`, `VirtualDataTable.tsx:703`, `devtools/RequestList.tsx:124` (this last one is `ring-1` — a candidate for the devtools palette-exemption decision below rather than a fix).
  - Fix: sweep the first three onto the house ring pattern; decide the devtools one alongside the broader devtools-exemption call below.

- [ ] **Vision Demo ships the identical app icon as the real app — indistinguishable in the Dock/Applications** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S6 (residue, closed 2026-07-03)_
  - `electron-builder-demo.json:13` points at the same `build/icon.icns`; `resources-demo/` holds no icon variant. The mark itself (`build/icon.svg`) is designed and on-token — only the demo needs a badged variant. ⏬ Non-mac icons are moot: both builder configs target macOS only (no win/linux blocks; `BrowserWindow`'s `icon` option is ignored on macOS) — becomes real only if other platforms ever ship.
  - Fix: derive a badged "DEMO" variant of `icon.svg`/`icon.icns` for `resources-demo/` and point `electron-builder-demo.json` at it.

- [ ] **`.dark` shadow overrides hardcode raw `hsl(0 0% 0% / …)` instead of the theme's own shadow token** ⬇
  - ↪ _from: Design authenticity 2026-07-03 · Wave S2 (residue, closed 2026-07-03)_
  - `index.css:488,674,708,715,761,876` hand-write black shadows in dark mode; `styles/themes.ts` defines a per-variant shadow hue (Nord `220 30% 6%`, ocean `194 40% 15%`…) that these blocks silently discard, so a Nord/ocean user's dark-mode shadows don't match their chosen variant.
  - Fix: replace the raw `hsl(0 0% 0% / …)` literals with `hsl(var(--glass-shadow))`.

- [ ] **Toast motion is the one overlay outside the token motion system** ⏬
  - ↪ _from: Design authenticity 2026-07-03 · Wave S5 (residue, closed 2026-07-03)_
  - `ui/sonner.tsx`'s skin is fully house (glass-thick, font-display title, token action-button shadow) and shares the global success-icon bounce (`index.css:859`), but its enter/exit/swipe physics are sonner library defaults, ungoverned by `--duration-*`/`--ease-*`. Whether the default feel actually clashes is an eyes-on call (see Still-to-research).
  - Fix, if the eyes-on pass confirms a clash: override sonner's transition props with the token durations/easings.

- [ ] **AI-chat tool sub-states are the smallest remaining gap in the three-tier loading system, plus five small copy nits** ⏬
  - ↪ _from: Design authenticity 2026-07-03 · Wave S6 (residue, closed 2026-07-03)_
  - The error card is on-token (`border-destructive/30 bg-destructive/5`, `ToolResultCard.tsx:95-105`) but its fallback string 'Tool failed.' (`:21`) is hardcoded English; there's no designed tool-running intermediate state (the crafted thinking dots already carry this — acceptable as-is). Copy nits found alongside: ⬇ `OllamaStatusBanner.tsx:38` prefers the raw English `status?.error` over its own localized hint; ⏬ `aria.toggleSidebar` nl "Zijbalk wisselen" means "swap sidebar", not toggle — should be in-/uitklappen; ⏬ nl `shortcuts.*` mixes imperative and infinitive verb forms; ⬇ `cashflow.window30` nl reads "30 d" vs en "30d".
  - Fix: translate 'Tool failed.'; fix the four copy nits alongside any other nl.json sweep.

- [ ] **Four design/UX decisions are filed but not yet decided by the user** 🔽
  - ↪ _from: Design authenticity 2026-07-03 · Wave S1–S6 (residue, closed 2026-07-03)_
  - (1) **devtools palette exemption** — declare devtools/admin surfaces exempt from token discipline by design (parallel to their already-accepted English-only-by-design status; sites: `RequestList.tsx:14-17` sky/orange, TableDataEditor amber/emerald, EndpointLiveness blue) or tokenize them. (2) **`formatCurrencyCompact`'s 9-char threshold** (`utils/currency.ts:151`) — the dashboard hero silently compacts large balances to "€12.3K"; a mitigation already exists (StatCard's `titleValue` shows the full amount on hover) — keep, tune, or gate behind a setting. (3) **print story** — zero `@media print` repo-wide; the backend Puppeteer report path (`themeCss.js`, token-driven) partially covers PDF, so decide whether browser-print of TaxOverviewPage (a Belgian tax filing document) is a supported surface worth a print stylesheet. (4) **PWA manifest** — Electron-first distribution makes it optional, but self-hosted web use is real; if wanted, a minimal manifest + theme-color rides on the already-filed favicon/brand-mark work above (no new investigation needed).
  - Fix: none of these have a fix yet — they need a user call before any code change; the nl je/u register decision (see the ⏫ finding above) is the fifth decision in this same family.

- [ ] **Route-change focus never resets, and OnboardingWizard has zero focus management on step change** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1 (residue, closed 2026-07-03)_
  - `ScrollToTop.tsx:7-9` only scrolls, `PageTransition.tsx:16-33` only animates, and `<main>` (`AppLayout.tsx:217`) has no `tabIndex={-1}` — after any sidebar navigation, keyboard focus strands on the old nav link with no page-change announcement for screen readers. Separately, `OnboardingWizard.tsx:171-172`'s `goNext`/`goBack` only call `setStep` — the new step's `<h2>` is never focused and the progress label (`:240-242`) isn't `aria-live` (no `ref`/`.focus()` anywhere in the file).
  - Fix: give `<main>` `tabIndex={-1}` and focus it on route change; focus the step heading and mark the progress label `aria-live="polite"` in OnboardingWizard.

- [ ] **SymbolSearchBox is not an ARIA combobox** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1 (residue, closed 2026-07-03)_
  - `SymbolSearchBox.tsx:44-65` is a custom `<Input>` + Card with no `role="combobox"`/`aria-expanded`/`aria-activedescendant` and no arrow-key navigation from the input (result rows are real `<button>`s, Tab-only).
  - Fix: add combobox ARIA wiring and arrow-key navigation into the result list.

- [ ] **Toast actions' only keyboard path is an undocumented Alt+T, and context-menu-only row actions are undiscoverable** ⬇
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1 (residue, closed 2026-07-03)_
  - `ui/sonner.tsx` sets no `hotkey` (sonner's default is Alt+T, absent from ShortcutsOverlay); the recipients "Create Rule" toast action (`useRecipients.ts:88-97`) has no keyboard path beyond that and a 4s window. Separately, Duplicate/show-all-from-recipient/mark-active/delete live only in the row context menu (`TransactionsTable.tsx:319-370`) — Shift+F10 does work (`VirtualDataTable.tsx:808-810`) but nothing documents it.
  - Fix: document Alt+T (or set an explicit hotkey) in ShortcutsOverlay; add a one-line hint for Shift+F10 context-menu access.

- [ ] **DashboardSettingsDialog nav is plain buttons, not real tabs; TableDataEditorPage icon buttons lack accessible names** ⬇
  - ↪ _from: UI/UX research 2026-07-03 · Wave U1 (residue, closed 2026-07-03)_
  - `DashboardSettingsDialog.tsx:92-111` is Tab-reachable with `aria-current` but has no `role="tab"`/tablist/arrow-roving semantics. Separately, `TableDataEditorPage.tsx:419` (delete new row) and `:490,:495` (pager) are icon-only with no accessible name — `:446` alone has a `title`.
  - Fix: either implement the tabs pattern (roving tabindex + arrow keys) or drop the visual tab styling for DashboardSettingsDialog; add `aria-label`s to the three TableDataEditorPage buttons.

- [ ] **Settings Selects have no accessible name anywhere — a systemic gap in `SettingRow`** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2 (residue, closed 2026-07-03)_
  - `SettingRow` wires `Label htmlFor` for Switches but never for Selects, so every settings `role=combobox` announces only its value: `GeneralSection.tsx:41,53,65,80,94,107,120`, `BehaviorSection.tsx:39,55`, `StatisticsSection.tsx:79`, `AppearanceSection.tsx:127,175,211` (plus unlabeled schedule-time inputs `:142-155`).
  - Fix: extend `SettingRow`'s label-wiring to Selects (and the schedule-time inputs), the same way it already handles Switches.

- [ ] **TaxProfileDialog has zero step validation — every step tab and the "next" action advance unconditionally** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2 (residue, closed 2026-07-03)_
  - `next()` (`TaxProfileDialog.tsx:102-110`) advances unconditionally and the final branch saves + closes with no validation anywhere; the step tabs (`:148`) can also be clicked directly to jump freely, skipping required fields on earlier steps.
  - Fix: gate `next()` (and direct tab clicks) on the current step's required fields before allowing advancement.

- [ ] **RecipientCombobox stale `displayLabel` — CONFIRMED unique to this combobox** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2 (residue, closed 2026-07-03)_
  - The list is server-filtered by `debouncedSearch` and `selected` derives from it (`RecipientCombobox.tsx:25-33`); `search` never resets on close, so the trigger shows the placeholder while a value is selected whenever the filter (or first-load latency, or >1000 recipients) excludes the selection from the current results. Verified unique to this combobox — Category/BankAccountMulti/TagFilter comboboxes load their full lists client-side and have no parity bug.
  - Fix: reset `search` when the popover closes (or derive the trigger label independently from the loaded-list filter).

- [ ] **Tax profile fields eat a typed `0`, and "12." can't survive the round-trip** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2 (residue, closed 2026-07-03)_
  - `value={x || ''}` at `IncomeStep.tsx:46,62,110,128,219,262,278` and `ExemptionsStep.tsx:128-202` (9 sites total): a typed `0` renders as empty, and a trailing decimal like "12." can't survive the `parseDecimal` round-trip. Mostly cosmetic since 0≡empty for these optional fields.
  - Fix: use `value={x ?? ''}` (not `||`) and preserve the raw typed string until blur/submit.

- [ ] **LinkTransactionDialog search input has no label, and its tolerance field yields 0/NaN on clear** ⬇
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2 (residue, closed 2026-07-03)_
  - `LinkTransactionDialog.tsx:175` search input has no label/id; `:227-232` the tolerance field's `Number(e.target.value)` produces 0/NaN when cleared, and `min={0}` isn't enforced while typing.
  - Fix: add a label/id to the search input; clamp and NaN-guard the tolerance field's `onChange`.

- [ ] **ExportDialog's custom date range has no from≤to validation** ⬇
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2 (residue, closed 2026-07-03)_
  - `ExportDialog.tsx:307-332` — an inverted range only surfaces as a server-error toast; there's no client-side check.
  - Fix: validate `from ≤ to` client-side before submit and disable the export action otherwise.

- [ ] **Onboarding bank-picker cards lack `aria-pressed` — selection is visual-only** ⬇
  - ↪ _from: UI/UX research 2026-07-03 · Wave U2 (residue, closed 2026-07-03)_
  - `OnboardingWizard.tsx:319-334` — the selected bank card has no `aria-pressed` (or equivalent), so screen-reader users can't tell which bank is currently selected.
  - Fix: add `aria-pressed={isSelected}` to the bank cards.

- [ ] **Page-internal state is URL-invisible across portfolio and list pages — same class as the already-filed transactions finding, but six more pages** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3 (residue, closed 2026-07-03)_
  - `NetWorthPage.tsx:72` period, `PerformancePage.tsx:89-90` period + FX-neutral toggle, `ResearchComparePage.tsx:202-205` compared symbols/range/sort (no save mechanism at all — a curated comparison vanishes on reload), `RecipientsPage.tsx:43-47`, `CategoriesPage.tsx:35-36`, `PlannedPaymentsPage.tsx:79`. Heaviest: `RebalancePage.tsx:77,82-85` — a half-built plan (sleeves, percentages, name, cash cap) is lost on refresh with no URL and no draft persistence.
  - Fix: mirror the transactions-page fix (`?`-param sync with `{replace: true}`) on each; prioritize RebalancePage given the data-loss risk of a half-built plan.

- [ ] **Settings is not deep-linkable in the browser, and VirtualDataTable has no scroll restoration on back-navigation** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3 (residue, closed 2026-07-03)_
  - Settings has no `/settings` route — it's a dialog (`AppLayout.tsx:37,231`), and section targeting exists only via the Electron `open-settings` bridge (`ElectronBridge.tsx:54` + `LEGACY_TAB_MAP`, `DashboardSettingsDialog.tsx:39-51`); browser users can't bookmark or link to a specific settings section. Separately, `VirtualDataTable` has no location-keyed scroll save/restore (`ScrollToTop` only touches `window`), so back-navigation into a long list reopens at the top.
  - Fix: consider a `/settings` route (at least for the web deployment); add a location-keyed scroll-position cache to VirtualDataTable.

- [ ] **No popstate/useBlocker guard anywhere — browser back with a heavyweight dialog open navigates underneath and discards typed work** ⬇
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3 (residue, closed 2026-07-03)_
  - Repo-wide grep finds zero `popstate`/`useBlocker` usage; browser back with AddTransaction, MergeRecipients, or PlannedPaymentForm open navigates the page underneath the dialog and silently discards typed input — a particular risk on mobile back gestures.
  - Fix: add a `useBlocker`/`beforeunload`-style guard when a heavyweight dialog has unsaved input and back-navigation fires.

- [ ] **OnboardingWizard step inputs are lost on reload, and ChartBuilderPage persists only ONE chart config to a single localStorage slot** ⬇
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3 (residue, closed 2026-07-03)_
  - `OnboardingWizard.tsx:101,146-157` — step/sub-step inputs vanish on reload (completion itself is server-persisted and Back still works, so this is scoped to in-progress form state). Separately, `ChartBuilderPage.tsx:93,107,112` persists exactly one chart config to a single localStorage slot — it isn't shareable, and building a second config silently overwrites the first.
  - Fix: low priority for onboarding (rare to reload mid-wizard); for ChartBuilder, key the localStorage slot per saved-chart id or move to a real "save as" flow.

- [ ] **`/import` vs `/portfolio/import`: two separate importers under a shared-looking prefix** ⏬
  - ↪ _from: UI/UX research 2026-07-03 · Wave U3 (residue, closed 2026-07-03)_
  - Two genuinely different importers with workspace-separated sidebar labels (`AppSidebar.tsx:136,183`) — low confusion risk since they live in different workspaces, but the shared `/…/import` prefix + same icon is a minor IA smell.
  - Fix: low priority — a distinct icon for one of the two would remove the last bit of ambiguity; not worth a route rename.

- [ ] **Admin sub-pages give no 401 recovery guidance — ProviderHealthPage renders a blank screen on auth failure** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U4 (residue, closed 2026-07-03)_
  - `ProviderHealthPage.tsx:125-201` has no error branch at all and renders blank on error; `DbMaintenancePage.tsx:206-214` and `TableDataEditorPage.tsx:349-355` show a raw "Unauthorized" string; none of the three link to the `/admin` token card (`AdminOverviewPage.tsx:84-99`). (`ExchangeRatesPage`'s GET is not token-gated — `routes/info/rates.js` has no `adminAuth` — so it's out of 401 scope.)
  - Fix: give all three an error state with a link back to the `/admin` token card, matching the pattern the token card itself demonstrates.

- [ ] **AI-chat interrupted stream leaves an unmarked frozen draft, with no timeout on a hung-open connection** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U4 (residue, closed 2026-07-03)_
  - Mid-stream drops and SSE `error` frames do reject and toast correctly (`ai.ts:168-172` throws → store catch → `onError`, `aiChatStreamStore.ts:263-269` — better than initially feared), but the partial `assistantDraft` is neither persisted (only `done` merges to cache, `:223-238`) nor marked interrupted; cancel leaves it frozen with no stopped/regenerate affordance, and a hung-open connection ("Thinking…" forever) has no timeout at all.
  - Fix: mark interrupted drafts visually with a regenerate affordance; add a client-side timeout for a stalled stream.

- [ ] **Update mutations are silent while create/delete toast — the same asymmetry across all four core entities** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U4 (residue, closed 2026-07-03)_
  - `useAccounts.ts:39-41`, `useCategories.ts:50`, `useTags.ts:36`, `useRecipients.ts:50` all invalidate-only on update, while every create/delete toasts on the same entities.
  - Fix: pick one convention — most likely add an update-success toast to match create/delete, applied consistently across all four hooks.

- [ ] **No background-refetch cue on placeholderData lists, and sonner announces errors at the same politeness as info** ⬇
  - ↪ _from: UI/UX research 2026-07-03 · Wave U4 (residue, closed 2026-07-03)_
  - Only `isFetchingMore` + refresh-button spinners exist as a background-fetch cue — matters mainly right after an import, when lists silently show pre-import data until the refetch lands. Separately, `ui/sonner.tsx` has no politeness override, so it inherits sonner's default `aria-live="polite"` for every toast, including errors that should be assertive.
  - Fix: add a subtle background-refetch indicator; override sonner's `aria-live` to `assertive` for error toasts specifically.

- [ ] **Dashboard monthly-summary queries don't feed the page's error subtitle, and FxStatusBanner has no inline refresh** ⬇
  - ↪ _from: UI/UX research 2026-07-03 · Wave U4 (residue, closed 2026-07-03)_
  - `DashboardPage.tsx:88,97` don't destructure `error` from the monthly-summary queries (the page-level error subtitle at `:348` covers the others), so an errored monthly chart renders empty rather than as an error. Separately, ⏬ FxStatusBanner shows staleness with an as-of date (good) but the refresh action lives only on ExchangeRatesPage, with no inline link from the banner itself.
  - Fix: wire the monthly-summary `error` into the page subtitle; add an inline refresh link/button to FxStatusBanner.

- [ ] **Portfolio sibling empty states are bare dead-ends with no CTA, unlike every peer surface** ⏫
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5 (residue, closed 2026-07-03)_
  - `crypto.noCrypto` / `stocks.noStocks` / `savings.noAccounts` / `realestate.noProperties` / `portfolio.noInvestments` all have no CTA, while peer surfaces guide the user (`transactions.noTransactions` "…Import a CSV", `watchlist.empty`, `accounts.emptyDescription`).
  - Fix: give the five portfolio empty states a CTA matching their peers (e.g. "Add your first holding" / link to the relevant import).

- [ ] **belegging vs positie: nl portfolio terminology is split, mirroring an EN holding/investment inconsistency** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5 (residue, closed 2026-07-03)_
  - nl.json counts: belegging(en) ~57 · positie(s) ~27 · effecten ~10 (correct Belgian usage for securities) · "holding" untranslated ×1. The split mirrors EN's own holding-vs-investment inconsistency (`portfolio.holdings` vs `portfolio.investments`) — standardize EN first. Same-surface mix to fix regardless: `invDetail.breakdown` "Beleggingsoverzicht" vs `invDetail.byAccount` "Posities per rekening".
  - Fix: standardize EN terminology (see the separate EN Investment-vs-Holding finding), then let nl keep `belegging` as the primary line-item term (matches `nav.investments`) with `positie` reserved for open/closed-position contexts.

- [ ] **Truncation gaps on long entity names in Recipients, Watchlist, and Categories** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5 (residue, closed 2026-07-03)_
  - `RecipientsPage.tsx:159-171` — name + merge-target render unbounded in a flex row (no `truncate`/`min-w-0`); `WatchlistPage.tsx:174-182` — CardTitle company name competes with the right-hand percentage with no truncation; `CategoriesPage.tsx:213-219` — the detail Badge is unclamped (though the description below it correctly uses `truncate max-w-[200px]`).
  - Fix: add `truncate min-w-0` (plus a `title` attribute) to the three sites.

- [ ] **Chart date-pattern drift: month-first vs day-first, and three different year-abbreviation styles** 🔽
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5 (residue, closed 2026-07-03)_
  - `ForecastInnerRolling.tsx:53` "MMM d" is the lone month-first outlier (everything else in the app is day-first); PerformancePage tooltips use "dd MMM yyyy" vs `BankBalancesWidget:238`'s "d MMM yy"; `statisticsUtils.ts:24,32` ships both "MMM yyyy" and "MMM yy".
  - Fix: standardize on one day-first pattern and one year-abbreviation convention; centralize in `statisticsUtils.ts`.

- [ ] **Dialog-footer button variant/verb drift: ghost vs outline cancel buttons, and "Save" vs verb-label mixing** ⬇
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5 (residue, closed 2026-07-03)_
  - Cancel is `variant="ghost"` in the bulk dialogs plus `MarkAsFiledDialog.tsx:77`, against an `outline` majority elsewhere; `ExportDialog.tsx:390-391`'s primary action is the only non-default dialog primary (`outline`+`sm`); "Save" (`EditPortfolioTxnDialog:357`) vs verb-labels like `addPortTxn.record` "Record" mix within the same dialog family.
  - Fix: standardize cancel on `outline`, standardize submit-button verb per flow (edit = "Save", create = the domain verb).

- [ ] **Empty-state punctuation drift: some end in a period, others don't, for the identical sentence pattern** ⬇
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5 (residue, closed 2026-07-03)_
  - "No categories yet." / "No recipients yet." (period) vs "No investments yet" / "No conversations yet" (no period) — same sentence shape, inconsistent punctuation.
  - Fix: pick one convention (no trailing period matches the house's general UI-copy style) and sweep.

- [ ] **CardContent padding overrides are scattered across many values — wide but victimless drift** ⏬
  - ↪ _from: UI/UX research 2026-07-03 · Wave U5 (residue, closed 2026-07-03)_
  - `pt-6` ×19, `px-4` ×23, `pb-3 px-4` ×21, `p-3` ×7, `py-4` ×8, … — no single value dominates. Related nit: `onboarding.categories.selectAll`/`deselectAll` render in Title Case amid an otherwise sentence-case UI.
  - Fix: low priority — fold into any future CardContent-variant pass rather than a standalone sweep; fix the two Title Case strings alongside any other copy sweep.

- [ ] **`leading-none` sits on wrap-capable text in AlertTitle and Label — long Dutch strings risk colliding line boxes at high zoom** ⬇
  - ↪ _from: UI/UX research 2026-07-03 · Wave U6 (residue, closed 2026-07-03)_
  - `ui/alert.tsx:39` (AlertTitle) and `ui/label.tsx:8` (Label) both use `leading-none`; wrapped Dutch strings at 125-150% browser zoom will collide line boxes since `leading-none` leaves no room between wrapped lines.
  - Fix: drop `leading-none` in favor of a small positive line-height (e.g. `leading-tight`) on these two wrap-capable text roles.

- [ ] **Raw fetch/timeout/5xx error strings leak verbatim into user toasts (~50 sites incl. all four bulk dialogs); no error-code→copy mapping exists anywhere** ⏫
  - ↪ _from: UI/UX review 2026-07-10 · Wave R1_
  - The bulk hooks pass `error.message` straight into the toast description: `apps/frontend/src/hooks/useTransactions.ts:260` (bulk delete), `:278` (bulk update — backs BulkRecategorizeDialog and BulkRecipientDialog), `:296` (bulk export), `:244` (bulk tag) — all `toast.error(t('txPage.bulk.failed'), { description: error.message })`; same pattern at `:80/:152/:224` and across useCategories/useRecipients/useAccounts/useInvestments/useSplits, `CloseAccountDialog.tsx:98`, `MoveHoldingDialog.tsx:60` (~50 `onError` sites). What the user actually reads (traced through `lib/api/client.ts`): backend down → browser TypeError **"Failed to fetch"** (Safari "Load failed", Firefox "NetworkError…") re-thrown raw at `client.ts:254`; timeout → **"Request timed out"** (`:251`); non-idempotent 5xx (bulk ops are POST) → **"Request failed (status 500)"** (`parseEnvelopeError`, `:182`); retry exhaustion → **"Server returned 503"** (`:304`); 422 → **"Validation error: body.ids.0: field required"** with raw joined loc paths (`:141-152`). `ApiClientError` carries a machine `code` (`ApiErrorCode.*`, `client.ts:73/94-104`) but no central humanizer was ever built — repo-wide, the code enum is only read by `client.ts`, its test, and `lib/devtools/apiEventBus.ts`. *(Distinct from the filed "vague fallback copy" findings — this is the opposite failure: developer-grade strings shown verbatim, and the missing mapping layer.)*
  - Fix: add a central `apiErrorToMessage(err)` switching on `ApiClientError.code` (network/timeout/5xx/rate-limited/validation) → i18n human copy; route toast `description` through it everywhere; keep raw `.message` for logs/devtools only.

- [ ] **The entire bulk + tags feature ships literal "[NL] …" placeholder strings to Dutch users — 49 stub values in nl.json render verbatim in the UI** ⏫
  - ↪ _from: UI/UX review 2026-07-10 · Wave R1_
  - `grep '\[NL\]' i18n/source/nl.json` → 49 keys whose value is a literal stub like `"txPage.bulk.recategorize": "[NL] Recategorize {n} transactions"`, `"[NL] {n} selected"`, `"[NL] Bulk action failed"`, `"[NL] Deactivate {n} transactions?"`. By namespace: `txPage.bulk.*` ×32, `tags.*` ×13, `filter.tags*` ×2, `txPage.field`/`txPage.col` ×1 each. Because the key *exists*, `t()` returns it verbatim (`LanguageContext.tsx:103`), so a Dutch user sees `[NL] Actions`, `[NL] Delete`, etc. in every bulk dialog title/button, the BulkActionsBar, and the tag-management surfaces — worse than untranslated English. Only the destructive delete-confirm keys (`txPage.bulk.confirmDeleteTitle/Body.*`) and `tax.markFiled.*` are properly translated. `validate-locales` checks key parity, so these stubs pass CI silently.
  - Fix: translate the 49 stubbed keys; add a `validate-locales` rule rejecting `[NL] `-prefixed values so stubs can't ship again.

- [ ] **MarkAsFiledDialog's Cancel button bypasses the reset path — a typed filing reference silently survives to the next open** 🔽
  - ↪ _from: UI/UX review 2026-07-10 · Wave R1_
  - `apps/frontend/src/components/tax/MarkAsFiledDialog.tsx:77` — Cancel calls `setOpen(false)` directly, never `handleOpenChange` (`:43-46`, where `setReference('')` lives); Radix fires `onOpenChange` only for its own dismiss paths (Esc/overlay/✕), not a programmatic state flip. Type a reference → Cancel → reopen shows the stale reference; confirming then files the year with a value the user thought they discarded (stored verbatim, `:37-39`).
  - Fix: route Cancel through `handleOpenChange(false)` so all close paths share the reset.

- [ ] **Bulk success toasts report only the server-side count — no reconciliation against what the user selected, and the export toast has no count at all** 🔽
  - ↪ _from: UI/UX review 2026-07-10 · Wave R1_
  - `BulkDeleteResult`/`BulkUpdateResult` are `{deleted}`/`{updated}` only (`apps/frontend/src/types/api.ts:571-577`) and the toasts echo them ("Deleted {n}"/"Updated {n}", `useTransactions.ts:257/275`). In filter-mode the bar advertises `effectiveCount = totalMatching` as "N selected" (`BulkActionsBar.tsx:76`); if the server affects fewer rows (concurrent edits), the toast silently shows the smaller number with no "X of Y" delta. The export toast (`txPage.bulk.exported` "Export ready", `:293`) carries no count.
  - Fix: surface requested-vs-affected when they differ ("Updated 80 of 100 — 20 unchanged"; needs the backend to return a requested/skipped count); add the row count to the export toast.

- [ ] **BulkRecipientDialog and BulkRecategorizeDialog expose their only control with no field label — screen readers announce just the placeholder value** 🔽 *(new instance of the filed unlabeled-control class)*
  - ↪ _from: UI/UX review 2026-07-10 · Wave R1_
  - Neither dialog renders a `<Label>` for its combobox (`BulkRecipientDialog.tsx:44-49`, `BulkRecategorizeDialog.tsx:43-48`), and the combobox triggers carry `role="combobox"` with no `aria-label`/`aria-labelledby` (`RecipientCombobox.tsx:38-44`, `CategoryCombobox.tsx:30-36`) — a screen reader hears only "Select recipient…" with no field name. Sibling BulkExportDialog does it right (`<Label htmlFor>` on its radio options, `BulkExportDialog.tsx:45-50`).
  - Fix: add a visible `<Label htmlFor>` (or `aria-label` on the trigger) naming the field.

- [ ] **Native menu / dock / dialog language tracks the OS locale, not the in-app language setting — and never rebuilds when the user switches language** 🔼
  - ↪ _from: UI/UX review 2026-07-10 · Wave R2_
  - The native menu is built from the Electron-side `t()`, whose dictionary is chosen once at boot purely from `app.getLocale()` (`packaging/electron/main.js:18` maps nl-prefixed OS locales to Dutch, everything else to English; loaded once in `initI18n`, `:51`). `setupApplicationMenu()` (`:2890`) and `setupDockMenu()` (`:2983`) run exactly once at launch (`:3118-3119`), and no IPC re-runs them on language change (grep: only `getLocale` at `:18`). The in-app language is an independent user preference (`App.tsx:117` reads `appSettings.language ?? 'en'`). Net effect: an English-locale Mac set to Dutch in-app shows a fully Dutch UI under an all-English menu bar, dock menu, and native dialogs — and vice-versa; runtime language switches never touch the native chrome.
  - Fix: seed the Electron-side language from persisted `appSettings.language` instead of `app.getLocale()`, and add an `app:language-changed` IPC from the LanguageContext setter that reloads the dictionary and re-runs `setupApplicationMenu()`/`setupDockMenu()`.

- [ ] **No native context menu on text inputs — right-click gives no copy/paste/select-all, and spellcheck suggestions are unreachable** 🔼
  - ↪ _from: UI/UX review 2026-07-10 · Wave R2_
  - No `webContents.on('context-menu', …)` handler exists anywhere in `packaging/electron` (grep clean), and `webPreferences` (`main.js:1503-1509`) sets no spellcheck/menu config. Copy/paste exist only as Edit-menu roles (`:2931-2939`) and keyboard shortcuts, so right-clicking any text field — the dbEditor WHERE box and cell editors, the AI-chat composer, every search box — shows nothing; and since Electron's default spellcheck is ON, misspelling underlines appear with no way to reach the suggestions. Conspicuous because the app ships bespoke right-click menus for data rows (`contextMenu.*`, `en.json:561-568`, used in TransactionsTable), setting an expectation plain inputs then break.
  - Fix: add a `context-menu` handler on `mainWindow.webContents` building an edit menu from `params` (Cut/Copy/Paste/Select All gated on `params.isEditable`/`editFlags`, plus `params.dictionarySuggestions` + add-to-dictionary); localize labels via the existing async `t()` loader.

- [ ] **dbEditor: staged cell edits cannot be reverted individually — changing your mind on one cell forces a global "Discard changes"** 🔽
  - ↪ _from: UI/UX review 2026-07-10 · Wave R2_
  - `TableDataEditorPage.tsx`: new rows have a per-row remove (`:419-420`) and delete-marks toggle off (`toggleDelete` `:227-233`, undo affordance `:447-449`), but an edited cell has no revert-to-original path — `EditableCell` (`:67-136`) offers Set-NULL (`:124-131`) but re-opening a dirty cell re-seeds the editor with the *edited* value (`:97`). The only undo for one edit among many is `discardAll()` (`:239-243`), which also nukes every other pending insert/delete/edit; the commit preview (`:504-529`) is likewise all-or-nothing.
  - Fix: when a cell is dirty, render a small revert affordance (e.g. `Undo2`) that deletes just that column from the staged edits; optionally let the preview dialog exclude individual statements before commit.

- [ ] **Native menu items use ASCII "..." instead of the "…" ellipsis glyph — the HIG-governed surface of the already-filed double-hyphen habit** 🔽
  - ↪ _from: UI/UX review 2026-07-10 · Wave R2_
  - `i18n/source/en.json:1186` `"menu.importCsv": "Import CSV..."` and `:1189` `"menu.settings": "Settings..."` (mirrored in nl.json) ship three periods where the macOS HIG specifies the single `…` glyph for menu items opening further UI — exactly the "Apple-polished" convention the app targets. The same `...` habit appears in-app (`dbEditor.committing`, `contextMenu.delete`, `importReview.committing`).
  - Fix: replace `...` with `…` in the two `menu.*` keys (and sweep the in-app `...` strings) in en.json + nl.json — fold into the em-dash typography sweep already filed.

- [ ] **BrowserWindow sets no `backgroundColor` — white flash on reload/navigation in dark mode on Windows/Linux** 🔽 *(static analysis; confirm live per the eyes-on resume point)*
  - ↪ _from: UI/UX review 2026-07-10 · Wave R2_
  - `createWindow()` (`main.js:1485-1510`) never sets `backgroundColor`, so Electron defaults to opaque white. Boot is covered by the theme-aware splash (`:3127`) and on macOS the `vibrancy: 'under-window'` material (`:1500`) masks the default — but the vibrancy block is darwin-only. On Windows/Linux, and on any full document load bypassing the splash (View → Reload role `:2951` / ⌘R), a dark-theme user gets a white frame before the app paints.
  - Fix: set `backgroundColor` from the persisted splash theme (`readSplashTheme`/`SPLASH_THEME_KEY` already exist — convert the stored HSL to hex) so the pre-paint frame matches the active theme on every platform.

- [ ] **Planned-payments dock badge is macOS-only — Windows/Linux users get no due-count indicator at all** ⏬
  - ↪ _from: UI/UX review 2026-07-10 · Wave R2_
  - `app:set-badge` (`main.js:3000-3008`) early-returns unless `process.platform === 'darwin' && app.dock`, then calls `app.dock.setBadge()`. The renderer's planned-payments due count therefore silently does nothing off macOS (Windows taskbar overlay and Linux Unity badge both unsupported by this call).
  - Fix: use cross-platform `app.setBadgeCount(clamped)` (macOS dock number, Linux Unity count) and/or `setOverlayIcon` on Windows instead of the darwin-gated `app.dock.setBadge`.

- [ ] **`setAboutPanelOptions` is never called and the About item is macOS-only — Windows/Linux have no About/version surface in the menu** ⏬ *(native sibling of the filed in-app "About with no about" finding)*
  - ↪ _from: UI/UX review 2026-07-10 · Wave R2_
  - `app.setAboutPanelOptions` appears nowhere (grep clean) and `{ role: 'about' }` lives only in the darwin-guarded app submenu (`main.js:2892-2895`). macOS shows a bare Info.plist panel with no branded copyright/credits; Windows/Linux menus have no About entry — no in-menu way to see the running version.
  - Fix: call `app.setAboutPanelOptions({ applicationName, applicationVersion, copyright })` and add a Help-menu "About Vision" item on non-macOS (opening `app.showAboutPanel()` or the in-app About).

- [ ] **nl: four outright mistranslations — wrong word or inverted meaning in visible labels (a page title reads as legal gibberish)** ⏫
  - ↪ _from: UI/UX review 2026-07-10 · Wave R3_
  - `owesPage.title` (nl.json:1495) — en "Who Owes You" → nl **"Openstaande verordeningen"**: "verordeningen" = ordinances/legal decrees, nothing to do with debts; the rest of the page correctly uses schulden/verrekenen. · `insights.topRecipient` (:1079) — en "Top Recipient" → nl **"Topverkoper"** (top *seller*); every sibling key uses "ontvanger" (`insights.topRecipients` "Topontvangers"). · `rebalance.editor.capCash` (:1944) — en "Cap the cash to deploy" → nl **"Maximeer het in te zetten contant"**: "maximeer" = *maximize*, the exact opposite of a cap on a spending guardrail. · `statsPage.pivot.metric` (:2774) — en "Metric" (column header noun) → nl **"Metrisch"** (the adjective, as in metric system); compare correct `tax.comparison.header.metric` "Metriek".
  - Fix: `owesPage.title` → "Wie is jou nog geld schuldig" (or "Openstaande schulden"); `insights.topRecipient` → "Topontvanger"; `rebalance.editor.capCash` → "Begrens het in te zetten bedrag"; `statsPage.pivot.metric` → "Metriek".

- [ ] **nl: Netherlands property-tax term "onroerendezaakbelasting" (OZB) on Belgian tax surfaces — one concept, four spellings, one of them the wrong country's tax** 🔼
  - ↪ _from: UI/UX review 2026-07-10 · Wave R3_
  - "Onroerendezaakbelasting" is the *Dutch* municipal OZB; the Belgian tax is **onroerende voorheffing**. NL-term sites: `tax.card.totalWithPropertyEstimate.desc`, `tax.pit.row.propertyTaxEstimate` ("Geschatte onroerendezaakbelasting"), `tax.pit.row.totalWithPropertyEstimate`, `tax.profile.section.residences.desc`, `tax.suggestions.multipleResidencesNote`. Variants: `tax.profile.field.cadastralIncome.desc` "onroerendegoedbelasting"; `tax.profile.region.flanders.desc` + `realestate.howItWorks` "onroerendgoedbelasting". Meanwhile `tax.propertyTax` already gets it right: "Onroerende Voorheffing".
  - Fix: standardize all these keys on "onroerende voorheffing" (the annual regional real-estate tax based on kadastraal inkomen), matching `tax.propertyTax`.

- [ ] **nl: "Dependents" calqued as "afhankelijken" instead of the Belgian fiscal term "personen ten laste" — which the app already uses correctly two keys away** 🔼
  - ↪ _from: UI/UX review 2026-07-10 · Wave R3_
  - `tax.profile.field.dependents` "Afhankelijken"; also `tax.automation.automaticDesc` "op basis van afhankelijken", `tax.profile.section.exemptions.desc`, `tax.profile.field.personalExemption` "(incl. afhankelijken)", `tax.suggestions.childcare.suggest` "U heeft afhankelijken". The correct fiscal term is in the same file: `tax.profile.dependents.children.desc` "Kinderen **ten laste**", `tax.profile.field.childrenDisabled.desc` "schaal van kinderen ten laste".
  - Fix: replace "afhankelijken" → "personen ten laste" at the five sites (label "Personen ten laste").

- [ ] **nl: withholding tax rendered two ways within `tax` — "roerende voorheffing" vs generic/NL "bronbelasting"** 🔼
  - ↪ _from: UI/UX review 2026-07-10 · Wave R3_
  - `tax.dividendWithholding`/`dividendWhtPaid`/`dividendWhtNetCost`/`estimatedDividendWht` all correctly use "roerende voorheffing", but `tax.rules.investment.dividends` ("daarna 30% **bronbelasting**") and `tax.rules.investment.savings` ("daarna 15% **bronbelasting**") switch to the generic/Netherlands term for the same Belgian tax.
  - Fix: use "roerende voorheffing" in both `tax.rules.investment.*` keys.

- [ ] **nl: shared-expense "splits" pluralized as the verb "splitsen" instead of the noun "splitsingen"** 🔼
  - ↪ _from: UI/UX review 2026-07-10 · Wave R3_
  - Singular is fine (`owesPage.split` "{n} splitsing", `owesPage.deleteSplit` "Splitsing verwijderen") but the plural uses the infinitive verb: `owesPage.splits` "{n} splitsen", `owesPage.outstandingSplits` "Openstaande splitsen", `owesPage.settleAll.confirmTitle`/`confirmDescription` "openstaande splits(en)". The noun plural of "splitsing" is "splitsingen".
  - Fix: "{n} splitsingen" / "Openstaande splitsingen" / "openstaande splitsingen" at the four sites.

- [ ] **nl: `rebalance` renders "cash" as physical "contant" in four keys and keeps English "cash" in two others** 🔽
  - ↪ _from: UI/UX review 2026-07-10 · Wave R3_
  - `rebalance.availableCash` "Beschikbaar contant", `rebalance.editor.capCash` "…in te zetten contant", `rebalance.subtitle` "Zet besteedbaar contant in…", `rebalance.totalDeployedHint` "Contant verdeeld over…" — standalone "contant" reads as coins/notes, unnatural for investable liquidity — while `rebalance.title` "Cash-bewust herbalanceren" and `rebalance.noSellNote` "Cash-bewust:" keep "cash".
  - Fix: standardize on "cash" ("Beschikbare cash", "besteedbare cash") to match the title's established usage.

- [ ] **nl: "koers" vs "prijs" for security prices, and three different refresh verbs, across the investment surfaces** 🔽
  - ↪ _from: UI/UX review 2026-07-10 · Wave R3_
  - Price: `addInv.label.currentPrice` "Huidige **koers** per eenheid" vs `addInv.label.pricePerUnit` "**Prijs** per eenheid"; `portfolio.refreshPrices` "**Koersen** verversen" vs `portfolio.stalePricesBanner` "**prijs**(en) zijn verouderd" vs `performance.emptyDescription`/`networth.emptyDescription` "Vernieuw **beleggingsprijzen**". Refresh verb: "verversen" (`portfolio.refreshPrices`, `exchangeRates.refresh`) vs "vernieuwen" (`portfolio.refreshPricesFailed`, `exchangeRates.refreshError`) vs "bijwerken" (`portfolio.refreshPricesFailedTitle`) — three verbs for one action, two of them inside the same success/failure toast pair.
  - Fix: "koers(en)" for quoted-security prices throughout; one refresh verb (suggest "vernieuwen") across portfolio/addInv/exchangeRates/performance/networth.

- [ ] **nl: "portfolio" vs "portefeuille" split across portfolio/performance namespaces** 🔽
  - ↪ _from: UI/UX review 2026-07-10 · Wave R3_
  - `portfolio.overviewTitle` "Portefeuille Overzicht" and `research.forecast.title` "Portefeuilleprognose" vs `portfolio.portfolioValue` "Portfoliowaarde", `portfolio.deleteTxnFailedTitle` "portfoliotransactie", and the whole `performance` namespace ("Portfoliorendement", "Portfoliowaarde over tijd", `performance.relativePortfolio` "Portfolio").
  - Fix: pick one — "portefeuille" is the standard Dutch — and apply consistently (note `portfolio.overviewTitle`'s "Portefeuille Overzicht" should then also become the compound "Portefeuilleoverzicht").

- [ ] **nl: English time-phrase calques — "over tijd" ×3 and "all time" translated three different ways** 🔽
  - ↪ _from: UI/UX review 2026-07-10 · Wave R3_
  - "over tijd" (anglicism): `networth.overTime` "Nettovermogen over tijd", `performance.valueOverTime` "Portfoliowaarde over tijd", `statsPage.subtitle` "…nettosaldo over tijd" — while the natural "in de loop van de tijd" already appears in `statsPage.chart.monthlyDesc` and `customChart.selectDesc`. "all time": `performance.period.all` + `insights.allTime` "Alle tijd" vs `networth.allTime` "alle tijden" vs `insights.topBySpendDesc` "over alle tijd".
  - Fix: "over tijd" → "in de loop van de tijd" (or restructure: "Verloop van je nettovermogen"); standardize "all time" as "hele periode".

- [ ] **nl: `research` translates "rebase" two ways and mints the undecipherable abbreviation "VKS-rendement"** 🔽
  - ↪ _from: UI/UX review 2026-07-10 · Wave R3_
  - Rebase: `research.builder.rebase` "Herbaseren naar 100" + `research.builder.preset.rebased` "Herbaseerde overlay" (anglicism) vs `research.compare.rebased` "Herschaald naar 100" + `research.compare.subtitle`/`research.entry.compare` "herschaald naar 100". FCF: `research.metric.fcfYield` "VKS-rendement" — a homemade abbreviation no user will decode, while neighbours spell out "Vrije kasstroom" (`research.metric.freeCashFlow`).
  - Fix: "herschaald naar 100" everywhere (or "geïndexeerd naar 100"); "VKS-rendement" → "FCF-rendement" (FCF is the recognized term, kept in `market`/`research` peers).

- [ ] **nl: `tax` surcharge term flips ("opcentiemen" vs "toeslag") plus two spelling/agreement slips** 🔽
  - ↪ _from: UI/UX review 2026-07-10 · Wave R3_
  - Surcharge: "gemeentelijke opcentiemen" (correct, used in `tax.pit.row.communalSurcharge`, `tax.card.totalPIT.desc`, `tax.profile.section.region.desc`) vs "Gemeentelijke **toeslag**" (`tax.profile.field.communalSurcharge`, `tax.profile.section.region.title`). Spelling: "belasting**s**vrije som" (`tax.profile.field.personalExemption`, `tax.profile.dependents.children.desc`) vs standard "belastingvrije som" (`tax.profile.field.isolatedParent.desc` has it right). Agreement: `tax.suggestions.multipleResidencesNote` "staat **in de** algemene belastingtotaal" (het-woord → "in het"); `insights.detailsSubtitle` "gemiddelde transactiebedrag" → "gemiddeld transactiebedrag".
  - Fix: "opcentiemen" throughout; "belastingvrije som"; correct the two agreement errors.

- [ ] **nl nits: verbatim-duplicate parenthetical, dropped qualifier, and "belegging"-labels vs "investering"-toasts** ⏬
  - ↪ _from: UI/UX review 2026-07-10 · Wave R3_
  - `tax.profile.field.cadastralIncome` — en "Cadastral income (kadastraal inkomen)" → nl "Kadastraal inkomen (kadastraal inkomen)" (the parenthetical duplicates the term verbatim). · `tax.profile.field.disabilityExemption.spouse` "Invaliditeitsvrijstelling (Partner)" drops "Spouse". · `portfolio` labels say "belegging" (`portfolio.addInvestment` "Belegging toevoegen") but every failure toast says "investering" (`portfolio.createInvestmentFailed(Title)`, `deleteInvestmentFailed`, `updateInvestmentFailed`, `refreshedPrices` "investering(en)") — a separate split from the filed belegging/positie one.
  - Fix: drop the nl parenthetical; "(Echtgenoot/partner)"; use "belegging" in the toasts.

- [ ] **Links rejected by `safeHref` become dead anchors that keep full clickable hover affordance — and protocol-relative feed URLs are wrongly rejected too** 🔼
  - ↪ _from: UI/UX review 2026-07-10 · Wave R4_
  - `utils/safeHref.ts:15` returns `undefined` for anything not matching `^https?:\/\//i`, and consumers render that straight into `href` with no fallback. In the news feeds the *whole card* is the anchor (`components/portfolio/PortfolioNewsFeed.tsx:100-137`, `components/research/ResearchNewsTab.tsx:57-88`): with `href={undefined}` the `<a>` is inert and not keyboard-focusable, yet `hover:bg-muted/50`, `group-hover:text-primary`, and the fade-in ExternalLink icon all still fire — a card that promises a click and does nothing. Same dead-affordance on `pages/PlannedPaymentsPage.tsx:197` and `AboutSection.tsx:192` (inert icons keeping their "Open related link"/"Release notes" tooltips) and `UpdateNotification.tsx:214` (enabled-looking Button that does nothing). Aggravator: the regex requires literal `http(s)://`, so *protocol-relative* URLs (`//cdn.example.com/article`, common in news/RSS payloads) are rejected — legitimate safe articles silently become dead cards, not just `javascript:`/`data:` ones. *(The security intent of d975084 is correct — this is about the degraded-state UX, not the guard.)*
  - Fix: when `safeHref` returns `undefined`, render a non-anchor container without the hover affordances (or a muted "link unavailable" state) in the news feeds, and hide the icon/button affordances entirely; treat protocol-relative URLs as safe by resolving against `https:`.

- [ ] **NetSummaryCard bar segments' new `role="img"` labels announce only "Income"/"Spending" — not the value or proportion the graphic encodes** ⏬
  - ↪ _from: UI/UX review 2026-07-10 · Wave R4_
  - `components/dashboard/NetSummaryCard.tsx:106-117` (added post-audit in 5120a7f): each segment gets `aria-label={t('dashboard.stat.income')}` / `…spending` — literally just the word. The information is the segment *width* (`incomePct`/`spendingPct`), never stated, so a screen reader hears "Income, image" with no magnitude (the raw amounts do exist as adjacent text at `:122/:125`, limiting harm).
  - Fix: compose value into the label (`"Income: €3,210 (64%)"`) or mark segments `aria-hidden` and give the whole bar one summarizing `role="img"` label, since the amounts are announced below anyway.

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
  - Verification (2026-07-03, Wave A2 residue): the full inventory is wider — 16 imports across 12 repo files, not 13/8: the whole info* family imports `convertRowsToEur` (`infoRepo.statistics.js:6`, `infoRepo.monthly.js:7`, `infoRepositoryNetWorth.js:9`, `infoRepositoryPlanned.js:6`, `infoRepositoryTags.js:17`, `infoRepositoryStatistics.js:6`, `infoRepositoryRecipients.js:12`, `infoRepositoryHelpers.js:7`), plus `infoRepositoryPlanned.js:8` (`calculateNextDate`). These "repos" are effectively read-services — rename/move, or document the exception in code-patterns.md.

- [ ] **Portfolio math services duplicate each other's inline SQL and bypass repositories entirely** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `services/portfolio/portfolioSummaryService.js:60-82` and `services/portfolio/snapshotBuilder.js:65-100` contain near-identical `investments` + `portfolio_transactions` loading queries (same COALESCE/`to_char(pt.date::date,'YYYY-MM-DD')`/JOIN shape, drifting only in columns/filters); neither file imports `investmentRepository` or `portfolioTransactionRepository`.
  - fix: extract one shared portfolio-rows read (in `portfolioTxRepo.reads.js`) parameterized by date window/asset-class filter and use it from both services.

- [ ] **info repository cluster is over-fragmented with two coexisting naming schemes and double barrels** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: 11 `info*` files in `repositories/` mix `infoRepositoryX.js` and `infoRepo.x.js` naming; `repositories/infoRepository.js` (barrel) re-exports `repositories/infoRepositoryMonthly.js`, which is itself only a 24-line barrel over `infoRepo.monthly.js`/`infoRepo.statistics.js`/`infoRepo.forecast.js` (see its header). Same dir also has the third scheme `portfolioTxRepo.{common,reads,writes}.js` under barrel `portfolioTransactionRepository.js:1-9`.
  - fix: pick one split convention (subdirectory `repositories/info/` with one barrel), delete the pass-through middle barrel, and rename dot-files to match.
  - Verification (2026-07-03, Wave A2 residue): `infoRepo.*` has no consumers outside `repositories/` — confirming it's pure internal fragmentation, not an external contract, and safe to flatten.

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

- [ ] **marketLookup.js is a service embedded in a route file, duplicating the Yahoo adapter surface** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: `routes/marketLookup.js:19-258` carries a module-level TTL cache + in-flight coalescing map, its own `YahooFinance` client (:57), and ~160 lines of quote assembly (`mapQuoteCore`:121, `buildQuote`:148, `getCachedQuote`:231) — the clearest remaining ADR-067 boundary loophole. The same upstream is independently wrapped by `services/research/adapters/yahooAdapter.js` (a second `YahooFinance` instance with its own mapping).
  - fix: extract into `services/marketLookupService.js` and consolidate the two Yahoo client instances.

- [ ] **ADR-090 (cash-sleeve-trades-as-transfers) vs ADR-083 (internal-transfer-detection): the contradiction is a real, dormant bug, not just a doc conflict** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · ADR re-run (backend, re-run 2026-07-03)_
  - The 2026-06-25 addendum widened `releaseOrphans()` to `WHERE is_transfer AND transfer_peer_id IS NULL` (`transferReconciliationService.js:53-59`) with no `transfer_source='trade'` carve-out — silently invalidating ADR-090's isolation claim. A trade cash leg is inserted single-sided as `is_transfer=true, transfer_source='trade', peer NULL` (`tradeCashLegService.js:66-79`), so the next `reconcileTransfers()` (runs after every import commit/edit) would release it, re-entering it into income/spending and breaking the ADR-090 double-count guard. The stale isolation claim survives verbatim in `tradeCashLegService.js:5-9` and in ADR-090's own text; the regression test ADR-090 explicitly required ("single-sided 'trade' leg survives reconcileTransfers") was never written (`tests/tradeCashLegService.test.js` doesn't touch the reconciler). Currently dormant: under the ADR-103 default flag, trades get no `account_id`, so `createTradeCashLeg` no-ops — brokerage/portfolio-import commit paths would arm it.
  - fix: add `AND transfer_source IS DISTINCT FROM 'trade'` to `releaseOrphans`, write the missing regression test, and add an ADR-083 addendum note recording the exception.

- [ ] **usePlannedPayments hand-rolls server state entirely outside React Query** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A3_
  - evidence: `hooks/usePlannedPayments.ts:199-302` uses manual `useState`/`useEffect`/`mountedRef` fetching — no cache sharing with the rest of the app, no invalidation alongside sibling query keys, a hand-rolled race guard. It also carries a 140-line untested `PlannedPayment`↔`PlannedTransaction` DTO remapping layer (:54-197) that belongs in lib/ with its own tests.
  - fix: migrate to `useQuery` and extract the DTO mapper into a tested lib module.

- [ ] **Navigation registry triplicated across CommandPalette, AppSidebar, and useGoToShortcuts** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: page lists are hand-maintained three times — `components/shared/CommandPalette.tsx:73-106,289-301`, `components/layout/AppSidebar.tsx` (~34 entries), `hooks/useGoToShortcuts.ts:7-25` — and the admin list already diverges between them.
  - fix: extract a single `lib/navigation.ts` registry all three consume.

- [ ] **Symbol-search wiring copy-pasted ×4 across research pages** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: identical debounce+query+open-condition blocks (~60-80 lines each) at `pages/research/ResearchComparePage.tsx:203-225,362-379`, `ChartBuilderPage.tsx:116-143,470-503`, `MarketLookupPage.tsx:151-160,184-189,288-303`, `ResearchHomePage.tsx:50` — the UI itself is already shared (`SymbolSearchBox.tsx`), only the wiring is duplicated.
  - fix: extract a `useSymbolSearch(searchFn)` hook.

- [ ] **Splits type-fidelity cluster: frontend types describe rows the backend never actually returns** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: (1) `POST /api/splits/:id/pay` returns the raw row with an un-coerced pg NUMERIC string `amount` (`splitRepository.js:396`; sibling `getPayments` coerces at :406-409 — the POST path was missed) vs `SplitPayment.amount: number` — latent only because `useSplits.ts:51-58` ignores the response; (2) split create/batch return raw `RETURNING *` rows (`splitRepository.js:111,162` — string amount, no `recipient_name`/`paid` fields) but are typed `SplitItem[]` (`lib/api/splits.ts:64-67`); (3) phantom field `SplitItem.paid_amount` (`lib/api/splits.ts:10`) — the backend emits `amount_paid` (`splitRepository.js:497`); (4) two parallel drifted splits type families: `lib/api/splits.ts:4/18/28/39` ↔ `types/splits.ts:3/26/16/35` (`SplitPayment` declared twice; `lib/api.ts:311` re-exports the lib one, the types/ copy is mostly dead — only `SplitCreateInput` is imported).
  - fix: consolidate onto backend-accurate shapes in one home.

- [ ] **aiChat frontend types describe payloads the backend has never sent** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: `TokenUsage` (`types/aiChat.ts:59-63`: `promptTokens`/`completionTokens`/`totalTokens`) shares zero fields with the actual payload (`evalCount`, `promptEvalCount`, `totalDurationMs` — `aiChatService.js:127,225`); `ConversationSummary.messageCount` is required but never selected (`aiChatRepository.js:16-17`); `ChatMessage` lacks the backend's `status` field (`aiChatRepository.js:18-21`); `OllamaModel` drifts both ways (`ollama/client.js:151-159`).
  - fix: regenerate these types from the actual response shapes and add them to the contract-guard coverage below.

- [ ] **openapi.yaml drift is the root cause of the FE type-fidelity gaps — contract-guard covers only 8 core schemas** ⏫
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: `generated.ts`'s `Split` (:3509-3520), `SplitOwed` (:3521-3526), `WatchlistItem` (:3536-3546, documents a never-returned `current_price`), `AiConversation` (:3547-3554, wrong casing), and `Attachment` (:3527) are all stale vs. actual responses, and `types/contract-guard.ts:58-65` doesn't guard any of them — so the drift is invisible to CI.
  - fix: fix the spec at `apps/node-backend/openapi.yaml:1106/1131/1164/1186`, then extend contract-guard to assert against these schemas.

- [ ] **openapi.yaml documents a 200+JSON body for 5 DELETE endpoints that actually return 204 No Content** ⏫ 🔧 *(undercounted — a 5th instance found during verification)*
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - `watchlist.js:89`, `savedCharts.js:169`, `investmentController.js:377`, `investmentController.js:483`, and **`routes/ai.js:217` (`DELETE /api/ai/conversations/:id`)** (all `res.status(204).send()`) vs. `openapi.yaml:4457-4468,2408-2418,4080-4090,4012-4022,5007-5017` (all declare 200 + Envelope body)
  - Sibling endpoints (only 2 in the whole spec: `deleteCustomParser`/`deletePortfolioParser`) correctly document 204, confirming this is inconsistent application, not deliberate.
  - Fix: update openapi.yaml to 204 for all 5 paths.

- [ ] **`GET /api/market/quote` — spec parameter name doesn't match the handler** ⏫ 🔎 verified-present 2026-07-11
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
  - Verification (2026-07-03, Wave A1 residue): splitRepository throws these HTTP-flavored errors at :86,:105,:127,:151,:333,:347 — sibling repos `portfolioTxRepo.common.js:101`/`aiChatRepository.js:25` instead mint layer-neutral coded errors, which is the cleaner seam to converge on.

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
  - **Perf addendum (Performance research 2026-07-05 · Wave P3):** the re-render fan-out has a concrete per-keystroke trigger — tax-profile wizard inputs write to the context per keystroke (`components/tax/profile-steps/ExemptionsStep.tsx:128-162`, `RegionStep.tsx:64` `onChange → updateProfile`), each keystroke recomputing `computeBelgianPIT(profile)` (`BelgianTaxProfileContext.tsx:532`) AND, via `displayCalculationForYear` identity churn (`:398-411,:535-542`), re-running the full PIT engine × N displayed years in `MultiYearTrendStrip.tsx:54-70` while re-rendering all ~12 tax surfaces behind the sheet. Live preview is intended; the ×N-year recompute per keystroke is not. The zustand migration above absorbs this; short-term, debounce/localize wizard field state (commit on blur) or split profile state from derived-calc selectors. 🔽

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
  - Verification (2026-07-03, Wave A3 residue): more twins found in the same family — `lib/api/market.ts:43/51/65` ↔ `types/research.ts:58/66/28`; a `ForecastMethod` name collides across unrelated domains (`types/research.ts:322`'s union `'parametric'|'block_bootstrap'` vs `lib/api/aggregations.ts:255`'s cashflow interface — rename one); and `AssetClass`/`PortfolioTxnType` are separately declared, with drift, in both `types/api.ts:346-347` and `types/portfolio.ts:6,43`.

- [ ] **Root config/ is half-dead: orphaned drifted copies of frontend configs** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: `config/tailwind.config.ts` (96 lines, last commit 2026-03-10 a63216eb), `config/eslint.config.js` (27 lines), `config/tsconfig{,.app,.node}.json`, `config/postcss.config.cjs`, `config/components.json` are referenced by nothing — the frontend carries its own actively-maintained copies (apps/frontend/tailwind.config.ts 191 lines, last commit 2026-06-24 6785a3eb; eslint 52 lines) that neither extend nor import them. CLAUDE.md documents `config/` as "shared tsconfig/vite/eslint/tailwind", which is false today; the directory also holds genuinely load-bearing files (`config/alembic.ini` via root package.json:37-42, config.py, gitleaks.toml, commitlint.config.mjs), so live and dead configs are interleaved.
  - fix: delete the dead frontend-config copies (or make apps/frontend actually extend them) and correct the CLAUDE.md description of config/.

- [ ] **Recurrence vocabulary forked: 'bi-weekly' vs 'biweekly', plus in-FE duplicate enum** 🔼
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: portfolio recurrence uses `'bi-weekly'` (apps/frontend/src/types/portfolio.ts:63, types/api.ts:348 — identical `RecurrenceInterval` declared twice in FE — and generated.ts:3352), while planned-transaction recurrence uses `'biweekly'` (apps/node-backend/src/services/calculations/recurrence.js:20 `SUPPORTED_PATTERNS`, FE hooks/usePlannedPayments.ts:22). Two hand-maintained vocabularies for the same concept, differing only in a hyphen — a standing trap for anyone unifying planned/portfolio recurrence.
  - fix: define one shared recurrence-token list in `@vision/types` (breaking-change note: aligning the wire value needs a compat mapping) and delete the duplicate FE declaration.

- [ ] **`PATCH /api/investments/{id}` — accepted `show_in_ticker` missing from the request schema** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - `investmentController.js:359-371` forwards `req.body` (upserts `show_in_ticker` per `docs/api/investments.md:246-251`) vs. `openapi.yaml:4051-4067`'s PATCH body, which lists only `name, symbol, asset_class, currency, is_active`
  - A prior commit added `show_in_ticker` to the **response** schema but never the request schema — a half-finished fix.
  - Fix: add `show_in_ticker: boolean` to the PATCH requestBody schema.

- [ ] **`POST /api/investments/{id}/move` — undocumented `strategy` field** 🔼 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - `investmentController.js:452-458` reads `strategy` (`'fifo'|'proportional'`) vs. `openapi.yaml:4217-4232` documenting only `from_account_id, to_account_id, units`.
  - Fix: add `strategy` enum to the requestBody schema.

- [ ] **`api-endpoint-matrix.md` self-contradicts on operation count, invisible to CI** 🔼 🔎 verified-present 2026-07-11
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

- [ ] **`api-endpoint-matrix.md` stale on `amount_signed`** 🔽 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - `:55` (GET /api/transactions row) still lists only `amount_min/max/exact`. Commit `692fd9b1` added `amount_signed` to `docs/api/transactions.md`/`docs/features/transactions.md` but never touched the matrix.
  - Fix: append `amount_signed` to the matrix row.

- [ ] **sankey.js is the only aggregation module running raw SQL** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: `services/calculations/aggregation/sankey.js:21,62-78` imports `database/connection.js` and inlines a query in the calc layer; all 13 sibling aggregation modules delegate to `infoRepository*` instead. It also hardcodes English node labels server-side.
  - fix: move the query into an infoRepository method and pass localized labels in from the caller.

- [ ] **Preview view-model assembly lives in the route layer for both import pipelines** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: review grouping/label-formatting/totals are built inline at `routes/importRoutes.js:404-477` (74 lines) and `routes/portfolioImportRoutes.js:334-400` (66 lines) — service-shaped logic sitting in the route handler.
  - fix: extract into a shared preview-assembly service function per pipeline.

- [ ] **ADR-030 env-discipline has undocumented leaks, and the env vars involved are absent from the Zod schema** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: `process.env` is read outside `config/env.js` beyond the documented logger exception: `database/migrate.js:21,24,30`, `services/reports/puppeteerRenderer.js:21` (`PUPPETEER_EXECUTABLE_PATH`), `main.js:397` (`VISION_BOOT_TRACE`) — none of these are declared in the Zod schema (logger's `LOG_LEVEL`/`ENABLE_LOGGING` are also absent from it).
  - fix: add the missing keys to the Zod schema even if the reading site stays outside `config/env.js`, so every env var the app reads is at least documented and validated once.

- [ ] **importRoutes ↔ portfolioImportRoutes copy-paste (~120 lines)** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: parser-CRUD blocks are near-identical modulo kind+normalizer (`importRoutes.js:191-235` vs `portfolioImportRoutes.js:260-300`, including a duplicated 23505→Conflict translation) and so are the batch list/get/rollback handlers (`:359-398` vs `:304-330`).
  - fix: a parameterized sub-router factory removes the duplication.

- [ ] **investmentRepository ↔ portfolioTxRepo.common: verbatim duplication of validation/SQL-builder helpers** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `makeValidationError` (`investmentRepository.js:122` vs `portfolioTxRepo.common.js:101`), `buildUpdateSql` (:144 vs :316), and the whole inheritance-schema probe/error-classifier suite (:21-70 vs :15-70) are duplicated between the two files.
  - fix: extract a shared inheritance-table helper module.

- [ ] **Report-section scaffolding is repeated ~40× across the 20 PDF renderers** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: every renderer hand-writes the `page`/`section-title`/`section-divider` shell twice (empty + populated path). Related duplication in the same family: two empty-state CSS classes for one concept (`empty-notice` vs `placeholder-notice`, e.g. `sections/bankBalances.js:29` vs `topHoldings.js:32`); `ASSET_CLASS_LABELS` duplicated 3× (`topHoldings.js:9`, `portfolioAllocation.js:9`, `assetClassDetail.js:10`); a near-verbatim snapshot→asset-class bucket builder (`portfolioAllocation.js:42-64` vs `assetClassDetail.js:41-60`); camel/snake dual-reads (`inv.currentValue ?? inv.current_value`) repeated in 4 renderers instead of normalized once in `dataFetcherPortfolio`; a duplicated filtered/all chart-pair + filter-notice block (`categoryBreakdown.js:46-77` vs `topRecipients.js:44-75`).
  - fix: add `sectionShell()`/`emptySection()` helpers to `sectionHelpers.js` (removes ~200 lines) and normalize the camel/snake reads once in the data fetcher.

- [ ] **`quantile()` and zero-fill densify logic each duplicated across forecast method modules** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `forecast/methods/monteCarloParametric.js:18-26` is a verbatim copy of `monteCarloBlockBootstrap.js:19-27`'s `quantile()`; separately, a shared `forecast/_densify.js` exists yet `holtWinters.js:24-43` and `prophetLite.js:105-122` keep private zero-fill densify copies.
  - fix: hoist `quantile()` into a shared forecast helper and switch `holtWinters`/`prophetLite` onto `forecast/_densify.js`.

- [ ] **8 fully dead exports found in a scripted export-vs-import diff over services/, repositories/, lib/, utils/** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `releaseAutoPairsFor` (`transferReconciliationService.js:213` — orphaned when reconcile went debounced-full-corpus), `clearReachabilityCache` (`lib/network.js`), `formatDateToYm` + `getUtcDayEndTimestamp` (`repositories/infoRepositoryHelpers.js:96-126`), `findBestRecipientMatch` (`services/calculations/normalization.js`), `readFileAsync` (`services/importPipeline/adapters/_shared.js`), `DATA_TYPES` (`services/research/capabilityMap.js`), and the `daysBetweenYmd` re-export (`utils/portfolioMath.js:21`) have zero references anywhere, not even in their own file or tests. Also dead: `fmtCurrencyCompact` (`services/reports/sectionHelpers.js:54`) and the env key `IMPORT_PIPELINE_V2` (`config/env.js:108`, validated + documented, zero consumers).
  - fix: delete all 8; drop the `IMPORT_PIPELINE_V2` env key or wire it to an actual toggle.

- [ ] **Repository return-shape has a genuine split-brain vs the pattern doc: newest repos return `undefined`, not the documented `rows[0] || null`** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `docs/reference/code-patterns.md:373-374` documents `rows[0] || null` at the repository boundary as a deliberate exception to the project-wide "never null" rule, but the newest repos return `undefined` instead: `accountRepository.js:57,62,109,141` (`?? undefined`), `customParserConfigRepository.js:66`, `portfolioImportBatchRepository.js:47,125` (bare `rows[0]`) — while sibling `importBatchRepository.js:75` still uses `?? null`. All other repos conform to the documented `null` exception.
  - fix: either bless `undefined` going forward in code-patterns.md, or align the three newer repos back onto `?? null`.

- [ ] **aiChatStreamStore emits a new `activeIds` array on every token, not just on membership change** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A3_
  - evidence: `emit()` (`lib/aiChatStreamStore.ts:138-141`) dirties the `getActiveConversationIds` cache (:148-157) on every event including token deltas, so `useActiveStreams` consumers (`ChatConversationList`) re-render per token even when the active set itself hasn't changed. The store is otherwise sound.
  - fix: compare-before-swap in the rebuild so the cache only changes when the active set actually changes.

- [ ] **useStatistics.ts has four near-identical filtered `useQuery` blocks** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A3_
  - evidence: `hooks/useStatistics.ts:243-307` repeats the same filtered-query shape four times. (No duplication with `lib/api/aggregations` — the server aggregates, the hook only reshapes.)
  - fix: a small query factory halves the boilerplate.

- [ ] **RangeSelector's `RANGES` const + pill row is byte-identical across 4 sites** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: ~35 duplicated lines at `pages/research/ResearchComparePage.tsx:31-37,397-409`, `ChartBuilderPage.tsx:25-31,390-396`, `MarketLookupPage.tsx:36-45,424-436`, `components/watchlist/WatchlistChartDialog.tsx:28`.
  - fix: extract a shared `RangeSelector` component/const.

- [ ] **OwesPage.tsx bundles three components and a lib-shaped infinite-scroll implementation in one 478-line file** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: `pages/OwesPage.tsx` (478 lines) holds three components in one file; its manual offset/ref infinite-scroll (:350-407) is shaped like a reusable `useInfiniteQuery`-style hook, not page-local logic.
  - fix: move detail+table components to `components/owes/` and extract the infinite-scroll logic into a hook.

- [ ] **PlannedPaymentsPage.tsx mixes 217 lines of inline column defs with lib-shaped date/multiplier math** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: `pages/PlannedPaymentsPage.tsx` (532 lines): 217-line inline column definitions (:154-371); frequency→monthly multiplier math (:119-131) and `dueBadge` date parsing (:41-70) are lib-shaped, not page-local; 4 copy-pasted stat cards (:446-494).
  - fix: extract the multiplier math and date parsing into lib helpers, and share the stat-card markup.

- [ ] **Tax components repeat a currency formatter, a lock/frozen indicator, and a numeric-field pattern across files** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: `fmtCurrency` copy-pasted ×3 (`components/tax/YearComparisonCard.tsx:74-80`, `MultiYearTrendStrip.tsx:46-52`, `SuggestedDeductionsCard.tsx:17`); a filed/frozen Lock/Snowflake indicator repeated ≥6 sites (`YearComparisonCard.tsx:164-169,194-199`, `MultiYearTrendStrip.tsx:113-124`, `TaxYearSwitcher.tsx:82-88`, `YearActionsMenu.tsx:84-100`, `HistoricalYearBanner.tsx:58`); a `ProfileNumberField`-shaped pattern repeated in `IncomeStep.tsx:37-60,104-156,210-233`.
  - fix: extract `fmtCurrency` to the shared currency formatter, a `<YearStatusIcon>` for the lock/frozen indicator, and a `ProfileNumberField` component for profile-steps.

- [ ] **Locale-generation has a dead env flag and a broken electron fallback path** 🔽
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: `GENERATE_LOCALES_AST=1` is set in `packaging/electron/package.json:9-10` + `apps/frontend/package.json:10` but never read by `scripts/generate-locales.js`; the electron fallback resolves to a nonexistent `packaging/i18n` path (`packaging/electron/main.js:342-357` — harmless, the real fallback is at :17-49); the root build runs the generator twice (`package.json:17` + the frontend build step).
  - fix: delete the dead `GENERATE_LOCALES_AST` flag, fix or remove the dead fallback path, and dedupe the double generator run.

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

- [ ] **Repo pivot helpers use three different positional-argument conventions** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `getCategoryPivot(exclCat, currency, exclRecip)` vs `getRecipientByYear(currency, exclRecip, exclCat)` vs options-object styles — three positional conventions across sibling repo calls.
  - fix: converge on one calling convention (options object is the safest against future argument-order mistakes).

- [ ] **Aggregation invariant-assertion coverage is inconsistent, and one doc/export name mismatches** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: 6 aggregation wrappers assert invariants (`monthly`, `cashflow`, `category`, `recipient`, `averageVsCurrent`, `bankBalances`) but `categoryPivot`/`recipientPivot`/`recipientByYear`/`tagPivot`/`sankey`/`cashflowForecast` don't; separately, `_invariants.js:8`'s doc comment says `assertNaN` but the actual export is `assertNoNaN`.
  - fix: add invariant assertions to the 6 uncovered aggregations; fix the doc-comment name.

- [ ] **lib-shaped utilities are parked inside infoRepositoryHelpers.js** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: UTC date helpers (:96-126), `roundToCents` (:86, an alias of `lib/money`'s `roundMoney`), and `sanitizeIsolatedDailyInvestmentSpikes` (:234, a smoothing heuristic — business logic) all sit in a repository-helpers file.
  - fix: move to `lib/` or a calculations service.

- [ ] **16 stale "Mirrors: apps/backend/….py" file headers reference the deleted Python backend** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: e.g. `importRoutes.js:3`, `config/logger.js:8`, and 14 others carry a header comment mirroring a Python backend that no longer exists.
  - fix: delete the stale header comments in a mechanical sweep.

- [ ] **backup/coverage.js's verification-stamp comment is stale** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `coverage.js:22` says "Last verified against: 0035" while migrations are at 0064. Comment-only drift — the table list itself is CI-enforced (`tests/backup-coverage.test.js`) so the content is current.
  - fix: update the comment (or make it self-updating from the migration count).

- [ ] **Small report/aggregation hygiene items: themeCss fallback duplication, page-break inconsistency, fetcher logic in renderers, redeclared unit vocab, and a Bucket typedef gap** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `themeCss.js:28-66` hand-copies 32 fallback-only tokens from the frontend theme; the page-break CSS convention splits between `page page-break` and bare `page` across section renderers; fetcher-shaped logic sits inside renderers (`performanceTrend.js:29-38`, `portfolioExecutiveSummary.js:28-44`); range vocabulary is redeclared per research adapter across 4 unit systems; `requestMetrics.js:37` adds a `sampled` field missing from the `Bucket` typedef (:22-28).
  - fix: low urgency — fold in opportunistically when each file is next touched.

- [ ] **Several lib-shaped pieces of logic are co-located inside components instead of extracted** ⏬
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: `OnboardingWizard` co-locates its `useOnboarding` hook (the react-refresh lint-disable at `components/onboarding/OnboardingWizard.tsx:26` is the tell); `CommandPalette`'s FX-parser/arithmetic-evaluator/recents-store (`CommandPalette.tsx:119-175`) are lib-shaped; `DashboardPage`'s inline page-scanning `queryFn` (`pages/DashboardPage.tsx:115-159`) and `PortfolioOverviewPage`'s sparkline builder (:147-186) are likewise lib-shaped.
  - fix: extract each into hooks/ or lib/ as appropriate; no urgency.

- [ ] **FX fallback in portfolio P&L hook silently uses the current (not point-in-time) rate, with no acknowledging comment** ⬇ 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · Architecture & API Contract · API ↔ openapi.yaml drift_
  - `apps/frontend/src/hooks/portfolio/useFxAwarePnl.ts:48-50` falls back to live-rate `getRateToEur` when `fx_rate_to_eur` is missing/zero
  - `docs/adr/085-belgian-tax-point-in-time-fx.md` sanctions an identical fallback for the *tax* path as "a transient approximation that self-corrects" — confirmed via official FOD Financiën guidance that point-in-time FX is indeed the technically correct convention for Belgian capital-gains/TOB valuation. The portfolio P&L hook has the same trade-off with no equivalent comment, and silently blends current-rate legs into an EUR cost pool used for gain math. This is a third surface with this pattern, distinct from the one ADR-085 already explicitly waves off (the portfolio-summary "current value display," which is intentionally out of scope).
  - Fix: add a short comment/doc note acknowledging the fallback and its accuracy trade-off; not urgent enough for a code change or new ADR on its own.

- [ ] **generateReport and the multer-instance export both write HTTP concerns directly from services/** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: `services/reports/index.js:568,601-605` takes `res` directly, sets Content-Type/Disposition, and calls `res.end(pdf)`; `services/attachmentService.js:61-71` similarly exports a multer middleware instance (documented rationale — backlog-grade, not urgent).
  - fix: have `generateReport` return `{pdf, filename}` and let the route write the response.

- [ ] **crossWorkspace.js parses/folds target-weights inline in the route** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: `routes/crossWorkspace.js:29-53` — small, but belongs beside `allocationAnalytics`.
  - fix: move the parsing/folding logic into the allocation-analytics service.

- [ ] **Domain logic (buy/sell math, sell-validation policy) lives in portfolioTxRepo.common.js** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: `normalizeBuySellMath` (:116), `normalizeTransactionPayload` (:155), `validateSellUnitsAvailability` (:271) implement buy/sell math and sell-validation policy in the repository layer.
  - fix: hoist into a portfolio-transaction service, leaving the repo as parameterized SQL only.

- [ ] **ADR-067's own doc references a seam module that never existed** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A1_
  - evidence: `docs/adr/067-enforce-route-service-boundary.md:54` lists seam module `portfolioTxService.js` — no git history for it exists, and no route imports `portfolioTxRepo.*` directly, so the boundary holds regardless; this is a documentation errata, not a code gap.
  - fix: correct the ADR text to reference the actual seam files.

- [ ] **Four small copy-paste duplications spread across forecast/, research adapters, dataImportService, and splitRepository** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: ewma/weightedAverage month-dedupe scaffolding copy-paste (`ewma.js:14-28` vs `weightedAverage.js:14-27`); `key()` get-or-throw boilerplate repeated ×5 across research adapters (`fred:18`, `alphaVantage:21`, `twelveData:20`, `finnhub:21`, `fmp:21`); `dataImportService` duplicates its own GENERAL:DETAIL parse/validate block (`dataImportService.js:119-135` vs `:193-207`); `splitRepository` duplicates its FOR-UPDATE+totals preamble (`createSplitAtomic:82-105` vs `createSplitsBatchAtomic:123-151`).
  - fix: hoist the adapter key-lookup as `requireProviderKey()` in `providerKeys.js`; extract the other three shared blocks into small helpers.

- [ ] **~24 exports are used only in their own file — un-export candidates** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `rawTransactionRepository`'s `sabbRawRepo`/`visionRawRepo`/`wiseRawRepo`, `accountService`'s `ACCOUNT_OWNERS`/`LIQUIDITY_CLASSES`, `attachmentService`'s `getAttachmentsRoot`/`getTransactionDir`, `recipientPatternService`'s `compilePattern`/`validatePattern`, `transactionExport`'s `buildCsvFilename`/`buildNdjsonFilename`, `loanSchedule`'s `validateLoanConfig`, `normalization`'s `DEFAULT_MATCH_THRESHOLD`, `adapters/index`'s `REGISTRY`, `allocationAnalytics`'s `REBALANCE_TARGET_ALIASES`, `portfolioTypeNormalizer`'s `BUILTIN_TYPE_ALIASES`, `dataFetcherTax`'s `periodToTaxContext`, `researchCache`'s `TTL_BY_TYPE`, `researchMappingService`'s `AUDIT_PRICE_TOLERANCE`, `aiChat/tools`'s `TOOLS`, `holidays/be`'s `belgianHolidays`, `lib/csvUpload`'s `isLikelyCsvFile`, `infoRepositoryHelpers`'s `getCategoryKey`/`parseCategoryId`, `ewma`'s `DEFAULT_ALPHA`.
  - fix: drop the `export` keyword on all of these; no behavior change.

- [ ] **~70 exports exist only for tests, mostly without the project's own `__`-prefix convention** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: a `__`-prefix convention exists (`__resetInvestmentSchemaCache`, `__clearQuoteCacheForTests`, `__resetPriceCache`) but ~90% of test-only exports don't use it, e.g. `ipMatchesRule` (`rateLimiter.js:38`), `resetMetrics` (`requestMetrics.js:155`), `portfolioMath`'s cost-basis re-exports, and 4 each of `quoteBackfillService`/`priceCache` internals.
  - fix: apply the `__`-prefix convention to the unmarked test-only exports (or move the assertions onto the public surface where one exists).

- [ ] **utils/portfolioMath.js's shared-utils re-export block has no live backend importer** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: the `@vision/shared-utils/portfolio` re-export block (`utils/portfolioMath.js:16-23`) is unused in production — `portfolioSummaryService` imports `shared-utils` directly, FIFO/LIFO/ByMethod are only reached test-only via this path, and `daysBetweenYmd` is fully dead. Two import paths exist for the same functions; the live locals are `toYmd`/`sanitize*`/`calendarDaysBetween`/`computeMetrics`/`computeHeatmap`.
  - fix: delete the unused re-export block (or the dead `daysBetweenYmd`) once test-only callers are updated to import from `@vision/shared-utils` directly.

- [ ] **feeBreakdown.js has a dead identity branch; all 7 forecast method modules export a dead default** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `feeBreakdown.js:37-38`'s comment promises a byInvestment fallback, but `displayRows = rows.length ? rows : []` is an identity no-op. Separately, `forecast/index.js:12-19` consumes the method modules via `import * as`, so their default exports are all dead (ensemble correctly omits one).
  - fix: fix or remove the identity branch; drop the unused default exports from the 6 non-ensemble method modules.

- [ ] **infoRepo.forecast.js is the only repo doing input-range validation, and it does so with untyped `throw new Error`** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `infoRepo.forecast.js:224,337,340,343,444` throw plain `Error` for out-of-range params, which the error middleware normalizes to a 500 instead of a 400.
  - fix: convert to `ValidationError` so bad params 400 instead of 500.

- [ ] **recipientPivot.js/tagPivot.js use `= null` param defaults, against the project's never-null convention** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `recipientPivot.js:16-18` / `tagPivot.js:14-16` default params to `null`, and those nulls flow into repo options.
  - fix: default to `undefined` per convention.

- [ ] **config.js exposes both a `getSettings()` function and a default export for the same data** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A2_
  - evidence: `getSettings()` has 5 importers and the default export has 7 — two access paths for the same config object.
  - fix: pick one and migrate the other's call sites.

- [ ] **lib/tax/ is a second tax-logic home beside lib/belgianTax/, and belgianTax's index leaks internals** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A3_
  - evidence: `lib/tax/exportTaxYearCsv.ts:13` imports belgianTax types — two tax homes instead of one; `belgianTax/index.ts:2`'s `export * from './constants'` leaks table internals; `socialSecurity.ts`/`propertyTax.ts` have no dedicated test files (covered only indirectly via PIT tests).
  - fix: fold `exportTaxYearCsv.ts` into `lib/belgianTax/`, narrow the constants re-export, and add direct tests for socialSecurity/propertyTax.

- [ ] **Several small duplications in components/pages: currency formatters, fmtLargeNum, admin skeleton rows, and a redundant PageHeader prop** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A4_
  - evidence: statistics components hand-roll currency-formatter closures despite `utils/currency.ts:127` (`CustomChart.tsx:78-83`, `CustomChartBuilderModal.tsx:89`, `RecipientInsightsTab.tsx:48,60`); `fmtLargeNum` is duplicated ×3 (`ResearchComparePage.tsx:181`, `MarketLookupPage.tsx:144`, `ResearchFundamentalsTab.tsx:77`); an admin skeleton-row loop is duplicated (`ProviderHealthPage.tsx:183-190` ≈ `EndpointLivenessPage.tsx:105-112`) and `ExchangeRatesPage.tsx:66-98` hand-rolls a `<table>` instead of using `ui/table`; `PageHeader.tsx:7-9` carries both a `subtitle` and a `description` prop alias.
  - fix: route the statistics formatters and `fmtLargeNum` through the shared currency util; share the admin skeleton-row component; switch ExchangeRatesPage to `ui/table`; drop one of PageHeader's two alias props.

- [ ] **No CI backstop for commitlint — enforced only via a skippable local git hook** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: commitlint runs only via `.githooks/commit-msg` (hooksPath from `scripts/setup-git-hooks.js`'s `prepare`), which `--no-verify` bypasses; gitleaks, by contrast, is wired twice (`.github/workflows/ci.yml:41-47` + `.githooks/pre-commit`).
  - fix: add a commitlint step to CI (e.g. lint the PR's commit range) so `--no-verify` can't skip it entirely.

- [ ] **info-routes count-field naming drifts inside the `data` payload** ⬇
  - ↪ _from: Code/architecture 2026-07-03 · Wave A5_
  - evidence: `total_count` (`routes/info/statistics.js:36`) vs `total_transactions` (:41) vs `total_rates` (`rates.js:69,108,120`) vs netWorth duplicating its paginated total into `data.snapshotsTotal` (`netWorth.js:60`) — four names for the same concept. The outer envelope and the one real pagination (netWorth's `meta.pagination` via shared `parsePagination`) are otherwise consistent.
  - fix: standardize on one count-field name across routes/info/*.

- [ ] **DELETE success responses use six different shapes across resources (204 empty vs five distinct 200 bodies)** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: 204+empty: `routes/watchlist.js:89`, `routes/savedCharts.js:169`, `routes/ai.js:217`, `routes/importRoutes.js:234`, `routes/portfolioImportRoutes.js:299`, `controllers/investmentController.js:377,483`. 200+`{message,…}`: `routes/transactions.js:646`, `routes/recipients.js:94`, `routes/categories.js:82`, `routes/plannedTransactions.js:321`, `routes/tags.js:47`, `routes/accounts.js:49`, `routes/recipientBankAccounts.js:60`, `routes/splits.js:204`. 200+`{deleted:true}`: `routes/attachments.js:165`, `routes/settings.js:242`. 200+`{removed}`: `routes/research.js:235`. 200+`{ok:true}`: `routes/transactions.js:233`. 200+`{patternId}`: `routes/recipients.js:199`. Same operation, 6 contracts — a generic delete-mutation hook on the frontend can't exist.
  - fix: pick one convention (204 for hard delete, 200+entity for soft-delete/deactivate is a defensible split) and codify it in `docs/reference/code-patterns.md`; migrate outliers opportunistically since the frontend is the only consumer today.

- [ ] **List-response key drift: `items` vs `batches` vs bare arrays vs per-route domain keys** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: canonical `{items,total,limit,offset}` in transactions/recipients/categories/planned/watchlist/investments (`routes/transactions.js:256-262`, `controllers/investmentController.js:189-195`). But: `{batches,total,limit,offset}` (`routes/importRoutes.js:362`, `routes/portfolioImportRoutes.js:307`); bare array as `data`: `routes/importRoutes.js:193` (GET /parsers), `routes/portfolioImportRoutes.js:261`, `routes/ai.js:166` (GET /conversations), `routes/savedCharts.js:83`, `routes/admin.js:294,312,317`; array-in-data + counts moved to envelope `meta`: `routes/plannedTransactions.js:231` (`res.ok(items,{days,total})`), `:245`; domain keys: `quotes` (`routes/marketLookup.js:279`), `articles` (`:367`), `points` (`:305`), `mappings` (`routes/research.js:198`), `providers` (`:254`), `models` (`routes/ai.js:149`), `banks`/`adapters` (`routes/info/statistics.js:27,36`).
  - fix: standardize on `{items, total}` (+`limit/offset` when paginated) for every collection GET; treat `batches`→`items` and the bare-array endpoints as the first migration targets since they also block ever adding pagination non-breakingly.

- [ ] **Request/response body casing splits by router: snake_case domain API vs camelCase in ai, savedCharts, crossWorkspace, admin dbEditor** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: snake_case bodies everywhere in the domain API (`transaction_ids` `routes/transactions.js:293`, `alias_ids` `routes/recipients.js:99`, `instrument_key` `routes/research.js:203`), but camelCase bodies in `routes/ai.js:251` (`conversationId`, `useTools`), `routes/savedCharts.js:87` (`chartType`, `categoryIds`, `dateRangeStart`), `routes/crossWorkspace.js:32,58` (`targetWeights`, `availableCash`), `routes/admin.js:286` (`changes`, `dryRun`); `routes/research.js:160-167` accepts *both* (`horizon_months ?? horizonMonths`). Responses mix too: `routes/importRoutes.js:397` returns `{deleted, recipientsRemoved}` (camel) two handlers away from `auto_linked_count` (snake, `:75`); marketLookup responses are fully camel (`routes/marketLookup.js:127-139`).
  - fix: declare snake_case the wire convention (it matches the DB-mirroring majority), grandfather the camel routers explicitly in the API docs, and stop the both-accepted pattern in research.js from spreading — dual-accept is the worst option (two undocumented contracts).

- [ ] **Bulk-operation partial-failure semantics disagree: transactions bulk ops validate-then-atomic-throw, splits /batch silently drops malformed entries** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: `POST /transactions/bulk-tag` throws on any unknown slug before writing (`routes/transactions.js:341-343`) and bulk-update validates FKs up front "so the entire batch fails atomically" (`:407-464`); but `POST /splits/batch` runs `normalizeBatchSplitInputs` which `.filter()`s out any split missing `recipient_id`/`amount` and commits the rest with no report of what was dropped (`routes/splits.js:43-51,110-114`); `POST /accounts/:id/merge` likewise silently filters non-integer `source_ids` (`routes/accounts.js:56-58`) while `POST /recipients/:id/merge` passes `alias_ids.map(Number)` through unfiltered (`routes/recipients.js:110-113`). Response reporting also varies: `{added,removed,transactions_affected}` vs `{updated}` vs `{deleted}` vs full `{items,total}`.
  - fix: adopt one rule — bulk requests are all-or-nothing with a 400 naming the offending entries (the transactions.js pattern); make splits/batch and accounts/merge reject instead of filter.

- [ ] **Same query param `include_backtest` has opposite defaults on the two sibling forecast endpoints** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: `/aggregations/cashflow-forecast-methods` defaults it ON (`include_backtest !== 'false' && !== '0'`, `routes/aggregations.js:113`) while `/aggregations/cashflow-forecast-rolling` defaults it OFF (`=== 'true' || === '1'`, `routes/aggregations.js:143-144`). A consumer omitting the param gets backtest data from one endpoint and not the other.
  - fix: pick one default (or require the param) and parse both through a shared default-aware boolean helper.

- [ ] **Boolean query-param parsing: ~31 ad-hoc comparison sites, shared helper used in only one router; accepted spellings differ per param** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: `isTruthyQueryParam` exists (`routes/info/_queryParams.js:23-30`) but is only used in `routes/info/rates.js:36,98`; `routes/aggregations.js` imports from that very module (line 37) yet hand-rolls `=== 'true' || === '1'` eight times (`:51,112-115,141-144,244`). Within one handler, `amount_signed` accepts `'true'|'1'` but `include_balance`/`normalize_to_eur` accept only `'true'` (`routes/transactions.js:71,98,238,252`) — `include_balance=1` is silently ignored. `active` uses a third pattern (`!== 'false'`, default-true) in ~8 routers, with a tri-state `active=all` supported only by tags and accounts (`routes/tags.js:21`, `routes/accounts.js:23`) and unavailable on recipients/categories/transactions. `controllers/investmentController.js:102-106` adds a fourth variant.
  - fix: promote `isTruthyQueryParam` (plus a default-true twin) from `routes/info/_queryParams.js` to `lib/` next to `parsePagination`, and adopt it route-by-route; decide whether `active=all` is API-wide or remove it.

- [ ] **Date-range query params come in five styles across the surface** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: `start_date`/`end_date` (`routes/transactions.js:48`, `routes/plannedTransactions.js:146`); bare `start`/`end` (`routes/aggregations.js:225-226,241-242` recipient-pivot/tag-pivot); `start_month`/`end_month` (`routes/info/rates.js:89-90`); `from`/`to` in the reports body (`routes/reports.js:58-59`); epoch-ms `from_ms`/`to_ms` (`controllers/investmentController.js:343`); plus `year` (`routes/aggregations.js:194`) and `days`/`months` windows (`routes/plannedTransactions.js:227`, `routes/aggregations.js:101`). Validation also differs: transactions/planned run `assertYmd`, aggregations pivots pass `start`/`end` through unvalidated (`routes/aggregations.js:225-226`).
  - fix: standardize new endpoints on `start_date`/`end_date` + `assertYmd`; alias `start`/`end` on the pivots (accept both, document one) rather than breaking existing callers.

- [ ] **Pagination-helper adoption gap: investmentController hand-rolls three clamp parsers; `validatePagination` in middleware is a dead duplicate** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: `parsePagination` is adopted in 8 route files + netWorth (grep: transactions, recipients, categories, planned, watchlist, both import batch lists, `routes/info/netWorth.js:46`), but `controllers/investmentController.js:108-139` still hand-rolls three variants (`Math.min(parseInteger(limit) || 200, 1000)` — note `limit=0` falls back to 200, and the bulk parser allows `limit` up to 200000 at `:126`), exactly the drift the helper's own doc-comment says it was built to end (`lib/pagination.js:6-9`). Meanwhile `middleware/validation.js:128-136` exports a second, unused `validatePagination` (zero callers) with different clamping.
  - fix: port investmentController's three parsers to `parsePagination` (keeping per-route `maxLimit`), and delete `validatePagination` from middleware/validation.js so there is one canonical parser.

- [ ] **Unpaginated collection endpoints; AI conversations list is the one that grows without bound** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: `GET /api/ai/conversations` returns every row, repository query has no LIMIT (`routes/ai.js:164-167` → `repositories/aiChatRepository.js:41-46`) — this grows with every chat forever. Also unpaginated: `GET /splits/owed` and `/splits/transaction/:id` (`routes/splits.js:57-65`), `GET /recipients/clusters` (`routes/recipients.js:23-27`, full-table scan of recipients), `GET /recipients/:id/aliases|patterns`, `GET /tags`, `GET /accounts`, `GET /saved-charts`, `GET /attachments/transaction/:id`. Most are naturally small (tags, accounts, charts); conversations and owed-splits are usage-proportional.
  - fix: add `parsePagination` to `/api/ai/conversations` first (bare-array response makes this a breaking change — bundle with the list-key standardization); leave the naturally-bounded ones alone.

- [ ] **:id path-param validation drift — five routers bypass `validateIdParam` with weaker hand-rolled checks** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: `validateIdParam` middleware is used in 11 routers, but importRoutes/portfolioImportRoutes batch+row ids use `Number.isFinite(parseInt(id,10))` which accepts `0`, negatives, and `"12abc"` (`routes/importRoutes.js:367-368,406,483-485`; `routes/portfolioImportRoutes.js:311-312,405-408`); `routes/savedCharts.js:24-28` only rejects NaN (accepts `-5`); `routes/research.js:232-233` and `routes/recipientBankAccounts.js:12-16` roll their own positive-int checks; `routes/recipients.js:189-190` checks `patternId` with only `Number.isFinite`. (ai.js's UUID regex is a legitimately different type.)
  - fix: `validateIdParam` already supports being applied per-param via `validateId` — sweep the five routers onto it (or a `validateIntParam('rowId')` factory) so `"12abc"` and `0` uniformly 400.

- [ ] **Action-endpoint naming: `POST /:id/<verb>` is the norm, but refresh/bulk actions use three patterns and `/categories/assign` exists twice** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: consistent core: `/:id/merge|unmerge|execute|pay|settle|move|commit|set-primary` (`routes/recipients.js:97,147`, `routes/plannedTransactions.js:294`, `routes/splits.js:133,157`, `routes/investments.js:39`, `routes/recipientBankAccounts.js:63`). Drift: refresh is verb-noun on one collection (`POST /investments/refresh-prices`, `routes/investments.js:32`), noun/verb on others (`POST /exchange-rates/refresh`, `/inflation-rates/refresh`, `routes/info/rates.js:79,114`), and verb-noun again at router root (`POST /info/refresh-views`, `routes/info/maintenance.js:12`). Bulk is `bulk-*` on transactions (`routes/transactions.js:289-503`) but `/batch` on splits (`routes/splits.js:104`). Duplicate endpoint: `POST /categories/assign` (`routes/categories.js:49-63`) and `POST /categories/:id/assign` (`:85-93`) do the same assignment two ways.
  - fix: document `POST /<collection>/:id/<verb>` and `POST /<collection>/<verb-noun>` (collection-level) as the two blessed forms; deprecate one of the two `/assign` endpoints and rename future bulk ops consistently (`bulk-create` not `batch`).

- [ ] **Duplicate-create handling: createOrGet returns 200-with-existing on four resources, 409 Conflict on two others** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: recipients, categories, recipient bank accounts, and tags return 200 + the existing row when the POSTed entity already exists (`routes/recipients.js:73`, `routes/categories.js:44`, `routes/recipientBankAccounts.js:40`, `routes/tags.js:29`), with no flag other than the status code to tell "created" from "found". Transactions and parser configs instead throw 409 ConflictError (`routes/transactions.js:560-563`, `routes/importRoutes.js:205-208`, `routes/portfolioImportRoutes.js:272-274`). Both are defensible; having both means a consumer must read per-endpoint docs to know if a duplicate POST is safe.
  - fix: keep both behaviors but make them explicit: document createOrGet endpoints as idempotent upserts, and add a `created: boolean` field to their 200 responses so consumers don't have to branch on status code alone.

- [ ] **Non-GET params from query string with inconsistent precedence — even within one file** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: `routes/importRoutes.js:45` resolves `bank_name` query-first (`req.query.bank_name || req.body.bank_name`), while `:100` in the same file spreads `{...req.query, ...req.body}` so body wins for the custom-import config; `routes/portfolioImportRoutes.js:133,139` uses body-wins spread throughout. `routes/admin.js:135` requires the destructive confirm as a *query* param on a POST (`force=true`). Everything else is body-only.
  - fix: for multipart uploads (the legitimate reason query params exist here), pick one precedence (body wins) and apply it to `bank_name` too; move `force` into the POST body.

- [ ] **SSE terminal event named `complete` on both import streams but `done` on AI chat; payload casing differs across streams** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: all three SSE endpoints share `createSseWriter`, identical headers, `progress`-style interim events, and an `error` frame carrying `{detail}` (`routes/importRoutes.js:249-300`, `routes/portfolioImportRoutes.js:183-235`, `routes/ai.js:295-358`) — good. Drift: terminal event is `complete` with snake_case payload (`total_processed`, `routes/importRoutes.js:285`) vs `done` with camelCase payload (`assistantMessage`, `routes/ai.js:340-345`); import errors are `{detail}` only while ai adds `{detail, code?}` (`routes/ai.js:352`).
  - fix: low urgency; when either protocol is next touched, converge on one terminal-event name and add `code` to the import error frames.

- [ ] **Route-edge validation is four different patterns: Zod (reports only), shared middleware validators, per-route assert functions, inline checks** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: `routes/reports.js:23-101` is the only Zod-validated router (backend has no Zod requirement, but it proves the dependency is already available); `middleware/validation.js` validators (`validateNumber`, `validateIntArray`, `assertYmd`) are adopted piecemeal (`routes/watchlist.js:19-39`, `routes/savedCharts.js:63-67`, `routes/settings.js:62-71`); settings and savedCharts each carry ~100 lines of bespoke assert-functions (`routes/settings.js:32-136`, `routes/savedCharts.js:30-79`); transactions/planned mix inline checks with name-resolution helpers (`routes/transactions.js:539-550`). Purely a maintainability/consistency map — no missing-validation hole found beyond the id-param finding above.
  - fix: no rewrite warranted; nominate the reports.js Zod pattern as the convention for *new* complex POST bodies in `docs/reference/code-patterns.md`, keep middleware validators for scalars.

- [ ] **`aggregations` hand-builds a 400 JSON envelope instead of throwing ValidationError** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: `routes/aggregations.js:135` — `res.status(400).json({ ok:false, error:{ code:'BAD_REQUEST', … } })`, the only route that bypasses the errorHandler for a validation failure; every sibling throws `ValidationError` (which also emits `VALIDATION_ERROR`, not `BAD_REQUEST`, so the error `code` differs from every other 400 in the API).
  - fix: replace with `throw new ValidationError('days_back + days_forward must be <= 730')`.

- [ ] **Singular `transaction` sub-resource segment in attachments and splits, plus a stale route doc-comment** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W1 (REST API design)_
  - evidence: `POST|GET /api/attachments/transaction/:id` (`routes/attachments.js:37,91`) and `GET /api/splits/transaction/:id` (`routes/splits.js:82`) use singular `transaction`; every other segment in the API is plural kebab (`/batches/:id/rows/:rowId`, `/:id/bank-accounts`). The attachments header comment documents `GET /api/transactions/:id/attachments` (`routes/attachments.js:5`), a route that doesn't exist.
  - fix: fix the doc-comment now; treat the singular segments as grandfathered (renaming is a breaking change for two working routes).

- [ ] **`bank_account` string ↔ `account_id` FK dual-write has no tracked exit: the ADR-088 contract phase was neutralized and nothing schedules it** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W2 (DB schema & data model)_
  - evidence: `alembic/versions/0055_drop_bank_account_string.py:1-38` (contract migration made a permanent no-op, drop deferred to "a deliberate, OUT-OF-BAND step"), `0056_restore_bank_account_after_premature_drop.py:40-60` (string re-derived + re-indexed after the premature drop). The string remains load-bearing: `mv_bank_balances` is grain-keyed on `bank_account, currency` (`apps/node-backend/src/services/materializedViewService.js:104-118`), and `transactions` carries duplicate index families for both keys (`idx_transactions_bank_date_active` 0056:57-58 vs `idx_transactions_account_date_active` 0050:121-123). TODO.md tracks symptom bugs (free-typed strings minting phantom accounts, TODO.md:1769; 0062 trigger stale-account edge, TODO.md:572) but no item tracks the contract step itself. Every future account-related feature must dual-write and dual-index two representations of the same fact.
  - fix: add an explicit backlog/ADR-088-addendum item defining the contract preconditions (parity check query, mv_bank_balances redefinition on `account_id`, code flip inventory) and the out-of-band runbook; until then, at minimum re-point `mv_bank_balances` at `accounts` via join so new consumers stop binding to the string. Any eventual drop ships as a new alembic revision with rollback, applied manually by the user.

- [ ] **Investments table-inheritance legacy is a permanent two-shape schema fork with no documented path out — and the docs present the legacy shape as canonical** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W2 (DB schema & data model)_
  - evidence: fresh installs get flat `investments`/`portfolio_transactions` tables (`0001_initial_database_schema.py:470-534`); legacy installs keep `investments_base` + 7 child tables + view (ADR-004, still status "Accepted", `docs/adr/004-postgresql-table-inheritance.md:15`). Cost is structural, not just the known ALTER-crash gotcha: FKs are *conditionally absent* on legacy installs (`0040_add_portfolio_import_staging.py:117-121` "PostgreSQL rejects FK references to views… columns stay plain INTEGERs", same pattern in 0026, 0052), runtime shape-probing via `to_regclass` in `investmentRepository.js:20,32` and `portfolioTxRepo.common.js:20`, inheritance-aware branching across ≥11 backend files, and the 0061 side-table idiom now needed for every future investments column. Meanwhile `docs/reference/data-model.md:260-327` documents the *inheritance* shape ("Investment (Base Table)" + child tables) as the data model, which is exactly what a fresh install does not have.
  - fix: write an ADR that either (a) declares the flat shape target and specifies a one-time legacy-install conversion migration (CREATE new flat table AS SELECT from view → swap names → drop children; rollback = keep old tables renamed), or (b) explicitly accepts the fork forever — then update data-model.md to describe the flat shape as primary with a legacy-shape appendix. Option (a) removes an entire class of conditional-FK/side-table workarounds from all future migrations.

- [ ] **`docs/reference/data-model.md` has hard drift: a dropped MV, a fictional table, a legacy-only table, and stale column contracts** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W2 (DB schema & data model)_
  - evidence: (1) `mv_recipient_monthly` documented as live with full column table (`data-model.md:670-695`, callout at :660-666 claims "Without 0035 … recipient queries fail") but it was dropped in `0038_drop_mv_recipient_monthly.py:1-21` because *nothing reads it*; `docs/performance/materialized-views.md:25` also still lists it. (2) The "RawTransaction" section (`data-model.md:786-799`) describes a generic table (`bank_name`, `raw_data JSONB`, `hash`, `import_id FK → imports`) that matches none of the 8 real per-bank tables (`0001:276-439`: `deduplication_hash`, `raw_csv_line`, no `imports` table exists). (3) `ExchangeRateCache` (`data-model.md:407-423`) exists only on legacy installs (legacy migration `0025_exchange_rate_cache`, `migrate.js:111`) and no app code references the table. (4) `transactions.amount` documented as NUMERIC(15,2) (`data-model.md:31`) vs NUMERIC(18,4) since `0025_fix_numeric_precision.py:141`. (5) SavedChart section (`data-model.md:771-780`) lists 4 columns; the real table has ~13 (`recipient_ids`/`chart_variant`/`time_bucket`/`date_range_*` 0017, `tag_ids` 0063, `all_categories`/`all_recipients`/`all_tags` 0064). (6) Absent tables: `db_editor_audit` (0059), `provider_api_keys` (0043), `instrument_provider_map`+`provider_quota` (0042), `cashflow_forecast_accuracy`/`_mc`/`_mc_rolling` (0012/0013/0016), and the 4 live MVs are not in the data-model page at all.
  - fix: docs-only pass (no migration): delete/replace the RawTransaction and mv_recipient_monthly sections, mark ExchangeRateCache legacy-only, refresh SavedChart and transactions.amount, add the missing tables; consider generating the table list from `information_schema` to keep it honest.

- [ ] **Enum discipline is three-tier with no rule, and the two recurrence vocabularies disagree (`'bi-weekly'` vs `'biweekly'`)** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W2 (DB schema & data model)_
  - evidence: inventory — PG native enums ×9 (`asset_class`, `portfolio_txn_type`, `recurrence_interval`, `price_provider`, `revolut_state` 0001:75-120; `account_type`, `account_liquidity_class`, `account_tax_wrapper`, `account_owner` 0050:59-77); TEXT+CHECK ×~14 (import/portfolio-import statuses, `ai_messages.role/status`, `transfer_source`, `custom_parser_configs.kind`, `instrument_provider_map.key_type/status`, `db_editor_audit.op`); free text validated only in app code: `planned_transactions.recurrence_pattern` (0001:217, app list `SUPPORTED_PATTERNS = ['daily','weekly','biweekly',…]` `services/calculations/recurrence.js:20`) vs the DB enum `recurrence_interval` with `'bi-weekly'` (0001:98) — same concept, two spellings, and the frontend carries a compat shim (`usePlannedPayments.ts:63` accepts both). Also free-text: `loan_type`, `raw_source_type` VARCHAR(20) (0001:265, no CHECK, write path passes through `rawTransactionRepository.js:290`), `saved_charts.chart_type/chart_variant/time_bucket` (app lists `routes/savedCharts.js:12-16`), `provider` in provider_* tables (TEXT) vs the `price_provider` enum. Sibling inconsistency: `import_staging_rows.match_source` has a CHECK (`0015:82-84`) but `portfolio_import_staging_rows.match_source` does not (`0040:90`); `portfolio_import_staging_rows.route` (0060) has none. `revolut_state` is the only raw-bank table using a PG enum — 3 of its 5 values are dead since the adapter drops non-COMPLETED rows (`importPipeline/adapters/revolut.js:48`).
  - fix: adopt one written rule (suggest: TEXT + named CHECK for everything new — PG enums require ALTER TYPE ceremony and can't drop values); ship one small revision adding CHECKs to `recurrence_pattern` (accepting `'biweekly'`), portfolio `match_source`/`route`, and `raw_source_type` (the 8 adapter names); document the rule in docs/reference/code-patterns.md. Rollback = drop constraints.

- [ ] **Unnamed inline constraints in the baseline keep forcing pg_constraint-discovery DO-blocks; chk_/ck_ and uq_/uniq_ prefixes are mixed** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W2 (DB schema & data model)_
  - evidence: it has already bitten twice — `0015_recipient_match_patterns.py:108-127` ("The inline CHECK has an auto-generated name; discover and drop it") and `0048_category_fk_on_delete_set_null.py:34,65-66` both had to query `pg_constraint` at runtime to find names. Yet `0001` still creates unnamed inline CHECKs (`ai_messages.role/status` :584,589; `import_batches.status` :606-607; `import_staging_rows.status` :623-624) and every 0001 FK is unnamed, so the next status-value addition or FK policy change repeats the dance. Naming split: `chk_*` (0028:27,35; 0046:65; 0050:102) vs `ck_*` (0044:59; 0041:45; 0042:77,87,128); `uq_*` (9 constraints) vs `uniq_pte_planned_executed` (0001:727); index prefixes 134× `idx_*` vs `ix_instrument_provider_map_provider_symbol` (0042:98) and suffix-style `db_editor_audit_table_time_idx` (0059:52).
  - fix: pick `chk_`/`uq_`/`idx_` as canonical in code-patterns.md; ship one housekeeping revision that renames the outliers (`ALTER TABLE … RENAME CONSTRAINT`, `ALTER INDEX … RENAME`) and names the anonymous 0001 CHECKs (drop-via-discovery once, re-add named). Rollback = reverse renames.

- [ ] **Money precision forked in 0025: `transactions.amount` is NUMERIC(18,4) but every sibling money column stayed NUMERIC(15,2)** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W2 (DB schema & data model)_
  - evidence: `0025_fix_numeric_precision.py:141` retypes only `transactions.amount`. Still (15,2): `transactions.balance` (0001:191), `planned_transactions.amount` (0001:208), `transaction_splits.amount`/`split_payments.amount`/`agg_split_outstanding.*` (0019:24,40,61-63), loan schedule columns (0001:251-254), `accounts.statement_balance` (0054:29), and all 8 raw tables' amounts (0001). Consequence: a 4-decimal transaction cannot be split exactly (splits round to cents while the 0062 split-guard trigger compares `SUM(splits) > ABS(amount)+0.005`), and a planned→executed copy silently gains precision headroom one way only. `import_staging_rows.amount` is NUMERIC(20,4) (0001:629) — wider than its commit target.
  - fix: decide the intended domain precision (ADR-060 audited arithmetic, not column types) and ship one alignment revision — either widen the sibling columns to (18,4) (safe, no rewrite for in-range values) or document 2-dp as the split/planned contract; rollback = re-narrow with a USING round().

- [ ] **`saved_charts` INTEGER[] id-arrays (`category_ids`, `recipient_ids`, `tag_ids`) have no referential integrity and no delete-cleanup** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W2 (DB schema & data model)_
  - evidence: `0001:564` (`category_ids INTEGER[]`), `0017:24` (`recipient_ids`), `0063:24-26` (`tag_ids`). Postgres cannot FK array elements; no cleanup exists in `categoryService.js`/`tagService.js` (grep for `saved_charts`/`category_ids` in those services: zero hits), while scalar category refs got explicit ON DELETE SET NULL in 0048 precisely because dangling refs 500'd. A deleted category/recipient/tag id silently persists inside saved chart filters — the chart just shows less data with no signal. The pattern is also spreading (tag_ids added 2026-07).
  - fix: either normalize to join tables (`saved_chart_categories` etc., ON DELETE CASCADE — consistent with `transaction_tags` 0031) via a new revision + backfill, or add app-level cleanup on category/recipient/tag hard-delete + a periodic prune; document the choice.

- [ ] **`updated_at` maintenance is split trigger-vs-app with no rule; a few mutable tables have no timestamps at all** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W2 (DB schema & data model)_
  - evidence: trigger-managed ×18+ (0001:818-831 + accounts 0050:106-109, tags 0031, splits 0019, parser configs 0037, provider_quota/instrument_provider_map 0042, provider_api_keys 0043); app-managed with no trigger: `exchange_rates` (column at 0001:454, absent from the 0001 trigger list; `rateFetcher.js:247` sets it manually), `user_settings` (`settingsRepository.js:70`), `ai_conversations` (touch-trigger fires only on message INSERT, 0001:834-841; title renames rely on `aiChatRepository.js:70`), `provider_health` (0010, no trigger). Zero timestamps: `investment_ticker_prefs` (0061:45-48). Mutable-status staging rows (`import_staging_rows`, `portfolio_import_staging_rows`) have only `created_at`, so import-debugging can't see when a row last transitioned.
  - fix: state the rule (suggest: any table with `updated_at` gets the shared trigger) in code-patterns.md; one revision attaches the trigger to the 4 app-managed tables (harmless with existing manual writes) — rollback drops them.

- [ ] **`import_staging_rows.resolved_recipient_id` / `resolved_bank_account_id` lack FKs while their sibling override column has one** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W2 (DB schema & data model)_
  - evidence: `0001:638-639` — plain INTEGERs, never constrained by any later migration; yet `user_override_recipient_id` on the same table got `REFERENCES recipients(id) ON DELETE SET NULL` in `0015:87-89`. A recipient merged/deleted mid-import leaves a dangling resolved id that commits will trust. (Distinct from the known 0061 side-table no-FK and from the prior FK-*index* pass.)
  - fix: new revision adding both FKs with ON DELETE SET NULL (matches 0015's choice), after a one-time orphan sweep like 0026 did; rollback drops them.

- [ ] **Cashflow-forecast cache tables store dates as TEXT and carry a vestigial `user_id DEFAULT 'anonymous'` found nowhere else in the schema** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W2 (DB schema & data model)_
  - evidence: `cashflow_forecast_accuracy.as_of_month TEXT` (0012:27), `cashflow_forecast_mc.month TEXT` (0013:26), `cashflow_forecast_mc_rolling.today_iso TEXT` (0016:26) — every other business date in the schema is DATE; TEXT keys sort correctly only by convention and can't be range-pruned or validated. All three also have `user_id TEXT NOT NULL DEFAULT 'anonymous'` in a single-user app (no other table has user_id), baking a phantom multi-tenancy dimension into PKs/unique constraints.
  - fix: low urgency (cache tables, truncate-safe): if ever touched again, retype the date keys to DATE with `USING`, and either drop `user_id` or document it as a deliberate future-proofing convention; rollback = reverse casts.

- [ ] **`provider_api_keys.api_key` is plaintext TEXT despite pgcrypto being loaded since the baseline** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W2 (DB schema & data model)_
  - evidence: `0043_add_provider_api_keys.py:34-38` (`api_key TEXT NOT NULL`); `pgcrypto` is created in `0001:47`. Keys flow into every dump/backup in the clear (the table is presumably in BACKUP_COVERED_TABLES). Self-hosted single-user context softens this, but it's a schema-level choice a DBA would flag.
  - fix: if deemed worth it: `pgp_sym_encrypt` with a key from `.env.local`, or at least document the accepted risk in docs/security/; schema change would be a new revision (add encrypted column, migrate, drop old).

- [ ] **Bank-adapter doc recipe points at the deprecated shim, not the real registry** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W3 (extensibility seams)_
  - evidence: docs/integrations/bank-adapters.md:83-86 ("Adding New Banks": *create parser in `apps/node-backend/src/services/bankAdapters.js`, register in `getSupportedBanks()`*, `updated: 2026-05-12`). Reality: `services/bankAdapters.js` is a deprecated re-export shim with **zero importers**; the real recipe is 2 touchpoints — new `apps/node-backend/src/services/importPipeline/adapters/<bank>.js` default-exporting `{name, bankName, detect, parse}` (exemplar: adapters/wise.js:134) + 2 lines in adapters/index.js:9-19 (import + `ADAPTERS` array). Everything downstream is derived: UI catalog via `listAdapters()` (adapters/index.js:41) → routes/info/statistics.js:35 → frontend useAdapters.ts:20 (API-fetched, no i18n keys, no frontend edit); hash/dedup generic (importPipeline/validate.js:55, commit.js:106). This is the most-extended seam and its doc actively misdirects.
  - fix: rewrite the "Adding New Banks" section to the adapters/-directory recipe (file + registry line), note the frontend/i18n/DB require **no** touch, and delete the dead `services/bankAdapters.js` shim.

- [ ] **Dead per-bank raw-table layer still presented as a live requirement for new adapters** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W3 (extensibility seams)_
  - evidence: `repositories/rawTransactionRepository.js` (324 lines, six copy-paste per-bank repos + hand-maintained if-chain at :315-322) has **zero importers** anywhere in src/. The pipeline never writes `*_raw_transactions`; raw lines live in `import_staging_rows.raw_data` (stage.js:103). Yet docs/features/import.md:375-381 lists the six per-bank `deduplication_hash` columns as the dedup mechanism, and :218 says "if raw table exists for bank" — implying "add bank X" needs an alembic migration for a raw table. It doesn't (only historical banks have them; wise/sabb tables are write-orphaned legacy data).
  - fix: mark the per-bank raw tables as frozen legacy in docs/features/import.md, state that new adapters need no migration, and delete (or explicitly tombstone) rawTransactionRepository.js so the next adapter author doesn't clone a seventh repo block.

- [ ] **how-to-add-api-endpoint guide contradicts code-patterns.md and imports a nonexistent module** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W3 (extensibility seams)_
  - evidence: docs/guides/how-to-add-api-endpoint.md snippets import `../database/pool.js` — that file does not exist (only `database/connection.js`; the canonical `query` import is documented correctly in docs/reference/code-patterns.md:377,445). The guide also uses bare `res.json(...)`/`res.status(404).json({detail})` where ADR-026 mandates the `res.ok()` envelope (code-patterns.md:513), registers with `app.use` while main.js uses `mountRouter` (main.js:310-331), shows no Zod validation, and its checklist (:212-221) omits three mandatory touchpoints per CLAUDE.md: openapi.yaml, `bun run generate:types` (ADR-031), and docs/reference/api-endpoint-matrix.md. Real end-to-end cost is ~9-11 files (route, main.js, repository, openapi.yaml, generated.ts regen, lib/api/<resource>.ts, hook/component, docs/api page + matrix, tests) — the guide describes ~6 and gets 3 of them wrong.
  - fix: rewrite the guide's snippets from a real recent resource (e.g. routes/tags.js) and extend the checklist with the openapi/types/matrix steps; the guide should defer to code-patterns.md instead of duplicating stale snippets.

- [ ] **Price-provider seam is the repo's worst shotgun: ~11 hand-maintained touchpoints incl. four copy-paste dispatch blocks** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W3 (extensibility seams)_
  - evidence: adding provider N requires: (1) strategy fn in `PROVIDERS` (services/prices/priceProviderRegistry.js:347); (2) `SUPPORTED_PROVIDERS` entry (priceProviderService.js:42); (3) the `stale = { binance: [], yahoo: [], custom: [], kinesis: [] }` bucket (priceProviderService.js:61) **plus a fifth near-identical ~20-line `if (stale.X.length)` block** (:87-164 — four existing blocks differ only in key resolution); (4) per-provider branches in `fetchHistoricalPrices` (:293+); (5) probe entry in providerHealthService.js:22-33; (6) PG `price_provider` enum ALTER migration (alembic 0001:106 — a DB migration to add a fetch strategy; extensibility cost of the enum choice, complementing W2's enum-discipline finding); (7) openapi.yaml:835 enum + generated.ts regen; (8-9) two hardcoded frontend lists (AddInvestmentDialog.tsx:27, EditInvestmentDialog.tsx:52-56); (10) three frontend type unions (types/api.ts:349, types/portfolio.ts:87, generated.ts:3374); (11) i18n `addInv.provider.hint.*` en+nl. docs/integrations/price-providers.md has **no "adding a provider" recipe at all** (headings :16-251).
  - fix: collapse the four dispatch blocks into one loop over a provider descriptor (`{key, resolveId, batch(ids|invs), cacheKeyOf}`) so the strategy object in the registry is the *single* backend registration point; document the remaining unavoidable touchpoints (enum migration, openapi, frontend) as a recipe in price-providers.md.

- [ ] **Frontend hardcodes the provider catalog twice while an unused catalog endpoint + client already exist** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W3 (extensibility seams)_
  - evidence: backend serves `SUPPORTED_PROVIDERS` at `GET /api/investments/providers` (investmentController.js:254) and the frontend client wrapper exists (lib/api/portfolio.ts:42-44), but **no component calls it** — AddInvestmentDialog.tsx:27 and EditInvestmentDialog.tsx:52-56 each keep their own literal `PRICE_PROVIDERS` arrays. Contrast the bank-adapter seam, which got this right (useAdapters.ts fetches the catalog). Result: the endpoint is dead weight and provider additions need two extra UI edits that can drift from the backend list.
  - fix: have both dialogs consume `getSupportedProviders()` (names/descriptions already come localized-ready from the backend list), or delete the endpoint + client fn if the hardcoded lists are the intended source.

- [ ] **Report-section IDs are triple-listed backend + hand-mirrored in the frontend, with silent-drop on mismatch** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W3 (extensibility seams)_
  - evidence: adding a section touches ~6 places: `sections/<x>.js`; reports/index.js **three** spots (import :15-34, renderer map :414/:435/:454, default-order list :424/:444/:464); the matching data fetcher (dataFetcher*.js); the frontend's independently hand-maintained mirror lists (ExportDialog.tsx:58-90 `FINANCIAL/PORTFOLIO/TAX_SECTIONS`); i18n `export.section.*` en+nl. There is no `GET /sections` catalog, and unknown IDs are *silently filtered* server-side (`requested.filter(id => id in RENDERERS)` — reports/index.js:480,:503,:526), so a backend/frontend ID typo yields a PDF that quietly omits the section rather than erroring.
  - fix: per report type, export one `[{id, render, default}]` array from reports/index.js (derive renderer map + default list from it) and either expose it via a small catalog endpoint for ExportDialog or at least make generateReport reject unknown section IDs instead of silently dropping them.

- [ ] **Real-DB test harness built but adoption stalled at 1 suite; TEST_DATABASE_URL set nowhere, so its tests silently skip everywhere** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W4 (test architecture)_
  - evidence: `apps/node-backend/tests/setup/db.js:1-53` is a deliberate opt-in real-PG seam ("Phase 0 step 6": `getTestPool()` + `it.skipIf(!hasTestDatabase())`), but only one production suite uses it (`tests/services/aggregationRefresh.test.js:37` `describe.skipIf(!hasTestDatabase())`) plus the harness self-test (`tests/setup/db.test.js`). `TEST_DATABASE_URL` appears in zero workflows and zero package.json scripts — the gated cases skip in CI *and* in every default local run. Meanwhile 60 suites mock the pool (`vi.mock('../src/database/connection.js')` 48× + 12× two-levels-deep), with 48 SQL-string assertions across 11 files, and multi-step `mockResolvedValueOnce` choreographies encoding exact query order (e.g. `tests/infoRepoMonthly.test.js:33-50`: MV probe → currency probe → data query, pinned fake clock). DB-bound orchestration like `src/services/transferReconciliationService.js` (254 lines) has no direct test at all — only its pure-calc extract is golden-tested (`tests/services/transfers.golden.test.js` → `calculations/transfers.js`, 87 lines) and the service is mocked in 3 bulk-route tests. These are exactly the tests the harness was built for.
  - fix: decide the harness's fate: either wire `TEST_DATABASE_URL` into CI (compose PG service or testcontainers) + a local script, then migrate the SQL-order-choreography suites (infoRepo*, transactionRepository*, transferReconciliation) onto it incrementally; or delete `setup/db.js` and record the "mock-only" decision in an ADR so the half-seam stops implying integration coverage that never runs.

- [ ] **Route tests mock Express itself and execute only the last handler — middleware chains are never exercised; no supertest anywhere** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W4 (test architecture)_
  - evidence: `tests/routes/transactions.test.js:7-19` — hand-rolled `mockRouter` stores `handlers[handlers.length - 1]`, so any validation/guard middleware registered before the handler is silently dropped from the test path; handlers are invoked with bare `{ query: {} }` req objects (line 69-71), bypassing Express query parsing, error-handler integration, and the ADR-026 envelope middleware path. `grep supertest` = zero hits in tests and package.json. `vi.mock('../../src/middleware/validation.js')` in 4 files stubs validation outright. The pattern is duplicated, not shared: `mockRouter` defined in 20 route files (3-4 hits each) and `mockResponse` re-declared in 22 files; no helper module exists (`tests/` has only `setup/db.js` and `golden/runGolden.js`).
  - fix: switch route suites to supertest against the real router mounted on a throwaway `express()` app (repos/services still mocked) — this restores middleware, status codes, and envelope behavior to the tested path; at minimum extract `mockRouter`/`mockResponse` into `tests/helpers/` and capture the full handler chain instead of `[length - 1]`.

- [ ] **Backend coverage gate measures only files tests happen to load — new untested modules never trip the 85/88 thresholds, and the config comment overstates e2e route coverage** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W4 (test architecture)_
  - evidence: `apps/node-backend/vitest.config.js:8-19` — Vitest 4 (`vitest@^4.1.7`, package.json:24) with no `coverage.include`: only files imported during the run are counted, so an entirely untested new service/repository is invisible to the threshold math (thresholds become "quality of tested files", not "coverage of codebase"). The comment at line 11-12 justifies this with "Routes are exercised end-to-end by frontend Playwright suites" — but the e2e suite is 630 lines of page-load smoke, dialog UX, a11y scans, and 4 CRUD creates (`e2e/mutations-parity.spec.ts:21-96`); it exercises a handful of GET paths and 3 POSTs, nothing like route coverage. Contrast the frontend, which does this honestly: explicit `coverage.include` + ratchet thresholds with measured baseline documented (`apps/frontend/vite.config.ts:118-147`).
  - fix: add `coverage.include: ['src/**/*.js']` (with targeted excludes) and re-ratchet thresholds to the real measured numbers, frontend-style; rewrite the comment to state what the gate actually guarantees.

- [ ] **Frontend coverage include-list omits `src/features/` and `src/contexts/` — 460K+124K of source (incl. the CSV-import UI) invisible to the ratchet, despite 15 test files living there** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W4 (test architecture)_
  - evidence: `apps/frontend/vite.config.ts:121-127` includes only `components/ hooks/ lib/ pages/ utils/`. `src/features/` (460K: imports, transactions, recipients, ai-chat) and `src/contexts/` (124K) are unmeasured — neither their covered nor uncovered lines count. Both dirs have tests (15 test files, e.g. `src/features/imports/PortfolioCsvColumnMapper.test.tsx`, `src/contexts/__tests__/WorkspaceContext.test.tsx`), so this looks like a stale list from before the `features/` reorganization rather than a decision.
  - fix: add `src/features/**` and `src/contexts/**` to `coverage.include`, re-measure, and re-set the ratchet per the config's own protocol (comment at lines 136-140).

- [ ] **Contract Zod schemas duplicated between MSW contract test and live-contract test — header claims they're shared, they aren't** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W4 (test architecture)_
  - evidence: `src/test/live-contracts/live-contracts.test.ts:4-6` says it validates "against the same Zod schemas used in MSW fixture contracts", but it imports only `server` (line 15) and re-declares its own `LinkSchema`/`paginatedOf`/6 item schemas (lines 40-70) — looser than the 19 schemas in `src/test/msw/contracts.test.ts` (e.g. its `TransactionItemSchema` checks 5 fields vs the full stub shape). So the contract now lives in four places: `openapi.yaml` → `generated.ts` (type-guarded via `src/types/contract-guard.ts`), hand-written `api.ts`, the MSW-side Zod set, and the live-side Zod subset — the two Zod copies can drift so MSW fixtures and the live backend are held to different shapes.
  - fix: extract the Zod schemas into `src/test/contracts/schemas.ts` imported by both suites (live suite can `.pick()` a lax subset from the strict schema rather than redefine it); fix the misleading header either way.

- [ ] **`database/connection.js` and `convertRowsToEur` mocks reinvented per file with divergent shapes/semantics — drift risk in the fakes themselves** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W4 (test architecture)_
  - evidence: the connection mock's export set varies by file — `{query}` only (`tests/categoryRepository.test.js:3`), `{query, queryPrepared, withTransaction}` (`tests/transactionRepositoryBehavior.test.js`), and a `withTransaction` that actually threads the mock client (`tests/investmentRepository.test.js:1-7`) vs `withTransaction: vi.fn()` that doesn't (`tests/tagRepository.test.js`) — same seam, different transaction semantics per suite. `convertRowsToEur` is faked in 13 places with 5 distinct implementations, two of which re-implement conversion logic inline (identity pass-through ×6-7 vs `amount_eur: Number(r.amount || 0)` mapping in `tests/infoRepository.test.js:7`) — a business-logic re-implementation that will silently diverge if the real converter's row contract changes.
  - fix: one `tests/helpers/mockDb.js` exporting the canonical connection mock (full export surface + client-threading `withTransaction`) and one canonical currency fake; per-file `vi.mock` bodies become one-liners delegating to it.

- [ ] **No factory/builder layer for domain rows — repository/service suites hand-roll row literals per file** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W4 (test architecture)_
  - evidence: no shared builders exist anywhere under `apps/node-backend/tests/` (only `setup/db.js` + `golden/runGolden.js`); transaction/investment/staging row shapes are inlined per test (e.g. `tests/routes/transactions.test.js:80`, and throughout the 694-line `plannedTransactionRepository.test.js`). With 159 backend files / ~2,405 cases, a column rename means grep-and-fix across dozens of literals. (Inline CSV strings in adapter tests are the known deliberate PII guard — not this finding.) The e2e suite similarly copy-pastes the `pageerror`-collector block into every test (`e2e/critical-flows.spec.ts:14-19` ×10+, `mutations-parity.spec.ts:22-23`).
  - fix: small `tests/builders/` with `makeTransactionRow(overrides)`-style functions for the 5-6 hot shapes; in e2e, a `test.extend` fixture that auto-collects `pageerror` and asserts empty on teardown.

- [ ] **E2e covers zero high-risk user journeys: no CSV-import upload→preview→commit, no transaction create/edit, no backup/restore flow** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W4 (test architecture)_
  - evidence: full e2e inventory (7 specs, 630 lines, ~51 tests incl. parameterized loops): page-load smoke (`smoke.spec.ts`, `critical-flows.spec.ts`), dialog UX edge cases (`dialogs-edge.spec.ts`), axe scans (`a11y.spec.ts`), screenshot capture-only mode (`visual.spec.ts:5` — compare mode not yet on), 4xx/5xx drift listener (`network-drift.spec.ts`), and 4 CRUD creates limited to category/recipient/planned (`mutations-parity.spec.ts:21-96`). `grep setInputFiles|upload` over `e2e/` = zero — the import journey (the app's riskiest write path, and the one the backend coverage comment leans on) is only "import page loads" + a screenshot. No transaction lifecycle test either.
  - fix: add one journey spec each for (a) CSV import of a small synthetic fixture through preview→commit→rows visible in /transactions, and (b) transaction create→edit→delete; these give the "routes exercised by Playwright" claim real teeth where it matters.

- [ ] **`coverage-clients*.test.ts` — 1,370 lines of tests named for, and shaped by, the coverage gate** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W4 (test architecture)_
  - evidence: `src/lib/api/__tests__/coverage-clients.test.ts` (537 lines) + `-2` (494) + `-3` (339) batch-import dozens of thin fetch-wrapper functions and exercise them against MSW. They aren't worthless (they route through the contract-checked handlers), but the naming is candid: these exist to feed the threshold, and they pad the "statements covered" figure with the easiest code in the app while the harder gaps (features/, contexts/ — see the include-list finding) sit unmeasured.
  - fix: no urgent action; when the coverage include-list is fixed and re-ratcheted, consider folding these into per-module client tests so file names describe behavior, not the metric.

- [ ] **checkJs CI gate is nominally load-bearing: `strict:false` + `noImplicitAny:false` and the data layer is untyped** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W5 (cross-cutting concerns)_
  - evidence: `apps/node-backend/tsconfig.check.json:10-11` (`"strict": false, "noImplicitAny": false`), run in CI at `.github/workflows/ci.yml:200`. Under these settings untyped params are silent `any`, so the check only catches gross misuse. Core data layer is where typing is absent: `src/repositories/transactionRepository.js` has 14 exports and **0** `@param`/`@returns`; all of `src/repositories/` (41 files) totals 71 `@param` vs 411 in `services/`. Only 15 `@typedef` sites repo-wide and **no shared domain-row typedefs** (no `TransactionRow`/`PlannedRow` contracts — `@vision/types` covers only error codes; `packages/shared-utils/src/*.d.ts` covers money/portfolio helpers). The clean `@ts-ignore` count (0 in src/) reflects the loose checker, not clean types. Net: row shapes flow into services as implicit `any`; typing is decorative exactly where SQL-shape drift is likeliest.
  - fix: add a shared `src/types/rows.js` (or `.d.ts` in `@vision/types`) with `@typedef` contracts for the ~10 core row shapes; annotate repository returns against them; then ratchet `noImplicitAny: true` per-directory (start `repositories/`), keeping `strict:false` elsewhere.

- [ ] **requestId reaches only 3 of ~286 logger call sites — no child-logger/ALS seam, so service/repo logs are uncorrelated** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W5 (cross-cutting concerns)_
  - evidence: `config/logger.js` is a module-level singleton with no `child()`/context mechanism (lines 37-50). `req.id` appears in log payloads only at `src/main.js:220` (entry debug line), `src/middleware/errorHandler.js:110`, and `src/routes/ai.js:288`. The other ~283 `logger.*` calls across 69 files (e.g. every service/repository warn/error) carry no correlation id, so a mid-request warning can't be tied to the request that the errorHandler later logs. The requestId middleware docstring (`src/middleware/requestId.js:4-8`) only promises envelope propagation, not log propagation — the gap is architectural, not accidental.
  - fix: an `AsyncLocalStorage` store set in the requestId middleware + `logger` reading `store.getStore()?.requestId` into `formatMessage` gives correlation to all 286 sites with zero call-site churn (no need for a full pino child-logger migration).

- [ ] **Error taxonomy has no upstream-failure/timeout class, and two parallel `extends Error` hierarchies need bespoke route translation** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W5 (cross-cutting concerns)_
  - evidence: the `AppError` set (`src/middleware/errorHandler.js:41-75`) covers 400/401/403/404/409/429 only — no 502/503/504 semantics for provider outage or timeout, so those become generic 500 `INTERNAL_SERVER_ERROR` with the prod-masked message (errorHandler.js:118-119). `services/` has 41 raw `throw new Error(` vs 72 typed, concentrated in exactly the upstream layer: `services/prices/priceProviderRegistry.js` (5), `services/research/adapters/*` (12+ incl. `httpClient.js`), `services/priceProviderService.js` (3), `services/dataImportService.js` (3). The research aggregator swallows per-provider failures in-chain (`researchAggregator.js:101,166,216`), but price/import throws do reach the handler as 500s. Separately, `AiChatServiceError extends Error` (`src/services/aiChatService.js:29`) and `ToolValidationError extends Error` (`src/services/aiChat/tools/_validate.js:11`) sit outside the AppError hierarchy and require hand-written translation at `src/routes/ai.js:78` and `:350` — no written rule says which layer owns HTTP semantics (docs/reference/service-layer.md documents per-service behavior but states no layer rule).
  - fix: add `UpstreamError` (502) / `UpstreamTimeoutError` (504) to errorHandler.js; make `AiChatServiceError` extend `AppError` (it already carries status+code) to delete the ai.js translation shims; state the rule ("services throw typed AppErrors; only middleware maps to HTTP") in service-layer.md.

- [ ] **Feature toggles re-accumulated after ADR-035 ("no flags") in three uncoordinated layers with no placement/precedence rule** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W5 (cross-cutting concerns)_
  - evidence: ADR-035 (2026-04-24) removed the flag system, declaring "all features are always enabled... enabling condition is now the presence of configuration". Since then toggles returned in three layers: boot-time backend env (`IMPORT_PIPELINE_V2`, `AI_CHAT_ENABLED` — `src/config/env.js:108,94`), build-time frontend env (`VITE_ENABLE_PER_ACCOUNT_HOLDINGS`, `VITE_SKIN_V2` — `apps/frontend/src/lib/env.ts`, per ADR-103/104), and runtime user settings (`colorblindGainLoss` setting **overrides** `VITE_SKIN_V2` after hydration, with a localStorage first-paint cache — a 3-level precedence documented only in code comments in `lib/env.ts:99-106`/`lib/skin.ts`). Provider keys have their own settings-over-env precedence (`src/services/research/providerKeys.js:4-10`). `docs/reference/environment-variables.md:19` documents only `.env`-file layering; nothing states where a new toggle should live or the general env-vs-settings precedence, and ADR-035 is now stale as the governing statement.
  - fix: a short ADR/reference page defining the three toggle layers (build-time VITE / boot env / runtime setting), when each is appropriate, and the standing precedence rule (setting > env > default); note it supersedes ADR-035's "no toggles" posture.

- [ ] **Transaction/locking discipline is real but unwritten — no rule for when `withTransaction` is required, and single-user-ness as the concurrency model exists only as asides** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W5 (cross-cutting concerns)_
  - evidence: inventory — *wrapped + locked*: import commit (`services/importPipeline/commit.js:73`), account merge (`accountMergeService.js:28-34`, FOR UPDATE), recipient merge (`recipientMergeService.js:50-54`), splits (`splitRepository.js:81,122,327-329`, FOR UPDATE), planned execute (`plannedTransactionRepository.js:647,696` + unique-index idempotency per `plannedExecutionService.js:9-12`), transfer reconciliation (`transferReconciliationService.js:96,152-154`), moveHolding, dbEditor (manual BEGIN/FOR UPDATE, `dbEditor.js:198-216,413-440`). *Unwrapped multi-write*: portfolio import commit is deliberately per-row atomic with a header rationale (`services/portfolioImportPipeline/commit.js:1-13`); `services/importPipeline/match.js:30-144` flips batch status + inserts recipients + chunk-updates staging rows with no tx (resumability relied on implicitly); trade create/delete + cash leg is the in-code-acknowledged non-atomic pair (`controllers/investmentController.js:426-437` NOTE comment, delete-side cascade error swallowed at `:475-478` — same root cause as the already-filed repo-client finding, not re-filed); `quoteBackfillService.js:599` delete-then-reinsert of price history (cache-like, backfillable). The single-user assumption that makes the unwrapped set acceptable appears only as asides (`docs/adr/013:98`, `docs/adr/009:62`) — no architecture page states the concurrency model or the "when must a flow be wrapped" rule.
  - fix: one page in docs/architecture/ stating: concurrency model = single user + optional concurrent background jobs; wrap-required criteria (cross-table invariant, merge, ledger pair); "per-row atomic + resumable" as the sanctioned alternative for pipelines, citing the two commit files as exemplars.

- [ ] **Electron main-process logs are stderr-only — nothing persisted, so packaged-app startup failures are undiagnosable after the fact** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W5 (cross-cutting concerns)_
  - evidence: `packaging/electron/main.js` has 28 raw `console.*` sites covering exactly the phases users report (`[migrate]` userData migration :104-111, `[startup]` boot-phase timings :153-161, `[settings]` corrupt-settings quarantine :234-236, `[port]` :292); no `electron-log` in `packaging/electron/package.json`, and every `createWriteStream` in main.js is backups/downloads, not logs. A double-clicked `.app` discards stderr, so when the startup error dialogs fire (`main.js:383,1139`) there is no trail to attach to a bug report. Backend logs at least live in `docker logs`; the shell itself has nothing.
  - fix: a ~15-line append logger writing to `app.getPath('userData')/logs/main.log` (size-capped, rotate-on-boot), routed through the existing tagged console calls; optionally surface "Open log folder" in the error dialogs.

- [ ] **Logger re-resolves level from `process.env` on every single log call** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W5 (cross-cutting concerns)_
  - evidence: `src/config/logger.js:13-20` — `getLogLevel()` runs per call (:39,42,45,48), re-reading 3-4 env vars and lowercasing on each of the ~286 call sites' invocations, including suppressed `debug` calls on hot paths. The frontend mirror does the same (`apps/frontend/src/lib/logger.ts:14-19`). Harmless functionally (env never changes post-boot outside tests) but it's the reason the logger can't also be given richer formatting cheaply.
  - fix: resolve once at module load with a `_setLevelForTests()` escape hatch, or memoize.

- [ ] **Electron main.js: 3.5k-line monolith with exactly one extracted module — backup subsystem alone is ~1,000 lines spread across three non-contiguous regions** ⏫
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W6 (aiChat + Electron shell design)_
  - evidence: `packaging/electron/main.js` (3,514 lines) has one module split: `packaging/electron/backup/bundle.js` (21KB, imported at main.js:11). Everything else is inline. Functional region map: i18n loader 17–79 · demo detection + legacy-userData migration 80–146 · boot marks 147–192 · security headers 193–220 · settings persistence 221–260 · port management 261–312 · workdir/.env management 313–513 · process/notify helpers 514–577 · **backup part 1** (passphrase, key derivation, encrypt/decrypt v1+v2, retention) 578–981 · health polling/watchdog/error page 982–1155 · docker-compose orchestration 1156–1335 · splash theme 1336–1439 · window bounds/creation 1440–1570 · updater (version compare, GitHub release, installer-script writer) 1571–1999 · http helpers 2001–2042 · **backup part 2** (runBackup, bundle backup/restore) 2043–2393 · update IPC 2394–2455 · **backup part 3** (runRestore + backup IPC) 2456–2773 · recovery IPC 2774–2799 · macOS integration (menus, dock, accent, CSV handoff) 2800–3103 · `launch()` 3104–3429 · quit lifecycle 3430–3514. Backup regions total ≈1,050 lines (30% of file) *despite* `backup/bundle.js` proving the extraction pattern works. Updater (≈430 lines incl. `writeInstallerScript` main.js:1629–1700) and compose orchestration (≈180 lines) are similarly self-contained. Entangled-by-globals regions (health watchdog ↔ window ↔ launch) are the genuinely hard splits.
  - fix: continue the `backup/` precedent — move backup crypto/restore into `backup/crypto.js` + `backup/restore.js`, updater into `updater.js`, compose orchestration into `compose.js`; each already communicates with the rest of the file through ≤3 functions (`run`, `composeArgs`, `notify`), so the seams are cheap. Leave `launch()`/window/watchdog in main.js.

- [ ] **IPC sender validation is opt-in per handler: 5 of 20 `ipcMain.handle` channels check the sender, the other 15 don't — no systematic wrapper** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W6 (aiChat + Electron shell design)_
  - evidence: `event.sender !== mainWindow.webContents` guard exists in exactly 5 handlers: `backup:restore` (main.js:2628), `app:renderer-ready` (2818), `app:set-badge` (3001), `app:get-accent-color` (3022), `theme:persist-splash` (3030). The remaining 15 handlers bind `_event` and skip the check, including state-changing ones: `backup:run` (2691), `backup:set-passphrase` (2742), `backup:save-settings` (2724), `update:install-shell` (2416), `update:pull-image` (2394), `recovery:retry` (2774). Exploitability was separately audited clean (single window, contextIsolation); the design problem is that each new handler must *remember* to add the guard, and the current 5/20 split shows nobody can tell which omissions are deliberate.
  - fix: add a `secureHandle(channel, fn)` wrapper that applies the sender check once and use it for all registrations; opt *out* explicitly (with a comment) for the error-page recovery channels if they legitimately come from a non-main webContents.

- [ ] **AI-chat SSE event contract is hand-synchronized in three places with an internal→wire rename layer; shared `@vision/types` package exists but carries none of it** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W6 (aiChat + Electron shell design)_
  - evidence: the event vocabulary lives in (1) the route-header comment `apps/node-backend/src/routes/ai.js:16–22`, (2) the docs table `docs/api/ai.md` (~lines 214–218), (3) the frontend discriminated union `apps/frontend/src/types/aiChat.ts:82–86` — all maintained by hand. On top, the service emits internal names that the route renames for the wire: `tool_message` → `tool_result` (ai.js:327–328) and `assistant_message` → swallowed, replaced by terminal `done` (ai.js:330–332, 340–345); unknown event types are silently dropped by the switch default (ai.js:333–334). Adding one service event means touching service, route switch, docs, and frontend types/store. Meanwhile ai.js:44 already imports `ApiErrorCode` from `@vision/types/errors`, so the shared-package seam exists; the `meta.renderAs` vocabulary (`'table'|'line'|'bar'|'pie'`) is likewise duplicated — 31 backend string literals (tools/*.js) vs frontend `ToolRenderAs` (types/aiChat.ts:49).
  - fix: add `@vision/types/aiChat` exporting SSE event-name constants + payload shapes and the tool-result envelope (`{ok, data, meta: {renderAs, …}}`); import it from route, service, and frontend types; drop the internal/wire rename by emitting wire names from the service.

- [ ] **Context-window management is message-count truncation only — full tool-result JSON replayed verbatim, no token budget, no `num_ctx`/options ever passed to Ollama** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W6 (aiChat + Electron shell design)_
  - evidence: history trimming is `history.slice(-maxHistoryMessages)` (default 30) at `apps/node-backend/src/integrations/ollama/prompts.js:117`; every persisted `tool` row is replayed with its full stringified result payload (prompts.js:86–93) — a single result can carry up to `settings.aiChat.maxToolRows` rows of table JSON, so 30 messages of tool-heavy history can dwarf a small local model's context while "30 messages" reads as safe. No summarization tier exists. Compounding it, `runChatTurn` never passes `options` (e.g. `num_ctx`) to the client even though both `chat` and `chatStream` accept it (client.js:169, 214; service call sites aiChatService.js:244–260), so the model's default context window silently governs how much of the carefully-built prompt survives Ollama's own front-truncation.
  - fix: budget by size, not count — e.g. cap replayed tool-result payloads (elide `data` beyond N rows, keep `meta`), walk history backwards accumulating an approximate char/token budget, and thread a configurable `options.num_ctx` through the service so prompt size and model window are managed by the same code.

- [ ] **Tool-call argument coercion implemented twice with divergent failure semantics (service silently passes bad JSON through; dispatcher throws)** 🔼
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W6 (aiChat + Electron shell design)_
  - evidence: `parseToolCallArguments` in `apps/node-backend/src/services/aiChatService.js:43–56` (returns the raw string unchanged when `JSON.parse` fails, line 51–53) vs `coerceArguments` in `services/aiChat/tools/index.js:107–123` (throws `ToolValidationError` on the same input). The service normalizes at aiChatService.js:318, then `dispatchTool` re-coerces the already-parsed value at index.js:166. The pipeline works end-to-end only because the silent-fallback string happens to hit the throwing path one layer down — two owners of one responsibility, and the persisted `toolArgs` (aiChatService.js:330) can be the *unparsed* string while the dispatcher rejected it.
  - fix: delete the service-side parser; let `dispatchTool` be the single coercion point and have it return the coerced args alongside the result so persistence stores what the tool actually saw.

- [ ] **Implicit, drifting tool-context contract: dispatcher passes `{conversationId, cache}`, tools destructure `{maxRows, cache}` — `conversationId` is never read, `maxRows` never supplied** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W6 (aiChat + Electron shell design)_
  - evidence: dispatch site passes `{ conversationId: conversation.id, cache: toolCache }` (aiChatService.js:325); no tool references `conversationId` (grep across `services/aiChat/tools/*.js` = zero hits); 26 of 29 tools declare `async run(args, { maxRows = settings.aiChat.maxToolRows } = {})` (e.g. expenses.js:59, portfolio.js:76) — `maxRows` only ever comes from the settings default since the dispatcher never sends it (it's a disguised test-injection seam); two tools take `_context` (insights.js:75, planned.js:257). No typedef documents what context contains. Related dead code: `aiChatRepository.updateMessageStatus` (aiChatRepository.js:143) has no callers — `status` is only ever written at insert ('complete' default / 'error' fallback, aiChatService.js:353).
  - fix: declare a `ToolContext` JSDoc typedef in `tools/index.js` ({cache, maxRows}), drop the unused `conversationId` from dispatch, and either pass `maxRows` from the dispatcher or rename the param to make the test-seam intent explicit; delete `updateMessageStatus` or wire it into streaming-failure marking.

- [ ] **Provider seam is 80% there but the error taxonomy and history-replay shape leak Ollama specifics** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W6 (aiChat + Electron shell design)_
  - evidence: the good seam — `runChatTurn` takes an injectable `ollamaClient` (aiChatService.js:139) and depends only on the normalized duck-typed contract `{chat, chatStream} → {content, toolCalls, evalCount, …}` (client.js:192–203, 393–403), so an OpenAI-compatible client is one new factory. The leaks: `instanceof OllamaError` checks in the service (aiChatService.js:277) and routes (ai.js:151); `settings.ollama.defaultModel` referenced from the service (aiChatService.js:102, 203); `/api/ai/status` + `/models` call `getOllamaClient()` directly (ai.js:34); and history replay emits orphan `role:'tool'` messages with no preceding assistant `tool_calls` (prompts.js:78–93, deliberate per the comment) — Ollama tolerates this, strict OpenAI-shape endpoints reject it, so the replay format is provider-lenient by accident.
  - fix: no multi-provider work needed (local-first by design); just decouple on the cheap seams — match on `err.code` instead of `instanceof OllamaError` in the service, and note the orphan-tool-message replay assumption in the prompts.js header so a future provider swap knows it's load-bearing.

- [ ] **Electron shell state = 17 scattered module-scope `let` globals, including a manually re-synced derived trio (`appPort`/`APP_URL`/`HEALTH_URL`)** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W6 (aiChat + Electron shell design)_
  - evidence: main.js module-scope mutables: `i18n` (15), `appPort`/`APP_URL`/`HEALTH_URL` (212–214), `healthWatchdogTimer`/`watchdogFailureCount`/`backendReportedLost` (1083–1085), `mainWindow` (1321), `windowBoundsSaveTimer` (1464), `shellUpdateCheckInFlight`/`pendingShellUpdate` (1568–1569), `backupInFlight` (2690), `rendererReady` (2797), `workDir`/`overrideFiles`/`useRepoMode` (3098–3102), `isQuitting` (3428). The URL pair is derived from `appPort` yet stored separately and re-synced by hand inside `launch()` (main.js:3151–3153) — a forgot-to-update bug waiting for the next writer. No lifecycle/state object groups any of this.
  - fix: cheapest wins first — replace the trio with `appUrl()`/`healthUrl()` accessor functions over the single `appPort`; when extracting modules (see monolith finding) let each extracted module own its state (watchdog state → health module, update flags → updater module) instead of introducing a big state object.

- [ ] **Electron IPC contract triplicated by hand: main.js handlers ↔ preload JSDoc ↔ renderer TS types (with `electronRecovery` untyped)** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W6 (aiChat + Electron shell design)_
  - evidence: the same 20-method surface is described in `packaging/electron/main.js` (handler returns), `packaging/electron/preload.js:10–188` (JSDoc), and `apps/frontend/src/lib/api/electron.ts:6–63` (hand-written `ElectronUpdater`/`ElectronBackup`/`ElectronAPI` types, accessed via per-call `window as` casts at electron.ts:71–81 rather than a global `Window` augmentation). Optional members (`checkRelease?`, `isEncrypted?` etc., electron.ts:7,32) are a deliberate old-shell-compat strategy — good — but nothing ties the three copies together, and `electronRecovery` (preload.js:175–188) has no renderer type at all (used only by `error.html`). Return-shape drift between a handler and electron.ts would be caught by nothing.
  - fix: author one `electron-api.d.ts` next to preload.js as the source of truth, reference it from preload JSDoc (`@type` imports) and re-export it into the frontend via the existing `@vision/types` package.

- [ ] **Demo compose file is outside the compose-mirror rule that exists specifically because of the v1.0.2 data-loss bug** 🔽
  - ↪ _from: Architecture & code design 2026-07-06 · Wave W6 (aiChat + Electron shell design)_
  - evidence: main.js is shared, not forked — demo divergence is a single runtime flag `__IS_DEMO` referenced 4× (main.js:80–83, 84, 92, 116), which is clean. But `packaging/electron/resources-demo/docker-compose.yml` is a hand-maintained sibling of `resources/docker-compose.yml` (same three named volumes today: postgres_data/attachments_data/vision_cache_data, resources compose:54–57 vs resources-demo compose:65–68), and the path-scoped rule `.claude/rules/packaging.md` mandates mirroring only for root ↔ `resources/docker-compose.yml` — the demo copy can silently drift (a new named volume added to root+resources but not resources-demo would re-create the v1.0.2 failure mode inside the demo, low stakes since demo data is synthetic and rebuildable).
  - fix: add `resources-demo/docker-compose.yml` to the mirror checklist in `.claude/rules/packaging.md`, or better, have `install-demo.sh` derive the demo compose from `resources/docker-compose.yml` + a small override instead of a full copy.

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
  - Verification (2026-07-03, D1 residue): `bun.lock` resolves only `fast-uri@3.1.2` — the first-patched version for GHSA-v39h-62p7-jpjc, and past 3.1.1 for GHSA-q3j6-qgpj-74h6 (neither advisory withdrawn). Both ignored GHSAs are moot in-tree today, so this finding is **no longer release-blocking** — but the underlying drift (release `verify`'s `bun audit` omitting CI's ignore flags) is still real and worth fixing so the two audit commands can't silently diverge again in the future; the ignore flags at `ci.yml:81-83` are now stale/droppable.

- [ ] **`.env` (real secrets) is not in `.dockerignore` and ships in every build context** ⏫
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `.dockerignore:13-17` — excludes `.env.local` / `.env.*.local` but not `.env` itself; `/Users/computer/Code/Vision/.env` (mode 600, contains `POSTGRES_PASSWORD` + `DATABASE_URL`) is sent to the Docker daemon on every `docker compose build`. Today no `COPY` grabs it, but a single future broad `COPY` (or a remote/buildx builder) would bake the DB password into an image layer or upload it off-host.
  - Fix: add `.env` (and `.env.*`, re-allowing `.env.example` with `!.env.example`) to `.dockerignore`.

- [ ] **In-app shell updater requires a release asset the pipeline never publishes** ⏫
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `packaging/electron/main.js:1725-1728` — `pickSourceLauncherZip` only accepts an asset matching `vision-source-launcher-.*-arm64\.zip`; `.github/workflows/release.yml:333-338` uploads only `Vision-*.dmg`, `Vision-*.zip`, `vision-setup.command`, `README.md`, `*.sha256` — nothing anywhere in the repo builds or uploads a source-launcher zip (`grep -r source-launcher` hits only main.js).
  - `packaging/electron/main.js:1940-1980,3336-3338` + `apps/frontend/src/components/settings/sections/AboutSection.tsx:116`, `components/notifications/UpdateNotification.tsx:111` — in source/repo mode (how the user's own `Vision.app` runs via `install.sh`), the startup dialog announces the new version, the user clicks Download, `prepareShellUpdateInstaller` returns `{ up_to_date: true, error: 'No compatible source launcher update asset found.' }`, and the flow silently exits — the update can never install and the prompt recurs every launch after any newer tag. The Settings/notification buttons hit the same dead end.
  - Fix: add a release.yml step that zips `unsigned/Vision/` (source tree) + `unsigned/launch.command` as `vision-source-launcher-<ver>-arm64.zip` with a `.sha256`, or delete the source-launcher updater path and fall back to opening `html_url`.

- [ ] **Web (non-Electron) deployments get wrong update-install instructions** ⏫
  - ↪ _from: DevOps research 2026-07-03 · Wave D3 (residue, closed 2026-07-03)_
  - `/api/admin/update/check`'s payload omits `update_mode` (`routes/admin.js:81-97`) → `UpdateNotification` defaults to `'source'` (`UpdateNotification.tsx:64`) and shows an Install button to browser users with no `isElectron()` gate (unlike `AboutSection.tsx:216`); clicking it calls `installShellUpdate()`, which no-ops outside Electron (`lib/electron.ts:140-144`) and shows a "Close and reopen the app" toast — wrong instructions for a docker-compose self-host (the correct action is `docker compose pull`). `settings.app.updatesHintWeb` (`en.json:2442`) is equally wrong for pure-web deployments. `source_launcher_available` (produced in three places, `main.js:1793,1875,1904`) is consumed nowhere in the frontend — a dead payload; the `update_mode` gate above is the live half of the same wiring gap.
  - Fix: needs a product decision — gate the Install button on `isElectron()`, or have the backend return `update_mode: 'docker-compose'` with correct instructions (and fix `updatesHintWeb` to match).

- [ ] **Devcontainer writes platform-specific state into the shared host workspace (node_modules, venv, .env)** ⏫
  - ↪ _from: DevOps research 2026-07-03 · Wave D4_
  - `.devcontainer/post-create.sh:67-74` — first container boot detects the host's macOS venv as broken, `rm -rf ./venv` and rebuilds it with Linux CPython **on the bind mount**, so back on the host `bun run db:upgrade` (`package.json:37` → `venv/bin/alembic`) dies with "cannot execute binary file" until you manually rebuild the venv.
  - `.devcontainer/post-create.sh:98` + `.devcontainer/bin/claude:93` — `bun install --frozen-lockfile` runs inside the bind-mounted workspace with no volume over `node_modules/`, replacing macOS platform binaries (esbuild/rollup/lightningcss) with Linux ones; every host↔container switch breaks the other side's dev loop until a reinstall.
  - `.devcontainer/post-create.sh:78-91` — on a fresh clone it also writes a repo-root `.env` with `POSTGRES_PASSWORD=localdev` that host-side `docker compose` (`env_file`) and `loadDotenv` would silently consume.
  - Fix: put the container's venv and node_modules outside the mount (named volumes over `./venv` and `./node_modules`, or `/home/dev/venv` + change `ALEMBIC_BIN` in `bin/claude:82`), and write the generated env file to a container-local path.

- [ ] **No enforced branch protection / required status checks on `main`** ⏫ 🔎 needs-GitHub-check 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - The repo is private on a plan tier without classic branch protection or rulesets (`gh api .../branches/main/protection` and `.../rulesets` both 403 "Upgrade to GitHub Pro"). None of the 13 CI gates can structurally block a merge or direct push — they only report. Mitigated today by solo-dev discipline + the "commit to main" workflow, but no backstop if that lapses or a token is compromised.
  - Fix: upgrade to GitHub Team/Pro (or make public) to enable rulesets; require `CI Complete` + CodeQL before merge.
  - Verification (2026-06-30): re-confirmed live — `gh api repos/EraPartner/Vision/branches/main` returns `"protected": false` today, independently corroborating the 403s.
  - Verification (2026-07-03, D1 residue, live `gh api` read): the picture has changed since 2026-06-30 — the repo is now public and a ruleset "Protect main" exists (id 14889474, `enforcement: active`, created 2026-04-09): requires exactly ONE status check (`CI Complete`, strict), a `code_scanning` rule (CodeQL `high_or_higher` + Trivy `errors`) plus `code_quality: errors`, PR-required with 0 approvals, linear history, required signatures, non-fast-forward. So "none of the 13 CI gates can structurally block a merge" is no longer accurate for non-admins — but (a) the sole required check (`CI Complete`) is exactly the one undermined by the skipped-tier bypass bug filed at the top of this section, (b) the `code_scanning` rule does not block when a scan is merely skipped/missing for the PR (see the PR #73 evidence below), and (c) `bypass_mode: always` for `RepositoryRole 5` (admin) means the repo owner's direct pushes bypass every one of these rules — which is why unsigned direct-to-main commits work despite "required signatures". Net: protection now exists on paper but the two live gaps in this domain (skipped-tier + admin-bypass) mean the practical exposure this finding described is still largely present. Full ruleset enumeration in Checked-clean below.

- [ ] **Dependabot auto-merge has no required-checks backstop** ⏫ 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - `.github/workflows/auto-merge.yml:28` — `gh pr merge --auto` only waits on checks marked *required*, and (per above) none are. A patch/minor dependency PR can complete its auto-merge independent of whether tests/lint/Trivy passed or even failed.
  - Fix: either fix branch protection above, or have the workflow explicitly `gh pr checks --watch` and gate on the result before calling `gh pr merge`.
  - Verification (2026-06-30): re-confirmed with live evidence — PR #73 merged via auto-merge on 2026-06-23 while its "Build Docker Image" check was failing. (That specific failure is a known artifact-quota false-positive, not a real defect — but the structural finding stands: nothing distinguishes a benign failure from a real one before merge.)
  - Verification (2026-07-03, D1 residue): downgrade — a required-checks backstop DOES exist (`allow_auto_merge: true` + `CI Complete` IS a ruleset-required check), so the "zero CI merge" worst case as originally framed is refuted; PR #73's `trivy-scan` was SKIPPED, not failing, and the `code_scanning` ruleset rule doesn't block on a missing/skipped scan (required-tools-list ≠ required-fresh-analysis). The actual residual exposure is exactly the `ci-complete` skipped-tier bypass bug filed at the top of this section — not "no backstop at all".

- [ ] **Precedent: an auto-applied migration shipped a destructive DROP ahead of its coupled code and crashed boot — no automated guard against recurrence** ⏫ 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - `alembic/versions/0055_drop_bank_account_string.py` (now neutered to a no-op) + recovery in `0056_restore_bank_account_after_premature_drop.py`; doctrine in ADR-088
  - The app runs `alembic upgrade head` unconditionally on every boot. 0055 originally dropped columns/a trigger/a matview; because it ran before the dependent app code shipped, it crashed startup. The fix was manual (a docstring + convention), not tooling-enforced — there's still no CI check flagging destructive DDL (`DROP TABLE/COLUMN`, narrowing `ALTER COLUMN TYPE`) landing without an explicit marker. Self-hosted users with no DB expertise have nothing protecting them from this recurring beyond developer memory of this one incident.
  - Fix: add a CI check (parallel to `verify-compose-sync`) that flags destructive DDL in new migrations and requires an explicit marker/ADR reference.

- [ ] **E2E/accessibility CI workflow has been failing on every single nightly run for a month with zero alerting** ⏫ 🔧 *(escalated — confirmed worse than originally reported)*
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - `.github/workflows/e2e.yml:8-11` claims "has not yet had a live run on GitHub Actions" — that comment is **stale**. Live `gh run list --workflow=e2e.yml` shows it has run on its nightly schedule every day since at least 2026-06-01 (30/30 fetched runs) and **failed every single time**. Root cause confirmed from an actual job log: the workflow never writes a `.env` file before `docker compose -f docker-compose.yml up -d --build`, so the stack never comes up (`env file ... not found`). The only failure handling (`if: failure()` at `:86-88`) dumps logs into the run's own output — no issue creation, no Slack/email — so this has been silently red for ~30 consecutive days.
  - Fix: have the workflow write a minimal `.env` before `docker compose up` (mirror `ci.yml`'s pattern at lines 532/601), re-verify via `workflow_dispatch`, then add failure notification (issue auto-creation or similar). Also fix the stale in-file comment.
  - Verification (2026-07-03, D1 residue): even once the `.env` fix lands, the a11y gate itself (`a11y.spec.ts:44-55`, fails on any critical OR serious axe violation across 9 pages) has never actually executed in CI — one supervised `workflow_dispatch` run is still needed to confirm it passes, alongside real job runtime vs. the 30-minute budget (`e2e.yml:31`, tight with 36 tests at `workers:1` + 2 retries and no buildx/GHA cache in this workflow) and empty-DB safety of all 36 tests. Rest of the wiring checks out statically: browser install matches the pinned Playwright version (`bun.lock:434`), `PLAYWRIGHT_BASE_URL`/CI env (`e2e.yml:86-88`) matches `playwright.config.ts:3-5`, `global-setup`'s onboarding PUT passes `csrfGuard.js:42`, the stub `.env` is byte-identical to `docker-verify`'s, and all 6 specs exist (no `.only`, no hardcoded ports). Minor accompanying nits: a redundant host-side `generate-locales` step (`e2e.yml:50-51` — the image already builds its own per `Dockerfile:45`); `visual.spec.ts` running in no workflow is likely deliberate (Linux screenshot baseline) — see the already-filed "hardcodes six spec files" finding below.

- [ ] **`VISION_IMAGE=vision:ci` is a no-op — the "build once, reuse" image artifact is never used; docker-verify and live-contracts each rebuild from scratch** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/ci.yml:534-537,603-606` export `VISION_IMAGE` before `docker compose up`, but `docker-compose.yml:22` defines the app service as `build: .` with no `image:` key, so compose ignores the variable, ignores the loaded `vision:ci` image, and rebuilds the image (uncached) in both jobs. The build-image job + tar upload/download (the thing hitting the artifact quota) buys nothing for these two jobs — only trivy-scan actually consumes the artifact.
  - Fix: add `image: "${VISION_IMAGE:-vision-app:local}"` to the app service in `docker-compose.yml` (mirror in the electron resources compose per packaging rules) and pass `--no-build` in CI so the loaded image is provably reused.

- [ ] **Artifact-quota relief design validated: replace the image-tar hand-off with a GHA cache-based rebuild** ⏫
  - ↪ _from: DevOps research 2026-07-03 · Wave D1 (residue, closed 2026-07-03)_
  - `.github/workflows/ci.yml:448,454` — `build-image` produces `outputs: type=docker,dest=/tmp/vision-ci.tar` and uploads it as an artifact; that upload is what hits the GHA artifact quota, causing the `build-image` failures that in turn trigger the `ci-complete` skipped-tier bypass filed at the top of this section. `trivy-scan`/`docker-verify`/`test-live-api-contracts` (`:475`,`:522`,`:591`) each download that tar.
  - Validated fix (works with the existing topology, eliminates the artifact class entirely): keep `cache-to: type=gha,mode=max` on `build-image`, drop the tar output + upload, and have each downstream job run `docker buildx build --load -t vision:ci --cache-from type=gha .` (a fully cache-hit rebuild), plus add a CI-only `docker-compose.ci.yml` override giving the `app` service an `image: vision:ci` key (no `build:`) so compose actually consumes the built image — which also fixes the already-filed dead `VISION_IMAGE` export above (today `docker-compose.yml`'s `app` is `build: .` with no `image:` key, so `VISION_IMAGE` is ignored and both downstream jobs rebuild uncached). A GHCR-push variant (`packages: write` on `build-image`, push `ghcr.io/erapartner/vision:ci-<sha>`, downstream pull) is also workable but needs CI-tag retention cleanup and gains nothing over the cache route. Caveat: GHA's 10 GB cache eviction means a downstream job can still hit a full uncached rebuild in the worst case — correct, just slow, no worse than today's behavior.
  - Fix: implement the cache-based hand-off described above; this eliminates the artifact-quota failure class that today makes the `ci-complete` skipped-tier bug practically exploitable.

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
  - Verification (2026-07-03, D1 residue): the gap this finding names is now closed — the ruleset config (enumerated on the "No enforced branch protection" finding above, and in Checked-clean below) is verified and documented live via `gh api`, not "unverified anywhere" as originally framed. `CI Complete` is confirmed to be the ruleset-required check. Residual risk collapses into the `ci-complete` skipped-tier bypass bug (🔺 above) and the open question of whether the `code_scanning` rule should hard-require a fresh Trivy analysis per PR (a GitHub-side settings question, not repo-side — empirically it does not block today).

- [ ] **Build context is ~1.2 GB of irrelevant files** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `.dockerignore:1-5` — `node_modules/` patterns only cover root/apps/packages; `packaging/electron/node_modules` (605 MB), `packaging/electron/dist` (503 MB), `venv/` (76 MB), `.playwright-mcp/` (31 MB), plus `docs/`, `.claude/`, `.idea/`, `.obsidian/`, `.github/`, `TODO.md` all enter the context. Every cold `docker:dev`/Electron local build transfers >1 GB to the daemon for a Dockerfile that only COPYs ~7 paths.
  - Fix: switch `.dockerignore` to an allowlist (`*` then `!package.json`, `!apps/`, `!packages/`, `!i18n/source/`, `!alembic/`, `!config/alembic.ini`, `!scripts/…`, `!docker-entrypoint.sh`, `!bun.lock`), or at minimum add `packaging/`, `venv/`, `docs/`, `.playwright-mcp/`, `**/node_modules`.

- [ ] **Dev↔packaged-app DB sharing silently depends on the repo directory being named "Vision"** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `docker-compose.yml:1` vs `packaging/electron/resources/docker-compose.yml:2` — the packaged compose pins `name: vision`; the root compose has no `name:` key, so its project name (and thus `vision_postgres_data`) derives from the checkout dirname. Clone the repo as `vision-2` (or a worktree) and `docker:dev` quietly creates a fresh empty DB instead of the "single source of truth" that `docker-compose.dev.yml:4-6` promises — or worse, users think data vanished.
  - Fix: add `name: vision` to the root `docker-compose.yml` (and to the CI compose-sync guard's checked keys).
  - Verification (2026-07-03, D2 residue): reconfirmed and the sharing itself is intentional design — `docker-compose.dev.yml:1-10` explicitly documents sharing `postgres_data` with the packaged Vision.app as the "single source of truth". The dirname-fragility is real as filed; the one-line fix stands.

- [ ] **`install.sh` requires `node` but only ever installs `bun`** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D2_
  - `install.sh:110-114,157-170` — the settings-merge branch shells out to `node -e`. On a machine where the script itself installed Bun (its own premise), `node` may not exist; with `set -e` the script dies at the very last step after the .app is already installed, leaving `repoPath` unwritten so the packaged app pulls GHCR instead of building locally — a confusing half-configured state.
  - Fix: use `bun -e` (already guaranteed present) or fall back: `command -v node || node() { bun "$@"; }`.

- [ ] **`APP_IMAGE_TAG` is never set — packaged app tracks `:latest`, contradicting the compose file's own comment** 🔼
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `packaging/electron/resources/docker-compose.yml:21-24` — comment claims "Electron sets APP_IMAGE_TAG to the exact version tag so `docker compose pull` fetches the correct image", but `APP_IMAGE_TAG` appears nowhere in `packaging/electron/main.js`, `install.sh`, or the workflows; the image resolves to `${APP_IMAGE_TAG:-latest}` → always `:latest`.
  - Consequences: shell version and backend image are never tied (an image prune + reboot silently pulls a newer `:latest` and auto-runs irreversible migrations against an older shell); rolling back to an older DMG cannot roll back the image; `packaging/release/README.md:143` uninstall (`docker rmi ghcr.io/erapartner/vision:__VERSION__`) leaves the actually-used `:latest` tag behind; the `vision-setup.command:13` pinned-tag pre-pull only warms layers by coincidence of digest equality.
  - Fix: have main.js export `APP_IMAGE_TAG` = its own package.json version into the compose env (bump it in the docker-image-update path), or delete the false comment and pin `:latest` intentionally with a documented rollback story.
  - Verification (2026-07-03, D2 residue): the GHCR publish side (`release.yml:134-206`) is actually solid — multi-arch (amd64+arm64), semver-tagged, and Trivy re-scans the pushed image by digest — the gap is entirely on the consume side (packaged app pulling the mutable tag with no digest pin), as already filed. Acceptable for the update flow as-is; noted, not escalated.

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

- [ ] **Desktop app's backend update path pulls a mutable image tag with no signature verification** 🔼 🔎 verified-present 2026-07-11
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
  - Verification (2026-07-03, D2 residue): the "user just sees an endless spinner" claim is stale for the Electron path — orchestrator failure surfacing is actually good: a boot `pollReady` timeout falls through to a localized `error.html` with a Retry button (`main.js:1120-1146`, `buildErrorPageUrl` at `:1067-1077`), and a post-boot health watchdog (`main.js:1095-1118`) emits `backend:lost`/`backend:restored` to the renderer on sustained failure. Detection is HTTP `/health`-only though (no Docker restart-count reads), so a tight flap could still oscillate lost/restored without a clear final verdict — and this doesn't help non-Electron (pure docker-compose) self-hosts at all, where the original "endless restart, no distinct signal" critique still fully applies.

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

- [ ] **`docs/reference/scripts.md` has further inaccuracies beyond the notarization claim** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D3 (residue, closed 2026-07-03)_
  - `docs/reference/scripts.md:87` — the `db:precision-drift` row claims it performs DB checks; the script is actually a static source scan and never touches the database.
  - Root `prepare` and `hooks:setup` scripts are undocumented; the `packaging/electron` workspace has no table at all despite the doc's claim that its tables mirror "those three files verbatim". (All other rows were verified verbatim-accurate.)
  - Fix: correct the `db:precision-drift` description, add the missing `prepare`/`hooks:setup` rows, and add (or explicitly scope out) a `packaging/electron` table.

- [ ] **`unsigned/launch.command`'s project-discovery fallback can launch/install an arbitrary sibling project** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D3 (residue, closed 2026-07-03)_
  - `packaging/electron/unsigned/launch.command:14-21` — globs `$DIR/*` alphabetically and takes the FIRST subdirectory containing any `package.json`, then runs `bun install` (executing that project's install scripts — arbitrary unvetted code) before exec'ing `electron:prod`. A same-parent-directory clone/checkout ordering could make it pick the wrong project.
  - Same file: `curl | bash` bun installer (`:34`) and `bun install || true` swallowing install failures (`:49,:53`).
  - Fix: accept only a candidate whose `package.json` name is `vision`.

- [ ] **`densify-asset-history.js` writes to the DB with no dry-run/confirmation gate** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D3 (residue, closed 2026-07-03)_
  - `apps/node-backend/scripts/densify-asset-history.js:24-33` — inserts into `asset_price_history` and recomputes snapshots with no `--dry-run` or confirmation prompt. Mitigated by the operation being additive-only and idempotent, but running it against the wrong environment gives no warning first. (`index-stats.js` and `check-precision-drift.js`, the other two scripts in the same directory, are read-only and clean.)
  - Fix: add a `--dry-run` flag or an explicit `--yes` confirmation gate before the writes.

- [ ] **Demo-data generator hardcodes `TODAY` to a fixed past date and stamps a literal Alembic revision — the mechanism behind the known demo multi-head crash-loop** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D3 (residue, closed 2026-07-03)_
  - `packaging/electron/demo-db/generate.mjs:19` — `TODAY` is hard-anchored to 2026-06-18, so regenerated demo data goes stale/overdue as calendar time passes.
  - `packaging/electron/demo-db/generate.mjs:33` — `alembic_version` is stamped with the literal string `'0060_brokerage_import_routing'`, with nothing checking that this stamp matches the actual repo head at regen time — this is the exact mechanism behind the persisted-demo-volume multi-stamped-heads crash-loop gotcha documented in CLAUDE.md.
  - Fix: derive `TODAY` from the real current date (or document that it must be bumped periodically), and derive the stamped revision from the actual current Alembic head instead of a literal string.

- [ ] **Volume-level disaster recovery for `postgres_data` is manual-only — no scheduled backup cadence** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D2 (residue, closed 2026-07-03)_
  - `docs/guides/deployment.md:179-198` documents only ad-hoc `pg_dump`/`pg_restore`; `docs/guides/deployment.md:450` ("Setup regular database backups") is an unchecked checklist box. The Electron app-level backup keeps only the newest 7 bundles. RPO is whatever the user last ran manually (a dump or an app backup) — a volume loss between those is otherwise unrecoverable.
  - Fix: document (or ship) a scheduled `pg_dump` cadence + retention policy.

- [ ] **`vision-claude-sync` (fish) pull path fails silently, and jq merge is container-wins for existing keys** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D4 (residue, closed 2026-07-03)_
  - `__claude_sandbox_sync.fish:116-121` — the pull path uses `; or true` plus redirects stderr to `/dev/null`, so a failed rsync/jq still prints "[pull] done" with no indication anything went wrong.
  - Pull-side jq merge is container-wins for existing keys — a host-side key update never reaches a container that already has that key (the `history.jsonl`/`todos` merge direction is container→host, which is cosmetic and fine).
  - Push/pull are otherwise additive newer-wins rsync (no `--delete`), with host backups and `.credentials.json` excluded both ways — the overall data-loss verdict is GOOD; this is a diagnostics gap, not a data-loss risk.
  - Fix: check the rsync/jq exit codes on pull and surface a real failure message instead of the fixed "[pull] done".

- [ ] **apple/container `cp` mtime fidelity is load-bearing for the sync tool's newer-wins logic and unverified** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D4 (residue, closed 2026-07-03)_
  - The host↔container sync (`vision-claude-sync`) decides push/pull direction by `--update` (mtime comparison). If `apple/container cp` doesn't preserve source mtimes, every push could overwrite newer host edits. Cushioned by host backups (last 5 kept) and the fact that autosync can fire per session exit, but the underlying assumption itself has not been verified against a live container.
  - **Needs live verification** — not yet empirically checked; requires a live sandbox test (copy a file with a known non-current mtime through `apple/container cp` and confirm it survives).
  - Fix: none until verified; if `cp` doesn't preserve mtimes, either preserve them explicitly (`cp -p`-equivalent) or switch the sync decision to a content hash instead of mtime.

- [ ] **Staged `claude.json` still carries the full `.projects` map (prompt history/OAuth metadata) into the sandbox** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D4 (residue, closed 2026-07-03)_
  - The curated host→container stage exists specifically to strip sensitive host state before it enters the sandbox (it already strips `.credentials.json`/`.oauthAccount`/`.projects`-adjacent hooks per `launcher-common.sh`), but the staged `claude.json` itself still carries the full `.projects` map — exactly the leak class the staging step exists to prevent.
  - May be intentional (the sync tool's status output does count/report it) — needs a user decision on whether it should be stripped too.
  - Fix: pending user decision — if unintentional, strip `.projects` from the staged `claude.json` the same way other sensitive host state is stripped.

- [ ] **`docs/reference/environment-variables.md` has drifted from actual env-var usage in both directions** 🔽
  - ↪ _from: DevOps research 2026-07-03 · Wave D4 (residue, closed 2026-07-03)_
  - `VITE_SKIN_V2` is read by the frontend (`lib/env.ts`) but undocumented.
  - `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_NAME` are documented (`:140-143`) as "injected for Alembic" and are indeed injected by both compose files, but no code actually consumes them — `alembic/env.py:19` reads only `DATABASE_URL`. Stale in both the doc AND the compose files.
  - Of the 69 documented vars, 59/64 extractable ones were verified as genuinely read; this diff covers the discrepancies found.
  - Fix: add `VITE_SKIN_V2` to the doc; either wire `DB_HOST`/`PORT`/`USER`/`NAME` into something that reads them or remove them from compose + doc.

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
  - `apps/frontend/.env.local.example` is separately missing `VITE_ENABLE_PER_ACCOUNT_HOLDINGS` and `VITE_SKIN_V2` (both parsed at `lib/env.ts:66,72`; arguably also `VITE_DEVTOOLS`) — same class of env-example incompleteness, in the frontend's own template. (`packaging/electron/resources/.env.example` is never read by code — `main.js` generates the real `.env` itself — so it's human-reference-only and lower stakes.)
  - Verification (2026-07-03, D4 residue): `FRED_API_KEY` gap reconfirmed and cross-checked against Electron's own `PROVIDER_KEY_VARS` (`main.js:424-427`), which wires it too.
  - Fix: add a commented `# FRED_API_KEY=` line with the free-tier note (root `.env.example`); add the two missing `VITE_*` lines to `apps/frontend/.env.local.example`.

- [ ] **`SECRET_KEY` documented and seeded in CI but never read by any backend code** 🔽 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - `docs/guides/deployment.md:55,434,447`, `.github/workflows/ci.yml:532,601` vs. zero references in `apps/node-backend/src`
  - Operators are told to "set a secure SECRET_KEY" for an auth system that doesn't exist (the real gate is `ADMIN_AUTH_TOKEN`, documented separately and correctly). False sense of configuration.
  - Fix: remove from the deployment checklist + CI stub, or mark explicitly reserved/unused.
  - Verification (2026-06-30): re-confirmed, and the "never read" claim holds repo-wide (grepped all `.js/.ts/.tsx/.py`, not just the backend), so the underlying claim is if anything stronger than stated.

- [ ] **`gitleaks.toml` whole-file-allowlists `opencode.json`** ⬇
  - ↪ _from: DevOps research 2026-07-03 · Wave D1 (residue, closed 2026-07-03)_
  - `config/gitleaks.toml:12-14` — a real secret ever committed to that specific file would be permanently masked from all future scans. Rest of the config is sane (`useDefault = true`, `.obsidian/` path allowlist, match-scoped placeholder regexes).
  - Fix: scope the allowlist to specific known placeholder patterns in that file instead of the whole path, or remove the allowlist and fix any current false positives directly.

- [ ] **`.githooks/pre-commit` has a couple of robustness gaps: silent gitleaks degrade, `xargs` without `-0`** ⬇
  - ↪ _from: DevOps research 2026-07-03 · Wave D3 (residue, closed 2026-07-03)_
  - `.githooks/pre-commit:54-55` — if `gitleaks` isn't installed locally, the hook prints a hint instead of failing, so a contributor without the binary gets no local secret-scan coverage at all and may not notice.
  - `.githooks/pre-commit:93,95,108` — pipes filenames through `xargs` without `-0`/`--null`, which breaks on filenames containing whitespace.
  - Fix: make the missing-gitleaks case a visible warning that must be acknowledged (or fail closed with install instructions); pair the `printf`s with `-print0`/`xargs -0` (or switch to a NUL-safe read loop).

- [ ] **Host `guard.mjs` has a pipe-chain bypass gap in its command-deny rules** ⬇
  - ↪ _from: DevOps research 2026-07-03 · Wave D4 (residue, closed 2026-07-03)_
  - `curl x | tee f | sh` bypasses the `curl | sh` deny pattern; `grep`/`node -e` secret-reading commands pass the `SECRET_READ` check. Enforcement is in-container-only by design — the host copy of the same guard is advisory only (acknowledged in its own header) — so this is a defense-in-depth gap, not a bypass of the actual sandbox boundary. All 14 regexes compile correctly and malformed payloads fail open into the normal permission flow (correct behavior).
  - Fix: extend the deny patterns to catch multi-stage pipes ending in a shell, and broaden `SECRET_READ` detection to cover `grep`/`node -e` style reads — low priority given the in-container-only threat model.

- [ ] **`pip-audit` is installed unpinned at run time in both workflows** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `.github/workflows/ci.yml:103`, `release.yml:107` — `pip install pip-audit` pulls latest from PyPI on every run: non-reproducible and a (small) supply-chain surface, inconsistent with the repo's otherwise strict SHA-pinning.
  - Fix: pin it (`pip install pip-audit==X.Y.Z`) or use the pinned `pypa/gh-action-pip-audit` action.

- [ ] **`test:e2e` hardcodes six spec files — new e2e specs are silently never run, and `visual.spec.ts` runs nowhere** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D1_
  - `apps/frontend/package.json:17-18` — a new `e2e/*.spec.ts` added without updating the script is dead code in the nightly run; visual regression specs aren't executed by any workflow.
  - Fix: run `playwright test` with `testIgnore` for visual specs (so new files are included by default) and decide whether visual specs join the nightly job.
  - Verification (2026-07-03, D1 residue): `visual.spec.ts` being excluded from `test:e2e` and run in no workflow is likely deliberate (Linux screenshot baseline vs. the developer's local macOS rendering) rather than an oversight — doesn't change the fix recommendation, just the urgency.

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

- [ ] **`sync-nl-with-en.js` appends new keys unsorted, never prunes orphaned NL keys, and JSON-parses without error handling** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D3 (residue, closed 2026-07-03)_
  - New keys are appended in whatever order they're encountered rather than sorted to match `en.json`; keys removed from `en.json` are never pruned from `nl.json` (orphans accumulate); a raw `JSON.parse` throws an unhandled exception on malformed input. (It correctly never overwrites a non-empty NL value — see Checked-clean.)
  - Fix: sort appended keys, add an orphan-prune pass, and wrap the parse with an actionable error message.

- [ ] **`alembic/env.py` loads `config/.env.local`, but docs/CLAUDE.md describe root `.env.local`** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D2 (residue, closed 2026-07-03)_
  - `alembic/env.py:12-14` — one-line path drift between what the code actually loads and what's documented; worth clarifying to avoid confusion when debugging DB connection issues.
  - Fix: align the doc/comment with the actual load path, or move the load path to match documented convention.

- [ ] **Minor packaging config nits** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D3_
  - `packaging/electron/package.json:6` — `"packageManager": "bun"` is not a valid corepack value (must be `name@version`); breaks the build the day corepack is enabled on the runner.
  - `packaging/electron/demo-db/regenerate.sh:24` — `PGBIN` hardcoded to `/opt/homebrew/opt/postgresql@18/bin`; fails on any machine without that exact keg (no PATH fallback like the alembic resolution above it has).
  - Fix: remove the `packageManager` field (or set `bun@<version>`); resolve `psql` via `command -v` with the homebrew path as fallback.

- [ ] **Generated locale artifacts are committed in triplicate — growth vector, not yet a problem** ⏬
  - ↪ _from: DevOps research 2026-07-03 · Wave D4_
  - `i18n/source/*.json` + `apps/frontend/src/locales/*.ts` + `packaging/electron/i18n/*.json` (~1.2 MB total, all rewritten by `scripts/generate-locales.js`) plus the periodically re-dumped `packaging/electron/demo-db/01-demo.sql` (1.1 MB) are the main repo-churn sources; pack is still only 17 MiB so this is informational. Note the committed copies are load-bearing (`package.json:21` skips generation in CI), so don't untrack without changing CI.
  - Fix: none needed now; if pack size ever matters, generate electron/i18n copies at package time instead of committing them.

- [ ] **Postgres image pinned by floating tag, inconsistent with digest-pinning everywhere else** ⏬ 🔎 verified-present 2026-07-11
  - ↪ _from: Codebase audit 2026-06-30 · DevOps/CI-CD/Packaging_
  - `docker-compose.yml:3`, `packaging/electron/resources/docker-compose.yml:5` — `postgres:18-alpine`
  - The app `Dockerfile` and devcontainer `Dockerfile` are both digest-pinned; Postgres (holding all user financial data) isn't.
  - Fix: pin to a digest; Dependabot's `docker` ecosystem entry already exists to manage bumps.

- [ ] **`.dockerignore` omits the plain `.env` file** ⬇ 🔎 verified-present 2026-07-11
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

**Wave 1a remaining residue:** BLOCKED — real-export verification of BNP/SABB status vocabulary and Belfius/KBC encoding: zero real bank-export fixtures exist in the repo (no `*.csv` outside `node_modules`; every adapter test uses inline synthetic strings). Needs user-provided real exports — do not fabricate.

**Wave 2a remaining residue:** nothing 500-class/boundary-case was runtime-reproduced against a live API (would need a demo-app pass to pin before fixing) · nl eyeball still not done for tax, research, portfolio, statsPage, customChart, addInv, rebalance, performance, export, admin, cashflow, insights, owesPage, aiChat, dbEditor, recipients*, invDetail, market, networth, exchangeRates + small namespaces (mechanical parity/placeholder screens already covered the whole file) · `pit.ts` full per-deduction clamp walk not done · planned PATCH beyond the form mapper (inline toggleActive, execute/link flows, repo update whitelist) not swept · not audited: transaction-side `CsvColumnMapper` + import-review row-edit UI, `InvestmentDetailDialog`/`MoveHoldingDialog` + `POST /api/investments/:id/move`, `POST /api/transactions/bulk` update/delete paths, bank-CSV adapters' truncation vs bounded raw-table columns, `translateRepoError` 400-vs-500 envelope consistency · unverified: changing an investment's native currency in `EditInvestmentDialog` doesn't re-stamp existing txns' `fx_rate_to_eur` · unclear whether any UI surface promises auto-generation of portfolio recurring transactions (decides the stored-but-inert finding's real severity).

**Wave 2b remaining residue:** `SettingsPreloadContext`/`ThemeContext` hydration read only for default parity, not fully audited · Belgian tax-profile settings blobs (`BelgianTaxProfileContext` keys) remain unvalidated-by-design and unaudited · `lib/fileSniff.js` internals (magic-byte tables) not read · `cleanupOldBackups`, backup passphrase storage, and `withPgPassEnvFile` env-file lifecycle not read.

**Wave 2c remaining residue:** the out-of-band contract-phase drop referenced by migration 0055 (a manual `bank_account`-drop script, if one exists outside `alembic/versions/`) was not searched for or reviewed.

### ⚡ Performance

**Performance research 2026-07-09 (fresh-ground waves — in progress)**

**Wave F1 residue (migration-at-upgrade boot cost):** real wall-clock durations unconfirmed — 500k-row `transactions` / multi-GB `asset_price_history` are hypotheses; needs a populated DB + timings to confirm which migrations actually breach the 120s/60s thresholds (the O(table)-with-no-cap structure is confirmed either way) · whether the manual shell updater (`setupManualShellUpdater`, `packaging/electron/main.js:3337`) could flip `composeDidBuild`/`building` to true on its compose invocation was not fully read (all `composeStartOrUp` paths confirmed `built:false` in packaged mode) · exact cumulative cost of a specific version jump (e.g. 0043→0064) not derivable statically.

**Wave F2 residue (backend residues):** export running-balance CPU at extreme scale unbenchmarked (per-row Decimal work yields at socket-write awaits, but a fast client may make those resolve near-synchronously — needs a multi-hundred-k-row `include_balance=true` load test) · `agg_split_outstanding` write-side triggers (`trg_split_outstanding_sync`/`trg_split_payment_outstanding_sync`) not audited — analogous to the filed `agg_recipient_totals` trigger finding but unverified · whether the dbEditor per-page COUNT actually approaches the 15s timeout on a real `transactions` table unconfirmed (no live EXPLAIN).

**Wave F3 residue (frontend residues):** only the vibrancy double-blur finding needs empirical confirmation (macOS device, enhanced tier, GPU frame capture) — everything else in the F3 scope was settled statically.

**Wave F4 residue (fresh-ground sweep):** `snapshotBuilder.computeAndStoreSnapshots` full-rebuild persist path (DELETE-all + reinsert-all per scheduled run, `snapshotBuilder.js:659-679`) not separately quantified — same O(days×investments) walk as the already-filed per-request replay finding, but off the request path · no live measurement this pass (the FIFO/LIFO constant-factor estimate is reasoned, not profiled).

**Pass complete (2026-07-09/10, Waves F1-F4 all run).** The static fresh-ground space is now essentially exhausted after 8 passes — the remaining perf work is (a) implementing the filed findings, (b) the live-measurement residues (real .app boot trace, SPA-phase timings, RAM cost of keep-alive options, macOS vibrancy capture, populated-DB migration timings), and (c) re-checking the demo-scale "fine at this size" verdicts against a real multi-year install.

**Codebase audit 2026-06-30**

**Open gap:** the React Query per-hook configuration audit (staleTime/gcTime overrides on individual hooks, duplicate/overlapping queries across components, mutation-invalidation scope) did not complete in either pass. The verified global default (`App.tsx:93-102`: `staleTime: 30s`, `gcTime: 5min`, `refetchOnWindowFocus: false`, `retry: 1`) is sensible — per-hook overrides are unverified and should be checked separately. *(Closed 2026-07-02 — see the "Performance Research — 2026-07-02" section below.)*

**UI/GPU research 2026-07-02**

**Wave A remaining residue:** ~~Electron `vibrancy` tier interaction with glass surfaces~~ — **closed 2026-07-09** (Performance research Wave F3): the interaction is a static double-blur stacking finding, filed in §⚡ Performance ("Enhanced-tier macOS vibrancy stacks the OS under-window blur…"); only empirical device confirmation remains.

### 🎨 UI/UX & Design

**Design authenticity 2026-07-03 / UI/UX research 2026-07-03**

**Eyes-on Demo-app pass still needed** (grep/read alone can't judge these): light-vs-dark *designed-first* parity (grep can't judge washed-out light glass; the token structure suggests dark-first tuning of `--glass-*` alphas) · per-theme-variant visual QA (Dracula/Nord chart-token contrast against glass) · Fraunces' optical size at 14px · rendered decimal alignment in tables and RollingNumber reel alignment against Money's parts · the stat-tile dialect visual clash and EntryCard grid feel · motion *feel*: the double-entrance mush (PageTransition + `.animate-in` stacking), the menu-vs-dialog physics mismatch, sonner toast enter/exit/swipe physics beyond the icon bounce, ChartTooltip follow/cursor physics, and sheet slide-from-side character · splash→app handoff (no `backgroundColor` on the BrowserWindow — potential flash before the splash data-URL paints on cold boot) and first-run dashboard-behind-wizard feel.

**Live-device verification still needed** (the user skipped the Playwright pass): mobile Sheet-sidebar focus behavior and per-dialog focus-landing (Radix default assumed, not verified per-dialog) · SR/focus reality checks — route-change + wizard focus stranding as actually experienced, Escape focus-return under `portalContainer` overrides, sonner Alt+T reachability inside the 4s toast window · DatePicker Shift+PageUp/PageDown year-jump behavior in the installed react-day-picker version, and whether SymbolSearchBox consumers add their own arrow-key handlers · on-screen keyboard vs fixed-centered dialogs (does it cover the focused field?), landscape-phone short-viewport behavior of `h-[82vh]`/`max-h` dialogs, and 125-150% browser-zoom sweep for text-container clipping (incl. the `leading-none` collision) · AddTransactionDialog actual clipping at 375×667 and landscape; long-name overflow rendering on RecipientsPage/WatchlistPage; ExportDialog's outline+sm primary button eyeball · chart-tooltip tap-away dismissal on touch · 375px sweeps of Onboarding/ImportReview/Owes/planned-payments surfaces, and dialog rounded-corner/edge-flush cosmetics at exactly 375px · real autofill behavior on unlabeled search inputs.

**Remaining static gaps**: none — the last one (~~full nl.json read-through~~) closed 2026-07-10 by Wave R3 (all 22 remaining namespaces read in full, incl. tax ×437 keys). Previously **closed 2026-07-10** (UI/UX review 2026-07-10, findings + checked-clean filed): ~~raw network-error copy sweep~~ + ~~MarkAsFiledDialog / bulk-dialog field-level audit~~ (Wave R1) · ~~Electron icon/dock/menubar color language~~ + ~~native font surfaces (menus, about panel)~~ + ~~native menu strings vs in-app language~~ + ~~TableDataEditorPage composition audit~~ (Wave R2).

**UI/UX review 2026-07-10 — open residue:** BulkTagDialog fields not audited in depth (only its BulkActionsBar wiring reviewed) · backend not checked for whether bulk endpoints *could* return requested/skipped counts (frontend types only expose `{deleted}`/`{updated}`).

### 🏛️ Architecture & API

**Architecture & code design research 2026-07-06**

**Wave W1 unchecked residue (resume points):** (1) Frontend client coupling — API hooks in `apps/frontend/src` were not traced to see which of the shape drifts (list keys, DELETE bodies, casing) are already absorbed by per-endpoint client code vs. genuinely biting — would sharpen fix priorities. (2) `openapi.yaml` — not checked whether the spec documents the inconsistent shapes faithfully per-endpoint or papers over them with a generic schema (convention-level spec accuracy; field drift was excluded as covered). (3) Boundedness of remaining unpaginated lists — ai conversations, recipient clusters, and tags verified at the repository layer; splits `getOwedSummary`, `attachmentRepository.listByTransaction`, `savedChartsRepository.getAll` judged small by domain, not by reading their SQL. (4) Non-`routes/` HTTP surface — `/health` and endpoints defined directly in `main.js` (root, static, CSRF) not audited against these conventions. (5) Response field-level naming inside single objects (e.g. marketLookup camel fields vs research provider payloads for the same concepts) spot-checked only, not inventoried.

**Wave W2 unchecked residue (resume points):** (1) App-side value agreement for the remaining PG enums beyond `price_provider`/`recurrence_interval` — `asset_class`, `portfolio_txn_type`, and the four `account_*` enums vs frontend/backend literals (generated.ts suggests OpenAPI-derived agreement, unconfirmed at write sites). (2) `alembic/legacy_versions/` and `alembic/manual/` contents, plus `migrate.js` legacy-revision rewrite logic beyond the `0025_exchange_rate_cache` reference. (3) `docs/reference/database-triggers.md` and `schema-initialization.md` not cross-checked against the live trigger/function set (only data-model.md + materialized-views.md drift-checked, table level). (4) No live-DB `information_schema` diff — a live install predating 0001 could carry extra legacy objects static review can't see. (5) Full inheritance-branching surface not quantified beyond 3 `to_regclass` probes + an 11-file grep hit list (per-file read of the portfolio repo family would give an exact LOC-of-debt figure). (6) Boolean naming drift (accounts' bare `spendable`/`in_net_worth` vs dominant `is_*`) inventoried but not filed — cosmetic, revisit only if a rename window opens.

**Wave W3 unchecked residue (resume points):** (1) The **portfolio/brokerage import adapter seam** (services/portfolioImportPipeline/ + brokerageFanout/brokerageRouting, ADR-095) — routing confirmed kind-based not adapter-name-based, but how a new *brokerage* adapter registers and its frontend touchpoints were not traced. (2) The **forecast-method registry** (services/calculations/forecast/methods/ — ensemble/prophetLite) as a possible additional plugin surface. (3) Whether **openapi.yaml covers** the adapter catalog (`/api/info/supported-parsers`) and report endpoints' section-ID enums (only the PriceProvider enum at openapi.yaml:835 verified). (4) Report **theming/`themeCss.js` + `sectionHelpers.SECTION_CSS`** conventions — whether a new section needs CSS registration or inherits. (5) The saved **custom-parser (generic adapter config)** UX as an alternate no-code extension path — noted at stage.js:42-46, not traced through the frontend. (6) `docs/features/ai-chat.md` 30-tool inventory not verified line-by-line against tools/index.js (counts matched at domain level only).

**Wave W4 unchecked residue (resume points):** (1) Neither coverage suite was run for current measured numbers — the backend "reached-files-only" gate means the printed 85/88 may sit far above true codebase coverage; worth one `test:coverage` run each side. (2) The 19 MSW Zod schemas not field-by-field verified against `openapi.yaml` (duplication question answered structurally only). (3) `stryker.config.json` scope/mutation-score config unaudited (frontend has it; backend does not — mutation-testing-in-no-workflow already known/deliberate). (4) AI-chat test cluster unread (`aiChatTools/aiChatService/ollamaClient`, ~2,300 lines — likely heavy fetch mocking). (5) Golden-fixture freshness not assessed against `INVENTORY.md` claims (fixture counts unverified). (6) `apps/frontend/src/test/property/` depth and the `tests/golden/__fixtures__/aggregations` shadow-middleware path unexamined. (7) No endpoint-matrix × test cross-reference — which of the 164 API operations have neither a route test nor a contract schema would quantify the route-coverage gap precisely.

**Wave W5 unchecked residue (resume points):** (1) `tsc -p tsconfig.check.json` with `noImplicitAny:true` was not run — that one command would size the ratchet effort for the checkJs finding. (2) The 167 backend `new Date()` sites were counted, not classified — spot-check `services/calculations/*` for compliance with timezone.js's "no raw new Date() in calc modules" rule. (3) `importPipeline/match.js` crash-mid-match recovery (batch stuck in `'matching'` status — janitor/resume path?) not traced. (4) Electron *renderer*-side logging (preload console forwarding, webContents crash-path logging, demo/dev build differences) not examined. (5) Whether `VISION_CACHE_DIR`/`VISION_BOOT_TRACE`/`PUPPETEER_EXECUTABLE_PATH` are all listed in `docs/reference/environment-variables.md` (only ALEMBIC_BIN confirmed, line 44). (6) Frontend request-correlation end-to-end (does the FE send an X-Request-Id it also logs, closing the loop with the backend's SAFE_REQUEST_ID reuse path) not traced beyond ApiClientError carrying the id.

**Wave W6 unchecked residue (resume points):** (1) main.js was mapped structurally (function-boundary grep + targeted reads), not read line-by-line — the updater internals (1571–1999, esp. the shell-installer script writer 1629–1700), backup crypto bodies (578–981), `launch()` tail (3195–3429) and quit lifecycle (3430–3514) have had no design-lens read. (2) The 29 AI tools were sampled (expenses.js head fully, others signatures/renderAs sites only) — per-tool data-shaping consistency (field naming across `data` rows, `meta` key vocabulary beyond renderAs) unassessed. (3) Frontend ai-chat component design (`ChatMessageList`, `ToolResultCard` rendering of the renderAs contract, `ChatComposer`) not reviewed. (4) `docs/features/ai-chat.md`, ADR-024, ADR-048 located but not cross-checked against the current implementation for doc drift. (5) `error.html` + the recovery surface, and `backup/bundle.js` internals (only header read), unexamined. (6) `lib/sse.js` (`createSseWriter`) internals not reviewed (backpressure behavior documented in docs/api/ai.md but unverified against code).

**Code/architecture 2026-07-03**

**Wave A1 residual:** `controllers/`, `database/`, `integrations/`, `jobs/`, `startup/` internals not re-read after the Wave A1 follow-up (jobs/startup covered only at seam level).

**Wave A2 residual:** the dead-export scan (services/repositories/lib/utils) is a word-boundary heuristic, not re-verified repo-wide incl. packaging/scripts — misses dynamic/string-keyed access, and the ~70 test-only exports were bucketed rather than individually judged for whether the test should target the public surface instead; `coerceNumericFields` per-repo coverage (a June 2026 pass claims it's done) was not re-verified this pass.

**Wave A3 residual:** the 146 component-level `useQuery` call sites (counted, not individually reviewed) are still unreviewed; the lib/ dead-file sweep (0 of 64 dead) did not extend to `features/`, `stores/`, or `hooks/`.

**Wave A4 residual:** tax dialogs were skimmed, not line-read; `pages/research/MarketOverviewPage.tsx` (1111 lines) and `TableDataEditorPage.tsx` (544) remain unread for cohesion/duplication.

**Wave A5 residual:** duplicate-type detection across the frontend was manual on suspicious pairs only — no structural diff across all ~180 exported FE interfaces, and `features/` type homes were not diffed against `types/`; `generated.ts` field-fidelity was audited only for the splits/watchlist/aiChat/attachment schemas, not the full OpenAPI spec (static reads only, no runtime response captures); madge's cycle-detection may still under-detect cycles introduced via dynamic `import()` (unconfirmed).

### 🏗️ DevOps / CI-CD / Packaging

**DevOps research 2026-07-03**

**Wave D1 remaining residue:** one supervised e2e workflow dispatch run remains open — needed to confirm the a11y gate (`a11y.spec.ts`, never yet executed, fails on any critical/serious axe violation across 9 pages), real job runtime vs. the 30-minute budget, and empty-DB safety of all 36 tests. Also open: whether the `code_scanning` ruleset rule should hard-require a fresh Trivy analysis per PR (a GitHub-side settings question, not repo-side — empirically it does not block merges today, per the PR #73 evidence in the Findings above).

**Wave D2 remaining residue:** in-container empirical PID-1/SIGTERM drain verification remains open (needs running the image; the static verdict — bun is PID 1 via `exec bun run <file>`, so signals reach `main.js`'s drain handlers — is already clean).

**Wave D3 remaining residue:** `installPreparedShellUpdate()`/`checkForShellUpdate()` internals (`packaging/electron/main.js` ~1620-1910) were only skimmed, not read for correctness; `packaging/electron/demo-db/02-onboarding.sql` was not read (its driver `regenerate.sh` was already checked clean).

**Wave D4 remaining residue:** apple/container `cp` mtime preservation needs a live sandbox test (filed as a Finding above with the load-bearing risk it creates); whether the staged `claude.json`'s full `.projects` map is intentional is a user call (also filed above).

**Codebase audit 2026-06-30**

- [x] Backend code-design: route→service boundary full sweep beyond the ADR-067 spot-check above, dead-shim sweep, empty-catch-block check 🔽 — **closed 2026-07-03**, see "Code Design & Architecture Research — 2026-07-03" Wave A1 (boundary loophole + reverse-layering findings; empty-catch check came back clean)
- [x] Backend performance: full systematic pass over `services/reports/sections/*` and the complete `aggregations.js` index cross-check (spot-checked only, lower-confidence-clean) 🔽 — **closed 2026-07-02**, see "Performance Research — 2026-07-02" below
- [x] Frontend performance: React Query per-hook config audit (staleTime/gcTime overrides, duplicate queries, invalidation scope per individual hook — see gap note above) 🔽 — **closed 2026-07-02**, see "Performance Research — 2026-07-02" below

## Checked clean — do NOT re-audit

Already verified sound in the passes below.

### 🐛 Correctness

**Correctness research 2026-07-02**

**Wave 1a checked clean (don't re-audit):** `parseDayMonthYear` + `parseDateFlexibleUtc` (round-trip validated, UTC-midnight, no TZ shift; SABB guards the DD/MM trap explicitly) · amount-parsing core (`parseDecimalSafe`/`parseCommaDecimal`/`parseAmountField` — Decimal throughout, EU/US formats, parentheses; lone `1.234`/`1,234` ambiguity is a documented fixed choice) · BOM/CRLF handling · IBAN propagation in Belfius/KBC/ING/BNP (KBC collapse class fixed in all IBAN adapters; SABB has no account column) · sign/direction in all adapters (Wise Direction handling correct) · stage/commit date paths · hash dedup + SAVEPOINT race-safety at commit · skipped-row counters surfaced · generic adapter fail-fast on bad date_format · match-phase recipient upsert · `transactionExport.js` keyset pagination + `toYmd` cursor + Decimal running balance + backpressure (2026-07-03) · `stage.js` `parsedDateToYmd` use — adapter-UTC Dates, safe side of the TZ boundary (2026-07-03) · `rawTransactionRepository`'s ON-CONFLICT dedup pattern is internally sound, just dead (2026-07-03, see the dead-code Finding).

**Wave 1b checked clean (don't re-audit):** repo choke-point numeric guards (zero/negative units/price/amount, `|units×price − amount| ≤ 0.01` cross-check, `fx_rate_to_eur ≤ 0` rejected) · FX stamping at commit (row rate wins; on-or-before rate for correct currency at row date) · ADR-095 double-count guard in the staged path · `computeTradeCashLegAmount` signs match ADR-090 exactly, Decimal-based · type normalization (unknown types error, no silent default) · dedup hash includes route+type · snapshot date boundaries (todayAppDateString both sides; txn-date FX for invested, valuation-day FX for value; Decimal accumulators; latest day reconciles with live summary; `'unassigned'` covers NULL-account lots) · snapshot persistence (DELETE+INSERT in one txn) · orchestrator failure path marks batch `failed` · `commitBrokerageFanout` confirmed no production callers · (2026-07-03) `accountBalanceSql.js` anchor+delta logic itself (sound for single-currency accounts; only FX-blind, see the FX-on-sleeve Finding) · `portfolioTxRepo.reads.js` NUMERIC coercion (6 tx fields + summary fields + counts) · `getById` round-trip via `createThroughInheritanceTables` (create returns through `getByIdFn` → identical mapped shape; duplicate-id sequence resync sound) · `getAllWithCount`/`getAllByInvestmentIds` SQL (aliasing, ranked-CTE limits) · `buildInvestmentSummaryCore` unit-based RoC/split handling (applied in all three cost-basis methods — non-unit RoC is a separate filed Finding) · `allocationAnalytics.js` (pure weight math, no snapshot/RoC involvement) · `sanitizeIsolatedValueSpikes` bridge guard (sustained repricings kept; no chain-smoothing of 2-day plateaus — distinct from the buggy `sanitizeSnapshotSpikes`, see the Finding) · test suites RUN: `brokerageFanout`/`portfolioImportCommit`/`tradeCashLegService`/`accountSnapshotParity`, 4 files, 36/36 pass (see the test-quality-gaps Finding for what they miss) · `computeTradeCashLegAmount` unit tests (real math, ADR-090 signs) · plan-side fanout tests (importActual, non-over-mocked) · ING/BNP factory tests (exact field values).

**Wave 1c checked clean (don't re-audit):** import-pipeline dates (`wise.js`/`revolut.js`/`_shared.js`/`importDates.js`/`commit.js`; `deduplication.js:13,44` `toISOString` is safe on adapter-produced UTC-midnight Dates) · `loanSchedule.js` (fully `Date.UTC`) · `snapshotBuilder.js:324` (consistent UTC roundtrip) · `aiChat/tools/_validate.js:30` · provider-timestamp→ymd WRITE paths (`rateFetcher.js:200`, `quotaGovernor.js`, `finnhubAdapter.js`, forecast toIso — light check; `priceCache.js`'s READ path has a confirmed bug instead, see the Finding — corrected 2026-07-03, do not treat `priceCache.js` as clean) · benign ISO timestamps (backend main/logger/admin/warmup, filename stamps, frontend timestamp-only hits) · backend `parseFloat`-on-NUMERIC sites (`sankey.js`, `normalization.js:112`, `rateFetcher.js:62`, `priceProviderRegistry.js:365`, `belgianInflationService.parseNumeric`) — per-site coercion before arithmetic, not the canonical helper but no correctness bug · `infoRepositoryPlanned.js:40-47` month-window construction · (2026-07-03) frontend date core: `shared/dateUtils.ts` (`parseISO` ymd→local branch, `toYmd`, `differenceInDays` UTC-normalized, `formatDateStringWithAppSettings`'s own T-split logic) · `lib/timezone.ts` (`todayLocal`/`todayYmd`/`daysBetween`) · `chartPeriods.ts` `filterByPeriod` · `CategoryPivotTable` month range · `useUpcomingPlannedPayments` window · `LinkTransactionDialog.tsx:52-54` −14d window math · `PlannedPaymentsPage` badge day-math itself (only its input is poisoned by the raw-pg-Date passthrough) · local `new Date(y,m-1,1)` ctor family (`MonthlyTrendsChart`, `NetSummaryCard`, `TaxOverviewPage`, `PerformanceBreakdown`, `SankeyTab`, `TransactionSearchSuggestions`, `IncomeStep`) · statistics `parseISO` month-key family · `PerformancePage` `parseISO(d.day)` on snapshot ymds · epoch-ms chart `time` fields · NO hand-rolled month arithmetic in frontend src · `toYmd(new Date())` ≡ `todayYmd()` bypasses (style only) · shared-utils `daysBetweenYmd`/`calculateAccruedInterest` (timestamp-tolerant) · numeric sweep clean end-to-end (backend coerces at every route seam checked; frontend defensively `Number()`s at consumption; no string-concat-instead-of-add or `toFixed`-on-string site found; `api/types.ts:46` `amount: string` is stale doc drift, harmless) · backend date-conversion call sites verified clean: `portfolioImportBatchRepository.js:63`, `importPipeline/commit.js:26,84-86`, `portfolioImportPipeline/commit.js:36`, `quoteBackfillService.js:204,286`, `reports/dataFetcherTax.js:102-104`, `infoRepositoryNetWorth.js:67,101`, `snapshotBuilder.js:98,559`, `utils/portfolioMath.js:97-104` · raw-bank tables + `recipient_aggregations.last_transaction_date` never reach any route · `watchlist` has no DATE column · aiChat `expenses.js` `toYmd` usage (local-getter fix already in) + `insights.js:38-41` bank-balance first/last dates · `middleware/envelope.js:20-36` `res.ok` confirmed pure pass-through (the fix point is per-field ymd conversion, not the envelope).

**Wave 2a checked clean (don't re-audit):** NO semantic inversions in nl — all 218 financial-term keys (income/expense, buy/sell, gain/loss, deposit/withdraw, owed, realized/unrealized) reviewed side-by-side, directions correct · all dynamic-key families enumerated and present (portfolio.assetClass 7/7, txnType 9/9, accounts.*, research.scorecard/metric, tax.history.kind 6/6, tax.profile.*, cashflow.window, performance.*, export.*, rebalance.* incl. unknown-sleeve fallback) · all 6 `tc()` plural families correct in both languages (nl/en share CLDR one/other, no category gap possible) · no English-literal `toast.*()` calls · no hardcoded `Intl.*Format('en-US')` locales · `AddPortfolioTxnDialog` amount/units/price validation (≤0/NaN/Infinity rejected, buy/sell 2-of-3 consistency, gift-zero intentional) · single-brace interpolation matches runtime (`LanguageContext.tsx:104-108`) · backend `recipient_id` positive-int validation · (2026-07-03) **splits: best-validated surface end-to-end** — cap-only invariant (`sum(new)+sum(existing) ≤ |txn.amount|`, partial splitting by design), zero/negative/over-allocation blocked both sides, client math is shared-Decimal round-to-cents before the cap compare, server re-sums under `SELECT … FOR UPDATE` (race-proof), payments overpayment-capped · **portfolio edit path does NOT bypass create guards** — PATCH merges then re-normalizes (2-of-3 on partial patches, sell-units re-check, `type`/`asset_class` immutable, gift forces fees/taxes 0 matching backend) · **money wire precision fine** — portfolio dialogs send pre-rounded JSON numbers (4/8/6 dp, no parseFloat loss), no client-side FX conversion in any submit path, `packages/shared-utils/src/money.js` Decimal HALF_EVEN single-source for both apps · **recurrence month-end math correct** (`recurrence.js:34-52` clamps monthly/yearly correctly; pattern whitelist enforced POST+PATCH; loan config server-derived, term 1-600 both sides) · **date fields otherwise clean** — empty-date submit blocked in all portfolio/planned forms, past planned dates deliberately allowed, DatePicker is calendar-popover only (no typed-entry invalid-date vector) · **AddAccountDialog otherwise solid** — name required+trimmed both sides, enums match exactly, balance non-editability intact, duplicate name → clean 409 · **TaxProfileDialog mechanics** — NaN/Infinity can never persist, dependent counts Select-bound + double-clamped, `POST /api/reports/tax` Zod contract matches frontend · **watchlist POST is reference-quality** — required trio, asset-class enum matches frontend union, currency regex, numeric coercion prevents string-price 500s · **portfolio CSV import otherwise** — required-mapping rules agree client/server exactly, asset-class/type/separator/account_id server-validated, negative-cell magnitude+direction intentional and documented · **transactions API otherwise** — tags array-type both POST/PATCH + 50-slug cap, recipient/category name-resolution 400s, read-only field stripping · **varchar widths otherwise safe** across investments/accounts/categories/recipients/transactions/planned/portfolio-tx/tags/settings · **nl mechanical screens (file-wide)**: 3,529/3,529 key parity, 0 missing/extra, 0 placeholder-token mismatches; namespaces eyeballed key-by-key (~1,050 keys) with no meaning inversions found: transactions/txPage/addTxn/txnEdit, dashboard, settings (all 236), onboarding, importPage/import/importReview/importHistory, planned/plannedPage/plannedForm/recurring/upcoming, accounts.

**Backup coverage: verified in sync (not a finding)** — the agent RAN `tests/backup-coverage.test.js`: 6/6 pass; the test derives the table set from all Alembic migrations, so accounts-epic tables, `portfolio_import_*`, `db_editor_audit`, `watchlist` are covered. Only staleness: `backup/coverage.js:23` header says "Last verified against: 0035" — update the comment.

**Wave 2b checked clean (don't re-audit):** transfer date-window inclusivity consistent (SQL BETWEEN vs JS ±3d) · same-account pairing excluded on both paths; `findTransferMatches`' bank_account comparison is test-only (no production callers) · sign handling consistent (zero-amount rows counted as income everywhere, deliberately) · hard-delete of one leg correctly releases the survivor via FK-NULL + `releaseOrphans` · edit-invalidation symmetric for reciprocal auto pairs · `resolveTransferMatches` mutual-unambiguity correct (contended matches demote to suggestions) · live-path month boundaries half-open (no double count) · MV transaction_count halving exact · MV fast-path gating on `includeTransfers`/currency homogeneity/exclusions consistent with live paths · `mvAvailable` allowlist + negative-TTL recovery · attachment download filename sanitization + 404s · attachment upload content-sniffing before store · (2026-07-03) **settings**: single + bulk PUT share `validateSettingValue` (bulk can't bypass); rebalance-plans validator solid (id/name/weights/cashCap, ≥1 positive weight, 50-plan cap); theme validator null-safe with HH:MM regex; `setMany` parameterized UNNEST upsert; DELETE-any-key safe (defaults kick in); `transferReconciliationService.js:250` writes proper jsonb boolean for its sentinel; db-editor writes to `user_settings` parameterized, xmin-guarded, audited · **electron restore (main.js side)**: plain pg_dump format self-handles FK ordering + sequence `setval`s; legacy investments-VIEW installs dump/restore fine; dbName/dbUser from own `.env`; connection termination → drop → recreate ordering correct; attachments staging + atomic swap awaited · **attachmentService**: `randomUUID()` filenames; `resolveAbsolutePath` double guard (string-prefix + realpath symlink resolution) blocks absolute paths, `..`, and symlink escapes; multer caps count/size correctly; client-MIME prefilter backstopped by magic-byte sniff · **`infoRepo.forecast.js`**: interval interpolations integer-range-validated (no injection); cumulative day-walk correct across month lengths; planned vs actual series kept separate · **`infoRepositoryNetWorth.js`**: forward-fill of missing snapshot days correct; ADR-092 liability split consistent; NUMERIC coercion throughout; historical-FX conversion batched with fallback.

**Wave 2c checked clean (don't re-audit):** ADR-026 envelope unwrapping correct in both `httpGet` consumers · the memory-noted crash-recovery port-walk bug is FIXED · health-poll vs window-load race handled (splash → matview-gated `pollReady` → watchdog) · quit ordering (backup before `compose stop`, SIGTERM graceful) · IPC path-traversal guards on restore/zip-extract/update-ZIP + sender checks on restore/badge/accent/splash · update download (mandatory checksum, SHA256, cleanup, timeout) · single-instance lock + macOS activate · contextIsolation/sandbox/preload posture · compose volume parity root↔resources · backup crypto streams (v1/v2, GCM tag, keys zeroed) · migration 0061 (side-table design safe on legacy investments-VIEW installs, re-run-safe, documented no-FK) · 0062 otherwise (NULL-safe `IS DISTINCT FROM`, BEFORE UPDATE row trigger, split-guard tolerance + ERRCODE, downgrade is a true reverse restoring the 0056 function verbatim) · (2026-07-03) **migrations 0044-0064 downgrade-fidelity sweep, otherwise clean:** 0044 additive/re-run-safe; 0045 upgrade-side trigger swap correct (only its downgrade has the filed drift); 0046 EUR-backfill-before-tighten ordering correct, and 0046-vs-0049 confirmed YES the NOT VALID CHECKs are VALIDATEd in 0049 after a normalization pass (only the boot-blocking case above); 0047 collision handling correct (demotes all-but-MIN(id) before the partial-unique build, null-safe); 0048 dynamic FK-name lookup covers all three RESTRICT category FKs correctly; 0050 backfill dedup/currency-pick logic otherwise correct (only the planned_transactions gap above); 0051 + 0062→0051 downgrade interplay verified correct (no stale-function or leftover-trigger window in the chain); 0054/0057/0058/0059/0060/0063/0064 additive nullable columns or new tables with symmetric downgrades; 0055/0056 correctly neutralized/idempotent; 0063/0064 `server_default` vs app default confirmed NO drift · `/health/detailed` contract vs `pingReady` holds (semantics match by design) · `packaging/electron/assets/error.{html,css,js}` CSP-safe, no XSS, localized correctly · electron-builder demo-vs-main config drift is all intended isolation (only the demo-update-gating finding above is real).

### ⚡ Performance

**Performance research 2026-07-09 · Wave F1 (migration-at-upgrade boot cost) checked clean (don't re-audit):**
Additive constant-default columns are metadata-only on PG18, no rewrite (`0044:39` `is_transfer BOOLEAN NOT NULL DEFAULT false`, `0050:116` nullable `account_id`, `0053:45` `portfolio_transaction_id`, `0036:36` `tx_hash`) · 0051 dual-write trigger creates triggers only, no backfill/scan (`0051:76-88`; comment at `:20` confirms account_id stays NULL) · 0047 touches only small `recipient_bank_accounts` (bounded UPDATE + partial index, `0047:33-54`) · alembic has NO `statement_timeout`/`lock_timeout` (env.py NullPool, alembic.ini no connect args, DATABASE_URL no `options`) — the app pool's 30s timeout (`connection.js:27`) cannot reach the separate alembic process; the migrate.js 120s execFile cap is the sole limiter (that cap is the filed 🔺 finding) · `alembic/manual/contract_drop_bank_account/` is out-of-band — runner only does `alembic upgrade head`, and 0055 is a neutralized `pass` no-op (`0055:30-32`) · skip-at-head cache short-circuits everything when at head and versions/ unchanged (`migrate.js:45-59,205-208`) — all filed costs are cache-miss/first-boot-after-update only · DROP INDEX migrations (0033, 0034) and MV drops are metadata-only.

**Performance research 2026-07-09 · Wave F2 (backend residues) checked clean (don't re-audit):**
`transactionExport.js` streaming core solid — keyset cursor (`buildExportChunkSql:68-94`), `EXPORT_CHUNK_SIZE=1000`, per-row backpressure await (`:171` / `writeWithBackpressure:55-60`), one-time `LIMIT 1` probe (`:42-44,147`), filters built once, tags/category/recipient resolved in-SQL (only the per-row correlated tag subquery is filed), `res.end()` on mid-stream error · `savedChartsRepository.getAll` single query, scalar columns + small int arrays, one call per `GET /savedCharts` (`savedChartsRepository.js:18-21`, `routes/savedCharts.js:81-84`) · `attachmentRepository.listByTransaction` single indexed query (`idx_attachments_transaction_id`, 0004), on-demand per transaction, no list N+1 (`attachmentRepository.js:27-35`, `routes/attachments.js:91-95`) · `getOwedSummary` single set-based query over trigger-maintained `agg_split_outstanding` with its indexes, called exactly once per `GET /owed` (`splitRepository.js:197-217`, `routes/splits.js:57-60`); `/batch` audit writes `Promise.all`-parallel · `investmentController.js` response caches with TTL (`:46-50,184,317`), `processInBatches` cap 10, fire-and-forget quote refresh off the request path (beyond the already-filed `refreshPrices` loop) · `jobs/refreshCashflowForecastMc.js` 24h cadence, `forEachConcurrent` cap 3, ~1 active user self-hosted · `startup/warmup.js` intervals `withInFlightGuard`-wrapped (:55-69), online-probe gated, Kinesis deferred off boot (:153-162) · `integrations/ollama/client.js` timeouts on request/health/stream, per-chunk idle-timeout re-arm (:358), `await onToken` backpressure (:334), lazy singleton (:416-419).

**Performance research 2026-07-09 · Wave F3 (frontend residues) checked clean (don't re-audit):**
Search debounce cadence fine — shared `SEARCH_DEBOUNCE_MS = 300` (`useDebounce.ts:8`), single trailing timer cleared per keystroke + on unmount (`VirtualDataTable.tsx:169-173,192`); the problems are the missing abort/min-length (filed), not the cadence · `TransactionSearchSuggestions.tsx:42-205` fires ZERO network requests — pure local quick-filter UI, no per-keystroke request storm · `useUpcomingPlannedPayments` dismissed-keys snapshot stable — module-level cached `Set`, rebuilt only in `dismissOccurrences` (`:70-83`), localStorage read once lazily, `useSyncExternalStore` gets a referentially stable snapshot (`:33,58-61,91`) · `PlannedPaymentForm` keystroke light — local `useState` fields, no schedule/amortization preview, `parseDecimal` only in `handleSubmit` (`:87,95-97`), comboboxes render only trigger buttons while closed (`:176,188`) · NO markdown parser in the chat stream — `ChatBubble.tsx:37` renders plain text via `whitespace-pre-wrap`, no react-markdown/remark/marked in the feature (the classic quadratic re-parse-per-token cost is absent) · no `JSON.parse` of tool payloads per render (`ToolResultCard.tsx:94` operates on already-parsed `result.data` inside `useMemo`) · conversation switching per-id cached, no full refetch/remount (`useAIChat.ts:25-26`) · `lib/devtools/` correctly excluded from prod — `DevtoolsRoot` lazy + env/adminMode-gated (`App.tsx:73-91`); `queryMetrics.ts:92`/`apiRequestLog.ts:30` subscriptions execute only when that chunk loads; only 32-line `apiEventBus.ts` ships statically and its emits short-circuit at `listeners.size === 0` (`apiEventBus.ts:27`).

**Performance research 2026-07-09 · Wave F4 (adversarial fresh-ground sweep) checked clean (don't re-audit):**
**Dockerfile/update-pull path well-designed** — multi-stage (`Dockerfile:4/:56`), `bun install --frozen-lockfile --production` (`:103`, no devDeps), both Puppeteer browser downloads skipped (`:35,:101-102`; only Alpine `chromium` apk `:72`), layer ordering pull-delta-optimal (heavy immutable apk/pip/bun layers precede the small app-code/dist/alembic COPYs `:110-115`), `.dockerignore` excludes node_modules/dist/tests/.git · **middleware chain clean for static requests** — csrfGuard + rate limiters mount on `/api` only (`main.js:308,316-331`), `requestId` = pooled `randomUUID`, `express.json` no-ops on non-JSON, constant CSP setHeader; 1y-immutable caching means the gzip wrapper re-compresses each hashed asset at most once per cold load — no precompression gap at single-user scale · **crossWorkspaceAnalytics** pure bounded math (`:17-112`); `crossWorkspaceDataService.assembleRebalanceInputs` one summary + one accounts query + per-account convert loop (tens), on-demand only (`:40-82`) · **recipientClusterService** prefix-bucketed LCP with `MAX_CLUSTERS=50` cap (`recipientClusterService.js:18,36-84`); `applyPatterns` O(distinctRaw·patterns) on the import path with the verified 512-LRU (`recipientPatternService.js:164-190`) · **cleanupStaleQuotes** one batched DELETE with unnest windows (`quoteBackfillService.js:637-687`); backfill loops `forEachConcurrent` cap 4, bounded by investment count, off request path · **recurrence/planned matching bounded** — detection 3-year-bounded per-recipient-linear (already-filed as uncached); `plannedMatchService` O(txs·activePlanned) with both sides small/date-bounded · **Electron IPC runtime chatter clean** — all renderer→main calls are invoke or mount-once subscriptions (`preload.js:124-186`); `setDockBadge` only on badge-count change (`UpcomingPaymentsNotification.tsx:20-24`); splash-theme/accent persist only on theme/OS-accent events; nothing crosses IPC per-scroll/per-keystroke · **shared-utils otherwise clean** (`money.js`/`slugify.js` trivial, LTTB O(n)) · **RecipientInsightsPage** fully server-aggregated, paged, top-10 sliced — no client O(n²).

**Startup/Electron performance research 2026-07-05 · Wave S1 (live instrumented boot, demo app) measured-fine (don't re-measure at this scale):**
First-ever live boot measurement (Vision Demo app, 3 warm + 2 hot runs, epochs aligned across Electron trace / HTTP poller / `docker logs --timestamps` to within 27ms). Boot trace is **always-on** (opt-out `VISION_BOOT_TRACE=0`), Electron→stderr `[startup] {json}`, backend→visible in `docker logs` — no env var needed, just capture stdout by launching the .app binary from a terminal. Measured fine: **backend in-container boot 92ms total** (db_poll 19–30 · alembic skip-cache hit 8–31 · MV create-if-not-exists 9–15 · MV indexes 4–5 · listen 10–11) — nothing to optimize; alembic skip cache + deferred MV refresh verified working live · **MV refresh post-listen 31ms / gate cost 33–38ms** (re-priced the P4 finding — keep the gate) · **compose all-running hot-boot fast path 73–79ms**, no container mutation · **compose all-stopped → `compose start`** fast path taken on every warm run (events show Starting/Started only, no create/build) · **health-poll quantization ≤100ms** warm, 15–16ms hot · **`check_docker` socket ping steady-state 15–21ms** (2.2s only on the daemon-wake path, filed) · **Postgres data-volume start ~100ms to accepting connections** — the db itself is not a cost · **splash loadURL precedes all Docker I/O** — confirmed live in trace ordering. Headline numbers: demo warm boot spawn→loadURL 6.8s (5.9s = demo-only compose healthcheck idle, filed ⏫), hot boot 0.6–1.1s, spawn→splash-visible 337–653ms. *Not measured (residue): the REAL Vision.app against real data (its parallel-start compose dodges the demo's 5s, projected ~2–2.5s warm — trace is always-on, just needs stdout capture) · cold boot with image pull / first-ever run (needs volume wipe — forbidden on demo) · SPA-side phases after loadURL (needs a devtools/Playwright pass) · the Docker-not-running dialog path (needs daemon shutdown, disruptive).*

**Startup/Electron performance research 2026-07-05 · Wave S2 (main-process cold-start static sweep) checked clean (don't re-audit):**
**Overall verdict: the Electron main process is tight** — outside the filed archiver-at-eval item there is no heavyweight machinery in the spawn→loadURL path. Specifics: **no auto-updater at boot** (electron-updater not a dep; `Resources/app-update.yml` is inert electron-builder output; updates are custom IPC `update:*` main.js:2394-2433, `setupManualShellUpdater()` called at :3337 *after* pollAndLoad and internally delayed 30s per :164,1979) · **Electron 42.2.0** (current — no framework-init win from upgrading) · **packaging config clean**: asar enabled, `files` globs tight (`main.js`, `preload.js`, `backup/**`, `assets/**` — package.json:58-63), zero native modules so no `asarUnpack` needed, i18n + compose templates correctly in `extraResources` outside the asar read async (main.js:22-48); demo config mirrors this · **module-eval top only Node builtins + electron** (~1ms) besides the filed bundle.js; rest of module scope = constants, `ipcMain.handle` registrations, dockerEnv IIFE (:501-508), keep-alive `http.Agent` (:979) — trivial · **pre-splash sync fs all sub-ms and justified** (`__IS_DEMO` existsSync :81, migrateLegacyUserData 1-2 existsSync :90-113, readSplashTheme/readSavedWindowBounds small-JSON readFileSync :1342,:1442); **no execSync/spawnSync anywhere in main.js** · **whenReady→createWindow**: `registerSecurityHeaders` handler-registration-only packaged-only (:193-209); initI18n async 6-11ms fine; `subscribeAccentColorChanges` (:3045) single cheap subscription (can move with the menu/dock batch) · **window options**: sandbox/contextIsolation posture correct (:1503-1509), `titleBarStyle: 'hiddenInset'` cheap, **show-immediately (no ready-to-show) is the RIGHT strategy** for perceived startup · **preload.js 188 lines**, requires only `electron`, pure contextBridge — nothing sync-heavy · **open-file handler** module-scope with whenReady deferral (:3076-3081) — correct macOS pattern · **splash handoff mechanics** (for S3): single BrowserWindow throughout — data-URL splash (`splashDataUrl()` :1372-1414) loaded :3127, later `loadURL(APP_URL)` in pollAndLoad :1126 + recovery :2804 + activate :3507; `setSplashStatus` guards on data:-URL prefix :1419; preload runs for both documents; `did-start-navigation` resets rendererReady :1552-1554. *Residue: split of the 187-429ms spawn→module-eval window (Electron framework init vs asar open vs parse vs require I/O) needs runtime tracing — the planned Electron-shell instrumented pass is the vehicle; `vibrancy: 'under-window'` create-time cost unmeasured (only touch if instrumented pass shows create_window dominated by window-server setup); V8 snapshot machinery judged not worth it for ≤50ms of unmeasured parse.*

**Startup/Electron performance research 2026-07-05 · Wave S3 (splash→SPA handoff + SPA boot + keep-alive options) checked clean (don't re-audit):**
Splash→SPA color continuity CORRECT — prod stylesheet render-blocking with `body { background-color: hsl(var(--background)) }` (index.css:28-29) + theme-flash pre-paint (theme-flash.ts:3-25), so the new document's first paint is theme-correct; the handoff gap is *blank*, not *wrong-colored* (only wrong-color window = the filed missing-`backgroundColor` frame-1 flash) · `setSplashStatus` data:-URL guard (main.js:1416-1426) can never poke the real app; splash palette derivation from persisted theme (`readSplashTheme`/`deriveSplashPalette` :1340-1370, persisted via `theme:persist-splash` preload.js:140) works and matches the app backdrop · splash messages all truthful (issue filed = coarseness, not honesty) · LanguageProvider never blocks children (LanguageContext.tsx:69-140) — no i18n loading wall; en+active locale fetch in parallel for non-en users once triggered · `main.tsx` mount sequence (:1-26) has no async gate before render · quit path bounded (45s unref'd force-exit main.js:3437-3441; `compose stop` not `down` :1296-1298 — volumes safe; watchdog torn down before container stop :3477-3478) · `pollReady` interval ladder (:1050-1065) + `pollAndLoad` build-aware budget (:1121-1147) nothing serial to shave statically · preload.js thin, runs for both documents at negligible cost · renderer→main ready signal exists (`electronAPI.ready()` ElectronBridge.tsx:102 → `app:renderer-ready` main.js:2817-2825, reset on navigation :1552-1554) — available for a paint-holding handoff if ever wanted. **Assessed and PARKED (don't pursue): pre-navigating the SPA during the compose wait** — the shell is served by the backend from memory only after listen (connection-refused before), the only loophole is Chromium's HTTP cache via the `max-age=1y` index.html header that's already filed as a bug to REMOVE, and the SPA has no boot-time connecting gate (React Query `retry: 1` would surface error states page-wide); a proper version needs an `app://` protocol + connection gate = meaningful effort for ~0.3-1s of overlap that hide-on-close/keep-services dwarf. *Residue: runtime durations of the SPA-side phases (loadURL → first paint → shell → strings-real) — mechanism-certain, magnitude-estimated; RAM cost of hidden renderer (C1) and idle containers (C2) — measure before the user decides.*

**Performance research 2026-07-05 · Wave P1 (backend query paths) checked clean (don't re-audit):**
trigram/GIN coverage exists and survives all migrations (`idx_transactions_memo_trgm`/`idx_transactions_comment_trgm` 0001:711-712, `idx_recipients_name_trgm` 0001:691; 0033 drops only `idx_transactions_date`, 0034 only legacy `ix_*` duplicates — the search problem is predicate shape, not missing indexes) · sort-column handling injection-safe and plan-cache-sane (whitelist map + ternary direction, parameterized LIMIT/OFFSET, stable `t.id DESC` tiebreaker — transactionRepository.js:27-40,105-112,428-434) · `transaction_tags` PK (transaction_id, tag_id) + `idx_transaction_tags_tag` (0031) — tag EXISTS probes and `tagSlugs = ANY(…)` index-served; `tags.slug` unique · `attachTagsToRows` one batched `ANY($1::int[])` per list call (transactionRepository.js:42-59) · **settings trio clean** (first audit ever): `GET /` one query via `getAll` (settingsRepository.js:48-58), `get()` single PK lookup, `setMany` one UNNEST upsert (:87-105), no per-key loops, no settings reads in middleware; the per-request settings reads that exist are single PK lookups (infoRepositoryHelpers.js:19, plannedMatchService.js:92, portfolioSummaryService.js:37) · bulk endpoints set-based (bulk-tag UNNEST CROSS JOIN + ANY delete routes/transactions.js:350-373; bulk-update/delete single statement :485-491,394-400; bulkSelection 5000-row cap with COUNT precheck) · manual-create dedup index-served (`idx_transactions_amount_date`, `deduplication_hash`/`normalized_name` inline UNIQUE) · `convertRowsToEur` one `getRates()` + per-(currency,date) memo, no per-row queries · categories/recipients count queries parallel on small tables · `listRecentUnlinked` date-bounded with indexed NOT EXISTS (transactionRepository.js:575-598). *Not covered: EXPLAIN-level verification on a live DB (planner claims are from PG semantics, not measured plans); transactionExport.js streamer internals; frontend search-box debounce cadence.*

**Performance research 2026-07-05 · Wave P2 (in-process memory & cache boundedness) checked clean (don't re-audit):**
the backend is unusually well-bounded — every major cache has TTL + size cap or fixed key cardinality, all module-scope intervals unref'd or cleared on shutdown, SSE/AI streaming state per-request with abort wiring. Specifics: `routes/info/_cache.js` all three response caches (TTL + hard `MAX_CACHE_ENTRIES=100` on every set, expired prune on get/set, inflight protected from eviction, error path self-cleans :103-108) · `middleware/requestMetrics.js` internals (first-ever read — `MAX_ROUTE_STORES=500`, 15-min bucket eviction per request, latency arrays reservoir-sampled at 1000/bucket, unmatched URLs collapsed to one key so scanners can't inflate it) · `priceCache._cache` (cardinality = configured investments, 5-min TTL + unref'd sweep :141-142) · `mvCache` hard-bounded to 2-name allowlist · aiChat `toolCache` created per turn inside `runChatTurnInner`, never escapes; `memoizeAsync` keys are asset-class discriminators not user text · `lib/sse.js` + all three consumers: no module-level client registry, per-request writer GC'd with response, `routes/ai.js:224-227,303-306` wires AbortController to `res.on('close')` so abandoned AI streams abort the Ollama call · `ollama/client.js` timers cleared in `finally` both paths, reader lock released, `{once:true}` abort listeners · warmup's four intervals created once, `withInFlightGuard` (skip not stack), cleared on shutdown (main.js:534-537) · MV/reconcile debounce timers cleared before re-set, no stacking · `process.on` only at main.js module scope (:558-583), grep-verified none inside functions · researchAggregator `inFlight` deleted in `finally` · puppeteerRenderer beyond the filed race: page closed in `finally`, PDF in-memory Buffer, no temp files, no page accumulation · single-slot replace-not-accumulate caches (currencyConversionService `memoryCache`/`liveFallbackRates`, belgianInflation, network reachability) · `recipientPatternService.patternCache` true LRU capped 512 · quotaGovernor `minuteBuckets` one entry/provider · logger console-only, no buffer · frontend module scope: no unbounded module-level Maps; `useCurrencyFormatter` Map is per-component useRef, GC'd on unmount. *Not covered: Docker stdout log rotation (infra layer); whether abandoned import SSE should cancel the pipeline mid-parse (runs to completion by design, transient memory only); multer/express.json upload buffer limits (request-size/DoS pass territory).*

**Performance research 2026-07-05 · Wave P3 (frontend state/context/i18n runtime) checked clean (don't re-audit):**
**i18n lookup:** `t()`/`tc()` resolve against a flat `Record<string,string>` — single property access, no per-call key splitting/nested walking (LanguageContext.tsx:99-112,114-128); interpolation only when `vars` passed; `Intl.PluralRules` cached per locale (:51-59) · `t` referentially stable in steady state (`useCallback([dicts, language])`; `dicts` changes only on locale-chunk load); language switch: loaded locales cached, no re-fetch on switch-back, no state loss (the only instability is the LanguageBridge finding, filed) · no `t()` hot loops — VirtualDataTable t() calls are chrome-only (:511,675-676,830-831), not per-row · **zustand:** exactly one store (stores/settingsStore.ts, grep-confirmed); all three consumer hooks select slices with `useShallow` (AppSettingsContext.tsx:125-134, SettingsContext.tsx:101-110, ThemeContext.tsx:249-265); no high-frequency set calls (all 19 update sites are discrete Select/Switch handlers, no scroll/pointer writers) · settings persistence debounced 500ms API save, no per-set localStorage stringify (theme mirrors one string key on resolved-theme change only, ThemeContext.tsx:194,224) · **aiChatStreamStore internals** (read in full): per-conversation snapshots reference-stable (getState returns Map entry or frozen INITIAL_STREAM_STATE, :143-146 — no fresh-object-per-getSnapshot risk), global listener set leak-safe (:131-136), non-matching consumers bail via unchanged snapshot; the `activeIds` identity churn is filed separately as a Finding ("aiChatStreamStore emits a new `activeIds` array on every token", 🏛️ Architecture & API) · **context values:** LanguageContext/PageTitleContext/BelgianTaxProfileContext/SidebarContext all memoized; PageHeader setTitle fires only on mount/title change; AppLayout scroll collapse is local boolean state with same-value bailout · **list surfaces:** RecipientsPage:385, OwesPage:461, PlannedPaymentsPage:500 all VirtualDataTable; CategoriesPage bounded grouped accordion (:166-194); AccountsPage bounded cards; StatisticsPage maps bounded widgetDefs; StocksPage/CryptoPage holdings bounded by distinct positions; no TagsPage exists · **form hotspots:** AddTransactionDialog keystroke re-render light (Radix SelectContent mounts only while open, so 200-item lists don't render per keystroke); TransactionInfoDialog ~20 light rows, local edit state · WorkspaceContext is a plain hook, sessionStorage read on agnostic routes only. *Not covered: lib/devtools/* hand-rolled stores (dev-gated, unread); useUpcomingPlannedPayments dismissed-keys snapshot (:91); PlannedPaymentForm keystroke behavior; no runtime profiling (LanguageBridge blast radius untested empirically).*

**Performance research 2026-07-05 · Wave P4 (startup/boot latency) checked clean (don't re-audit):**
Electron `parallel_init` genuinely parallel (port resolve, .env ensure, Docker check, conditional pre-pull, dev skip-build in one `Promise.all` — packaging/electron/main.js:3144-3246) · Docker daemon check fast path via Unix-socket `/_ping` (<50ms warm), CLI fallback only (main.js:1156-1200) · warm-boot compose fast paths correct and cheap (all-running → no compose mutation; all-stopped → `compose start`, no build/pull; port-drift guard falls through to `up` recreate; quit uses `stop` not `down` precisely to keep this path alive — main.js:1245-1298; packaged `up -d` never passes `--build`, `pull_policy: missing` + parallel pre-pull only when image absent) · health poll cadence well-tuned (100ms×20 then 300ms, keep-alive agent, connection-refused fails fast — main.js:979-1013,1050-1065) · splash shows before any Docker I/O (createWindow main.js:3122-3128; the awaited initI18n is only small local JSON) · container entrypoint execs bun immediately, no serial pg_isready loop (removed deliberately, docker-entrypoint.sh) · no `depends_on: service_healthy` chain; db/image healthchecks informational only — Electron polls HTTP directly, so healthcheck intervals add zero boot latency (docker-compose.yml:12-19,61-73, Dockerfile:134-135) · alembic skip-at-head cache persists across container recreation (`/app/.vision-cache` = `vision_cache_data` volume, writable despite read_only rootfs, both composes; miss only on first boot or changed alembic/versions/, miss cost one alembic spawn 1-3s; `stampBaselineIfLegacy` ~3 trivial queries — migrate.js:30-76,132-207) · backend DB wait immediate-first with 50ms→1s exponential backoff (main.js:434-470) · pre-listen MV work is create/index-only (`IF NOT EXISTS`), refresh correctly deferred post-listen (main.js:452-462) · puppeteer lazy at first render; offline probe bounded (1.5s TCP, 30s cache), doesn't gate the materializedViews readiness key · frontend providers render children immediately, no loading walls; DashboardPage skeletons instant (App.tsx:164-247, DashboardPage.tsx:305-330) · dev loop clean — `bun run dev` = concurrently vite + `bun --watch`, no locale regeneration (root package.json:16) · port resolution persisted, random-pick ms-scale, crash-recovery port-walk confirmed fixed; quit bounded by 45s force-exit so it can't poison the next boot (main.js:3437-3441) · quit-time backup opt-in, bounded, doesn't touch boot. *Not covered: no live measurement — both shells emit structured `VISION_BOOT_TRACE` phase timings; a single instrumented boot would turn the per-stage estimates (MV refresh, container start) into numbers. Demo-app boot path / install-demo.sh unswept.*

**Performance research 2026-07-02**

- **React Query:** global defaults respected everywhere (no `staleTime: 0` / `refetchOnMount: 'always'` in src); PortfolioTicker polling is exemplary (IntersectionObserver + `document.hidden` + online gating); dialog-scoped queries properly `enabled`-gated (Merge/Patterns/Watchlist/Research dialogs, CommandPalette); research-tab staleTimes correct; no unstable query keys found (exclusion arrays deduped+sorted+memoized); portfolio mutations invalidate scoped prefixes; watchlist/market polls online-gated and deduped across pages.
- **Runtime:** `useCountUp` rAF-driven with reduced-motion snap; `RollingNumber` pure CSS; `ThemeContext`/`UpdateNotification` timers gated; zero `JSON.parse(JSON.stringify)`/`structuredClone` in the frontend; `useStatistics` fully server-aggregated; DashboardPage/RecipientsPage/PlannedPaymentsPage/PortfolioOverview/Stocks derived data memoized; `useCurrencyFormatter` caches correctly.
- **Bundle:** sourcemaps off in prod; no moment/lodash/jspdf/xlsx anywhere; date-fns in a non-preloaded chunk; visx isolated in a lazy chunk; all 38 routes lazy with sidebar hover-prefetch (`lib/routePreload.ts:51-58`); devtools env-gated and absent from prod chunks; Tailwind content globs tight (25 KB gz total CSS); `public/` is tiny.
- **Backend infra:** gzip wrapper is SSE-exempt + backpressure-correct; `express.json` 1MB limit; SPA shell preloaded into memory at boot; per-request middleware all O(1) with bounded memory; in-memory rate limiter O(1) with unref'd sweep; `/health` DB-free (detailed probe 1s-cached); PG pool sizing/withTransaction-release/poisoned-client handling all correct; startup fully parallelized post-listen with an offline short-circuit and an alembic skip-at-head cache; MV refresh CONCURRENTLY + coalesced (only the scheduling/timeout issues above); background jobs overlap-guarded with cleared intervals; graceful shutdown drains correctly; Electron health watchdog cheap (10s, keep-alive agent, no execSync anywhere).
- **Reports:** Puppeteer page-per-render closed in `finally` (only the launch race above); all 21 section renderers are pure string builders over pre-aggregated data with top-N caps, zero DB access; `dataFetcherTax` FX loop uses a binary-searched rate index (no per-row queries); sankey fully SQL-aggregated; `mvAvailable` probe cached; MC paths clamped at the route; backtest doesn't forward user `paths`.
- **DB:** systematic FK-index pass over migrations 0001→0064 found all *other* queried FK columns indexed (transactions, planned, splits, attachments, tags junctions, staging batch ids, portfolio 0052 columns, recipients); all 4 MVs have the unique indexes CONCURRENTLY requires with a correct non-concurrent fallback; `asset_price_history` pruned to holding windows; `rateFetcher`/`belgianInflationService`/`settingsRepository.setMany`/`cleanupStaleQuotes` all batch correctly; raw bank tables grow by design (dedup source of truth, indexed).

**UI/GPU research 2026-07-02**

**Wave A checked clean (don't re-audit):** theme switch (theme-flash.ts flips `.dark` class pre-paint; no `* { transition }`, no root/body color transition — switch is one style-recalc + single repaint, no animation wave) · `will-change`/layer-promotion (only 3 sites in index.css:573,727,941 — aurora blobs, micro-lift hover, ticker — all justified, no `translateZ(0)` hacks) · PortfolioTicker marquee gating (IntersectionObserver + visibilitychange + hover pause + conditional will-change, PortfolioTicker.tsx:83-95 — exemplary) · `drop-shadow()`/SVG filters (single 3.5px star icon at MarketOverviewPage.tsx:1025, no feGaussianBlur anywhere) · no `background-attachment: fixed`/`bg-fixed` · no transitions on `filter`/`backdrop-filter` anywhere · form controls & button variants use explicit `transition-[...]` property lists rather than transition-all (button/input/select/switch/checkbox/toggle/slider) · reduced-motion + reduced-transparency + prefers-contrast + fx-tier fallbacks comprehensive and mutually consistent (index.css:977-1122) · `animate-in`/`animate-stagger`/dialog enter-exit keyframes finite, opacity/transform-only · `animate-spin`/`animate-pulse` instances are transient loading spinners (compositor-friendly) · app-topbar correctly drops its backdrop-filter at scroll-top (index.css:500-503) · sonner toasts/popovers/menus glass-thick (transient, bounded) · scrollbar styling · the four `glass-regular` hotspot pages (RealEstatePage 8, StocksPage 7, TaxOverviewPage 7, MarketLookupPage 7) have no nested blur or per-row blur multiplication — every use is a top-level `<Card>`, inner list items use plain fills (`bg-card/50`, `bg-muted/30`), and mapped-card counts are bounded (Tax summary ≤6, one Card per RealEstate property, MarketLookup sections mutually exclusive at ~5-6 concurrent max) · framer `whileHover`/`animate` sweep outside the app shell: importers are exactly the 9 lazy-route chart components + the app-shell trio (AppSidebar/PageTransition/tabs, already filed) + `lib/motion.ts`, with the only non-shell `whileHover` being DonutChart's event-driven slice scale — no hidden per-frame motion sites (this also means `lib/motion.ts`'s unused `microLift`/`pressFeedback` presets carry zero runtime cost; their dead-export cleanup is tracked as a UI/UX-domain finding, not a performance item) · visx SVG paint statics: no SVG `filter=`/feGaussianBlur anywhere in `components/charts/`, exactly one `LinearGradient` per AreaChart (`AreaChart.tsx:290-305`), grid lines ≤5 per chart · CommandPalette surface cost when open: one standard glass-thick DialogContent + the shared blur-md overlay, ~35 static CommandItems + bounded dynamic groups (≤5 recipients, 1 ticker, 1 calc row), cmdk filtering trivial, FX/calc memos O(1) · OnboardingWizard: single shared Dialog surface, one step rendered at a time (largest step 15 category buttons), no framer, no extra glass layers, adapters fetched only while open · the ~29 redundant `glass-regular`/`premium-frame` Card call sites named as Wave A hotspot counts (`components/ui/card.tsx:9` already bakes both in) have zero GPU/render cost — duplicate classnames dedupe, so the counts were a grep artifact of class redundancy, not a rendering signal; the redundancy itself is tracked as a UI/UX-domain cleanup finding, not a performance item.

**Wave B checked clean (don't re-audit):** single ShaderAurora instance for app lifetime (AppLayout mounted once outside `<Routes>`, App.tsx:181, no per-route remount/context churn) · no GL context re-creation on theme change (MutationObserver color refresh only, ShaderAurora.tsx:152-153) · context attrs otherwise sane (`preserveDrawingBuffer` default false, `antialias:false`, `depth/stencil:false`, cleanup calls `WEBGL_lose_context.loseContext()` + cancels rAF + removes listeners) · DPR deliberately ignored in canvas sizing (0.25×/640px blurry-noise cap makes DPR moot; window `resize` catches cross-monitor moves) · no `backgroundThrottling:false`, no `appendSwitch`, no `disableHardwareAcceleration`, no `powerSaveBlocker`, single BrowserWindow, sandbox/contextIsolation on (main.js:1485-1510) — Electron default throttling does stop rAF+CSS animation when hidden/minimized/fully-occluded (so the always-running auroras are saved there, just not on blur-while-visible) · no other `<canvas>`/`getContext`/`OffscreenCanvas` anywhere in apps/frontend/src · no canvas-based chart/animation libs (Recharts is SVG; no confetti/three/pixi) · VirtualDataTable.tsx:409-411 rAF is a bounded 5-attempt focus retry, not a loop · RollingNumber.tsx:32 is a single settle rAF · no `<video>`/GIF/`image-rendering` usage · RemoteNewsImage.tsx:51 already has `decoding="async"` · useLargeDisplay 5s poll is 4 property reads (negligible) · full-screen occlusion survey: the aurora is never opaquely occluded — the only `fixed inset-0` surfaces in the app are the three Radix overlays (`dialog.tsx:23` bg-background/40, `sheet.tsx:22` /40, `alert-dialog.tsx:20` /50, all + backdrop-blur-md), so opacity-triggered draw-pausing has no trigger surface beyond the already-filed "freeze aurora while a modal overlay is up" variant · Electron boot splash (`packaging/electron/main.js:1373-1416`) read in full: data:-URL page, one 26px border-spinner (compositor-friendly `transform: rotate`), one static radial-gradient painted once, reduced-motion hides the spinner, `setSplashStatus` guards on `getURL().startsWith('data:')` so it is strictly boot-only · `packaging/electron/preload.js` read in full: pure contextBridge IPC surface, no eager listeners (subscription helpers register on renderer call and return unsubscribers), no polling, no DOM/render footprint · Recharts-layer animation gating is moot: Recharts is only consumed by `ToolResultCard.tsx`, and every series there sets `isAnimationActive={false}`, so no Recharts entrance animation exists anywhere — the visx/framer charts' missing in-view gating is the separately-filed chart mount-stagger finding.

**Wave C checked clean (don't re-audit):** AppLayout window-scroll topbar effect (`AppLayout.tsx:82-90` — passive, boolean setState with React same-value bailout, `children` element reference stable so page subtree doesn't re-render on threshold crossings) · VirtualDataTable infinite-scroll handler (`VirtualDataTable.tsx:414-449` — passive, ref-guarded, no per-scroll setState) and its single-instance document mousedown/keydown listeners (198-213) · ShaderAurora (rAF capped 30fps, 0.25× res, resize handler only sets canvas dims, getComputedStyle only on mount/theme MutationObserver, full cleanup) · useLargeDisplay/useVisualEffectsTier (resize listener + 5s poll, boolean bailout) · PageTransition (animates opacity/y/scale = transform-only, no AnimatePresence, no layout props, reduced-motion bypass) · tabs.tsx active pill and AppSidebar ActiveRail (layoutId FLIP on discrete tab/route change only, transform-based) · dialogGenie (one module-level passive pointerdown listener + single GBCR at dialog mount) · ElectronBridge window dragover/drop (guarded, no state) · CommandPalette forceMount (bounded: ≤5 recipient hits + single result items, palette mounted only while open) and its single ⌘K document listener · sidebar/ShortcutsOverlay/useGoToShortcuts/AppLayout keydown — all single-instance app-shell listeners, no per-row listeners anywhere · DonutChart hover (event-driven enter/leave, AnimatePresence center swap is one small node) · ResizeObserver usage (only visx ParentSize per chart, one element each, library-managed disconnect) · themeTokens getComputedStyle (report-export one-shot only) · no window `resize` setState storms found · no framer `layout` prop usage on motion components · no Radix tooltips/hover-cards on table rows (HoverCard imported nowhere; TooltipTrigger only in sidebar/ExclusionToggle/TaxOverviewPage at low counts) · CsvDropzone dragover (boolean state, import page only) · no measurement→state→layout feedback loops beyond the ChartTooltip one reported above · SankeyChart (`SankeyChart.tsx:64-96`): the in-place d3-sankey mutation does not defeat memoization — nodes/links are shallow-cloned inside the layout `useMemo` keyed on `[data, innerWidth, innerHeight]`, so layout only re-runs on data/resize; hover re-renders only regenerate a small number of link `d` strings via `pathGen`, negligible · VirtualDataTable inline edit: no Radix portal churn — exactly one row is editable at a time (`editingRow`, `VirtualDataTable.tsx:131,685`), edit cells are plain `Input`/`DatePicker`, and TransactionsTable's `CategoryCombobox`/`RecipientCombobox` mount Radix Popover content only on open (portal lazy) — ≤2 combobox instances exist while editing, zero in display mode · `use-mobile`/matchMedia hygiene: `use-mobile.tsx` pairs `addEventListener`/`removeEventListener` on the MQL, `ThemeContext.tsx:160-166` likewise, `useCountUp.ts:29-32` and theme-transition checks are one-shot `.matches` reads — no leaks, no per-render listener registration.

**UI/GPU perf research 2026-07-05 · Wave G1 checked clean (don't re-audit):**
`will-change` inventory dimension COMPLETE — exactly 3 sites, all correctly scoped (index.css:568-573 aurora blobs always-animating so promotion justified; :725-728 `.micro-lift:hover` only; :936-942 `.ticker-track` only under `[data-active="true"]`); zero inline `willChange` in TSX, zero `translateZ(0)` hacks; only one `position: fixed` element in index.css (:555 liquid-canvas) besides the surveyed Radix overlays — no layer explosion beyond the filed backdrop-filter story · infinite-animation sweep COMPLETE — index.css keyframes are only aurora-drift-a/b (excluded), finite animate-in/icon-success-bounce, and IntersectionObserver-gated ticker-scroll; tailwind.config.ts:71-92 custom keyframes only finite accordion-down/up; no framer `repeat: Infinity` in src; all animate-spin/pulse are loading-transient except two motion-safe-gated opacity-only 6px dots (AppSidebar.tsx:403, ChatConversationList.tsx:127 — negligible, not filed) · event-listener hygiene COMPLETE — no non-passive wheel/touch listeners anywhere; scroll listeners only AppLayout.tsx:88 + VirtualDataTable.tsx:445, both passive (previously verified); resize only ShaderAurora.tsx:164 + useVisualEffectsTier.ts:17 · layout-thrash sweep COMPLETE — every GBCR/offset*/scrollHeight/getComputedStyle hit is previously filed/excluded or the new chart-hover finding; no ResizeObserver writes styles (only visx ParentSize, library-managed) · React 19 scheduling — VirtualDataTable.tsx:341 already uses `useDeferredValue`; no useTransition anywhere; market/research search surfaces (SymbolSearchBox consumers, MarketLookupPage, ResearchComparePage, ChartBuilderPage, ResearchHomePage, AddToWatchlistDialog) all debounce into bounded server queries — no expensive un-deferred client subtree besides the filed combobox family · load-path polish COMPLETE — RemoteNewsImage.tsx:44-54 already lazy+async+sized; only inline base64 asset is the ~300-byte noise SVG (index.css:651); route hover-prefetch exists (lib/routePreload.ts); index.html minimal · StatisticsPage.tsx:159-283 Radix Tabs without forceMount — inactive tabs' charts unmounted, not hidden-but-rendering.

**UI/GPU perf research 2026-07-05 · Wave G2 runtime verdicts (demo app, first measured pass — don't re-measure at this scale):**
Aurora idle cost DEFLATED at both tiers — Standard tier doesn't even mount the WebGL canvas (`AppLayout.tsx:106` gates `<ShaderAurora/>` behind `effectsTier === 'enhanced'`; Standard "aurora" = 2 CSS keyframe pseudo-elements), and paused-vs-running showed zero main-thread delta; Enhanced with shader mounted still 60fps/0 long tasks, 0.25×-res claim real (360×225 backing for 1430×900 element) · glass/backdrop-filter steady state — no main-thread cost measurable over 14 (Dashboard) / 9 (Statistics) / 3 (Transactions) surfaces through idle/scroll/hover (GPU raster cost invisible to the instrument; nothing backs up into frame drops) · Transactions virtualized scroll clean (jank 1.3%, worst 33.4ms, 0 long tasks under forced 120px/frame scroll during page loads) · page load clean (FCP 104ms, 0 long tasks ≥50ms) · Statistics mount produced 0 long tasks even mid-stagger · the filed hover-path-rebuild/GBCR stack: no measurable cost at 31-month density (one 216.7ms first-run gap did not reproduce — harness/GC artifact, recorded for honesty, no action). **Full measurement table + caveats (DPR 1, main-thread-only instrument, Electron not exercised, demo = ¼ of real month span) in §Research context → UI/GPU performance research 2026-07-05.**

**UI/GPU perf research 2026-07-05 · Wave G3 checked clean (don't re-audit):**
Build graph (prod build ran clean, vite 8.0.16/rolldown): all 6 @fontsource woff2 land hashed in `dist/assets/` (Fraunces 400/600/700 ~20 kB, Inter 400/500/600 ~24 kB each); entry *static*-graph modulepreloading itself is correct/complete (12 chunks); manualChunks isolation verified in output — recharts (114 kB gz) absent from shared `charts` chunk, contained in `AIChatPage` (vite.config.ts:71-76 comment true). Top chunks (raw│gz): index 429│119 kB · AIChatPage 373│105 · nl 202│55 · en 189│50 · react-vendor 179│57 · radix-ui 164│50 · charts 111│34 · **Fraunces weight synthesis CLEAN** — Fraunces = h1-h3 + `.font-display` (index.css:39-46); all 13 `.font-display` sites pair with `font-semibold` (600, loaded), all explicit-weight h1-h3 use `font-bold` (700, loaded); zero `font-medium`/`italic` on any Fraunces surface (the only weight issues are the Inter ones filed in §🎨) · **remaining combobox cardinality CLEAN at realistic sizes** — TagFilterCombobox → `GET /api/tags` unbounded but hand-created tags (dozens ceiling); BankAccountMultiCombobox → distinct labels (~10); InvestmentCombobox → `useInvestmentsQuery` `limit: 500` incl. sold, single consumer PortfolioImportReviewPage, realistic cardinality tens (if holdings ever near the 500 cap it inherits the RecipientCombobox fix family — not filed) · **static-asset cache headers near-optimal** — main.js:359 hashed assets `max-age=1y, immutable`; :360-366 SPA shell from memory with `no-cache`; gzip at main.js:146; Electron loads the same backend (packaging/electron/main.js:213,1078). Only defects: the `/index.html`-literal-path edge (filed §🐛) and non-hashed public files sharing the 1y header (same finding).

**DB performance research 2026-07-06 · Wave D1 (Postgres server & container config — first-ever audit) checked clean (don't re-audit):**
**Live-verified on demo DB (`visiondemoapp-db-1`, PG 18.4, 18 MB total, largest relation 2.1 MB).** Stock defaults assessed and genuinely fine at this scale (thresholds noted so they can be re-checked against a real install): `shared_buffers` 128 MB (entire DB fits ~7× over) · `work_mem` 4 MB (every sort/hash fits; revisit past ~100 MB tables) · `effective_cache_size` 4 GB (planner hint, roughly right for Docker Desktop VM) · `jit=on` (jit_above_cost 100k never reached at this size) · `maintenance_work_mem` 64 MB, autovacuum defaults, `max_wal_size` 1 GB, `checkpoint_completion_target` 0.9 (fine for this write volume) · `max_connections` 100 vs pool max 10 (huge headroom) · `synchronous_commit=on` (CORRECT for financial data — do not trade durability for import speed) · `effective_io_concurrency` 16 (PG18's new default is already SSD-appropriate — the old classic finding is fixed upstream) · `huge_pages=try` (meaningless in the VM at this shared_buffers). **Image/volume posture:** all shipping composes pin `postgres:18-alpine`, no major-version skew (16→18 switch in commit `806415dc` predates the release workflow — no released install stranded on a PG16 volume; stray local `postgres:16` image referenced by nothing) · volume mount `postgres_data:/var/lib/postgresql` matches PG18 official-image PGDATA layout (future in-place pg_upgrade feasible); named volume = VM-native ext4, not slow gRPC-FUSE bind · data checksums ON (PG18 initdb default, live-verified) · no db memory/cpu limit — correct (app capped 4g/4cpu, db intentionally uncapped) · `docker-compose.dev.yml`/`docker-compose.clean.yml` have no db config drift; `dist/` compose copies are build artifacts. **Pool fresh angles (beyond filed statement_timeout/max=10):** single shared `pg.Pool` (`apps/node-backend/src/database/connection.js:22-28`) is the only pool; no `min` (default 0 fine — worst case one ~5ms reconnect after 60s idle); `connectionTimeoutMillis` 5s sane; no per-connection SET round-trips; `queryPrepared` per-connection cache correct; poisoned-client destruction on failed ROLLBACK correct; missing `application_name` = observability nit, not filed. **Backup path:** zero `pg_dump` in the backend — dump/restore runs from the Electron shell against the container directly, no competition for the app pool or its statement_timeout. *Uncertainty: whether 18.4 is the newest 18.x minor was not web-verified (the never-pulls-db finding stands regardless); live checks are demo-DB only — threshold assessments should be re-checked against the real DB if it's orders of magnitude larger.*

**DB performance research 2026-07-06 · Wave D2 (first-ever live EXPLAIN pass, demo DB) checked clean + measured (don't re-derive):**
All five filed structural planner claims got live verdicts (recorded as 📏 notes on the items themselves): search OR-chain, category COALESCE, recipient OR, ABS(amount) all CONFIRMED structural via `enable_seqscan=off` (predicate stays a post-join Filter, never an Index Cond); COUNT(*) OVER () plan-flip demonstrated. **Measurement technique worth reusing:** with seqscan disabled the planner fakes compliance via a *full bitmap scan of a small partial index* (`Recheck Cond: is_active` only) — "an index appears in the plan" is NOT evidence the filter is indexed; only `Index Cond` containing the filter column counts. **Clean:** default list plan without the window count is excellent (pipelined Nested Loop + Memoize on all 5 joins, stops at LIMIT via `idx_transactions_active`) · tag EXISTS subquery planned as a hashed SubPlan executed once, not per-row — cheap even inside the OR chain · MV machinery healthy: all 4 unique indexes present, CONCURRENTLY works, refresh 3.7-22.4 ms at demo scale (mv_monthly_summary 236 rows/32 kB the biggest; consistent with the 33-38 ms boot-gate measurement; says nothing about statement_timeout risk at real scale) · table bloat negligible (max n_dead_tup 866, autovacuum current) · date-range aggregation predicates get real Index Conds on `idx_transaction_date_recipient` · signed amount filters correctly use `idx_transactions_amount_date` · `getAll`/`getCount`/`getAllWithCount` share one WHERE builder — no count-vs-page drift. *Caveats: 1,051-row warm-cache corpus — only plan-shape verdicts, catalog facts, and the never-analyzed behavior transfer to real installs; GIN-wins-at-scale for the UNION restructure is capability-proven, not benefit-proven; idx_scan counters are demo-lifetime only.*

### 🎨 UI/UX & Design

**Design authenticity 2026-07-03**

**Wave S1 checked clean (don't re-audit):** zero "Oops/Whoops/Uh oh/Awesome/Great!" anywhere (en.json, nl.json, and all of `apps/frontend/src` — only a code comment in `lib/undo.ts:4`) · no marketing-speak: 0× seamless/effortless/powerful/easily, and only 2 "Manage your"-type subtitles (filed above) · portfolio buy/sell flow verb-consistent (button "Record":174 → toast "{type} recorded for {name}":184) · "OK" exists only as unused `common.ok`:537, no "Submit" anywhere · placeholders are overwhelmingly the good "e.g. <real value>" pattern (~20 sites) with real examples, incl. `dbEditor.rawWherePlaceholder`:732 showing an actual WHERE clause · the 4 tooltip strings (`accounts.balanceTooltip`:6, `accounts.driftTooltip`:24, `portfolio.stalePriceTooltip`:1843, `tax.pit.tooltip`:3039) all add information, none restates a label · nl.json has no "Gelieve" (over-formal Flemish) and no meaningful untranslated-English leakage (the 103 identical en=nl values are legit shared terms: Type, Status, Dashboard, Crypto, MACD…) · destructive confirms mostly name the object and consequence (`accounts.mergeWarning`:58 is exemplary); the weak category/recipient ones are already filed by Wave U2 (TODO ~line 492) · Title Case vs sentence case drift already filed by Wave U5 — not re-measured · error strings largely interpolate real reasons via `{msg}` (28 sites) · onboarding restore-flow copy (`onboarding.restore.*`:1404-1412) is precise and consequence-stating. (2026-07-03) **Electron main-process dialogs are genuinely i18n'd** — own async `t()` loader (`main.js:12-56`) reading packaged en/nl.json, 55 call sites covering Docker prompts, updates, slow-boot, embedded-prep; the sole exception is the restore confirm (filed above) · `aria.*` (21 keys) are descriptive verb-object phrases; `shortcuts.*` are human (real tips, platform-aware, "Quick Look" untranslated deliberately); AI-chat microcopy is fully i18n'd and on-voice across all 5 components (nits filed above) — nl.json has no untranslated-English leakage beyond what's already filed · dead-key scan exclusions were derived, not assumed — all 25 template-literal `t()`-key families (`accounts.type/*`, `portfolio.assetClass/*`, `export.reportType/*`, `tax.profile.region/*`, `research.scorecard.*`, `rebalance.model/sleeve`, `performance.*`, `cashflow.window*`, …) + 12 `tc()` plural-suffix keys enumerated; zero string-concat key building exists in the codebase.

**Wave S2 checked clean (don't re-audit):** zero raw indigo/purple/violet/fuchsia/pink/rose/teal/cyan classes anywhere in `apps/frontend/src` (the classic gradient-slop hues are simply absent); only one `bg-clip-text`/`text-transparent` in the whole app (filed above) and zero `from-blue→to-purple` gradients — all 68 `bg-gradient-to-*` sites except the corner-orb family and DbMaintenance orange use tokens (`primary/accent/gain/loss/chart-N`) · hardcoded hex in TS/TSX: only `charts/BarChart.tsx:360` (`var(--background, #fff)` fallback — fine) · `ShaderAurora.tsx:146-150` reads `--primary`/`--accent` live from the theme (WebGL is token-driven, one gradient language with the CSS aurora) · `TagInput.tsx:13-26` palette is a *designed*, named jewel-tone wheel with `color-mix` tinting — a model, not a violation · `components/charts/palette.ts` + `ChartTooltip`/`ChartLegend`/axis neutrals are fully token-routed; recharts defaults nowhere · gain/loss token discipline is genuinely good: `--gain/--loss` → 166 combined uses, sign-conditional `text-success:text-destructive` ternaries = 0 (ADR-104 colorblind toggle is respected on every money surface checked, incl. WatchlistChartDialog's inverted below-target=gain logic) · `--warning` correctly adopted in 74 places (the 6 stragglers filed above) · theme variants in `styles/themes.ts` define the full token surface incl. all 8 chart colors and glass tokens (no partial-variant gaps) · dialog/popover/dropdown/sheet uniformly `glass-thick` and sidebar `glass-chrome` — the chrome/overlay tiers ARE hierarchical · onboarding wizard section colors are token-based (`chart-3`/`primary`) · overlay scrims consistent (`bg-background/40 backdrop-blur-md` ×3). (2026-07-03) **`index.css` 400-1100 is token-routed** — aurora blobs compose `--primary`/`--accent` with `--aurora-*-alpha` tokens; film grain is colorless feTurbulence + `--grain-alpha`; the only `#000`s (`:960-968`) are mask alpha stops (not color); glass/hairline/fx-reduced blocks are all `hsl(var(--…))` — the raw-black dark shadows filed above are the sole literals · **Report/PDF palette is token-driven** — `apps/node-backend/src/services/reports/themeCss.js` receives the live frontend theme tokens, regex-sanitizes them (SSRF-hardened), and falls back to mode-aware defaults matching the house palette (158 62% 32% primary / 38 58% 52% accent) — no second color language on the export surface.

**Wave S3 checked clean (don't re-audit):** the font system itself is real, not templated — three deliberate roles (`styles/tokens.css:120-124`): Fraunces Variable display for h1–h3 with `dlig` + −0.02em (`index.css:39-46`), Inter body with `ss01/ss02/cv11` + −0.005em, SF Mono for identifiers; self-hosted via @fontsource with weights matching usage (400/600/700 Fraunces, 400/500/600 Inter — `main.tsx:9-14`), no Google-Fonts CDN, no generic single-stack tell · `.tabular-nums` is *overridden* to add −0.006em numeric tracking (`index.css:879-882`) — a real craft touch — with 234 uses; StocksPage holdings table (`pages/portfolio/StocksPage.tsx:306-380`) and NetWorthPage account rows/stat tiles are right-aligned + tabular throughout · `Money.tsx` and `RollingNumber.tsx` (odometer with reduced-motion + aria-label fallback) and `DeltaPill.tsx` are each genuinely designed components — the findings above are *adoption* gaps, don't redesign the components · `components/charts/scrub.tsx:46-52` sign handling (true −/±, sign-stripped abs) is exemplary · PageHeader h1 (Fraunces 3xl + `canvas-text` legibility halo, `index.css:59-68`) is deliberate and consistent across pages · ticker symbols uniformly `font-mono font-bold` (SymbolSearchResultItem, PortfolioTicker, ChartBuilderPage) — a coherent identifier convention · no gradient text on any heading (S2 filed the sole `bg-clip-text`, a number) · dashboard recent-transactions amount column is right-aligned (`pages/DashboardPage.tsx:293`) · heading size ladder h1 3xl → CardTitle 2xl → overridden lg for chart cards is coherent *where the defaults are used*. (2026-07-03) **`ChartAxis.tsx` is one real shared axis spec across all 5 visx charts** (the tabular-nums gap on numeric ticks is filed above); `formatDateStringWithAppSettings` is adopted in 20+ files; all tax tables + ImportReviewPage amounts are right-aligned + tabular via shared `formatCurrency`; `text-xs` is ~75-80% legitimate dense-data dialect (triage note filed on the sprawl finding above).

**Wave S4 checked clean (don't re-audit):** dialog sizing is NOT uniform — 6 deliberate width tiers across 24 sized DialogContents (sm→4xl; quick actions like OwesPage pay = `sm:max-w-sm`, editors = lg/2xl, review surfaces = 4xl) — genuinely task-scaled · Dashboard and PortfolioOverview both use real asymmetric bento compositions (featured 2×-span hero + secondary tiles, `DashboardPage.tsx:401-419`, `PortfolioOverviewPage.tsx:275-325`) — the app's two hubs are *not* interchangeable scaffolds · `MetalsPage.tsx:1-13` re-exports a parameterized StocksPage — the correct anti-paste pattern exists in-repo (A4 tracks making Crypto/Savings/RealEstate follow it) · RealEstatePage's body (`:208-300+`) is truly content-specific: per-property cards with location, MapPin, cadastral income, municipality tax, appreciation/rent split — the best page-specific composition in the app · OwesPage composition is content-derived (outstanding-total hero card `:63-77` + per-person progress cards with paid/total meters, not stat tiles) · badge usage is broadly semantic, not soup — 123 total `<Badge` app-wide; worst page (ImportReviewPage, 10) uses them correctly as match-status chips (`:43-67`); only the TaxOverview key-value trio filed above misuses them · Separator count is low (19) — no divider-decoration habit · no numbered-step decoration outside the onboarding wizard, where order is real · `EmptyState` (16 consumers) has designed character (glass tile + aurora glow halo, `components/shared/EmptyState.tsx:12-18`) and its icons mostly match page identity (hand-rolled empty-state clones are S6's axis) · TransactionsPage's utilitarian [header → FilterBanner → dense table] is *right* for its job — density variation between it and the dashboard is intentional and good. (2026-07-03) **Settings anatomy is a real system** — SettingsSection/SettingsGroup/SettingRow adopted 6/7 (7/7 of `sections/`); danger zone systematized (`AboutSection.tsx:256` SettingsGroup `border-destructive/30`); `DashboardSettingsDialog.tsx:91-112` has a proper sidebar-nav anatomy · TableDataEditorPage is genuinely crafted (two-row header, PK markers, dirty-cell amber ring, staged-op commit preview) · MarketOverviewPage's body is well-composed (~870/1111 lines are curated symbol config); its heat-grid composition is designed (the one color literal is filed above) · WatchlistPage/ResearchComparePage tables are house-language (chart-color dots, deliberate border-spacing heat matrix) · tax sub-widgets (MultiYearTrendStrip, YearComparisonCard) are content-derived.

**Wave S5 checked clean (don't re-audit):** the motion *system* is real, not aspirational — token durations/easings in `tokens.css:112-117` are mapped into Tailwind (`tailwind.config.ts:127-136`) and consumed by every `index.css` interaction utility · all 8 chart components are framer-driven off `lib/motion.ts` `durations`/`easings` with `useReducedMotion` (12 files) — zero recharts default entrances, and `ToolResultCard` explicitly sets `isAnimationActive={false}` ×3 · tabs active pill (`ui/tabs.tsx:78-81`) and sidebar rail (`AppSidebar.tsx:68-72`) magic-move via layoutId + `springs.snappy` with reduced-motion zero-duration — shared physics, genuinely crafted · dialog genie exit toward the opening pointer with keyboard fallback (`lib/dialogGenie.ts`) is signature-quality and shared by alert-dialog · Button has full press choreography (hover lift → active settle + `press-feedback` scale, enumerated transition properties, token timing) · sonner success toasts get the SF-Symbols icon bounce globally (`index.css:859-861`) and `TransactionImportCard.tsx:437` reuses it · `animate-pulse` restraint: 8 sites, mostly `motion-safe:`-gated micro-dots, no pulsing content cards · `hover:scale` restraint: 8 sites, all small icon-tile/knob scales (1.04-1.10), zero card-level zoom slop; arrow-nudge `group-hover:translate-x` only 6 · `animate-bounce` is only the chat typing ellipsis with designed 900ms/300ms-offset timing (`ChatMessageList.tsx:107-109`) · ticker tape: constant pixel speed via `--ticker-duration`, hover-to-read pause, offscreen freeze, reduced-motion none (`index.css:928-953`) · the reduced-motion story overall: broad CSS block (`:977-1010`) + `useReducedMotion` in PageTransition/charts/tabs/sidebar + `ShaderAurora.tsx:176-182` renders a static frame + `fx-static-atmosphere` freezes CSS blobs · focus rings are largely one pattern (`ring-2 ring-ring/70 ring-offset-2`; only 4 stray `ring-primary/50`). (2026-07-03) **`animate-stagger`'s 12-child delay cap is unreachable in practice** — its 3 consumers max out at 4 direct children (`SummaryCards.tsx:59` = 4, `DashboardPage.tsx:401` = 3, `NetWorthPage.tsx:237` ≤ 4), resolving the open question of whether any grid exceeds 12 · CommandPalette rides `CommandDialog` → house DialogContent (genie exit included); popover/select/dropdown share one open language (fade + zoom-95 + directional slide-2); sheet slide is token-driven, pure directional, and the slow-open/normal-close asymmetry is deliberate.

**Wave S6 checked clean (don't re-audit):** `ShortcutsOverlay.tsx` is a genuinely crafted shortcuts sheet — real inventory (not aspirational), platform-aware ⌘/Ctrl + ⇧/⌃, explicitly mirrors the Electron menu accelerators, styled `<kbd>` keys, bound to `?` with typing-target guard · Electron chrome is deeply considered: `hiddenInset` traffic lights + vibrancy + fullscreen inset handoff (`main.js:1497-1517`), persisted+clamped window bounds, macOS dock menu (New transaction / Dashboard, `:2983-2994`), ⌘1-9 route accelerators with a documented `before-input-event` reliability fix, notifications titled APP_NAME · splash *mechanics* (as opposed to character, filed above): `readSplashTheme`/`deriveSplashPalette` persist the user's palette so boot matches their theme, spinner hidden under reduced-motion, tabular-nums status line · `theme-flash.ts` applies theme *and* palette variant pre-mount (no FOUC) · the loading system is a coherent three-tier hierarchy, not spinner soup: `App.tsx:105-112` hairline top-edge shimmer for route chunks (designed, motion-reduce fallback) → `SectionLoader` shimmer stack (`role="status"`) for sections → `Loader2` reserved for inline button-busy (all 32 files checked; zero full-page centered spinners) · `TransactionsTable.tsx:384-393` empty state is the house exemplar (contextual icon, search-aware copy, Import CTA) · boot-error page bones: strict CSP, en/nl i18n, retry + view-logs actions, light/dark (`packaging/electron/assets/`) · onboarding offers restore-from-backup on the welcome step AND the backup step — genuinely considerate for migrating users · `SUGGESTED_CATEGORIES` per-category emoji (`OnboardingWizard.tsx:81-97`) is a warm human touch worth keeping · sidebar footer's glowing accent dot (`AppSidebar.tsx:403`) is charming — keep it, just fix the version string beside it. (2026-07-03) `build/icon.svg` is a designed on-token mark (obsidian body, emerald→champagne gradients, comments name the app's glass tokens) — the Vision Demo icon-parity gap is filed above, not the mark's own quality.

**UI/UX review 2026-07-10**

**Wave R4 checked clean (don't re-audit):** PlannedPaymentForm today-default (6d66491) is edit-safe — `initial?.due_date` is always truthy for real payments (`usePlannedPayments.ts:20/78/90` normalizes required `planned_date`), the `new Date()` branch only runs for new payments, and `key={editing?.id ?? "new"}` remounting (`PlannedPaymentsPage.tsx:513`) prevents stale-today carryover · VirtualDataTable empty-state a11y fix (95a25ba/80a5d66) yields a valid tree (rowgroup → row → cell → status, matching the data path's `role="cell"`:743 under `role="table"`:573) and keeps full-width centering (block-level cell, `text-center py-12`, no colspan in the div/flex layout) · UpdateNotification/AboutSection d975084 diff changed only the href expression — labels, ExternalLink icon, `t('update.releaseNotes')`, target/rel all intact · i18n strings unchanged since 2026-07-01 (`git log -- i18n/source` empty) — the 2026-07-03 string audits still describe the current state; all keys referenced by the post-audit commits already exist.

**Wave R3 checked clean (don't re-audit):** full side-by-side en/nl read of all 22 previously-uneyeballed namespaces (tax ×437 keys in full, research, portfolio, statsPage, customChart, addInv, rebalance, performance, export, admin, cashflow, insights, owesPage, aiChat, dbEditor, recipients/recipientsPage/recipientPatterns, invDetail, market, networth, exchangeRates) — issues confined to the R3 findings above · `tax`'s core Belgian fiscal vocabulary is largely excellent and correctly Belgian: TOB/beurstaks, Reynders-taks, roerende voorheffing (on the dividend keys), meerwaardebelasting, gemeentelijke opcentiemen, kadastraal inkomen, personenbelasting, aanslagbiljet, dienstencheques, woonbonus, chèque habitat, ten laste, WIB-92/CIR-92 citations; NO financial-direction inversions found in the previously-untested keys; nl number formatting correct (16.320 / €10.000 / 1,32%) · aiChat natural and idiomatic ("Aan het denken") · dbEditor clean ("wegschrijven" for commit is a sound consistent choice) · admin health metaphor consistent · recipientPatterns/recipientsPage consistent ("ontvanger", "matchpatroon", "hoofdlettergevoelig") · invDetail uses "koers" consistently · minor unfixed nits deliberately not filed: `cashflow.rollingDesc` drops the Past/next qualifiers; `market.forwardPE` "Forward K/W" vs `research.metric.forwardPE` "Verwachte K/W".

**Wave R2 checked clean (don't re-audit):** Go-menu terminology matches the sidebar — `GO_MENU_ROUTES` (`main.js:2833-2843`) labels every destination via the same `nav.*` keys the sidebar uses; no menu item points at a renamed route or coins a divergent noun (File → "Import CSV…" is intentionally action-scoped, distinct from the Go entry) · native menu Title Case is *correct* for the macOS surface (HIG convention) — the divergence from in-app sentence case is deliberate, not drift · TableDataEditorPage i18n complete: every user-facing string routes through `t('dbEditor.*')`, 35 keys at full en/nl parity; only untranslated literals are technical sentinels (NULL/true/false `:59-61`, PK marker `:376`, server op names `:523`) · the editor's ~15-icon import list has NO dead icons — all used with consistent icon-per-action semantics (Eye=preview, KeyRound=PK, Ban=set-null; RotateCcw doubles as discard+undo-delete, both read as "revert") · diff-before-commit exists: preview dialog renders exact generated SQL per op with INSERT/UPDATE/DELETE labels + destructive-op warning (`:504-529`) · TableDataEditorPage building on base `ui/table` primitives instead of DataTable/VirtualDataTable is defensible, not a rogue third dialect (editable cells, filter header row, PK locking, staged dirty-state — needs the shared components don't serve; noted in case an editable shared-table variant is ever extracted) · native notification identity consistent — `notify()` always titles `APP_NAME` and localizes bodies via `t()` (`main.js:538-542`; the 3 raw-English rebuild notifications at `:3387-3399` are dev-only) · no `Tray` usage exists (nothing to audit); app icons need no dark variants.

**Wave R1 checked clean (don't re-audit):** BulkActionsBar delete confirm quality — `tc(...)` with proper `.one/.other` pluralization, fully translated en+nl, `destructive` variant, count-aware "permanently removes … cannot be undone" body (`BulkActionsBar.tsx:92-103`) · MarkAsFiledDialog copy/i18n fully `t()`-driven with real Dutch for every key; `Label htmlFor="filing-reference"` correctly associates the input (`MarkAsFiledDialog.tsx:62-70`); "e.g. Tax-on-Web 2024-12345" placeholder is the house exemplar pattern · BulkExportDialog radio options correctly `htmlFor`/`id`-paired (`:44-51`), format defaults to csv, filename extension follows format (`useTransactions.ts:289-291`) · 0-selected edge safe — `BulkActionsBar` returns `null` at `idCount === 0` (`:78`) so the dialogs are unreachable empty; filter-mode tagging short-circuit is intentional and commented (`:154-165`) · BulkRecipientDialog disables Apply while `recipientId == null` and guards `handleApply` (`:33/55`); pending-disable across all four re-confirmed.

**UI/UX research 2026-07-03**

**Wave U1 checked clean (don't re-audit):** dialog/sheet/alert-dialog focus return — Radix defaults intact, zero `onOpenAutoFocus`/`onCloseAutoFocus` overrides repo-wide (grep) · dialogGenie is animation-only (transform-origin CSS vars, no focus impact) · no positive `tabIndex` anywhere (only 0/−1) · CommandPalette: ⌘K toggle, labeled input, cmdk arrow nav, recents, forceMount only on groups · ShortcutsOverlay discoverability good (`?` key, palette action, topbar ⌘K hint, list generated from real `GO_TO_ROUTES` so it can't drift) · `g`-sequence/`[`/`]`/⌘Z/⌘B all correctly inert while typing or with modifiers (modal gap filed above) · VirtualDataTable rows: ↑/↓/Enter/Space nav, `aria-sort`, sort headers are real `<button>`s, inline-edit Enter/Escape · OwesPage:86-94, CategoriesPage:195-210, WatchlistPage:160-171 clickable cards done right (`role="button"` + `tabIndex` + shared `onActivateKeyDown`) · charts ship localized SR summaries via `chartAria.ts` · `<header>`/`<main>` landmarks present · Escape closes search-suggestion dropdown + inline edit consistently. (2026-07-03) **Electron accelerators vs in-page keys: no collisions** — menu ⌘,/⌘N/⇧⌘I/⌃⌘S/⌘1-9 (`main.js:2836-2978`) vs page ⌘,/⌘Z/⌘K/`?`/g-seq/`[`/`]`; no key is dual-bound, and in-page ⌘Z only preventDefaults when it consumes an undo so native field-undo survives · cmdk combobox family keyboard is solid (arrow nav, Escape-returns-focus, multi-select stays open; minor: `BankAccountMultiCombobox:37-40` re-sorts selected-to-top on toggle, jumping the active highlight) · VirtualDataTable Space quick-look is end-to-end clean (preventDefault + typing guard + wired via `TransactionsTable.tsx:381`) · ContextMenuTrigger wraps the focusable row so Shift+F10 works · Calendar `autoFocus` moves into the day grid · no onClick-on-div anywhere in admin/settings.

**Wave U2 checked clean (don't re-audit):** AddTransactionDialog amount pattern (`type="text" inputMode="decimal"` + pattern + `parseLocaleNumber`) and TransactionInfoDialog inline amount edit (`:68` parseLocaleNumber) · `parseFloat` centralized (only `utils/currency.ts:55`, `utils/sanitize.ts:77` — no raw locale-string parseFloat) · `parseLocaleNumber`/`parseDecimal` comma/thousands heuristics solid · date defaults to today via `todayYmd` in `createAddTransactionFormState` · footer buttons in all 9 `<form>` dialogs correctly `type="button"`/`type="submit"` (no accidental default-submit; Radix Select/cmdk swallow Enter) · zero `window.confirm` · confirm coverage good on TransactionsPage:217, CategoriesPage:262, RecipientsPage:295, PlannedPaymentsPage:345, OwesPage:283, BulkActionsBar:93,107, ChatConversationList, InvestmentDetailDialog, BackupSection restore AlertDialog:350, TableDataEditorPage (staged deletes + op-count commit summary :208-219) · RecipientCombobox/CategoryCombobox have search + explicit "none" clear item · required fields marked "*" in PlannedPaymentForm labels (en.json:1594,1636) · API keys `type="password" autoComplete="off"` (ResearchKeysSection:104-109) · AddTransactionDialog/SplitTransactionDialog/AddRecipientDialog/AddCategoryDialog submit buttons disable on `isPending` · AddTransactionDialog + PlannedPaymentForm(new) keep typed state across accidental close (stay mounted, `key={editing?.id ?? "new"}` at PlannedPaymentsPage:512). (2026-07-03) **The stale-label bug is unique to RecipientCombobox** (Category/BankAccountMulti/TagFilter comboboxes load full lists client-side) · free-text-creation parity is equal (neither combobox creates inline — creation lives outside) · dialog close ✕ is last in DOM (`ui/dialog.tsx:48`) so Radix autofocus lands on the first real field · AdminOverviewPage's token field is exemplary · ExportDialog/MarkAsFiledDialog/bulk dialogs are solid (disabled-when-invalid, reset-on-close, pending-disable) · autocomplete sweep: only 2 `autoComplete="off"` sites, both secret fields; no name/address/email fields exist in the app · TransactionImportCard parser-config labels are `htmlFor`-linked · ExchangeRatesPage has NO manual-rate form (read-only + refresh — the residue premise there was wrong).

**Wave U3 checked clean (don't re-audit):** catch-all 404 route exists, localized, logs the path, offers a home link (`App.tsx:231`, `pages/NotFound.tsx`) · legacy-route redirects preserve query strings and use `replace` (`RedirectWithQuery`/`RedirectSymbolToMarket`, `App.tsx:148-162`; `/portfolio/market`, `/portfolio/watchlist`, `/research/symbol/:symbol`, `/portfolio/exchange-rates`) · `StartupRedirect` uses `replace` (`:64`) · sidebar active-state prefix matching is correct for nested routes incl. exact-match workspace roots and the `/admin` special case (`AppSidebar.tsx:85-91,374-376`), so `/import/:batchId/review` and `/admin/db/:table` highlight the right item · `?new=1` deep-link is consumed with `replace` so back/refresh don't re-open the dialog (`AddTransactionDialog.tsx:33-43`) · AI-chat `?conversation` and forecast `forecastMode`/`rollingDays` params replace-synced (`AIChatPage.tsx:28-46`, `CashFlowForecastChart.tsx:86-107`) · transactions filter changes push history entries (back steps through filter states — sensible) and quick-filters merge params additively (`TransactionsPage.tsx:262-271`) · bad/missing `:batchId` → disabled query → error panel with back-to-import buttons (`ImportReviewPage.tsx:96-99,256-273`); `TableDataEditorPage` has a back button (`:288`) + `query.error` panel (`:349`) · ScrollToTop keys on `pathname` only, so same-page query-param filtering doesn't yank scroll · Electron deep-link payloads validated (`ElectronBridge.tsx:52` `startsWith('/')`) · planned payment → matched transaction link exists (`ExecutionHistoryDialog.tsx:161`), portfolio holding → Market Lookup exists (`StocksPage.tsx:84`, `CryptoPage.tsx:53`, `InvestmentDetailDialog.tsx:141`). (2026-07-03) **CommandPalette recents store bare routes — internally consistent** · Electron window title is static and never diverges · sidebar workspaces genuinely separate the two importers (the `/import` vs `/portfolio/import` IA note above is cosmetic only) · ChartBuilder does persist its config (single localStorage slot — the shareability gap is filed above).

**Wave U4 checked clean (don't re-audit):** all domain mutation hooks carry onError toasts with `error.message` (useTransactions/useAccounts/useCategories/useRecipients/useTags/useSplits/useInvestments/useSavedCharts/useAIChat/useCustomParserConfigs/usePortfolioParserConfigs/RecipientPatternsDialog/MoveHoldingDialog/CloseAccountDialog/PortfolioTicker/ProviderHealthPage/DbMaintenancePage/TableDataEditorPage/ExchangeRatesPage/PortfolioImportReviewPage) · transactions CRUD fully optimistic with snapshot rollback + delete Undo toast + ⌘Z one-slot undo (`lib/undo.ts`, AppLayout.tsx:60) + broad invalidation fan-out (useTransactions.ts:110-123) · ImportReviewPage overrides use mutateAsync + try/catch + state rollback, commit toast reports imported/duplicates/errors and button is isPending-guarded · TransactionImportCard has phase progress + cancel + complete/error panels; SimpleImportCard/ExportCard toast success/fail and disable while running · refreshPrices reports partial failure (stale-source count) via warning toast with stable id (no stacking), buttons disabled while pending and offline-aware (useOnlineStatus) · backup restore has schema-mismatch/passphrase-specific errors + submitting-disabled dialogs (useRestoreBackup.tsx) · ErrorBoundary per-route keyed (App.tsx:140-143) + shell-level, fallback offers Retry + Reload · API errors normalized into ApiClientError (envelope/legacy/422-field-list/429-retry-after, client.ts:112-184) with requestId correlation · app-settings persist failures toasted via save-error nonce (AppSettingsContext.tsx:84-120) · placeholderData keeps old data on transactions/accounts/categories/recipients/bankAccounts/aiChat plain lists + PerformancePage keepPreviousData · empty states with guidance on StatisticsPage (noData), PortfolioOverview (isEmpty), accounts/networth/performance (title+desc), dashboard recent-transactions (CTA); first run gated by OnboardingWizard (AppLayout.tsx:233) · planned-payments CRUD/execute call sites all catch + toast (PlannedPaymentsPage, LinkTransactionDialog) · RebalancePage compute renders its error inline (:347-348). (2026-07-03) **Reports/ExportDialog feedback is complete** (busy + disabled + success/error toasts, browser download) · OnboardingWizard's async steps are all try/catch→toast with pending-disabled buttons · FxStatusBanner's trigger + staleness-date logic is correct · self-querying dashboard widgets render error text (`BankBalancesWidget:82-95`, `CashFlowForecastChart:343-347`) and the page has an error subtitle (`DashboardPage.tsx:348`) · parser-config create/update/delete all toast (`useCustomParserConfigs.ts`).

**Wave U5 checked clean (don't re-audit):** lucide icon semantics — Trash2=delete (20 files), X=close/clear-chip only, Pencil=edit (8, no `Edit` icon), Plus=create; zero raw `text-gray/bg-white/text-black` classes repo-wide · gain/loss color always routes through `--gain`/`--loss` tokens (`text-gain` 25 files + `.amount-gain` 26 files, tailwind.config.ts:75 + index.css:900 — colorblind toggle covers all) with no sign-conditional `text-success` misuse (only non-money verdict at ResearchAnalystTab:62) · currency formatting centralized (`utils/currency.ts` configured from AppSettings at App.tsx:121; Money/useCurrencyFormatter/useChartCurrencyFormatter all app-locale-aware) · ~35 Intl.NumberFormat/DateTimeFormat call sites verified passing the app locale · datetime formatters (`formatDateTimeStringWithAppSettings`, `formatMonthYearWithAppSettings`, `formatDistanceToNow`) all receive locale at their call sites · JSX hardcoded-string sweeps (bare text, placeholder=, label:/title: props, toast messages) found nothing user-facing outside the tax items above — devtools panels (`components/devtools/*`) are English-only by design (developer surface) · confirm dialogs uniform (18× useConfirmDialog + 2 bespoke AlertDialogs share the same primitives/variants; destructive variant used at all destructive call sites) · search inputs centralized in DataTable/VirtualDataTable (icon + clear + focus styling) · en.json ellipsis style consistent (131× "...", 0× "…") · "Bank Account" naming consistent across forms/import/planned. (2026-07-03) **nl securities terminology (effecten/Effectenrekening) is correct Belgian usage; no rogue "aandeel"** · combobox triggers + MarketOverviewPage names truncate correctly (the RecipientsPage/WatchlistPage/CategoriesPage truncation gaps are filed above) · portfolio sibling pages are uniformly `space-y-6` · onboarding titles + settings descriptions are tonally consistent.

**Wave U6 checked clean (don't re-audit):** viewport meta correct — `width=device-width, initial-scale=1.0`, no `user-scalable=no`/`maximum-scale` so pinch-zoom stays available (`index.html:6`) · mobile sidebar done right — `useIsMobile()` at 768px (`hooks/use-mobile.tsx:3`) swaps to a Sheet drawer (18rem, `ui/sidebar.tsx:146-162`) and `SidebarTrigger` is always in the topbar (`AppLayout.tsx:114`) · Sheet panels `w-3/4 sm:max-w-sm` — viewport-safe (`ui/sheet.tsx:39-41`) · dashboard grids fully breakpointed (`DashboardPage.tsx:306,401,414,426`; BankBalances cards `sm:grid-cols-2 lg:grid-cols-3`) · wide-content overflow handled: `ui/table.tsx` wraps in `overflow-auto`, StocksPage:300/CryptoPage:210 `overflow-x-auto`, CategoryPivotTable `min-w-[800px]` inside ScrollArea WITH `<ScrollBar orientation="horizontal"/>` (:388) · no fixed widths ≥400px outside that contained pivot (grep) · Button default h-10 / `size="icon"` 40px, and the 40px `icon-touch-target` utility is adopted in 21 files incl. transaction-row Info/Delete (always visible → transactions DO have a touch path to details) · NetSummaryCard sparkline scrub is touch-correct (`touchAction: "pan-y"` + pointer events, :132) · charts are visx with pointer-event handlers, so tap shows tooltips (BarChart per-bar `onPointerEnter`, no touch-action lock) · DialogContent width overrides all `max-w-sm…4xl` over `w-full` — no fixed-px dialog widths · DialogFooter stacks buttons column-reverse below `sm` (`ui/dialog.tsx:65`) · sonner toasts default bottom placement (full-width bottom on small screens — thumb-reachable) · `overscroll-behavior-y: none` on body kills the pull-to-refresh seam (`index.css:36`) · no PWA manifest/apple-touch-icon, so iOS safe-area-inset handling is currently N/A. (2026-07-03) **U6 statics confirmed:** portal content widths all ≤300px (widest `CustomChartBuilderModal` `w-[300px]`; comboboxes 260-280px — nothing overflows 375px) · Electron min 800×600 (`main.js:1434-1435,1489-1490`) keeps desktop layout above the 768px breakpoint, with restore-bounds clamping · no text-bearing fixed `h-[Npx]` containers (VirtualDataTable `min-h-[40px]` grows; ChatComposer `max-h` scrolls) · all sampled `whitespace-nowrap` cells sit inside verified `overflow-auto` wrappers · 15 dialogs verified with proper cap+scroll (DashboardSettingsDialog `h-[82vh]`+ScrollArea, ExportDialog `max-h-[90vh]`, TaxProfileDialog is a Sheet with `overflow-y-auto`, PlannedPaymentForm, MergeRecipientsDialog, AddAccountDialog, InvestmentDetailDialog, …).

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

**Code/architecture 2026-07-03 — residue follow-up (backend, A1+A2):** backup/ is a single 89-line `coverage.js` registry (BACKUP_COVERED_TABLES + documented exclusions) with live consumers and no dead files · routes/research.js and ai.js are exemplary/thin (SSE protocol well-documented); no direct repository imports and no inline SQL found in any of the six route files read (importRoutes, portfolioImportRoutes, ai, marketLookup, research, crossWorkspace) · middleware/rateLimiter.js (all 10 limiter singletons consumed, trusted-proxy XFF + fail-safe dev-bypass) and requestMetrics.js (reservoir sampling, capped, single consumer) are clean; config/ is sound (env.js Zod fail-fast single source, config.js deep-frozen, loadDotenv precedence documented, kinesisConfig.js NOT dead — 4 consumers) · forecast method contract is consistent across point/MC methods; research adapters share one normalized shape/error contract; categoryPivot/recipientPivot/tagPivot and recipient vs recipientByYear are genuinely not duplicates; aggregation/cashflowForecast.js has no overlap with the forecast/ engine · reports: all 20 sections are registered in the three registries with no dead sections; puppeteerRenderer has a clean boundary (singleton browser, finally-closed pages); escapeHtml discipline is consistent; themeCss's HSL-pinning posture is deliberate · repositories: rawTransactionRepository is cohesive, aiChatRepository's PG-FK→typed-domain-error seam, accountRepository's WRITABLE allowlist + accountBalanceSql extraction, plannedTransactionRepository/splitRepository atomics are the sanctioned pattern, categoryRepository's enrichCategory is presentational mapping, and small repos (attachment/savedCharts/tag/watchlist/settings/provider*/cashflowForecastAccuracy/importBatch) all conform; no hand-rolled HTTP status codes anywhere in the repository layer; `sanitizeUpdateFields` middleware imports remain the known 2 files (no new violators found) · ADR-067 seams: all 13 seam files are pure re-exports; no service imports routes/ or middleware/; bankAdapters.js is a pure 4-symbol shim; the attachmentService/attachmentRecordService split is genuinely clean; dataImportService cohesion is good · dead-export scan: every export in services/, repositories/, lib/, utils/ besides the ones filed above has ≥1 live src consumer (portfolioMath's live core = toYmd, sanitizeIsolatedValueSpikes, calendarDaysBetween, computeMetrics, computeHeatmap, sanitizeSnapshotSpikes).

**Code/architecture 2026-07-03 — residue follow-up (frontend, A3–A5):** `lib/belgianTax/` is an exemplary pure-logic module (pit.ts = 9 focused pure helpers + one linear orchestrator; constants.ts data-only; zero React/store imports; 1200+ lines of tests) · `aiChatStreamStore` is a deliberate, sound hand-rolled store (documented non-zustand rationale, leak-safe Set+unsubscribe, `useSyncExternalStore`-driven; only the per-token cache-dirtying is filed as a Finding) · lib/ dead-file sweep: 0 dead of 64 (scripted alias+relative+barrel resolver with fixpoint alive-propagation) — lib/research/, lib/tax/, lib/devtools/ are all cohesive and consumed (the sweep did not extend to features/, stores/, or hooks/ — noted under Still-to-research) · the 7-primitive shadcn ui deadlist is CONFIRMED (all lazy loading is route-path-keyed; no barrel, no storybook) · components/ui/sidebar.tsx confirmed stock shadcn (styling-only divergence) · settings sections are 7/7 on the SettingsPrimitives scaffold aside from the two straggler headers already filed elsewhere; statistics chart architecture is correct; admin pages are structurally distinct (no shared scaffold warranted, no polling); research-page table/chart internals differ structurally (no shared scaffold warranted) · prop drilling: DashboardPage is clean (all children 1-level leaves); portfolio-overview's second hop is intra-file and justified by PerformancePage reuse — no bypassed context on either tree · useStatistics has no duplication with lib/api/aggregations (server aggregates, hook reshapes) · watchlist types are clean end-to-end (FE type ↔ route ↔ repository); remaining lib/api/*.ts modules have no further structural twins vs types/ beyond the ones filed; owed summary/detail + AI-chat turn/SSE/conversation transport contracts checked; locale generation is genuinely single-source (scripts/generate-locales.js writes both FE TS and electron JSON); gitleaks live in CI + pre-commit; ADR-105 token values verified.

**ADR re-run verdicts (2026-07-03, promoted from Still-to-research):** ADR-092 (liabilities-as-negative-accounts) vs. ADR-089 (account-typed-model): no contradiction — type-based cash-widget exclusion (infoRepositoryBanks.js:42,56) is exactly ADR-092's prescription; ADR-089 only bars schema branching on type (nuance: the net-worth "liquid" bucket is type≠liability, ignoring `liquidity_class`, so an illiquid pension counts as liquid headline — a naming nuance, not a conflict) · ADR-093 (net-worth/liquid-assets): code matches ADR — netWorth = liquid + liabilities + investments (infoRepositoryNetWorth.js:224-226); bank side Σ over `in_net_worth=true` accounts (:94); liabilities split as a negative-type bucket (:92,:197); investments from snapshots with forward-fill + live-summary overlay on the latest point (:207-244); consistent with ADR-093 incl. its ADR-100 follow-on note · ADR-099/104/105 (sidebar/visual redesign): ADRs match reality — 099 is IA-only (rail styling never specified; the post-ADR flush 2px active-rail at AppSidebar.tsx:65-74 is documented, not drift); 104's three 2026-06-24 addenda match code exactly (`colorblindGainLoss` default `false` at settingsStore.ts:107, UI at AppearanceSection.tsx:205-227); 105 unconditional as stated (tokens.css:58, card.tsx:9), only cosmetic line-citation drift in its text (099's stale "Proposed" status filed separately under Stale docs) · ADR-102 (unified-tax): fully removed functionally — zero remnants in code, i18n keys, openapi, or migrations; ADR-098 correctly bannered "Superseded in part" (two stale file-header comments filed separately under Stale docs) · ADR-103 (per-account holdings flag): default OFF on every surface — `VITE_ENABLE_PER_ACCOUNT_HOLDINGS` is frontend-only by design (ADR-103:52-53), `booleanEnv(false)` at lib/env.ts:65, absent from settings store/UI, .env.example, compose files, and packaging; no Dockerfile pass-through ARG so image builds are hard-OFF.

**Architecture & code design research 2026-07-06**

**Wave W1 checked clean (don't re-audit):** Mount-level resource naming is uniformly plural kebab-case with no camel path segments anywhere (`main.js:310-342`: `/api/planned-transactions`, `/api/saved-charts`, `/api/cross-workspace`, `/api/recipient…/bank-accounts`, `/net-worth/by-account`, `/transfer-suggestions`). PUT-vs-PATCH semantics are sound and consistent: PATCH is used for partial updates on every entity (transactions, recipients, categories, tags, accounts, planned, watchlist, investments, parsers, charts, conversations), PUT only for genuinely idempotent upserts (`routes/settings.js:209,222`, `routes/research.js:258` provider-keys) — no drift found. 404-on-missing via thrown `NotFoundError` (never 200-empty) is universal across all getById/update/delete handlers. 201-on-create is applied at every unconditional-create site (12+ handlers) and 202-for-review-required is used identically by both import pipelines (`routes/importRoutes.js:60,139`, `routes/portfolioImportRoutes.js:155`). `parsePagination` itself is sound (NaN-safe, floor/clamp, per-resource `maxLimit`, `lib/pagination.js:17-33`) and every adopter passes a maxLimit. The free-text `search` filter convention is uniform where it exists — same param name, same 200-char slice — across transactions/recipients/categories/planned (`routes/transactions.js:94`, `routes/recipients.js:41`, `routes/categories.js:21`, `routes/plannedTransactions.js:162`); `q` is reserved for market/research symbol search, a reasonable domain split. `sort_by`/`sort_dir` with an asc/desc whitelist is consistent across the domain listers that sort (`routes/transactions.js:96-97`, `routes/recipients.js:44-45`); the only camel sort params are the admin dbEditor's (covered in the casing finding). SSE plumbing (shared `createSseWriter`, identical headers incl. `X-Accel-Buffering: no`, `progress` events via shared `progressToPercent`, guarded `writer.closed` checks, `writer.end()` termination) is structurally consistent across all three streams. Envelope adoption and netWorth pagination shape were excluded per brief and not re-examined.

**Wave W2 checked clean (don't re-audit):** Money/quantity column types — NUMERIC everywhere for monetary values; the only float usages are non-monetary statistics (`DOUBLE PRECISION` mae/rmse/mape `0012:28-30`, `REAL match_similarity` `0015:87`, `0040:90`) — sound. Business dates are consistently `DATE` and event timestamps consistently `TIMESTAMPTZ` on all core tables; the two naive-TIMESTAMP incidents (0002 feature_flags — since dropped in 0011; 0030 user_settings) were remediated by `0032_user_settings_timestamptz.py`, and no naive TIMESTAMP remains in the active chain. FK ON DELETE policy is coherent, not ad-hoc: CASCADE for owned children (attachments 0004, splits/payments 0019, tags junctions 0031, staging rows 0040), SET NULL for soft references (category refs made explicit in 0048, transfer peer 0044:51, pattern refs 0015), RESTRICT for history-protecting account ownership per ADR-087 (0050:112-120, 0052:76) — each choice justified in the migration docstring. Currency integrity chain is exemplary: backfill → NOT NULL + DEFAULT + `NOT VALID` ISO CHECK (0046) → `VALIDATE CONSTRAINT` (0049:63) → same convention on accounts at birth (0050:102); the 0028 split-amount CHECKs were validated in the same revision (0028:30,38) — no orphaned NOT VALID constraints exist. `0022_updated_at_not_null_defaults.py` systematically fixed nullable `updated_at` across 9 tables with per-table backfill sources. `price_provider` enum values agree exactly with the app list (`priceProviderService.js:43-47`, frontend `types/api.ts:349`); saved-chart type/variant/bucket values are app-validated (`routes/savedCharts.js:12-16`); `user_settings.value` JSONB gets per-key server-side validation for the risky keys (`routes/settings.js:190-207`). JSONB usage overall is confined to caches, audit payloads, tool args, and parser configs — no domain data hides in JSONB, and `custom_parser_configs.config_json`'s per-kind shape is documented (`data-model.md:811`). The 4 live matviews follow one naming convention (`mv_<subject>`, unique index `mv_*_idx`, `materializedViewService.js:14-17,53-118`) and their column contracts are documented in `docs/performance/materialized-views.md:30-90`. Raw bank tables share a consistent skeleton (id, `deduplication_hash` UNIQUE, `created_at` NOT NULL, `raw_csv_line`, NUMERIC(15,2) amounts). Table naming is consistently plural snake_case for entity tables (singular only for audit/infra: watchlist, split_audit, db_editor_audit, provider_health, provider_quota); `*_id`/`*_at` column conventions hold throughout; index naming is 134× `idx_*` with only 2 stray non-legacy outliers (filed above).

**Wave W3 checked clean (don't re-audit):** The **bank-adapter code seam** itself is the repo's best extension story — 2 touchpoints (new `adapters/<bank>.js` + one array entry in adapters/index.js:19), with detection, staging, hashing, dedup, and the UI picker all derived (adapters/index.js:41 `listAdapters` → routes/info/statistics.js:35 → useAdapters.ts:20; shared parsing skeleton in adapters/_shared.js keeps per-adapter files ~90-135 lines of genuinely bank-specific logic) — only its docs/legacy residue is dirty (filed above). The **AI-chat tool seam** is equally good: a tool is one colocated `{name, description, parameters, run}` object (e.g. insights.js:23-58) plus one `TOOLS` entry (tools/index.js:56-87); schemas ship to the LLM via `getToolSchemas()` (:92), the system prompt derives tool names (integrations/ollama/prompts.js:61-63), and the frontend ToolResultCard is fully generic via `meta.renderAs` (ToolResultCard.tsx:96-125) — zero frontend/i18n edits per tool. The **dashboard-widget seam** is clean: page-local `WidgetDefinition[]` (DashboardPage.tsx:42) + `isVisible()` guards, generic WidgetVisibilityDialog and a single backend settings key (useWidgetVisibility.ts:4) — one file plus an i18n label per widget, no cross-file registry. The **i18n seam** (light check) is documented (docs/i18n/, `i18n` skill) and mechanically enforced: `validate-locales` runs in CI (.github/workflows/ci.yml:233) and builds regenerate locales (package.json:17-22). The **research-provider cluster** (distinct from price providers) is well-factored: adapter map (research/providerRegistry.js:32-40), quota limits (quotaGovernor.js:26-30), env-key gating (providerKeys.js:18-24), and capability chains (capabilityMap.js) are four small colocated maps, and the Settings keys UI is fully API-driven (ResearchKeysSection.tsx:55 maps `data.providers`).

**Wave W4 checked clean (don't re-audit):** Suite topology is deliberate and consistent — backend: 159 files / ~2,405 cases in `apps/node-backend/tests/` (flat + `routes/ services/ property/ golden/ setup/` subdirs, zero colocated in `src/`); frontend: 134 files / ~1,839 cases colocated in `__tests__/` dirs next to source; e2e isolated in `apps/frontend/e2e/` — three clearly separated layers with the pyramid weighted correctly at the base (the hole is the integration middle, filed above). The golden + property layer is genuinely well-designed: `tests/golden/INVENTORY.md` is a per-function coverage lock table ("any new calc must append a row before merge") over `src/services/calculations/`, with `runGolden.js` fixtures + `UPDATE_GOLDENS=1` re-baselining and 7 fast-check property suites (`tests/property/`) covering money round-trips, loan schedules, splits invariants, recurrence — money math and dedup hashing are exercised for real, not threshold-padded. The frontend test stack is coherent and single-patterned: RTL + userEvent + shared `src/test/renderWithApp.tsx` (used with `QueryClientProvider` plumbing across 59 files) + MSW at the HTTP boundary with `onUnhandledRequest: "error"` (`src/test-setup.ts:36`), per-test `server.use()` overrides, a chaos layer (`src/test/msw/chaos.ts`), and `src/test/msw/contracts.test.ts` explicitly guarding fixture shapes against the backend contract — plus `src/types/contract-guard.ts`, a smart type-level device making the OpenAPI-generated types load-bearing. The frontend coverage config is honest by design (explicit include + documented ratchet, `vite.config.ts:136-146`). No module-scope `setInterval`/singleton side effects were found in backend `src/services|config` that force test gymnastics; the 34 files using the `vi.mock`-then-`await import()` dance are standard vitest hoisting, not a seam defect. `playwright.config.ts` is sane (CI retries, trace-on-retry, local `webServer` boot, global-setup onboarding flag — known).

**Wave W5 checked clean (don't re-audit):** Backend logger *adoption* is total and disciplined — 0 raw `console.*` in `apps/node-backend/src/` (excluding logger.js itself) vs 286 `logger.*` calls across 69 files, with consistent level semantics including the deliberate warn-for-4xx / error-for-5xx split in `errorHandler.js:102-103`, and the convention is documented (`docs/guides/backend-configuration.md:70-103`); logger.js's direct `process.env` read is a documented bootstrap exception (`env.js:8-9`). Routes' typed-error discipline is excellent: 236 typed throws vs 1 raw `throw new Error` in `src/routes/`, and the errorHandler normalizes non-Error throws and headersSent correctly (`errorHandler.js:90-96`). Frontend env is a genuine registry: `lib/env.ts` mirrors the backend Zod pattern with fail-fast aggregation, and the only stray `import.meta.env` reads outside it are justified (`lib/logger.ts` bootstrap exception documented in env.ts:6-8; `import.meta.env.DEV` guards in App.tsx:73, ErrorBoundary.tsx:29, skin.ts:50); frontend console hygiene is clean (5 sites). `providerKeys.js` reading `process.env` is justified by design (injectable `env` param default, dynamic provider→var map unfit for a static Zod schema, precedence documented in its header). Zero `@ts-ignore`/`@ts-expect-error` in backend src. Locking where it matters exists: FOR UPDATE in splits, both merges, transfer reconciliation, dbEditor, account rename (`accountRepository.js:118`). Timezone/clock: ADR-009 + `src/lib/timezone.js:1-9` state the convention ("no raw `new Date()` + offset arithmetic in calc modules"), APP_TIMEZONE is validated at boot (timezone.js:14-25), and the testing seam is coherently fake-clock-over-DI — 76 `vi.setSystemTime`/fake-timer sites pin the 167 `new Date()` + 66 `Date.now()` direct calls, so no injection seam is needed; this is architectural, not ad-hoc. `dbEditor.js` manual BEGIN/COMMIT/ROLLBACK with READ ONLY reads and xmin optimistic checks is correct. Planned-transaction execute is idempotent by unique index with a shared single-source service (`plannedExecutionService.js:1-13`).

**Wave W6 checked clean (don't re-audit):** aiChat module decomposition — orchestration (`aiChatService.js` runChatTurn/runChatTurnInner, ~180 cohesive lines with persistence + loop + streaming switch), prompt assembly (pure, I/O-free `integrations/ollama/prompts.js`), transport (`integrations/ollama/client.js`), and tool registry (`services/aiChat/tools/index.js`) are cleanly separated with one-directional dependencies; no god function found. The tool-execution pipeline is coherent end-to-end: shared validators (`tools/_validate.js`) throw a stable `ToolValidationError`, the dispatcher never throws and shapes all failures into `{ok:false, error:{code}}` (index.js:125–170), and — notably good — the system prompt documents exactly the error codes the dispatcher produces, forming a written model-facing retry contract (prompts.js:35–38 ↔ index.js VALIDATION_ERROR/UNKNOWN_TOOL/TOOL_ERROR); all 29 tools return the uniform `{ok, data, meta}` envelope with `meta.renderAs` (31 sites verified). Prompt management is a single template constant with one placeholder, not concatenation soup; pure and unit-tested (`tests/prompts.test.js`); English-only and unversioned are explicit v1 decisions (prompts.js:9, 23). The SSE protocol *is* written down — route header (ai.js:16–27), full event table with payload shapes in `docs/api/ai.md` (~183–225), and a typed discriminated union on the frontend (types/aiChat.ts:82–86) — the W6 finding is about single-sourcing, not absence. Message persistence shape is sound (ai_messages role/content/tool_name/tool_args/tool_result/status, camelCase-aliased at the repo boundary, aiChatRepository.js:6–21) with mid-stream conversation deletion mapped to a clean 410 (aiChatService.js:165–182). `toolCache.js`/`_portfolioFetch.js` memoization is a well-documented, promise-sharing seam. Electron: preload.js is a coherent, fully JSDoc'd four-namespace surface (electronUpdater/electronBackup/electronAPI/electronRecovery) with consistent unsubscribe-returning subscription helpers (preload.js:143–168); IPC naming is uniformly `namespace:verb` across all 20 handlers and all 6 main→renderer channels, all request/response via `invoke` (zero `ipcMain.on`); the demo app does **not** fork main.js — one shared file, 4 `__IS_DEMO` branches; the renderer's optional-member typing in electron.ts is a deliberate old-shell compatibility strategy that works.

### 🏗️ DevOps / CI-CD / Packaging

**DevOps research 2026-07-03**

**Wave D1 checked clean (don't re-audit):** All actions in all five workflows are SHA-pinned with version comments, and dependabot's `github-actions` ecosystem keeps them updated (grouped, weekly). Every workflow has top-level `permissions: {}` deny-all with per-job least-privilege opt-ins (`security-events: write` only for SARIF uploads, `packages: write` only for the GHCR push, `contents: write` only for release creation); no `pull_request_target` anywhere; auto-merge's dependabot token-elevation pattern matches GitHub's documented recipe and `github.actor` gating is safe. Every job has `timeout-minutes`; ci/e2e/release have sane concurrency groups (release correctly uses `cancel-in-progress: false`). Bun cache (`~/.bun/install/cache` keyed on `bun.lock`) present in all bun jobs; docker builds in ci/release use `type=gha` layer cache. CI genuinely runs all the quality gates that exist as scripts: frontend+backend lint, frontend `tsc` typecheck, backend JSDoc `tsc --checkJs`, frontend tests+coverage gate, backend vitest+coverage thresholds (85/75/85/88 in `apps/node-backend/vitest.config.js`), frontend prod build, `validate-locales`, OpenAPI-type drift, endpoint-matrix count, compose-volume sync (the v1.0.2 guard), gitleaks, bun audit, pip-audit, Trivy. Backend vitest is unit-level (no PG service container) but real-Postgres coverage exists: `docker-verify` boots the real compose stack (migrations run to head on boot), round-trips `alembic downgrade -1 && upgrade head`, and `test-live-api-contracts` runs MSW fixture schemas against the live backend. Playwright config has CI retries (2) and trace-on-first-retry; e2e report artifact retention 14 days is reasonable. Root `Dockerfile` base images are digest-pinned. Release verifies tag == root `package.json` == electron `package.json` (per packaging rules) and stages sha256 checksums. Draft-PR skip logic evaluates correctly on push events. Deliberate-by-design (per known context, not re-reported): CodeQL JS/TS-only/security-extended/build-mode-none, artifact-quota reds on Build Docker Image, patch/minor-only auto-merge, commitlint enforced only via a local git hook (not CI-required), stryker mutation testing wired into no workflow. (2026-07-03 residue additions:) branch protection is now live-verified — ruleset "Protect main" fully enumerated (deletion/creation/update, linear history, required signatures, PR-required with 0 approvals + all merge methods, `code_quality: errors`, `code_scanning` CodeQL+Trivy, non-FF, required check `CI Complete` strict; bypass = admin `always`; `allow_auto_merge: true`; repo public) — closing the "not codified or verified anywhere" gap named in the Findings above; `vitest-coverage-report-action` (pinned SHA v2.12.0) verdict is benign/no-defect — on push events it skips PR comments and writes only the step summary, and a missing coverage-summary.json calls `setFailed` but the job is already red under `if: always()` from the failed test step (nit: `success() || failure()` would be cleaner than `always()`, which also fires on `cancelled`); fast-uri tree resolves only to the patched `3.1.2` (both ignored GHSAs are moot in-tree — see the Findings verification note).

**Wave D2 checked clean (don't re-audit):** Dockerfile multi-stage layer ordering (manifests-before-`bun install`, sources after — dependency layer not busted by source edits; both stages `--frozen-lockfile`, stage 2 `--production`); non-root runtime end-to-end (`USER bun` + `chown` + compose `user: 1000:1000`, `read_only: true` with explicit tmpfs/volumes, `cap_drop: ALL`, `no-new-privileges`, ports bound to `127.0.0.1`); entrypoint hygiene (`set -e`, `exec bun` so signals reach the app; `main.js:548-549` handles SIGTERM/SIGINT with re-entrancy-guarded drain); DB wait + migration-at-boot design (checkConnection retry loop, skip-at-head cache in `migrate.js` with fingerprint invalidation, legacy-revision normalization); Puppeteer setup (system Chromium, `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD`, `--disable-dev-shm-usage`); postgres 18 volume path `/var/lib/postgresql` (correct for the v18 image layout); app HEALTHCHECK endpoint/params sane (`/health`, start_period 20s); root↔packaged compose volume lists in sync (postgres_data/attachments_data/vision_cache_data — no drift beyond the `name:` finding above); `docker-compose.clean.yml` properly isolates via named `vision_postgres_data_clean`; `.env.example` ships placeholders, no default credentials; `install.sh` overall (bash strict mode, refuses blind curl|bash with checksum/confirm path, Docker daemon wait loop, idempotent re-run). (2026-07-03 residue additions:) `alembic/env.py` + `alembic.ini` — fail-fast `DATABASE_URL`-only construction (no fallback credentials), atomic multi-revision upgrades (whole `upgrade` wrapped in one `context.begin_transaction()`, so a mid-migration failure rolls everything back cleanly and a retry starts from a consistent state), WARNING-level engine logging (no URL/password echo), harmless SQLite `render_as_batch` path; Electron orchestrator failure surfacing confirmed good — boot `pollReady` timeout falls through to a localized `error.html` with Retry, and a post-boot health watchdog emits `backend:lost`/`backend:restored` to the renderer (detection is HTTP `/health`-only, no Docker restart-count reads — see the Findings note); bun-as-PID-1 static verdict clean (`exec bun run <file>` — file-path form runs in-process, no npm-script shell interposed — empirical in-container verification still open, see Still-to-research); GHCR publish (multi-arch amd64+arm64, semver-tagged, Trivy re-scans the pushed image by digest) is solid — the only gap is the packaged app pulling by mutable tag (already filed); `docker:dev` ↔ packaged-app volume sharing via a shared project name is confirmed intentional design (`docker-compose.dev.yml:1-10`, "single source of truth") — the dirname-fragility itself is still a filed finding.

**Wave D3 checked clean (don't re-audit):** release.yml verify job's tag==root==electron package.json version guard (lines 75-90) and compose-volume sync gate at release time; CI migration reversibility check (`ci.yml:559-567`, downgrade -1 → upgrade head); git-hook machinery (`scripts/setup-git-hooks.js` idempotent/CI-safe; `.githooks/commit-msg` commitlint, `.githooks/pre-push` typecheck×2 + endpoint-matrix + locales + backend tests with sane skip/bypass semantics); `scripts/check-endpoint-matrix.js` and `scripts/validate-locales.js` (sound, wired into CI + pre-push); `packaging/release/vision-setup.command` (robust: strict mode, arch detection, Docker wait, graceful pull failure) and `packaging/release/README.md` accuracy vs the embedded compose (`name: vision` project + volume names all match); update-ZIP handling security (mandatory sha256 verify, zipinfo path-traversal check, rsync rollback in the generated installer); `packaging/electron/demo-db/regenerate.sh` design (throwaway DB, wide alembic_version workaround, reload-validate + sanity checks); `electron-builder-demo.json` isolation (separate appId/output/resources-demo); all `bun run`/`node scripts/` targets referenced by workflows exist (no missing scripts); embedded vs root compose volume parity is currently green. (2026-07-03 residue additions:) the "never audited" claim on `packaging/electron/backup/bundle.js` was stale — it was fully reviewed (correctness axis) in Wave 2b; re-audited here for build wiring only and clean (globbed in both builder configs, require path resolves, prod-dep bundling correct); `preload.js` + `assets/error.{html,css,js}` fully wired, CSP-clean, no XSS, localized correctly, `electronRecovery` exposed (`preload.js:175-188`), preload security posture good (contextIsolation/sandbox on); `.githooks/pre-commit` read in full (132 lines) — staged/unstaged split correct, `SKIP_HOOKS`/`ALLOW_BIG_FILES` semantics sound (aside from the two nits filed); `index-stats.js` + `check-precision-drift.js` (the other two `apps/node-backend/scripts/` files) are read-only and clean; `generate-locales.js` determinism + escaping clean; demo `generate.mjs` determinism clean (mulberry32 seeded, no `Math.random`, no real PII, escaping + sequence resets — aside from the `TODAY`/`alembic_version` staleness filed as a Finding); `sync-nl-with-en.js` correctly never overwrites a non-empty NL value (aside from the unsorted/no-prune/raw-throw nits filed); all other `docs/reference/scripts.md` rows verified verbatim-accurate; update-UI mode handling inside Electron itself is clean (the bug is the backend/web-facing `update_mode` gate, filed as a Finding); `electron-builder` demo-vs-real glob consistency clean; release.yml's GHCR job fully verified (multi-arch, semver tags, digest-scanned by Trivy); e2e wiring statically checks out — browser install matches pinned Playwright 1.60.0 (`bun.lock:434`), `PLAYWRIGHT_BASE_URL`/CI env (`e2e.yml:86-88`) matches `playwright.config.ts:3-5` (`webServer` omitted under CI), `global-setup`'s onboarding PUT passes `csrfGuard.js:42` (origin-less clients admitted), stub `.env` byte-identical to `docker-verify`'s, all 6 specs exist (no `.only`, no hardcoded ports), artifact paths correct; coverage reporters/paths verified sane in both workspaces.

**Wave D4 checked clean (don't re-audit):** `.devcontainer/init-firewall.sh` (fail-closed default-deny before flush, proxy-UID-only OUTPUT, 3-invariant verification + sentinel), `squid.conf` (peek/splice SNI allowlist, HTTPS-only, metadata-IP deny, no MITM), `entrypoint.sh` (firewall-before-network ordering, squid supervision + log rotation, graceful SIGTERM, empty-volume Postgres adoption), `perms-fix.sh`, `launcher-common.sh` (staging strips `.credentials.json`/`.oauthAccount`/`.projects`/hooks; token forwarded name-only, never in argv), `bin/claude` (RO `.devcontainer`/`.git` mounts, mandatory verify-pins gate, opt-in autosync, RO memory seed + interactive-only pushback), `bin/doctor`, `bin/verify-pins`, `.devcontainer/.dockerignore`; version parity is GOOD — bun 1.3.14 = CI, PostgreSQL 18 = prod, both SHA-pinned; full dev loop (dev server, backend tests, alembic migrations) works in-container. No generated dirs tracked (`coverage/`, `dist/`, `venv/`, `node_modules/`, `.playwright-mcp/` all 0 tracked files); `.env`/`.env.local`/`.env.production` ignored, `.env.example` placeholder-only; secrets grep over tracked files clean; no `*.sha256`/`.DS_Store`/`__pycache__` tracked; `*.csv` global ignore is a deliberate PII guard (no CSV fixtures exist — adapter tests use inline strings); repo pack 17 MiB / .git 24 MB, largest blobs are the demo SQL + icon.icns (acceptable). (2026-07-03 residue additions:) the upstream `devcontainer-egress/` sync source repo is **LockBox** (`/Users/computer/Code/LockBox`, remote `EraPartner/Lockbox`), vendoring direction LockBox→project with cmp verification — read-only `sync.sh --check` shows all 6 vendored copies + allowlists IN SYNC, zero drift; host sync push-path guards (snapshot-abort, hooks/mcpServers/plugins sanitized on push), `vision-claude.fish`, `guard.mjs` rule compilation + fail-open behavior (all 14 regexes compile; malformed payloads correctly fail open into the normal permission flow), electron `main.js` env handling (0600 modes, no-overwrite key merge, subprocess allowlist) all clean; no `.vscode/` + no `devcontainer.json` is coherent, not a gap — the sandbox runs on apple/container, which VS Code/Codespaces can't attach to (and Codespaces would sidestep the egress lock anyway).

## Refuted — do NOT re-add

Investigated and disproven; kept for transparency.

**Codebase audit 2026-06-30**

- **"'Failed to load' copy shown for legitimately empty data, not just real errors" (`RecipientInsightsPage.tsx:145-151`)** — **REFUTED.** The guard `if (isError || !filteredData)` was claimed to fire on legitimate emptiness, but the backend (`infoRepositoryRecipients.js:161`) always returns a defined object (`{topMerchants: [], monthOverMonth: []}`) even with zero recipients — never `undefined`/`null` — and React Query only returns `data === undefined` when the query is actually in an error state. So `!filteredData` never fires independently of `isError` given the current API shape; a fresh install with zero recipients renders the real (mostly-empty) page, not a false "failed to load." The `!filteredData` check is redundant dead code worth removing for clarity, but it is not causing the user-facing bug originally described.

---

**Performance research 2026-07-02**

- **"Manual transaction edits never reach the MV-refresh scheduler; `scheduleAggregationRefresh` has zero transaction-route callers, so MVs go stale until the next import/restart"** — **REFUTED** by direct grep: `routes/transactions.js` calls `scheduleReconcile()` at 9 sites (lines 225-645), and `transferReconciliationService.js:233-235` chains `reconcileTransfers().finally(() => scheduleRefresh())`. The real situation is the *opposite* problem — every edit triggers a full reconcile + 4-view refresh (filed as the ⏫ infra finding above). The narrower, still-true gap (single-transaction mutations never clear the *Monte Carlo* cashflow cache) was already filed in the 2026-06-30 audit and stands unchanged.

## Stale docs — KB updates (not code bugs)

**Codebase audit 2026-06-30**

- [ ] `docs/reference/code-patterns.md` still warns about old shim duplication (`loanRepaymentService.js`/`recurrenceService.js` vs. their `calculations/` replacements) that was fully removed in the Phase 9 cutover (commit `65d3dac0`) — doc is stale, code is clean. Update the doc. ⬬ 🔎 verified-present 2026-07-11 *(re-confirmed during verification: code is clean, doc is the only thing stale)*
- [ ] `docs/adr/101-db-data-editor.md:45-47` makes a false security claim ("a hostile WHERE clause can therefore neither mutate nor hang the database") — see the SQL-injection finding at the top of this document. Correct the ADR text alongside the code fix. ⏫ *(found during verification)*

**Code/architecture 2026-07-03 (ADR re-run nits)**

- [ ] ADR-099 (sidebar/IA redesign) still lists its status as "Proposed" even though the post-ADR sidebar (flush 2px active-rail, `AppSidebar.tsx:65-74`) has shipped and matches reality — update the status field. ⏬
- [ ] Two stale file-header comments still describe the removed unified-tax feature (ADR-102, confirmed fully removed functionally): `apps/frontend/src/lib/api/crossWorkspace.ts:2-3` and `apps/node-backend/src/services/crossWorkspaceAnalytics.js:4`. ⏬

## Research context & coverage notes

_Scope, method, sub-topic labels, and caveats from the original research passes. Archive — safe to trim once findings are triaged._

### Performance research 2026-07-09 (fresh-ground waves, sequential single agents)

Method: sequential Explore agents (no fan-out, per user's credit constraint), findings written to this file between waves so any later agent can resume mid-pass (see the "Performance research 2026-07-09" resume-point block for the wave plan and where it stopped). Dedupe basis: full title extraction of the ⚡ Performance findings section + Checked-clean §⚡ + Refuted before each wave. **Wave F1 (migration-at-upgrade boot cost)** — first-ever audit of the pending-migration boot path (all prior startup passes measured only the skip-at-head fast path). Static sweep of `alembic/versions/0001-0064`, `alembic/env.py`, `migrate.js`, backend `main.js` pre-listen ordering, and the Electron poll budget. Key structural facts established: the whole pending chain runs as ONE Postgres transaction (`env.py:128`, no `transaction_per_migration`); migrate.js kills alembic at 120s; packaged updates poll with the 60s (not 3-min) budget. 3 findings filed 🔺/⏫ + 3 grouped 🔼; checked-clean and residue recorded in their sections. No live timing — demo DB too small to exercise any of it. **Wave F2 (backend residues)** — closed the four explicitly-open backend residues from prior passes: `transactionExport.js` streamer perf internals, the three "judged small by domain" repository methods (`getOwedSummary`/`attachmentRepository.listByTransaction`/`savedChartsRepository.getAll` — all clean), perf-lens read of `controllers/`/`jobs/`/`startup/`/`integrations/` internals (clean beyond already-filed items), and dbEditor/admin route paging + audit growth. 5 findings filed, all 🔽/⏬ (admin-only or scaling wrinkles) — the backend residue space is essentially clean. **Wave F3 (frontend residues)** — closed the five explicitly-open frontend residues: search-box debounce path (cadence fine; missing abort + min-length gate filed ⏫), `PlannedPaymentForm` keystrokes (clean), `useUpcomingPlannedPayments` snapshot (clean), AI-chat components (ToolResultCard re-reconcile filed 🔼; no markdown-parser-per-token, conversation switching cached), and the Electron vibrancy-tier × glass interaction (double-blur stacking filed 🔽; Wave A residue closed). 4 findings filed. **Wave F4 (adversarial fresh-ground sweep)** — exclusion-map-driven hunt across Dockerfile/update-pull, middleware chain, workspace/cluster/backfill/planned services, shared-utils hot paths, Electron IPC chatter, and unfiled pages. 1 finding (⏬ FIFO/LIFO O(B²) lot tracking); everything else cleared with evidence. Conclusion recorded in the resume-points block: static fresh ground is essentially exhausted — next value is implementation + the live-measurement residues.

### UI/UX review 2026-07-10 (closing the static resume points)

**Method:** sequential single agents (no fan-out), findings written to TODO.md §🎨 UI/UX & Design after each wave with a `Wave Rn` label; performance explicitly out of scope (already covered by the ⚡ passes). Targets = the "Remaining static gaps" resume points left by the 2026-07-03 audits, plus a sweep of frontend surfaces changed after 2026-07-03 (safeHref consumers, PlannedPaymentForm, UpdateNotification).

- **Wave R1 (done):** MarkAsFiledDialog + BulkRecategorize/BulkRecipient/BulkExport field-level audit; raw network-error copy → toast sweep (`lib/api/client.ts` message inventory traced to ~50 `onError` sites). 5 findings filed (2 ⏫: raw error strings verbatim in toasts / 49 `[NL]` stub strings shipping to Dutch users), checked-clean block added. Residue: BulkTagDialog depth; backend requested/skipped counts for bulk ops.
- **Wave R2 (done):** Electron native surfaces (menu language source, context menu, backgroundColor, badge, About panel) + TableDataEditorPage composition. 7 findings filed (2 🔼: native chrome language tracks OS locale not the in-app setting / no editable-field context menu), checked-clean block added. Residue: none new (backgroundColor flash finding carries a confirm-live caveat).
- **Wave R3 (done):** full en/nl side-by-side read of all 22 never-eyeballed namespaces. 12 findings filed (1 ⏫: four outright mistranslations incl. "Openstaande verordeningen" as the Owes page title; 4 🔼: NL-vs-Belgian tax terms, "afhankelijken" calque, bronbelasting flip, splitsen-as-noun), checked-clean block added. Coverage: complete — this closes the last static resume point.
- **Wave R4 (done):** post-2026-07-03 diff sweep (utils/safeHref.ts + its 5 consumers, PlannedPaymentForm default-date change, VirtualDataTable + NetSummaryCard a11y fixes). 2 findings filed (1 🔼: safeHref-rejected links render as dead-but-hoverable anchors, and protocol-relative feed URLs are wrongly rejected), checked-clean block added.

**Status after this pass:** every static UI/UX resume point from the 2026-07-03 audits is now closed. What remains for UI/UX research is exclusively the **eyes-on Demo-app pass** and the **live-device verification** lists above (need a running app / real devices — grep can't judge them).

### DB performance research 2026-07-06 (fresh-ground waves + first live EXPLAIN pass)

**Method:** sequential single agents (no fan-out), findings written to TODO.md §⚡ Performance
(DB items) / §🏛️ Architecture & API (Supabase/ORM assessment) immediately after each wave so
progress survives interruption. Targets ONLY dimensions no prior pass covered. Already covered
elsewhere — do NOT refile: FK-index sweep 0001→0064 (clean, §Checked clean ⚡ 2026-07-02 "DB"),
filterBuilder predicate shapes vs indexes (search OR-chain ⏫, COUNT(*) OVER, COALESCE category
filter, recipient OR, ABS(amount), bank-account ILIKE, sort expressions — all filed), MV refresh
scheduling/debounce/statement_timeout (filed), import-pipeline per-row round trips (filed ×4),
trigram index coverage (clean), pool sizing/withTransaction hygiene (clean), settings routes
(clean), staging-table growth (filed), 6 unindexed FKs on delete paths (filed 🔽),
planned/portfolio single-column indexes (filed ⬇), `agg_recipient_totals` trigger overhead
(filed 🔽), `sync_account_id_from_bank_account` trigger SELECT-first (filed 🔽).

**Live-measurement environment:** demo DB (`visiondemoapp-db-1`, PG 18.4, synthetic data,
~1,051 transactions). CAVEAT: corpus is tiny — EXPLAIN validates plan *shape* (seq scan vs index),
not real-world latency; the user's real DB is larger. `docker start visiondemoapp-db-1`, then
`docker exec visiondemoapp-db-1 psql -U ftm_user -d financial_transactions`.

**Wave status (resume here if interrupted):**
- Wave D1 — Postgres server & container config (postgres image tag/config in both composes +
  demo compose, shared_buffers/work_mem/effective_cache_size defaults, autovacuum posture,
  WAL/fsync settings, container memory limits, pool config vs server max_connections,
  Alpine-vs-debian image implications): ✅ done 2026-07-06 — 7 findings filed in §⚡ (db image
  never re-pulled by updater 🔼; random_page_cost 4.0 on SSD, no idle_in_transaction timeout,
  no shm_size 🔽; unrotated db logs, musl collation image-swap hazard ⬇; 3s pg_isready forever ⏬)
  + checked-clean block in §Checked clean ⚡ (stock defaults assessed against actual data size —
  most genuinely don't matter; pool fresh angles clean; image/volume posture clean)
- Wave D2 — live EXPLAIN + index-usage pass on demo DB (EXPLAIN ANALYZE the filed planner claims:
  search OR-chain, COUNT(*) OVER, category COALESCE, ABS(amount); pg_stat_user_indexes for
  never-used indexes = write amplification; MV REFRESH timings; table/index bloat check;
  missing-stats check): ✅ done 2026-07-06 — all 5 structural planner claims CONFIRMED via
  `enable_seqscan=off` (📏 verdict notes added to each filed item); 3 new findings filed in §⚡
  (24-index write amplification incl. 2 exact duplicates 🔽; never-ANALYZEd small tables 🔽;
  pg_stat_statements not installed 🔽) + checked-clean/measured block in §Checked clean ⚡
- Wave D3 — schema fresh ground (MV *definitions* themselves — the SELECTs behind the 4 MVs;
  NUMERIC/date type choices vs query patterns; partial-index opportunities; trigger
  aggregate-table design vs MV design coherence; index redundancy REMOVED from scope — Wave D2
  covered it catalog-structurally): PLANNED
- Wave D4 — Supabase + ORM switch assessment (local-first Electron architecture vs Supabase
  hosted/self-hosted stack; raw-SQL corpus size vs ORM migration cost/benefit; alembic-in-a-Bun-repo
  status quo; incremental alternatives e.g. typed query builder): PLANNED

### Architecture & code design research 2026-07-06 (fresh-ground waves)

**Scope:** architecture/code-design improvements on dimensions NO prior pass audited. The
2026-07-03 Code/architecture pass (waves A1–A5) + its residue closure already covered:
layering/boundaries, module cohesion/god files, dead code, FE API layer/types/stores/providers,
features-vs-components org, envelope/error-code/shared-utils patterns, circular imports, env
centralization, i18n pipeline, workspace topology — **do NOT re-report anything filed under
§🏛️ Architecture & API with a 2026-07-03 or 2026-06-30 `from:` line, nor anything in
§Checked clean → 🏛️.** Findings are single-pass research, not adversarially verified.

**Method note for the next agent:** run waves SEQUENTIALLY (one subagent at a time, NOT fanned
out — rate-limit conservation). After each wave returns, IMMEDIATELY append its findings to
§Findings → 🏛️ Architecture & API (with `↪ from: Architecture & code design 2026-07-06 · Wave
Wn` lines), its clean list to §Checked clean → 🏛️, its residue to §Still to research → 🏛️,
and tick the wave checkbox here — so progress survives a context/session loss. If a box is
ticked but no findings with that wave's `from:` line exist, the wave was lost mid-write; re-run it.

- [x] **W1 — REST API design consistency**: resource modeling, naming (plural/singular, verb
  actions), pagination/filter/sort param conventions, bulk-op shapes, status-code + query-vs-body
  conventions, SSE endpoint patterns across all route files. Design quality, NOT openapi drift
  (2026-06-30 covered drift) and NOT envelope adoption (A5 covered it). ✅ done 2026-07-06 —
  17 findings filed (worst: 6 DELETE shapes, list-key drift, per-router casing split, bulk
  partial-failure disagreement), clean + residue filed.
- [x] **W2 — DB schema & data-model design**: table/column naming consistency, constraint/CHECK
  discipline, enum-as-text patterns, jsonb usage, timestamps/audit-column consistency, the legacy
  `investments` inheritance debt + side-table pattern as an architecture (not the crash gotcha),
  matview design coherence. NOT migration downgrade fidelity (2026-07-02/05 covered it). ✅ done
  2026-07-06 — 11 findings filed (worst: bank_account↔account_id dual-write has no tracked exit,
  inheritance fork has no documented path out + data-model.md documents the legacy shape as
  canonical, hard data-model.md drift incl. a fictional table), clean + residue filed.
- [x] **W3 — Extensibility seams**: steps/touchpoints to add a bank adapter, price provider,
  report section, AI-chat tool, i18n namespace; registration-pattern consistency; duplicated glue
  per extension; whether docs match the real recipe. ✅ done 2026-07-06 — 6 findings filed
  (worst: bank-adapter + api-endpoint doc recipes actively misdirect; price-provider seam = ~11
  touchpoints; report-section IDs silently dropped on mismatch); adapter/AI-tool/widget seams
  themselves verified clean.
- [x] **W4 — Test architecture & testability**: backend suite organization, DI/mocking seams,
  fixture strategy, unit-vs-integration split, frontend test story, coverage-shape honesty
  (thresholds vs what's actually exercised). NOT CI wiring (DevOps D1 covered it). ✅ done
  2026-07-06 — 9 findings filed (worst: real-DB harness exists but TEST_DATABASE_URL set nowhere
  so it always skips; route tests execute only the last handler, no supertest; backend coverage
  gate counts only reached files); golden/property layer + frontend RTL/MSW stack verified clean.
- [x] **W5 — Cross-cutting concerns architecture**: logging/observability design (levels,
  structure, correlation-id flow), config/feature-flag layering, backend JSDoc `checkJs`
  type-safety architecture (where typing is load-bearing vs decorative), transactionality/
  idempotency boundary discipline (beyond the filed repo-client finding). ✅ done 2026-07-06 —
  7 findings filed (worst: checkJs gate is loose exactly where SQL-row shapes flow (strict:false,
  repos untyped); requestId reaches 3 of ~286 log sites; no 502/504 error classes; toggle layers
  re-accumulated post-ADR-035 with no rule); logger adoption, route error discipline, FE env
  registry, locking coverage, clock convention verified clean.
- [x] **W6 — Under-audited subsystems (design lens)**: `services/aiChat/` internals (tool
  registry, streaming, prompt assembly) + `packaging/electron/main.js` monolith decomposition /
  IPC channel-surface design (naming, validation discipline). ✅ done 2026-07-06 — 10 findings
  filed (worst: main.js 3.5k-line monolith with backup ≈1,050 lines across 3 regions; IPC sender
  validation opt-in 5/20; SSE event contract hand-synced ×3 with wire-rename layer; count-only
  context truncation with no num_ctx); aiChat decomposition + tool pipeline + preload surface
  verified clean. **ALL 6 WAVES COMPLETE — pass finished 2026-07-06.**

### Startup/Electron performance research 2026-07-05 (goal: app feels + starts instant)

**Method:** sequential (not fanned-out) single agents, one wave at a time, findings written to
TODO.md §⚡ Performance **immediately after each wave returns** so progress survives interruption
(rate-limit-safe by design). Targets ONLY ground the 2026-07-05 Performance pass Wave P4
(startup/boot static analysis) and the UI/GPU G-waves did NOT cover — their findings and the
§Checked clean ⚡ blocks were fed to each agent as exclusions. The three named residues this pass
exists to close: (1) live instrumented boot measurement (`VISION_BOOT_TRACE` marks exist in both
shells, never once run), (2) Electron main-process cold-start static sweep (process spawn → splash
visible — everything *before* the already-audited parallel_init), (3) renderer first-paint handoff
+ perceived-instant architecture options (splash→SPA transition, keep-alive/hide-on-close,
login-item prelaunch). Findings are single-pass research, NOT adversarially verified — confirm
citations against current code before fixing.

**Wave status (resume here if interrupted — each wave = one sequential agent):**
- Wave S1 — live instrumented boot measurement on the Vision Demo app (`/Applications/Vision
  Demo.app`, compose project `visiondemoapp`; port = `appPort` in `~/Library/Application
  Support/Vision Demo/settings.json`): ✅ done 2026-07-05 — 5 new findings filed in §⚡ Performance
  (demo db-healthcheck missing `start_interval` = 5.9s of a 6.8s warm boot ⏫; serial 2s-timeout
  Docker-socket probing on daemon wake 🔼; `pre_pull_image` CLI spawn dominates hot boot 🔽;
  splash-visible 337–653ms 🔽; boot-trace double-emit/never-closed marks ⏬) + 2 measured
  re-pricings appended to existing P4 items (MV gate = 33–38ms, recommend closing; backend
  pre-listen import graph = ~490ms untraced, 5× the traced backend boot) + measured-fine block in
  §Checked clean ⚡. Key numbers: demo warm boot 6.8s / hot 0.6–1.1s / backend-in-container 92ms.
  Residue: instrumented boot of the REAL Vision.app on real data (projected ~2–2.5s warm; trace
  always-on, just capture stdout) · SPA-side post-loadURL phases (→ Wave S3 territory) · cold boot
  with image pull · Docker-not-running dialog path
- Wave S2 — Electron main-process cold-start static sweep (fresh ground *before* parallel_init,
  which P4 already verified): ✅ done 2026-07-05 — verdict: main process is TIGHT; 4 findings filed
  in §⚡ Performance (backup `archiver`/`yauzl` chain at module eval ~56ms+ 🔼; missing
  BrowserWindow `backgroundColor` → pre-splash flash 🔽; single-instance lock at END of module
  eval ⏬; asar ships 2128 node_modules files for backup alone + 4 redundant direct deps ⏬) +
  extensive checked-clean block in §Checked clean ⚡ (no updater at boot, packaging tight,
  preload clean, show-immediately correct). Residue: spawn→module-eval window split needs the
  instrumented Electron pass; vibrancy create-cost unmeasured
- Wave S3 — renderer first-paint handoff + perceived-instant architecture options: ✅ done
  2026-07-05 — 8 findings filed in §⚡ Performance (blank "second splash" — empty `#root` between
  navigation and React mount 🔼; locale chunk discovered late → raw-key flash every cold boot 🔼;
  Dutch triple text flash keys→en→nl behind the settings RTT 🔼; hide-on-close option 💡🔼
  RECOMMENDED FIRST — close already keeps backend warm, only the renderer is thrown away;
  keep-services-on-quit toggle 💡🔼; splash status frozen through the dominant phase 🔽;
  dock-reactivate reopen path no splash/no poll 🔽; login-item prelaunch 💡🔽 recommend skipping)
  + checked-clean block in §Checked clean ⚡ (splash color continuity correct; pre-navigating the
  SPA during compose wait assessed and PARKED). Residue: SPA-phase runtime durations
  (magnitude-estimated); RAM cost of hidden renderer / idle containers before the user decides
  the options

**PASS COMPLETE 2026-07-05.** All three waves done; 17 new findings filed + 2 measured
re-pricings of P4 items + 3 measured-fine/checked-clean blocks. The "instant feel" shortlist by
value-for-effort: (1) demo healthcheck `start_interval` ⏫ (one line, −4.8s demo warm boot),
(2) hide-on-close 💡🔼 (reopen ≈ 0ms, user decision), (3) keep-services-on-quit toggle 💡🔼
(next launch 0.6-1.1s, user decision), (4) the three renderer flash fixes 🔼 (inline #root
placeholder + module-scope locale fetch + localStorage language mirror — all visually free),
(5) archiver lazy-require 🔼 (−56ms pre-splash). Remaining residue for a future pass:
instrumented boot of the REAL Vision.app on real data · SPA-side phase durations (devtools/
Playwright pass) · RAM measurements for the keep-alive options · spawn→module-eval window split ·
cold-boot-with-image-pull path.

### Performance research 2026-07-05 (fresh-ground pass)

**Method:** sequential (not fanned-out) single agents, one wave at a time, findings written to
TODO.md §⚡ Performance immediately after each wave returns so progress survives interruption.
Targets ONLY dimensions the 2026-06-30 / 2026-07-02 performance passes and the 2026-07-02 UI/GPU
waves never covered (their findings + checked-clean lists were fed to each agent as exclusions).
Findings are single-pass static analysis, NOT adversarially verified — check citations against
current code before fixing.

**Wave status (resume here if interrupted):**
- Wave P1 — backend search/filter/query paths (transaction text search ILIKE/trigram, filterBuilder
  predicate shapes vs indexes, COUNT paths, sort columns, settings routes): ✅ done 2026-07-05 —
  6 findings filed in §⚡ Performance (search OR-chain ⏫; COUNT(\*) OVER, COALESCE category filter,
  recipient OR-across-tables 🔼; bank-account ILIKE, sort expressions 🔽) + checked-clean block in
  §Checked clean ⚡ Performance (incl. settings routes, first-ever audit — clean)
- Wave P2 — backend in-process memory & cache boundedness (module-level Maps/TTL caches, SSE client
  registries, interval/listener accumulation over weeks-long Electron uptime): ✅ done 2026-07-05 —
  verdict: unusually well-bounded, only 3 minor findings filed (marketLookup quote-cache no sweeper 🔽;
  ECB full-history cache retained for process life ⬇; quotaGovernor dayMirror never pruned ⏬) +
  extensive checked-clean block in §Checked clean ⚡ Performance (incl. requestMetrics.js internals,
  first-ever read — clean)
- Wave P3 — frontend state/context/i18n runtime (LanguageContext `t()` lookup cost + language-switch
  fan-out, zustand store selector granularity, `lib/aiChatStreamStore.ts` internals (275 lines,
  never read by any pass), remaining contexts' value stability, unvirtualized long lists beyond the
  filed import-review/watchlist ones, form/dialog keystroke re-render hotspots, settings-persistence
  stringify cost): ✅ done 2026-07-05 (retry after a rate-limit kill) — 4 findings filed
  (LanguageBridge unstable `setLanguage` re-renders every useLanguage consumer on any settings
  change 🔼; tax-wizard per-keystroke ×N-year PIT recompute — merged as perf addendum into the
  existing BelgianTaxProfileContext architecture item; InvestmentDetailDialog unvirtualized txn
  list 🔽; ChatConversationList unpaginated ⏬) + checked-clean block in §Checked clean ⚡
  Performance (i18n flat-map lookup clean, zustand useShallow everywhere, aiChatStreamStore
  snapshots reference-stable)
- Wave P4 — startup/boot latency end-to-end (Electron time-to-usable: compose up ordering, health
  poll cadence, splash handoff; backend boot ordering before listen; frontend first-paint sequence):
  ✅ done 2026-07-05 — 5 findings filed (MV-refresh readiness gate serializes every boot 🔼;
  Docker-not-running quits instead of waiting 🔼; dashboard 3-serial-round-trip data chain 🔼;
  StartupRedirect waits on settings despite localStorage target 🔽; yahoo-finance2 static in
  pre-listen graph 🔽) + checked-clean block in §Checked clean ⚡ Performance

**PASS COMPLETE 2026-07-05.** All four waves done; 18 findings filed total (see per-wave notes
above). Remaining residue for a future pass: live runtime profiling (no wave measured anything —
`VISION_BOOT_TRACE` marks exist in both shells and one instrumented boot would turn the P4
estimates into numbers; EXPLAIN on a live DB would confirm the P1 planner claims) · lib/devtools/*
hand-rolled stores (dev-gated, unread) · useUpcomingPlannedPayments dismissed-keys snapshot ·
PlannedPaymentForm keystroke behavior · Docker stdout log rotation (infra) · multer/express.json
buffer limits (request-size/DoS pass territory) · Demo-app boot path.

### UI/GPU performance research 2026-07-05 (runtime + fresh static)

**Method:** sequential single agents (no fan-out, per user instruction), one wave at a time;
findings written to TODO.md **immediately after each wave returns** (into §⚡ Performance /
§🎨 UI/UX & Design with `↪ from:` lines) so progress survives interruption. Targets ONLY ground
the 2026-07-02 UI/GPU Waves A/B/C (+ their residue closure 2026-07-03) and the
2026-06-30 / 2026-07-02 / 2026-07-05 performance passes never covered — each agent gets the prior
findings + checked-clean lists as exclusions. Single-pass research, NOT adversarially verified —
confirm citations against current code before fixing. Design constraint applies: fixes must be
visually free or explicitly labeled look-changing (see ⚠️ Binding constraints at top).

**Wave status (resume here if interrupted):**
- Wave G1 — static fresh ground: compositor/layer hygiene (`will-change` inventory, CSS
  `contain`/`content-visibility` opportunities, layer-promotion pressure), font-loading strategy
  (Fraunces/Inter FOIT/FOUT/preload), passive-listener + scroll/wheel/resize handler sweep,
  layout-thrash sites (getBoundingClientRect/ResizeObserver beyond the filed ones), React 19
  scheduling opportunities (useTransition/useDeferredValue on hot inputs): ✅ done 2026-07-05 —
  4 findings filed in §⚡ Performance (zero-CSS-containment / `content-visibility: auto`
  opportunity 🔼; RecipientCombobox 1000-item double-filter 🔼; font FOUT no-preload 🔽;
  chart-hover per-pointermove GBCR 🔽) + dimension-complete checked-clean block in §Checked clean
  ⚡. Residue → G2/G3: `content-visibility` × visx ParentSize runtime check (demo app) ·
  built dist/index.html modulepreload graph (needs a build) · TagFilter/BankAccountMulti/
  InvestmentCombobox cardinality assumed low, not read · Fraunces weight-synthesis (500/italic)
  unaudited · Electron static-server cache headers for hashed font assets unswept
- Wave G2 — live runtime profiling on the Vision Demo app (the top residue named by every prior
  pass — first measured numbers ever): long-task/frame profiling of Dashboard, Transactions
  scroll, Statistics all-time mount (verify the ~260 motion.rect stagger estimate), aurora frame
  cost, glass-blur paint cost: ✅ done 2026-07-05 — no new defect found; main outcomes were
  *verdicts on prior static claims*, annotated in place: chart mount-stagger ⏫→🔼 (mechanism +
  ~3.9s decade extrapolation confirmed, but 60fps/0 long tasks throughout — settle-latency issue,
  not jank); `content-visibility`×ParentSize experiment PASS (annotated into the G1 finding);
  chart-hover GBCR no measurable cost at demo density (runtime note added). Measurements table
  below; checked-clean/deflation block in §Checked clean ⚡.
- Wave G3 — follow-ups surfaced by G1/G2 (build modulepreload graph, Fraunces weight synthesis,
  remaining combobox cardinality, Electron static-server cache headers for hashed font/asset
  files): ✅ done 2026-07-05 — 3 findings filed (default-route modulepreload gap 🔽 in §⚡ — its
  fix plugin also closes the G1 font-preload half; Inter-700-never-loaded weight-hierarchy
  collapse ×108 sites 🔽 in §🎨; `/index.html` immutable-cached stale-shell edge 🔽 in §🐛) +
  checked-clean block in §Checked clean ⚡ (Fraunces synthesis clean, combobox cardinality clean,
  cache headers otherwise near-optimal, chunk-size table).

**PASS COMPLETE 2026-07-05.** G1 (static fresh ground) + G2 (first-ever runtime profiling, demo
app) + G3 (build/residue) all done; 8 findings filed total (7 new + 1 non-repro record), 2 prior
findings re-verdicted in place (stagger ⏫→🔼 settle-latency; content-visibility caveat → PASS).
Big picture for the next agent: **runtime measurements found NO main-thread jank anywhere on demo
data at DPR 1** — the app's ambient GPU aesthetic is much cheaper than the static findings
implied (Standard tier doesn't even mount WebGL). The remaining value is in: the
`content-visibility: auto` rollout (verified viable), the RecipientCombobox/cmdk double-filter,
stagger clamp, and the small load-path items (modulepreload+font-preload plugin, index.html
cache header). Remaining residue: brotli/precompressed assets (runtime gzip only — noted, not
filed) · fontaine-style metric-override fallback (G1 finding's second half, still open) ·
locale-chunk preload needs a server-side hint (logged, disproportionate — not recommended) ·
Electron-shell instrumented pass (translucency/vibrancy compositing — user previously skipped
eyes-on .app pass by choice) · hover/tooltip cost at real 120-month density + DPR 2 unmeasured ·
per-frame GPU wattage/thermals invisible to the rAF instrument.

**Wave G2 measurement record (Playwright Chromium 1440×900 DPR 1, demo data = 31 months
Jan 24–Jul 26; "jank" = frames >20ms; long tasks ≥50ms via PerformanceObserver). Caveats: main
thread only — backdrop-filter raster + WebGL run on GPU/compositor threads invisible to a rAF
loop; Electron shell (translucency, vibrancy) not exercised; real data is ~4× the month span and
runs at DPR 2 (≈4× raster pixels; >6MP displays already auto-cap to Reduced per ADR-075).**

| Scenario | Result |
|---|---|
| Dashboard idle, Standard tier (CSS aurora) | 300 frames/5s, mean 16.66ms, p95 17.8ms, 0 dropped, 0 long tasks |
| Dashboard idle, all animations paused | identical (mean 16.67ms) — **ambient animation delta ≈ 0** |
| Dashboard idle, Enhanced tier (WebGL ShaderAurora, 360×225 backing = 0.25× res confirmed) | 60fps, 0 long tasks |
| Dashboard load | DCL 48ms, load 50ms, FCP 104ms, 0 long tasks; 1311 DOM nodes; 14 backdrop-filter surfaces |
| Statistics page | 670 DOM nodes, 9 backdrop-filter surfaces, 73 svg rects |
| Transactions page | 1512 DOM nodes, 3 backdrop-filter surfaces |
| Statistics mount stagger | 62 bars (31mo×2 series); attr animation 705→1868ms = **1.16s tail**, 1054 mutations, 0 jank frames, 0 long tasks |
| Transactions scripted scroll (120px/frame×4s while pages loaded) | mean 16.88ms, max 33.4ms, jank 1.3%, 0 long tasks |
| Chart hover sweep ~60Hz×3s | steady-state 60fps, 0 jank; one 216.7ms gap in the very first run did NOT reproduce on fresh-reload retest (no long task, no network — harness/GC artifact, no action) |
| content-visibility experiment | PASS (both post-mount and insert-time application; chart renders on unskip) |

Side effect (restored + verified): demo visual-effects setting was flipped Standard→Enhanced for
the shader measurement and restored to Standard (`<html>` carries no `fx-*` class). Screenshots
under `.playwright-mcp/` (gitignored).

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
