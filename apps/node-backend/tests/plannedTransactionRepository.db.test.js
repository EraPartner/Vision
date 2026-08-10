/**
 * Real-Postgres tests for plannedTransactionRepository's windowed reads —
 * `getDueSoon` and `getForForecast` — on the ONE-CLOCK rule (ADR-009): both
 * windows anchor on the APP_TIMEZONE calendar day, read once and bound into
 * the SQL, not on Postgres `CURRENT_DATE` (the DB session's UTC day).
 *
 * Unlike the month-rollover suites (infoRepoForecast.db.test.js,
 * infoRepoMonthly.db.test.js), the exposure pinned here is NIGHTLY: for the
 * last hours of every UTC day the app day (default Europe/Brussels) is one day
 * ahead of `CURRENT_DATE`, so a CURRENT_DATE-anchored due-soon window kept
 * yesterday's (app-clock) bills in "due soon" and cut the final day off the
 * lookahead.
 *
 * Technique as in the forecast suite's rollover describe: only `Date` is faked
 * (pg's connection/statement timers must keep running or the pool stalls); the
 * DB keeps its own real, unfaked clock; the process clock is pinned to 00:30
 * app-time on the day AFTER the DB's today, reproducing the drift window at
 * whatever hour the suite runs. Fixture dates are computed from the DB clock
 * BEFORE pinning, so every planned_date is a plain literal on the relationship
 * under test.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import plannedTransactionRepository from '../src/repositories/plannedTransactionRepository.js';
import { closePool } from '../src/database/connection.js';
import { todayAppDateString, appDateStringToUtc } from '../src/lib/timezone.js';

/** Insert one planned row directly, so the repository is not asserted against itself. */
async function insertPlanned({ date, amount = '-10.00', memo = null, isActive = true, isExecuted = false }) {
  const { rows } = await getTestPool().query(
    `INSERT INTO planned_transactions (planned_date, amount, currency, is_active, is_executed, memo)
     VALUES ($1, $2, 'EUR', $3, $4, $5) RETURNING id`,
    [date, amount, isActive, isExecuted, memo],
  );
  return rows[0].id;
}

describe.skipIf(!hasTestDatabase())('repositories/plannedTransactionRepository — one clock (real DB)', () => {
  beforeAll(async () => {
    expect(
      process.env.DATABASE_URL,
      'DATABASE_URL must equal TEST_DATABASE_URL for this suite (see scripts/with-test-db.sh)',
    ).toBe(process.env.TEST_DATABASE_URL);
    // DB suites share one database across parallel vitest workers — serialize.
    await acquireDbSuiteLock();
  }, 180_000);

  afterEach(async () => {
    vi.useRealTimers();
    await getTestPool().query('DELETE FROM planned_transactions');
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  /**
   * Read the calendar facts off the REAL DB clock, then freeze the process
   * clock at 00:30 app-time on the day after the DB's today (22:30/23:30 UTC
   * on the DB's today — the nightly drift window itself). Returns the facts
   * the assertions are written against.
   */
  async function pinClockToNightlyDrift() {
    const { rows } = await getTestPool().query(`
      SELECT to_char(CURRENT_DATE,                                'YYYY-MM-DD') AS db_today,
             to_char(CURRENT_DATE + 1,                            'YYYY-MM-DD') AS app_today,
             to_char(CURRENT_DATE + 1 + 7,                        'YYYY-MM-DD') AS due_window_end,
             to_char(CURRENT_DATE + 1 + 8,                        'YYYY-MM-DD') AS past_due_window,
             to_char((CURRENT_DATE + 1) + interval '1 month',     'YYYY-MM-DD') AS forecast_horizon,
             to_char((CURRENT_DATE + 1) + interval '1 month' + interval '1 day', 'YYYY-MM-DD') AS past_forecast_horizon
    `);
    const facts = rows[0];
    // 00:30 of the app-timezone day AFTER the DB's today == 22:30/23:30 UTC
    // on the DB's today.
    const instant = new Date(appDateStringToUtc(facts.app_today).getTime() + 30 * 60_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(instant);

    // Guard the premise: the app clock is one day ahead of the calendar day
    // CURRENT_DATE reports.
    expect(todayAppDateString()).toBe(facts.app_today);
    expect(instant.toISOString().slice(0, 10)).toBe(facts.db_today);
    return facts;
  }

  it('getDueSoon spans exactly [app today, app today + days] — not the CURRENT_DATE window', async () => {
    const facts = await pinClockToNightlyDrift();
    // App-clock YESTERDAY (the DB's today): overdue, not "due soon".
    // Pre-fix `planned_date >= CURRENT_DATE` kept it in the reminder list.
    const overdue = await insertPlanned({ date: facts.db_today, memo: 'overdue' });
    const dueToday = await insertPlanned({ date: facts.app_today, memo: 'due today' });
    // The lookahead's final day. Pre-fix `<= CURRENT_DATE + 7 days` ended one
    // day early and dropped it.
    const windowEnd = await insertPlanned({ date: facts.due_window_end, memo: 'window end' });
    const beyond = await insertPlanned({ date: facts.past_due_window, memo: 'beyond' });

    const due = await plannedTransactionRepository.getDueSoon(7);
    const ids = due.map((r) => r.id);

    expect(ids).toContain(dueToday);
    expect(ids).toContain(windowEnd);
    expect(ids).not.toContain(overdue);
    expect(ids).not.toContain(beyond);
    expect(ids).toEqual([dueToday, windowEnd]); // ordered by planned_date
  });

  it('getDueSoon ignores inactive and executed rows inside the window', async () => {
    const facts = await pinClockToNightlyDrift();
    const live = await insertPlanned({ date: facts.app_today });
    await insertPlanned({ date: facts.app_today, isActive: false });
    await insertPlanned({ date: facts.app_today, isExecuted: true });

    const due = await plannedTransactionRepository.getDueSoon(7);
    expect(due.map((r) => r.id)).toEqual([live]);
  });

  it('getForForecast reaches the app-anchored horizon and keeps unexecuted past rows', async () => {
    const facts = await pinClockToNightlyDrift();
    // No lower bound: a started-but-unexecuted recurring row stays visible.
    const past = await insertPlanned({ date: facts.db_today, memo: 'started, unexecuted' });
    // The horizon day itself (app today + 1 month, inclusive). Pre-fix the
    // horizon was CURRENT_DATE-based — one day short on most calendar days.
    const horizon = await insertPlanned({ date: facts.forecast_horizon, memo: 'horizon' });
    const beyond = await insertPlanned({ date: facts.past_forecast_horizon, memo: 'beyond' });

    const rows = await plannedTransactionRepository.getForForecast(1);
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(past);
    expect(ids).toContain(horizon);
    expect(ids).not.toContain(beyond);
  });
});
