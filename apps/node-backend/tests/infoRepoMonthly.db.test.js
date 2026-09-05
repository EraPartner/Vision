/**
 * Real-Postgres tests for infoRepositoryMonthly (`getMonthlyFinancialSummary`).
 *
 * DB-backed complement to infoRepoMonthly.test.js (which stays: it runs without
 * a DB). The mock suite stubs `mvAvailable` and `getIncludeTransfers` outright
 * and matches SQL substrings (`FROM mv_monthly_summary`, `generate_series`,
 * `NOT IN ($1, $2)`), so it verifies which branch the JS *chose* — never what
 * either branch computes. Here both paths run for real: the live path against
 * the 6-month `generate_series` × `daily` join, and the materialized-view fast
 * path against an actually-created `mv_monthly_summary` (created inside the MV
 * tests and dropped again, since every other DB suite assumes a freshly-migrated
 * database with no MVs).
 *
 * The headline property is the one the module's own comments claim and no mock
 * could ever check: toggling an exclusion switches paths, so the two paths must
 * agree on the same corpus.
 *
 * Determinism: the repository's windows are anchored on the APP_TIMEZONE
 * calendar day (ADR-009), not Postgres `CURRENT_DATE` — for the last hours of
 * a UTC day the two disagree by one day. So, exactly as in
 * infoRepoForecast.db.test.js, the fixture helpers substitute the literal
 * token `CURRENT_DATE` in every date expression with the app-clock date at
 * call time, keeping fixtures and queries on ONE clock whatever hour the suite
 * runs. Day 5/10/15 exist in every month. The rollover describe at the bottom
 * deliberately seeds on the DB clock via `now()`, which the substitution
 * leaves alone.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { getMonthlyFinancialSummary } from "../src/repositories/infoRepositoryMonthly.js";
import { createMaterializedViews } from "../src/services/materializedViewService.js";
import { clearMvCache } from "../src/repositories/infoRepositoryHelpers.js";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.js";
import { closePool } from "../src/database/connection.js";
import { todayAppDateString, appDateStringToUtc } from "../src/lib/timezone.js";

const MANAGED_VIEWS = ["mv_monthly_summary", "mv_category_totals"];

const cat = {};
const rec = {};

/** Day N of the month `monthsBack` months before the current one. */
const monthDay = (monthsBack, day) =>
  `date_trunc('month', CURRENT_DATE) - interval '${monthsBack} months' + interval '${day - 1} days'`;

/**
 * Anchor a fixture date expression on the SAME clock the queries use: the
 * literal token `CURRENT_DATE` becomes the APP_TIMEZONE calendar day, resolved
 * at call time (so the fake-timer rollover cases see the frozen clock). `now()`
 * is deliberately NOT substituted — the rollover describe uses it to seed on
 * the real DB clock.
 */
const anchored = (dateExpr) =>
  dateExpr.replaceAll("CURRENT_DATE", `('${todayAppDateString()}'::date)`);

/** 'YYYY-MM' key for the month `monthsBack` months before the current one (app-clock anchored). */
async function monthKey(monthsBack) {
  const { rows } = await getTestPool().query(
    anchored(
      `SELECT to_char(date_trunc('month', CURRENT_DATE) - interval '${monthsBack} months', 'YYYY-MM') AS k`,
    ),
  );
  return rows[0].k;
}

/** 'YYYY-MM-DD' for an arbitrary date expression (app-clock anchored). */
async function ymd(dateExpr) {
  const { rows } = await getTestPool().query(
    `SELECT to_char((${anchored(dateExpr)})::date, 'YYYY-MM-DD') AS d`,
  );
  return rows[0].d;
}

/** A month row keyed 'YYYY-MM', for readable assertions. */
const byMonth = (result) =>
  Object.fromEntries(
    result.months.map((m) => [
      `${m.year}-${String(m.month).padStart(2, "0")}`,
      m,
    ]),
  );

