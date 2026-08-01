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
    it('averages the running cumulative net across the elapsed months of history', async () => {
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

      // Divisor is the elapsed months since this ledger's earliest in-window
      // month (2 months back → 2), not the full 24-month span. The 25-months-back
      // row is outside the window, so it does not stretch the span either.
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
  // ADR-083 transfer exclusion (was a PIN: the module counted transfer legs)
  // ───────────────────────────────────────────────────────────────────────────
  describe('ADR-083 internal-transfer exclusion', () => {
    // Was pinned as a discrepancy: every query in infoRepositoryForecast.js
    // filtered on `t.is_active = true` only, with no getIncludeTransfers() call
    // anywhere in the module, while the sibling surfaces on the SAME dashboard
    // (infoRepositoryAverageVsCurrent.js:22-23, infoRepositoryMonthly.js:38/194)
    // honoured the setting. On this fixture the cash-flow chart read −1000 and
    // the avg-vs-current card read 100. Now all three agree.
    it('excludes transfer legs from the comparison, matching getAverageVsCurrentSpending', async () => {
      await seedBase();
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-100.00', isTransfer: false });
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-900.00', isTransfer: true });

      const comparison = await getCashflowComparison([], [], 'EUR');
      const current = comparison.without_planned.find((d) => d.day === comparison.current_day);
      expect(current.current).toBe(-100); // transfer leg excluded

      const avg = await getAverageVsCurrentSpending('EUR');
      expect(avg.current_month.total_spending).toBe(100); // same fixture, same answer

      // The forecast pipeline inherits the exclusion.
      const forecast = await getCashflowForecastData(3, [], [], 'EUR');
      expect(forecast.currentActual).toEqual([{ date: await ymd('CURRENT_DATE'), net: -100 }]);
    });

    it('excludes transfer legs from the rolling and by-category surfaces too', async () => {
      await seedBase();
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-100.00', recipientId: rec.misc, categoryId: cat.Food });
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-900.00', recipientId: rec.misc, categoryId: cat.Food, isTransfer: true });
      // History side of both windows: 45 days back is always before this
      // month's start (byCat's boundary) AND before CURRENT_DATE - 30 days
      // (rolling's boundary) — monthDay(1, 5) is not on the first days of a
      // month, where it falls inside the trailing 30-day current window.
      const histDate = "CURRENT_DATE - interval '45 days'";
      await insertTxn({ dateExpr: histDate, amount: '50.00' });
      await insertTxn({ dateExpr: histDate, amount: '-700.00', isTransfer: true });

      const rolling = await getCashflowForecastDataRolling(12, 30, 60, [], [], 'EUR');
      expect(rolling.currentActual).toEqual([{ date: await ymd('CURRENT_DATE'), net: -100 }]);
      expect(rolling.history).toEqual([{ date: await ymd(histDate), net: 50 }]);

      const byCat = await getCashflowForecastDataByCategory(3, [], [], 'EUR');
      expect(byCat.currentActualByCategory).toEqual([
        { date: await ymd('CURRENT_DATE'), category_id: cat.Food, general: 'Food', detail: 'Groceries', net: -100 },
      ]);
      // The transfer leg would otherwise invent −900 of "Food" spending.
      expect(byCat.historyByCategory).toEqual([
        { date: await ymd(histDate), category_id: null, general: 'Uncategorized', detail: 'Uncategorized', net: 50 },
      ]);
    });

    // It is a runtime setting, not a hardcoded filter: opting in must bring the
    // legs back, on every surface.
    it('counts transfer legs again when includeTransfers is switched on', async () => {
      await seedBase();
      await getTestPool().query(
        `INSERT INTO user_settings (key, value) VALUES ('includeTransfers', 'true'::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-100.00' });
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-900.00', isTransfer: true });

      const comparison = await getCashflowComparison([], [], 'EUR');
      const current = comparison.without_planned.find((d) => d.day === comparison.current_day);
      expect(current.current).toBe(-1000);

      const forecast = await getCashflowForecastData(3, [], [], 'EUR');
      expect(forecast.currentActual).toEqual([{ date: await ymd('CURRENT_DATE'), net: -1000 }]);

      const rolling = await getCashflowForecastDataRolling(12, 30, 60, [], [], 'EUR');
      expect(rolling.currentActual).toEqual([{ date: await ymd('CURRENT_DATE'), net: -1000 }]);

      const byCat = await getCashflowForecastDataByCategory(3, [], [], 'EUR');
      expect(byCat.currentActualByCategory).toEqual([
        { date: await ymd('CURRENT_DATE'), category_id: null, general: 'Uncategorized', detail: 'Uncategorized', net: -1000 },
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Historical-average denominator (was a PIN: divided by populated months)
  // ───────────────────────────────────────────────────────────────────────────
  describe('historical average denominator', () => {
    // Was pinned as a discrepancy: the divisor was the number of months that
    // HAPPEN to carry rows, so one 240 month in a 24-month window reported an
    // "average" of 240 — a sparse ledger drew an average line as tall as its
    // single busiest month. An elapsed month with no rows is a real zero.
    it('divides a sparse window by every elapsed month, not by the populated ones', async () => {
      await seedBase();
      // Oldest month inside the 24-month window → the ledger's observed span is
      // the full window, so the divisor is 24.
      await insertTxn({ dateExpr: monthDay(24, 5), amount: '240.00' });

      const r = await getCashflowComparison([], [], 'EUR');
      expect(r.without_planned.find((d) => d.day === 5).average).toBe(10); // 240 / 24
    });

    // …and the counterweight: dividing by the whole window unconditionally
    // would deflate a young ledger. Months BEFORE the first entry are not
    // observations (the app did not exist for that user), so they must not be
    // charged as zeros. Fresh-install shape: history starts 3 months ago.
    it('does not charge phantom zeros for months before the ledger started', async () => {
      await seedBase();
      // Ledger opens 3 months back; month −2 is genuinely empty, month −1 has data.
      await insertTxn({ dateExpr: monthDay(3, 5), amount: '30.00' });
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '30.00' });

      const r = await getCashflowComparison([], [], 'EUR');
      // 60 / 3 elapsed months. Old behaviour (populated months only) gave 30;
      // dividing by the 24-month window would give 2.5.
      expect(r.without_planned.find((d) => d.day === 5).average).toBe(20);
    });

    it('counts every elapsed month once history is contiguous', async () => {
      await seedBase();
      for (const back of [3, 2, 1]) {
        await insertTxn({ dateExpr: monthDay(back, 5), amount: '30.00' });
      }

      const r = await getCashflowComparison([], [], 'EUR');
      expect(r.without_planned.find((d) => d.day === 5).average).toBe(30); // 90 / 3
    });

    // One divisor for both historical series: a month with transactions but no
    // planned rows is a month in which the user planned nothing (a real zero),
    // so the planned overlay must not be re-based onto its own shorter span.
    // Orientation A — ledger OLDER than the plan.
    it('shares the ledger-wide divisor with the planned-history overlay', async () => {
      await seedBase();
      await insertTxn({ dateExpr: monthDay(3, 5), amount: '30.00' });
      await insertPlanned({ dateExpr: monthDay(1, 5), amount: '-60.00' });

      const r = await getCashflowComparison([], [], 'EUR');
      const plain = r.without_planned.find((d) => d.day === 5);
      const planned = r.with_planned.find((d) => d.day === 5);

      expect(plain.average).toBe(10); // 30 / 3
      // −60 / 3, not −60 / 1: the planned series rides the same 3-month span.
      expect(planned.average).toBe(-10);
    });

    // Orientation B — plan OLDER than the ledger, the orientation where a
    // union-of-keys divisor breaks. A recurring plan the auto-linker never
    // matched keeps its original past planned_date forever, so a one-month-old
    // ledger can easily carry an un-executed row dated 24 months back. That row
    // must not stretch the divisor: it deflated the transactions average 24x
    // (30 → 1.25), the exact "short history" failure the divisor exists to stop.
    it('does not let a stale planned row stretch the divisor backwards', async () => {
      await seedBase();
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '30.00' });
      await insertPlanned({ dateExpr: monthDay(24, 5), amount: '-60.00' });

      const r = await getCashflowComparison([], [], 'EUR');
      // Ledger is one complete month old → divisor 1, so the transactions
      // average is untouched by the plan's age.
      expect(r.without_planned.find((d) => d.day === 5).average).toBe(30);
      // The stale plan still contributes its numerator on the with-planned
      // line (it is inside the window); it just cannot move the denominator.
      expect(r.with_planned.find((d) => d.day === 5).average).toBe(-30);
    });

    // The divisor answers "when did this ledger start", which is a property of
    // the ledger — not of the current view. Deriving it from the filtered rows
    // let an exclusion that empties the oldest months re-base it, so toggling a
    // category exclusion moved the average line by a factor unrelated to the
    // rows it removed.
    it('keeps the divisor when a category exclusion empties the oldest month', async () => {
      await seedBase();
      // Oldest month is Food-only; excluding Food empties it entirely.
      await insertTxn({ dateExpr: monthDay(3, 5), amount: '30.00', recipientId: rec.misc, categoryId: cat.Food });
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '30.00', recipientId: rec.misc });

      const all = await getCashflowComparison([], [], 'EUR');
      expect(all.without_planned.find((d) => d.day === 5).average).toBe(20); // 60 / 3

      const exclFood = await getCashflowComparison([cat.Food], [], 'EUR');
      // Numerator drops to 30, denominator stays 3 → 10. If the divisor came
      // from the filtered rows it would re-base to 1 and report 30.
      expect(exclFood.without_planned.find((d) => d.day === 5).average).toBe(10);
    });

    // Same argument for the ADR-083 filter itself: excluding transfer legs must
    // change the numerator only.
    it('keeps the divisor when the transfer filter empties the oldest month', async () => {
      await seedBase();
      await insertTxn({ dateExpr: monthDay(3, 5), amount: '30.00', isTransfer: true });
      await insertTxn({ dateExpr: monthDay(1, 5), amount: '30.00' });

      const r = await getCashflowComparison([], [], 'EUR');
      expect(r.without_planned.find((d) => d.day === 5).average).toBe(10); // 30 / 3, not 30 / 1
    });

    // Soft-deleted rows are not history, so they do not establish the start.
    it('ignores inactive rows when locating the ledger start', async () => {
      await seedBase();
      await insertTxn({ dateExpr: monthDay(12, 5), amount: '-5000.00', isActive: false });
      await insertTxn({ dateExpr: monthDay(2, 5), amount: '30.00' });

      const r = await getCashflowComparison([], [], 'EUR');
      expect(r.without_planned.find((d) => d.day === 5).average).toBe(15); // 30 / 2
    });
  });
});
