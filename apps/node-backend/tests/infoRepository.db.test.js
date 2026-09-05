/**
 * Real-Postgres tests for the infoRepository barrel — the sub-repositories that
 * only reach a consumer through it and have no dedicated DB suite of their own:
 * `getNetWorthFromSnapshots` (infoRepositoryNetWorth), `getPlannedExpensesNextMonth`
 * (infoRepositoryPlanned) and `getAverageVsCurrentSpending`
 * (infoRepositoryAverageVsCurrent), plus the barrel's own assembly.
 *
 * DB-backed complement to infoRepository.test.js (which stays: it runs without a
 * DB). That mock suite dispatches on SQL substrings — `if (sql.includes('WITH
 * anchor'))`, `if (sql.includes('balance_series'))` — to decide which canned rows
 * to hand back, so it asserts the shape of the JS reducers and the presence of
 * SQL fragments, never what the statements return. Everything here runs against
 * the migrated schema: the daily balance-series walk and the shared anchor+delta
 * lateral resolving over real NUMERIC/DATE columns, `portfolio_performance_snapshots`
 * joined by day, the transaction-flow fallback, the planned-transaction recurrence
 * expansion off real DATE values, and the 6-month/current-month aggregation windows.
 *
 * The other barrel members already have dedicated DB suites — statistics
 * (infoRepoStatistics.db.test.js), banks (infoRepoBanks.db.test.js), monthly
 * (infoRepoMonthly.db.test.js), forecast (infoRepoForecast.db.test.js) and
 * recipients (infoRepositoryRecipients.db.test.js) — so they are only smoke-checked
 * here for barrel wiring.
 *
 * Determinism: net-worth day series and the planned-expense window are anchored
 * on the APP-TIMEZONE today (ADR-009), so those fixtures are dated with the very
 * same `todayAppDateString()` helper the repository uses rather than SQL's
 * `CURRENT_DATE` — the two can disagree for the last hours of a UTC day.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import infoRepository from "../src/repositories/infoRepository.js";
import { clearMvCache } from "../src/repositories/infoRepositoryHelpers.js";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.js";
import { closePool } from "../src/database/connection.js";
import {
  todayAppDateString,
  addDaysYmd,
  firstOfMonthYmd,
} from "../src/lib/timezone.js";

const cat = {};
const rec = {};

const TODAY = () => todayAppDateString();

async function seedBase() {
  const pool = getTestPool();
  for (const [key, [general, detail]] of Object.entries({
    Food: ["Food", "Groceries"],
    Rent: ["Home", "Rent"],
  })) {
    const { rows } = await pool.query(
      "INSERT INTO categories (general, detail) VALUES ($1, $2) RETURNING id",
      [general, detail],
    );
    cat[key] = rows[0].id;
  }
  const { rows } = await pool.query(
    `INSERT INTO recipients (name, normalized_name) VALUES ('Misc Payee', 'misc payee') RETURNING id`,
  );
  rec.misc = rows[0].id;
}

/** Create an accounts row with explicit net-worth attributes. */
async function addAccount(
  name,
  { type = "checking", inNetWorth = true, currency = "EUR" } = {},
) {
  const { rows } = await getTestPool().query(
    `INSERT INTO accounts (name, display_name, type, in_net_worth, currency)
     VALUES ($1, $1, $2::account_type, $3, $4) RETURNING id`,
    [name, type, inNetWorth, currency],
  );
  return rows[0].id;
}

async function insertTxn({
  date,
  amount,
  currency = "EUR",
  bank = "MAIN BANK",
  balance = null,
  categoryId = null,
  isActive = true,
  isTransfer = false,
}) {
  if (bank) {
    await getTestPool().query(
      `INSERT INTO accounts (name, display_name) VALUES ($1, $1)
       ON CONFLICT (lower(btrim(name))) DO NOTHING`,
      [bank],
    );
  }
  const { rows } = await getTestPool().query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, category_id, bank_account, balance, is_active, is_transfer)
     VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      date,
      amount,
      currency,
      rec.misc,
      categoryId,
      bank,
      balance,
      isActive,
      isTransfer,
    ],
  );
  return rows[0].id;
}

/**
 * Full fixture wipe, mirroring the suite's own `afterEach` exactly (tables +
 * caches). Shared so a test that needs to wipe and rebuild mid-test — the
 * suite's `afterEach` only runs BETWEEN tests — can't drift from it and
 * silently miss a table or a cache clear the way two local subsets once did.
 */
async function wipeAll() {
  const pool = getTestPool();
  await pool.query("DELETE FROM planned_transactions");
  await pool.query("DELETE FROM transactions");
  await pool.query("DELETE FROM portfolio_performance_snapshots");
  await pool.query("DELETE FROM accounts");
  await pool.query("DELETE FROM recipients");
  await pool.query("DELETE FROM categories");
  await pool.query("DELETE FROM exchange_rates");
  await pool.query(`DELETE FROM user_settings WHERE key = 'includeTransfers'`);
  for (const bag of [cat, rec]) for (const k of Object.keys(bag)) delete bag[k];
  clearMemoryCache();
  clearMvCache();
}

async function insertSnapshot(date, value, currency = "EUR") {
  await getTestPool().query(
    `INSERT INTO portfolio_performance_snapshots (snapshot_date, value, currency)
     VALUES ($1::date, $2, $3)`,
    [date, value, currency],
  );
}

