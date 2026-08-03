/**
 * Real-Postgres tests for the brokerage CASH half of the portfolio import
 * commit.
 *
 * The property under test is exactly the one mocks could never see:
 * `transactions.recipient_id` has been NOT NULL since migration 0001, with no
 * default and no supplying trigger, so an INSERT that omits it dies with 23502
 * at commit — which is what the cash path did from its introduction (every
 * `route='cash'` row was recorded as a per-row error and the ledger stayed
 * empty). These tests drive `commitBatch` against the real schema and assert
 * the rows actually land, carry the batch's BROKER as their recipient (sleeve
 * account `institution`, falling back to `name`), keep the ledger sign from
 * the cash-sign fix, stay dedup-able on re-import, and remain rollback-able
 * through the route-split delete.
 *
 * Recipient identity: resolution goes through recipientRepository.createOrGet
 * (trim + uppercase display, normalized_name unique key), so differently-cased
 * or whitespace-padded broker labels from separate batches must converge on
 * ONE recipient row instead of forking near-duplicates.
 *
 * Isolation: per-test targeted DELETEs of the corpus this suite owns.
 * commitBatch/rollbackBatch open their own transactions, so a wrapping
 * transaction would nest.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';

import { closePool } from '../src/database/connection.js';
import { commitBatch } from '../src/services/portfolioImportPipeline/commit.js';
import { rollbackBatch } from '../src/services/portfolioImportBatchService.js';

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;

/** Ids seeded by `seedAccount()`. */
const fx = {};

/**
 * @param {{ name?: string, institution?: string|null }} [opts]
 * @returns {Promise<number>} account id
 */
async function seedAccount({ name = 'DEGIRO SLEEVE', institution = ' DeGiro ' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO accounts (name, display_name, institution) VALUES ($1, $1, $2) RETURNING id`,
    [name, institution],
  );
  return rows[0].id;
}

async function wipe() {
  await pool.query(`DELETE FROM portfolio_transactions`);
  await pool.query(`DELETE FROM transactions`);
  await pool.query(`DELETE FROM portfolio_import_staging_rows`);
  await pool.query(`DELETE FROM portfolio_import_batches`);
  await pool.query(`DELETE FROM recipients`);
  await pool.query(`DELETE FROM accounts`);
}

/** @param {number|null} accountId */
async function newBrokerageBatch(accountId) {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_import_batches
       (adapter_name, status, rows_total, account_id, is_brokerage)
     VALUES ('generic', 'awaiting_review', 0, $1, true) RETURNING id`,
    [accountId],
  );
  return Number(rows[0].id);
}

