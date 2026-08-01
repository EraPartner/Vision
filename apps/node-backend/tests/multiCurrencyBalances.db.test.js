/**
 * Real-Postgres tests for the four surfaces that read the shared computed
 * balance and had to be migrated off its single cross-currency `SUM(t2.amount)`:
 *
 *   - the accounts hub          — `accountRepository.getAll` (computed_balance + drift)
 *   - drift reconciliation      — `reconcileService.reconcileAccount`
 *   - the rebalance cash input  — `crossWorkspaceDataService.assembleRebalanceInputs`
 *   - the net-worth current point — `infoRepositoryNetWorth.getNetWorthFromSnapshots`
 *
 * (`getBankBalances`, the fifth reader, has its own DB suite in
 * infoRepoBanks.db.test.js — including the drift badge, which now derives from
 * the same per-currency helper these surfaces use.)
 *
 * Why a DB suite: the mock suites next door feed each surface pre-shaped rows,
 * so they can prove the JS fold is right but never observe what Postgres
 * actually returns from the partitioned lateral against real NUMERIC/DATE
 * columns — which is exactly where the defect lived. Every figure asserted here
 * comes out of the real schema and the real `exchange_rates` table.
 *
 * The fixture is the canonical one from the finding: 100 EUR + 100 USD in ONE
 * account, with USD at 0.5. The wrong single-rate answer is 100 (the bare sum
 * 200 converted at the most recent row's rate); the right answer is 150. The
 * two numbers differ, so a green assertion here cannot be satisfied by the old
 * behaviour — the failure mode this suite exists to prevent.
 *
 * Determinism: fixtures are dated by SQL expressions relative to CURRENT_DATE,
 * never by literal calendar dates. The currency memory cache is cleared around
 * every test so no test sees another's seeded rates.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import accountRepository from '../src/repositories/accountRepository.js';
import { reconcileAccount } from '../src/services/reconcileService.js';
import { assembleRebalanceInputs } from '../src/services/crossWorkspaceDataService.js';
import { netWorthRepository } from '../src/repositories/infoRepositoryNetWorth.js';
import { banksRepository } from '../src/repositories/infoRepositoryBanks.js';
import { clearMvCache } from '../src/repositories/infoRepositoryHelpers.js';
import { clearMemoryCache } from '../src/services/currency/currencyConversionService.js';
import { closePool } from '../src/database/connection.js';

const rec = {};

async function seedRecipient() {
  const { rows } = await getTestPool().query(
    `INSERT INTO recipients (name, normalized_name) VALUES ('Misc Payee', 'misc payee') RETURNING id`,
  );
  rec.misc = rows[0].id;
}

/**
 * Create an accounts row. Accounts are pre-created (rather than left to the
 * dual-write trigger) because these surfaces are gated on account attributes —
 * spendable / in_net_worth / statement_balance — that the trigger's onboarding
 * INSERT does not set.
 */
async function addAccount(name, {
  type = 'checking',
  currency = 'EUR',
  spendable = true,
  inNetWorth = true,
  isActive = true,
  statementBalance = null,
  statementBalanceDate = null,
} = {}) {
  const { rows } = await getTestPool().query(
    `INSERT INTO accounts (name, type, currency, spendable, in_net_worth, is_active,
                           statement_balance, statement_balance_date)
     VALUES ($1, $2::account_type, $3, $4, $5, $6, $7,
             CASE WHEN $7::numeric IS NULL THEN NULL ELSE (${statementBalanceDate ?? 'CURRENT_DATE'})::date END)
     RETURNING id`,
    [name, type, currency, spendable, inNetWorth, isActive, statementBalance],
  );
  return rows[0].id;
}

