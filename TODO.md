# TODO

Format: Obsidian Tasks plugin emoji. Priority 🔺 highest / ⏫ high / 🔼 medium / 🔽 low / ⏬ lowest. Dates 📅 due / 🛫 start / ⏳ scheduled.

## Codebase audit — June 2026

Full-codebase audit done 2026-06-09 (financial math, date handling, import pipeline, bank
adapters, AI-chat tools, Electron backup). Every item below is **self-contained**: it carries the
offending code, the root cause, the concrete fix, and how to verify — no other files or docs need
to be read first. Verification baseline: `bun run test` (backend vitest, run from repo root or
`apps/node-backend/`) and `bun run lint` must stay green.

**One recurring root cause, referenced by several items below ("pg-DATE class"):** the backend
uses node-postgres with **no custom type parsers** (`apps/node-backend/src/database/connection.js`
creates `new pg.Pool(...)` and never calls `pg.types.setTypeParser`). By default node-postgres
parses Postgres `DATE` (OID 1082) columns into a **JS `Date` at server-local midnight** (verified:
parsing `'2026-06-09'` in TZ Europe/Brussels yields `2026-06-08T22:00:00.000Z`). Any code that
re-serializes such a value with `toISOString()` / `getUTC*()` therefore shifts it **one day back**
whenever the server TZ is east of UTC (the Mac dev host runs Europe/Brussels; the Docker prod
containers run UTC, where the bug is dormant). The app's canonical timezone helpers live in
`apps/node-backend/src/lib/timezone.js`: `toAppDateString(date)` (Date → `YYYY-MM-DD` in
APP_TIMEZONE, default `Europe/Brussels`) and `appDateStringToUtc(str)` (strict `YYYY-MM-DD` parser
that **throws** on anything else). `apps/node-backend/src/utils/portfolioMath.js:24-32` has a
local-getter `toYmd()` that handles pg Dates correctly but is not exported.

### Bugs — high

- [ ] ⏫ Fix LTTB downsampler: first bucket never sampled, last point duplicated 🛫 2026-06-09
  - **File:** `packages/shared-utils/src/downsample.js` (single shared implementation;
    `apps/node-backend/src/utils/downsample.js` and `apps/frontend/src/utils/downsample.ts` are
    re-export shims of `@vision/shared-utils/downsample`).
  - **Offending code** (lines 21–26): inside `for (let i = 0; i < threshold - 2; i++)`:

    ```js
    const bucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, len - 1);
    const nextBucketStart = Math.floor((i + 2) * bucketSize) + 1;
    const nextBucketEnd = Math.min(Math.floor((i + 3) * bucketSize) + 1, len - 1);
    ```

  - **Why wrong:** standard LTTB selects from bucket `[floor(i*b)+1, floor((i+1)*b)+1)` and
    averages the *next* bucket `[floor((i+1)*b)+1, floor((i+2)*b)+1)` as the triangle apex. This
    implementation is shifted one bucket forward, so (a) the points in the first bucket after
    `data[0]` can never be selected — a spike there is silently dropped — and (b) on the last
    iteration `bucketStart` lands on `len-1` with an empty loop range, so `maxAreaIndex`
    (initialized to `bucketStart`) pushes `data[len-1]`, which line 71 (`sampled.push(data[len-1])`)
    then pushes **again** → duplicated final point. Empirically verified:
    `downsampleLTTB(10 points with a 100× spike at index 2, threshold 5)` returns indices
    `0,3,6,9,9` — spike dropped, last point doubled.
  - **Fix:** shift both windows back one bucket: selection `[floor(i*b)+1, min(floor((i+1)*b)+1, len-1))`,
    apex `[floor((i+1)*b)+1, min(floor((i+2)*b)+1, len-1))`. Keep the existing `avgCount === 0`
    fallback (anchor apex on `data[len-1]`) for the tail.
  - **Impact:** backend `/api/info/portfolio-performance` payload (`routes/info/_performanceHelpers.js`
    line 68 calls `downsampleLTTB(..., 400, ...)` — fires for any period with >400 daily snapshots,
    i.e. >13 months) and frontend `apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx:85`.
  - **Verify:** `bun -e "import {downsampleLTTB} from './packages/shared-utils/src/downsample.js'; const d=Array.from({length:10},(_,i)=>({i,v:i===2?100:1})); console.log(downsampleLTTB(d,5,x=>x.i,x=>x.v).map(x=>x.i))"`
    must include `2` and must not end `...,9,9`. Add a unit test asserting no duplicate last point
    and that a first-bucket spike survives; run `bun run test`.

- [ ] ⏫ `GET /api/aggregations/cashflow-forecast` throws 500 whenever any planned transaction exists 🛫 2026-06-09
  - **File:** `apps/node-backend/src/services/calculations/aggregation/cashflowForecast.js` lines 51–53:

    ```js
    function parseDate(isoDateStr) {
      return appDateStringToUtc(String(isoDateStr).slice(0, 10));
    }
    ```

    called with `row.planned_date` from `plannedTransactionRepository.getForForecast()`
    (`apps/node-backend/src/repositories/plannedTransactionRepository.js:559` — selects
    `pt.planned_date` with no `to_char`, and `planned_date` is a `DATE NOT NULL` column).
  - **Why wrong:** pg-DATE class (see preamble): `row.planned_date` is a JS `Date`, so
    `String(date).slice(0,10)` yields e.g. `"Mon Jun 08"`, and `appDateStringToUtc`
    (`lib/timezone.js:104-109`) throws `TypeError: Expected YYYY-MM-DD, got: Mon Jun 08`. This
    happens in **every** timezone (the string form of a Date never matches `YYYY-MM-DD`). The route
    (`routes/aggregations.js:103-107`, mounted unconditionally at `main.js:288` under
    `/api/aggregations`) 500s as soon as one active, unexecuted planned transaction is in the
    horizon. Nothing in the frontend calls this endpoint (only the `-methods`/`-rolling` variants),
    which is why it went unnoticed; there is no direct test.
  - **Fix (pick one):** (a) in `getForForecast`, select
    `to_char(pt.planned_date, 'YYYY-MM-DD') AS planned_date`; or (b) make `parseDate` handle `Date`
    input via local getters (`getFullYear/getMonth/getDate`); or (c) the global type-parser fix
    (design item below) which makes all `DATE` columns arrive as strings.
  - **Verify:** add a test that feeds `computeCashflowForecast` a repo mock returning
    `planned_date: new Date(2026, 5, 15)` (a Date, as pg returns) and asserts it does not throw and
    buckets into `2026-06`. Run `bun run test`.