async function insertPlanned({
  date,
  amount,
  currency = "EUR",
  categoryId = null,
  recurring = false,
  pattern = null,
  isActive = true,
  isExecuted = false,
}) {
  const { rows } = await getTestPool().query(
    `INSERT INTO planned_transactions
       (planned_date, amount, currency, recipient_id, category_id, is_recurring, recurrence_pattern, is_active, is_executed)
     VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      date,
      amount,
      currency,
      rec.misc,
      categoryId,
      recurring,
      pattern,
      isActive,
      isExecuted,
    ],
  );
  return rows[0].id;
}

describe.skipIf(!hasTestDatabase())(
  "repositories/infoRepository barrel (real DB)",
  () => {
    beforeAll(async () => {
      expect(
        process.env.DATABASE_URL,
        "DATABASE_URL must equal TEST_DATABASE_URL for this suite (see scripts/with-test-db.sh)",
      ).toBe(process.env.TEST_DATABASE_URL);
      // DB suites share one database across parallel vitest workers — serialize.
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(wipeAll);

    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    // ───────────────────────────────────────────────────────────────────────────
    // Barrel assembly
    // ───────────────────────────────────────────────────────────────────────────
    it("assembles every sub-repository method onto one object, all callable against the DB", async () => {
      // The exact assembled surface. Note what is NOT here: the module's own
      // header comment (infoRepository.js:9-10) advertises `getStatistics` and
      // `getTransactionSummary` on infoRepositoryStatistics, and neither exists —
      // that sub-module exports getCategoryBreakdown/getBanks/getTransactionCount/
      // getCategoryPivot only. Pinning the key set keeps the drift visible.
      const expected = [
        "getAverageVsCurrentSpending",
        "getBankBalances",
        "getBanks",
        "getCashflowComparison",
        "getCashflowForecastData",
        "getCashflowForecastDataByCategory",
        "getCashflowForecastDataRolling",
        "getCategoryBreakdown",
        "getCategoryPivot",
        // Not a sub-repository query: the ADR-083 toggle read, exposed on the
        // barrel because the forecast cache key needs it before deciding whether
        // to call any of the queries around it.
        "getIncludeTransfers",
        "getMonthlyFinancialSummary",
        "getNetWorthFromSnapshots",
        "getPlannedExpensesNextMonth",
        "getRecipientByYear",
        "getRecipientInsights",
        "getRecipientPivot",
        "getTransactionCount",
      ];
      expect(Object.keys(infoRepository).sort()).toEqual(expected);
      for (const name of expected) {
        expect(
          typeof infoRepository[name],
          `${name} missing from the barrel`,
        ).toBe("function");
      }
      // Spread order matters: statisticsRepository and the sub-repositories must
      // not shadow one another. Smoke-call the ones with dedicated DB suites
      // through the barrel to prove the wiring, not the behaviour.
      await seedBase();
      expect(await infoRepository.getBanks()).toEqual([]);
      expect(await infoRepository.getTransactionCount()).toBe(0);
      expect(await infoRepository.getBankBalances()).toMatchObject({
        accounts: [],
        total_net_position: 0,
      });
      expect(
        (await infoRepository.getMonthlyFinancialSummary([])).months,
      ).toHaveLength(6);
      expect(await infoRepository.getRecipientInsights("EUR")).toEqual({
        topMerchants: [],
        monthOverMonth: [],
      });
    });

    // ───────────────────────────────────────────────────────────────────────────
    // getNetWorthFromSnapshots
    // ───────────────────────────────────────────────────────────────────────────
    describe("getNetWorthFromSnapshots", () => {
      it("returns the empty shape when there is no source record at all", async () => {
        expect(await infoRepository.getNetWorthFromSnapshots()).toEqual({
          current: { liquid: 0, liabilities: 0, investments: 0, netWorth: 0 },
          monthlyChange: 0,
          monthlyChangePercent: 0,
          snapshots: [],
        });
      });

      it("walks stamped balances daily, forward-fills investments and splits liabilities out of liquid", async () => {
        await seedBase();
        const today = TODAY();
        const d2 = addDaysYmd(today, -2);
        const d1 = addDaysYmd(today, -1);
        await addAccount("KBC");
        await addAccount("MORTGAGE", { type: "liability" });

        await insertTxn({
          date: d2,
          amount: "-10.00",
          bank: "KBC",
          balance: "4500.00",
        });
        await insertTxn({
          date: today,
          amount: "-10.00",
          bank: "KBC",
          balance: "5000.00",
        });
        await insertTxn({
          date: d2,
          amount: "-1.00",
          bank: "MORTGAGE",
          balance: "-300.00",
        });
        // Snapshots exist only on two of the three days — the missing day must
        // carry the previous value forward, not collapse to liquid-only.
        await insertSnapshot(d2, "3235");
        await insertSnapshot(today, "4470");

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.snapshots.map((s) => s.date)).toEqual([d2, d1, today]);
        expect(r.snapshots[0]).toMatchObject({
          liquid: 4500,
          liabilities: -300,
          investments: 3235,
          netWorth: 7435,
        });
        expect(r.snapshots[1]).toMatchObject({
          liquid: 4500,
          liabilities: -300,
          investments: 3235,
        }); // forward-filled
        expect(r.current).toEqual({
          liquid: 5000,
          liabilities: -300,
          investments: 4470,
          netWorth: 9170,
        });
      });

      it("resolves EVERY point with the anchor+delta definition, current and historical alike", async () => {
        await seedBase();
        const today = TODAY();
        const d1 = addDaysYmd(today, -1);
        await addAccount("KBC");
        await addAccount("CASH"); // manual-only: never stamped

        await insertTxn({
          date: d1,
          amount: "-10.00",
          bank: "KBC",
          balance: "5000.00",
        });
        await insertTxn({ date: today, amount: "150.00", bank: "KBC" }); // unstamped, after the anchor
        await insertTxn({ date: d1, amount: "200.00", bank: "CASH" }); // never stamped at all

        const r = await infoRepository.getNetWorthFromSnapshots();
        // History on d1: KBC's stamp 5000 + CASH's unstamped 200 — the manual-only
        // account is no longer invisible until the final point.
        expect(r.snapshots[0]).toMatchObject({ date: d1, liquid: 5200 });
        // Current: 5000 + 150 (post-anchor) + 200 (manual-only account) = 5350,
        // i.e. exactly the 150 that actually posted today above the d1 point.
        expect(r.current.liquid).toBe(5350);
        expect(r.current.netWorth).toBe(5350);
        expect(r.snapshots[r.snapshots.length - 1].liquid).toBe(5350);
      });

      it("falls back to the cumulative transaction flow when nothing is stamped anywhere", async () => {
        await seedBase();
        const today = TODAY();
        const d1 = addDaysYmd(today, -1);
        // No accounts row and no balance stamp → the stamped walk is empty.
        await insertTxn({ date: d1, amount: "1200.00", bank: null });
        await insertTxn({ date: today, amount: "300.00", bank: null });

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.snapshots.map((s) => [s.date, s.liquid])).toEqual([
          [d1, 1200],
          [today, 1500], // cumulative, not per-day
        ]);
        expect(r.current.liquid).toBe(1500);
      });

      it("overlays the live portfolio value on the latest point only", async () => {
        await seedBase();
        const today = TODAY();
        const d1 = addDaysYmd(today, -1);
        await addAccount("KBC");
        await insertTxn({
          date: d1,
          amount: "-1.00",
          bank: "KBC",
          balance: "1000.00",
        });
        await insertSnapshot(d1, "500");
        await insertSnapshot(today, "600");

        const r = await infoRepository.getNetWorthFromSnapshots("EUR", {
          liveInvestments: 5123.45,
        });
        expect(r.current.investments).toBe(5123.45);
        expect(r.current.netWorth).toBe(6123.45);
        expect(r.snapshots[0].investments).toBe(500); // earlier points untouched
        expect(r.snapshots[r.snapshots.length - 1].investments).toBe(5123.45);
      });

      it("measures monthlyChange against the last point before the current month", async () => {
        await seedBase();
        const today = TODAY();
        const monthStart = firstOfMonthYmd(today);
        const dayBefore = addDaysYmd(monthStart, -1);
        await addAccount("KBC");
        await insertTxn({
          date: dayBefore,
          amount: "-1.00",
          bank: "KBC",
          balance: "1000.00",
        });
        await insertTxn({
          date: today,
          amount: "-1.00",
          bank: "KBC",
          balance: "1100.00",
        });

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.current.netWorth).toBe(1100);
        expect(r.monthlyChange).toBe(100);
        expect(r.monthlyChangePercent).toBe(10);
      });

      it("excludes tracking-only accounts from both the history walk and the current point", async () => {
        await seedBase();
        const today = TODAY();
        await addAccount("KBC");
        await addAccount("TRACKING", { inNetWorth: false });
        await insertTxn({
          date: today,
          amount: "-1.00",
          bank: "KBC",
          balance: "1000.00",
        });
        await insertTxn({
          date: today,
          amount: "-1.00",
          bank: "TRACKING",
          balance: "9999.00",
        });

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.current.liquid).toBe(1000);
      });

      // The transaction-flow fallback fires whenever the balance walk returns no
      // rows — which is not only the unattributed ledger it was written for, but
      // ALSO a ledger where every account with activity is in_net_worth=false.
      // It used to sum ALL active transactions with no account / in_net_worth
      // predicate, so that ledger reported the tracking-only accounts' running
      // total as net worth (measured: liquid −143.25 where 0 is correct).
      it("reports 0 for a ledger whose only active accounts are tracking-only", async () => {
        await seedBase();
        const today = TODAY();
        const d1 = addDaysYmd(today, -1);
        await addAccount("TRACKING", { inNetWorth: false });
        // Unstamped on purpose: the walk is empty either way (no in-net-worth
        // account owns a row), so the fallback is what answers.
        await insertTxn({ date: d1, amount: "-133.25", bank: "TRACKING" });
        await insertTxn({ date: today, amount: "-10.00", bank: "TRACKING" });

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.current).toEqual({
          liquid: 0,
          liabilities: 0,
          investments: 0,
          netWorth: 0,
        });
        // Not `[0, 0]`: the two tracking rows do not define the series span
        // either, so there is no series at all rather than a run of zero days
        // measured out by excluded rows. See the span tests below.
        expect(r.snapshots).toEqual([]);
      });

      // ── first_data_date: the series START BOUND, under the same exclusion ────
      // `firstDataDateYmd` is what the day grid, the walk and the fallback are all
      // bounded by. It used to be MIN(date) over ALL active transactions, tracking
      // rows included, so rows that can never contribute a value still set the
      // span.

      it("does not let tracking-only rows set the series span", async () => {
        await seedBase();
        const today = TODAY();
        // 400 days back: far enough that the old span is unmistakable.
        const old = addDaysYmd(today, -400);
        await addAccount("TRACKING", { inNetWorth: false });
        await insertTxn({ date: old, amount: "-133.25", bank: "TRACKING" });
        await insertTxn({ date: today, amount: "-10.00", bank: "TRACKING" });

        const r = await infoRepository.getNetWorthFromSnapshots();
        // Was 401 all-zero snapshots spanning `old`..today — a 13-month chart
        // whose every point is 0 and whose length came entirely from the rows the
        // computation excludes.
        expect(r.snapshots).toEqual([]);
        expect(r.current).toEqual({
          liquid: 0,
          liabilities: 0,
          investments: 0,
          netWorth: 0,
        });
      });

      it("does not create a span from inactive-only tracking rows", async () => {
        await seedBase();
        const today = TODAY();
        const old = addDaysYmd(today, -400);
        await addAccount("TRACKING", { inNetWorth: false });
        await insertTxn({ date: old, amount: "-133.25", bank: "TRACKING" });
        await getTestPool().query(`UPDATE transactions SET is_active = false`);

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.snapshots).toEqual([]);
      });

      it("does not create a span from inactive-only in-net-worth rows", async () => {
        await seedBase();
        const old = addDaysYmd(TODAY(), -30);
        await addAccount("KBC");
        await insertTxn({ date: old, amount: "100.00", bank: "KBC" });
        await getTestPool().query(`UPDATE transactions SET is_active = false`);

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.current).toEqual({
          liquid: 0,
          liabilities: 0,
          investments: 0,
          netWorth: 0,
        });
        expect(r.snapshots).toEqual([]);
      });

      it("still spans from the first IN-net-worth row when a tracking account is older", async () => {
        await seedBase();
        const today = TODAY();
        const old = addDaysYmd(today, -400);
        const d3 = addDaysYmd(today, -3);
        // The exclusion must narrow the span to the rows that count — never past
        // them. A real in-net-worth row keeps its full history.
        await addAccount("TRACKING", { inNetWorth: false });
        await addAccount("KBC");
        await insertTxn({ date: old, amount: "-1.00", bank: "TRACKING" });
        await insertTxn({
          date: d3,
          amount: "-10.00",
          bank: "KBC",
          balance: "1000.00",
        });

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.snapshots[0].date).toBe(d3);
        expect(r.snapshots).toHaveLength(4); // d3..today inclusive
        expect(r.snapshots.every((s) => s.liquid === 1000)).toBe(true);
      });

      // The invariant the span bug actually broke, in its strongest form: a
      // tracking-only account is not part of net worth, so adding one must not
      // move ANY field of the answer. It did — the phantom leading-zero region it
      // manufactured became the monthly-change baseline, so an account opened this
      // month reported its whole balance as this month's gain (measured 1050 where
      // 50 is the real movement) with monthlyChangePercent collapsing to 0.
      it("is completely unaffected by the presence of a tracking-only account", async () => {
        const today = TODAY();
        const monthStart = firstOfMonthYmd(today);

        /** Seed the in-net-worth half of the ledger; optionally an older tracking account. */
        async function build({ withTracking }) {
          await seedBase();
          if (withTracking) {
            await addAccount("TRACKING", { inNetWorth: false });
            await insertTxn({
              date: addDaysYmd(monthStart, -400),
              amount: "-133.25",
              bank: "TRACKING",
            });
            await insertTxn({
              date: today,
              amount: "-10.00",
              bank: "TRACKING",
            });
          }
          await addAccount("KBC");
          // Opens THIS month — that is what makes the baseline observable.
          await insertTxn({
            date: monthStart,
            amount: "-10.00",
            bank: "KBC",
            balance: "1000.00",
          });
          await insertTxn({ date: today, amount: "50.00", bank: "KBC" });
          return infoRepository.getNetWorthFromSnapshots();
        }

        const withTracking = await build({ withTracking: true });
        // The suite's afterEach only runs between tests; this test builds twice.
        await wipeAll();
        const without = await build({ withTracking: false });

        expect(withTracking).toEqual(without);
        // Anchored independently of the day of month, so this stays deterministic:
        // the span starts where the in-net-worth account does, not 400 days early.
        expect(withTracking.snapshots[0].date).toBe(monthStart);
        expect(withTracking.current.liquid).toBe(1050);
      });

      // ── the same span pathology, other input: UNATTRIBUTED rows ──────────────
      // A row with a NULL account_id is not positively attributed to a
      // tracking-only account, so the tracking exclusion says nothing about it —
      // yet the WALK cannot value it either (there is no account to join it to).
      // Whenever the walk is what answers, such a row used to set the START BOUND
      // of a series it never appears in. Measured on the ledger below before the
      // fix: 21 snapshots with 17 leading all-zero days, monthlyChange 1000 with
      // monthlyChangePercent 0, and the +7.00 never counted in any snapshot.
      //
      // The exclusion has to be CONDITIONAL, which is what makes this different
      // from the tracking-only case: the transaction-flow fallback deliberately
      // counts these rows (they are the unattributed ledger it exists for), so the
      // date probe drops them only when it can tell the walk will answer — see
      // WALK_ANSWERS_CTE in infoRepositoryNetWorth.js. The two tests after this
      // one pin both sides of that condition.
      it("is completely unaffected by unattributed rows when the walk is what answers", async () => {
        const today = TODAY();
        const monthStart = firstOfMonthYmd(today);

        /** Seed the in-net-worth half; optionally an older UNATTRIBUTED row. */
        async function build({ withUnattributed }) {
          await seedBase();
          if (withUnattributed) {
            // account_id NULL behind a bank_account string with no accounts row —
            // a synthetic legacy shape (the trigger only resolves an UPDATE
            // against an existing account).
            await insertTxn({
              date: addDaysYmd(monthStart, -400),
              amount: "7.00",
              bank: null,
            });
            await getTestPool().query(
              `UPDATE transactions SET bank_account = 'LEGACY BANK'`,
            );
            expect(
              (
                await getTestPool().query(
                  `SELECT count(*)::int AS n FROM transactions WHERE account_id IS NULL`,
                )
              ).rows[0].n,
            ).toBe(1);
          }
          await addAccount("KBC");
          // Opens THIS month — that is what makes the baseline observable.
          await insertTxn({
            date: monthStart,
            amount: "-10.00",
            bank: "KBC",
            balance: "1000.00",
          });
          await insertTxn({ date: today, amount: "50.00", bank: "KBC" });
          return infoRepository.getNetWorthFromSnapshots();
        }

        const withUnattributed = await build({ withUnattributed: true });
        // The suite's afterEach only runs between tests; this test builds twice.
        await wipeAll();
        const without = await build({ withUnattributed: false });

        expect(withUnattributed).toEqual(without);
        expect(withUnattributed.snapshots[0].date).toBe(monthStart);
        expect(withUnattributed.current.liquid).toBe(1050);
        // The 7.00 is nowhere in the answer: the walk cannot value it, and the
        // fallback that would have counted it never runs here.
        expect(
          withUnattributed.snapshots.some(
            (s) => s.liquid === 7 || s.liquid === 1007,
          ),
        ).toBe(false);
      });

      // The other side of the condition, and the reason it cannot be an
      // unconditional exclusion: when the FALLBACK is what answers, the
      // unattributed rows ARE the ledger, and dropping them from the probe would
      // blank the chart of exactly the install the fallback exists for. (The
      // plain unattributed ledger is covered further down; this pins the awkward
      // shape — an in-net-worth account exists, but every one of its rows is
      // future-dated, so the walk's grid ends before it and the walk still cannot
      // answer.)
      it("still lets unattributed rows set the span when the walk cannot answer", async () => {
        await seedBase();
        const today = TODAY();
        const d12 = addDaysYmd(today, -12);
        await insertTxn({ date: d12, amount: "1200.00", bank: null });
        await getTestPool().query(
          `UPDATE transactions SET bank_account = 'LEGACY BANK'`,
        );
        await addAccount("KBC");
        await insertTxn({
          date: addDaysYmd(today, 5),
          amount: "500.00",
          bank: "KBC",
          balance: "5000.00",
        });

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.snapshots[0].date).toBe(d12);
        expect(r.snapshots).toHaveLength(13); // d12..today inclusive
        // Every historical day is the fallback's running total over the
        // unattributed rows. The unified current-point override is also bounded
        // at today, so the future account row cannot replace the final value.
        expect(r.snapshots.every((s) => s.liquid === 1200)).toBe(true);
      });

      // The strongest form of "never past them", on a ledger that actually looks
      // like a user's: FULL-ARRAY equality over every retained day of a mixed
      // ledger — two in-net-worth accounts in two currencies, a liability, a
      // tracking-only account, unattributed rows, and a sparse investments
      // series. The single-account guard above ("still spans from the first
      // IN-net-worth row…") pins a length and one repeated liquid figure, so a
      // narrowing that clipped a day off the front of a multi-account ledger, or
      // that moved the start onto the WRONG account's first row, would pass it.
      // Every value here is hand-computed from the fixture, not captured output.
      it("keeps every retained day intact on a realistic mixed ledger", async () => {
        await seedBase();
        const today = TODAY();
        const d = (n) => addDaysYmd(today, -n);
        // USD flat at 0.5 EUR across the whole window (and before it), so the
        // conversion cannot mask an accumulation error behind a moving rate.
        for (let n = 32; n >= 0; n--) {
          await getTestPool().query(
            `INSERT INTO exchange_rates (currency_code, rate_date, rate_to_eur, is_latest)
           VALUES ('USD', $1::date, 0.5, $2)`,
            [d(n), n === 0],
          );
        }

        await addAccount("KBC");
        await addAccount("USD SAVINGS", { currency: "USD" });
        await addAccount("MORTGAGE", { type: "liability" });
        await addAccount("OLD TRACKER", { inNetWorth: false });

        // Neither of these can contribute to any snapshot, and neither may set
        // the span: the tracking rows are excluded outright, the unattributed
        // ones are excluded because the walk is what answers here.
        await insertTxn({
          date: d(28),
          amount: "-500.00",
          bank: "OLD TRACKER",
        });
        await insertTxn({ date: d(30), amount: "99.00", bank: null });
        await insertTxn({
          date: d(25),
          amount: "11.00",
          currency: "USD",
          bank: null,
        });
        await getTestPool().query(
          `UPDATE transactions SET bank_account = 'LEGACY BANK' WHERE account_id IS NULL`,
        );
        expect(
          (
            await getTestPool().query(
              `SELECT count(*)::int AS n FROM transactions WHERE account_id IS NULL`,
            )
          ).rows[0].n,
        ).toBe(2);

        // The in-net-worth half. KBC opens the span at d10.
        await insertTxn({
          date: d(10),
          amount: "-20.00",
          bank: "KBC",
          balance: "2000.00",
        });
        await insertTxn({ date: d(5), amount: "250.00", bank: "KBC" }); // unstamped, after the anchor
        await insertTxn({
          date: d(8),
          amount: "100.00",
          currency: "USD",
          bank: "USD SAVINGS",
        });
        await insertTxn({
          date: d(3),
          amount: "-40.00",
          currency: "USD",
          bank: "USD SAVINGS",
        });
        await insertTxn({
          date: d(6),
          amount: "-1000.00",
          bank: "MORTGAGE",
          balance: "-90000.00",
        });
        await insertSnapshot(d(7), "3000");
        await insertSnapshot(d(1), "3300"); // gap on d(6)..d(2) → forward-fill

        // Hand-computed: KBC 2000 (stamp) → 2250 from d5; USD 100 → 60 from d3, at
        // 0.5 → 50 then 30; MORTGAGE −90000 from d6; investments 3000 from d7,
        // 3300 from d1. netWorth = liquid + liabilities + investments.
        const expected = [
          [d(10), 2000, 0, 0],
          [d(9), 2000, 0, 0],
          [d(8), 2050, 0, 0],
          [d(7), 2050, 0, 3000],
          [d(6), 2050, -90000, 3000],
          [d(5), 2300, -90000, 3000],
          [d(4), 2300, -90000, 3000],
          [d(3), 2280, -90000, 3000],
          [d(2), 2280, -90000, 3000],
          [d(1), 2280, -90000, 3300],
          [today, 2280, -90000, 3300],
        ].map(([date, liquid, liabilities, investments]) => ({
          date,
          liquid,
          liabilities,
          investments,
          netWorth: liquid + liabilities + investments,
        }));

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.snapshots).toEqual(expected);
        expect(r.current).toEqual({
          liquid: 2280,
          liabilities: -90000,
          investments: 3300,
          netWorth: -84420,
        });
      });

      // The other half of the same predicate: the fallback must keep counting
      // rows that are NOT positively attributed to a tracking-only account. A
      // bare inner join to `accounts` would have dropped exactly these — the
      // unattributed ledger the fallback exists to serve.
      it("still sums unattributed rows whose bank_account has no accounts row", async () => {
        await seedBase();
        const today = TODAY();
        const d1 = addDaysYmd(today, -1);
        // Written with no bank label (account_id NULL), then relabelled: the
        // sync trigger only ever resolves an UPDATE against an EXISTING account,
        // so the row keeps account_id NULL behind a bank_account string with no
        // accounts row — the shape a pre-accounts ledger carries.
        await insertTxn({ date: d1, amount: "1200.00", bank: null });
        await insertTxn({ date: today, amount: "300.00", bank: null });
        await getTestPool().query(
          `UPDATE transactions SET bank_account = 'LEGACY BANK'`,
        );
        expect(
          (
            await getTestPool().query(
              `SELECT count(*)::int AS n FROM transactions WHERE account_id IS NULL`,
            )
          ).rows[0].n,
        ).toBe(2);
        expect(
          (await getTestPool().query("SELECT count(*)::int AS n FROM accounts"))
            .rows[0].n,
        ).toBe(0);

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.snapshots.map((s) => [s.date, s.liquid])).toEqual([
          [d1, 1200],
          [today, 1500],
        ]);
        expect(r.current.liquid).toBe(1500);
      });

      it("drops only the tracking-attributed rows when unattributed rows sit alongside them", async () => {
        await seedBase();
        const today = TODAY();
        await addAccount("TRACKING", { inNetWorth: false });
        await insertTxn({ date: today, amount: "-133.25", bank: "TRACKING" });
        await insertTxn({ date: today, amount: "1000.00", bank: null }); // unattributed

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.current.liquid).toBe(1000); // not 866.75
      });

      // ── the fallback's liquid/liability split ────────────────────────────────
      // The fallback had no is_liability split at all, so `liabilities` was
      // structurally 0 on that path and every row landed in `liquid`. It now
      // carries the walk's own resolution — `accounts.type = 'liability'` on the
      // row's `account_id`, the same column `account_list` reads.

      it("leaves un-attributable fallback rows in liquid, not liabilities", async () => {
        await seedBase();
        const today = TODAY();
        // The synthetic legacy shape: a big negative running balance behind a
        // bank_account string with no accounts row. There is no `accounts.type` to
        // read, so there is nothing to split on — the documented resolution is
        // `false` (liquid), which is also what keeps this ledger's reported
        // buckets identical to what it has always reported. netWorth is the same
        // number either way; only the split between the two buckets is at stake.
        await insertTxn({ date: today, amount: "-5000.00", bank: null });
        await getTestPool().query(
          `UPDATE transactions SET bank_account = 'LEGACY MORTGAGE'`,
        );
        expect(
          (
            await getTestPool().query(
              `SELECT count(*)::int AS n FROM transactions WHERE account_id IS NULL`,
            )
          ).rows[0].n,
        ).toBe(1);

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.current).toEqual({
          liquid: -5000,
          liabilities: 0,
          investments: 0,
          netWorth: -5000,
        });
      });

      // What makes that decision total rather than a guess: every row the fallback
      // can ever see is un-attributable. A row with a non-null account_id belongs
      // to an account that is either in_net_worth=false (dropped by the fallback's
      // own exclusion) or in_net_worth=true — and the latter puts the account in
      // `account_list`, which makes the walk non-empty, which means the fallback
      // never fires. `accounts.in_net_worth` is NOT NULL, so there is no third
      // case. This pins that boundary from the liability side.
      it("answers an attributed liability account from the walk, never the fallback", async () => {
        await seedBase();
        const today = TODAY();
        await addAccount("MORTGAGE", { type: "liability" });
        await insertTxn({ date: today, amount: "-5000.00", bank: "MORTGAGE" });
        expect(
          (
            await getTestPool().query(
              `SELECT count(*)::int AS n FROM transactions WHERE account_id IS NOT NULL`,
            )
          ).rows[0].n,
        ).toBe(1);

        const r = await infoRepository.getNetWorthFromSnapshots();
        // Split by the walk — a mortgage is not liquid cash (ADR-092).
        expect(r.current).toEqual({
          liquid: 0,
          liabilities: -5000,
          investments: 0,
          netWorth: -5000,
        });
      });

      // The split must not disturb the multi-currency partitioning the fallback
      // already does: it now runs one dense day series per (currency, bucket)
      // pair rather than per currency.
      it("keeps the fallback per-currency running totals intact under the split", async () => {
        await seedBase();
        const today = TODAY();
        const d1 = addDaysYmd(today, -1);
        // Rate resolves from the DB, never the network (same shape the
        // multi-currency suite seeds). USD at 0.5 EUR on both days, so the
        // conversion cannot mask an accumulation error behind a moving rate.
        for (const [d, latest] of [
          [d1, false],
          [today, true],
        ]) {
          await getTestPool().query(
            `INSERT INTO exchange_rates (currency_code, rate_date, rate_to_eur, is_latest)
           VALUES ('USD', $1::date, 0.5, $2)`,
            [d, latest],
          );
        }
        await insertTxn({
          date: d1,
          amount: "100.00",
          currency: "EUR",
          bank: null,
        });
        await insertTxn({
          date: d1,
          amount: "100.00",
          currency: "USD",
          bank: null,
        });
        await insertTxn({
          date: today,
          amount: "10.00",
          currency: "USD",
          bank: null,
        });

        const r = await infoRepository.getNetWorthFromSnapshots();
        // Each currency accumulates on its own and converts at its own rate:
        // d1 = 100 EUR + 100/2 USD = 150; today = 100 + 110/2 = 155.
        expect(r.snapshots.map((s) => [s.date, s.liquid])).toEqual([
          [d1, 150],
          [today, 155],
        ]);
        expect(r.current.liabilities).toBe(0);
      });
    });

    // ───────────────────────────────────────────────────────────────────────────
    // getPlannedExpensesNextMonth
    // ───────────────────────────────────────────────────────────────────────────
    describe("getPlannedExpensesNextMonth", () => {
      /** First / last day of the month after the app-timezone current month. */
      const nextMonthStart = () => firstOfMonthYmd(TODAY(), 1);
      const monthAfterStart = () => firstOfMonthYmd(TODAY(), 2);

      it("reports the next-month window and only the rows inside it", async () => {
        await seedBase();
        const start = nextMonthStart();
        const after = monthAfterStart();
        const lastDay = addDaysYmd(after, -1);
        const midNext = addDaysYmd(start, 4);

        await insertPlanned({
          date: midNext,
          amount: "-20.00",
          categoryId: cat.Rent,
        });
        await insertPlanned({ date: midNext, amount: "50.00" });
        await insertPlanned({ date: TODAY(), amount: "-999.00" }); // current month → out
        await insertPlanned({ date: after, amount: "-888.00" }); // month after → out

        const r = await infoRepository.getPlannedExpensesNextMonth("EUR");
        expect(r.period_start).toBe(start);
        expect(r.period_end).toBe(lastDay);
        // The month/year fields must name the same month period_start does.
        expect(`${r.year}-${String(r.month).padStart(2, "0")}`).toBe(
          start.slice(0, 7),
        );
        expect(r.daily_data).toHaveLength(1);
        expect(r.daily_data[0]).toMatchObject({
          date: midNext,
          total_income: 50,
          total_expenses: -20,
        });
        // Same-day rows come back in whatever order `ORDER BY pt.planned_date`
        // leaves them (no tiebreaker in the SQL), so assert set-wise.
        expect(r.daily_data[0].transactions).toHaveLength(2);
        expect(r.daily_data[0].transactions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              amount: -20,
              category_name: "Home:Rent",
              is_recurring: false,
            }),
            expect.objectContaining({ amount: 50, category_name: null }),
          ]),
        );
        expect(r.summary).toMatchObject({
          total_income: 50,
          total_expenses: -20,
          net_amount: 30,
          transaction_count: 2,
        });
      });

      it("ignores executed and inactive planned rows", async () => {
        await seedBase();
        const midNext = addDaysYmd(nextMonthStart(), 4);
        await insertPlanned({ date: midNext, amount: "-10.00" });
        await insertPlanned({
          date: midNext,
          amount: "-4000.00",
          isExecuted: true,
        });
        await insertPlanned({
          date: midNext,
          amount: "-5000.00",
          isActive: false,
        });

        const r = await infoRepository.getPlannedExpensesNextMonth("EUR");
        expect(r.summary).toMatchObject({
          total_expenses: -10,
          transaction_count: 1,
        });
      });

      it("expands a recurring row dated in the CURRENT month into its next-month occurrences", async () => {
        await seedBase();
        const start = nextMonthStart();
        // Weekly, anchored on the 1st of the CURRENT month: the row itself never
        // falls inside next month, so only expansion can surface it.
        await insertPlanned({
          date: firstOfMonthYmd(TODAY()),
          amount: "-50.00",
          recurring: true,
          pattern: "weekly",
        });

        const r = await infoRepository.getPlannedExpensesNextMonth("EUR");
        expect(r.summary.transaction_count).toBeGreaterThanOrEqual(4);
        expect(r.summary.total_expenses).toBe(
          -50 * r.summary.transaction_count,
        );
        for (const d of r.daily_data) {
          expect(d.date >= start && d.date < monthAfterStart()).toBe(true);
          // Every occurrence is 7 days after the previous one.
          expect(
            (new Date(`${d.date}T00:00:00Z`) -
              new Date(`${firstOfMonthYmd(TODAY())}T00:00:00Z`)) %
              (7 * 86_400_000),
          ).toBe(0);
        }
      });

      it("fast-forwards a stale daily recurrence instead of dropping it (120-hop cap)", async () => {
        await seedBase();
        const start = nextMonthStart();
        const after = monthAfterStart();
        // Anchored ~8 months back: a flat 120-hop walk would run out before
        // reaching next month and the row would silently vanish.
        await insertPlanned({
          date: firstOfMonthYmd(TODAY(), -8),
          amount: "-5.00",
          recurring: true,
          pattern: "daily",
        });

        const r = await infoRepository.getPlannedExpensesNextMonth("EUR");
        const daysInNextMonth = Math.round(
          (new Date(`${after}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) /
            86_400_000,
        );
        expect(r.summary.transaction_count).toBe(daysInNextMonth);
        expect(r.daily_data[0].date).toBe(start);
        expect(r.daily_data[r.daily_data.length - 1].date).toBe(
          addDaysYmd(after, -1),
        );
      });
    });

    // ───────────────────────────────────────────────────────────────────────────
    // getAverageVsCurrentSpending
    // ───────────────────────────────────────────────────────────────────────────
    describe("getAverageVsCurrentSpending", () => {
      /** Day N of the month `monthsBack` months before the current one. */
      const monthDay = (monthsBack, day) =>
        // App-clock anchored (ecd7f78): the repo's windows no longer read CURRENT_DATE.
        `date_trunc('month', '${TODAY()}'::date) - interval '${monthsBack} months' + interval '${day - 1} days'`;

      async function insertTxnAt(dateExpr, amount, opts = {}) {
        const { rows } = await getTestPool().query(
          `SELECT to_char((${dateExpr})::date, 'YYYY-MM-DD') AS d`,
        );
        return insertTxn({ date: rows[0].d, amount, ...opts });
      }

      it("divides the 6-month spend by calendar days and projects the current month on elapsed days", async () => {
        await seedBase();
        await insertTxnAt(monthDay(1, 10), "-10.00");
        await insertTxnAt(monthDay(2, 10), "-20.00");
        await insertTxnAt(monthDay(2, 10), "5.00"); // income never counts as spending
        await insertTxnAt(monthDay(9, 10), "-9999.00"); // outside the 6-month window
        await insertTxn({ date: TODAY(), amount: "-5.00" });
        await insertTxn({ date: TODAY(), amount: "1.00" });

        // Observed window: the ledger's first in-window row is in month -2 (the
        // month -9 row is outside the 6-month floor), so the denominators are
        // months -2 and -1 — in months for the monthly figure, in calendar days
        // for the daily one.
        const { rows } = await getTestPool().query(`
        SELECT (date_trunc('month', '${TODAY()}'::date)::date
                - (date_trunc('month', '${TODAY()}'::date) - interval '2 months')::date) AS n
      `);
        const calendarDays = Number(rows[0].n);

        const r = await infoRepository.getAverageVsCurrentSpending("EUR");
        expect(r.past_6_months.months_counted).toBe(2);
        expect(r.past_6_months.avg_monthly_spending).toBe(15); // 30 over 2 elapsed months
        // Rounded to cents by the repository, so compare the rounded figure.
        expect(r.past_6_months.avg_daily_spending).toBe(
          Math.round((30 / calendarDays) * 100) / 100,
        );
        expect(r.current_month.total_spending).toBe(5);
        expect(r.current_month.daily_data).toEqual([
          { date: TODAY(), spending: 5, income: 1 },
        ]);
        const projected =
          Math.round(
            (5 / r.current_month.days_elapsed) *
              r.current_month.days_in_month *
              100,
          ) / 100;
        expect(r.comparison.projected_monthly_total).toBe(projected);
        expect(r.comparison.variance).toBe(
          Math.round((projected - 15) * 100) / 100,
        );
      });

      it("excludes internal transfers by default and includes them when the setting is on", async () => {
        await seedBase();
        await insertTxn({ date: TODAY(), amount: "-100.00" });
        await insertTxn({ date: TODAY(), amount: "-900.00", isTransfer: true });

        expect(
          (await infoRepository.getAverageVsCurrentSpending("EUR"))
            .current_month.total_spending,
        ).toBe(100);

        await getTestPool().query(
          `INSERT INTO user_settings (key, value) VALUES ('includeTransfers', 'true'::jsonb)`,
        );
        expect(
          (await infoRepository.getAverageVsCurrentSpending("EUR"))
            .current_month.total_spending,
        ).toBe(1000);
      });

      it("ignores inactive rows on both windows", async () => {
        await seedBase();
        await insertTxnAt(monthDay(1, 10), "-40.00", { isActive: false });
        await insertTxn({ date: TODAY(), amount: "-30.00", isActive: false });

        const r = await infoRepository.getAverageVsCurrentSpending("EUR");
        expect(r.past_6_months.months_counted).toBe(1); // the "no data" divisor floor
        expect(r.past_6_months.avg_monthly_spending).toBe(0);
        expect(r.current_month.total_spending).toBe(0);
        expect(r.comparison.pace).toBeNull();
      });
    });

    // ───────────────────────────────────────────────────────────────────────────
    // PINNED real-DB behaviours (see the suite report — do NOT "fix" here)
    // ───────────────────────────────────────────────────────────────────────────
    describe("pinned discrepancies (current real behaviour)", () => {
      const monthDay = (monthsBack, day) =>
        // App-clock anchored (ecd7f78): the repo's windows no longer read CURRENT_DATE.
        `date_trunc('month', '${TODAY()}'::date) - interval '${monthsBack} months' + interval '${day - 1} days'`;

      async function insertTxnAt(dateExpr, amount, opts = {}) {
        const { rows } = await getTestPool().query(
          `SELECT to_char((${dateExpr})::date, 'YYYY-MM-DD') AS d`,
        );
        return insertTxn({ date: rows[0].d, amount, ...opts });
      }

      // Was PIN 1 — "average monthly spending over the past 6 months" divided by
      // the number of months that contain ANY transaction. A `monthlySpending`
      // key was seeded for every month with a row (before the `eur < 0` test),
      // then the total was divided by `monthKeys.length`: a gap month vanished
      // from the divisor (inflating the average) and a month whose only rows were
      // INCOME entered it (diluting the average with zero extra spend). The
      // `avg_daily_spending` sibling on the same object divided by calendar days
      // instead, so the two disagreed by construction.
      //
      // Both now divide the same numerator by the same observed window — the span
      // from the ledger's first in-window transaction through the last complete
      // month (infoRepositoryAverageVsCurrent.countObservedMonths, the same
      // definition infoRepositoryForecast uses), one expressed in months and one
      // in days.
      it("divides by elapsed months since the ledger started, counting empty months as zeros", async () => {
        await seedBase();
        await insertTxnAt(monthDay(1, 10), "-240.00");

        // A one-month-old ledger is not charged five phantom zeros: 240, not 40.
        const one = await infoRepository.getAverageVsCurrentSpending("EUR");
        expect(one.past_6_months.months_counted).toBe(1);
        expect(one.past_6_months.avg_monthly_spending).toBe(240);

        // Pushing history back to month -3 makes months -3 and -2 real zeros:
        // the divisor is 3, not the 2 months that happen to carry rows.
        await insertTxnAt(monthDay(3, 10), "-60.00");
        const three = await infoRepository.getAverageVsCurrentSpending("EUR");
        expect(three.past_6_months.months_counted).toBe(3);
        expect(three.past_6_months.avg_monthly_spending).toBe(100); // 300 / 3, not 300 / 2 = 150
      });

      it("is unmoved by an income-only month INSIDE an established span (an income row that is the ledger-oldest row still extends the span, matching the forecast doctrine)", async () => {
        await seedBase();
        await insertTxnAt(monthDay(3, 10), "-240.00");

        const before = await infoRepository.getAverageVsCurrentSpending("EUR");
        expect(before.past_6_months.months_counted).toBe(3);
        expect(before.past_6_months.avg_monthly_spending).toBe(80); // 240 over months -3..-1

        // A month holding ONLY income adds no spend and no new observed month
        // (month -1 was already inside the span), so the average cannot move.
        await insertTxnAt(monthDay(1, 10), "1000.00");
        const after = await infoRepository.getAverageVsCurrentSpending("EUR");
        expect(after.past_6_months.months_counted).toBe(3);
        expect(after.past_6_months.avg_monthly_spending).toBe(80); // was 240 → 120 before the fix
      });

      it("keeps avg_monthly_spending and avg_daily_spending on one denominator", async () => {
        await seedBase();
        await insertTxnAt(monthDay(2, 10), "-240.00");

        const { rows } = await getTestPool().query(`
        SELECT (date_trunc('month', '${TODAY()}'::date)::date
                - (date_trunc('month', '${TODAY()}'::date) - interval '2 months')::date) AS n
      `);
        const observedDays = Number(rows[0].n);

        const r = await infoRepository.getAverageVsCurrentSpending("EUR");
        expect(r.past_6_months.months_counted).toBe(2);
        expect(r.past_6_months.avg_monthly_spending).toBe(120);
        // Same 240 spread over the same window, in days rather than months —
        // previously 240/183 next to 240/2, a factor-3 disagreement.
        expect(r.past_6_months.avg_daily_spending).toBe(
          Math.round((240 / observedDays) * 100) / 100,
        );
      });

      // Was PIN 2 — net worth's stamp-based history walk hid never-stamped
      // accounts from every point except the last one, where the current-point
      // override added them back in one go: a vertical step no transaction
      // explains, which the monthly-change figure then reported as a real gain.
      // The transaction-flow fallback only rescued "nothing stamped anywhere";
      // mixing one stamped account with one manual account defeated it. The walk
      // now resolves each day with the same unstamped-tolerant anchor+delta
      // definition the current point uses.
      it("carries manual-only accounts through the whole net-worth history, not just the last point", async () => {
        await seedBase();
        const today = TODAY();
        const d1 = addDaysYmd(today, -1);
        await addAccount("KBC");
        await addAccount("CASH");
        await insertTxn({
          date: d1,
          amount: "-1.00",
          bank: "KBC",
          balance: "1000.00",
        });
        await insertTxn({ date: d1, amount: "200.00", bank: "CASH" }); // never stamped

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.snapshots.map((s) => [s.date, s.liquid])).toEqual([
          [d1, 1200], // CASH's 200 counts from the day it posts…
          [today, 1200], // …so the last point is flat, not a step
        ]);
        expect(r.current.liquid).toBe(1200);
        // Nothing moved after d1, so nothing is reported as movement.
        expect(r.monthlyChange).toBe(0);
      });

      it("keeps headline == last chart point for a foreign-currency account on a moving curve", async () => {
        // Same invariant as the banks widget's: the current point converts at
        // today's rate and the walk at each day's, so a rate that moved after the
        // last statement must not open a gap between the headline and the chart.
        await seedBase();
        const today = TODAY();
        const d30 = addDaysYmd(today, -30);
        await addAccount("WISE USD", { currency: "USD" });
        for (const [date, rate, isLatest] of [
          [d30, "0.5", false],
          [today, "0.9", true],
        ]) {
          await getTestPool().query(
            `INSERT INTO exchange_rates (currency_code, rate_date, rate_to_eur, is_latest)
           VALUES ('USD', $1::date, $2, $3)`,
            [date, rate, isLatest],
          );
        }
        await insertTxn({
          date: d30,
          amount: "-10.00",
          currency: "USD",
          bank: "WISE USD",
          balance: "1000.00",
        });

        const r = await infoRepository.getNetWorthFromSnapshots("EUR");
        expect(r.current.liquid).toBe(900); // 1000 USD × today's 0.9
        const last = r.snapshots[r.snapshots.length - 1];
        expect(last.liquid).toBe(r.current.liquid);
        // The curve moves the series, so the equality above is not a flat-curve
        // coincidence: the statement day itself is still valued at 0.5.
        expect(r.snapshots[0]).toMatchObject({ date: d30, liquid: 500 });
      });

      it("keeps headline == last chart point on an all-manual net-worth ledger", async () => {
        await seedBase();
        const today = TODAY();
        const d2 = addDaysYmd(today, -2);
        const d1 = addDaysYmd(today, -1);
        await addAccount("CASH");
        await addAccount("WALLET");
        await insertTxn({ date: d2, amount: "200.00", bank: "CASH" });
        await insertTxn({ date: d1, amount: "-50.00", bank: "CASH" });
        await insertTxn({ date: d1, amount: "30.00", bank: "WALLET" });

        const r = await infoRepository.getNetWorthFromSnapshots();
        expect(r.snapshots.map((s) => [s.date, s.liquid])).toEqual([
          [d2, 200],
          [d1, 180],
          [today, 180],
        ]);
        expect(r.current.liquid).toBe(180);
        expect(r.snapshots[r.snapshots.length - 1].liquid).toBe(
          r.current.liquid,
        );
      });
    });
  },
);