/** `balance` NULL means "not stamped by a bank import" — the anchor distinction. */
async function insertTxn({ dateExpr, amount, currency = 'EUR', bank, balance = null, isActive = true }) {
  await getTestPool().query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, bank_account, balance, is_active)
     VALUES ((${dateExpr})::date, $1, $2, $3, $4, $5, $6)`,
    [amount, currency, rec.misc, bank, balance, isActive],
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

/**
 * The finding's fixture: one account holding 100 EUR and 100 USD, USD at 0.5.
 *   correct   → 100 + (100 × 0.5) = 150
 *   old (bad) → (100 + 100) × 0.5 = 100
 */
async function seedMultiCurrencyAccount(name = 'WISE MULTI', accountOpts = {}) {
  await seedRecipient();
  const id = await addAccount(name, { currency: 'EUR', ...accountOpts });
  await insertRate('USD', 'CURRENT_DATE', '0.5');
  await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '100.00', currency: 'EUR', bank: name });
  await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '100.00', currency: 'USD', bank: name });
  return id;
}

describe.skipIf(!hasTestDatabase())('cross-currency computed balance, all reader surfaces (real DB)', () => {
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

  // ───────────────────────────────────────────────────────────────────────────
  // Surface 1 — accounts hub (accountRepository.getAll)
  // ───────────────────────────────────────────────────────────────────────────
  describe('accounts hub', () => {
    it('sums the currency partitions into the account currency instead of across them', async () => {
      await seedMultiCurrencyAccount();

      const [row] = await accountRepository.getAll();

      expect(row.computed_balance).toBe(150); // NOT 100
      // Provenance still describes the account, not one currency: nothing is
      // stamped here, so it is the "sum of N entries" shape.
      expect(row.anchor_date).toBeUndefined();
      expect(row.post_anchor_count).toBe(2);
      expect(row.has_transactions).toBe(true);
    });

    it('derives drift from the account-currency partition, not the cross-currency sum', async () => {
      // Statement says 120 EUR. The EUR partition holds 100, so the drift the
      // badge must show is 20 EUR. The cross-currency Σ (200) would have shown
      // −80 — a number no reconcile action could ever clear.
      await seedMultiCurrencyAccount('WISE MULTI', { statementBalance: '120.00' });

      const [row] = await accountRepository.getAll();

      expect(row.computed_balance).toBe(150);
      expect(row.drift).toBe(20);
    });

    it('anchors each currency on its own stamp — a EUR statement never absorbs USD activity', async () => {
      await seedRecipient();
      await addAccount('WISE STAMPED', { currency: 'EUR' });
      await insertRate('USD', 'CURRENT_DATE', '0.5');
      // EUR: stamp 1000 (day-10), then −25 (day-3) → 975 EUR
      // USD: nothing stamped → Σ = 100 USD → 50 EUR
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '10 days'", amount: '-50.00', currency: 'EUR', bank: 'WISE STAMPED', balance: '1000.00' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '5 days'", amount: '100.00', currency: 'USD', bank: 'WISE STAMPED' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '3 days'", amount: '-25.00', currency: 'EUR', bank: 'WISE STAMPED' });

      const [row] = await accountRepository.getAll();

      // The cross-currency form gave 1000 + (100 − 25) = 1075.
      expect(row.computed_balance).toBe(1025);
    });

    it('leaves a single-currency account byte-identical to the unpartitioned computation', async () => {
      await seedRecipient();
      await addAccount('ONE CCY USD', { currency: 'USD', statementBalance: '900.00' });
      await insertRate('USD', 'CURRENT_DATE', '0.5');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '10 days'", amount: '-50.00', currency: 'USD', bank: 'ONE CCY USD', balance: '1000.00' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '5 days'", amount: '-100.00', currency: 'USD', bank: 'ONE CCY USD' });

      const [row] = await accountRepository.getAll();

      // Native USD throughout: the account currency IS the partition currency,
      // so nothing is converted and the drift is the same native figure as before.
      expect(row.computed_balance).toBe(900);
      expect(row.drift).toBe(0);
      expect(row.anchor_date).toBeDefined();
      expect(row.post_anchor_count).toBe(1);
    });

    it('keeps an account with no ledger rows at 0 rather than dropping it from the list', async () => {
      await addAccount('FRESH');
      const rows = await accountRepository.getAll();
      expect(rows.map((r) => r.name)).toEqual(['FRESH']);
      expect(rows[0].computed_balance).toBe(0);
      expect(rows[0].drift).toBeNull();
      expect(rows[0].has_transactions).toBe(false);
    });

    it('pages by ACCOUNT, not by currency partition', async () => {
      // The per-currency lateral is used in its aggregated (one row per account)
      // form precisely so LIMIT keeps counting accounts: a row-per-partition
      // form would have returned the multi-currency account's two partitions as
      // "two accounts" and truncated the page.
      await seedMultiCurrencyAccount('AAA MULTI');
      await addAccount('BBB PLAIN');
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '10.00', bank: 'BBB PLAIN' });

      const page = await accountRepository.getAll({ limit: 2, offset: 0 });
      expect(page.map((r) => r.name)).toEqual(['AAA MULTI', 'BBB PLAIN']);
      expect(page[0].computed_balance).toBe(150);
      expect(page[1].computed_balance).toBe(10);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Surface 2 — reconcile (reconcileService)
  // ───────────────────────────────────────────────────────────────────────────
  describe('reconcile', () => {
    // NOTE on the missing 'adjustment' case: that mode's INSERT omits
    // `transactions.recipient_id`, which is NOT NULL from migration 0001 and was
    // never relaxed — so the whole mode raises 23502 against the real schema,
    // before it ever reaches the drift this change alters. That defect is
    // unrelated to (and predates) the per-currency migration and is reported
    // separately; the drift SIZING for 'adjustment' is asserted in the mock
    // suite (tests/reconcileService.test.js). The two cases below exercise the
    // same per-currency drift read end-to-end against Postgres.

    it("'accept' adopts the own-currency partition as the statement of record", async () => {
      const id = await seedMultiCurrencyAccount('WISE MULTI', { statementBalance: '120.00' });

      const result = await reconcileAccount(id, { mode: 'accept' });

      // 100 = the EUR partition. The cross-currency Σ would have written 200 as
      // the statement of record — a EUR statement figure with USD folded in.
      expect(result).toMatchObject({ mode: 'accept', drift: 0, statement_balance: 100, computed_balance: 100 });
      const [row] = await accountRepository.getAll();
      // The badge the user clicked is now actually clear, and the converted
      // balance beside it is untouched (no ledger row was created).
      expect(row.drift).toBe(0);
      expect(row.computed_balance).toBe(150);
    });

    it('refuses a multi-currency account whose own-currency partition already matches', async () => {
      // The cross-currency Σ (200) is 100 away from the statement, so the old
      // reading would have minted a 100 EUR adjustment out of thin air.
      const id = await seedMultiCurrencyAccount('WISE MULTI', { statementBalance: '100.00' });

      await expect(reconcileAccount(id, { mode: 'adjustment' })).rejects.toThrow(/already reconciled/i);
      const { rows } = await getTestPool().query(`SELECT COUNT(*)::int AS n FROM transactions`);
      expect(rows[0].n).toBe(2); // nothing inserted
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Surface 3 — rebalance available cash (crossWorkspaceDataService)
  // ───────────────────────────────────────────────────────────────────────────
  describe('rebalance available cash', () => {
    it('converts each currency partition at its own rate', async () => {
      await seedMultiCurrencyAccount('WISE MULTI', { spendable: true });

      const out = await assembleRebalanceInputs({ currency: 'EUR' });

      expect(out.availableCash).toBe(150); // NOT 100
      expect(out.cashAccounts).toEqual([
        { id: expect.any(Number), name: 'WISE MULTI', currency: 'EUR', balance: 150 },
      ]);
    });

    it('honours the spendable/active gates and keeps a zero-activity account listed', async () => {
      await seedMultiCurrencyAccount('WISE MULTI');
      await addAccount('NOT SPENDABLE', { spendable: false });
      await addAccount('ARCHIVED', { isActive: false });
      await addAccount('NO ACTIVITY');
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '999.00', bank: 'NOT SPENDABLE' });
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '999.00', bank: 'ARCHIVED' });

      const out = await assembleRebalanceInputs({ currency: 'EUR' });

      expect(out.cashAccounts.map((a) => a.name)).toEqual(['NO ACTIVITY', 'WISE MULTI']);
      expect(out.cashAccounts.find((a) => a.name === 'NO ACTIVITY').balance).toBe(0);
      expect(out.availableCash).toBe(150);
    });

    it('converts into a non-EUR target from every partition', async () => {
      // Target USD: the EUR partition converts at 1/0.5 and the USD one passes
      // through — 100 EUR → 200 USD, plus 100 USD = 300 USD.
      await seedMultiCurrencyAccount('WISE MULTI');

      const out = await assembleRebalanceInputs({ currency: 'USD' });

      expect(out.currency).toBe('USD');
      expect(out.availableCash).toBe(300);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Surface 4 — net-worth current point (infoRepositoryNetWorth)
  // ───────────────────────────────────────────────────────────────────────────
  describe('net worth current point', () => {
    it('values each currency partition at its own rate', async () => {
      await seedMultiCurrencyAccount('WISE MULTI', { inNetWorth: true });

      const nw = await netWorthRepository.getNetWorthFromSnapshots('EUR');

      expect(nw.current.liquid).toBe(150); // NOT 100
      expect(nw.current.netWorth).toBe(150);
    });

    it('leaves no step between the last history point and the headline', async () => {
      // The invariant the history walk's byCurrency flag protects: the walk and
      // the current point must resolve a multi-currency account the same way, or
      // the chart ends one figure below the headline printed above it and the
      // monthly-change figure reports the gap as a real gain.
      await seedMultiCurrencyAccount('WISE MULTI');

      const nw = await netWorthRepository.getNetWorthFromSnapshots('EUR');
      const last = nw.snapshots[nw.snapshots.length - 1];

      expect(last.liquid).toBe(nw.current.liquid);
      expect(last.netWorth).toBe(nw.current.netWorth);
      // …and the point before the USD leg posted holds only the EUR partition,
      // so the series genuinely moves rather than being flat by accident.
      expect(nw.snapshots[0].liquid).toBe(100);
    });

    it('splits liabilities out of the liquid bucket per currency', async () => {
      await seedRecipient();
      await addAccount('WISE MULTI', { currency: 'EUR' });
      await addAccount('CARD', { type: 'liability', currency: 'USD' });
      await insertRate('USD', 'CURRENT_DATE', '0.5');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '100.00', currency: 'EUR', bank: 'WISE MULTI' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '100.00', currency: 'USD', bank: 'WISE MULTI' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '-200.00', currency: 'USD', bank: 'CARD' });

      const nw = await netWorthRepository.getNetWorthFromSnapshots('EUR');

      expect(nw.current.liquid).toBe(150);
      expect(nw.current.liabilities).toBe(-100); // −200 USD × 0.5
      expect(nw.current.netWorth).toBe(50);
    });

    it('excludes tracking-only accounts from the partitioned current point', async () => {
      await seedMultiCurrencyAccount('WISE MULTI', { inNetWorth: true });
      await addAccount('TRACKING', { inNetWorth: false });
      await insertTxn({ dateExpr: 'CURRENT_DATE', amount: '9999.00', bank: 'TRACKING' });

      const nw = await netWorthRepository.getNetWorthFromSnapshots('EUR');

      expect(nw.current.liquid).toBe(150);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The cross-surface invariant the two findings are really about
  // ───────────────────────────────────────────────────────────────────────────
  it('reports ONE figure for the same account across every reader surface', async () => {
    await seedMultiCurrencyAccount('WISE MULTI', { statementBalance: '120.00' });

    const [hub] = await accountRepository.getAll();
    const cash = await assembleRebalanceInputs({ currency: 'EUR' });
    const nw = await netWorthRepository.getNetWorthFromSnapshots('EUR');
    const widget = await banksRepository.getBankBalances('EUR');

    expect(hub.computed_balance).toBe(150);
    expect(cash.availableCash).toBe(150);
    expect(nw.current.liquid).toBe(150);
    expect(widget.total_net_position).toBe(150);
    // …and the hub badge and the dashboard badge show the SAME drift, which is
    // the figure reconcile acts on. Keeping those two in step is what previously
    // held the dashboard on the cross-currency sum.
    expect(hub.drift).toBe(20);
    expect(widget.accounts[0].drift).toBe(20);
  });
});
