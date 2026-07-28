/**
 * Real-Postgres tests for the infoRepository barrel — the sub-repositories that
 * only reach a consumer through it and have no dedicated DB suite of their own:
 * `getNetWorthFromSnapshots` (infoRepositoryNetWorth), `getPlannedExpensesNextMonth`
 * (infoRepositoryPlanned) and `getAverageVsCurrentSpending`
 * (infoRepositoryAverageVsCurrent), plus the barrel's own assembly.
 *
 * DB-backed complement to infoRepository.test.js (which stays: it runs without a
 * DB). That mock suite dispatches on SQL substrings — `if (sql.includes('WITH
 * anchor'))`, `if (sql.includes('account_list'))` — to decide which canned rows
 * to hand back, so it asserts the shape of the JS reducers and the presence of
 * SQL fragments, never what the statements return. Everything here runs against
 * the migrated schema: the stamped history walk and the shared anchor+delta
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

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import infoRepository from '../src/repositories/infoRepository.js';
import { clearMvCache } from '../src/repositories/infoRepositoryHelpers.js';
import { clearMemoryCache } from '../src/services/currency/currencyConversionService.js';
import { closePool } from '../src/database/connection.js';
import { todayAppDateString, addDaysYmd, firstOfMonthYmd } from '../src/lib/timezone.js';

const cat = {};
const rec = {};

const TODAY = () => todayAppDateString();

async function seedBase() {
  const pool = getTestPool();
  for (const [key, [general, detail]] of Object.entries({
    Food: ['Food', 'Groceries'],
    Rent: ['Home', 'Rent'],
  })) {
    const { rows } = await pool.query(
      'INSERT INTO categories (general, detail) VALUES ($1, $2) RETURNING id',
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
async function addAccount(name, { type = 'checking', inNetWorth = true, currency = 'EUR' } = {}) {
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
  currency = 'EUR',
  bank = 'MAIN BANK',
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
    [date, amount, currency, rec.misc, categoryId, bank, balance, isActive, isTransfer],
  );
  return rows[0].id;
}

async function insertSnapshot(date, value, currency = 'EUR') {
  await getTestPool().query(
    `INSERT INTO portfolio_performance_snapshots (snapshot_date, value, currency)
     VALUES ($1::date, $2, $3)`,
    [date, value, currency],
  );
}

async function insertPlanned({
  date,
  amount,
  currency = 'EUR',
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
    [date, amount, currency, rec.misc, categoryId, recurring, pattern, isActive, isExecuted],
  );
  return rows[0].id;
}

describe.skipIf(!hasTestDatabase())('repositories/infoRepository barrel (real DB)', () => {
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
    await pool.query('DELETE FROM portfolio_performance_snapshots');
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
  // Barrel assembly
  // ───────────────────────────────────────────────────────────────────────────
  it('assembles every sub-repository method onto one object, all callable against the DB', async () => {
    // The exact assembled surface. Note what is NOT here: the module's own
    // header comment (infoRepository.js:9-10) advertises `getStatistics` and
    // `getTransactionSummary` on infoRepositoryStatistics, and neither exists —
    // that sub-module exports getCategoryBreakdown/getBanks/getTransactionCount/
    // getCategoryPivot only. Pinning the key set keeps the drift visible.
    const expected = [
      'getAverageVsCurrentSpending',
      'getBankBalances',
      'getBanks',
      'getCashflowComparison',
      'getCashflowForecastData',
      'getCashflowForecastDataByCategory',
      'getCashflowForecastDataRolling',
      'getCategoryBreakdown',
      'getCategoryPivot',
      // Not a sub-repository query: the ADR-083 toggle read, exposed on the
      // barrel because the forecast cache key needs it before deciding whether
      // to call any of the queries around it.
      'getIncludeTransfers',
      'getMonthlyFinancialSummary',
      'getNetWorthFromSnapshots',
      'getPlannedExpensesNextMonth',
      'getRecipientByYear',
      'getRecipientInsights',
      'getRecipientPivot',
      'getTransactionCount',
    ];
    expect(Object.keys(infoRepository).sort()).toEqual(expected);
    for (const name of expected) {
      expect(typeof infoRepository[name], `${name} missing from the barrel`).toBe('function');
    }
    // Spread order matters: statisticsRepository and the sub-repositories must
    // not shadow one another. Smoke-call the ones with dedicated DB suites
    // through the barrel to prove the wiring, not the behaviour.
    await seedBase();
    expect(await infoRepository.getBanks()).toEqual([]);
    expect(await infoRepository.getTransactionCount()).toBe(0);
    expect(await infoRepository.getBankBalances()).toMatchObject({ accounts: [], total_net_position: 0 });
    expect((await infoRepository.getMonthlyFinancialSummary([])).months).toHaveLength(6);
    expect(await infoRepository.getRecipientInsights('EUR')).toEqual({ topMerchants: [], monthOverMonth: [] });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getNetWorthFromSnapshots
  // ───────────────────────────────────────────────────────────────────────────
  describe('getNetWorthFromSnapshots', () => {
    it('returns the empty shape when there is no source record at all', async () => {
      expect(await infoRepository.getNetWorthFromSnapshots()).toEqual({
        current: { liquid: 0, liabilities: 0, investments: 0, netWorth: 0 },
        monthlyChange: 0,
        monthlyChangePercent: 0,
        snapshots: [],
      });
    });

    it('walks stamped balances daily, forward-fills investments and splits liabilities out of liquid', async () => {
      await seedBase();
      const today = TODAY();
      const d2 = addDaysYmd(today, -2);
      const d1 = addDaysYmd(today, -1);
      await addAccount('KBC');
      await addAccount('MORTGAGE', { type: 'liability' });

      await insertTxn({ date: d2, amount: '-10.00', bank: 'KBC', balance: '4500.00' });
      await insertTxn({ date: today, amount: '-10.00', bank: 'KBC', balance: '5000.00' });
      await insertTxn({ date: d2, amount: '-1.00', bank: 'MORTGAGE', balance: '-300.00' });
      // Snapshots exist only on two of the three days — the missing day must
      // carry the previous value forward, not collapse to liquid-only.
      await insertSnapshot(d2, '3235');
      await insertSnapshot(today, '4470');

      const r = await infoRepository.getNetWorthFromSnapshots();
      expect(r.snapshots.map((s) => s.date)).toEqual([d2, d1, today]);
      expect(r.snapshots[0]).toMatchObject({ liquid: 4500, liabilities: -300, investments: 3235, netWorth: 7435 });
      expect(r.snapshots[1]).toMatchObject({ liquid: 4500, liabilities: -300, investments: 3235 }); // forward-filled
      expect(r.current).toEqual({ liquid: 5000, liabilities: -300, investments: 4470, netWorth: 9170 });
    });

    it('overrides the CURRENT point with the anchor+delta definition while history stays stamp-based', async () => {
      await seedBase();
      const today = TODAY();
      const d1 = addDaysYmd(today, -1);
      await addAccount('KBC');
      await addAccount('CASH'); // manual-only: never stamped

      await insertTxn({ date: d1, amount: '-10.00', bank: 'KBC', balance: '5000.00' });
      await insertTxn({ date: today, amount: '150.00', bank: 'KBC' }); // unstamped, after the anchor
      await insertTxn({ date: d1, amount: '200.00', bank: 'CASH' }); // never stamped at all

      const r = await infoRepository.getNetWorthFromSnapshots();
      // History: the stamped walk sees KBC only, frozen at its stamp.
      expect(r.snapshots[0]).toMatchObject({ date: d1, liquid: 5000 });
      // Current: 5000 + 150 (post-anchor) + 200 (manual-only account) = 5350.
      expect(r.current.liquid).toBe(5350);
      expect(r.current.netWorth).toBe(5350);
      expect(r.snapshots[r.snapshots.length - 1].liquid).toBe(5350);
    });

    it('falls back to the cumulative transaction flow when nothing is stamped anywhere', async () => {
      await seedBase();
      const today = TODAY();
      const d1 = addDaysYmd(today, -1);
      // No accounts row and no balance stamp → the stamped walk is empty.
      await insertTxn({ date: d1, amount: '1200.00', bank: null });
      await insertTxn({ date: today, amount: '300.00', bank: null });

      const r = await infoRepository.getNetWorthFromSnapshots();
      expect(r.snapshots.map((s) => [s.date, s.liquid])).toEqual([
        [d1, 1200],
        [today, 1500], // cumulative, not per-day
      ]);
      expect(r.current.liquid).toBe(1500);
    });

    it('overlays the live portfolio value on the latest point only', async () => {
      await seedBase();
      const today = TODAY();
      const d1 = addDaysYmd(today, -1);
      await addAccount('KBC');
      await insertTxn({ date: d1, amount: '-1.00', bank: 'KBC', balance: '1000.00' });
      await insertSnapshot(d1, '500');
      await insertSnapshot(today, '600');

      const r = await infoRepository.getNetWorthFromSnapshots('EUR', { liveInvestments: 5123.45 });
      expect(r.current.investments).toBe(5123.45);
      expect(r.current.netWorth).toBe(6123.45);
      expect(r.snapshots[0].investments).toBe(500); // earlier points untouched
      expect(r.snapshots[r.snapshots.length - 1].investments).toBe(5123.45);
    });

    it('measures monthlyChange against the last point before the current month', async () => {
      await seedBase();
      const today = TODAY();
      const monthStart = firstOfMonthYmd(today);
      const dayBefore = addDaysYmd(monthStart, -1);
      await addAccount('KBC');
      await insertTxn({ date: dayBefore, amount: '-1.00', bank: 'KBC', balance: '1000.00' });
      await insertTxn({ date: today, amount: '-1.00', bank: 'KBC', balance: '1100.00' });

      const r = await infoRepository.getNetWorthFromSnapshots();
      expect(r.current.netWorth).toBe(1100);
      expect(r.monthlyChange).toBe(100);
      expect(r.monthlyChangePercent).toBe(10);
    });

    it('excludes tracking-only accounts from both the history walk and the current point', async () => {
      await seedBase();
      const today = TODAY();
      await addAccount('KBC');
      await addAccount('TRACKING', { inNetWorth: false });
      await insertTxn({ date: today, amount: '-1.00', bank: 'KBC', balance: '1000.00' });
      await insertTxn({ date: today, amount: '-1.00', bank: 'TRACKING', balance: '9999.00' });

      const r = await infoRepository.getNetWorthFromSnapshots();
      expect(r.current.liquid).toBe(1000);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getPlannedExpensesNextMonth
  // ───────────────────────────────────────────────────────────────────────────
  describe('getPlannedExpensesNextMonth', () => {
    /** First / last day of the month after the app-timezone current month. */
    const nextMonthStart = () => firstOfMonthYmd(TODAY(), 1);
    const monthAfterStart = () => firstOfMonthYmd(TODAY(), 2);

    it('reports the next-month window and only the rows inside it', async () => {
      await seedBase();
      const start = nextMonthStart();
      const after = monthAfterStart();
      const lastDay = addDaysYmd(after, -1);
      const midNext = addDaysYmd(start, 4);

      await insertPlanned({ date: midNext, amount: '-20.00', categoryId: cat.Rent });
      await insertPlanned({ date: midNext, amount: '50.00' });
      await insertPlanned({ date: TODAY(), amount: '-999.00' }); // current month → out
      await insertPlanned({ date: after, amount: '-888.00' }); // month after → out

      const r = await infoRepository.getPlannedExpensesNextMonth('EUR');
      expect(r.period_start).toBe(start);
      expect(r.period_end).toBe(lastDay);
      // The month/year fields must name the same month period_start does.
      expect(`${r.year}-${String(r.month).padStart(2, '0')}`).toBe(start.slice(0, 7));
      expect(r.daily_data).toHaveLength(1);
      expect(r.daily_data[0]).toMatchObject({ date: midNext, total_income: 50, total_expenses: -20 });
      // Same-day rows come back in whatever order `ORDER BY pt.planned_date`
      // leaves them (no tiebreaker in the SQL), so assert set-wise.
      expect(r.daily_data[0].transactions).toHaveLength(2);
      expect(r.daily_data[0].transactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ amount: -20, category_name: 'Home:Rent', is_recurring: false }),
          expect.objectContaining({ amount: 50, category_name: null }),
        ]),
      );
      expect(r.summary).toMatchObject({
        total_income: 50, total_expenses: -20, net_amount: 30, transaction_count: 2,
      });
    });

    it('ignores executed and inactive planned rows', async () => {
      await seedBase();
      const midNext = addDaysYmd(nextMonthStart(), 4);
      await insertPlanned({ date: midNext, amount: '-10.00' });
      await insertPlanned({ date: midNext, amount: '-4000.00', isExecuted: true });
      await insertPlanned({ date: midNext, amount: '-5000.00', isActive: false });

      const r = await infoRepository.getPlannedExpensesNextMonth('EUR');
      expect(r.summary).toMatchObject({ total_expenses: -10, transaction_count: 1 });
    });

    it('expands a recurring row dated in the CURRENT month into its next-month occurrences', async () => {
      await seedBase();
      const start = nextMonthStart();
      // Weekly, anchored on the 1st of the CURRENT month: the row itself never
      // falls inside next month, so only expansion can surface it.
      await insertPlanned({
        date: firstOfMonthYmd(TODAY()),
        amount: '-50.00',
        recurring: true,
        pattern: 'weekly',
      });

      const r = await infoRepository.getPlannedExpensesNextMonth('EUR');
      expect(r.summary.transaction_count).toBeGreaterThanOrEqual(4);
      expect(r.summary.total_expenses).toBe(-50 * r.summary.transaction_count);
      for (const d of r.daily_data) {
        expect(d.date >= start && d.date < monthAfterStart()).toBe(true);
        // Every occurrence is 7 days after the previous one.
        expect((new Date(`${d.date}T00:00:00Z`) - new Date(`${firstOfMonthYmd(TODAY())}T00:00:00Z`)) % (7 * 86_400_000)).toBe(0);
      }
    });

    it('fast-forwards a stale daily recurrence instead of dropping it (120-hop cap)', async () => {
      await seedBase();
      const start = nextMonthStart();
      const after = monthAfterStart();
      // Anchored ~8 months back: a flat 120-hop walk would run out before
      // reaching next month and the row would silently vanish.
      await insertPlanned({
        date: firstOfMonthYmd(TODAY(), -8),
        amount: '-5.00',
        recurring: true,
        pattern: 'daily',
      });

      const r = await infoRepository.getPlannedExpensesNextMonth('EUR');
      const daysInNextMonth = Math.round(
        (new Date(`${after}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86_400_000,
      );
      expect(r.summary.transaction_count).toBe(daysInNextMonth);
      expect(r.daily_data[0].date).toBe(start);
      expect(r.daily_data[r.daily_data.length - 1].date).toBe(addDaysYmd(after, -1));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // getAverageVsCurrentSpending
  // ───────────────────────────────────────────────────────────────────────────
  describe('getAverageVsCurrentSpending', () => {
    /** Day N of the month `monthsBack` months before the current one. */
    const monthDay = (monthsBack, day) =>
      `date_trunc('month', CURRENT_DATE) - interval '${monthsBack} months' + interval '${day - 1} days'`;

    async function insertTxnAt(dateExpr, amount, opts = {}) {
      const { rows } = await getTestPool().query(`SELECT to_char((${dateExpr})::date, 'YYYY-MM-DD') AS d`);
      return insertTxn({ date: rows[0].d, amount, ...opts });
    }

    it('divides the 6-month spend by calendar days and projects the current month on elapsed days', async () => {
      await seedBase();
      await insertTxnAt(monthDay(1, 10), '-10.00');
      await insertTxnAt(monthDay(2, 10), '-20.00');
      await insertTxnAt(monthDay(2, 10), '5.00'); // income never counts as spending
      await insertTxnAt(monthDay(9, 10), '-9999.00'); // outside the 6-month window
      await insertTxn({ date: TODAY(), amount: '-5.00' });
      await insertTxn({ date: TODAY(), amount: '1.00' });

      const { rows } = await getTestPool().query(`
        SELECT (date_trunc('month', CURRENT_DATE)::date
                - (date_trunc('month', CURRENT_DATE) - interval '6 months')::date) AS n
      `);
      const calendarDays = Number(rows[0].n);

      const r = await infoRepository.getAverageVsCurrentSpending('EUR');
      expect(r.past_6_months.months_counted).toBe(2);
      expect(r.past_6_months.avg_monthly_spending).toBe(15); // 30 / 2 months with rows
      // Rounded to cents by the repository, so compare the rounded figure.
      expect(r.past_6_months.avg_daily_spending).toBe(Math.round((30 / calendarDays) * 100) / 100);
      expect(r.current_month.total_spending).toBe(5);
      expect(r.current_month.daily_data).toEqual([{ date: TODAY(), spending: 5, income: 1 }]);
      const projected = Math.round(((5 / r.current_month.days_elapsed) * r.current_month.days_in_month) * 100) / 100;
      expect(r.comparison.projected_monthly_total).toBe(projected);
      expect(r.comparison.variance).toBe(Math.round((projected - 15) * 100) / 100);
    });

    it('excludes internal transfers by default and includes them when the setting is on', async () => {
      await seedBase();
      await insertTxn({ date: TODAY(), amount: '-100.00' });
      await insertTxn({ date: TODAY(), amount: '-900.00', isTransfer: true });

      expect((await infoRepository.getAverageVsCurrentSpending('EUR')).current_month.total_spending).toBe(100);

      await getTestPool().query(
        `INSERT INTO user_settings (key, value) VALUES ('includeTransfers', 'true'::jsonb)`,
      );
      expect((await infoRepository.getAverageVsCurrentSpending('EUR')).current_month.total_spending).toBe(1000);
    });

    it('ignores inactive rows on both windows', async () => {
      await seedBase();
      await insertTxnAt(monthDay(1, 10), '-40.00', { isActive: false });
      await insertTxn({ date: TODAY(), amount: '-30.00', isActive: false });

      const r = await infoRepository.getAverageVsCurrentSpending('EUR');
      expect(r.past_6_months.months_counted).toBe(1); // the "no data" divisor floor
      expect(r.past_6_months.avg_monthly_spending).toBe(0);
      expect(r.current_month.total_spending).toBe(0);
      expect(r.comparison.pace).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PINNED real-DB behaviours (see the suite report — do NOT "fix" here)
  // ───────────────────────────────────────────────────────────────────────────
  describe('pinned discrepancies (current real behaviour)', () => {
    const monthDay = (monthsBack, day) =>
      `date_trunc('month', CURRENT_DATE) - interval '${monthsBack} months' + interval '${day - 1} days'`;

    async function insertTxnAt(dateExpr, amount, opts = {}) {
      const { rows } = await getTestPool().query(`SELECT to_char((${dateExpr})::date, 'YYYY-MM-DD') AS d`);
      return insertTxn({ date: rows[0].d, amount, ...opts });
    }

    // PIN 1 — "average monthly spending over the past 6 months" divides by the
    // number of months that contain ANY transaction, not by 6.
    // infoRepositoryAverageVsCurrent.js:66-75 seeds a `monthlySpending` key for
    // every month that has a row (the key is created before the `eur < 0`
    // test), then divides by `monthKeys.length`. A ledger holding one spending
    // month reports that month's whole figure as its 6-month average, and a
    // month whose only rows are INCOME still counts in the divisor and dilutes
    // it. The `avg_daily_spending` sibling on the same object does use the true
    // calendar-day denominator, so the two disagree by construction: the
    // fixture below reports 240/month next to 240/calendarDays per day.
    it('PIN: avg_monthly_spending divides by populated months (income-only months included), not by 6', async () => {
      await seedBase();
      await insertTxnAt(monthDay(1, 10), '-240.00');

      const one = await infoRepository.getAverageVsCurrentSpending('EUR');
      expect(one.past_6_months.months_counted).toBe(1);
      expect(one.past_6_months.avg_monthly_spending).toBe(240); // not 240 / 6 = 40

      // Adding a month with ONLY income halves the reported average without a
      // single euro of extra spending.
      await insertTxnAt(monthDay(2, 10), '1000.00');
      const two = await infoRepository.getAverageVsCurrentSpending('EUR');
      expect(two.past_6_months.months_counted).toBe(2);
      expect(two.past_6_months.avg_monthly_spending).toBe(120);
    });

    // PIN 2 — net worth's stamp-based history walk hides accounts that were
    // never stamped, so every point except the last one under-reports.
    // infoRepositoryNetWorth.js:137 gates the walk with
    // `WHERE lb.balance IS NOT NULL`, while the current point is taken from the
    // unstamped-tolerant anchor+delta lateral (147-162, applied at 303-314).
    // A manual-only account therefore contributes to the headline and to the
    // final chart point but to no earlier point — the chart shows a vertical
    // step on its last day that no transaction explains. The transaction-flow
    // fallback only rescues the case where NOTHING is stamped anywhere; mixing
    // one stamped account with one manual account defeats it.
    it('PIN: a manual-only account appears only in the LAST net-worth point, stepping the chart', async () => {
      await seedBase();
      const today = TODAY();
      const d1 = addDaysYmd(today, -1);
      await addAccount('KBC');
      await addAccount('CASH');
      await insertTxn({ date: d1, amount: '-1.00', bank: 'KBC', balance: '1000.00' });
      await insertTxn({ date: d1, amount: '200.00', bank: 'CASH' }); // never stamped

      const r = await infoRepository.getNetWorthFromSnapshots();
      expect(r.snapshots.map((s) => [s.date, s.liquid])).toEqual([
        [d1, 1000], // CASH's 200 is invisible…
        [today, 1200], // …until the current-point override adds it
      ]);
      // The step is reported as a real monthly gain even though nothing moved.
      expect(r.current.liquid).toBe(1200);
    });
  });
});