- [ ] ⏫ `portfolioSummaryService` double-counts buy/sell fees+taxes in `gainLoss` for unit-based assets 🛫 2026-06-09
  - **File:** `apps/node-backend/src/services/portfolio/portfolioSummaryService.js`.
  - **Mechanics:** for `asset_class` in {stock, etf, crypto, metals} (`isUnitBased`, lines 160–173),
    `realizedGain`/`unrealizedGain`/`totalInvested` come from `calculateCostBasis(txns)`
    (`apps/node-backend/src/utils/portfolioMath.js:101-154`), which **already** folds the per-row
    `fees`/`taxes` columns in: buys add them to cost (`amount.plus(fees).plus(taxes)`, line 118) and
    sells subtract them from proceeds (`amount.minus(fees).minus(taxes)`, line 128). Empirically
    verified: `calculateCostBasis([{type:'buy',units:1,amount:100,fees:10,...}])` → `totalCost: 110`;
    a sell with `fees: 5` nets the 5 out of `realizedGain`.
  - **Offending code** (lines 146–147 and 200–202):

    ```js
    const totalFees = feeTxnAmount.plus(feesFieldAmount);   // feesFieldAmount = Σ fees column over ALL rows
    const totalTaxes = taxTxnAmount.plus(taxesFieldAmount);
    ...
    const gainLoss = totalGain.plus(totalIncome).minus(totalFees).minus(totalTaxes);
    ```

    For unit-based assets the `feesFieldAmount`/`taxesFieldAmount` parts are already inside
    `totalGain` → subtracted **twice**. Example: buy `amount=100, fees=10`, price now 150 →
    economic gain +40 (paid 110, worth 150) but reported `gainLoss = 40 − 10 = 30`.
  - **Fix:** in the unit-based branch, compute
    `gainLoss = totalGain + totalIncome − feeTxnAmount − taxTxnAmount` (only standalone `fee`/`tax`
    *transaction types*, which are not part of cost basis). Leave fixed-income/real-estate/other
    branches on the current formula (their `totalInvested` does NOT include the fees/taxes columns).
  - **Impact:** `/api/info/portfolio-summary` (dashboard + performance headline cards) and
    `breakdownSummary` understate gains for anyone recording fees/taxes on buy/sell rows.
  - **Verify:** extend `apps/node-backend/tests/portfolioSummaryService.test.js` (its fixtures
    currently always use `fees: 0, taxes: 0` — that's why this survived): buy 100/fee 10/price 150
    must yield `gainLoss === 40`. Run `bun run test`.

- [ ] ⏫ `portfolioSummaryService` double-counts rent AND fees/taxes for real-estate `gainLoss` 🛫 2026-06-09
  - **File:** `apps/node-backend/src/services/portfolio/portfolioSummaryService.js` lines 186–192 + 200–202:

    ```js
    } else if (isRealEstate) {
      ...
      realizedGain = totalRent.minus(totalFees).minus(totalTaxes);   // line 192
    }
    const totalIncome = totalDividends.plus(totalInterestPaid).plus(totalRent);  // rent again
    const totalGain = realizedGain.plus(unrealizedGain);
    const gainLoss = totalGain.plus(totalIncome).minus(totalFees).minus(totalTaxes);  // fees/taxes again
    ```

  - **Why wrong:** expands to `gainLoss = appreciation + 2·rent − 2·fees − 2·taxes`. Example: rent
    12 000, fees 2 000, taxes 1 000, appreciation 10 000 → reported 28 000; economic gain 19 000
    (overstated by exactly `realizedGain`).
  - **Fix:** set `realizedGain = toDecimal(0)` in the real-estate branch (rent is income, not a
    realized gain; sale gains are not lot-tracked here) and let the shared line 202 handle
    income/fees/taxes once. If "realizedGain" should still display rent-net-of-costs in the UI,
    expose it as a separate field rather than feeding it into `gainLoss`.
  - **Verify:** add a real-estate test case with the numbers above asserting `gainLoss === 19000`.
    Run `bun run test`.

- [ ] ⏫ Import commit persists `tx_date` one day early when server TZ ≠ UTC 🛫 2026-06-09
  - **File:** `apps/node-backend/src/services/importPipeline/commit.js` lines 74–76:

    ```js
    const dateStr = row.tx_date instanceof Date
      ? row.tx_date.toISOString().slice(0, 10)
      : String(row.tx_date).slice(0, 10);
    ```

    `row.tx_date` comes from the SELECT at lines 22–45 (`isr.tx_date` from `import_staging_rows`,
    a `DATE` column, no `to_char`) → pg-DATE class: a local-midnight `Date`; `toISOString()` in a
    UTC+ timezone yields the **previous day**. `dateStr` is then used both for the field-based
    duplicate check (line 99, `t.date = $1`) and the INSERT into `transactions` (line 154) — i.e.
    **wrong dates are persisted**. Dormant in Docker (UTC); active under `bun run dev` on the
    Brussels-TZ host.
  - **Fix (simplest, local):** change the SELECT to
    `to_char(isr.tx_date, 'YYYY-MM-DD') AS tx_date` so the string branch always runs. Alternatively
    replace the `Date` branch with local getters, or rely on the global type-parser fix.
  - **Verify:** test that stages a row, runs `commitBatch` with the repo layer returning
    `tx_date: new Date(2026, 5, 15)`, and asserts the inserted `date` param is `'2026-06-15'`
    (with `process.env.TZ='Europe/Brussels'` in the test). Run `bun run test`.

- [ ] ⏫ Custom CSV parser: choosing `DD-MM-YYYY` silently imports zero rows 🛫 2026-06-09
  - **Files:** `apps/node-backend/src/services/importPipeline/adapters/generic.js` lines 12–22:

    ```js
    function parseDate(dateStr, fmt) {
      if (fmt.includes('%d/%m/%Y') || fmt === '%d/%m/%Y') { ... Date.UTC(y, m - 1, d) ... }
      if (fmt.includes('%m/%d/%Y') || fmt === '%m/%d/%Y') { ... Date.UTC(y, m - 1, d) ... }
      return new Date(dateStr);   // everything else falls through to engine parsing
    }
    ```

    versus the UI options in `apps/frontend/src/features/imports/TransactionImportCard.tsx:359-363`,
    which offer **five** formats: `%Y-%m-%d`, `%d/%m/%Y`, `%m/%d/%Y`, `%d-%m-%Y`,
    `%Y-%m-%d %H:%M:%S`.
  - **Why wrong:** `%d-%m-%Y` → `new Date("31-12-2024")` → Invalid Date → `rowToTransaction`
    (generic.js, ~line 37) returns `null` → **every row is skipped**; the import "succeeds" with 0
    transactions and no error. `%Y-%m-%d %H:%M:%S` → `new Date("2024-12-31 00:30:00")` parses in
    **local** time; `stage.js:78-79` then serializes with `toISOString()`, so early-morning
    timestamps shift a day back in UTC+ zones. (`%Y-%m-%d` is safe — date-only ISO strings parse as
    UTC per spec.)
  - **Fix:** implement `%d-%m-%Y` (split on `-`, `Date.UTC(y, m-1, d)`) and
    `%Y-%m-%d( %H:%M:%S)?` (parse the date part only, `Date.UTC`). For any *unrecognized*
    `date_format`, throw (HTTP 400) instead of falling back to `new Date()`. Also make the parse
    report a skipped-row count so an all-rows-skipped import is visible (see the low-priority
    adapter item).
  - **Verify:** unit test `parseWithConfig` with `date_format: '%d-%m-%Y'` on a 2-row CSV asserts
    2 transactions with correct dates. Run `bun run test`.

- [ ] ⏫ Wise adapter books cross-currency OUT transfers on the recipient's side 🛫 2026-06-09
  - **File:** `apps/node-backend/src/services/importPipeline/adapters/wise.js` lines 50–59:

    ```js
    const targetAmountStr = (row['Target amount (after fees)'] || '').trim();
    const sourceAmountStr = (row['Source amount (after fees)'] || '').trim();
    const amountStr = targetAmountStr || sourceAmountStr;     // always prefers TARGET
    ...
    const currency = targetCurrency || sourceCurrency || 'USD';
    ```

    and line 73: `bankAccount: 'WISE ' + currency`.
  - **Why wrong:** for an outgoing (`Direction === 'OUT'`) cross-currency transfer — you send
    100 EUR, recipient gets 108 USD — the transaction is recorded as **−108 on account "WISE USD"**
    instead of **−100 on "WISE EUR"**. The amount/currency describe the *recipient's* side, so
    per-account balances and EUR-converted spend are wrong. (For `IN`, target is your side and the
    current code is correct; same-currency transfers are unaffected.)
  - **Fix:** make the choice direction-aware: `OUT` → prefer `source` amount/currency (negated via
    the existing `resolveAmount`), `IN` → prefer `target`; keep the other side as fallback when the
    preferred one is blank. Update `bankAccount` accordingly. Keep the existing comment line that
    records the conversion (`100 EUR → 108 USD`).
  - **Verify:** unit test with an OUT row (`Source 100 EUR`, `Target 108 USD`) asserting
    `amount === -100`, `currency === 'EUR'`, `bankAccount === 'WISE EUR'`. Run `bun run test`.

### Bugs — medium

- [ ] 🔼 Design fix for the whole pg-DATE class: return `DATE` columns as strings 🛫 2026-06-09
  - **File:** `apps/node-backend/src/database/connection.js` (top, right after `import pg from 'pg';`).
  - **Fix:** add `pg.types.setTypeParser(1082, (v) => v);` so Postgres `DATE` columns arrive as
    `'YYYY-MM-DD'` strings everywhere, eliminating the entire bug class (forecast crash, heatmap
    skew, execute-advance skew, import-commit shift, AI-chat month bucketing — all listed in this
    file). Most code already handles the string form (`typeof x === 'string'` branches and
    `String(x).slice(0,10)` paths become the live path; `instanceof Date` branches go dead but
    harmless).
  - **Required sweep before merging:** grep the backend for `instanceof Date`, `toISOString`,
    `getUTCFullYear|getUTCMonth|getUTCDate`, `getFullYear|getMonth|getDate` on values read from the
    DB and confirm each site accepts the string form. Known sites: `utils/portfolioMath.js`
    (`toYmd`, `computeHeatmap`), `routes/info/_performanceHelpers.js:57`,
    `services/importPipeline/commit.js:74`, `services/aiChat/tools/expenses.js:309,508`,
    `services/portfolio/snapshotBuilder.js:50`, `routes/plannedTransactions.js:281`. Also note API
    responses that currently serialize raw Dates (e.g. `formatPlannedTransaction` passes
    `row.planned_date` through) will change from `"2026-06-08T22:00:00.000Z"` to `"2026-06-15"` —
    that is the *desired* contract but check the frontend accepts plain dates (it does for fields it
    `slice(0,10)`s).
  - **Verify:** full `bun run test` + `bun run lint` + manual smoke of transactions list, planned
    payments, portfolio performance, imports.

- [ ] 🔼 `computeHeatmap` mis-buckets snapshots into the wrong month when server TZ ≠ UTC 🛫 2026-06-09
  - **File:** `apps/node-backend/src/utils/portfolioMath.js` lines 460–465:

    ```js
    const withDate = snapshots.map((s) => ({
      snap: s,
      dateStr: typeof s.snapshot_date === 'string'
        ? s.snapshot_date
        : s.snapshot_date.toISOString().slice(0, 10),   // ← UTC; wrong for pg local-midnight Dates
    }));
    ```

    Input rows come from `portfolioPerformanceSnapshotService.getSnapshots()` which selects
    `snapshot_date` (a `DATE` column) raw → pg-DATE class. The same file already contains the
    correct helper `toYmd()` (lines 24–32, local getters, with a comment explaining exactly this
    pitfall) — `computeHeatmap` just doesn't use it.
  - **Effect:** with daily snapshots every date shifts one day back in UTC+ zones, so the "last
    snapshot of month M" used for the monthly-returns heatmap is actually the row from the **1st of
    month M+1**.
  - **Fix:** replace the ternary with `dateStr: toYmd(s.snapshot_date)`. Apply the same one-line fix
    to `routes/info/_performanceHelpers.js:57` (`filterSnapshotsByPeriod`, identical ternary —
    export `toYmd` from portfolioMath or inline the local-getter version) and to
    `services/portfolio/snapshotBuilder.js:50-52` (`firstDataDate` normalization — harmless today,
    same anti-pattern). Superseded by the global type-parser item if that lands first.
  - **Verify:** test `computeHeatmap` with `snapshot_date: new Date(2026, 5, 1)` rows under
    `TZ=Europe/Brussels` asserting the row buckets into `2026-06`, not `2026-05`. Run `bun run test`.

- [ ] 🔼 Recurring `/execute` advances `planned_date` with `toISOString()` (day-shift) + month-end anchor drift 🛫 2026-06-09
  - **File:** `apps/node-backend/src/routes/plannedTransactions.js` lines 280–287:

    ```js
    if (existing.is_recurring && existing.recurrence_pattern) {
      const baseDate = new Date(existing.planned_date);
      const nextDate = calculateNextDate(baseDate, existing.recurrence_pattern);
      if (nextDate) {
        updateFields.planned_date = nextDate.toISOString().split('T')[0];   // ← UTC serialization
        updateFields.is_executed = false;
      }
    }
    ```

  - **Bug 1 (TZ):** `calculateNextDate` (`services/calculations/recurrence.js`) computes the next
    occurrence as a UTC `Date` representing start-of-day **in APP_TIMEZONE** (Europe/Brussels).
    Serializing that with `toISOString()` takes the UTC calendar day, which in a UTC+ zone is one
    day earlier — combined with `existing.planned_date` being a pg local-midnight Date, executing a
    monthly payment on the host (TZ Brussels) moves it one day earlier per cycle. **Fix:**
    `updateFields.planned_date = toAppDateString(nextDate);` — import `toAppDateString` from
    `../lib/timezone.js` (already used elsewhere in the codebase for exactly this).
  - **Bug 2 (design, TZ-independent):** the advance chains from the *previous clamped* date, so a
    monthly recurrence anchored on the 31st becomes the 28th after February **permanently**
    (Jan 31 → Feb 28 → Mar 28 → …). `calculateNextDate`'s month-add clamps to the last day of the
    target month but has no memory of the original day. **Decide:** either store an anchor
    day-of-month (e.g. derive `day = max(day-of(planned_date at creation))` and recompute each
    advance from the anchor, like `loanSchedule.js#addMonthsAtDay` does with `preferredDay`), or
    document "sticky clamp" as intended behavior in the planned-transactions feature doc.
  - **Verify:** test executing a monthly planned tx dated `2026-01-31` twice under
    `TZ=Europe/Brussels`: after fix 1 the dates must be `2026-02-28` then (per the fix-2 decision)
    `2026-03-31` (anchored) or `2026-03-28` (documented sticky). Run `bun run test`.

- [ ] 🔼 `recurrence_pattern` accepted unvalidated → recurring item that never advances 🛫 2026-06-09
  - **Files:** `apps/node-backend/src/routes/plannedTransactions.js` — POST handler (~line 176) and
    PATCH handler accept any string for `recurrence_pattern` (the only handling is a default:
    lines 112–113 set `'monthly'` when undefined).
    `apps/node-backend/src/services/calculations/recurrence.js` defines the actual grammar:
    `SUPPORTED_PATTERNS = ['daily','weekly','biweekly','monthly','quarterly','yearly']` plus
    `/^every\s+(\d+)\s+days?$/` with N ≥ 1 (see `calculateNextDate`, lines 54–75). The exported
    `isValidPattern` (lines 77–80) checks only `SUPPORTED_PATTERNS` — it rejects `every N days`
    which `calculateNextDate` supports — and **no caller uses it**.
  - **Consequence:** a typo like `"fortnightly"` stores fine; on `/execute`,
    `calculateNextDate` returns `null`, the `if (nextDate)` block is skipped, and the row keeps its
    old `planned_date` with `is_executed: false` — it shows as due forever and can be executed
    repeatedly.
  - **Fix:** extend `isValidPattern` to also accept `every N days` (N ≥ 1), then in POST/PATCH:
    `if (data.is_recurring && data.recurrence_pattern && !isValidPattern(data.recurrence_pattern)) throw new ValidationError(...)`.
  - **Verify:** route test: POST with `recurrence_pattern: 'fortnightly'` → 400; with
    `'every 10 days'` → 201. Run `bun run test`.

- [ ] 🔼 AI-chat portfolio tools ignore stock splits → holdings/market value wrong by the split ratio 🛫 2026-06-09
  - **File:** `apps/node-backend/src/services/aiChat/tools/portfolio.js` lines 36–48:

    ```js
    const UNIT_CREDIT_TYPES = new Set(['buy', 'gift']);
    const UNIT_DEBIT_TYPES = new Set(['sell']);
    function computeNetUnits(txns) {
      let net = toDecimal(0);
      for (const t of txns) {
        const units = toDecimal(t.units ?? 0);
        if (UNIT_CREDIT_TYPES.has(t.type)) net = net.plus(units);
        else if (UNIT_DEBIT_TYPES.has(t.type)) net = net.minus(units);
      }
      return net;
    }
    ```

    used at lines 87, 325, 396 (holdings, breakdown, returns tools).
  - **Why wrong:** `portfolio_transactions` rows with `type = 'split'` carry `units` = **new total
    units after the split** (established convention — see
    `utils/portfolioMath.js:134-136` and `services/portfolio/snapshotBuilder.js:368-372`).
    `computeNetUnits` skips them, so after a 2:1 split the chat reports half the real units
    multiplied by the post-split price → roughly half the true market value (reverse splits →
    double). The dashboard/summary paths are unaffected (they use `calculateCostBasis`).
  - **Fix:** in the loop, add: `else if (t.type === 'split' && units.gt(0) && net.gt(0)) net = units;`
    (transactions are already date-ordered by the repository query; if unsure, sort by date first
    like `calculateCostBasis` does).
  - **Verify:** unit test: buy 10 units, split with `units = 20` → `computeNetUnits` returns 20.
    Run `bun run test`.

- [ ] 🔼 AI-chat expense tools bucket transactions into the wrong month when server TZ ≠ UTC 🛫 2026-06-09
  - **File:** `apps/node-backend/src/services/aiChat/tools/expenses.js` lines 308–309 (and the same
    pattern at ~line 508):

    ```js
    const d = row.date instanceof Date ? row.date : new Date(row.date);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    ```

    Rows come from `transactionRepository.getAll` which selects `t.date` (a `DATE` column) raw →
    pg-DATE class: local-midnight `Date`, so `getUTC*()` in a UTC+ zone reports the previous day —
    every transaction dated the **1st of a month** lands in the previous month's bucket.
  - **Fix:** use local getters (`getFullYear()/getMonth()`) for the `instanceof Date` branch — pg
    Dates are local-midnight so local getters recover the stored calendar day. (If the global
    type-parser item lands first, `row.date` becomes a `'YYYY-MM-DD'` string, `new Date(row.date)`
    is UTC midnight, and the existing `getUTC*` is then correct — coordinate with that item; don't
    apply both.)
  - **Verify:** unit test `aggregateByMonthCategory([{date: new Date(2026,5,1), amount: -10}], ...)`
    under `TZ=Europe/Brussels` asserts bucket `2026-06`. Run `bun run test`.

- [ ] 🔼 Loan schedule: first installment can be dated before the loan starts 🛫 2026-06-09
  - **File:** `apps/node-backend/src/services/calculations/loanSchedule.js` line 107 inside the
    installment loop: `const dueDate = addMonthsAtDay(startDate, i - 1, paymentDay);` — for
    installment `i = 1` this is "the payment day **in the start month**". With
    `loan_start_date = 2026-06-20` and `loan_payment_day = 5`, the first due date is
    **2026-06-05**, before the loan exists; the route then sets the planned transaction's
    `planned_date` to it (`routes/plannedTransactions.js` POST loan branch:
    `data.planned_date = generated.first_due_date`). `validateLoanConfig` (same file, lines 36–62)
    does not guard against this.
  - **Fix:** after computing installment 1's date, if `dueDate < startDate` shift the whole schedule
    one month: use `addMonthsAtDay(startDate, i, paymentDay)` for all installments (i.e. base
    offset `i` instead of `i - 1`). Implementation: compute
    `const offset = addMonthsAtDay(startDate, 0, paymentDay) < startDate ? 1 : 0;` once before the
    loop and use `i - 1 + offset`. (`addMonthsAtDay` returns `YYYY-MM-DD` strings — lexicographic
    comparison is safe.)
  - **Context (already correct, don't break):** the annuity formula
    (`P·r / (1 − (1+r)^−n)`), fixed-principal and interest-only branches, final-installment
    rounding absorption, and month-end clamping with original-day anchoring were all verified
    correct.
  - **Verify:** unit test: start `2026-06-20`, payment day 5, 12 months → first due `2026-07-05`;
    start `2026-06-03`, payment day 5 → first due `2026-06-05`. Run `bun run test`.

### Bugs — low / robustness

- [ ] 🔽 Backend Belgian tax table stale: no 2026 entry, missing CGT/Reynders/TACR fields 🛫 2026-06-09
  - **Files:** `apps/node-backend/src/services/reports/belgianTaxTables.js` (the whole file: a
    `TABLES` map with only `2024` and `2025`, each holding just `dividendExemption`,
    `dividendWHTRate`, `tob{bonds,sharesAndOther,accumulatingFunds,distributingFunds}`;
    `LATEST_YEAR = 2025`; `getTaxTable(year)` silently falls back to `TABLES[LATEST_YEAR]`).
    The frontend's `apps/frontend/src/lib/belgianTax/constants.ts` is the richer, current source:
    it has 2024/2025/**2026** entries including `capitalGainsTaxRate: 0.10`,
    `capitalGainsTaxExemptionSingle: 10_000`, `capitalGainsTaxExemptionMarried: 20_000` (lines
    543–550) plus Reynders/TACR fields, and an `isApproximatedTaxYear()` helper. The backend file's
    own header comment says it "must remain in sync" with that file — it isn't.
  - **Consequence:** the PDF tax report for tax year 2026 renders "Taxes and fees for tax year 2026"
    (`services/reports/sections/taxExecutiveSummary.js` uses `data.taxYear`) while silently using
    2025 numbers, and cannot represent the 2026 capital-gains regime at all.
  - **Fix:** copy the 2026 values from `constants.ts` into `belgianTaxTables.js` (add the missing
    field names the report needs), bump `LATEST_YEAR`, and add an `approximated: true` marker when
    `getTaxTable` falls back so report sections can render a "rates approximated from <year>" note.
    Longer-term: generate both tables from one shared source (e.g. a JSON in
    `packages/shared-utils`) so they cannot drift.
  - **Verify:** `bun run test`; render/snapshot the tax report section for year 2026 and check the
    fallback note logic.

- [ ] 🔽 `snapshotBuilder` `lastKnownPrice` mixes transaction currency with investment currency 🛫 2026-06-09
  - **File:** `apps/node-backend/src/services/portfolio/snapshotBuilder.js`. Lines 348 and 365 store
    `lastKnownPrice[tx.investmentId] = tx.amount / tx.units` — a price in the **transaction's**
    currency (`pt.currency`, which `COALESCE`s to the investment currency but can legitimately
    differ). Lines 407–419 consume it as if it were in the **investment's** currency:
    `convertAmount(toDecimal(units).times(price), inv.currency, undefined, day)`.
  - **Consequence:** only wrong when a portfolio transaction is recorded in a different currency
    than its investment (e.g. USD buy of an EUR-listed asset) *and* no price history exists for the
    day — the fallback price is then converted with the wrong source currency.
  - **Fix:** store `{ price: tx.amount / tx.units, currency: tx.currency }` and convert from
    `entry.currency` (not `inv.currency`) when the fallback is used; or convert `tx.amount` into
    `inv.currency` (via the existing `convertAmount(tx.amount, tx.currency, tx.fxRateToEur, day)`)
    before dividing.
  - **Verify:** unit test of `computeDailySnapshots` with a USD transaction on an EUR investment and
    no price history. Run `bun run test`.

- [ ] 🔽 `portfolioSummaryService`: `totalInvested.abs()` masks negative net-invested + inconsistent "invested" definition 🛫 2026-06-09
  - **File:** `apps/node-backend/src/services/portfolio/portfolioSummaryService.js`.
  - **Issue A** (line 213): `const convertedTotalInvested = conv(totalInvested.abs());` — for
    fixed-income/real-estate, `totalInvested = buys − sells` can be legitimately negative (sold
    above contributions); `.abs()` silently flips it positive, misreporting. Use
    `Decimal.max(0, totalInvested)` (clamp like the unit-based path does) or surface the negative.
  - **Issue B** (line 301): `totals.totalInvested` sums per-investment `totalBuyCost`, which
    **includes** the per-txn fees/taxes columns for unit-based assets (`calculateCostBasis` adds
    them to buy cost) but **excludes** them for fixed-income/real-estate (those branches set
    `totalBuyCost = totalBuyOrGiftAmount` from amounts only). Decide one definition ("gross cash
    in, including acquisition costs" is the more defensible) and apply it to all branches;
    document it in the field's JSDoc.
  - **Verify:** extend `apps/node-backend/tests/portfolioSummaryService.test.js` accordingly.

- [ ] 🔽 Dividend-WHT reclaim ignores `married_joint` (CGT exemption two functions down does not) 🛫 2026-06-09
  - **File:** `apps/frontend/src/lib/belgianTax/portfolioTax.ts`, `computeDividendWht`
    (lines 266–299): `const reclaimCap = Decimal.min(grossDividendBase, taxTable.dividendExemption).times(taxTable.dividendWHTRate);`
    uses a single `dividendExemption` regardless of filing status, while `computeCgtEstimate`
    (lines 240–254) doubles its exemption for `filingStatus === 'married_joint'`. The Belgian
    dividend exemption (≈ €859 for IY2025) applies **per taxpayer**, so joint filers can reclaim up
    to 2× — domain-verify this before changing.
  - **Fix:** add a `filingStatus` parameter to `computeDividendWht`; when `married_joint`, use
    `dividendExemption * 2` as the cap base. Update callers (PortfolioTaxPage / tax-overview page)
    and the golden fixtures in `portfolioTax.test.ts`.
  - **Verify:** frontend tests (`bun run --filter vision-frontend test` or the project's frontend
    test script) stay green with updated fixtures.

- [ ] 🔽 Belgian-bank adapters: amounts with dot-thousands (`1.234,56`) parse as NaN → row silently dropped 🛫 2026-06-09
  - **File:** `apps/node-backend/src/services/importPipeline/adapters/_shared.js` lines 55–57:

    ```js
    export function parseCommaDecimal(value) {
      return parseDecimalSafe(String(value).replace(/\s/g, '').replace(',', '.'));
    }
    ```

    `"1.234,56"` → `"1.234.56"` → `Decimal` throws → NaN. Every caller treats NaN as "skip this
    row" with no warning: `belfius.js:65` (amounts) and `belfius.js:22` (`Laatste saldo` —
    display-formatted, most likely to carry thousands dots; failure silently disables the
    running-balance reconstruction), `ing.js:49`, `kbc.js:48` (amount) and `kbc.js:51` (balance).
  - **Fix:** make `parseCommaDecimal` strip dots when a comma is present
    (`.replace(/\./g, '').replace(',', '.')` after the whitespace strip) — or route these callers
    through the already-robust `parseAmountField` (same file, lines 63–98, handles both EU and US
    formats). Note `parseAmountField`'s heuristic treats a lone `"1,234"` as EU decimal `1.234`
    — acceptable for Belgian banks, keep `parseCommaDecimal` semantics for them.
  - **Verify:** unit tests: `parseCommaDecimal('1.234,56') === 1234.56`,
    `parseCommaDecimal('12,5') === 12.5`. Run `bun run test`.

- [ ] 🔽 Wise/SABB adapters parse dates with bare `new Date(string)` (TZ/locale hazards) 🛫 2026-06-09
  - **Wise** — `apps/node-backend/src/services/importPipeline/adapters/wise.js:43-46`:
    `new Date(row['Finished on'])` where Wise exports timestamps like `"2024-12-31 14:23:11"`;
    V8 parses these as **local** time, and `stage.js:78-79` serializes with `toISOString()` → in a
    UTC+ zone, transactions finished between 00:00 and the UTC offset (e.g. before 02:00 CEST)
    import dated one day early. **Fix:** match `/^(\d{4})-(\d{2})-(\d{2})/` and build
    `new Date(Date.UTC(y, m-1, d))`, falling back to `new Date()` only for other shapes.
  - **SABB** — `apps/node-backend/src/services/importPipeline/adapters/sabb.js:13-17`:
    `new Date(row['Transaction date'])` with no format pinned; if SABB exports `DD/MM/YYYY`, V8
    reads it as `MM/DD/YYYY` (silent month/day swap for days ≤ 12, Invalid Date → dropped row for
    days > 12). **Fix:** confirm the real SABB export format from a sample file, then parse it
    explicitly (reuse `parseDayMonthYear` from `_shared.js:39-53` if it is `DD/MM/YYYY`).
  - **Verify:** adapter unit tests with fixture rows; run `bun run test`.

- [ ] 🔽 All bank adapters drop unparseable rows silently — surface a skipped count 🛫 2026-06-09
  - **Files:** every adapter's `parse()` builds `transactions` with `if (tx) transactions.push(tx)`
    and `rowToTransaction/parseLine` returns `null` on any parse failure:
    `adapters/belfius.js`, `bnp.js`, `ing.js`, `kbc.js`, `revolut.js`, `sabb.js`, `vision.js`,
    `wise.js`, `generic.js` (all under `apps/node-backend/src/services/importPipeline/adapters/`).
    A file where 30% of rows fail (encoding glitch, format drift, the `%d-%m-%Y` bug above) imports
    "successfully" with fewer rows and no signal.
  - **Fix:** have each adapter count skipped data rows (rows attempted minus rows returned, ignoring
    headers/blank lines) and return `{ transactions, skipped }` (or attach
    `transactions.skipped = n`); propagate through `services/importPipeline/index.js` / `stage.js`
    into the batch metadata (`import_batches` already has a `rows_error` counter; a
    `rows_skipped_parse` column or reuse of `rows_error` both work) and show it in the import review
    UI. Keep the per-adapter `logger.info` lines but include the skipped count.
  - **Verify:** adapter unit test with one good + one malformed row asserts
    `skipped === 1`; run `bun run test`.

### Performance

- [ ] ⏬ Import commit: ~4 DB round-trips per row — batch per chunk 🛫 2026-06-09
  - **File:** `apps/node-backend/src/services/importPipeline/commit.js` lines 73–195: per staged row
    it runs (1) a field-based duplicate `SELECT` (lines 96–109), (2) `SAVEPOINT`, (3) `INSERT`,
    (4) `UPDATE import_staging_rows`, plus `RELEASE`. A 10 000-row CSV ≈ 40 000+ round trips
    (fine on localhost, slow over a network link).
  - **Fix sketch (preserve semantics):** per 1000-row chunk — one set-based dup check
    (`JOIN transactions ON (date, amount, recipient match, memo)` against a `VALUES`/`unnest` list),
    one multi-row `INSERT ... ON CONFLICT (tx_hash) WHERE tx_hash IS NOT NULL DO NOTHING RETURNING tx_hash`,
    and two `UPDATE ... FROM unnest($1::bigint[])` calls for the staging statuses. Keep the
    intra-batch `committedHashes` dedup and the chunk-level transaction + checkpoint counters
    exactly as they are (they guard crash recovery).
  - **Verify:** existing import pipeline tests must stay green (`bun run test`); compare imported /
    duplicate / error counts on a fixture CSV before vs after.

- [ ] ⏬ Electron backup: `encryptBundle` ignores stream backpressure 🛫 2026-06-09
  - **File:** `packaging/electron/backup/bundle.js` lines 225–234:

    ```js
    input.pipe(cipher);
    cipher.on('data', (chunk) => output.write(chunk));   // ignores write() === false
    cipher.on('end', () => { const tag = cipher.getAuthTag(); output.end(tag); });
    ```

    For a multi-GB bundle (large attachments) the unthrottled writes can balloon memory.
  - **Fix:** `input.pipe(cipher).pipe(output, { end: false });` then on `cipher.on('end')` write the
    auth tag and `output.end(tag)` as today (remove the manual `data` handler). The GCM tag is only
    available after cipher end, which `pipe` with `end: false` accommodates.
  - **Verify:** `packaging/electron` backup round-trip test (`apps/node-backend/tests/backup-roundtrip.test.js`
    or the electron test suite) still passes; spot-check memory with a ~1 GB attachments dir.

### Round 4 — multi-agent fan-out (2026-06-10)

Five finder agents (frontend bugs / backend bugs / formula correctness / performance / design)
each produced findings that were then **adversarially verified one-by-one** by independent agents
that re-read the cited code, re-derived the math, and checked for duplication against this file —
28 of 30 findings survived. Items below carry the verifier's corrections where line numbers or
details were adjusted. Raw verified JSON: see session workflow artifact wf_b5c2ab25-b3e.confirmed.json.

#### Round 4 — Frontend bugs

- [ ] ⏫ Frontend portfolio summaries double-count fees/taxes in gainLoss for unit-based assets and double-count rent+fees+taxes for real estate (frontend mirror of the known backend bug, separate code) 🛫 2026-06-10
  - **File:** `apps/frontend/src/hooks/portfolio/usePortfolioSummaries.ts` lines 76-77, 126, 133-135.
  - **Offending code:**

    ```
    const totalFees = feeTxnAmount.plus(feesFieldAmount);
    const totalTaxes = taxTxnAmount.plus(taxesFieldAmount);
    ...
        realizedGain = totalRent.minus(totalFees).minus(totalTaxes);   // real-estate branch
    ...
    const totalIncome = totalDividends.plus(totalInterestPaid).plus(totalRent);
    const totalGain = realizedGain.plus(unrealizedGain);
    const gainLoss = totalGain.plus(totalIncome).minus(totalFees).minus(totalTaxes);
    ```

  - **Why wrong:** For unit-based assets the branch at lines 90-103 takes realized/unrealized gain from calculateCostBasis (apps/frontend/src/hooks/portfolio/usePortfolioCalculations.ts:39-51), which already folds the per-row fees/taxes columns into cost (buys: amount.plus(fees).plus(taxes)) and proceeds (sells: amount.minus(fees).minus(taxes)). Line 135 then subtracts totalFees/totalTaxes — which include feesFieldAmount/taxesFieldAmount summed over those same rows — a second time. Concrete: buy 1 unit, amount=100, fees=10, current_price=150 → avgCostBasis=110, unrealizedGain=40 (economic gain), but gainLoss = 40 − 10 = 30. Real estate is worse: line 126 sets realizedGain = rent − fees − taxes, then line 133 adds rent again into totalIncome and line 135 subtracts fees/taxes again → gainLoss = appreciation + 2·rent − 2·fees − 2·taxes. With rent 12000, fee-rows 2000, tax-rows 1000, appreciation 10000: reported 28000 vs economic 19000. These values drive gainLoss/gainLossPercent shown on StocksPage (line 157), CryptoPage (line 253), PortfolioOverviewPage (lines 143-147, 392) and totals.totalGainLoss from usePortfolio. TODO.md lists this only for the backend file (services/portfolio/portfolioSummaryService.js) — this frontend copy is a separate implementation that must be fixed in lockstep or the portfolio pages will disagree with the backend-driven dashboard once the backend is fixed.
  - **Fix:** In buildSummary: for the unitBased branch compute gainLoss subtracting only standalone fee/tax transaction types: gainLoss = totalGain.plus(totalIncome).minus(feeTxnAmount).minus(taxTxnAmount). For the realEstate branch set realizedGain = new Decimal(0) (expose rent-net-of-costs as a separate display field if needed) and let line 135 handle income/fees/taxes once. Leave fixedIncome/other branches on the current formula (their totalInvested does not include the fees/taxes columns). Mirror whatever final formula the backend TODO fix adopts.
  - **Verify:** Add a unit test for buildSummary (export it or test via usePortfolioSummaries with renderHook): unit-based investment, txns=[{type:'buy',units:1,amount:100,fees:10,taxes:0,date:'2026-01-01'}], current_price=150 → expect gainLoss===40 (currently 30); real-estate case with rent 12000/fees 2000/taxes 1000/appreciation 10000 → expect gainLoss===19000 (currently 28000). Run: bun run --filter vision-frontend test
  - **Verifier corrections (read these before fixing):** All cited line numbers are exact: usePortfolioSummaries.ts 76-77 (totalFees/totalTaxes), 126 (real-estate realizedGain), 133-135 (totalIncome/totalGain/gainLoss); usePortfolioCalculations.ts 39-51 (fee/tax folding in calculateCostBasis). Consumer line numbers also verified (StocksPage.tsx:157, CryptoPage.tsx:253, PortfolioOverviewPage.tsx:143-147 and 392). Severity high is appropriate. Minor nuance: PortfolioOverviewPage lines 144/392 display totalGain (not gainLoss), but gainLossPercent (derived from gainLoss) is used at 143/147/392, so the impact claim stands.

- [ ] ⏫ Executing a loan installment never advances planned_date — loan shows as due forever and can be executed repeatedly 🛫 2026-06-10
  - **File:** `apps/node-backend/src/routes/plannedTransactions.js` lines 197-198, 276-287.
  - **Offending code:**

    ```
        data.is_recurring = true;
        if (data.recurrence_pattern) delete data.recurrence_pattern;
    ...
      const updateFields = {
        is_executed: !existing.is_recurring,
    ...
      if (existing.is_recurring && existing.recurrence_pattern) {
        const nextDate = calculateNextDate(baseDate, existing.recurrence_pattern);
    ```

  - **Why wrong:** Full chain (verified end-to-end): the frontend loan form (apps/frontend/src/components/planned/PlannedPaymentForm.tsx:89) submits loans with is_recurring:true, and usePlannedPayments.mapToCreateAPI (apps/frontend/src/hooks/usePlannedPayments.ts:135-137) sends the display string recurrence_pattern:'loan(12 months)'. POST /api/planned-transactions deletes that pattern in its loan branch (line 198) and — unlike the PATCH path, whose applyLoanPatchDefaults defaults recurrence_pattern to 'monthly' at lines 111-113 — never sets a replacement, so a freshly created loan is stored with is_recurring=true and recurrence_pattern=NULL. On POST /:id/execute, is_executed = !is_recurring = false and the advance block (line 280) is skipped because recurrence_pattern is null; /execute has no loan_schedule branch and executeAndAdvance (plannedTransactionRepository.js:613) does no loan handling either. Result: create a 12-month loan starting 2026-01-05, link installment 1 via the PlannedPaymentsPage circle button → planned_date stays 2026-01-05, the row remains 'due' forever, the button re-enables, and every cashflow forecast keeps the first installment date. Not in TODO.md (its recurrence item covers invalid *stored* patterns like 'fortnightly'; here the pattern is NULL by the route's own design and the frontend string is silently discarded).
  - **Fix:** In the POST loan branch, replace the delete with data.recurrence_pattern = 'monthly' (loan installments are monthly by construction — generateLoanSchedule uses addMonthsAtDay — and this mirrors applyLoanPatchDefaults lines 111-113). Better long-term: add a loan branch to /execute that sets planned_date to the first loan_schedule entry dated after the executed installment. Also remove the dead 'loan(N months)' assignment in apps/frontend/src/hooks/usePlannedPayments.ts:135-137 (the backend deletes it today, and TODO's planned recurrence_pattern validation would otherwise 400 every loan creation); PlannedPaymentsPage already renders the loan label from loan_term_months (lines 212-217), not the pattern.
  - **Verify:** Backend route test: POST a loan (principal 12000, rate 5, term 12, start 2026-01-05), then POST /:id/execute with a transaction id; GET the row and assert planned_date advanced to the second installment date (currently unchanged) and that linking can't be repeated for the same installment. Run: bun run test
  - **Verifier corrections (read these before fixing):** Cited lines accurate (197-198, 275-287; advance block 280-287). Two fix corrections: (a) the proposed primary fix — set data.recurrence_pattern='monthly' in the POST loan branch — is insufficient alone, because plannedTransactionRepository.create() (lines 322-325) unconditionally nulls recurrence_pattern when is_loan is true; the repository sanitization must be changed too, or the loan_schedule-driven /execute approach taken instead. (b) Minor chain detail: PlannedPaymentForm.tsx deliberately omits recurrence_pattern for loans (comment 'loans drive their own schedule'); it is usePlannedPayments.ts mapToCreateAPI (lines 134-140) that injects the 'loan(N months)' display string into the API payload — net effect as the finding claims. Severity 'high' stands: loan rows are permanently overdue, the execute button never latches, and cashflow forecasts omit all installments after the first.

- [ ] 🔼 Transaction mutations invalidate a dead ['stats'] query key — Dashboard stat cards, Statistics aggregations, and the filtered recent-transactions widget are never invalidated 🛫 2026-06-10
  - **File:** `apps/frontend/src/hooks/useTransactions.ts` lines 43-47, 110-115.
  - **Offending code:**

    ```
    function invalidateTransactionViews(queryClient: ReturnType<typeof useQueryClient>) {
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
        queryClient.invalidateQueries({ queryKey: ['transactions-virtual'] });
        queryClient.invalidateQueries({ queryKey: ['monthlySummary'] });
        queryClient.invalidateQueries({ queryKey: ['stats'] });
    }
    ```

  - **Why wrong:** No useQuery in the codebase uses a key starting with 'stats' (grep confirms the only occurrence is this invalidation), so that line is a no-op. The Dashboard stat cards read ['filteredDashboardStats', ...] (useFilteredDashboardStats.ts:42-47, staleTime 30s, refetchOnWindowFocus:false) and the Statistics page reads ['aggregations', ...] (useStatistics.ts:213-298, staleTime 60s); DashboardPage's filtered recent-transactions widget reads ['dashboardRecentTransactions', ...] (DashboardPage.tsx:111). None are invalidated by any transaction mutation — and the single create/update/delete mutations (lines 43-47, 62-66, 80-84) don't even call invalidateTransactionViews. Concrete: delete a EUR 5,000 transaction on the Transactions page, click to the Dashboard 10 seconds later → 'last month spending', net balance, transaction count and recent transactions still include the deleted row (active queries won't refetch within staleTime without invalidation, and window-focus refetch is disabled for the stat cards); same on Statistics within its 60s window.
  - **Fix:** In invalidateTransactionViews, replace ['stats'] with ['filteredDashboardStats'] and add invalidations for ['aggregations'] and ['dashboardRecentTransactions']; call invalidateTransactionViews from the onSuccess of useCreateTransaction, useUpdateTransaction, useDeleteTransaction and useBulkTagTransactions instead of their hand-rolled three-key lists.
  - **Verify:** Vitest (renderHook with a QueryClient wrapper, apiClient mocked): mutate via useDeleteTransaction and assert queryClient.invalidateQueries was called with each of ['filteredDashboardStats'], ['aggregations'], ['dashboardRecentTransactions'], ['monthlySummary'], ['transactions'], ['transactions-virtual'] (extend hooks/**tests**/useQueryHooks.test.tsx). Run: bun run --filter vision-frontend test
  - **Verifier corrections (read these before fixing):** Minor line-number precision: the hand-rolled onSuccess invalidation blocks are at lines 44-46 (create), 63-65 (update), 81-83 (delete), 99-101 (bulk-tag); invalidateTransactionViews is at 110-115 as cited. One scoping nuance the finding already handles correctly: the recent-transactions gap applies only when exclusions are active (the widget query has enabled: exclusionsApply; the unfiltered path reads useTransactions({limit:50}) via the invalidated ['transactions'] key). Staleness is bounded at 30s (stats/recent) / 60s (aggregations) since refetchOnMount eventually refetches — consistent with the stated medium severity.

- [ ] 🔼 Import commit only invalidates ['import-batches'] — freshly imported transactions don't appear in the transactions list or dashboard until staleTime expires 🛫 2026-06-10
  - **File:** `apps/frontend/src/pages/ImportReviewPage.tsx` lines 115-132.
  - **Offending code:**

    ```
      const commitMutation = useMutation({
        mutationFn: () => apiClient.commitImportBatch(batchId),
        onSuccess: (data) => {
          ...
          queryClient.invalidateQueries({ queryKey: ["import-batches"] });
          navigate("/import");
        },
    ```

  - **Why wrong:** Committing an import batch inserts potentially hundreds of rows into transactions, but the only invalidated key is ['import-batches']. The cached ['transactions'] / ['transactions-virtual'] (staleTime 30s), ['monthlySummary'] (30s), ['aggregations'] (60s) and ['filteredDashboardStats'] (30s) queries stay 'fresh'. Concrete: user commits a 300-row CSV, the success toast says 'imported 300', they click to /transactions within 30s → the list renders the pre-import cache with none of the imported rows and the old total; the Dashboard income/spending cards likewise exclude the import. Looks exactly like a lost import until the user waits or hard-refreshes.
  - **Fix:** Export invalidateTransactionViews from hooks/useTransactions.ts (extended per the previous finding) and call it in commitMutation.onSuccess alongside the existing ['import-batches'] invalidation, so transactions, monthlySummary, aggregations, filteredDashboardStats and dashboardRecentTransactions all refetch after a commit.
  - **Verify:** Component test (msw): render ImportReviewPage with a seeded QueryClient containing a ['transactions-virtual'] cache entry, fire the Approve button, and assert the cached transaction queries are marked invalidated (queryClient.getQueryState(...).isInvalidated). Run: bun run --filter vision-frontend test
  - **Verifier corrections (read these before fixing):** Line numbers are exact (115-132, invalidation at 126). Minor strengthening detail the finding omitted: refetchOnWindowFocus is disabled globally (App.tsx:67), so even tab-refocus does not refetch within staleTime. Fix detail: invalidateTransactionViews must be exported from hooks/useTransactions.ts (currently module-private) and extended with 'aggregations' and 'filteredDashboardStats' keys, which it does not currently include.

- [ ] 🔼 useTransactionListData: in-flight loadMore page from a previous filter/search is appended after the filter changes — requestId is only bumped on sort changes 🛫 2026-06-10
  - **File:** `apps/frontend/src/features/transactions/hooks/useTransactionListData.ts` lines 118-160, 162-172.
  - **Offending code:**

    ```
    // Sort/filter change bumped requestIdRef while we awaited — drop
    // this stale page so it cannot append rows from a prior query.
    if (myRequestId !== requestIdRef.current) return;
    setAllItems(prev => {
        const existingIds = new Set(prev.map((t) => t.id));
        const newItems = (result.items as unknown as RawApiTransaction[]).filter((t) => !existingIds.has(t.id));
        return [...prev, ...newItems];
    });
    ```

  - **Why wrong:** The guard comment claims sort/filter changes bump requestIdRef, but only handleSortChange (line 171) does; the filter inputs (search, showAll, category/recipient/date/type/tags from URL params) reach the hook as props and trigger a new useQuery fetch without bumping requestIdRef. Concrete sequence: with filter category_ids=FOOD the user scrolls, loadMore(offset=100, category=FOOD) goes in flight (myRequestId === requestIdRef.current stays true); the user clears the filter; the new query's initialData effect (lines 109-116) replaces allItems with the unfiltered page 0 and sets offsetRef=50; then the FOOD page resolves, passes the requestId check, and appends 50 FOOD-only rows into the unfiltered list, sets offsetRef=150 (wrong base for the next page → rows between 50 and 150 of the unfiltered cohort are skipped), and overwrites totalItems with the FOOD total. The user sees rows from the cleared filter and a wrong count.
  - **Fix:** Bump the request id whenever the query inputs change, e.g. add in the hook: useEffect(() => { requestIdRef.current += 1; }, [showAll, search, transactionIdFilter, recipientIdFilter, categoryIdFilter, categoryIdsFilter, startDateFilter, endDateFilter, transactionTypeFilter, tagsFilter, pageSize]); (same dependency list as loadMore). The existing myRequestId !== requestIdRef.current check then drops the stale page exactly as it already does for sort changes.
  - **Verify:** Vitest renderHook test with apiClient.getTransactions mocked to a controllable deferred promise: call loadMore (leave pending), rerender the hook with a different search prop, resolve the deferred with old-filter rows, and assert allItems does not contain them and offsetRef-driven state (totalItems) is unchanged. Run: bun run --filter vision-frontend test
  - **Verifier corrections (read these before fixing):** Cited lines are accurate (loadMore 118-160, handleSortChange 162-172; excerpt at 140-147; initialData reset effect 109-116). One nuance to add to the finding: the staleTime 30_000 cache makes the harmful ordering near-deterministic when the user returns to a recently-viewed filter state (cached page 0 resolves synchronously, the stale network page after), so this is more reproducible than a generic network race. Severity medium stands.

#### Round 4 — Backend bugs

- [ ] 🔼 updatePattern validates merged-with-defaults instead of the existing row — blocks case_sensitive-only updates and bypasses the ReDoS guard on pattern-only updates 🛫 2026-06-10
  - **File:** `apps/node-backend/src/services/recipientPatternService.js` lines 348-356.
  - **Offending code:**

    ```
    export async function updatePattern(patternId, updates) {
      if (updates.pattern !== undefined || updates.pattern_kind !== undefined || updates.case_sensitive !== undefined) {
        const validation = validatePattern({
          pattern: updates.pattern ?? '',
          pattern_kind: updates.pattern_kind ?? 'literal_prefix',
          case_sensitive: updates.case_sensitive ?? false,
        });
        if (!validation.valid) throw new Error(validation.error);
    ```

  - **Why wrong:** Validation uses hardcoded fallbacks instead of the row's stored values. (a) PATCH /api/recipients/:id/patterns/:patternId with body {"case_sensitive": true} (toggling only that flag) validates {pattern: ''} -> 'Pattern must not be empty' -> thrown as plain Error -> 500; the toggle is impossible via the API. (b) PATCH {"pattern": "(a+)+$"} on a row whose pattern_kind is 'regex' is validated as 'literal_prefix', so hasRedosRisk() (line 124, only run for kind 'regex') is skipped; the catastrophic-backtracking pattern is stored and later compiled as a real regex by compilePattern() during import matching (applyPatterns, line 176), defeating the ReDoS guard that createPattern enforces. Similarly an invalid regex body like "([A-Z" passes literal_prefix validation, then silently compiles to the never-matching /(?!)/ at import time — a dead pattern with no error.
  - **Fix:** In updatePattern, first SELECT pattern, pattern_kind, case_sensitive FROM recipient_match_patterns WHERE id = $1 (throw NotFoundError when missing), merge: validatePattern({ ...existingRow, ...updates }), and throw ValidationError (from middleware/errorHandler.js) instead of plain Error so the route returns 400 rather than 500. Apply the same ValidationError wrapping in createPattern/previewPatternMatches.
  - **Verify:** Add a route test in apps/node-backend/tests: create a regex pattern 'FOO[0-9]+'; PATCH {case_sensitive:true} must return 200 (currently 500); PATCH {pattern:'(a+)+$'} on that regex row must return 400 (currently 200). Run bun run test.
  - **Verifier corrections (read these before fixing):** Line numbers, file, and proposed fix are accurate as stated. Severity 'medium' is fair but worth one nuance: the shipped frontend (RecipientPatternsDialog.tsx:153-163) always sends pattern+pattern_kind+case_sensitive together on edit, and its is_active toggle skips the validation block, so neither failure is triggered by the built-in UI — both require a direct API call with a partial body. However the frontend's RecipientPatternUpdate type declares all fields optional, confirming partial PATCH is the intended API contract, so the API-level bug stands.

- [ ] 🔼 mergeRecipients leaves nested aliases pointing at a merged alias — alias chains break the one-level read layer and divert future imports 🛫 2026-06-10
  - **File:** `apps/node-backend/src/services/recipientMergeService.js` lines 113-123.
  - **Offending code:**

    ```
    // 5. flag aliases as pointing at the primary. This preserves the
    // historical relationship for the Recipients UI + /:id/aliases.
    const aliasRes = await client.query(
      `UPDATE recipients
          SET primary_recipient_id = $1,
              updated_at = NOW()
        WHERE id = ANY($2::int[])
          AND id <> $1
        RETURNING id`,
      [primaryId, ids],
    );
    ```

  - **Why wrong:** The merge only stamps the alias rows themselves; recipients whose primary_recipient_id points at one of the merged aliases are untouched. Sequence: merge C into B (C.primary_recipient_id = B), later merge B into A. Result: C.primary_recipient_id = B while B.primary_recipient_id = A — a depth-2 chain the entire read layer cannot resolve: getAliases(A) (recipientRepository.js:290) returns only B, so C vanishes from A's alias list; the recipientGroupId filter (filterBuilder.js:131, `t.recipient_id = $p OR r.primary_recipient_id = $p`) resolves one level only. The route guard (routes/recipients.js:104) only checks the *target* isn't an alias, so this state is freely reachable. Concretely worse: the import matcher resolves exact names to the raw recipient id with no primary COALESCE (normalization.js:74-81 `JOIN recipients r ON r.normalized_name = c.norm`), so a post-merge bank import containing C's exact name creates new transactions with recipient_id = C — they display under B's name (an alias) and never appear in A's merged group.
  - **Fix:** In step 5 of mergeRecipients, add a second UPDATE inside the same transaction: `UPDATE recipients SET primary_recipient_id = $1, updated_at = NOW() WHERE primary_recipient_id = ANY($2::int[]) AND id <> $1` to re-point grandchildren onto the new primary (flattening chains to depth 1, which is what every reader assumes).
  - **Verify:** Service test: create recipients A, B, C; mergeRecipients(B,[C]); mergeRecipients(A,[B]); assert C.primary_recipient_id === A.id and recipientRepository.getAliases(A.id) contains both B and C. Run bun run test.
  - **Verifier corrections (read these before fixing):** Line numbers in the finding are accurate as cited: recipientMergeService.js:113-123 (excerpt matches exactly), recipientRepository.js getAliases at 290-301, filterBuilder.js:131, routes/recipients.js:104, normalization.js exact-match CTE at 74-82, plus importPipeline/commit.js:78 (effectiveRecipientId insertion) which strengthens the import-divergence mechanism.

- [ ] 🔼 Transactions list pagination has no unique ORDER BY tiebreaker — same-date rows can be duplicated or skipped across pages 🛫 2026-06-10
  - **File:** `apps/node-backend/src/repositories/transactionRepository.js` lines 417-421, 446.
  - **Offending code:**

    ```
    const sortCol = TRANSACTION_SORT_COLUMNS[sortBy] || 't.date';
    const sortDirection = sortDir === 'asc' ? 'ASC' : 'DESC';
    const orderBy = sortBy && TRANSACTION_SORT_COLUMNS[sortBy]
      ? `${sortCol} ${sortDirection}, t.date DESC`
      : `t.date DESC`;
    ```

  - **Why wrong:** The default order is `t.date DESC` only, and every custom sort's secondary key is also the non-unique t.date — never t.id. Each page (LIMIT/OFFSET, line 446) is a separate query execution, and Postgres gives no ordering guarantee among equal keys between executions. Concrete: a bank CSV import inserts 80 rows all dated 2026-06-01; the user views page 1 (limit 50), edits one row's category (the UPDATE relocates the tuple in the heap, changing scan order among the ties), then opens page 2 — rows seen on page 1 reappear on page 2 and others never appear at all. Same applies to getAll (lines 105-110) and to sort_by=amount/memo ties.
  - **Fix:** Append a unique tiebreaker to every ORDER BY: default `t.date DESC, t.id DESC`; custom sorts `${sortCol} ${dir}, t.date DESC, t.id DESC` — in both getAll and getAllWithCount (and getUncategorisedWithCount's `ORDER BY t.date DESC` at line 287).
  - **Verify:** DB-backed test: insert 60 rows with the same date, fetch limit=20 offset=0/20/40 after UPDATEing one row between fetches, assert the union of ids has no duplicates and covers all 60. Run bun run test.
  - **Verifier corrections (read these before fixing):** Cited lines are accurate (417-421, 446 in getAllWithCount; 105-110/134 in getAll; 287 in getUncategorisedWithCount). One addition: getUncategorised at line 195 has the same date-only ORDER BY with LIMIT/OFFSET and should get the t.id DESC tiebreaker too. Note for getUncategorisedWithCount: the outer ORDER BY at line 294 already includes u.id DESC, but it only orders the already-selected page — the inner CTE at line 287 does the page selection and is where the tiebreaker must be added, as the finding says.

- [ ] 🔽 Saved-charts PATCH cannot clear date_range_start/end — null is coerced to undefined and silently dropped 🛫 2026-06-10
  - **File:** `apps/node-backend/src/routes/savedCharts.js` lines 58-63, 116-117.
  - **Offending code:**

    ```
    function parseDateOrNull(value, fieldName) {
      if (value === undefined || value === null || value === '') return undefined;
      ...
    }
    ...
    dateRangeStart = parseDateOrNull(dateRangeStart, 'dateRangeStart');
    dateRangeEnd = parseDateOrNull(dateRangeEnd, 'dateRangeEnd');
    ```

  - **Why wrong:** The frontend edit flow sends null to clear a chart's date range (CustomChartBuilderModal.tsx:150-151: `dateRangeStart: state.dateRangeStart || null`). parseDateOrNull maps null/'' to undefined, and savedChartsRepository.update (savedChartsRepository.js:46-47) skips undefined fields entirely. Concrete failure: create a chart with date_range_start='2025-01-01'; in the edit modal clear the date field and save; the PATCH returns 200 with the *old* range still set, the refetch repopulates the date input, and the chart keeps filtering to the old window. There is no API way to remove a date range short of deleting the chart.
  - **Fix:** Make parseDateOrNull distinguish 'absent' from 'clear': return undefined only for value === undefined, return null for null/'' (validating non-empty strings as today), and pass null through to the repository (its `dateRangeStart !== undefined` check already writes null correctly). Same for dateRangeEnd.
  - **Verify:** Route test: POST a chart with dateRangeStart, PATCH { dateRangeStart: null }, then GET and assert date_range_start === null. Run bun run test.
  - **Verifier corrections (read these before fixing):** Line numbers in the finding are accurate: routes/savedCharts.js lines 58-63 (parseDateOrNull) and 116-117 (PATCH coercion); repository skip is savedChartsRepository.js lines 46-47; frontend trigger CustomChartBuilderModal.tsx lines 150-151 with edit mutate at line 155. Severity 'low' is appropriate (no data corruption; workaround is delete+recreate the chart). Note for the fix: the POST path (lines 94-95) also uses parseDateOrNull, but create() applies `?? null`, so returning null for null/'' is safe there too.

- [ ] 🔽 Bulk PUT /api/settings bypasses the per-key validation enforced by PUT /api/settings/:key (cost_basis_method allowlist, exclusionScope, excludeHiddenCategories) 🛫 2026-06-10
  - **File:** `apps/node-backend/src/routes/settings.js` lines 158-173.
  - **Offending code:**

    ```
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'dashboard_settings') assertDashboardSettingsValue(value);
      if (key === 'theme_settings') assertThemeSettingsValue(value);
    }
    
    await settingsRepository.setMany(settings);
    ```

  - **Why wrong:** PUT /api/settings/cost_basis_method with value 'bogus' is rejected 400 (lines 148-152 check ALLOWED_COST_BASIS_METHODS), but the exact same data via PUT /api/settings {"cost_basis_method":"bogus"} is persisted — the bulk loop validates only dashboard_settings and theme_settings, and even those without the validateExcludeHiddenCategories/validateExclusionScope options the single-key path passes (lines 142-145), so {"dashboard_settings":{"exclusionScope":"nonsense","excludeHiddenCategories":"yes"}} also persists via bulk while the single-key endpoint rejects it. An invalid cost_basis_method then flows to the frontend cost-basis/CGT calculations, which silently fall back rather than erroring.
  - **Fix:** Extract the per-key validation from the single-key handler into one validateSettingValue(key, value) function (covering dashboard_settings with both option flags, theme_settings, and cost_basis_method) and call it for every entry in the bulk handler before settingsRepository.setMany.
  - **Verify:** Route test: PUT /api/settings with body {"cost_basis_method":"bogus"} must return 400 (currently 200), and {"cost_basis_method":"fifo"} must return 200. Run bun run test.
  - **Verifier corrections (read these before fixing):** Line numbers and code excerpt are accurate (bulk handler is exactly lines 158-173). One claim in why_wrong is overstated: 'an invalid cost_basis_method then flows to the frontend cost-basis/CGT calculations, which silently fall back' — no code actually consumes the cost_basis_method setting key today. Backend calculateCostBasisByMethod (utils/portfolioMath.js:319-323, the silent-fallback dispatcher) has no production callers, the frontend stores costBasisMethod inside app_settings (stores/settingsStore.ts:35,69) and never reads the cost_basis_method key, and saveSettingsBulk (apps/frontend/src/lib/api/settings.ts:18) has no UI callers. So the bypass is reachable only via direct API requests and the persisted invalid value is currently inert — severity 'low' stands, arguably low/lowest. The fix and verify steps are otherwise correct as written.

- [ ] 🔽 Tags-only PATCH on a nonexistent transaction returns 500 (FK violation) instead of 404 — junction insert runs before any existence check 🛫 2026-06-10
  - **File:** `apps/node-backend/src/repositories/transactionRepository.js` lines 491-509.
  - **Offending code:**

    ```
    if (tags !== undefined) {
      const row = await withTransaction(async (client) => {
        if (setClauses.length > 0) {
          ...
          if (!res.rows[0]) return null;
        }
        await setTransactionTags(client, id, tags ?? []);
        const res = await client.query(fetchSql, [id]);
    ```

  - **Why wrong:** When the PATCH body contains only `tags` (no other columns), setClauses is empty, so the UPDATE-based existence check is skipped and setTransactionTags runs first. For a nonexistent transaction id with at least one valid active slug, the INSERT INTO transaction_tags (transactionRepository.js:70-75) hits the transaction_id foreign key -> Postgres error 23503 -> the error is not an AppError, so errorHandler returns 500 'An internal server error occurred'. Concrete: PATCH /api/transactions/99999999 with body {"tags":["food"]} (tag 'food' exists) -> 500, while PATCH {"comment":"x"} on the same id correctly returns 404.
  - **Fix:** In the tags branch, when setClauses.length === 0, run an existence probe first inside the same transaction (`SELECT 1 FROM transactions WHERE id = $1`) and return null when no row, before calling setTransactionTags. (Alternatively always perform the existence check regardless of setClauses.)
  - **Verify:** Route test: ensure a tag slug exists, then PATCH /api/transactions/99999999 {tags:['<slug>']} and assert status 404 with the standard envelope (currently 500). Run bun run test.
  - **Verifier corrections (read these before fixing):** Cited lines 491-509 match the current file exactly; setTransactionTags INSERT is at transactionRepository.js:70-75 as cited. No corrections needed.

- [ ] 🔽 Streamed export paginates with OFFSET across separate pool queries — a concurrent write mid-export silently drops or duplicates rows 🛫 2026-06-10
  - **File:** `apps/node-backend/src/services/transactionExport.js` lines 147-160.
  - **Offending code:**

    ```
    const chunkSql = buildExportChunkSql(whereSql, nextParamIdx, nextParamIdx + 1);
    let chunkOffset = 0;
    ...
    while (true) {
      const chunk = await dbQuery(chunkSql, [...params, EXPORT_CHUNK_SIZE, chunkOffset]);
      if (chunk.rows.length === 0) break;
    ```

  - **Why wrong:** Each 1000-row chunk is an independent query on the pool (READ COMMITTED, new snapshot each time), with plain OFFSET pagination. Concrete: a 2,500-row CSV export streams chunk 1 (rows 1-1000 by date ASC, id ASC); while the client downloads, the user deletes one already-streamed transaction (or an import commit inserts rows dated before the cursor); chunk 2's `OFFSET 1000` now lands one position later/earlier in the shifted result set, so one row is silently missing from (or duplicated in) the exported file with no error — and headers are already sent, so the result still looks like a clean 200. Imports and exports are both user-triggered and routinely overlap.
  - **Fix:** Replace OFFSET pagination with keyset pagination: track the last (date, id) of each chunk and use `WHERE ... AND (t.date, t.id) > ($k, $k+1) ORDER BY t.date ASC, t.id ASC LIMIT 1000` — immune to concurrent inserts/deletes and faster on large tables. (Alternative: hold one pool client and run all chunks inside a single REPEATABLE READ transaction.)
  - **Verify:** Test streamCsvExport with a dbQuery stub of 2,500 fixture rows that removes an early row after the first chunk call; assert the streamed output still contains all remaining 2,499 distinct ids exactly once after the fix. Run bun run test.
  - **Verifier corrections (read these before fixing):** Line numbers 147-160 are exact. Minor scope nuance: for POST /bulk-export the id set is pinned (buildIdListWhere), so the insert/duplicate variant only affects the filter-based GET /export/csv|json endpoints; the delete/skip variant affects all three. The proposed keyset fix is valid since the sort key (t.date, t.id) is unique via t.id; note the tuple comparison params must be appended consistently with the existing nextParamIdx scheme.

#### Round 4 — Formula correctness

- [ ] ⏫ Cashflow planned overlays include executed planned transactions → double counting against actuals 🛫 2026-06-10
  - **File:** `apps/node-backend/src/repositories/infoRepo.forecast.js` lines 80-97.
  - **Offending code:**

    ```
      const sqlPlannedCurrent = `
        SELECT pt.amount, pt.currency, pt.planned_date,
               EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month
        FROM planned_transactions pt
        WHERE pt.is_active = true
          AND pt.planned_date >= date_trunc('month', CURRENT_DATE)
          AND pt.planned_date <= (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')
      `;
    ```

  - **Why wrong:** Executing a non-recurring planned transaction sets is_executed=true but leaves is_active=true and planned_date unchanged (routes/plannedTransactions.js:274-296, executeAndAdvance only updates passed fields). All four planned queries in this file (sqlPlannedCurrent line 80, sqlPlannedHist line 89, and their twins at lines 272-285 in getCashflowForecastData and 390-396 in getCashflowForecastDataRolling) filter only on is_active. Concrete: planned rent −1200 on 2026-06-05, executed on June 5 → the real transaction lands in sqlCurrent actuals AND the planned row still matches sqlPlannedCurrent, so getCashflowComparison's with_planned 'current' line (line 196: current + plannedCum) shows −2400 for that one rent from day 5 onward. sqlPlannedHist likewise double counts every executed past planned tx into avgPlannedCumByDay, inflating the with_planned 'average' overlay. In the forecast pipeline (forecast/index.js cumulativeFor), a future-dated planned tx executed early is added again via plannedAdd. The sibling repository functions getUpcoming/getForForecast (plannedTransactionRepository.js:541,574) both filter `AND pt.is_executed = false`, proving the intended convention.
  - **Fix:** Add `AND pt.is_executed = false` to all four planned_transactions queries in infoRepo.forecast.js (getCashflowComparison sqlPlannedCurrent + sqlPlannedHist, getCashflowForecastData sqlPlannedCurrent + sqlPlannedHist, getCashflowForecastDataRolling sqlPlannedFuture), matching the getForForecast convention. Recurring rows are unaffected (execution advances planned_date and keeps is_executed=false).
  - **Verify:** Integration test against a seeded DB: insert a planned tx (is_active=true, is_executed=true, planned_date in current month) plus its executed real transaction; assert getCashflowComparison returns with_planned.current === without_planned.current for every day, and that an is_executed=false row still contributes. Run `bun run test`.
  - **Verifier corrections (read these before fixing):** Line numbers in the finding are accurate (80-97 spans both getCashflowComparison planned queries; 272-285 and 390-396 verified; route logic is at routes/plannedTransactions.js:274-287 within the cited 274-296). One scoping nuance: getCashflowForecastDataRolling's sqlPlannedFuture (390-396) only double counts in the early-execution case since it requires planned_date > CURRENT_DATE — the dominant everyday impact is in getCashflowComparison (both current line and 24-month historical average) and getCashflowForecastData's sqlPlannedHist. Severity high is defensible for a user-facing money chart; effect size equals the full planned amount per executed non-recurring planned transaction.

- [ ] 🔼 Forecast methods average only days-with-transactions (no zero-fill) → conditional-mean bias; EWMA never decays stale buckets 🛫 2026-06-10
  - **File:** `apps/node-backend/src/services/calculations/forecast/methods/simpleAverage.js` lines 17-35.
  - **Offending code:**

    ```
      const byDom = new Map();
      for (const r of history) {
        const d = dayOfMonth(r.date);
        if (!byDom.has(d)) byDom.set(d, []);
        byDom.get(d).push(r.net);
      }
      const means = new Map();
      for (const [d, arr] of byDom) {
        let s = 0;
        for (const v of arr) s += v;
        means.set(d, s / arr.length);
      }
    ```

  - **Why wrong:** `history` from infoRepo.forecast.js aggregateByDate contains only dates that had transactions; a calendar day with no transactions is net 0 by definition, but these methods divide by occurrence count, not month count. Empirically verified (bun run of the actual modules): history = one −300 on 2026-01-15 plus +3000 salary on the 1st of 5 months → simpleAverage forecasts −300 for the next DOM-15 instead of ≈ −50 (sum/months), and ewma.js (lines 42-47: `if (x === undefined) continue;`) also returns −300 — a 5-month-old one-off carried at full weight with zero decay, defeating the advertised α=0.15 half-life. weightedAverage.js and seasonality.js buildSeasonalityBuckets (feeding both Monte Carlo methods) have the same skip-missing flaw. This contradicts the codebase's own semantics: simpleAverage's header claims 'parity with the legacy cashflow-comparison average', but getCashflowComparison zero-fills (`cum += (dayNet[d] || 0)` divided by monthCount), and holtWinters.js denseDaily explicitly comments 'Fill missing dates with 0 net'. Net effect: every per-day forecast and MC band is biased away from zero, by 2× when only half the bucket's months have activity.
  - **Fix:** Zero-fill centrally in runForecastEngine (services/calculations/forecast/index.js, after building trainHistory at lines 111-113): densify trainHistory over every calendar date from max(history-window start, first observed date) through todayIso, inserting {date, net: 0} for missing dates (reuse/extract holtWinters' denseDaily). Do the same for the trainHistory passed to walkForwardBacktest. Methods then need no changes.
  - **Verify:** Unit test: forecast({history: [{date:'2026-01-15',net:-300}, six monthly +3000 rows], forecastDates:['2026-06-15']}) after the fix returns ≈ −300/n_months for simple_avg and a value with magnitude < 300·(1−α)^4 for ewma; assert backtest MAE for simple_avg does not regress on a dense fixture. Run `bun run test`.
  - **Verifier corrections (read these before fixing):** Code excerpt sits at lines 18-29 of simpleAverage.js (the forecast function spans 17-36) — cited 17-35 is essentially correct. Two additions to the fix: (a) tests/services/cashflowForecastMethods.test.js lines 108-119 ('returns mean-per-DOM') encodes the occurrence-count behavior (expects 10 for a DOM seen in 1 of 2 months) and must be updated to expect the zero-filled mean (5); (b) the finding's '≈ −50' example assumes 6 history months — with 5 months the zero-filled simple-avg value is −60 (mechanism unchanged). Severity medium is appropriate.

- [ ] 🔼 Category-forecast reconciliation scales by ref/sum — explodes when mixed-sign categories nearly cancel 🛫 2026-06-10
  - **File:** `apps/node-backend/src/services/calculations/forecast/categoryBreakdown.js` lines 119-128.
  - **Offending code:**

    ```
      return categoryForecasts.map(({ cat, series }) => ({
        cat,
        series: series.map((p) => {
          const sum = sumByDate.get(p.date) ?? 0;
          const ref = refByDate.get(p.date) ?? 0;
          const scale = sum !== 0 ? ref / sum : 1;
          return { date: p.date, value: p.value * scale };
        }),
      }));
    ```

  - **Why wrong:** Multiplicative reconciliation is only valid when components share a sign. Category daily nets mix signs (income categories positive, expense categories negative), so `sum` is a small difference of large numbers and `scale = ref/sum` is unbounded. Empirically verified with the actual module: categories {+3000 income, −2990 expenses} (sum=+10) with aggregate reference 200 → scale 20 → reconciled values +60000 and −59800. Any payday date where income and spending nearly cancel produces absurd per-category forecast/cumulative lines in the category_breakdown view (and a sign flip of `sum` vs `ref` inverts every category's sign).
  - **Fix:** Replace proportional scaling with additive distribution of the residual: per date compute `diff = ref − sum`, `totalAbs = Σ|v_i|`; set `value_i = v_i + diff · |v_i| / totalAbs` (when totalAbs === 0, split diff equally across categories). This keeps Σ categories === ref exactly while keeping each adjustment bounded by |diff|.
  - **Verify:** Unit test on reconcileCategoryForecasts: input series [+3000, −2990], ref 200 → outputs must sum to 200 and each |adjustment| ≤ 190; also assert sign preservation for the dominant component. Run `bun run test`.
  - **Verifier corrections (read these before fixing):** Lines 119-128 are accurate for the mapped reconciliation block, but the code contains an extra line the excerpt omits: line 124 is `// eslint-disable-next-line vision-local-money/no-raw-money-arithmetic`, so the scale computation sits at line 125 and the block spans 119-128 inclusive as cited. Severity medium is appropriate (forecast/display correctness in the category_breakdown view, not money-moving).

- [ ] 🔼 average-vs-current: monthly projection multiplies a per-active-day rate by full calendar days (wrong denominator) 🛫 2026-06-10
  - **File:** `apps/node-backend/src/repositories/infoRepo.statistics.js` lines 82-86.
  - **Offending code:**

    ```
      const totalCurrentSpending = dailyData.reduce((s, d) => s + d.spending, 0);
      const daysElapsed = dailyData.length || 1;
      const now = new Date();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const projectedTotal = (totalCurrentSpending / daysElapsed) * daysInMonth;
    ```

  - **Why wrong:** `dailyData.length` counts distinct days that have any transaction, not calendar days elapsed. Concrete: today is June 9; the user spent €100 on each of 3 days (June 1, 5, 8) → daysElapsed = 3, projected_monthly_total = (300/3)·30 = €3000, while the actual run-rate is 300/9·30 = €1000 — 3× overstated, and `variance` (line 103) inherits the error. The same wrong-N appears at lines 57-58: `totalDays = Σ monthlyDays[k].size` counts only transaction days over 6 months (e.g. 80) instead of ~181 calendar days, overstating past_6_months.avg_daily_spending; `pace` (line 104) then divides two differently-biased rates. Consumers: GET /api/aggregations/average-vs-current, the AI-chat insights tool (services/aiChat/tools/insights.js:80), and the PDF report (services/reports/dataFetcher.js:66).
  - **Fix:** Use calendar denominators: `daysElapsed = now.getDate()` (better: select EXTRACT(DAY FROM CURRENT_DATE) in SQL to stay consistent with the query's CURRENT_DATE window) for the projection, and for the 6-month block divide by the number of calendar days between window start (date_trunc('month', CURRENT_DATE) - interval '6 months') and the window end. Keep daily_data as-is; rename/keep days_elapsed but populate it with the calendar value.
  - **Verify:** Unit test getAverageVsCurrentSpending with a mocked query returning 3 spending rows (days 1/5/8, −100 each) under a fixed clock at the 9th: assert projected_monthly_total === 100·daysInMonth/3 → after fix 300/9·daysInMonth. Run `bun run test`.
  - **Verifier corrections (read these before fixing):** Line numbers accurate (82-86 primary; secondary at 57-58, 103-104). Minor nuance: the finding says daysElapsed counts days with "any transaction" — correct; income-only days also create dailyMap entries (line 71), so the projection denominator can include zero-spending days, which slightly varies the bias but does not change the conclusion. Severity medium is appropriate.

- [ ] 🔽 Monthly-summary MV fast path converts month aggregates at the month-start FX rate — contradicts the live path's own correctness comment 🛫 2026-06-10
  - **File:** `apps/node-backend/src/repositories/infoRepo.monthly.js` lines 44-50.
  - **Offending code:**

    ```
        for (const r of mvResult.rows) {
          const dateStr = r.month_start instanceof Date ? formatDateToYmd(r.month_start) : String(r.month_start);
          const monthKey = formatYearMonthKey(r.year, r.month);
          mergedRows.push({ currency: r.currency, amount: toNumber(toDecimal(r.total_income)), _key: monthKey, _type: 'income', _row: r, date: dateStr });
          mergedRows.push({ currency: r.currency, amount: toNumber(toDecimal(r.total_spending)), _key: monthKey, _type: 'spending', _row: r, date: dateStr });
        }
        const mergedConverted = await convertRowsToEur(mergedRows, targetCurrency, { useHistoricalRatesByDate: true, dateField: 'date' });
    ```

  - **Why wrong:** mv_monthly_summary (alembic/versions/0025_fix_numeric_precision.py) is grained at month×currency, so the whole month's income/spending is converted at the historical rate of the 1st of the month. The live fallback in the same file converts per (date, currency) and its comment (lines 99-108) explicitly states 'A month-level GROUP BY would NOT be valid here because intra-month FX varies.' Concrete: $3100 of USD spending spread across June while EUR/USD moves 1.05→1.15 → MV path values everything at June-1's rate, off by up to ~9% vs the live path; toggling any category/recipient exclusion switches paths, so the dashboard's monthly history visibly changes for unrelated months. EUR-only datasets are unaffected.
  - **Fix:** Gate the MV fast path on currency homogeneity: before using the MV, check `SELECT 1 FROM mv_monthly_summary WHERE currency <> $1 LIMIT 1` (param = targetCurrency); if any row exists, fall through to the existing live per-date path. (Longer term: regrain the MV to (date, currency).)
  - **Verify:** Test with two seeded USD transactions in one month and two exchange_rates rows (month start vs mid-month): assert getMonthlyFinancialSummary returns the same total_spending with and without a dummy exclusion (today the two paths differ). Run `bun run test`.
  - **Verifier corrections (read these before fixing):** Line numbers accurate (excerpt at 44-50; gate at line 29, conversion call at line 50; live-path comment at 99-108). Severity 'low' is defensible for a mostly-EUR (Belgian) user base but is arguably 'medium' for multi-currency users since the dashboard's monthly history visibly shifts when toggling unrelated exclusions. The suggested homogeneity check should compare against targetCurrency (not hardcoded EUR), as the finding's fix already does — note it must also trigger when rows are all-EUR but targetCurrency is non-EUR, which `currency <> $1` handles correctly.

- [ ] 🔽 Planned-expenses-next-month counts each recurring item once at its current (possibly current-month) date and ignores is_executed 🛫 2026-06-10
  - **File:** `apps/node-backend/src/repositories/infoRepositoryPlanned.js` lines 34-38.
  - **Offending code:**

    ```
          WHERE pt.is_active = true
            AND (
              (pt.is_recurring = true)
              OR (pt.planned_date >= $1 AND pt.planned_date < $2)
            )
    ```

  - **Why wrong:** Recurring rows are included regardless of planned_date and are never expanded into next-month occurrences. Concrete: a weekly recurring −50 with planned_date 2026-06-12 (current month, viewed in June) appears in the 'next month' (July) payload keyed under daily_data['2026-06-12'] — a date outside the advertised period_start/period_end — and contributes −50 to summary.total_expenses, while July will actually see 4-5 occurrences (−200/−250). A monthly recurring item is dated with June's date instead of its July occurrence. Additionally there is no `is_executed = false` filter, so a non-recurring July item already executed early still counts as upcoming. Consumers: GET /api/info/planned-expenses-next-month and the PDF report (services/reports/dataFetcher.js:67).
  - **Fix:** For recurring rows, walk occurrences forward with calculateNextDate (services/calculations/recurrence.js) from planned_date until >= period_start, emitting one entry per occurrence < period_end (cap iterations, e.g. 100); bucket those into daily_data instead of the raw planned_date. Add `AND pt.is_executed = false` to the WHERE clause for the non-recurring branch.
  - **Verify:** Unit test with a weekly recurring planned tx dated mid-current-month: assert the next-month payload has 4-5 daily_data entries all within [period_start, period_end) and total_expenses = occurrences × amount; assert an is_executed=true non-recurring next-month row is excluded. Run `bun run test`.
  - **Verifier corrections (read these before fixing):** Line numbers (34-38) are accurate. Severity "low" is defensible but arguably understated: the PDF report's Planned Outlook KPIs (Expected Income/Expenses/Net) are materially wrong for any user with recurring planned transactions, which the /execute flow makes the common steady state. One addition to the fix: a recurring row whose planned_date is already beyond period_end (e.g., yearly recurring dated December) is also wrongly included today; the proposed occurrence-walk fix handles that case too (emits zero in-period occurrences).

#### Round 4 — Performance

- [ ] ⏫ Bank-balances 12-month history query materializes ~12× the whole transactions table via ROW_NUMBER over a months×transactions join 🛫 2026-06-10
  - **File:** `apps/node-backend/src/repositories/infoRepositoryBanks.js` lines 55-77.
  - **Offending code:**

    ```
                ROW_NUMBER() OVER (
                  PARTITION BY a.bank_account, m.month_start
                  ORDER BY t.date DESC, t.id DESC
                ) AS rn
              FROM months m
              CROSS JOIN account_list a
              LEFT JOIN transactions t ON t.bank_account = a.bank_account
                AND t.date <= (m.month_start + interval '1 month' - interval '1 day')::date
    ```

  - **Why wrong:** For each of the 12 month-ends, the LEFT JOIN matches every active balance-bearing transaction of that account dated on-or-before that month-end. Since the window is "the last 12 months" and most history is older, each of the 12 join legs matches nearly the full table: with 100 000 transactions this materializes ~1.2 M intermediate rows, sorts them by (bank_account, month_start, date DESC, id DESC), assigns row numbers, then throws away all but ~12×accounts rows (rn = 1). Postgres cannot push a top-1-per-group limit into a window function. This runs on every dashboard load (BankBalancesWidget, apps/frontend/src/components/dashboard/BankBalancesWidget.tsx:44-48, staleTime 60 s) and on the AI-chat getBankBalances tool — computeBankBalances has no server-side TTL cache (its envelope even mislabels source as 'mv').
  - **Fix:** Replace the ranked CTE with the LEFT JOIN LATERAL ... ORDER BY t.date DESC, t.id DESC LIMIT 1 pattern this repo layer already uses for the same "latest balance ≤ day" problem in infoRepositoryNetWorth.js:92-101: FROM months m CROSS JOIN account_list a LEFT JOIN LATERAL (SELECT t.currency, t.balance, t.date FROM transactions t WHERE t.is_active = true AND t.bank_account = a.bank_account AND t.balance IS NOT NULL AND t.date <= (m.month_start + interval '1 month' - interval '1 day')::date ORDER BY t.date DESC, t.id DESC LIMIT 1) lb ON true WHERE lb.balance IS NOT NULL. Each probe is an index scan on the existing idx_transactions_bank_date_active (bank_account, date DESC) WHERE is_active = true (alembic/versions/0001_initial_database_schema.py:709), so the query does ~12×accounts index probes (~60 for 5 accounts) instead of ranking ~1.2 M rows.
  - **Verify:** Extend apps/node-backend/tests/infoRepoBanks.test.js to assert identical history/total_history output for a fixture with multiple balance rows per month (incl. same-date id tie-break). On a seeded DB run EXPLAIN (ANALYZE, BUFFERS) on both forms and confirm the WindowAgg over ~12×N rows is replaced by a Nested Loop of index scans. Run bun run test.
  - **Verifier corrections (read these before fixing):** Minor: the ranked CTE itself is lines 55-72 with the rn=1 outer select at 73-77 (cited range 55-77 is fine; the full query starts at line 42). One technical nuance: the stack runs postgres:18-alpine, and PG 15+ applies a window 'run condition' for the rn=1 filter — but with PARTITION BY it only short-circuits per-partition evaluation; the full ~12N-row join output must still be produced and sorted beneath the WindowAgg, so the claimed dominant cost is unchanged. Severity 'high' is defensible given the per-dashboard-load frequency, though on a single-user self-hosted deployment the wall-clock impact may read as medium until the transactions table is large.

- [ ] ⏫ getCategoryPivot streams every active transaction row into JS (unbounded, sorted) and aggregates per month/category in JavaScript 🛫 2026-06-10
  - **File:** `apps/node-backend/src/repositories/infoRepositoryStatistics.js` lines 149-187.
  - **Offending code:**

    ```
        const sql = `
          SELECT
            COALESCE(t.category_id, r.default_category_id) AS category_id,
            CONCAT(c.general, ': ', c.detail) AS category_name,
            TO_CHAR(t.date, 'YYYY-MM') AS period,
            t.amount, t.currency, t.date
          FROM transactions t
          ...
          ORDER BY t.date
    ```

  - **Why wrong:** No date bound, no LIMIT, no SQL aggregation: with 100 000 active transactions, every /api/aggregations/category-pivot request transfers ~100 000 rows × 6 columns over the pg wire, allocates a JS object per row in convertRowsToEur (plus a Decimal round-trip per row in mapRowsForAmountConversion), then reduces to a few thousand (period, category) cells in the periodCatMap loop (lines 173-187). ORDER BY t.date additionally forces a full sort that the consumer never needs (rows go into maps). The Statistics page fires this twice per visit when exclusions are configured — unfiltered always plus filtered (apps/frontend/src/hooks/useStatistics.ts:218-222 and 254-267, staleTime only 60 s) — so one page open can stream the whole table to JS twice.
  - **Fix:** Push the aggregation into SQL using the exactness argument already proven and documented for the monthly-summary fallback (apps/node-backend/src/repositories/infoRepo.monthly.js:99-108: rows sharing the same date+currency share one historical FX rate, and rate > 0 preserves sign): SELECT COALESCE(t.category_id, r.default_category_id) AS category_id, CONCAT(c.general, ': ', c.detail) AS category_name, TO_CHAR(t.date,'YYYY-MM') AS period, t.date, t.currency, SUM(t.amount) AS amount, COUNT(*) AS cnt ... GROUP BY 1,2,3,4,5 (drop ORDER BY t.date). Then run convertRowsToEur with useHistoricalRatesByDate on the grouped rows and accumulate eur×1/count per group (use cnt for transactionCount). Returned rows shrink from one-per-transaction to one per distinct (category, day, currency) — typically 5-10× fewer rows and no per-transaction JS work.
  - **Verify:** Extend apps/node-backend/tests/infoRepoStatistics.test.js with a fixture of multiple same-day same-category transactions in two currencies and assert the categoryPivot output (totals + transactionCount per period) is identical before/after the rewrite. Run bun run test.
  - **Verifier corrections (read these before fixing):** Line numbers correct (SQL at 149-163, aggregation loop at 173-187, function spans 137-197). Two fix-text imprecisions: (1) 'accumulate eur×1/count per group' is garbled — converting the per-group SUM(t.amount) yields the group EUR total directly, and cnt supplies transactionCount; no per-group division is needed. (2) Dropping ORDER BY t.date changes the JSON key insertion order of periods in the raw response; the frontend does not depend on it, but adding ORDER BY period on the grouped rows is near-free and keeps the response byte-identical. Severity 'high' is defensible given the double-fire per page visit; for typical single-user self-hosted datasets (tens of thousands of rows) 'medium' would also be reasonable.

- [ ] 🔼 getRecipientByYear pulls every expense transaction row into JS to compute top-20 recipients per year 🛫 2026-06-10
  - **File:** `apps/node-backend/src/repositories/infoRepositoryRecipients.js` lines 156-191.
  - **Offending code:**

    ```
        const sql = `
          SELECT
            EXTRACT(YEAR FROM t.date)::int AS year,
            COALESCE(pr.id, r.id) AS recipient_id,
            COALESCE(pr.name, r.name) AS name,
            t.amount, t.currency, t.date
          FROM transactions t
          ...
          ORDER BY t.date
    ```

  - **Why wrong:** Same mechanism as getCategoryPivot: every active expense row (amount < 0, no date bound, no LIMIT) is streamed to JS, converted per-row, and reduced in the yearRecMap loop (lines 179-191) — even though the endpoint only returns the top 20 recipients per year. With 60 000 expense rows out of 100 000 transactions that is 60 000 rows per request, and the Statistics page requests it twice (unfiltered always + filtered when exclusions exist, apps/frontend/src/hooks/useStatistics.ts:230-234 and 269-281, staleTime 60 s). The ORDER BY t.date sort is pure waste — output ordering is irrelevant to a map-based reduce.
  - **Fix:** Apply the same (date, currency)-group collapse as the monthly-summary fallback (infoRepo.monthly.js:99-108): GROUP BY COALESCE(pr.id, r.id), COALESCE(pr.name, r.name), EXTRACT(YEAR FROM t.date)::int, t.date, t.currency with SUM(ABS(t.amount)) AS abs_amount, COUNT(*) AS cnt, and drop ORDER BY t.date. Convert the grouped rows with useHistoricalRatesByDate (rate identical within each group, ABS distributes over same-sign sums since the WHERE clause pins amount < 0), then keep the existing JS top-20 slice. Collapses multiple same-day purchases at the same merchant and removes per-transaction Decimal/object overhead; same rewrite applies to getRecipientPivot (lines 219-241) which shares the pattern verbatim.
  - **Verify:** Extend apps/node-backend/tests/infoRepositoryRecipients.test.js with a fixture containing several same-day transactions for one recipient (mixed currencies) and assert recipientsByYear totals/transactionCount and top-20 ordering are unchanged by the rewrite. Run bun run test.
  - **Verifier corrections (read these before fixing):** Minor line-range imprecision only: the cited 156-191 covers the SQL + yearRecMap reduce, but the full pattern in getRecipientByYear spans 148-202 (top-20 slice at 193-199). The getRecipientPivot reference "219-241" covers its SQL + conversion; its full identical pattern spans 204-265 (reduce at 243-255). Severity medium is appropriate.

- [ ] 🔼 Saved-chart recipient pivot fetches the pivot for ALL recipients, then the client discards everything but the chart's few selected recipients 🛫 2026-06-10
  - **File:** `apps/frontend/src/hooks/useRecipientPivot.ts` lines 62-72.
  - **Offending code:**

    ```
        const filtered = useMemo(() => {
            const recipientData = buildRecipientPeriodData(rawPivot ?? {});
            const selected = new Set(recipientIds ?? []);
            return recipientData.filter((r) => selected.has(r.recipientId));
        }, [rawPivot, recipientIds]);
    ```

  - **Why wrong:** The only consumer of /api/aggregations/recipient-pivot is CustomChart (apps/frontend/src/components/statistics/CustomChart.tsx:70) rendering a saved chart with typically 1-10 chart.recipient_ids. The backend (apps/node-backend/src/repositories/infoRepositoryRecipients.js:204-241) nevertheless scans every active expense transaction for ALL recipients, builds the full recipients×periods pivot, and ships it as JSON; the hook then throws away all but the selected recipients. With 2 000 recipients × 60 months the JSON payload is hundreds of thousands of cells (easily multiple MB) per chart load, recomputed server-side after every 60 s staleTime window — to render a handful of series.
  - **Fix:** Add an optional recipient_ids inclusion param end-to-end: (1) route /recipient-pivot parses recipient_ids via the existing parseNumericArrayQueryParam (apps/node-backend/src/routes/aggregations.js:225-237); (2) in getRecipientPivot, first resolve member ids with SELECT id FROM recipients WHERE id = ANY($1) OR primary_recipient_id = ANY($1), then add AND t.recipient_id = ANY($n) to the transactions WHERE clause — this hits idx_transactions_recipient_date_active (recipient_id, date DESC) WHERE is_active = true (0001_initial_database_schema.py:707) so only the selected recipients' rows are read instead of the whole table; (3) in useRecipientPivot pass chart.recipient_ids to getAggregationRecipientPivot and add them to the queryKey (the current key deliberately omits them, which would otherwise serve one chart's narrowed payload to a different chart).
  - **Verify:** Backend: extend apps/node-backend/tests/infoRepositoryRecipients.test.js asserting the pivot for recipient_ids=[A] includes alias-rolled-up rows of A only and matches the unfiltered pivot's values for A. Frontend: existing CustomChart tests stay green; verify in devtools that the /recipient-pivot response now only contains the selected recipients. Run bun run test and bun run lint.
  - **Verifier corrections (read these before fixing):** Code excerpt is at lines 68-72 (cited 62-72 includes the rawPivot/recipientIds setup at 62-63 — close enough). Backend function spans infoRepositoryRecipients.js:204-265; the cited 204-241 covers the SQL+query+conversion. Two refinements: (1) the backend is worse than described — the SQL has no GROUP BY, so every active expense transaction row is streamed to Node and FX-converted per-row in JS before aggregation, not just "scans... builds the pivot"; (2) "recomputed server-side after every 60 s staleTime window" is slightly off — staleTime only governs client refetch on remount/focus; the server recomputes on every request regardless. Also note: the proposed fix of adding recipient_ids to the queryKey reverses a documented decision in ADR-041 (shared cache keyed per currency/bucket/start/end), so the fix should include a superseding/amending ADR note per the repo's append-only ADR rule.

- [ ] 🔽 Sankey aggregation streams a full year of transaction rows into JS where an exactly-equivalent SQL GROUP BY returns ~50 rows 🛫 2026-06-10
  - **File:** `apps/node-backend/src/services/calculations/aggregation/sankey.js` lines 57-99.
  - **Offending code:**

    ```
        SELECT
          t.amount,
          t.currency,
          COALESCE(c.general || ': ' || c.detail, 'Uncategorised') AS category_name,
          t.amount > 0 AS is_income
        FROM transactions t
    ```

  - **Why wrong:** Every Statistics Flow-tab load (SankeyTab, staleTime 5 min, refetched per year/exclusion-toggle change) fetches one full year of transaction rows (10 000-20 000 for an active user) and reduces them in the JS loop at lines 91-99 to ~13 numbers (totalIncome + top-12 categories). Unlike the pivots, this endpoint converts with latest rates only (convertRowsToEur without useHistoricalRatesByDate, line 82-85), so per-group SQL summation is numerically identical — multiplication by one rate per currency distributes over the sum. The per-row fetch buys nothing.
  - **Fix:** Change the query to SELECT COALESCE(c.general || ': ' || c.detail, 'Uncategorised') AS category_name, t.currency, (t.amount > 0) AS is_income, SUM(ABS(t.amount)) AS amount FROM ... GROUP BY 1, 2, 3 (keep the same WHERE/exclusion clauses), then run the existing convertRowsToEur + accumulation over the ~(categories × currencies × 2) grouped rows. ABS distributes because each group is sign-homogeneous (grouped on t.amount > 0).
  - **Verify:** Add a unit test for computeSankeyFlow with a mocked query returning grouped rows (two currencies, >12 categories) asserting identical nodes/links to the current implementation's output for the same underlying data; run bun run test.
  - **Verifier corrections (read these before fixing):** Line numbers are accurate (query at 57-72, JS reduction loop at 91-99). One wording nit: 'numerically identical' is strictly identical only after roundMoney rounding — raw float sums may differ at ULP level due to summation order (SQL SUM on numeric is exact decimal, so the grouped version is if anything more precise). Severity 'low' is appropriate.

- [ ] 🔽 Dashboard stats queryFn awaits two independent API calls sequentially 🛫 2026-06-10
  - **File:** `apps/frontend/src/hooks/useFilteredDashboardStats.ts` lines 55-63.
  - **Offending code:**

    ```
          const countData = await apiClient.getTransactionCount();
    
          const envelope = await apiClient.getAggregationMonthlySummary({
            excluded_category_ids: excludedCategoryIds.length > 0 ? excludedCategoryIds : undefined,
            excluded_recipient_ids: excludedRecipientIds.length > 0 ? excludedRecipientIds : undefined,
            currency: targetCurrency,
          });
    ```

  - **Why wrong:** getTransactionCount and getAggregationMonthlySummary have no data dependency, but the second request only starts after the first round-trip completes. This hook gates the entire dashboard skeleton (DashboardPage.tsx:299 blocks rendering on statsLoading), so every dashboard mount and every exclusion-set change pays one extra serial round-trip; the monthly-summary call is the slow one (per-month aggregation + FX), and over Docker/remote links the wasted serial hop is a user-visible 50-300 ms added to first paint.
  - **Fix:** const [countData, envelope] = await Promise.all([apiClient.getTransactionCount(), apiClient.getAggregationMonthlySummary({ ... })]); — no other changes needed since neither result feeds the other's request.
  - **Verify:** Existing hook tests stay green (bun run --filter vision-frontend test); in devtools Network tab confirm /api/info/transaction-count and /api/aggregations/monthly-summary now start concurrently on dashboard load.
  - **Verifier corrections (read these before fixing):** Lines 55-63 in the finding include two comment lines; the actual sequential awaits are at lines 57 and 59-63. Otherwise accurate.

#### Round 4 — Design

- [ ] ⏫ Dashboard exclusion filters drifted: canonical buildExclusionClauses has zero production callers while four hand-rolled SQL variants disagree on alias and category semantics 🛫 2026-06-10
  - **File:** `apps/node-backend/src/repositories/infoRepo.monthly.js` lines 86-92 (plus infoRepositoryStatistics.js:143-146, infoRepositoryRecipients.js:30-33, vs canonical infoRepo.forecast.js:44-52 and services/filterBuilder.js:211-247).
  - **Offending code:**

    ```
    const categoryExcludeClause = validIds.length > 0
      ? `AND COALESCE(t.category_id, r.default_category_id) NOT IN (${validIds.map(id => { params.push(id); return `$${params.length}`; }).join(',')})`
      : '';
    const recipientExcludeClause = validRecipientIds.length > 0
      ? `AND t.recipient_id NOT IN (${validRecipientIds.map(id => { params.push(id); return `$${params.length}`; }).join(',')})`
      : '';
    ```

  - **Why wrong:** All these queries receive the SAME excluded_category_ids/excluded_recipient_ids from the frontend's centralized useExcludedIds hook, but implement exclusion differently. Recipient exclusion: monthly-summary (infoRepo.monthly.js:92) and category-pivot (infoRepositoryStatistics.js:146) use bare `t.recipient_id NOT IN`, while recipient-insights (infoRepositoryRecipients.js:33, `COALESCE(pr.id, r.id) NOT IN`) and all forecast queries (infoRepo.forecast.js:52, `COALESCE(r.primary_recipient_id, t.recipient_id) NOT IN`) are alias-aware. Concrete: recipient "AH BV" (id 9, holds the transactions) is merged under primary "Albert Heijn" (id 5). User excludes id 5 → dashboard monthly cards and statistics category pivot still count AH BV's transactions; the top-recipients widget and cashflow forecast exclude them — different money totals on the same page from one exclusion set. Excluding id 9 instead inverts the disagreement (recipient-insights resolves the row to pr.id=5 ∉ {9} and keeps it). Category exclusion: monthly/pivot/recipients use 2-level COALESCE(t.category_id, r.default_category_id) while forecast and the canonical builder use 3-level (adds pr.default_category_id) — a transaction categorized only via the primary recipient's default category is excluded from forecasts but not from monthly totals. The canonical fix already exists: services/filterBuilder.js:211-247 buildExclusionClauses/buildAggregationFilter (header: "Call-site migration happens in Phases 2 (dashboard) and 5 (transactions)") — Phase 5 happened (transactionRepository, routes/transactions, bulkSelection import it), Phase 2 never did; the two exports have zero production callers (only tests/filterBuilder.test.js).
  - **Fix:** Migrate the hand-rolled exclusion clauses to buildExclusionClauses (it returns { joinSql, whereSql, params, nextParamIdx } and supports startParamIdx for composition): infoRepo.monthly.js getMonthlyFinancialSummary, infoRepositoryStatistics.js getCategoryPivot, and infoRepositoryRecipients.js (all three query sites — :30/33, :153, :209; the existing pr join is already in those queries). Delete the per-file `Number.isInteger(id) && id > 0 && id < 2147483647` filters in favor of validateInt4Ids. Decide the recipient semantics once (alias-aware COALESCE(r.primary_recipient_id, t.recipient_id) is what forecasts and the builder already do) and document it in docs/features for exclusions.
  - **Verify:** Extend apps/node-backend/tests/infoRepoMonthly.test.js and infoRepoStatistics.test.js: capture the SQL passed to the mocked query() and assert the recipient exclusion uses COALESCE(r.primary_recipient_id, t.recipient_id) and the category exclusion the 3-level COALESCE; add one cross-module test asserting monthly-summary and recipient-insights produce consistent exclusion SQL for the same ids. Run bun run test.
  - **Verifier corrections (read these before fixing):** Line numbers slightly off: infoRepo.monthly.js excerpt is at 87-93 (cited 86-92); infoRepositoryStatistics.js at 142-147 (cited 143-146); infoRepositoryRecipients.js at 29-34 (cited 30-33); buildExclusionClauses at filterBuilder.js:211-246. Substantive correction to the category sub-claim: the claimed direction ('a transaction categorized only via the primary recipient's default category is excluded from forecasts but not from monthly totals') is wrong — for such a row the 2-level COALESCE is NULL, and `NULL NOT IN (...)` evaluates to NULL, so monthly ALSO drops the row whenever any category exclusion is active. The actual 2-vs-3-level divergence is broader: with any non-empty category exclusion list, the 2-level variants silently drop ALL rows whose 2-level effective category is NULL (including genuinely uncategorized transactions), while the 3-level forecast variant keeps the ones whose resolved category is not excluded. The recipient-alias divergence (the headline mechanism) is exactly as described. Fix and severity (high) stand; the fix should also note the NULL-handling change in row retention for uncategorized transactions when migrating to buildExclusionClauses.

- [ ] 🔼 Phase 9 aggregation cutover incomplete: AGGREGATIONS_V2_ENABLED flag is fictional and legacy GET /api/info + GET /api/info/transaction-summary are dead route surface still maintained in five places 🛫 2026-06-10
  - **File:** `apps/node-backend/src/routes/info/statistics.js` lines 20-24, 50-60 (plus routes/aggregations.js:13-15, repositories/infoRepositoryStatistics.js:16-80 and 199-256).
  - **Offending code:**

    ```
    router.get('/', async (req, res) => {
      const targetCurrency = getTargetCurrency(req);
      const stats = await infoRepository.getStatistics(targetCurrency);
      res.ok(stats);
    });
    ```

  - **Why wrong:** routes/aggregations.js:13-15 says routes are "Mounted in parallel with legacy /api/info/* behind the AGGREGATIONS_V2_ENABLED feature flag ... legacy routes are removed in Phase 9" — but no such flag exists anywhere in the codebase (grep hits only this comment) and main.js:287-288 mounts both unconditionally. ADR-010 marks "Phase 9 Cutover Complete" (2026-04-25) yet the legacy endpoints were never removed: GET /api/info and GET /api/info/transaction-summary have zero production callers — frontend getStatistics/getTransactionSummary (lib/api/info.ts:11,43) are exported via the lib/api.ts barrel (:118,:122) but called by no page/component/hook, and Electron does not call /api/info. Meanwhile they are maintained in openapi.yaml (:2457,:2514), types/generated.ts, msw handlers, both contract suites, and ~130 lines of repo code — including infoRepositoryStatistics.getStatistics (lines 37-79) which duplicates getCategoryBreakdown (lines 92-120) nearly verbatim and has already drifted internally: its MV path sums per-category rounded totals (line 28) while its fallback rounds the unrounded float sum (line 60), giving penny-different total_amount depending on MV availability. Every future audit/refactor pays to keep this dead, drifting surface correct.
  - **Fix:** Finish the documented Phase 9: delete the GET / and GET /transaction-summary handlers from routes/info/statistics.js, the getStatistics and getTransactionSummary functions from infoRepositoryStatistics.js (getCategoryBreakdown stays — aggregation/category.js uses it), the getStatistics/getTransactionSummary exports from apps/frontend/src/lib/api/info.ts and lib/api.ts, the two paths from openapi.yaml (regenerate generated.ts), and the corresponding msw handlers + contract-test cases. Rewrite the stale flag comment in routes/aggregations.js to describe reality. Update docs/reference/api-endpoint-matrix.md.
  - **Verify:** grep -rn "'/api/info'\|transaction-summary" apps/frontend/src --include='*.ts*' | grep -v test returns nothing; bun run test and the frontend test suite stay green after removing the routes (tests/routes/info.test.js GET / and GET /transaction-summary describes get deleted alongside).
  - **Verifier corrections (read these before fixing):** All cited line numbers check out exactly (statistics.js 20-24 and 50-60; aggregations.js 13-15; infoRepositoryStatistics.js 16-80 and 199-256; openapi.yaml 2457/2514; info.ts 11/43; api.ts 118/122). One imprecision in why_wrong: "no such flag exists anywhere in the codebase (grep hits only this comment)" — the string also appears in docs (ADR-011/016/033, alembic/versions/0002_feature_flags.py docstring) and, notably, docs/reference/environment-variables.md:44 still lists AGGREGATIONS_V2_ENABLED as a live env var sourced from config/env.js, which is false. The substantive claim (no runtime gate) holds, but the fix should also remove the stale environment-variables.md row. Severity medium is appropriate.

- [ ] 🔼 MSW default handlers mock wrong response shapes for four /api/info endpoints and the msw contract suite pins the wrong shapes, contradicting the live-contracts suite 🛫 2026-06-10
  - **File:** `apps/frontend/src/test/msw/handlers.ts` lines 366-370 (plus contracts.test.ts:740-755 vs live-contracts/live-contracts.test.ts:343-365).
  - **Offending code:**

    ```
    http.get(`${API_BASE}/api/info/transaction-summary`, () => ok(null)),
    http.get(`${API_BASE}/api/info/transaction-count`, () => ok(0)),
    http.get(`${API_BASE}/api/info/recurring-patterns`, () => ok([])),
    http.get(`${API_BASE}/api/info/banks`, () => ok([])),
    http.get(`${API_BASE}/api/info/supported-adapters`, () => ok([])),
    ```

  - **Why wrong:** The real routes return objects: transaction-count → { total_transactions } (routes/info/statistics.js:47), recurring-patterns → { patterns, total } (:71-76), banks → { banks } (:28), supported-adapters → { adapters, total_count } (:42). The msw contract tests then validate the mocks' wrong shape — contracts.test.ts:746-748 asserts z.array() for supported-adapters while live-contracts.test.ts:353-361 asserts z.object({ adapters, total_count }) for the same endpoint: the two "contract" suites assert contradictory contracts, so the msw one can never catch a frontend/backend shape mismatch. Concrete failure: any component test relying on the defaults exercises impossible API states — useAdapters.ts:21 does res?.adapters → undefined under the default mock, so the import-page adapter dropdown renders empty in every test and a regression in that path is invisible; useFilteredDashboardStats reads countData.total_transactions → undefined. OnboardingWizard.test.tsx:15-25 already had to locally re-stub supported-adapters with the correct object shape to make the component work, proving the default is wrong.
  - **Fix:** Change the five defaults in handlers.ts to the live shapes: ok({ total_count: 0, total_amount: 0, average: 0, min: null, max: null }), ok({ total_transactions: 0 }), ok({ patterns: [], total: 0 }), ok({ banks: [] }), ok({ adapters: [], total_count: 0 }). Update contracts.test.ts:735-755 to the same zod schemas live-contracts.test.ts uses (best: extract the schemas into one shared module imported by both suites so they cannot diverge again). Remove the now-redundant local stub in OnboardingWizard.test.tsx.
  - **Verify:** Frontend test run (bun run --filter vision-frontend test): contracts.test.ts updated cases pass; delete the stubAdapters() override in OnboardingWizard.test.tsx and confirm the wizard tests still pass against the corrected default handler.
  - **Verifier corrections (read these before fixing):** Line corrections: handlers.ts excerpt is lines 365-369 (not 366-370; 370 is inflation-rates). contracts.test.ts block is lines 726-748 (transaction-summary 726-729, transaction-count 731-734, recurring-patterns 736-739, banks 741-744, supported-adapters 746-748), not 740-755. OnboardingWizard.test.tsx stub is lines 15-27, not 15-25. Scope correction: the title says four endpoints, but it is five wrong defaults — transaction-summary's ok(null) is also unreachable (backend returns a zeroed object when empty, infoRepositoryStatistics.js:230); the live-contracts suite only asserts z.unknown() there, so the suite-contradiction applies to four endpoints while the wrong-mock-shape applies to five. The proposed fix already covers all five. Severity medium is appropriate (test-infrastructure design flaw, no production bug).

- [ ] 🔼 Bank-adapter catalog maintained in three places: frontend-facing endpoint hardcodes the list (with adapter_class names that don't exist) while the registry-backed endpoint is dead 🛫 2026-06-10
  - **File:** `apps/node-backend/src/routes/info/statistics.js` lines 31-43 (plus routes/importRoutes.js:376-383, services/importPipeline/adapters/index.js:19-33).
  - **Offending code:**

    ```
    router.get('/supported-adapters', async (req, res) => {
      const adapters = [
        { key: 'kbc', name: 'KBC', adapter_class: 'KBCAdapter' },
        { key: 'belfius', name: 'Belfius', adapter_class: 'BelfiusAdapter' },
        ...
      ];
      res.ok({ adapters, total_count: adapters.length });
    });
    ```

  - **Why wrong:** Three encodings of the same catalog: (1) this hardcoded list (the only one the frontend uses — useAdapters.ts and OnboardingWizard.tsx call getSupportedParsers → /api/info/supported-adapters); (2) the adapter registry in adapters/index.js, where every adapter already exports { name, bankName } (e.g. bnp.js:28-29: NAME='bnp', BANK_LABEL='BNP Paribas Fortis'); (3) GET /api/import/supported-banks (importRoutes.js:376-383), which derives from the registry but has zero frontend callers — dead route. The adapter_class strings ('KBCAdapter' etc.) name classes that exist nowhere in the codebase (adapters are plain objects). Concrete drift scenario: add an N26 adapter to adapters/index.js → CSV auto-detection and parsing work, /api/import/supported-banks reports it, but the import card's adapter dropdown and the onboarding wizard never show it because routes/info/statistics.js was not also edited; nothing fails loudly.
  - **Fix:** In routes/info/statistics.js import the registry (ADAPTERS or a new listAdapters() export from services/importPipeline/adapters/index.js) and serve: ADAPTERS.filter(a => a.name !== 'generic').map(a => ({ key: a.name, name: a.bankName })). Keep adapter_class temporarily as a derived legacy field (or drop it and remove it from the BankAdapter interface in useAdapters.ts — nothing reads it beyond the type). Delete the dead GET /api/import/supported-banks handler and its openapi.yaml entry, and update docs/reference/api-endpoint-matrix.md.
  - **Verify:** Add to tests/routes/info.test.js: GET /supported-adapters payload deep-equals the registry-derived list (import the registry in the test), so adding an adapter without UI exposure becomes impossible. grep -rn 'supported-banks' apps/frontend/src confirms no callers before deleting. Run bun run test.
  - **Verifier corrections (read these before fixing):** importRoutes.js cite should be lines 377-383 (376 is a comment line). Minor nuance for the fix: the dead supported-banks route returns capitalized registry names ('Bnp'), not bankName labels, so it was never display-equivalent to the hardcoded list; the proposed registry-backed map (key: a.name, name: a.bankName) is the correct replacement.

#### Round 4 — discovered during adversarial verification

- [ ] 🔼 Historical-FX conversion (`useHistoricalRatesByDate: true`) is silently inert for DB-sourced date rows — falls back to today's rate 🛫 2026-06-10
  - **File:** `apps/node-backend/src/services/currency/rateFetcher.js` lines 23-28 (`normalizeDateInput`), consumed via `apps/node-backend/src/services/currency/currencyConversionService.js` lines 215-220 (`resolveRateWithFallback`).
  - **Mechanism (verified experimentally with bun):** `normalizeDateInput` matches `String(value)` against `/^\d{4}-\d{2}-\d{2}/`. Rows fetched from Postgres `DATE` columns arrive as JS `Date` objects (pg-DATE class, see preamble), whose `String()` form is `"Sun Jun 01 2025 ..."` — the regex fails, `normalizeDateInput(new Date(2025,5,1)) === null`, and `resolveRateWithFallback` short-circuits to `rates[code]`, the **latest** in-memory rate. So every call site that passes DB rows with `useHistoricalRatesByDate: true, dateField: 'date'` actually converts at today's rate; the intended per-date historical conversion is dead code there.
  - **Known affected call sites:** `apps/node-backend/src/repositories/infoRepositoryBanks.js` lines 80-98 (bank-balance history sparkline group) and `apps/node-backend/src/repositories/infoRepositoryStatistics.js` lines 167-171 (category pivot passes `useHistoricalRatesByDate: true`). Grep for other `useHistoricalRatesByDate` call sites and check what each passes as `dateField` rows.
  - **Fix:** make `normalizeDateInput` handle `Date` instances via local getters (`getFullYear/getMonth/getDate`, mirroring `toYmd` in `utils/portfolioMath.js:24-32`) — or land the global `pg.types.setTypeParser(1082, v => v)` fix first, which makes the dates strings and the existing regex match.
  - **⚠ Migration coupling:** landing the global type-parser fix **activates** historical conversion at these call sites, changing reported numbers (pivot/history values switch from latest-rate to per-date historical-rate conversion). Whoever lands either fix must expect and validate that intentional behavior change — note it in the type-parser item's sweep.
  - **Verify:** unit test `normalizeDateInput(new Date(2025, 5, 1)) === '2025-06-01'`; integration test that a mocked multi-currency row set with historical rates present converts at the row-date rate, not the latest. Run `bun run test`.

### Round 5 — chart verification audit (2026-06-10)

Single-agent end-to-end audit of **every chart in the app** (chart primitives in
`apps/frontend/src/components/charts/`, all 29 consumers across dashboard / statistics /
portfolio / tax / market pages, and the backend endpoints feeding them): calculations,
series construction, axes/tooltips/legends, sign conventions, exclusion handling,
date/bucket handling, empty/edge states. Items below are **new** — overlaps with already-filed
items (LTTB downsampler, `computeHeatmap` TZ bucketing, cashflow planned-overlay double count,
forecast zero-fill bias, monthly-summary MV FX, exclusion-SQL drift, inert historical-FX) were
checked and **not** duplicated.

- [ ] 🔼 Saved charts: `yearly` time bucket is broken three ways (blank line/area charts, monthly granularity for categories, first year dropped by date filter) 🛫 2026-06-10
  - **Files:** `apps/frontend/src/components/statistics/CustomChart.tsx` lines 32-47 (`formatPeriod`/`parseDate`), 83-105 (`allPeriods` + date-range filter at 95-102), 123-142 (`chartData`); `apps/frontend/src/components/shared/dateUtils.ts` lines 42-50 (`parseISO`); `apps/frontend/src/hooks/useRecipientPivot.ts` lines 51-57.
  - **Why wrong:** Category data always arrives monthly (`StatisticsData.categoryPivot[].months` is keyed `YYYY-MM`; the category-pivot endpoint has no bucket param), while recipient data respects the saved `time_bucket` (`useRecipientPivot` passes `bucket: chart.time_bucket` → keys `YYYY` for yearly). The builder modal (`CustomChartBuilderModal.tsx:202-213`) freely allows `yearly` with categories. Consequences for a `time_bucket='yearly'` chart: **(a)** with categories + chart type line/area: `parseDate('2026-05', 'yearly')` → `parseISO('2026-05-01-01')` → falls through the regex to `new Date('2026-05-01-01')` → **Invalid Date** (verified with bun) → every x value is NaN → the chart renders completely blank (no error). With bar type the chart silently renders **monthly** bars with raw `2026-05` labels (`formatPeriod(period,'yearly')` returns the period string unchanged) — the yearly setting is ignored. **(b)** mixed category+recipient yearly charts union `YYYY` and `YYYY-MM` period keys, so each series is zero/absent on the other's rows. **(c)** the date-range filter compares `p >= start.slice(0,7)`; for a yearly period `'2026' >= '2026-01'` is **false** lexicographically, so a yearly chart with `date_range_start` in year Y silently drops year Y itself (the end-bound comparison is unaffected: `'2026' <= '2026-12'` holds).
  - **Fix:** In `CustomChart`, derive period keys per the saved bucket: when `time_bucket='yearly'`, re-bucket category months client-side (`period.slice(0,4)`, summing values) before building `allPeriods`/`chartData`, so both sources share `YYYY` keys; make `parseDate` for yearly slice the year first (`parseISO(\`${period.slice(0,4)}-01-01\`)`); and compare date-range bounds on a common prefix (`p.length === 4 ? start.slice(0,4) : start.slice(0,7)`). Alternatively (smaller surface): restrict the builder to monthly when categories are selected — but the re-bucket fix is strictly better since yearly category charts are a reasonable feature.
  - **Verify:** Component test: saved chart `{time_bucket:'yearly', category_ids:[X], chart_type:'line'}` with two years of pivot data renders 2 data points with valid dates (currently 0 visible); `{time_bucket:'yearly', date_range_start:'2026-01-01'}` keeps year 2026. Run `bun run --filter vision-frontend test`.

- [ ] 🔼 Statistics "Spending by Category" donut and "Top Category Trends" include income categories — salary shows up as the biggest "spending" slice 🛫 2026-06-10
  - **Files:** `apps/frontend/src/components/statistics/CategoryPieChart.tsx` lines 22-39; `apps/frontend/src/components/statistics/CategoryTrendChart.tsx` lines 21-44; data built in `apps/frontend/src/hooks/useStatistics.ts` (`mapToStatisticsData`) lines 109-141.
  - **Why wrong:** Both charts read `category.months[period]` and rank by `category.total`, which `mapToStatisticsData` fills with `Math.abs(item.total)` summed over **all** categories regardless of sign (line 128-135), and the backend category pivot (`apps/node-backend/src/repositories/infoRepositoryStatistics.js:149-163`) has **no `amount < 0` filter** — income categories flow straight through. Card titles are `'Spending by Category'` (`en.ts:2070`) and `'Monthly spending for top 5 categories'` (`en.ts:2071`), but a salary category (typically the single largest monthly magnitude) renders as the largest donut slice and occupies a top-5 trend line. Mixed categories additionally net income against expenses *within* a month before `abs()` (sign decided per `item.total`), understating their spending. The structure already carries the right fields — `expenseMonths`/`expenseTotal` (and `incomeMonths`/`netMonths`) are built at lines 119-137 — the charts just read the wrong ones.
  - **Fix:** In `CategoryPieChart`, sum `category.expenseMonths[period]` and drop categories with zero expense total; in `CategoryTrendChart`, take top-5 by `expenseTotal` and plot `expenseMonths`. (If an income view is wanted later, add a toggle like `CategoryPivotTable`'s `PivotValueMode` rather than mixing signs.)
  - **Verify:** Frontend test: pivot data with `SALARY: +3000/mo` and `FOOD: −500/mo` → donut data contains FOOD only; trend series do not include SALARY. Run `bun run --filter vision-frontend test`.

- [ ] 🔼 Dashboard "Spending by Category" donut actually shows transaction *counts* over the latest 50 transactions of all time — not this month, not spending 🛫 2026-06-10
  - **Files:** `apps/frontend/src/pages/DashboardPage.tsx` lines 76 (`useTransactions({ limit: 50 })`), 195-214 (`categoryBreakdown` counts every fetched transaction incl. income), 216-240 (`categoryData` top-5 + Other), 458-459 + 470 (card renders `categoryPie.title`/`categoryPie.desc` and passes `formatValue={(v) => String(v)}`).
  - **Why wrong:** The card header says **"Spending by Category" / "This month's breakdown"** (`en.ts:353-355`), but the data is (a) the 50 most recent transactions regardless of month (the list query is `ORDER BY t.date DESC LIMIT 50` — an import or a busy week pushes the window far short of a month; a quiet month stretches it across several months), (b) a **count** of transactions per category, not an amount, and (c) includes income transactions (a salary row counts toward its category). The tooltip shows a bare integer styled like every other money tooltip. Nothing on the card communicates any of the three.
  - **Fix (pick one):** (a) Reuse the statistics category aggregation scoped to the current month: fetch `getAggregationCategoryPivot` (or a `start`/`end`-bounded variant) for the current month, sum expense amounts per category, format tooltips as currency — making the card match its title; or (b) keep counts but fix the copy (`categoryPie.title` → "Recent activity by category", desc → "Last 50 transactions") and label the tooltip value as a count. Option (a) matches user expectation on a finance dashboard.
  - **Verify:** With seeded data spanning two months where this month has 3 FOOD transactions totalling −300 and last month has 47 others: after fix (a) the donut shows FOOD −300 only; after fix (b) the copy no longer claims "this month"/"spending". Run `bun run --filter vision-frontend test` + visual check.

- [ ] 🔼 "Top Recipients by year" can never honor category exclusions — missing through the whole chain, and the filtered query is disabled when only categories are excluded 🛫 2026-06-10
  - **Files:** `apps/node-backend/src/repositories/infoRepositoryRecipients.js` lines 148-162 (`getRecipientByYear` builds only `recExclude`; no category clause — contrast `getRecipientInsights` lines 22-34 which supports both); `apps/node-backend/src/routes/aggregations.js` lines 217-223 (parses only `excluded_recipient_ids`); `apps/frontend/src/lib/api/aggregations.ts` lines 147-158 (wrapper has no `excluded_category_ids` param); `apps/frontend/src/hooks/useStatistics.ts` lines 269-281 (filtered query sends only recipient ids, and `enabled: filteredEnabled && settingsExcludedRecIds.length > 0` at line 279) + line 326 (falls back to the **unfiltered** payload).
  - **Why wrong:** Every other statistics chart applies category exclusions (incl. hidden categories) server-side via `useExcludedIds`. For the year-filtered Top Recipients view: a user who excludes only categories (the common "hide internal transfers / rent" setup) gets `recipientByYearFilteredQuery` disabled → line 326 silently serves **unfiltered** data → selecting a year in the Top Recipients chart shows totals that include excluded-category transactions, while the "All years" view of the *same chart* (from `recipientInsights`, which does pass categories) excludes them — the chart contradicts itself when switching the year dropdown.
  - **Fix:** Add `excludedCategoryIds` to `getRecipientByYear` (same `COALESCE(t.category_id, r.default_category_id) NOT IN` clause as `getRecipientInsights`; needs the `LEFT JOIN recipients r` that's already there), parse `excluded_category_ids` in the route, add the param to the API wrapper, pass `effectiveExcludedCategoryIds` in `useStatistics` and change the enabled gate to `filteredEnabled` (matching the other filtered queries). Coordinate clause style with the round-4 "exclusion drift" item (alias-aware recipient exclusion + 3-level category COALESCE) rather than adding a fifth variant.
  - **Verify:** Backend test: seed recipient A with transactions in category X; `getRecipientByYear` with `excludedCategoryIds:[X]` excludes them. Frontend test: with category-only exclusions, the by-year query fires with the category param (currently never fires). Run `bun run test` + `bun run --filter vision-frontend test`.

- [ ] 🔽 Bank-balances history chart: stacked area breaks with negative balances, and accounts whose *current* balance is zero vanish from all history 🛫 2026-06-10
  - **Files:** `apps/frontend/src/components/dashboard/BankBalancesWidget.tsx` lines 89 (`visibleAccounts` filter), 92-105 (`chartData` built only from `visibleAccounts`; the fetched `total_history`/`total` field at 103 is never rendered), 191-204 (`<AreaChart stacked>`); `apps/frontend/src/components/charts/AreaChart.tsx` lines 152-163 (stacked y-domain from per-datum **sums**).
  - **Why wrong:** (a) Balances can legitimately be negative (credit line, overdraft). visx `AreaStack` uses d3's default `stackOffsetNone`, so band edges are cumulative sums that *decrease* through a negative series; with e.g. account A = +10 000 and B = −4 000 the band edges reach 10 000 while the stacked domain max is the **sum** 6 000 (`AreaChart.tsx:153-158`) → A's band top is drawn above the plot area (there is no clipPath) and the bands overlap — the chart is visually wrong, not just ugly. (b) `visibleAccounts` (current balance ≈ 0 excluded — sensible for the balance *cards*) also drives the **history** series, so an account closed last month with years of large balances disappears from the entire 12-month chart, understating every past month; the backend's `total_history` (which includes it) is fetched and silently dropped.
  - **Fix:** (a) Either render the per-account history unstacked (multi-line, `stacked` off) — truthful with any sign — or add a `total` series from `total_history` and keep stacking only when all values ≥ 0. (b) Build `chartData`/`accountSeries` from accounts with *any* non-zero history balance (`history[acct].some(h => h.balance !== 0)`), keeping the ≈0 filter only for the balance cards grid.
  - **Verify:** Storybook/test fixture with one positive and one negative account: no path extends beyond the plot rect; a closed account (current 0, past 10 000) appears in past months and the chart's top edge matches `total_history`. Run `bun run --filter vision-frontend test` + visual check.

- [ ] 🔼 Sankey & Recipient-Insights surfaces bypass the centralized exclusion resolver — hidden categories (and on insights, *all* category exclusions) leak in; **user-confirmed:** the statistics Recipients-tab KPI cards ignore excluded recipients 🛫 2026-06-10
  - **User-confirmed symptom (2026-06-10, priority raised 🔽→🔼):** on the Statistics page Recipients tab, the "Top Recipient" card and its neighbors ("Top 10 Total", "Avg Transaction" — `RecipientInsightsTab.tsx` lines 166-216, derived from `top10 = filteredData.topMerchants.slice(0,10)`) still show recipients the user excluded. Mechanism: the tab's only exclusion is the client-side post-filter `!excludedRecipientIds.has(m.recipientId)` (lines 67-79), but the server returns **alias-rolled-up primary ids** (`COALESCE(pr.id, r.id)`, `infoRepositoryRecipients.js:39-46`) — so whenever the excluded recipient is an alias of a merged primary (or the exclusion set holds the alias id), the Set lookup never matches and the merchant stays in every KPI card, the MoM alerts, and the details table. The server-side `recExclude` clause is alias-aware and the API wrapper already accepts the params (`lib/api/aggregations.ts:51-54`) — they are just never sent.
  - **Files:** `apps/frontend/src/components/statistics/SankeyTab.tsx` lines 38-39 (uses raw `settings.excludedCategoryIds`/`excludedRecipientIds`); `apps/frontend/src/components/statistics/RecipientInsightsTab.tsx` lines 60-69 and `apps/frontend/src/pages/RecipientInsightsPage.tsx` lines 41-63 (fetch `getRecipientInsights` with **no** exclusion params, then client-side filter only `topMerchants`/`monthOverMonth` rows by raw recipient ids).
  - **Why wrong:** `useExcludedIds` exists precisely so all money surfaces share one exclusion set (settings + hidden categories — see its header comment). SankeyTab passes raw settings ids, so transactions in **hidden categories** (`excludeHiddenCategories`) appear in the money-flow diagram while every other statistics chart drops them. The two Recipient-Insights surfaces are worse: the server query runs with no exclusions at all, so (a) category exclusions and hidden categories never apply to merchant totals/KPIs, and (b) the client-side recipient filter compares raw settings ids against the server's **rolled-up primary** ids (`COALESCE(pr.id, r.id)`) — excluding an alias recipient filters nothing. The backend already accepts both params (`getRecipientInsights(targetCurrency, { excludedCategoryIds, excludedRecipientIds })`), and `useStatistics`' own copy of this query passes them (lines 285-298) — these three call sites just don't.
  - **Fix:** Replace raw `settings.excluded*` with `useExcludedIds('statistics')` in all three components and pass the resolved sets as query params (drop the client-side post-filtering); include the resolved ids in the query keys.
  - **Verify:** Frontend test: with a hidden category configured, the sankey query is called with that category id (currently absent); recipient-insights fetch carries both param sets and an excluded alias's transactions disappear from merchant totals. Run `bun run --filter vision-frontend test`.

- [ ] 🔽 Forecast diagnostics "Suggested Ensemble Weights" don't match what `ensemble_imse` actually does (1/MAE² unshrunk vs shrunk 1/RMSE² + uniform floor) 🛫 2026-06-10
  - **Files:** `apps/frontend/src/components/dashboard/CashFlowForecastDiagnostics.tsx` lines 146-153 (`totalInvMSE` computed from `1/(mae*mae)`); `apps/node-backend/src/services/calculations/forecast/methods/ensemble.js` (`weightsFromAccuracy`: inverse-MSE on **RMSE** with sample-size shrinkage `(n·rmse + K·meanRmse)/(n+K)` plus a uniform-blend floor); `apps/frontend/src/locales/en.ts:288-290`.
  - **Why wrong:** The panel is presented next to the ensemble method as its weight preview, but it computes inverse-squared **MAE** with no shrinkage and no uniform floor — on a short backtest the panel can show one method at 80% while the actual ensemble (shrunk + floored) gives it far less. Even the note contradicts itself: "Inverse-MSE weights based on backtest MAE" (MSE ≠ MAE²). The variable is named `totalInvMSE` while consuming MAE.
  - **Fix:** Either compute the displayed weights the same way the backend does (use `rmse` + replicate shrinkage/floor — best: have the backend include its actual weights in the diagnostics payload so the two can't drift), or relabel honestly ("Relative accuracy (1/MAE²), illustrative — actual ensemble weights use shrunk inverse-MSE").
  - **Verify:** Unit-compare panel weights against `weightsFromAccuracy` output for the same accuracy rows after the fix. Run both suites.

- [ ] 🔽 Portfolio Overview "Last 30 days" sparkline shows cost-basis *contributions* but is styled as performance (green/red ±% badge) — and the same label on the Performance page means portfolio *value* 🛫 2026-06-10
  - **Files:** `apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx` lines 156-195 (series = cumulative buys+gifts−sells flow; the component docstring in `components/portfolio/TotalValueCard.tsx:5` says "30-day cost-basis sparkline"), 285 (label `portfolio.last30Days` = "Last 30 days"); `apps/frontend/src/components/portfolio/TotalValueCard.tsx` lines 164-190 (delta % badge, green/red + trend arrow); `apps/frontend/src/pages/portfolio/PerformancePage.tsx` lines 90-95 + 143-146 (same card pattern + same label, but the series is the 1-month *value* snapshots).
  - **Why wrong:** On the Overview, buying €5 000 of stock renders a green "+x%" 30-day trend on the **Total Value** card even if the position immediately lost money; selling renders red even after a gain. A user comparing the two pages sees the same card title + label with different semantics. The math is fine — the presentation misattributes it.
  - **Fix:** Label it for what it is (e.g. `portfolio.netContributions30d`: "Net contributions (30d)") and use a neutral color for the badge (contributions have no win/lose valence), or switch the Overview sparkline to the same 1-month value series the Performance page uses (`/portfolio-performance?period=1m` is already cached by react-query when the user visits Performance).
  - **Verify:** Visual check of both cards; if relabeled, `bun run validate-locales` after adding the key (en + nl).

- [ ] 🔽 `LineChart` primitive: `connectNulls` semantics are inverted (latent — no current consumer regresses) 🛫 2026-06-10
  - **File:** `apps/frontend/src/components/charts/LineChart.tsx` lines 197-230.
  - **Why wrong:** `connectNulls !== false` (the default, "connect") keeps all rows and sets a `defined` guard (lines 226-229) — in d3/visx `defined` **splits** the path at the null points, i.e. it *gaps*. `connectNulls: false` ("gap") instead pre-filters the nulls out (lines 200-205), producing one continuous path — i.e. it *connects*. Exactly backwards. It happens to be invisible today because every consumer's nulls are at the head or tail of the series (forecast methods are future-only, actuals stop at today; `forecastMerge.ts` lines 70/85/97/106 and `CashFlowComparisonChart.tsx:77` rely on it only for leading/trailing nulls, where filter-vs-gap renders identically) — but the first consumer with an *interior* gap (e.g. a category trend without zero-fill) gets the opposite of what it asks for.
  - **Fix:** Swap the two behaviors: default/`true` → pass unfiltered data with **no** `defined` guard after filtering nulls out (continuous), `false` → keep all data + `defined` guard (gaps). Add a unit test for both modes with an interior null.
  - **Verify:** Frontend test rendering a 3-point series `[1, null, 3]`: `connectNulls: true` produces one path segment, `false` produces two. Run `bun run --filter vision-frontend test`.

- [ ] ⏬ Dead chart code: `CashFlowComparisonChart` and `MonthlySpendingChart` have zero consumers 🛫 2026-06-10
  - **Files:** `apps/frontend/src/components/dashboard/CashFlowComparisonChart.tsx` (174 lines; only reference is a comment in `CashFlowForecastChart.tsx:2` "replaces CashFlowComparisonChart"), `apps/frontend/src/components/dashboard/MonthlySpendingChart.tsx` (113 lines; zero references — verified by grep over `apps/frontend/src`). The `apiClient.getCashflowComparison` wrapper (`lib/api.ts:124`) also has no production caller — only `types/generated.ts`/msw reference the endpoint.
  - **Why it matters:** Both encode money-display logic (tabs, diff badges, i18n keys) that future audits keep paying to re-verify; the comparison chart still wires `connectNulls` and day-indexed merging that no longer runs. The backend `/api/aggregations/cashflow-comparison` endpoint (which has the already-filed executed-planned double-count) keeps a frontend-looking consumer that doesn't exist.
  - **Fix:** Delete both components and their now-unused i18n keys (`cashflow.24monthAvg`, `cashflow.thisMonth` stays — used by the forecast chart — check each with grep; `monthlySpending.*` go), and the `getCashflowComparison` wrapper if the team confirms no planned re-use; coordinate with the round-4 cashflow-comparison backend item (its repro path is then API-only). Run `bun run validate-locales` after key removal.
  - **Verify:** `bun run build` + `bun run --filter vision-frontend test` green after deletion; grep confirms no dangling imports.

**Charts audited & clean (recorded so the next audit can skip):** chart primitives BarChart
(incl. negative-value baseline handling), StackedBarChart/PieChart/DonutChart (consumers all
feed non-negative data), Sparkline, ChartTooltip viewport logic, ChartAxis; forecast chart
merge logic (`forecastMerge.ts` — band cumsum anchored at last actual, head/tail null
conventions); statistics MonthlyChart (3-mo trailing rolling average correct),
NetTrendChart, YearlyComparisonChart, TopRecipientsChart (label-collision edge only);
heatmap renderer (YTD = geometric compounding — correct; underlying month bucketing bug
already filed); PerformancePage transforms (naive value/invested cumulative return is a
documented-acceptable simplification; metrics cards intentionally period-independent);
NetWorth page/chart (peak/trough/days-tracked over raw snapshots; LTTB bug already filed);
WatchlistChartDialog (zero-target reference-line cosmetic edge only); MarketLookupPage
(backend filters null closes at `routes/marketLookup.js:235`); tax charts (PIT proration
documented and sum-consistent; asset-class tax bars; TOB/Reynders/TACR estimators previously
verified); AI-chat ToolResultCard (generic best-effort renderer; its data sources covered by
existing AI-chat tool items).

### Round 6 — calculations & statistics audit (2026-06-10)

Single-agent follow-up to Round 5 covering the **non-chart numbers**: statistics-page cards and
pivot/yearly tables, stat cards on every page (dashboard, planned payments, recipient insights,
net worth, tax overview), and the full investment-gain pipeline (frontend
`usePortfolioCalculations`/`usePortfolioSummaries`, per-asset pages, backend
`portfolioSummaryService`). Verified-clean list at the end. Existing items (unit-based fees/taxes
double-count, real-estate rent double-count, frontend gainLoss mirror, `totalInvested.abs()`,
average-vs-current denominator) were checked and not duplicated — two items below explicitly
extend them to branches/sites those items do **not** cover.

- [ ] ⏫ Frontend portfolio math ignores corporate-action transaction types — units, cost basis, and unrealized gain (absolute **and** relative) wrong after any split or return of capital 🛫 2026-06-10
  - **Files:** `apps/frontend/src/hooks/portfolio/usePortfolioCalculations.ts` lines 23-72 (`calculateCostBasis` handles only buy/gift/sell); `apps/frontend/src/pages/portfolio/StocksPage.tsx` lines 103-146 (`calculateFxAwarePnl` pool — same three types only); `apps/frontend/src/types/api.ts` line 268 (`PortfolioTxnType` omits the types entirely).
  - **Why wrong:** The DB accepts `split`, `merger`, `spinoff`, `return_of_capital` as first-class portfolio transaction types (`alembic/versions/0006_portfolio_event_types.py`), and the **backend** handles them everywhere: `utils/portfolioMath.js:134-139` (weighted-avg: split sets `totalUnits = units` [new post-split total], ROC reduces cost), lines 213/291 (FIFO/LIFO via `applyCorporateAction`), `services/portfolio/snapshotBuilder.js:368-372`. The **frontend** copy handles none of them, so for any holding with a split: `totalUnits` stays at the pre-split count while `current_price` is post-split → `currentValue = totalUnits × price` is ~halved after a 2:1 split, `avgCostBasis` is ~doubled, and `unrealizedGain` (absolute) and the displayed % are both wrong on StocksPage/MetalsPage/CryptoPage rows, PortfolioOverviewPage allocation + best/worst performers, and the frontend `totals` fallback — while the Dashboard/Performance surfaces (backend-served) show the correct numbers for the *same holding*. A `return_of_capital` row likewise leaves frontend cost basis too high (unrealized gain understated). The round-4 split item covers only the AI-chat tools; this is the user-facing pages.
  - **Also (same files, fix together):** the frontend `else` ("other" asset class) branch leaves `totalBuyCost` at 0 (`usePortfolioSummaries.ts:127-131`) while the backend sets `totalBuyCost = totalBuyAmount` (`portfolioSummaryService.js:196`) — so `gainLossPercent` is always 0% for "other" assets on the frontend and `PortfolioOverviewPage.tsx`'s performers filter (`s.totalBuyCost > 0`, line ~137) silently excludes them from best/worst.
  - **Fix:** Port the backend branches into the frontend `calculateCostBasis` (split: `totalUnits = units` when both > 0; ROC: `totalCost = max(0, totalCost − amount)`) and into `calculateFxAwarePnl`'s pool (split scales `poolUnits` only); add the four types to `PortfolioTxnType`; align the "other" branch's `totalBuyCost`. Merger/spinoff are cost-basis-neutral in the backend (`portfolioMath.js:89`) — mirror that (no-op on cost, document it). Long-term: this is the third hand-rolled cost-basis implementation — consider moving it to `packages/shared-utils` like the downsampler.
  - **Verify:** Frontend unit test: buy 10 units @100, split with `units = 20`, `current_price = 60` → `totalUnits === 20`, `currentValue === 1200`, `unrealizedGain === 200` (currently 600/−400 wrong); ROC of 100 reduces `totalCost` by 100. Run `bun run --filter vision-frontend test`.

- [ ] ⏫ Fixed-income `gainLoss` double-counts interest — `realizedGain = totalInterestPaid` AND `totalIncome` includes the same interest (backend **and** frontend, branch not covered by the filed double-count items) 🛫 2026-06-10
  - **Files:** `apps/node-backend/src/services/portfolio/portfolioSummaryService.js` lines 184 (`realizedGain = totalInterestPaid`) + 200-202 (`totalIncome` includes `totalInterestPaid`; `gainLoss = totalGain + totalIncome − …`); `apps/frontend/src/hooks/portfolio/usePortfolioSummaries.ts` lines 118 + 133-135 (identical structure).
  - **Why wrong:** Structurally the same error as the filed real-estate rent double-count, but in the fixed-income branch: interest received enters `gainLoss` once via `realizedGain` and again via `totalIncome`. Example: €10 000 deposit at 4%, one year of interest payments (€400), negligible accrual → economic gain €400, reported `gainLoss = 400 (realized) + 400 (income) = 800`. Affects `/api/info/portfolio-summary` totals (dashboard + performance headline cards), `breakdownSummary`, and the frontend mirror used by FixedIncomePage/PortfolioOverviewPage. ⚠ The round-4 frontend-mirror item's fix text says "Leave fixedIncome/other branches on the current formula" — that guidance is **wrong for interest** (it was scoped to the fees/taxes question); whoever fixes either item should fix this branch too or the items conflict.
  - **Fix:** In both files' fixed-income branch set `realizedGain = toDecimal(0)` (interest received is income, exactly like dividends — it's already in `totalIncome`; keep `unrealizedGain = accruedInterest`). If the UI should still show "realized = interest received" per investment, expose it as a display field without feeding it into `gainLoss` (same approach the real-estate item chose for rent).
  - **Verify:** Extend `apps/node-backend/tests/portfolioSummaryService.test.js`: fixed-income with one `interest` txn of 400 and zero fees/taxes/accrual → `gainLoss === 400` (currently 800); mirror the case in a frontend test. Run `bun run test` + `bun run --filter vision-frontend test`.

- [ ] 🔼 StocksPage/MetalsPage and CryptoPage "Net gain" cards double-subtract fees/taxes (hand-rolled formulas not covered by the round-4 `usePortfolioSummaries` item) 🛫 2026-06-10
  - **Files:** `apps/frontend/src/pages/portfolio/StocksPage.tsx` line 190 (`netGain = totalRealizedGain + totalUnrealizedGain + totalDividends − totalFees − totalTaxes`; MetalsPage reuses StocksPage); `apps/frontend/src/pages/portfolio/CryptoPage.tsx` line 60 (`netGain = totalRealizedGain + totalUnrealizedGain − totalFees − totalTaxes`).
  - **Why wrong:** Both pages' realized/unrealized inputs already fold the per-row `fees`/`taxes` columns into cost/proceeds — CryptoPage via `holding.realizedGain`/`unrealizedGain` (from `calculateCostBasis`), StocksPage via its FX-aware pool (`poolCostEur += (amount + fees + taxes) × rate`, `netProceeds = (amount − fees − taxes) × …`, lines 116-131). Subtracting `totalFees`/`totalTaxes` (which include those same per-row columns, `usePortfolioSummaries.ts:76-77`) removes them a **second** time. Concrete: buy 1 unit @100 with fee 10, price now 150 → unrealized = 40 (correct, fee already in cost), card shows `netGain = 40 − 10 = 30`. Only standalone `fee`/`tax` *transaction-type* rows should be subtracted. Same root cause as the round-4 ⏫ frontend item but in two additional hand-rolled sites that item doesn't list — fix in the same pass with the same final formula.
  - **Also (dormant):** StocksPage's non-FX fallback (`displayedPnlByHoldingId`, lines 152-156) labels `holding.gainLossPercent` — a *total-return* percent including dividends and realized gain — as the per-row "unrealized %" . Unreachable today (no caller passes `enableFxAwarePnl={false}`; default is `true`), but fix or delete the fallback while in the file.
  - **Verify:** Frontend test with the buy-100/fee-10/price-150 fixture: StocksPage and CryptoPage net-gain cards show 40 (currently 30). Run `bun run --filter vision-frontend test`.

- [ ] 🔼 Category pivot "Income"/"Expense" metrics classify by the sign of the category-month **net** — mixed-sign months are misclassified, the drill-through contradicts the cell, and Tax Overview inherits the skew 🛫 2026-06-10
  - **Files:** `apps/frontend/src/hooks/useStatistics.ts` lines 127-138 (`mapToStatisticsData`: one `item.total` per (category, period); `incomeAmount`/`expenseAmount` derived from its sign); root cause in `apps/node-backend/src/repositories/infoRepositoryStatistics.js` `getCategoryPivot` (lines 137-197) which returns a single **net** total per (category, period) with no sign-split. Consumers: `CategoryPivotTable.tsx` (`getPeriodValue`, lines 33-42 + drill URLs at 44-67), `TaxOverviewPage.tsx` lines 115-126 (`taxableIncomeByMonth` sums `cat.incomeMonths`).
  - **Why wrong:** A category-month containing both signs is netted *before* classification. Example: FOOD month with −300 purchases and +500 refund (return of a big purchase) → `item.total = +200` → pivot "Income" mode shows 200, "Expense" mode shows **0**, while clicking the cell drills to `/transactions?transaction_type=expense` showing the real −300. Conversely an income category-month that nets negative is dropped from `incomeMonths` (clamped to 0 by classification), so `TaxOverviewPage`'s taxable income by year **overstates** (a −500 correction month contributes 0 instead of −500). Whole months are also never split: income mode + expense mode don't sum to the "absolute" column for mixed months.
  - **Fix:** Backend: have `getCategoryPivot` return sign-split aggregates per (category, period) — `SUM(amount) FILTER (WHERE amount >= 0) AS income`, `SUM(amount) FILTER (WHERE amount < 0) AS expense` (per (category, day, currency) group for FX correctness) — and emit `{total, income, expense}` per pivot item. **Coordinate with the round-4 ⏫ perf item that already rewrites this exact query to SQL aggregation** — one rewrite should land both. Frontend: build `incomeMonths`/`expenseMonths` from the explicit fields instead of the sign heuristic.
  - **Verify:** Backend test: category with +500 and −300 in one month → pivot item `{total: 200, income: 500, expense: −300}`; frontend test: pivot table income mode shows 500, expense mode 300, absolute 200; Tax Overview taxable income uses the explicit income field. Run `bun run test` + `bun run --filter vision-frontend test`.

- [ ] 🔽 Recipient insights month-over-month compares a *partial* current month against the *full* previous month 🛫 2026-06-10
  - **File:** `apps/node-backend/src/repositories/infoRepositoryRecipients.js` lines ~92-140 (`momRawResult` window `t.date >= date_trunc('month', CURRENT_DATE) − 1 month`; `changePercent = (current − previous)/previous` over the two raw buckets).
  - **Why wrong:** On any day before month-end, `current` is month-to-date while `previous` is the whole prior month, so early in the month nearly every recipient shows a large spurious *decrease* ("Month-over-Month Changes — how your spending … changed vs. last month", `RecipientInsightsTab`/`RecipientInsightsPage` alert lists), and genuine increases are understated. The `previous > 0 && current > 0` filter hides new/stopped merchants but not the partial-window bias.
  - **Fix (pick one):** (a) compare like-for-like windows: current month-to-date vs previous month *through the same day-of-month* (`AND t.date <= date_trunc('month', CURRENT_DATE) − interval '1 month' + (CURRENT_DATE − date_trunc('month', CURRENT_DATE)))` on the previous bucket); or (b) compare the last two *complete* months and label accordingly. (a) matches the existing copy.
  - **Verify:** Backend test with a fixed clock mid-month: recipient spending evenly across both months shows ~0% change after the fix (currently ≈ −67% on day 10 of a 30-day month). Run `bun run test`.

- [ ] 🔽 Planned payments "Est. monthly" card: planned *income* inflates it (abs of amount), and mixed currencies are summed without conversion 🛫 2026-06-10
  - **File:** `apps/frontend/src/pages/PlannedPaymentsPage.tsx` lines 94-108 (`totalMonthly = Σ |amount| × frequency-multiplier` over active recurring rows).
  - **Why wrong:** (a) Planned transactions are signed (the cashflow forecast sums `pt.amount` signed; a recurring +2 000 salary is representable) but `Math.abs(p.amount)` counts income as if it were a monthly *cost* — the card reads as committed outgoings ("Est. monthly"). (b) `p.amount` is summed raw across rows whose `currency` can differ (`usePlannedPayments.ts:89` maps a per-row currency), then formatted in the default currency — a 500 USD subscription is counted as €500. Frequency multipliers themselves are fine (incl. the `every N days` → `30/N` mapping; loans land on monthly via the recurrence default).
  - **Fix:** Sum only `p.amount < 0` rows (or split into "monthly out" / "monthly in"), and convert per-row via the existing `useCurrencyConverter`/`convertToTarget` before summing.
  - **Verify:** Frontend test: rows [−100 EUR monthly, +2000 EUR monthly salary, −10 USD monthly] → card shows 100 + converted(10 USD), not 2 110. Run `bun run --filter vision-frontend test`.

- [ ] ⏬ Monthly-summary MV fast path omits zero-transaction months that the live path zero-fills — dashboard month set changes when exclusions toggle the path 🛫 2026-06-10
  - **File:** `apps/node-backend/src/repositories/infoRepo.monthly.js` — MV path (lines 29-85) emits only months present in `mv_monthly_summary` (no row for an empty month); live path (lines 109-211) `generate_series` + LEFT JOIN zero-fills every month in the window.
  - **Why wrong:** With no exclusions the dashboard uses the MV path: a month with zero transactions in the 6-month window is simply missing (5 bars in Monthly Trends); configure any exclusion → live path → the same month appears as a zero bar (6 bars). Same divergence class as the round-4 "MV converts at month-start FX" item (and the same fix gate would cover both — note it there).
  - **Fix:** Zero-fill the MV path over the same `generate_series` window after aggregation (cheap JS loop over ≤6 keys), or fold this into the round-4 MV-gating fix.
  - **Verify:** Backend test: seed data with an empty month inside the window; both paths return the same month keys. Run `bun run test`.

**Audited & clean (Round 6 — recorded so the next audit can skip):** statistics SummaryCards
(net = income − spending; averages divide by the zero-filled calendar month count on the
`all_time` live path), YearlySummaryTable (sums per-month converted values), monthly-summary
`buildMonthlySummary`, pivot drill-through URL construction (period bounds via `lastDayOfMonth`),
dashboard stat cards (latest-month-with-data semantics match their "most recent month" copy;
NetSummaryCard savings rate and income/spending split), planned payments frequency multipliers
and due-this-week/executed/pending counts, net-worth `monthlyChange` (last-snapshot-of-previous-
month baseline) and peak/trough/all-time change, recipient insights `avgAmount`, tax-overview
PIT-per-year proration and `pitForGross` year-snapshot selection, unit-based unrealized-gain
formula itself (`(price − avgCostBasis) × units` ≡ value − cost), `calculateAccruedInterest`
(simple interest since last payment) and projected annual interest, fixed-income/real-estate
`currentValue` definitions, `gainLossPercent` denominator (cumulative gross buy cost — a
convention, consistent between frontend and backend), StocksPage FX-aware realized/unrealized
pool math (modulo the corporate-action and net-gain items above), portfolio totals aggregation
in `usePortfolioSummaries.totals`, and `computeMetrics` CAGR (naive but documented-acceptable).

### Round 7 — user-reported (2026-06-10)

Three user reports investigated end-to-end. Report 1 (statistics Recipients-tab cards ignoring
excluded recipients) was traced to the already-filed Round 5 item "Sankey & Recipient-Insights
surfaces bypass the centralized exclusion resolver" — that item has been **amended in place** with
the confirmed symptom, the exact KPI-card lines, the alias-id root cause, and a priority bump
(🔽→🔼). Reports 2 and 3 are the new items below.

- [ ] 🔼 Dashboard "Balance History" chart: monthly datapoints but ~12 auto-generated sub-month x-ticks — duplicated/incorrect month labels; preferred fix is finer-grained data 🛫 2026-06-10
  - **Files:** `apps/frontend/src/components/dashboard/BankBalancesWidget.tsx` lines 92-105 (chartData = one point per month from `total_history`/`history`) + 191-201 (AreaChart with `xTickFormat="MMM yy"`, no `xTickValues`); `apps/frontend/src/components/charts/AreaChart.tsx` line 390 (`BottomAxis numTicks = max(2, floor(innerWidth / 90))`); backend `apps/node-backend/src/repositories/infoRepositoryBanks.js` lines 42-77 (months CTE = last 12 month-ends).
  - **Why wrong:** The data is one point per month-end (≤12 points; with ~6 months of history, 5-6 points — matching the user's "5-ish points of data"), but the x-axis is a `scaleTime` whose tick count comes from chart *width*, not data density: a full-width dashboard (~1100px inner) yields ~12 ticks. d3's time scale places those at "nice" sub-month intervals (every ~1-2 weeks across a 5-month domain), and each is formatted `"MMM yy"` → the axis reads "Feb 25 · Feb 25 · Mar 25 · Mar 25 · Apr 25 …" — many axis points, few datapoints, months apparently duplicated/wrong. (The 6-Month Trends bar chart is immune — band scale, one tick per bar; this is the only dashboard time-scale chart with monthly granularity.)
  - **Fix (option A — preferred by user: more granular data):** emit weekly (or daily (preferred by user)) balance points instead of month-ends. The backend already has the "latest balance ≤ day" machinery; change the `months` CTE to `generate_series` over weeks/days. ⚠ **Must land together with the round-4 ⏫ perf item on this same query** ("Bank-balances 12-month history query materializes ~12× the whole transactions table"): with the current ROW_NUMBER-over-join shape, going daily multiplies the blow-up ~30×; with that item's `LEFT JOIN LATERAL … LIMIT 1` rewrite, daily granularity is ~365×accounts cheap index probes. Keep the response size sane (52 weekly or ~365 daily points × accounts) and let the existing AreaChart density handle it; with ≥ tick-count datapoints the auto-ticks become unobjectionable.
  - **Fix (option B — minimal):** keep monthly data and pass `xTickValues={chartData.map(d => d.date)}` to the AreaChart (the prop exists and `NetWorthChart.tsx:151` already uses it this way) so ticks land exactly on the datapoints — 5-6 correct month labels, nothing in between.
  - **Verify:** With ~5 months of seeded history: option A → chart renders ≥20 points and axis labels show distinct dates; option B → exactly one tick per month present in the data, no duplicated labels. `bun run --filter vision-frontend test` + visual check at 1440px.

- [ ] 🔼 Portfolio chart LTTB downsampling: not needed at this app's scale, and it *amplifies* the bad kinesis price needles — remove (or raise threshold) and sanitize spikes at the source instead 🛫 2026-06-10
  - **Research conclusion (2026-06-10):** the downsampling is **not necessary** at realistic data volumes and is net-harmful; recommend rolling it back on the performance payload and fixing the kinesis needles with the sanitizer that net worth already uses.
  - **Where it runs:** backend `apps/node-backend/src/routes/info/_performanceHelpers.js:68` — `downsampleLTTB(periodMapped, 400, …)` on `/api/info/portfolio-performance` whenever a period has >400 daily snapshots (3y/all with >13 months of history); frontend `apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx:81-86` — LTTB to ≤400 points scaled by zoom (`maxPointsForZoom = max(150, min(500, 800/dayWidth))`).
  - **Why it's unnecessary:** (a) point counts are modest — daily snapshots are 365/yr, so even 10 years ≈ 3 650 points; the visx charts render each series as **one** SVG `<path>` (`LinePath`/`AreaClosed`), so per-point DOM cost — the original recharts-era motivation — is gone, and 1-4k-point paths render fine; hover lookup is a `bisector` (O(log n)). (b) payload saving is small: ~12 numeric fields/snapshot ≈ 270 KB raw (≈50 KB gzipped) for 3 years, cached 5 min (`PerformancePage` staleTime 300 s) on a self-hosted/LAN app. (c) the shared implementation has the filed ⏫ Round-1 correctness bug (first-bucket spikes dropped, last point duplicated) — removal closes that item's backend impact for free.
  - **Why it's harmful given the kinesis data quality issue:** kinesis sometimes reports a one-day price far too high that stabilises the next day (user-reported). LTTB selects the points with the **largest triangle area** — an isolated needle is mathematically guaranteed to be kept while its normal-valued neighbors are dropped, so on downsampled periods (3y/all) the needle is not only preserved but rendered **wider** (the line now bridges from days away straight to the spike), making bad data more prominent than the full-resolution chart would. The Net-Worth page is protected — `infoRepositoryNetWorth.js:206` runs `sanitizeIsolatedDailyInvestmentSpikes` (`infoRepositoryHelpers.js:222-260`: detects isolated log-ratio needles ≥18% with a normal prev→next bridge and replaces them with the geometric mean) **before** its data reaches the chart — but `/portfolio-performance` applies **no sanitization**, so the Performance page's value chart, heatmap month-ends, and metrics all see raw needles.
  - **Fix:** (1) Remove the `downsampleLTTB` call from `_performanceHelpers.js` (or, conservatively, raise `DOWNSAMPLE_THRESHOLD` to ~2 000 so only pathological histories downsample). (2) Port `sanitizeIsolatedDailyInvestmentSpikes` to the performance snapshot path — preferably inside `snapshotBuilder` when daily snapshots are computed (adapting it to the `value` + per-class value fields), so the chart, heatmap, and metrics all benefit and the fix covers every consumer; alternatively apply it in `buildPortfolioPerformancePayload` before mapping. (3) For `NetWorthPage`'s frontend LTTB: optional — it also caps `chartWidth` (points × dayWidth); either keep it (it operates on already-sanitized data) or replace with a plain `slice`-based cap; if both call sites drop LTTB, delete `packages/shared-utils/src/downsample.js` and close the Round-1 LTTB item as superseded. Longer-term: fix kinesis ingestion itself (reject/flag ticks that deviate >X% from the previous close and revert next day) so bad points never enter `asset_price_history`.
  - **Verify:** seed >400 daily snapshots including one synthetic 2× one-day needle: `/api/info/portfolio-performance?period=all` returns all snapshots 1:1 (no downsampling) with the needle smoothed by the sanitizer; Performance page "all" chart renders without the spike and without visible lag; `bun run test` (snapshot-builder + performance route suites) and the Round-1 LTTB item's status updated accordingly.
  - Fix: When double clicking a general category (so no specific detail of a category, a general category that contains details within the general category) in the category pivot table of the statistics page category section, the transactions aren't filtered correctly, showing an empty view and leaving the app in a broken state not allowing any other actions until a hard refresh.
  - Make the sidebar liquid glass too

### Carried over from May 2026 audit (pre-existing open items)

These three items predate the June audit (they were in TODO.md before it was rewritten) and are
still open — restored here so they aren't lost.

- [ ] ⏫ **Validate `/transaction-summary` grouped-scan rewrite on a running multi-currency DB** — `getTransactionSummary` (`apps/node-backend/src/repositories/infoRepositoryStatistics.js`) now pushes `COUNT/SUM/MIN/MAX … GROUP BY currency` into SQL and combines per-currency aggregates in JS (count = Σ; total = Σ sum_c×rate_c; min/max = min/max of (extremum_c×rate_c); valid because the default conversion is one latest rate per currency and rate_c > 0 is monotonic). Code-complete with unit tests for the JS combine math, but SQL correctness **cannot be proven by the Vitest suite** (tests mock `query()`). Validate: `bun run docker:dev` + `bun run db:upgrade`, seed multi-currency (USD+EUR) multi-year data with historical `exchange_rates`, diff endpoint output before vs after (must match exactly — read-only perf rewrite), confirm the win with `EXPLAIN ANALYZE`. 🛫 2026-06-01
- [ ] ⏫ **Validate report monthly-summary pushdown (all-time path) on a running multi-currency DB** — `apps/node-backend/src/repositories/infoRepo.monthly.js` live path now aggregates per `(date, currency)` in SQL (`COUNT`, `SUM … FILTER` sign-split) and converts each day's income/spending at that date's historical rate, bucketing into months in JS. Deliberately groups by **date** (not month) because the path uses per-transaction-date FX — a month-level GROUP BY would change results. Numerically identical to the old per-transaction loop by construction; unit test covers the bucketing. Same validation recipe as the item above. ⚠ Note the round-4 finding "Historical-FX conversion is silently inert for DB-sourced date rows" — if that bug affects this path, the "historical rate" conversion may currently be falling back to latest rates; check while validating. 🛫 2026-06-01
- [ ] 🔽 Visually spot-check `apps/frontend/src/components/ui/calendar.tsx` in the running app after its react-day-picker v10 migration ([[docs/adr/062-frontend-typecheck-gate-enforcement|ADR-062]]). The code migration is **done** — v10 `classNames` keys, the `Chevron` component, and the removed temporary cast (typecheck + frontend tests green) — but the theme (selected/today/range styling, nav button positioning) has not been confirmed visually. Open any date picker (e.g. Add Transaction → date) at 320/768/1440 in both themes. 🛫 2026-05-29

### Audited & clean (no action — recorded so the next audit can skip)

Verified correct on 2026-06-09: cost-basis math (weighted-avg/FIFO/LIFO incl. oversell clamps and
corporate actions), loan annuity/fixed-principal/interest-only formulas and rounding absorption,
splits/owed-summary invariants, recipient pg_trgm matching, shared money lib (banker's rounding,
Decimal), PIT bracket math, TOB/Reynders/TACR estimators, CSV formula-injection guard
(`lib/csv.js`), transactions list query (allowlisted sort columns, clamped limits, batched tag
fetch), `forEachConcurrent`, import commit transactional/checkpoint semantics, backup bundle crypto
(GCM v2 + per-bundle scrypt salt, byte-accurate zip-bomb caps, path-traversal guard), adapter
registry/detection ordering, AI-chat tools' SQL usage (repository-only, validated/clamped inputs),
and the AI-chat planned-tool recurrence walk (UTC-anchored, guarded).
