/**
 * Real-Postgres tests for infoRepositoryBanks (`getBankBalances`).
 *
 * DB-backed complement to infoRepoBanks.test.js (which stays: it runs without a
 * DB). That mock suite choreographs `query` resolutions in order and asserts SQL
 * substrings — it can prove the two statements are *fired* in parallel and that
 * they *mention* `in_net_worth`, but it feeds the JS half pre-shaped rows and so
 * never observes what Postgres actually returns. Everything asserted here comes
 * out of the real schema: the shared anchor+delta lateral
 * (COMPUTED_BALANCE_LATERAL) resolving against real NUMERIC/DATE columns, the
 * `accounts` population gates (type/in_net_worth/transaction_count), the 12-month
 * daily history LATERAL, and FX conversion off seeded `exchange_rates` rows.
 *
 * Determinism: both statements are anchored on `CURRENT_DATE`, so fixtures are
 * dated by SQL expressions relative to it (never by a literal calendar date) and
 * the expectations are computed from the same anchors the queries use.
 *
 * The materialized views are not involved here (this repository has no MV fast
 * path); the currency memory cache is cleared around every test so no test sees
 * another's seeded rates.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import { banksRepository } from '../src/repositories/infoRepositoryBanks.js';
import { clearMvCache } from '../src/repositories/infoRepositoryHelpers.js';
import { clearMemoryCache } from '../src/services/currency/currencyConversionService.js';
import { closePool } from '../src/database/connection.js';

const rec = {};

/** 'YYYY-MM-DD' for `CURRENT_DATE + <sqlInterval>` (empty string = today). */
async function ymdFromToday(sqlInterval = '') {
  const expr = sqlInterval ? `CURRENT_DATE ${sqlInterval}` : 'CURRENT_DATE';
  const { rows } = await getTestPool().query(`SELECT to_char((${expr})::date, 'YYYY-MM-DD') AS d`);
  return rows[0].d;
}

async function seedRecipient() {
  const { rows } = await getTestPool().query(
    `INSERT INTO recipients (name, normalized_name) VALUES ('Misc Payee', 'misc payee') RETURNING id`,
  );
  rec.misc = rows[0].id;
}

/**
 * Create an accounts row with explicit population attributes. Accounts are
 * pre-created (rather than left to the dual-write trigger) because this suite
 * is about the population GATES — type, in_net_worth, statement_balance — which
 * the trigger's onboarding INSERT does not set.
 */
async function addAccount(name, {
  displayName = null,
  type = 'checking',
  inNetWorth = true,
  currency = 'EUR',
  statementBalance = null,
  statementBalanceDate = null,
} = {}) {
  const { rows } = await getTestPool().query(
    `INSERT INTO accounts (name, display_name, type, in_net_worth, currency,
                           statement_balance, statement_balance_date)
     VALUES ($1, $2, $3::account_type, $4, $5, $6, $7) RETURNING id`,
    [name, displayName, type, inNetWorth, currency, statementBalance, statementBalanceDate],
  );
  return rows[0].id;
}

/**
 * Insert one transaction via plain SQL. `date` is a SQL expression evaluated
 * server-side so fixtures stay anchored to the same CURRENT_DATE the queries
 * under test use. `balance` NULL means "not stamped by a bank import" — the
 * distinction the anchor+delta lateral exists for.
 */
