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
      expect(r.accounts[0].last_transaction).toEqual(new Date(await ymdFromToday("- interval '3 days'")));
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
    it('emits one point per day from the first stamp to today, carrying the last stamp forward', async () => {
      await seedRecipient();
      await addAccount('HIST BANK');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '4 days'", amount: '-50.00', bank: 'HIST BANK', balance: '1000.00' });
      // A LATER unstamped row must not create or move a history point: the
      // history walk is stamp-based (WP-A1) and this row has balance NULL.
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
        { date: days[2], balance: 1000 }, // unstamped row ignored by the walk
        { date: days[3], balance: 900 },
        { date: days[4], balance: 900 },
      ]);
      expect(r.total_history).toEqual(r.history['HIST BANK']);
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
  // PINNED real-DB behaviours (see the suite report — do NOT "fix" here)
  // ───────────────────────────────────────────────────────────────────────────
  describe('pinned discrepancies (current real behaviour)', () => {
    // PIN 1 — wire-date convention violation.
    // `anchor_date` is emitted as a 'YYYY-MM-DD' string (the lateral uses
    // to_char), but `first_transaction` / `last_transaction` are passed through
    // RAW from pg (infoRepositoryBanks.js:182-183). pg reads a DATE column as a
    // JS Date at *local* midnight, and lib/dateFormat.js documents the project
    // rule: DATE values at an emit boundary go through toWireDate(), because
    // JSON-serializing the raw Date emits an ISO timestamp of the PREVIOUS day
    // on any server east of UTC (Brussels: all day, every day). The mock suite
    // fed these fields as strings, so it could never see the type. This pins
    // the CURRENT behaviour: Date instances, not calendar-day strings.
    it('PIN: first_transaction/last_transaction come back as raw pg Date objects, not toWireDate strings', async () => {
      await seedRecipient();
      await addAccount('DATE SHAPE');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '3 days'", amount: '-1.00', bank: 'DATE SHAPE' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '-2.00', bank: 'DATE SHAPE' });

      const account = (await banksRepository.getBankBalances()).accounts[0];
      expect(account.first_transaction).toBeInstanceOf(Date);
      expect(account.last_transaction).toBeInstanceOf(Date);
      // …while the provenance field on the SAME object is already a string.
      expect(typeof account.anchor_date === 'undefined' || typeof account.anchor_date === 'string').toBe(true);
    });

    // PIN 2 — multi-currency accounts sum raw amounts across currencies.
    // COMPUTED_BALANCE_LATERAL does `SUM(t2.amount)` with no currency
    // partitioning, and the account's currency is then taken from the single
    // most recent active row (`(ARRAY_AGG(... ORDER BY t.date DESC, t.id DESC))[1]`),
    // so a mixed-currency account has its EUR and USD amounts added as bare
    // numbers and the total converted at ONE rate. Fixture: 100 EUR + 100 USD
    // with USD@0.5. Correct would be 100 + 50 = 150 EUR; the query yields
    // (100+100) × 0.5 = 100. The repository comment flags multi-currency
    // partitioning as "D2" (deferred) — pinned here, not fixed.
    it('PIN: a multi-currency account adds EUR and USD amounts before converting at one rate', async () => {
      await seedRecipient();
      await addAccount('MULTI CCY');
      await insertRate('USD', 'CURRENT_DATE', '0.5');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '100.00', currency: 'EUR', bank: 'MULTI CCY' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '100.00', currency: 'USD', bank: 'MULTI CCY' });

      const r = await banksRepository.getBankBalances();
      expect(r.accounts[0].balance).toBe(100); // (100 EUR + 100 USD) × 0.5 — NOT 150
      expect(r.total_net_position).toBe(100);
    });

    // PIN 3 — the history series and the headline have different populations.
    // The current-balance query deliberately dropped its `balance IS NOT NULL`
    // gate (WP-A1) so manual-only accounts reach the headline, but the history
    // query still filters `WHERE lb.balance IS NOT NULL`. A ledger of only
    // never-stamped accounts therefore renders a non-zero total_net_position
    // above an EMPTY Balance History chart; with a mix, today's total_history
    // point silently disagrees with total_net_position.
    it('PIN: manual-only accounts reach total_net_position but never appear in history', async () => {
      await seedRecipient();
      await addAccount('MANUAL ONLY');
      await addAccount('STAMPED');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '70.00', bank: 'MANUAL ONLY' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '-1.00', bank: 'STAMPED', balance: '1000.00' });

      const r = await banksRepository.getBankBalances();
      expect(r.total_net_position).toBe(1070);
      expect(Object.keys(r.history)).toEqual(['STAMPED']); // MANUAL ONLY has no points
      // Today's history total is 1000 — 70 short of the headline it sits under.
      expect(r.total_history[r.total_history.length - 1].balance).toBe(1000);
    });
  });
});
