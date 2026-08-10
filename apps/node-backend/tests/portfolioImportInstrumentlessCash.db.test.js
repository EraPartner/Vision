/**
 * Real-Postgres tests for D6 (ADR-095 addendum 2026-07-10): instrument-less
 * dividend/interest/fee/tax brokerage rows route 'cash' and land as ONE signed
 * `transactions` row on the sleeve, auto-categorized by row kind.
 *
 * The discriminating property: before D6, validate routed these rows
 * 'portfolio' and commit errored every one with "unresolved instrument", so a
 * real brokerage Account.csv (sleeve interest, custody fees, account-level
 * distributions — rows with no symbol and no name) could NEVER fully import.
 * The first test drives the full validate → match → commit pipeline and
 * asserts imported=5/errors=0 with correctly SIGNED, CATEGORIZED ledger rows —
 * it fails on the old routing (4 unresolved-instrument errors).
 *
 * Sign truth comes from the CANONICAL type, not type_raw: the custody-fee row
 * is staged with a raw label only the batch's type_mapping understands
 * ("Custody Fee" → fee), so deriving the sign from type_raw (the pre-D6
 * signedCashAmount) would default it to +1 and credit the sleeve with its own
 * fee. The test pins the debit.
 *
 * Rollback must treat these rows exactly like other cash rows: route='cash'
 * travels with the committed id, so the ledger DELETE covers them and the
 * portfolio DELETE never sees their ids.
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
import { validateBatch } from '../src/services/portfolioImportPipeline/validate.js';
import { matchBatch } from '../src/services/portfolioImportPipeline/matchInvestments.js';
import { commitBatch } from '../src/services/portfolioImportPipeline/commit.js';
import { rollbackBatch } from '../src/services/portfolioImportBatchService.js';
import accountRepository from '../src/repositories/accountRepository.js';
import { clearMemoryCache } from '../src/services/currency/currencyConversionService.js';

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;

/** Ids seeded per test. */
const fx = {};

async function wipe() {
  await pool.query(`DELETE FROM portfolio_transactions`);
  await pool.query(`DELETE FROM transactions`);
  await pool.query(`DELETE FROM portfolio_import_staging_rows`);
  await pool.query(`DELETE FROM portfolio_import_batches`);
  await pool.query(`DELETE FROM investments`);
  await pool.query(`DELETE FROM recipients`);
  await pool.query(`DELETE FROM accounts`);
  await pool.query(`DELETE FROM categories`);
  await pool.query(`DELETE FROM exchange_rates`);
  clearMemoryCache();
}

async function seedAccount() {
  const { rows } = await pool.query(
    `INSERT INTO accounts (name, display_name, institution, currency)
     VALUES ('DEGIRO SLEEVE', 'DEGIRO SLEEVE', 'DeGiro', 'EUR') RETURNING id`,
  );
  return rows[0].id;
}

async function seedInvestment() {
  const { rows } = await pool.query(
    `INSERT INTO investments (name, symbol, asset_class, currency)
     VALUES ('Acme Corp', 'ACME', 'stock', 'EUR') RETURNING id`,
  );
  return rows[0].id;
}

