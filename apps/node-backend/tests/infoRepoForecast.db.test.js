/**
 * Real-Postgres tests for infoRepositoryForecast — `getCashflowComparison`,
 * `getCashflowForecastData`, `getCashflowForecastDataRolling` and
 * `getCashflowForecastDataByCategory`.
 *
 * DB-backed complement to infoRepoForecast.test.js (which stays: it runs without
 * a DB, and its argument-validation cases are pure JS with no DB reachable).
 * The mock suite pins SQL text — `interval '12 months'`, `planned_date >
 * CURRENT_DATE`, param numbering — and hand-feeds already-converted rows into
 * the JS reducers. It therefore proves nothing about which rows Postgres puts in
 * (or leaves out of) each window, which is where every behaviour below lives:
 * the four/three/two parallel window predicates, the planned-transaction
 * overlays and their `is_executed` gate, the 3-level effective-category JOIN,
 * and per-date FX off seeded `exchange_rates` rows.
 *
 * Determinism: every window is anchored on `CURRENT_DATE`, so no fixture uses a
 * literal calendar date — dates are SQL expressions relative to the same anchors
 * the queries use, and day-of-month expectations are derived from the response's
 * own `current_day` / `days_in_month`. Day 5 and day 10 exist in every month, so
 * the past-month averages are exact regardless of when the suite runs.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import {
  getCashflowComparison,
  getCashflowForecastData,
  getCashflowForecastDataRolling,
  getCashflowForecastDataByCategory,
} from '../src/repositories/infoRepositoryForecast.js';
import { getAverageVsCurrentSpending } from '../src/repositories/infoRepositoryAverageVsCurrent.js';
import { clearMvCache } from '../src/repositories/infoRepositoryHelpers.js';
import { clearMemoryCache } from '../src/services/currency/currencyConversionService.js';
import { closePool } from '../src/database/connection.js';

const cat = {};
const rec = {};

/** Day N of the month `monthsBack` months before the current one, as 'YYYY-MM-DD'. */
const monthDay = (monthsBack, day) =>
  `date_trunc('month', CURRENT_DATE) - interval '${monthsBack} months' + interval '${day - 1} days'`;

/** 'YYYY-MM-DD' for an arbitrary date expression. */
async function ymd(dateExpr) {
  const { rows } = await getTestPool().query(`SELECT to_char((${dateExpr})::date, 'YYYY-MM-DD') AS d`);
  return rows[0].d;
}

/**
 * Categories and the alias topology: `Electrabel` (primary, default category
 * Bills) with alias `Electrabel Invoicing` carrying no category of its own —
 * the 3-level effective-category case the by-category forecast must resolve.
 */
async function seedBase() {
  const pool = getTestPool();
  for (const [key, [general, detail]] of Object.entries({
    Food: ['Food', 'Groceries'],
    Bills: ['Bills', 'Utilities'],
  })) {
    const { rows } = await pool.query(
      'INSERT INTO categories (general, detail) VALUES ($1, $2) RETURNING id',
      [general, detail],
    );
    cat[key] = rows[0].id;
  }
  const addRecipient = async (name, { defaultCategoryId = null, primaryId = null } = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO recipients (name, normalized_name, default_category_id, primary_recipient_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, name.toLowerCase(), defaultCategoryId, primaryId],
    );
    return rows[0].id;
  };
  rec.electrabel = await addRecipient('Electrabel', { defaultCategoryId: cat.Bills });
  rec.electrabelAlias = await addRecipient('Electrabel Invoicing', { primaryId: rec.electrabel });
  rec.misc = await addRecipient('Misc Payee');
}

/**
 * Ensure an accounts row exists for a label (the transactions dual-write trigger
 * resolves `bank_account` → `account_id`; pre-creating keeps fixture setup
 * independent of the trigger).
 */
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
  currency = 'EUR',
  recipientId = null,
  categoryId = null,
  bank = 'MAIN BANK',
  isActive = true,
  isTransfer = false,
}) {
  if (bank) await ensureAccount(bank);
  const { rows } = await getTestPool().query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, category_id, bank_account, is_active, is_transfer)
     VALUES ((${dateExpr})::date, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [amount, currency, recipientId ?? rec.misc, categoryId, bank, isActive, isTransfer],
  );
  return rows[0].id;
}

async function insertPlanned({
  dateExpr,
  amount,
  currency = 'EUR',
  isActive = true,
  isExecuted = false,
}) {
  await getTestPool().query(
    `INSERT INTO planned_transactions (planned_date, amount, currency, is_active, is_executed)
     VALUES ((${dateExpr})::date, $1, $2, $3, $4)`,
    [amount, currency, isActive, isExecuted],
  );
}

