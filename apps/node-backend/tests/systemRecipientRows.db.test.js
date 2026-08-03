/**
 * Real-Postgres tests for the two server-generated ledger rows —
 * reconcile's 'adjustment' delta and the opening-balance anchor — and for the
 * shared system recipient that owns them.
 *
 * Why a DB suite: `transactions.recipient_id` is NOT NULL (migration 0001,
 * never relaxed) and both INSERTs omitted it, so BOTH features raised
 * `23502 null value in column "recipient_id"` on every call in production. The
 * mock suites next door assert the statements and their params, which is why
 * the omission survived: a mocked `query` accepts any column list. Nothing
 * short of the real schema can catch this class, so every row asserted here is
 * written by the service into real Postgres and read back.
 *
 * Determinism: fixtures are dated by SQL expressions relative to CURRENT_DATE,
 * never by literal calendar dates.
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
import {
  recipientRepository,
  SYSTEM_RECIPIENT_NAME,
} from '../src/repositories/recipientRepository.js';
import { reconcileAccount } from '../src/services/reconcileService.js';
import { setOpeningBalance } from '../src/services/openingBalanceService.js';
import { mergeAccounts, previewMerge } from '../src/services/accountMergeService.js';
import { ValidationError } from '../src/middleware/errorHandler.js';
import { clearMemoryCache } from '../src/services/currency/currencyConversionService.js';
import { closePool } from '../src/database/connection.js';

const rec = {};

async function seedRecipient() {
  const { rows } = await getTestPool().query(
    `INSERT INTO recipients (name, normalized_name) VALUES ('Misc Payee', 'misc payee') RETURNING id`,
  );
  rec.misc = rows[0].id;
}

async function addAccount(name, { currency = 'EUR', statementBalance = null } = {}) {
  const { rows } = await getTestPool().query(
    `INSERT INTO accounts (name, type, currency, spendable, in_net_worth, is_active,
                           statement_balance, statement_balance_date)
     VALUES ($1, 'checking'::account_type, $2, true, true, true, $3,
             CASE WHEN $3::numeric IS NULL THEN NULL ELSE CURRENT_DATE END)
     RETURNING id`,
    [name, currency, statementBalance],
  );
  return rows[0].id;
}

async function insertTxn({ dateExpr, amount, currency = 'EUR', bank }) {
  await getTestPool().query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, bank_account, is_active)
     VALUES ((${dateExpr})::date, $1, $2, $3, $4, true)`,
    [amount, currency, rec.misc, bank],
  );
}

async function insertRate(code, rate) {
  await getTestPool().query(
    `INSERT INTO exchange_rates (currency_code, rate_date, rate_to_eur, is_latest)
     VALUES ($1, CURRENT_DATE, $2, true)`,
    [code, rate],
  );
}

/** Every row the services generate, newest first. */
async function systemRows() {
  const { rows } = await getTestPool().query(
    `SELECT t.id, t.amount, t.balance, t.currency, t.memo, t.account_id, t.recipient_id,
            t.is_transfer, t.transfer_source, r.name AS recipient_name, r.is_active AS recipient_active
       FROM transactions t
       JOIN recipients r ON r.id = t.recipient_id
      WHERE t.transfer_source IN ('adjustment', 'opening')
      ORDER BY t.id DESC`,
  );
  return rows;
}