/** Stage one 'matched' CASH row. */
async function stageCash(batchId, rowIndex, { typeRaw = 'deposit', amount = 1000, note = null, txHash = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_import_staging_rows
       (batch_id, row_index, status, tx_date, type_raw, route, amount, currency, note, tx_hash)
     VALUES ($1, $2, 'matched', '2026-02-01', $3, 'cash', $4, 'EUR', $5, $6)
     RETURNING id`,
    [batchId, rowIndex, typeRaw, amount, note, txHash],
  );
  return Number(rows[0].id);
}

async function ledgerRows() {
  const { rows } = await pool.query(
    `SELECT t.id, t.amount::float8 AS amount, t.memo, t.account_id, t.recipient_id, r.name AS recipient_name
       FROM transactions t JOIN recipients r ON r.id = t.recipient_id
      ORDER BY t.id`,
  );
  return rows;
}

describeDb('portfolio import — brokerage cash commit (real Postgres)', () => {
  beforeAll(acquireDbSuiteLock, 180_000);

  beforeEach(async () => {
    await wipe();
    fx.accountId = await seedAccount();
  });

  afterAll(async () => {
    if (!pool) return;
    await wipe();
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it('commits cash rows into the ledger with the broker as recipient (institution, trimmed/uppercased)', async () => {
    const batchId = await newBrokerageBatch(fx.accountId);
    const depositRow = await stageCash(batchId, 0, { typeRaw: 'deposit', amount: 1000, note: 'wire in' });
    const withdrawalRow = await stageCash(batchId, 1, { typeRaw: 'withdrawal', amount: 250 });

    const res = await commitBatch({ batchId });
    expect(res).toMatchObject({ imported: 2, duplicates: 0, errors: 0 });

    const rows = await ledgerRows();
    expect(rows).toHaveLength(2);
    // The broker recipient exists ONCE, adopted from the account's institution
    // ' DeGiro ' through the standard trim+uppercase display-name path.
    for (const r of rows) {
      expect(r.recipient_name).toBe('DEGIRO');
      expect(r.account_id).toBe(fx.accountId);
    }
    // Ledger sign survives (cash-sign fix): staging magnitudes are absolute,
    // the withdrawal must land negative.
    expect(rows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([-250, 1000]);

    // Staging rows are committed and point at their ledger rows.
    const { rows: staged } = await pool.query(
      `SELECT id, status, committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id = $1 ORDER BY row_index`,
      [batchId],
    );
    expect(staged.map((s) => s.status)).toEqual(['committed', 'committed']);
    expect(new Set(staged.map((s) => Number(s.committed_txn_id)))).toEqual(new Set(rows.map((r) => Number(r.id))));
    expect(Number(staged[0].id)).toBe(depositRow);
    expect(Number(staged[1].id)).toBe(withdrawalRow);
  });

  it('does not fork the broker identity across batches with casing/whitespace variants', async () => {
    const batchA = await newBrokerageBatch(fx.accountId); // institution ' DeGiro '
    await stageCash(batchA, 0, { typeRaw: 'deposit', amount: 100 });
    expect((await commitBatch({ batchId: batchA })).imported).toBe(1);

    const otherAccount = await seedAccount({ name: 'DEGIRO SLEEVE 2', institution: 'DEGIRO  ' });
    const batchB = await newBrokerageBatch(otherAccount);
    await stageCash(batchB, 0, { typeRaw: 'deposit', amount: 200, note: 'second batch' });
    expect((await commitBatch({ batchId: batchB })).imported).toBe(1);

    const { rows } = await pool.query(`SELECT id, name FROM recipients WHERE normalized_name = 'DEGIRO'`);
    expect(rows).toHaveLength(1); // one identity, not 'DEGIRO' + ' DeGiro ' twins
    const { rows: distinct } = await pool.query(`SELECT DISTINCT recipient_id FROM transactions`);
    expect(distinct).toHaveLength(1);
    expect(Number(distinct[0].recipient_id)).toBe(Number(rows[0].id));
  });

  it('falls back to the account name when the institution is empty', async () => {
    const acct = await seedAccount({ name: 'IBKR-MAIN', institution: null });
    const batchId = await newBrokerageBatch(acct);
    await stageCash(batchId, 0, { typeRaw: 'deposit', amount: 500 });

    expect((await commitBatch({ batchId })).imported).toBe(1);
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_name).toBe('IBKR-MAIN');
  });

  it('re-importing the same statement is a no-op (field dedup, not a second ledger row)', async () => {
    const batchA = await newBrokerageBatch(fx.accountId);
    await stageCash(batchA, 0, { typeRaw: 'withdrawal', amount: 250, note: 'wd' });
    expect((await commitBatch({ batchId: batchA })).imported).toBe(1);

    const batchB = await newBrokerageBatch(fx.accountId);
    await stageCash(batchB, 0, { typeRaw: 'withdrawal', amount: 250, note: 'wd' });
    const res = await commitBatch({ batchId: batchB });
    expect(res).toMatchObject({ imported: 0, duplicates: 1 });
    expect(await ledgerRows()).toHaveLength(1);
  });

  it('rollback deletes exactly the cash rows the commit path itself created', async () => {
    // A decoy ledger row from ANOTHER source must survive the rollback.
    const { rows: decoyRec } = await pool.query(
      `INSERT INTO recipients (name, normalized_name) VALUES ('BYSTANDER', 'BYSTANDER') RETURNING id`,
    );
    const { rows: decoy } = await pool.query(
      `INSERT INTO transactions (date, amount, currency, memo, account_id, recipient_id, is_active)
       VALUES ('2026-01-15', 77, 'EUR', 'unrelated', $1, $2, true) RETURNING id`,
      [fx.accountId, decoyRec[0].id],
    );

    const batchId = await newBrokerageBatch(fx.accountId);
    await stageCash(batchId, 0, { typeRaw: 'deposit', amount: 1000 });
    await stageCash(batchId, 1, { typeRaw: 'withdrawal', amount: 250 });
    expect((await commitBatch({ batchId })).imported).toBe(2);
    expect(await ledgerRows()).toHaveLength(3);

    const res = await rollbackBatch(batchId);
    expect(res).toEqual({ deleted: 2 });

    const remaining = await ledgerRows();
    expect(remaining).toHaveLength(1);
    expect(Number(remaining[0].id)).toBe(Number(decoy[0].id));
    // The broker recipient row itself survives — recipients are shared state.
    const { rows: rec } = await pool.query(`SELECT 1 FROM recipients WHERE normalized_name = 'DEGIRO'`);
    expect(rec).toHaveLength(1);

    // Rollback also resets the staging rows to their pre-commit state: no
    // committed_txn_id left dangling at the deleted ledger rows.
    const { rows: staged } = await pool.query(
      `SELECT status, committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id = $1 ORDER BY row_index`,
      [batchId],
    );
    expect(staged.map((s) => s.status)).toEqual(['matched', 'matched']);
    for (const s of staged) expect(s.committed_txn_id).toBeNull();
  });
});