/** Seed one exchange_rates row so conversion resolves from the DB, never the network. */
async function insertRate(code, dateExpr, rate, isLatest = true) {
  await getTestPool().query(
    `INSERT INTO exchange_rates (currency_code, rate_date, rate_to_eur, is_latest)
     VALUES ($1, (${dateExpr})::date, $2, $3)`,
    [code, rate, isLatest],
  );
}

describe.skipIf(!hasTestDatabase())('repositories/infoRepositoryForecast (real DB)', () => {
  beforeAll(async () => {
    expect(
      process.env.DATABASE_URL,
      'DATABASE_URL must equal TEST_DATABASE_URL for this suite (see scripts/with-test-db.sh)',
    ).toBe(process.env.TEST_DATABASE_URL);
    // DB suites share one database across parallel vitest workers — serialize.
    await acquireDbSuiteLock();
  }, 180_000);

  afterEach(async () => {
    const pool = getTestPool();
    await pool.query('DELETE FROM planned_transactions');
    await pool.query('DELETE FROM transactions');
    await pool.query('DELETE FROM accounts');
    await pool.query('DELETE FROM recipients');
    await pool.query('DELETE FROM categories');
    await pool.query('DELETE FROM exchange_rates');
    await pool.query(`DELETE FROM user_settings WHERE key = 'includeTransfers'`);
    for (const bag of [cat, rec]) for (const k of Object.keys(bag)) delete bag[k];
    clearMemoryCache();
    clearMvCache();
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getCashflowComparison
  // ───────────────────────────────────────────────────────────────────────────
  describe('getCashflowComparison', () => {
    it('averages the running cumulative net across the months that HAVE data', async () => {
      await seedBase();
      // Two past months inside the 24-month window; day 5 and day 10 exist in
      // every month, so these day buckets are calendar-independent.
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '100.00' });
      await insertTxn({ dateExpr: monthDay(1, 10), amount: '-30.00' });
      await insertTxn({ dateExpr: monthDay(2, 5), amount: '60.00' });
      // Outside the 24-month window — must not enter the average.
      await insertTxn({ dateExpr: monthDay(25, 5), amount: '9999.00' });
      // Inactive rows never count.
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '-777.00', isActive: false });

      const r = await getCashflowComparison([], [], 'EUR');
      const byDay = Object.fromEntries(r.without_planned.map((d) => [d.day, d]));

      // Divisor is the number of months WITH rows (2), not the 24-month span.
      expect(byDay[4].average).toBe(0);
      expect(byDay[5].average).toBe(80); // (100 + 60) / 2
      expect(byDay[9].average).toBe(80); // cumulative carries forward
      expect(byDay[10].average).toBe(65); // ((100 − 30) + 60) / 2
      expect(byDay[r.days_in_month].average).toBe(65);
    });

    it('accumulates the current month up to today and leaves later days null', async () => {
      await seedBase();
      await insertTxn({ dateExpr: monthDay(0, 1), amount: '50.00' });
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-10.00' });
      // A future-dated row inside this month is invisible (t.date <= CURRENT_DATE).
      await insertTxn({ dateExpr: "date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day'", amount: '-500.00' });

      const r = await getCashflowComparison([], [], 'EUR');
      const byDay = Object.fromEntries(r.without_planned.map((d) => [d.day, d]));

      expect(byDay[1].current).not.toBeNull();
      // Cumulative through today covers both current-month rows (they collapse
      // onto one day when the suite runs on the 1st).
      expect(byDay[r.current_day].current).toBe(40);
      if (r.current_day < r.days_in_month) {
        expect(byDay[r.current_day + 1].current).toBeNull();
        expect(byDay[r.days_in_month].current).toBeNull();
      }
      expect(r.without_planned).toHaveLength(r.days_in_month);
      expect(r.with_planned).toHaveLength(r.days_in_month);
    });

    it('overlays unexecuted planned transactions, in both the current month and the historical average', async () => {
      await seedBase();
      await insertTxn({ dateExpr: monthDay(0, 1), amount: '50.00' });
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-10.00' });
      await insertPlanned({ dateExpr: monthDay(0, 1), amount: '-20.00' });
      // Executed / inactive planned rows must not double-count against the real
      // transactions they already produced.
      await insertPlanned({ dateExpr: monthDay(0, 1), amount: '-4000.00', isExecuted: true });
      await insertPlanned({ dateExpr: monthDay(0, 1), amount: '-5000.00', isActive: false });
      // One historical planned month → its own cumulative average.
      await insertPlanned({ dateExpr: monthDay(1, 5), amount: '-40.00' });

      const r = await getCashflowComparison([], [], 'EUR');
      const plain = Object.fromEntries(r.without_planned.map((d) => [d.day, d]));
      const planned = Object.fromEntries(r.with_planned.map((d) => [d.day, d]));

      expect(planned[r.current_day].current).toBe(plain[r.current_day].current - 20);
      expect(planned[4].average).toBe(plain[4].average);
      expect(planned[5].average).toBe(plain[5].average - 40);
    });

    it('applies alias-aware category and recipient exclusions to the live rows', async () => {
      await seedBase();
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '100.00', recipientId: rec.misc, categoryId: cat.Food });
      // Categorised only via the PRIMARY of its alias (3rd resolution level).
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '200.00', recipientId: rec.electrabelAlias });

      const all = await getCashflowComparison([], [], 'EUR');
      expect(all.without_planned.find((d) => d.day === 5).average).toBe(300);

      // Excluding Bills drops the alias row even though it carries no category_id.
      const exclCat = await getCashflowComparison([cat.Bills], [], 'EUR');
      expect(exclCat.without_planned.find((d) => d.day === 5).average).toBe(100);

      // Excluding the PRIMARY recipient also drops rows recorded under its alias.
      const exclRec = await getCashflowComparison([], [rec.electrabel], 'EUR');
      expect(exclRec.without_planned.find((d) => d.day === 5).average).toBe(100);
    });

    it('converts each day at its own stored rate', async () => {
      await seedBase();
      await insertRate('USD', monthDay(1, 5), '0.5', false);
      await insertRate('USD', monthDay(2, 5), '0.25', false);
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '100.00', currency: 'USD' });
      await insertTxn({ dateExpr: monthDay(2, 5), amount: '100.00', currency: 'USD' });

      const r = await getCashflowComparison([], [], 'EUR');
      // Same nominal amount, different months, different rates: (50 + 25) / 2.
      expect(r.without_planned.find((d) => d.day === 5).average).toBe(37.5);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getCashflowForecastData / …Rolling
  // ───────────────────────────────────────────────────────────────────────────
  describe('getCashflowForecastData', () => {
    it('splits history / currentActual / plannedCurrent / plannedHist on the real window boundaries', async () => {
      await seedBase();
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '100.00' });
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '-40.00' }); // same day → summed
      await insertTxn({ dateExpr: monthDay(2, 5), amount: '10.00' });
      await insertTxn({ dateExpr: monthDay(4, 5), amount: '9999.00' }); // outside a 3-month history
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-7.00' });
      await insertPlanned({ dateExpr: monthDay(0, 1), amount: '-20.00' });
      await insertPlanned({ dateExpr: monthDay(1, 5), amount: '-30.00' });

      const r = await getCashflowForecastData(3, [], [], 'EUR');

      expect(r.historyMonths).toBe(3);
      expect(r.history).toEqual([
        { date: await ymd(monthDay(2, 5)), net: 10 },
        { date: await ymd(monthDay(1, 5)), net: 60 }, // 100 − 40, ascending by date
      ]);
      expect(r.currentActual).toEqual([{ date: await ymd('CURRENT_DATE'), net: -7 }]);
      expect(r.plannedCurrent).toEqual([{ date: await ymd(monthDay(0, 1)), net: -20 }]);
      expect(r.plannedHist).toEqual([{ date: await ymd(monthDay(1, 5)), net: -30 }]);
    });
  });

  describe('getCashflowForecastDataRolling', () => {
    it('keeps history strictly before the rolling window and only future planned rows', async () => {
      await seedBase();
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '40 days'", amount: '100.00' });
      // Exactly on the boundary: history is `< CURRENT_DATE - daysBack`, current
      // is `>= CURRENT_DATE - daysBack`, so this row belongs to currentActual.
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '30 days'", amount: '5.00' });
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-3.00' });
      await insertPlanned({ dateExpr: 'CURRENT_DATE', amount: '-99.00' }); // not > CURRENT_DATE
      await insertPlanned({ dateExpr: "CURRENT_DATE + interval '10 days'", amount: '-50.00' });
      await insertPlanned({ dateExpr: "CURRENT_DATE + interval '90 days'", amount: '-11.00' }); // beyond daysForward

      const r = await getCashflowForecastDataRolling(12, 30, 60, [], [], 'EUR');

      expect(r.history).toEqual([{ date: await ymd("CURRENT_DATE - interval '40 days'"), net: 100 }]);
      expect(r.currentActual).toEqual([
        { date: await ymd("CURRENT_DATE - interval '30 days'"), net: 5 },
        { date: await ymd('CURRENT_DATE'), net: -3 },
      ]);
      expect(r.plannedCurrent).toEqual([
        { date: await ymd("CURRENT_DATE + interval '10 days'"), net: -50 },
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getCashflowForecastDataByCategory
  // ───────────────────────────────────────────────────────────────────────────
  describe('getCashflowForecastDataByCategory', () => {
    it('resolves the effective category over all three levels and labels the rest Uncategorized', async () => {
      await seedBase();
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '-50.00', recipientId: rec.misc, categoryId: cat.Food });
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '-25.00', recipientId: rec.misc, categoryId: cat.Food });
      // Own category NULL, alias's own default NULL → resolved via the PRIMARY.
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '-1000.00', recipientId: rec.electrabelAlias });
      // Uncategorised at all three levels.
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '-10.00', recipientId: rec.misc });
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-5.00', recipientId: rec.misc, categoryId: cat.Food });

      const r = await getCashflowForecastDataByCategory(3, [], [], 'EUR');
      const day = await ymd(monthDay(1, 5));

      expect(r.historyByCategory).toEqual(
        expect.arrayContaining([
          { date: day, category_id: cat.Food, general: 'Food', detail: 'Groceries', net: -75 },
          { date: day, category_id: cat.Bills, general: 'Bills', detail: 'Utilities', net: -1000 },
          { date: day, category_id: null, general: 'Uncategorized', detail: 'Uncategorized', net: -10 },
        ]),
      );
      expect(r.historyByCategory).toHaveLength(3);
      expect(r.currentActualByCategory).toEqual([
        { date: await ymd('CURRENT_DATE'), category_id: cat.Food, general: 'Food', detail: 'Groceries', net: -5 },
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PINNED real-DB behaviours (see the suite report — do NOT "fix" here)
  // ───────────────────────────────────────────────────────────────────────────
  describe('pinned discrepancies (current real behaviour)', () => {
    // PIN — internal transfers are counted by every cash-flow forecast surface.
    //
    // ADR-083 says internal transfers must not inflate cash-flow aggregates
    // unless the user opts in via the `includeTransfers` setting. Two sibling
    // repositories honour that: infoRepositoryAverageVsCurrent.js:22-23 and
    // infoRepositoryMonthly.js:38/194 both read getIncludeTransfers() and add
    // `AND t.is_transfer = false`. Every query in infoRepositoryForecast.js —
    // sqlPast/sqlCurrent (lines 93-116), getCashflowForecastData's two
    // (261-280), …Rolling's two (362-381) and …ByCategory's two (462-479) —
    // filters on `t.is_active = true` ONLY, with no transfer predicate and no
    // getIncludeTransfers() call anywhere in the module. So the dashboard
    // cash-flow chart and the forecast pipeline count both legs of an internal
    // transfer while the monthly/average surfaces on the SAME dashboard do not.
    // The mock suite asserted the SQL substrings it expected to be present and
    // never noticed the absent one. Pinned as-is, with the contrast against
    // getAverageVsCurrentSpending asserted on the identical fixture.
    it('PIN: transfers inflate the cashflow comparison while getAverageVsCurrentSpending excludes them', async () => {
      await seedBase();
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-100.00', isTransfer: false });
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-900.00', isTransfer: true });

      const comparison = await getCashflowComparison([], [], 'EUR');
      const current = comparison.without_planned.find((d) => d.day === comparison.current_day);
      expect(current.current).toBe(-1000); // transfer leg included

      const avg = await getAverageVsCurrentSpending('EUR');
      expect(avg.current_month.total_spending).toBe(100); // transfer leg excluded

      // The forecast pipeline inherits the same inclusion.
      const forecast = await getCashflowForecastData(3, [], [], 'EUR');
      expect(forecast.currentActual).toEqual([{ date: await ymd('CURRENT_DATE'), net: -1000 }]);
    });

    // PIN — the historical average divides by "months that have rows", so a
    // single outlier month in a 24-month window is reported at FULL weight
    // instead of being averaged down. Seeding one month with 240 makes the
    // "average" 240, not 240/24 = 10. Consequence: a ledger with sparse
    // history draws an average line as tall as its single busiest month.
    it('PIN: the 24-month average divides by populated months only, not by the window', async () => {
      await seedBase();
      await insertTxn({ dateExpr: monthDay(7, 5), amount: '240.00' });

      const r = await getCashflowComparison([], [], 'EUR');
      expect(r.without_planned.find((d) => d.day === 5).average).toBe(240);
    });
  });
});