async function seedBase() {
  const pool = getTestPool();
  for (const [key, [general, detail]] of Object.entries({
    Food: ["Food", "Groceries"],
    Bills: ["Bills", "Utilities"],
  })) {
    const { rows } = await pool.query(
      "INSERT INTO categories (general, detail) VALUES ($1, $2) RETURNING id",
      [general, detail],
    );
    cat[key] = rows[0].id;
  }
  const addRecipient = async (
    name,
    { defaultCategoryId = null, primaryId = null } = {},
  ) => {
    const { rows } = await pool.query(
      `INSERT INTO recipients (name, normalized_name, default_category_id, primary_recipient_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, name.toLowerCase(), defaultCategoryId, primaryId],
    );
    return rows[0].id;
  };
  rec.electrabel = await addRecipient("Electrabel", {
    defaultCategoryId: cat.Bills,
  });
  rec.electrabelAlias = await addRecipient("Electrabel Invoicing", {
    primaryId: rec.electrabel,
  });
  rec.misc = await addRecipient("Misc Payee");
}

async function ensureAccount(name) {
  await getTestPool().query(
    `INSERT INTO accounts (name, display_name) VALUES ($1, $1)
     ON CONFLICT (lower(btrim(name))) DO NOTHING`,
    [name],
  );
}

async function insertTxn({
  dateExpr,
  amount,
  currency = "EUR",
  recipientId = null,
  categoryId = null,
  bank = "MAIN BANK",
  isActive = true,
  isTransfer = false,
}) {
  if (bank) await ensureAccount(bank);
  const { rows } = await getTestPool().query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, category_id, bank_account, is_active, is_transfer)
     VALUES ((${anchored(dateExpr)})::date, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      amount,
      currency,
      recipientId ?? rec.misc,
      categoryId,
      bank,
      isActive,
      isTransfer,
    ],
  );
  return rows[0].id;
}

async function dropManagedViews() {
  const pool = getTestPool();
  for (const view of MANAGED_VIEWS) {
    await pool.query(`DROP MATERIALIZED VIEW IF EXISTS ${view} CASCADE`);
  }
  clearMvCache();
}

describe.skipIf(!hasTestDatabase())(
  "repositories/infoRepositoryMonthly (real DB)",
  () => {
    beforeAll(async () => {
      expect(
        process.env.DATABASE_URL,
        "DATABASE_URL must equal TEST_DATABASE_URL for this suite (see scripts/with-test-db.sh)",
      ).toBe(process.env.TEST_DATABASE_URL);
      // DB suites share one database across parallel vitest workers — serialize.
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      const pool = getTestPool();
      // MVs first: they are the only artefact of this suite that outlives a row
      // wipe, and every other DB suite assumes a migrated DB with no MVs.
      await dropManagedViews();
      await pool.query("DELETE FROM transactions");
      await pool.query("DELETE FROM accounts");
      await pool.query("DELETE FROM recipients");
      await pool.query("DELETE FROM categories");
      await pool.query("DELETE FROM exchange_rates");
      await pool.query(
        `DELETE FROM user_settings WHERE key = 'includeTransfers'`,
      );
      for (const bag of [cat, rec])
        for (const k of Object.keys(bag)) delete bag[k];
      clearMemoryCache();
    });

    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    // ───────────────────────────────────────────────────────────────────────────
    // Live path
    // ───────────────────────────────────────────────────────────────────────────
    describe("live path", () => {
      it("returns exactly the 6-month window, zero-filling months with no rows", async () => {
        await seedBase();
        await insertTxn({ dateExpr: monthDay(2, 10), amount: "-25.00" });

        const r = await getMonthlyFinancialSummary([], "EUR", [], false);
        expect(r.months).toHaveLength(6);
        const expectedKeys = [];
        for (let i = 5; i >= 0; i -= 1) expectedKeys.push(await monthKey(i));
        expect(
          r.months.map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`),
        ).toEqual(expectedKeys);

        const months = byMonth(r);
        expect(months[await monthKey(2)]).toMatchObject({
          total_spending: -25,
          total_income: 0,
          net_amount: -25,
          transaction_count: 1,
        });
        expect(months[await monthKey(3)]).toMatchObject({
          total_spending: 0,
          total_income: 0,
          net_amount: 0,
          transaction_count: 0,
        });
      });

      it("emits period_start/period_end as calendar-day strings covering the whole month", async () => {
        await seedBase();
        const r = await getMonthlyFinancialSummary([], "EUR", [], false);
        const current = byMonth(r)[await monthKey(0)];
        expect(current.period_start).toBe(
          await ymd(`date_trunc('month', CURRENT_DATE)`),
        );
        expect(current.period_end).toBe(
          await ymd(
            `date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day'`,
          ),
        );
        expect(typeof current.period_start).toBe("string");
      });

      it("splits income from spending per month and rolls the window into summary", async () => {
        await seedBase();
        await insertTxn({ dateExpr: monthDay(1, 5), amount: "2000.00" });
        await insertTxn({ dateExpr: monthDay(1, 5), amount: "-300.00" }); // same day, same currency
        await insertTxn({ dateExpr: monthDay(1, 15), amount: "-200.00" });
        await insertTxn({ dateExpr: monthDay(0, 10), amount: "-50.00" });
        await insertTxn({
          dateExpr: monthDay(0, 10),
          amount: "-9999.00",
          isActive: false,
        });
        // Outside the window entirely.
        await insertTxn({ dateExpr: monthDay(9, 10), amount: "-1234.00" });

        const r = await getMonthlyFinancialSummary([], "EUR", [], false);
        const months = byMonth(r);
        expect(months[await monthKey(1)]).toMatchObject({
          total_income: 2000,
          total_spending: -500,
          net_amount: 1500,
          transaction_count: 3,
        });
        expect(months[await monthKey(0)]).toMatchObject({
          total_income: 0,
          total_spending: -50,
          net_amount: -50,
          transaction_count: 1,
        });
        expect(r.summary).toMatchObject({
          total_income: 2000,
          total_spending: -550,
          net_amount: 1450,
          transaction_count: 4,
        });
        expect(r.summary.period_start).toBe(
          await ymd(`date_trunc('month', CURRENT_DATE) - interval '5 months'`),
        );
      });

      it("excludes internal transfers by default and includes them when the setting is on", async () => {
        await seedBase();
        await insertTxn({ dateExpr: monthDay(1, 5), amount: "-100.00" });
        await insertTxn({
          dateExpr: monthDay(1, 5),
          amount: "-900.00",
          isTransfer: true,
        });

        const off = await getMonthlyFinancialSummary([], "EUR", [], false);
        expect(byMonth(off)[await monthKey(1)]).toMatchObject({
          total_spending: -100,
          transaction_count: 1,
        });

        await getTestPool().query(
          `INSERT INTO user_settings (key, value) VALUES ('includeTransfers', 'true'::jsonb)`,
        );
        const on = await getMonthlyFinancialSummary([], "EUR", [], false);
        expect(byMonth(on)[await monthKey(1)]).toMatchObject({
          total_spending: -1000,
          transaction_count: 2,
        });
      });

      it("applies alias-aware category and recipient exclusions to real rows", async () => {
        await seedBase();
        await insertTxn({
          dateExpr: monthDay(1, 5),
          amount: "-100.00",
          recipientId: rec.misc,
          categoryId: cat.Food,
        });
        // Categorised only via the PRIMARY of its alias (3rd resolution level).
        await insertTxn({
          dateExpr: monthDay(1, 5),
          amount: "-200.00",
          recipientId: rec.electrabelAlias,
        });
        // Uncategorised at all three levels — must SURVIVE any exclusion (the -1
        // sentinel in buildExclusionClauses exists exactly for this).
        await insertTxn({
          dateExpr: monthDay(1, 5),
          amount: "-7.00",
          recipientId: rec.misc,
        });

        const all = await getMonthlyFinancialSummary([], "EUR", [], false);
        expect(byMonth(all)[await monthKey(1)].total_spending).toBe(-307);

        const exclBills = await getMonthlyFinancialSummary(
          [cat.Bills],
          "EUR",
          [],
          false,
        );
        expect(byMonth(exclBills)[await monthKey(1)]).toMatchObject({
          total_spending: -107,
          transaction_count: 2,
        });

        const exclPrimary = await getMonthlyFinancialSummary(
          [],
          "EUR",
          [rec.electrabel],
          false,
        );
        expect(byMonth(exclPrimary)[await monthKey(1)]).toMatchObject({
          total_spending: -107,
          transaction_count: 2,
        });
      });

      it("extends the series back to the earliest active transaction when allTime is set", async () => {
        await seedBase();
        await insertTxn({ dateExpr: monthDay(8, 10), amount: "-10.00" });
        await insertTxn({ dateExpr: monthDay(0, 10), amount: "-20.00" });

        const r = await getMonthlyFinancialSummary([], "EUR", [], true);
        expect(r.months).toHaveLength(9); // month-8 … month-0 inclusive
        expect(byMonth(r)[await monthKey(8)]).toMatchObject({
          total_spending: -10,
        });
        expect(byMonth(r)[await monthKey(7)]).toMatchObject({
          total_spending: 0,
          transaction_count: 0,
        });
      });

      it("converts each day at its own stored rate", async () => {
        await seedBase();
        await getTestPool().query(
          `INSERT INTO exchange_rates (currency_code, rate_date, rate_to_eur, is_latest)
         VALUES ('USD', (${anchored(monthDay(1, 5))})::date, 0.5, false),
                ('USD', (${anchored(monthDay(2, 5))})::date, 0.25, false)`,
        );
        await insertTxn({
          dateExpr: monthDay(1, 5),
          amount: "-100.00",
          currency: "USD",
        });
        await insertTxn({
          dateExpr: monthDay(2, 5),
          amount: "-100.00",
          currency: "USD",
        });

        const r = await getMonthlyFinancialSummary([], "EUR", [], false);
        expect(byMonth(r)[await monthKey(1)].total_spending).toBe(-50);
        expect(byMonth(r)[await monthKey(2)].total_spending).toBe(-25);
      });
    });

    // ───────────────────────────────────────────────────────────────────────────
    // Materialized-view fast path
    // ───────────────────────────────────────────────────────────────────────────
    describe("materialized-view fast path", () => {
      /** The corpus used for both path-agreement tests. */
      async function seedCorpus() {
        await seedBase();
        await insertTxn({
          dateExpr: monthDay(1, 5),
          amount: "2000.00",
          recipientId: rec.misc,
        });
        await insertTxn({
          dateExpr: monthDay(1, 5),
          amount: "-300.00",
          recipientId: rec.misc,
          categoryId: cat.Food,
        });
        await insertTxn({
          dateExpr: monthDay(1, 15),
          amount: "-200.00",
          recipientId: rec.electrabelAlias,
        });
        await insertTxn({
          dateExpr: monthDay(3, 10),
          amount: "-40.00",
          recipientId: rec.misc,
        });
        await insertTxn({
          dateExpr: monthDay(0, 10),
          amount: "-50.00",
          recipientId: rec.misc,
        });
        await insertTxn({
          dateExpr: monthDay(0, 11),
          amount: "-900.00",
          recipientId: rec.misc,
          isTransfer: true,
        });
      }

      it("produces the SAME months and summary as the live path on one corpus", async () => {
        await seedCorpus();
        // No MVs yet → live path.
        const live = await getMonthlyFinancialSummary([], "EUR", [], false);

        await createMaterializedViews();
        clearMvCache();
        const mv = await getMonthlyFinancialSummary([], "EUR", [], false);

        // The module's stated invariant: toggling an exclusion flips the code
        // path, so the dashboard's month set and figures must not move with it.
        expect(mv.months).toEqual(live.months);
        expect(mv.summary).toEqual(live.summary);
      });

      it("really serves from the MV: a post-creation insert stays invisible until REFRESH", async () => {
        // Path proof for the agreement test above — without it, an MV that failed
        // to populate would make "MV path == live path" vacuously true. The MV is
        // a snapshot, so a row inserted after CREATE is absent until refreshed.
        await seedCorpus();
        await createMaterializedViews();
        clearMvCache();

        const before = await getMonthlyFinancialSummary([], "EUR", [], false);
        await insertTxn({
          dateExpr: monthDay(0, 12),
          amount: "-77.00",
          recipientId: rec.misc,
        });
        const after = await getMonthlyFinancialSummary([], "EUR", [], false);
        expect(after.months).toEqual(before.months); // stale MV — the new row is unseen

        await getTestPool().query(
          "REFRESH MATERIALIZED VIEW mv_monthly_summary",
        );
        const refreshed = await getMonthlyFinancialSummary(
          [],
          "EUR",
          [],
          false,
        );
        expect(byMonth(refreshed)[await monthKey(0)].total_spending).toBe(
          byMonth(before)[await monthKey(0)].total_spending - 77,
        );
      });

      it("falls back to the live path when the MV holds a non-target currency", async () => {
        await seedBase();
        await getTestPool().query(
          `INSERT INTO exchange_rates (currency_code, rate_date, rate_to_eur, is_latest)
         VALUES ('USD', (${anchored(monthDay(1, 5))})::date, 0.5, true)`,
        );
        await insertTxn({
          dateExpr: monthDay(1, 5),
          amount: "-100.00",
          currency: "USD",
        });
        await insertTxn({
          dateExpr: monthDay(1, 6),
          amount: "-10.00",
          currency: "EUR",
        });

        const live = await getMonthlyFinancialSummary([], "EUR", [], false);
        await createMaterializedViews();
        clearMvCache();
        const withMv = await getMonthlyFinancialSummary([], "EUR", [], false);

        // Mixed currencies ⇒ the homogeneity probe rejects the MV, so the
        // per-(date,currency) live conversion is used and the answer is unchanged.
        expect(withMv.months).toEqual(live.months);
        expect(byMonth(withMv)[await monthKey(1)].total_spending).toBe(-60);
      });

      it("never takes the MV path when an exclusion or allTime is requested", async () => {
        await seedCorpus();
        await createMaterializedViews();
        clearMvCache();

        // allTime reaches back further than the MV path's fixed 6-month window,
        // proving the live query ran.
        await insertTxn({
          dateExpr: monthDay(8, 10),
          amount: "-11.00",
          recipientId: rec.misc,
        });
        const allTime = await getMonthlyFinancialSummary([], "EUR", [], true);
        expect(allTime.months.length).toBeGreaterThan(6);
        expect(byMonth(allTime)[await monthKey(8)].total_spending).toBe(-11);

        // An exclusion likewise forces the live path — and is honoured.
        const excluded = await getMonthlyFinancialSummary(
          [cat.Food],
          "EUR",
          [],
          false,
        );
        expect(byMonth(excluded)[await monthKey(1)].total_spending).toBe(-200);
      });
    });

    // ───────────────────────────────────────────────────────────────────────────
    // One clock: the app-date anchor across a month rollover (same technique as
    // infoRepoForecast.db.test.js — only `Date` is faked; the DB keeps its real
    // clock, faithfully reproducing "the app is a month ahead of CURRENT_DATE",
    // the ~2h window before UTC midnight on every month's last day).
    // ───────────────────────────────────────────────────────────────────────────
    describe("one clock: APP_TIMEZONE anchor across a month rollover", () => {
      // These fixtures deliberately anchor on the REAL DB clock (`now()`, which
      // the anchored() substitution leaves alone — `CURRENT_DATE` would be
      // rewritten to the app date): the premise is "app clock one month ahead
      // of the DB's month".
      // Day 5 of the month five months before the one Postgres is in — inside a
      // CURRENT_DATE-anchored window, OUTSIDE the app-anchored one.
      const oldestDbWindowMonthDay5 =
        "date_trunc('month', now()) - interval '5 months' + interval '4 days'";
      // Day 5 of the month Postgres is in — the app clock's LAST COMPLETE month.
      const dbMonthDay5 = "date_trunc('month', now()) + interval '4 days'";
      // Day 1 of the month the app clock is in — its "today".
      const appToday = "date_trunc('month', now()) + interval '1 month'";

      afterEach(() => {
        vi.useRealTimers();
      });

      /**
       * Freeze the process clock inside the rollover window and return the
       * APP_TIMEZONE calendar facts the assertions are written against.
       *
       * Only `Date` is faked: pg's connection/statement timers must keep running
       * or the pool stalls.
       */
      async function pinClockToRollover() {
        const { rows } = await getTestPool().query(`
        SELECT to_char(date_trunc('month', CURRENT_DATE) + interval '1 month', 'YYYY-MM-DD') AS app_today,
               to_char(date_trunc('month', CURRENT_DATE) + interval '1 month', 'YYYY-MM')     AS app_month,
               to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM')                          AS db_month,
               to_char(date_trunc('month', CURRENT_DATE) - interval '4 months', 'YYYY-MM')    AS app_window_start,
               to_char(date_trunc('month', CURRENT_DATE) - interval '5 months', 'YYYY-MM')    AS db_window_start
      `);
        const facts = rows[0];
        // 00:30 of that app-timezone day == 22:30/23:30 UTC on the day before.
        const instant = new Date(
          appDateStringToUtc(facts.app_today).getTime() + 30 * 60_000,
        );
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(instant);

        // Guard the premise: the app clock reads the 1st of the next month while
        // the UTC calendar day — the one CURRENT_DATE would report — is still in
        // the month before it.
        expect(todayAppDateString()).toBe(facts.app_today);
        expect(instant.toISOString().slice(0, 7)).toBe(facts.db_month);
        return facts;
      }

      it("live path: the 6-month set and its window both follow the app month", async () => {
        await seedBase();
        await insertTxn({ dateExpr: oldestDbWindowMonthDay5, amount: "-5.00" });
        await insertTxn({ dateExpr: dbMonthDay5, amount: "-40.00" });
        await insertTxn({ dateExpr: appToday, amount: "-10.00" });

        const facts = await pinClockToRollover();
        const r = await getMonthlyFinancialSummary([], "EUR", [], false);

        // Anchored on CURRENT_DATE the series ran db_window_start…db_month: the
        // app month (and the row dated on the app's "today") vanished from the
        // dashboard while a stale sixth-back month stayed in.
        const keys = r.months.map(
          (m) => `${m.year}-${String(m.month).padStart(2, "0")}`,
        );
        expect(r.months).toHaveLength(6);
        expect(keys[0]).toBe(facts.app_window_start);
        expect(keys[keys.length - 1]).toBe(facts.app_month);
        expect(keys).not.toContain(facts.db_window_start);
        const months = byMonth(r);
        expect(months[facts.app_month]).toMatchObject({
          total_spending: -10,
          transaction_count: 1,
        });
        expect(months[facts.db_month]).toMatchObject({
          total_spending: -40,
          transaction_count: 1,
        });
      });

      it("MV fast path: SQL filter and JS zero-fill agree on ONE 6-month set", async () => {
        await seedBase();
        await insertTxn({ dateExpr: oldestDbWindowMonthDay5, amount: "-5.00" });
        await insertTxn({ dateExpr: dbMonthDay5, amount: "-40.00" });
        await createMaterializedViews();
        clearMvCache();

        const facts = await pinClockToRollover();
        const r = await getMonthlyFinancialSummary([], "EUR", [], false);

        // Pre-fix the MV filter (CURRENT_DATE) admitted db_window_start…db_month
        // while the zero-fill (app clock) keyed app_window_start…app_month — a
        // SEVEN-month union on the dashboard. One bound clock ⇒ exactly the
        // app's six months, stale month dropped, app month zero-filled.
        const keys = r.months.map(
          (m) => `${m.year}-${String(m.month).padStart(2, "0")}`,
        );
        expect(r.months).toHaveLength(6);
        expect(keys[0]).toBe(facts.app_window_start);
        expect(keys[keys.length - 1]).toBe(facts.app_month);
        expect(keys).not.toContain(facts.db_window_start);
        const months = byMonth(r);
        expect(months[facts.db_month]).toMatchObject({
          total_spending: -40,
          transaction_count: 1,
        });
        expect(months[facts.app_month]).toMatchObject({
          total_spending: 0,
          transaction_count: 0,
        });
      });
    });
  },
);