describe.skipIf(!hasTestDatabase())('system-generated ledger rows + their recipient (real DB)', () => {
  beforeAll(async () => {
    expect(
      process.env.DATABASE_URL,
      'DATABASE_URL must equal TEST_DATABASE_URL for this suite (see scripts/with-test-db.sh)',
    ).toBe(process.env.TEST_DATABASE_URL);
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
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The constraint that made both features unreachable
  // ───────────────────────────────────────────────────────────────────────────
  it('rejects a transactions INSERT with no recipient_id (23502) — the defect, by construction', async () => {
    await seedRecipient();
    const accountId = await addAccount('CHECKING');

    // The pre-fix statement, verbatim in shape: every column the adjustment row
    // carried EXCEPT recipient_id. It cannot reach the ledger, so any test that
    // asserts an adjustment row exists is discriminating against this.
    await expect(getTestPool().query(
      `INSERT INTO transactions
         (date, amount, currency, memo, account_id, is_transfer, transfer_source, is_active)
       VALUES (CURRENT_DATE, 20, 'EUR', 'BALANCE ADJUSTMENT', $1, true, 'adjustment', true)`,
      [accountId],
    )).rejects.toMatchObject({ code: '23502', column: 'recipient_id' });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // reconcile — mode 'adjustment'
  // ───────────────────────────────────────────────────────────────────────────
  describe("reconcile 'adjustment'", () => {
    it('creates the delta row and drives the drift to 0', async () => {
      await seedRecipient();
      const id = await addAccount('CHECKING', { statementBalance: '120.00' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '100.00', bank: 'CHECKING' });

      const before = (await accountRepository.getAll())[0];
      expect(before.drift).toBe(20);

      const result = await reconcileAccount(id, { mode: 'adjustment' });

      expect(result).toMatchObject({ mode: 'adjustment', drift: 0, statement_balance: 120 });
      const [row] = await systemRows();
      expect(Number(row.amount)).toBe(20);
      expect(row.account_id).toBe(id);
      expect(row.transfer_source).toBe('adjustment');
      expect(row.is_transfer).toBe(true);
      // NOT an anchor: a stamped balance would freeze the computed balance here.
      expect(row.balance).toBeNull();
      expect(row.recipient_name).toBe(SYSTEM_RECIPIENT_NAME);

      // The badge the user clicked is actually clear on the next hub read.
      const after = (await accountRepository.getAll())[0];
      expect(after.drift).toBe(0);
      expect(after.computed_balance).toBe(120);
    });

    it('clears the drift of a multi-currency account in the base partition currency', async () => {
      // Declared EUR, ledger is EUR + USD, statement 120 EUR. The base is the
      // EUR partition (100), so the adjustment is +20 EUR — it must land in the
      // partition the drift was measured against, or the badge never clears.
      await seedRecipient();
      const id = await addAccount('WISE MULTI', { statementBalance: '120.00' });
      await insertRate('USD', '0.5');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '100.00', currency: 'EUR', bank: 'WISE MULTI' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '100.00', currency: 'USD', bank: 'WISE MULTI' });

      await reconcileAccount(id, { mode: 'adjustment' });

      const [row] = await systemRows();
      expect(Number(row.amount)).toBe(20);
      expect(row.currency).toBe('EUR');

      const after = (await accountRepository.getAll())[0];
      expect(after.drift).toBe(0);
      expect(after.reconcilable_balance).toBe(120);
      // …and the USD partition is untouched: 120 EUR + 100 USD × 0.5.
      expect(after.computed_balance).toBe(170);
    });

    it('stamps the adjustment in a mislabelled account\'s only funded partition', async () => {
      // USD ledger under an account still declared EUR: an adjustment in
      // a.currency would open a second (EUR) partition and leave the drift.
      await seedRecipient();
      const id = await addAccount('MISLABELLED', { currency: 'EUR', statementBalance: '120.00' });
      await insertRate('USD', '0.5');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '100.00', currency: 'USD', bank: 'MISLABELLED' });

      await reconcileAccount(id, { mode: 'adjustment' });

      const [row] = await systemRows();
      expect(row.currency).toBe('USD');
      expect(Number(row.amount)).toBe(20);
      const after = (await accountRepository.getAll())[0];
      expect(after.drift).toBe(0);
    });

    it('is atomic: a second reconcile finds no drift left and inserts nothing', async () => {
      await seedRecipient();
      const id = await addAccount('CHECKING', { statementBalance: '120.00' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '100.00', bank: 'CHECKING' });

      await reconcileAccount(id, { mode: 'adjustment' });
      await expect(reconcileAccount(id, { mode: 'adjustment' })).rejects.toThrow(/already reconciled/i);

      expect(await systemRows()).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // opening-balance anchor
  // ───────────────────────────────────────────────────────────────────────────
  describe('opening balance', () => {
    it('writes the anchor and carries it into the computed balance', async () => {
      await seedRecipient();
      const id = await addAccount('WALLET');
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '1 day'", amount: '-25.00', bank: 'WALLET' });

      const { transaction, warning } = await setOpeningBalance(id, {
        balance: 1000,
        date: '2020-01-01',
      });

      expect(warning).toBeNull();
      expect(Number(transaction.balance)).toBe(1000);
      expect(Number(transaction.amount)).toBe(0);
      const [row] = await systemRows();
      expect(row.transfer_source).toBe('opening');
      expect(row.recipient_name).toBe(SYSTEM_RECIPIENT_NAME);

      // Anchor + the later −25 row.
      expect((await accountRepository.getAll())[0].computed_balance).toBe(975);
    });

    it('re-running updates the one anchor and leaves its recipient alone', async () => {
      await seedRecipient();
      const id = await addAccount('WALLET');

      await setOpeningBalance(id, { balance: 1000, date: '2020-01-01' });
      // A user re-attributing the anchor to a real payee must survive a re-run:
      // the upsert's UPDATE branch does not touch recipient_id.
      await getTestPool().query(
        `UPDATE transactions SET recipient_id = $1 WHERE transfer_source = 'opening'`,
        [rec.misc],
      );

      await setOpeningBalance(id, { balance: 2500, date: '2020-01-01' });

      const rows = await systemRows();
      expect(rows).toHaveLength(1); // one anchor per (account, currency)
      expect(Number(rows[0].balance)).toBe(2500);
      expect(rows[0].recipient_id).toBe(rec.misc);
    });

    it('anchors each currency of a multi-currency account separately', async () => {
      await seedRecipient();
      const id = await addAccount('WALLET');
      await insertRate('USD', '0.5');

      await setOpeningBalance(id, { balance: 1000, date: '2020-01-01' });
      await setOpeningBalance(id, { balance: 400, date: '2020-01-01', currency: 'USD' });

      const rows = await systemRows();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.recipient_name === SYSTEM_RECIPIENT_NAME)).toBe(true);
      // 1000 EUR + 400 USD × 0.5
      expect((await accountRepository.getAll())[0].computed_balance).toBe(1200);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // merging accounts that hold anchors — reachable only now that anchors exist
  // ───────────────────────────────────────────────────────────────────────────
  describe('merge vs. opening anchors', () => {
    it('refuses the merge with a 400 instead of a raw 23505, leaving both anchors intact', async () => {
      await seedRecipient();
      const survivor = await addAccount('SURVIVOR');
      const source = await addAccount('SOURCE');
      await setOpeningBalance(survivor, { balance: 1000, date: '2020-01-01' });
      await setOpeningBalance(source, { balance: 500, date: '2020-01-01' });

      // The dialog can warn before the click.
      const preview = await previewMerge(source, survivor);
      expect(preview.openingAnchorCollision).toBe(true);

      // uq_transactions_opening_anchor is UNIQUE (account_id, currency) WHERE
      // transfer_source = 'opening', so the repoint would raise 23505 —
      // unmapped, therefore a 500. The guard turns it into an actionable 400.
      const err = await mergeAccounts(survivor, [source]).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/opening balance in EUR/);
      expect(err.message).not.toMatch(/duplicate key|uq_transactions_opening_anchor/);
      expect(err.code).not.toBe('23505');

      // Nothing moved: both accounts and both anchors survive, each on its own
      // account, so the user can act on the message.
      const { rows: accounts } = await getTestPool().query(
        `SELECT id FROM accounts ORDER BY id`,
      );
      expect(accounts.map((r) => r.id)).toEqual([survivor, source].sort((a, b) => a - b));
      const anchors = await systemRows();
      expect(anchors).toHaveLength(2);
      expect(new Set(anchors.map((r) => r.account_id))).toEqual(new Set([survivor, source]));
    });

    it('allows the merge when the two anchors are in different currencies', async () => {
      await seedRecipient();
      const survivor = await addAccount('SURVIVOR');
      const source = await addAccount('SOURCE');
      await insertRate('USD', '0.5');
      await setOpeningBalance(survivor, { balance: 1000, date: '2020-01-01' });
      await setOpeningBalance(source, { balance: 400, date: '2020-01-01', currency: 'USD' });

      expect((await previewMerge(source, survivor)).openingAnchorCollision).toBe(false);
      await mergeAccounts(survivor, [source]);

      // Both anchors now sit on the survivor — one per currency, which the
      // partial unique index permits.
      const anchors = await systemRows();
      expect(anchors).toHaveLength(2);
      expect(anchors.every((r) => r.account_id === survivor)).toBe(true);
      // 1000 EUR + 400 USD × 0.5
      expect((await accountRepository.getAll())[0].computed_balance).toBe(1200);
    });

    it('does not flag a single account carrying both of the anchors', async () => {
      // The source holds nothing: one account with two currencies is the normal
      // shape the index allows, and must not be read as a collision.
      await seedRecipient();
      const survivor = await addAccount('SURVIVOR');
      const source = await addAccount('SOURCE');
      await insertRate('USD', '0.5');
      await setOpeningBalance(survivor, { balance: 1000, date: '2020-01-01' });
      await setOpeningBalance(survivor, { balance: 400, date: '2020-01-01', currency: 'USD' });

      expect((await previewMerge(source, survivor)).openingAnchorCollision).toBe(false);
      await mergeAccounts(survivor, [source]);
      expect(await systemRows()).toHaveLength(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // the shared system recipient
  // ───────────────────────────────────────────────────────────────────────────
  describe('system recipient', () => {
    it('is created once, inactive, and shared by both services', async () => {
      await seedRecipient();
      const id = await addAccount('CHECKING', { statementBalance: '120.00' });
      await insertTxn({ dateExpr: "CURRENT_DATE - interval '2 days'", amount: '100.00', bank: 'CHECKING' });

      await reconcileAccount(id, { mode: 'adjustment' });
      await setOpeningBalance(id, { balance: 10, date: '2020-01-01' });

      const { rows } = await getTestPool().query(
        `SELECT id, is_active FROM recipients WHERE name = $1`,
        [SYSTEM_RECIPIENT_NAME],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_active).toBe(false);

      const generated = await systemRows();
      expect(generated).toHaveLength(2);
      expect(new Set(generated.map((r) => r.recipient_id))).toEqual(new Set([rows[0].id]));
    });

    // Every call after the first is a pure read. An ON CONFLICT DO UPDATE no-op
    // would instead fire the recipients BEFORE UPDATE trigger on every
    // reconcile: updated_at bumps, xmin advances (one dead tuple per call, and
    // a broken optimistic-concurrency check for the DB editor on an adopted
    // user recipient) and the row stays exclusively locked for the rest of the
    // caller's transaction.
    it('does not write the row on the resolve path (no xmin/updated_at churn)', async () => {
      const id = await recipientRepository.getOrCreateSystemId();
      const version = async () => (await getTestPool().query(
        `SELECT xmin::text AS xmin, updated_at FROM recipients WHERE id = $1`, [id],
      )).rows[0];

      const before = await version();
      for (let i = 0; i < 5; i++) await recipientRepository.getOrCreateSystemId();

      expect(await version()).toEqual(before);
    });

    it('resolves idempotently and stays out of the active-only recipient list', async () => {
      const first = await recipientRepository.getOrCreateSystemId();
      const second = await recipientRepository.getOrCreateSystemId();
      expect(second).toBe(first);

      const active = await recipientRepository.getAll({ active: true, limit: 100 });
      expect(active.map((r) => r.name)).not.toContain(SYSTEM_RECIPIENT_NAME);
      // …but it is a real, joinable row — the FK and every transaction display
      // join (a plain LEFT JOIN) are indifferent to is_active.
      expect((await recipientRepository.getById(first)).name).toBe(SYSTEM_RECIPIENT_NAME);
    });

    it('adopts an existing recipient of the same name rather than deactivating it', async () => {
      const { rows } = await getTestPool().query(
        `INSERT INTO recipients (name, normalized_name, is_active)
         VALUES ($1, $1, true) RETURNING id`,
        [SYSTEM_RECIPIENT_NAME],
      );

      expect(await recipientRepository.getOrCreateSystemId()).toBe(rows[0].id);
      const after = await getTestPool().query(
        `SELECT is_active FROM recipients WHERE id = $1`, [rows[0].id],
      );
      expect(after.rows[0].is_active).toBe(true);
    });
  });
});