async function insertTxn({
  dateExpr,
  amount,
  currency = 'EUR',
  bank,
  balance = null,
  isActive = true,
}) {
  const { rows } = await getTestPool().query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, bank_account, balance, is_active)
     VALUES ((${dateExpr})::date, $1, $2, $3, $4, $5, $6) RETURNING id`,
    [amount, currency, rec.misc, bank, balance, isActive],
  );
  return rows[0].id;
}

/** Seed one exchange_rates row so conversion resolves from the DB, never the network. */
async function insertRate(code, dateExpr, rate, isLatest = true) {
  await getTestPool().query(
    `INSERT INTO exchange_rates (currency_code, rate_date, rate_to_eur, is_latest)
     VALUES ($1, (${dateExpr})::date, $2, $3)`,
    [code, rate, isLatest],
  );
}

describe.skipIf(!hasTestDatabase())('repositories/infoRepositoryBanks (real DB)', () => {
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
    await pool.query('DELETE FROM transactions');
    await pool.query('DELETE FROM accounts');
    await pool.query('DELETE FROM recipients');
    await pool.query('DELETE FROM exchange_rates');
    for (const k of Object.keys(rec)) delete rec[k];
    clearMemoryCache();
    clearMvCache();
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it('returns the empty shape on an empty ledger', async () => {
    expect(await banksRepository.getBankBalances()).toEqual({
      accounts: [],
      total_net_position: 0,
      history: {},
      total_history: [],
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Current balances — anchor+delta lateral and the population gates
  // ───────────────────────────────────────────────────────────────────────────
  describe('current balances', () => {
    it('computes anchor+delta for stamped accounts and Σ(amount) for manual-only ones', async () => {
      await seedRecipient();
      await addAccount('AAA MANUAL');
      await addAccount('BBB STAMPED', {
        displayName: 'KBC Zichtrekening',
        statementBalance: '960.00',
        statementBalanceDate: await ymdFromToday(),
      });

      // Manual-only: nothing stamped anywhere → Σ(amount) = 70.
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '20 days'", amount: '-10.00', bank: 'AAA MANUAL' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '15 days'", amount: '-20.00', bank: 'AAA MANUAL' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '100.00', bank: 'AAA MANUAL' });
      // Stamped at day-10 (balance 1000 embeds the opening balance), then one
      // unstamped manual row after the anchor → 1000 + (−25) = 975.
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '10 days'", amount: '-50.00', bank: 'BBB STAMPED', balance: '1000.00' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '5 days'", amount: '-25.00', bank: 'BBB STAMPED' });

      const r = await banksRepository.getBankBalances();

      expect(r.accounts.map((a) => a.bank_account)).toEqual(['AAA MANUAL', 'BBB STAMPED']); // ORDER BY a.name
      expect(r.accounts[0]).toMatchObject({
        bank_account: 'AAA MANUAL',
        display_name: 'AAA MANUAL', // display_name NULL → falls back to name
        balance: 70,
        transaction_count: 3,
        post_anchor_count: 3, // no anchor → "sum of 3 entries"
      });
      expect(r.accounts[0].anchor_date).toBeUndefined();
      expect(r.accounts[0].drift).toBeUndefined(); // no statement balance stored
      expect(r.accounts[1]).toMatchObject({
        bank_account: 'BBB STAMPED',
        display_name: 'KBC Zichtrekening',
        balance: 975,
        transaction_count: 2,
        anchor_date: await ymdFromToday("- interval '10 days'"),
        post_anchor_count: 1, // "as of {anchor} statement + 1 entry since"
        drift: -15, // statement_balance 960 − computed 975, native currency
      });
      expect(r.total_net_position).toBe(1045);
    });

    it('applies the population gates: liability, tracking-only and no-activity accounts stay out', async () => {
      await seedRecipient();
      await addAccount('IN SCOPE');
      await addAccount('MORTGAGE', { type: 'liability' });
      await addAccount('TRACKING ONLY', { inNetWorth: false });
      await addAccount('NO ACTIVITY'); // exists, but zero transactions

      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '10.00', bank: 'IN SCOPE' });
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '-500.00', bank: 'MORTGAGE' });
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '20.00', bank: 'TRACKING ONLY' });

      const r = await banksRepository.getBankBalances();
      expect(r.accounts.map((a) => a.bank_account)).toEqual(['IN SCOPE']);
      expect(r.total_net_position).toBe(10);
    });

    it('counts only ACTIVE rows in the balance, the count and the metadata lateral', async () => {
      await seedRecipient();
      await addAccount('MIXED');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '3 days'", amount: '10.00', bank: 'MIXED' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '-999.00', bank: 'MIXED', isActive: false });

      const r = await banksRepository.getBankBalances();
      expect(r.accounts[0]).toMatchObject({ balance: 10, transaction_count: 1 });
      // The inactive row is also invisible to the activity lateral's MIN/MAX.
      // DATE columns cross the boundary as calendar-day strings (toWireDate).
      expect(r.accounts[0].last_transaction).toBe(await ymdFromToday("- interval '3 days'"));
    });

    it('converts each account at the rate for its most recent activity date', async () => {
      await seedRecipient();
      await addAccount('WISE USD', { currency: 'USD' });
      await insertRate('USD', 'CURRENT_DATE', '0.5');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '80.00', currency: 'USD', bank: 'WISE USD' });

      const r = await banksRepository.getBankBalances();
      expect(r.accounts[0]).toMatchObject({ bank_account: 'WISE USD', balance: 40 });
      expect(r.total_net_position).toBe(40);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 12-month daily history
  // ───────────────────────────────────────────────────────────────────────────
  describe('history', () => {
    it('emits one point per day from the first activity to today, anchoring each day on the latest stamp ≤ that day', async () => {
      await seedRecipient();
      await addAccount('HIST BANK');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '4 days'", amount: '-50.00', bank: 'HIST BANK', balance: '1000.00' });
      // A later UNSTAMPED row moves the series from the day it posts: the walk
      // resolves each day with the same anchor+delta definition the headline
      // uses (anchor = latest stamp ≤ day, plus every active row after it),
      // so manual/trade activity is no longer invisible until the next import.
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '-25.00', bank: 'HIST BANK' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '-5.00', bank: 'HIST BANK', balance: '900.00' });

      const r = await banksRepository.getBankBalances();
      const days = [
        await ymdFromToday("- interval '4 days'"),
        await ymdFromToday("- interval '3 days'"),
        await ymdFromToday("- interval '2 days'"),
        await ymdFromToday("- interval '1 day'"),
        await ymdFromToday(),
      ];
      expect(r.history['HIST BANK']).toEqual([
        { date: days[0], balance: 1000 },
        { date: days[1], balance: 1000 }, // forward-filled: no row that day
        { date: days[2], balance: 975 },  // 1000 stamp − the unstamped 25
        { date: days[3], balance: 900 },  // re-anchored on the new stamp
        { date: days[4], balance: 900 },
      ]);
      expect(r.total_history).toEqual(r.history['HIST BANK']);
      // The invariant both history findings demand: the headline IS the last
      // chart point, never a step above it.
      expect(r.total_history[r.total_history.length - 1].balance).toBe(r.total_net_position);
    });

    it('fills the whole 12-month window from a stamp that predates it', async () => {
      await seedRecipient();
      await addAccount('OLD STAMP');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '18 months'", amount: '-1.00', bank: 'OLD STAMP', balance: '500.00' });

      const r = await banksRepository.getBankBalances();
      const points = r.history['OLD STAMP'];
      // generate_series(CURRENT_DATE - 12 months, CURRENT_DATE, 1 day) inclusive.
      const { rows } = await getTestPool().query(
        `SELECT (CURRENT_DATE - (CURRENT_DATE - interval '12 months')::date + 1) AS n`,
      );
      expect(points).toHaveLength(Number(rows[0].n));
      expect(points[0].date).toBe(await ymdFromToday("- interval '12 months'"));
      expect(points[points.length - 1].date).toBe(await ymdFromToday());
      expect(points.every((p) => p.balance === 500)).toBe(true);
    });

    it('opens the window at the balance carried in from BEFORE it, stamps and unstamped rows alike', async () => {
      // The series is computed over the whole ledger and then clamped onto the
      // grid: activity older than the 12-month window must arrive as the
      // window's opening balance, not as a missing/zero point.
      await seedRecipient();
      await addAccount('OLD ACTIVITY');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '18 months'", amount: '-1.00', bank: 'OLD ACTIVITY', balance: '500.00' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '15 months'", amount: '-100.00', bank: 'OLD ACTIVITY' });

      const r = await banksRepository.getBankBalances();
      const points = r.history['OLD ACTIVITY'];
      expect(points[0].date).toBe(await ymdFromToday("- interval '12 months'"));
      expect(points.every((p) => p.balance === 400)).toBe(true);
      expect(r.total_net_position).toBe(400);
    });

    it('orders WITHIN a day: an unstamped row after that day’s stamp moves the same day’s point', async () => {
      // Same-date rows tie-break on id, exactly as the current-balance anchor
      // does — the stamp anchors and the later row is a delta on top of it.
      await seedRecipient();
      await addAccount('SAME DAY');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '-10.00', bank: 'SAME DAY', balance: '1000.00' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '-25.00', bank: 'SAME DAY' });

      const r = await banksRepository.getBankBalances();
      expect(r.history['SAME DAY']).toEqual([
        { date: await ymdFromToday("- interval '1 day'"), balance: 975 },
        { date: await ymdFromToday(), balance: 975 },
      ]);
      expect(r.total_net_position).toBe(975);
    });

    it('ignores inactive rows in the series, as the current balance does', async () => {
      await seedRecipient();
      await addAccount('HIST ACTIVE');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '100.00', bank: 'HIST ACTIVE' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '-999.00', bank: 'HIST ACTIVE', isActive: false });

      const r = await banksRepository.getBankBalances();
      expect(r.history['HIST ACTIVE'].every((p) => p.balance === 100)).toBe(true);
      expect(r.total_net_position).toBe(100);
    });

    it('sums per-day across accounts into total_history, honouring the same population gates', async () => {
      await seedRecipient();
      await addAccount('A BANK');
      await addAccount('B BANK');
      await addAccount('C TRACKING', { inNetWorth: false });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '-1.00', bank: 'A BANK', balance: '100.00' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '-1.00', bank: 'B BANK', balance: '50.00' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '-1.00', bank: 'C TRACKING', balance: '9999.00' });

      const r = await banksRepository.getBankBalances();
      const d2 = await ymdFromToday("- interval '2 days'");
      const d1 = await ymdFromToday("- interval '1 day'");
      const d0 = await ymdFromToday();
      expect(Object.keys(r.history).sort()).toEqual(['A BANK', 'B BANK']); // tracking-only excluded
      expect(r.total_history).toEqual([
        { date: d2, balance: 100 },
        { date: d1, balance: 150 },
        { date: d0, balance: 150 },
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Formerly pinned discrepancies — now corrective
  // ───────────────────────────────────────────────────────────────────────────
  describe('wire-date convention', () => {
    // Was PIN 1. `anchor_date` is emitted as a 'YYYY-MM-DD' string (the lateral
    // uses to_char) while `first_transaction` / `last_transaction` were passed
    // through RAW from pg. pg reads a DATE column as a JS Date at *local*
    // midnight, and lib/dateFormat.js documents the project rule: DATE values
    // at an emit boundary go through toWireDate(), because JSON-serializing the
    // raw Date emits an ISO timestamp of the PREVIOUS day on any server east of
    // UTC (Brussels: all day, every day). The mock suite fed these fields as
    // strings, so only a real-DB test can see the type.
    it('emits first_transaction/last_transaction as calendar-day strings, not raw pg Dates', async () => {
      await seedRecipient();
      await addAccount('DATE SHAPE');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '3 days'", amount: '-1.00', bank: 'DATE SHAPE' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '-2.00', bank: 'DATE SHAPE' });

      const account = (await banksRepository.getBankBalances()).accounts[0];
      expect(account.first_transaction).toBe(await ymdFromToday("- interval '3 days'"));
      expect(account.last_transaction).toBe(await ymdFromToday("- interval '1 day'"));
      // The whole object survives JSON round-tripping as calendar days — the
      // actual failure mode was an ISO timestamp landing a day early.
      const wire = JSON.parse(JSON.stringify(account));
      expect(wire.first_transaction).toBe(account.first_transaction);
      expect(wire.last_transaction).toBe(account.last_transaction);
      // …matching the provenance field on the SAME object, already a string.
      expect(typeof account.anchor_date === 'undefined' || typeof account.anchor_date === 'string').toBe(true);
    });
  });

  describe('multi-currency accounts', () => {
    // Was PIN 2. The unpartitioned lateral did `SUM(t2.amount)` across
    // currencies and the caller converted that total at the ONE rate belonging
    // to the most recent row's currency. The balance computation is now
    // partitioned by currency and each partition converted at its own rate.
    it('converts each currency partition at its own rate instead of summing raw amounts', async () => {
      await seedRecipient();
      await addAccount('MULTI CCY');
      await insertRate('USD', 'CURRENT_DATE', '0.5');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '100.00', currency: 'EUR', bank: 'MULTI CCY' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '100.00', currency: 'USD', bank: 'MULTI CCY' });

      const r = await banksRepository.getBankBalances();
      expect(r.accounts[0].balance).toBe(150); // 100 EUR + (100 USD × 0.5) — NOT (100+100) × 0.5
      expect(r.total_net_position).toBe(150);
      // …and the chart agrees with the headline it sits under.
      expect(r.total_history[r.total_history.length - 1].balance).toBe(150);
    });

    it('anchors each currency on ITS OWN latest stamp — a EUR statement never absorbs USD activity', async () => {
      // Composition semantics: a stamped `balance` is the statement figure for
      // the currency of the row carrying it, so it anchors that partition only.
      //   EUR: stamp 1000 (day-10) − 25 (day-3)      = 975 EUR
      //   USD: nothing stamped → Σ = 100 USD @0.5    =  50 EUR
      await seedRecipient();
      await addAccount('WISE MULTI', { currency: 'EUR' });
      await insertRate('USD', 'CURRENT_DATE', '0.5');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '10 days'", amount: '-50.00', currency: 'EUR', bank: 'WISE MULTI', balance: '1000.00' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '5 days'", amount: '100.00', currency: 'USD', bank: 'WISE MULTI' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '3 days'", amount: '-25.00', currency: 'EUR', bank: 'WISE MULTI' });

      const r = await banksRepository.getBankBalances();
      // The old cross-currency form gave 1000 + (100 − 25) = 1075 at one rate.
      expect(r.accounts[0].balance).toBe(1025);
      expect(r.total_net_position).toBe(1025);
      expect(r.total_history[r.total_history.length - 1].balance).toBe(1025);
    });

    it('revalues the headline at TODAY rate, not at the last statement date, over a moving curve', async () => {
      // The archetypal imported foreign-currency account: fully stamped, last
      // statement a month old, rate moved since. Keying the headline's FX on
      // the account's last activity (as it briefly did) pinned it to the old
      // rate while the chart — which revalues day by day — ended at the new
      // one: 500 under a chart ending at 900. Both must read 900.
      // NOTE: a single seeded rate row makes this test vacuous — the curve has
      // to move for the two conventions to disagree.
      await seedRecipient();
      await addAccount('WISE USD', { currency: 'USD' });
      await insertRate('USD', "CURRENT_DATE - interval '30 days'", '0.5', false);
      await insertRate('USD', 'CURRENT_DATE', '0.9');
      await insertTxn({
        dateExpr: "CURRENT_DATE - interval '30 days'",
        amount: '-10.00', currency: 'USD', bank: 'WISE USD', balance: '1000.00',
      });

      const r = await banksRepository.getBankBalances();
      expect(r.accounts[0].balance).toBe(900); // 1000 USD × today's 0.9
      expect(r.total_net_position).toBe(900);

      const points = r.history['WISE USD'];
      expect(points[points.length - 1]).toEqual({ date: await ymdFromToday(), balance: 900 });
      // …and the day of the statement is still valued at the rate of that day,
      // so the series genuinely moves with FX (otherwise the check above is
      // satisfied by a flat curve).
      const statementDay = await ymdFromToday("- interval '30 days'");
      expect(points.find((p) => p.date === statementDay)).toEqual({ date: statementDay, balance: 500 });
    });

    it('holds headline == last chart point for a MIXED-currency account on a moving curve', async () => {
      await seedRecipient();
      await addAccount('MULTI MOVING', { currency: 'EUR' });
      await insertRate('USD', "CURRENT_DATE - interval '20 days'", '0.5', false);
      await insertRate('USD', 'CURRENT_DATE', '0.8');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '20 days'", amount: '100.00', currency: 'EUR', bank: 'MULTI MOVING' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '20 days'", amount: '200.00', currency: 'USD', bank: 'MULTI MOVING' });

      const r = await banksRepository.getBankBalances();
      expect(r.accounts[0].balance).toBe(260); // 100 EUR + 200 USD × 0.8
      const points = r.history['MULTI MOVING'];
      expect(points[points.length - 1].balance).toBe(260);
      expect(points[0]).toEqual({ // 20 days ago, at that day's 0.5
        date: await ymdFromToday("- interval '20 days'"),
        balance: 200,
      });
      expect(r.total_history[r.total_history.length - 1].balance).toBe(r.total_net_position);
    });

    it('leaves a single-currency account byte-identical to the unpartitioned computation', async () => {
      // The overwhelmingly common case: one partition, whose anchor is the
      // account's latest stamped row and whose delta is every row after it.
      await seedRecipient();
      await addAccount('ONE CCY USD', { currency: 'USD' });
      await insertRate('USD', 'CURRENT_DATE', '0.5');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '10 days'", amount: '-50.00', currency: 'USD', bank: 'ONE CCY USD', balance: '1000.00' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '5 days'", amount: '-100.00', currency: 'USD', bank: 'ONE CCY USD' });

      const r = await banksRepository.getBankBalances();
      expect(r.accounts[0]).toMatchObject({
        balance: 450, // (1000 − 100) USD × 0.5
        anchor_date: await ymdFromToday("- interval '10 days'"),
        post_anchor_count: 1,
      });
      expect(r.total_net_position).toBe(450);
    });
  });

  describe('history/headline agreement', () => {
    // Was PIN 3. The current-balance query dropped its `balance IS NOT NULL`
    // gate (WP-A1) so manual-only accounts reach the headline, but the history
    // query kept filtering `WHERE lb.balance IS NOT NULL` — so an all-manual
    // ledger rendered a non-zero total_net_position above an EMPTY chart, and a
    // mixed one rendered a today-point that silently disagreed with it.
    it('includes manual-only accounts in history, so today equals total_net_position (mixed ledger)', async () => {
      await seedRecipient();
      await addAccount('MANUAL ONLY');
      await addAccount('STAMPED');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '70.00', bank: 'MANUAL ONLY' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '-1.00', bank: 'STAMPED', balance: '1000.00' });

      const r = await banksRepository.getBankBalances();
      expect(r.total_net_position).toBe(1070);
      expect(Object.keys(r.history).sort()).toEqual(['MANUAL ONLY', 'STAMPED']);
      expect(r.history['MANUAL ONLY']).toEqual([
        { date: await ymdFromToday("- interval '1 day'"), balance: 70 },
        { date: await ymdFromToday(), balance: 70 },
      ]);
      expect(r.total_history[r.total_history.length - 1].balance).toBe(r.total_net_position);
    });

    // KNOWN DIVERGENCE (deliberate, and the only one left): the headline is the
    // unbounded computed balance — the same figure the accounts hub shows, which
    // it must not drift from — while the chart stops at today. A FUTURE-dated
    // row therefore counts in the headline before it reaches the chart. Bounding
    // the headline at today instead would fix the chart at the cost of the hub
    // agreement; pinned here so the trade-off stays visible.
    it('counts a future-dated row in the headline but not yet in the chart', async () => {
      await seedRecipient();
      await addAccount('AHEAD');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '100.00', bank: 'AHEAD' });
      await insertTxn({ dateExpr: "CURRENT_DATE + interval '3 days'", amount: '40.00', bank: 'AHEAD' });

      const r = await banksRepository.getBankBalances();
      expect(r.total_net_position).toBe(140);
      expect(r.total_history[r.total_history.length - 1]).toEqual({
        date: await ymdFromToday(),
        balance: 100,
      });
    });

    it('charts an all-manual ledger instead of leaving the headline over an empty chart', async () => {
      await seedRecipient();
      await addAccount('CASH');
      await addAccount('WALLET');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '3 days'", amount: '200.00', bank: 'CASH' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '-50.00', bank: 'CASH' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '30.00', bank: 'WALLET' });

      const r = await banksRepository.getBankBalances();
      expect(r.total_net_position).toBe(180);
      // A day BEFORE an account's first row yields no point for it (its first
      // known balance is never carried backwards), so the running total starts
      // at first activity and steps only where transactions actually land.
      expect(r.total_history).toEqual([
        { date: await ymdFromToday("- interval '3 days'"), balance: 200 },
        { date: await ymdFromToday("- interval '2 days'"), balance: 150 },
        { date: await ymdFromToday("- interval '1 day'"), balance: 180 },
        { date: await ymdFromToday(), balance: 180 },
      ]);
      expect(r.total_history[r.total_history.length - 1].balance).toBe(r.total_net_position);
    });
  });
});