/** @param {object|null} customConfig */
async function newBrokerageBatch(accountId, customConfig = null) {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_import_batches
       (adapter_name, status, rows_total, account_id, is_brokerage, custom_config)
     VALUES ('generic', 'pending', 0, $1, true, $2) RETURNING id`,
    [accountId, customConfig ? JSON.stringify(customConfig) : null],
  );
  return Number(rows[0].id);
}

/** Stage one PENDING row (route/type resolved by validateBatch, not seeded). */
async function stagePending(batchId, rowIndex, { typeRaw, amount, symbolRaw = null, nameRaw = null, note = null, currency = 'EUR' }) {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_import_staging_rows
       (batch_id, row_index, status, tx_date, type_raw, symbol_raw, name_raw, amount, currency, note, raw_data)
     VALUES ($1, $2, 'pending', '2026-02-02', $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [batchId, rowIndex, typeRaw, symbolRaw, nameRaw, amount, currency, note, `${rowIndex}|${typeRaw}|${amount}|${currency}`],
  );
  return Number(rows[0].id);
}

async function ledgerRows() {
  const { rows } = await pool.query(
    `SELECT t.id, t.amount::float8 AS amount, t.memo, t.account_id, t.recipient_id,
            r.name AS recipient_name, c.general AS cat_general, c.detail AS cat_detail
       FROM transactions t
       JOIN recipients r ON r.id = t.recipient_id
       LEFT JOIN categories c ON c.id = t.category_id
      ORDER BY t.id`,
  );
  return rows;
}

/**
 * The Account.csv-style corpus: four instrument-less money movements plus one
 * dividend that names an instrument (must stay a portfolio row).
 * The custody fee's raw label resolves only via the batch type_mapping.
 */
async function stageCorpus(batchId) {
  await stagePending(batchId, 0, { typeRaw: 'dividend', amount: 12.34, note: 'fund distribution' });
  await stagePending(batchId, 1, { typeRaw: 'rente', amount: 1.11 }); // NL alias → interest
  await stagePending(batchId, 2, { typeRaw: 'Custody Fee', amount: 2.5 }); // type_mapping → fee
  await stagePending(batchId, 3, { typeRaw: 'tax', amount: 0.4 });
  await stagePending(batchId, 4, { typeRaw: 'dividend', amount: 100, symbolRaw: 'ACME' });
}

const TYPE_MAPPING = { type_mapping: { 'Custody Fee': 'fee' } };

describeDb('portfolio import — D6 instrument-less cash rows (real Postgres)', () => {
  beforeAll(acquireDbSuiteLock, 180_000);

  beforeEach(async () => {
    await wipe();
    fx.accountId = await seedAccount();
    fx.investmentId = await seedInvestment();
  });

  afterAll(async () => {
    if (!pool) return;
    await wipe();
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it('imports instrument-less dividend/interest/fee/tax rows as signed, categorized ledger rows (fails on the pre-D6 "unresolved instrument" routing)', async () => {
    const batchId = await newBrokerageBatch(fx.accountId, TYPE_MAPPING);
    await stageCorpus(batchId);

    const validated = await validateBatch({ batchId });
    expect(validated).toMatchObject({ validated: 5, duplicates: 0, errors: 0 });

    // D6 routing is decided at validate time, deterministic from the row: no
    // symbol AND no name → 'cash' (with the canonical type persisted for the
    // sign/category); an instrument-bearing row keeps 'portfolio'.
    const { rows: routed } = await pool.query(
      `SELECT row_index, route, type FROM portfolio_import_staging_rows WHERE batch_id = $1 ORDER BY row_index`,
      [batchId],
    );
    expect(routed.map((r) => r.route)).toEqual(['cash', 'cash', 'cash', 'cash', 'portfolio']);
    expect(routed.map((r) => r.type)).toEqual(['dividend', 'interest', 'fee', 'tax', 'dividend']);

    await matchBatch({ batchId });

    const res = await commitBatch({ batchId });
    // THE discriminating assertion: pre-D6 these four rows each errored
    // "unresolved instrument — pick or create a holding" (imported 1, errors 4).
    expect(res).toMatchObject({ imported: 5, duplicates: 0, errors: 0 });
    const { rows: errRows } = await pool.query(
      `SELECT error_message FROM portfolio_import_staging_rows WHERE batch_id = $1 AND status = 'error'`,
      [batchId],
    );
    expect(errRows).toEqual([]);

    // Exactly the four instrument-less rows in the LEDGER — signed by kind,
    // categorized by kind, payee = broker, on the sleeve account.
    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(4);
    for (const r of ledger) {
      expect(r.account_id).toBe(fx.accountId);
      expect(r.recipient_name).toBe('DEGIRO');
    }
    const byAmount = new Map(ledger.map((r) => [r.amount, r]));
    // Income kinds credit the sleeve…
    expect(byAmount.get(12.34)).toMatchObject({ cat_general: 'INCOME', cat_detail: 'DIVIDENDS' });
    expect(byAmount.get(1.11)).toMatchObject({ cat_general: 'INCOME', cat_detail: 'INTEREST' });
    // …expense kinds debit it. The fee's sign comes from the CANONICAL type
    // ('Custody Fee' → fee via type_mapping): deriving it from type_raw would
    // classify 'review' and default to +2.50.
    expect(byAmount.get(-2.5)).toMatchObject({ cat_general: 'INVESTMENTS', cat_detail: 'FEES' });
    expect(byAmount.get(-0.4)).toMatchObject({ cat_general: 'INVESTMENTS', cat_detail: 'TAXES' });

    // The instrument-bearing dividend stays a PORTFOLIO row (tax/stats source)
    // and emitted NO ledger row — the double-count guard.
    const { rows: ptx } = await pool.query(
      `SELECT investment_id, type, amount::float8 AS amount, account_id FROM portfolio_transactions`,
    );
    expect(ptx).toHaveLength(1);
    expect(ptx[0]).toMatchObject({ investment_id: fx.investmentId, type: 'dividend', amount: 100, account_id: fx.accountId });
  });

  it('re-importing the same statement is a no-op for D6 rows (field dedup)', async () => {
    const batchA = await newBrokerageBatch(fx.accountId, TYPE_MAPPING);
    await stageCorpus(batchA);
    await validateBatch({ batchId: batchA });
    await matchBatch({ batchId: batchA });
    expect((await commitBatch({ batchId: batchA })).imported).toBe(5);

    const batchB = await newBrokerageBatch(fx.accountId, TYPE_MAPPING);
    await stageCorpus(batchB);
    await validateBatch({ batchId: batchB });
    await matchBatch({ batchId: batchB });
    const res = await commitBatch({ batchId: batchB });
    expect(res).toMatchObject({ imported: 0, duplicates: 5, errors: 0 });
    expect(await ledgerRows()).toHaveLength(4);
  });

  it('rollback restores exactly: D6 ledger rows deleted via the cash route, bystanders untouched', async () => {
    // Decoys from OTHER sources on both sides of the route split.
    const { rows: decoyRec } = await pool.query(
      `INSERT INTO recipients (name, normalized_name) VALUES ('BYSTANDER', 'BYSTANDER') RETURNING id`,
    );
    const { rows: decoyTxn } = await pool.query(
      `INSERT INTO transactions (date, amount, currency, memo, account_id, recipient_id, is_active)
       VALUES ('2026-01-15', 77, 'EUR', 'unrelated', $1, $2, true) RETURNING id`,
      [fx.accountId, decoyRec[0].id],
    );
    const { rows: decoyTrade } = await pool.query(
      `INSERT INTO portfolio_transactions (investment_id, type, date, amount)
       VALUES ($1, 'buy', '2026-01-10', 500) RETURNING id`,
      [fx.investmentId],
    );

    const batchId = await newBrokerageBatch(fx.accountId, TYPE_MAPPING);
    await stageCorpus(batchId);
    await validateBatch({ batchId });
    await matchBatch({ batchId });
    expect((await commitBatch({ batchId })).imported).toBe(5);
    expect(await ledgerRows()).toHaveLength(5); // 4 D6 rows + decoy

    const res = await rollbackBatch(batchId);
    expect(res).toEqual({ deleted: 5 }); // 4 ledger + 1 portfolio

    const remainingLedger = await ledgerRows();
    expect(remainingLedger).toHaveLength(1);
    expect(Number(remainingLedger[0].id)).toBe(Number(decoyTxn[0].id));
    const { rows: remainingTrades } = await pool.query(`SELECT id FROM portfolio_transactions`);
    expect(remainingTrades).toHaveLength(1);
    expect(Number(remainingTrades[0].id)).toBe(Number(decoyTrade[0].id));

    // Staging reset to the pre-commit state; shared state (categories,
    // recipient) survives.
    const { rows: staged } = await pool.query(
      `SELECT status, committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id = $1`,
      [batchId],
    );
    for (const s of staged) {
      expect(s.status).toBe('matched');
      expect(s.committed_txn_id).toBeNull();
    }
    const { rows: cats } = await pool.query(
      `SELECT general, detail FROM categories ORDER BY general, detail`,
    );
    expect(cats.length).toBeGreaterThanOrEqual(4);
  });

  it('two identical same-day custody fees in ONE batch both commit; re-importing that statement adds nothing', async () => {
    // Realistic Degiro shape: N per-exchange connection fees, same date, same
    // amount, distinguishable only by a description that lands in `note` ONLY
    // if the user mapped a note column — here they didn't (note null), so the
    // dedup identity (date, signed amount, memo) repeats legitimately. The
    // boolean field-dedup silently dropped the second fee (imported 1,
    // duplicate 1, ledger short a real −2.50); occurrence-matching must land
    // BOTH — while a re-import of the same statement stays a complete no-op.
    const batchA = await newBrokerageBatch(fx.accountId, TYPE_MAPPING);
    await stagePending(batchA, 0, { typeRaw: 'Custody Fee', amount: 2.5 });
    await stagePending(batchA, 1, { typeRaw: 'Custody Fee', amount: 2.5 });
    await validateBatch({ batchId: batchA });
    await matchBatch({ batchId: batchA });

    const resA = await commitBatch({ batchId: batchA });
    expect(resA).toMatchObject({ imported: 2, duplicates: 0, errors: 0 });
    const ledgerA = await ledgerRows();
    expect(ledgerA.map((r) => r.amount)).toEqual([-2.5, -2.5]);
    expect(ledgerA.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(-5.0);

    // Cross-batch idempotence must survive the repeated identity: the re-import
    // sees 2 pre-existing matches for 2 statement occurrences → both dedup.
    const batchB = await newBrokerageBatch(fx.accountId, TYPE_MAPPING);
    await stagePending(batchB, 0, { typeRaw: 'Custody Fee', amount: 2.5 });
    await stagePending(batchB, 1, { typeRaw: 'Custody Fee', amount: 2.5 });
    await validateBatch({ batchId: batchB });
    await matchBatch({ batchId: batchB });

    const resB = await commitBatch({ batchId: batchB });
    expect(resB).toMatchObject({ imported: 0, duplicates: 2, errors: 0 });
    expect(await ledgerRows()).toHaveLength(2);
  });

  it('a −10 fee is not deduped against an unrelated +10 ledger row sharing date and memo (no magnitude leg for D6 kinds)', async () => {
    // The legacy |amount| branch exists only for pre-sign-fix
    // deposit/withdrawal rows. Applied to D6 kinds it made a NEW fee vanish
    // whenever any same-day +10 row happened to share the memo.
    const { rows: rec } = await pool.query(
      `INSERT INTO recipients (name, normalized_name) VALUES ('OTHER', 'OTHER') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO transactions (date, amount, currency, memo, account_id, recipient_id, is_active)
       VALUES ('2026-02-02', 10, 'EUR', 'CUSTODY FEE', $1, $2, true)`,
      [fx.accountId, rec[0].id],
    );

    const batchId = await newBrokerageBatch(fx.accountId, TYPE_MAPPING);
    await stagePending(batchId, 0, { typeRaw: 'Custody Fee', amount: 10 });
    await validateBatch({ batchId });
    await matchBatch({ batchId });

    const res = await commitBatch({ batchId });
    expect(res).toMatchObject({ imported: 1, duplicates: 0, errors: 0 });
    const amounts = (await ledgerRows()).map((r) => r.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([-10, 10]); // the fee landed; the bystander is untouched
  });

  it('a USD cash row on the EUR sleeve keeps its native currency and is converted per partition, not summed raw (WP-C2 FX check)', async () => {
    // The import seam of the FX-blind-SUM finding: broker cash lands as real
    // ledger rows since f843d64, so a USD dividend must (a) be STORED as USD —
    // conversion is a display concern — and (b) reach the hub through the
    // per-currency anchor+delta partitions (#142), never through the
    // cross-currency Σ that added 100 EUR + 100 USD as bare numbers.
    await pool.query(
      `INSERT INTO exchange_rates (currency_code, rate_date, rate_to_eur, is_latest)
       VALUES ('USD', CURRENT_DATE, '0.5', true)`,
    );
    const batchId = await newBrokerageBatch(fx.accountId, TYPE_MAPPING);
    await stagePending(batchId, 0, { typeRaw: 'deposit', amount: 100 }); // 100 EUR
    await stagePending(batchId, 1, { typeRaw: 'dividend', amount: 100, currency: 'USD' }); // 100 USD, instrument-less
    await validateBatch({ batchId });
    await matchBatch({ batchId });
    expect((await commitBatch({ batchId })).imported).toBe(2);

    // (a) native currency stored raw on the row.
    const { rows: usdRows } = await pool.query(
      `SELECT amount::float8 AS amount, currency FROM transactions WHERE currency = 'USD'`,
    );
    expect(usdRows).toEqual([{ amount: 100, currency: 'USD' }]);

    // (b) the hub balance partitions per currency and converts each at its own
    // rate: 100 EUR + (100 USD × 0.5) = 150 — not (100 + 100) × 1 = 200, and
    // not (100 + 100) × 0.5 = 100.
    const accounts = await accountRepository.getAll();
    const sleeve = accounts.find((a) => Number(a.id) === Number(fx.accountId));
    expect(sleeve.computed_balance).toBe(150);
  });

  it('non-brokerage batches are untouched: an instrument-less dividend still blocks with "unresolved instrument"', async () => {
    const { rows } = await pool.query(
      `INSERT INTO portfolio_import_batches (adapter_name, status, rows_total, is_brokerage)
       VALUES ('generic', 'pending', 0, false) RETURNING id`,
    );
    const batchId = Number(rows[0].id);
    await stagePending(batchId, 0, { typeRaw: 'dividend', amount: 12.34 });

    await validateBatch({ batchId });
    const { rows: routed } = await pool.query(
      `SELECT route FROM portfolio_import_staging_rows WHERE batch_id = $1`,
      [batchId],
    );
    expect(routed[0].route).toBeNull();

    await matchBatch({ batchId });
    const res = await commitBatch({ batchId });
    expect(res).toMatchObject({ imported: 0, errors: 1 });
    const { rows: errRows } = await pool.query(
      `SELECT error_message FROM portfolio_import_staging_rows WHERE batch_id = $1`,
      [batchId],
    );
    expect(errRows[0].error_message).toMatch(/unresolved instrument/);
    expect(await ledgerRows()).toHaveLength(0);
  });
});
