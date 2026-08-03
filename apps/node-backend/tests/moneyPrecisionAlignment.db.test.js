/**
 * Real-Postgres pins for migration 0088 (ADR-060 D7): NUMERIC(18,4) is the domain
 * precision for money columns, and every (15,2) sibling of transactions.amount is
 * aligned to it.
 *
 * What only a real database can verify here:
 *   1. The widened types themselves (information_schema) — the whole point of the
 *      migration, and the assertion that catches an incomplete inventory or a
 *      re-narrowing regression.
 *   2. The finding's failure case, now possible: a 4-decimal transaction split
 *      EXACTLY into 4-decimal parts, with genuine NUMERIC equality
 *      (SUM(splits) = ABS(amount), no 0.005-tolerance masking), surviving the
 *      0019 sync-trigger path into agg_split_outstanding — whose plpgsql locals
 *      0088 re-declared at (18,4) precisely so this stops rounding to cents.
 *   3. The 0062 split-guard trigger still guards after the retype.
 *   4. Planned→executed copies are precision-symmetric: a 4-dp planned amount
 *      round-trips into transactions.amount and compares equal in SQL.
 *   5. The repository guards moved to storage precision with the columns:
 *      sub-cent over-payment / over-allocation are REJECTED (pre-0088 they were
 *      admitted-then-rounded-away by (15,2) storage; with (18,4) storage a
 *      cent-precision cap would store the overshoot), auto-settle fires only on
 *      an exact 4-dp cover, and a settled split takes no further payments.
 *   6. The 0088 downgrade pre-flight refuses (with a curated message, database
 *      untouched) when a sub-cent split would round to 0.00 under
 *      USING round(amount, 2) and violate chk_split_amount_positive.
 *
 * Isolation: fixtures carry a unique memo/name marker; afterAll deletes only what
 * this suite created (transactions cascade to splits → payments → agg rows). The
 * downgrade suite runs on its own scratch database, adr109Conversion-style.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import { splitRepository } from '../src/repositories/splitRepository.js';
import { closePool } from '../src/database/connection.js';

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;

const MARK = `_0088_precision_${process.pid}`;

/**
 * Mirror of MONEY_COLUMNS in alembic/versions/0088_money_precision_alignment.py —
 * the full D7 alignment inventory. Kept literal on purpose: if the migration's
 * list and this one drift, the schema pin below fails.
 */
const WIDENED = [
  ['transactions', 'balance'],
  ['planned_transactions', 'amount'],
  ['planned_transactions', 'loan_principal'],
  ['planned_transactions', 'loan_regular_payment_amount'],
  ['planned_transaction_loan_schedule', 'payment_amount'],
  ['planned_transaction_loan_schedule', 'principal_amount'],
  ['planned_transaction_loan_schedule', 'interest_amount'],
  ['planned_transaction_loan_schedule', 'remaining_principal'],
  ['transaction_splits', 'amount'],
  ['split_payments', 'amount'],
  ['agg_split_outstanding', 'original_amount'],
  ['agg_split_outstanding', 'paid_amount'],
  ['agg_split_outstanding', 'outstanding_amount'],
  ['accounts', 'statement_balance'],
  ['belfius_raw_transactions', 'amount'],
  ['belfius_raw_transactions', 'balance'],
  ['custom_raw_transactions', 'amount'],
  ['custom_raw_transactions', 'balance'],
  ['kbc_raw_transactions', 'amount'],
  ['kbc_raw_transactions', 'balance'],
  ['kbc_raw_transactions', 'credit_amount'],
  ['kbc_raw_transactions', 'debit_amount'],
  ['manual_raw_transactions', 'amount'],
  ['revolut_raw_transactions', 'amount'],
  ['revolut_raw_transactions', 'fee'],
  ['revolut_raw_transactions', 'balance'],
  ['sabb_raw_transactions', 'amount'],
  ['vision_raw_transactions', 'amount'],
  ['vision_raw_transactions', 'balance'],
  ['wise_raw_transactions', 'source_amount'],
  ['wise_raw_transactions', 'target_amount'],
  ['wise_raw_transactions', 'source_fee_amount'],
];

describeDb('migration 0088: money columns aligned to NUMERIC(18,4)', () => {
  /** @type {number} */ let recipientId;
  /** @type {number[]} */ const txIds = [];
  /** @type {number[]} */ const plannedIds = [];

  beforeAll(async () => {
    await acquireDbSuiteLock();
    const { rows } = await pool.query(
      `INSERT INTO recipients (name, normalized_name) VALUES ($1, $1) RETURNING id`,
      [MARK],
    );
    recipientId = rows[0].id;
  }, 180_000);

  afterAll(async () => {
    if (pool) {
      // transactions → transaction_splits → split_payments / agg_split_outstanding
      // all cascade; planned rows and the recipient are deleted directly.
      if (txIds.length) await pool.query(`DELETE FROM transactions WHERE id = ANY($1)`, [txIds]);
      if (plannedIds.length) {
        await pool.query(`DELETE FROM planned_transactions WHERE id = ANY($1)`, [plannedIds]);
      }
      if (recipientId) await pool.query(`DELETE FROM recipients WHERE id = $1`, [recipientId]);
    }
    await releaseDbSuiteLock();
    await closeTestPool();
    // The repository guards below go through the app pool (DATABASE_URL).
    await closePool();
  });

  async function insertTx(amount, balance = null) {
    const { rows } = await pool.query(
      `INSERT INTO transactions (date, amount, balance, memo, currency, recipient_id)
       VALUES ('2026-08-01', $1, $2, $3, 'EUR', $4) RETURNING id`,
      [amount, balance, MARK, recipientId],
    );
    txIds.push(rows[0].id);
    return rows[0].id;
  }

  it('pins every D7 column at numeric(18,4) via information_schema', async () => {
    const { rows } = await pool.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'numeric'
        AND numeric_precision = 18 AND numeric_scale = 4
    `);
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const missing = WIDENED.filter(([t, c]) => !have.has(`${t}.${c}`));
    expect(missing).toEqual([]);
    // 0025's original column kept its type; nothing regressed it.
    expect(have.has('transactions.amount')).toBe(true);
  });

  it('leaves no numeric(15,2) money column behind, and import_staging_rows at (20,4)', async () => {
    const { rows } = await pool.query(`
      SELECT table_name || '.' || column_name AS col
      FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'numeric'
        AND numeric_precision = 15 AND numeric_scale = 2
    `);
    expect(rows.map((r) => r.col)).toEqual([]);

    const staging = await pool.query(`
      SELECT column_name, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'import_staging_rows'
        AND column_name IN ('amount', 'balance')
      ORDER BY column_name
    `);
    expect(staging.rows).toEqual([
      { column_name: 'amount', numeric_precision: 20, numeric_scale: 4 },
      { column_name: 'balance', numeric_precision: 20, numeric_scale: 4 },
    ]);
  });

  it('splits a 4-decimal amount exactly — SUM(splits) = ABS(amount), no tolerance needed', async () => {
    const txId = await insertTx('-100.0001');
    await pool.query(
      `INSERT INTO transaction_splits (transaction_id, recipient_id, amount)
       VALUES ($1, $2, '50.0000'), ($1, $2, '50.0001')`,
      [txId, recipientId],
    );

    const { rows } = await pool.query(
      `SELECT SUM(ts.amount) AS split_sum,
              SUM(ts.amount) = ABS(t.amount) AS exact
       FROM transactions t JOIN transaction_splits ts ON ts.transaction_id = t.id
       WHERE t.id = $1 GROUP BY t.id, t.amount`,
      [txId],
    );
    expect(rows[0].split_sum).toBe('100.0001');
    expect(rows[0].exact).toBe(true); // pre-0088 the 50.0001 split rounded to 50.00

    // The 0019 trigger chain kept all four decimals on its way into the aggregate
    // (0088 re-declared fn_agg_split_outstanding_sync's locals at (18,4)).
    const agg = await pool.query(
      `SELECT a.original_amount
       FROM agg_split_outstanding a
       JOIN transaction_splits ts ON ts.id = a.split_id
       WHERE ts.transaction_id = $1 ORDER BY a.original_amount`,
      [txId],
    );
    expect(agg.rows.map((r) => r.original_amount)).toEqual(['50.0000', '50.0001']);
  });

  it('tracks 4-decimal payments to an exact outstanding amount', async () => {
    const txId = await insertTx('-60.0001');
    const { rows: split } = await pool.query(
      `INSERT INTO transaction_splits (transaction_id, recipient_id, amount)
       VALUES ($1, $2, '60.0001') RETURNING id`,
      [txId, recipientId],
    );
    await pool.query(`INSERT INTO split_payments (split_id, amount) VALUES ($1, '25.0001')`, [
      split[0].id,
    ]);
    const { rows } = await pool.query(
      `SELECT paid_amount, outstanding_amount FROM agg_split_outstanding WHERE split_id = $1`,
      [split[0].id],
    );
    expect(rows[0].paid_amount).toBe('25.0001');
    expect(rows[0].outstanding_amount).toBe('35.0000');
  });

  it('0062 split-guard still fires on a shrunk parent and passes an exact 4-dp cover', async () => {
    const txId = await insertTx('-100.0001');
    await pool.query(
      `INSERT INTO transaction_splits (transaction_id, recipient_id, amount)
       VALUES ($1, $2, '100.0001')`,
      [txId, recipientId],
    );

    // Shrinking the parent below the split total (beyond the 0.005 tolerance) raises.
    await expect(
      pool.query(`UPDATE transactions SET amount = '-99.99' WHERE id = $1`, [txId]),
    ).rejects.toMatchObject({ code: '23514' });

    // An amount the splits cover exactly (equality, zero slack) passes.
    await pool.query(`UPDATE transactions SET amount = '-100.0001', balance = '1.2345' WHERE id = $1`, [
      txId,
    ]);
    const { rows } = await pool.query(`SELECT amount, balance FROM transactions WHERE id = $1`, [
      txId,
    ]);
    expect(rows[0].amount).toBe('-100.0001');
    expect(rows[0].balance).toBe('1.2345'); // transactions.balance holds 4 dp too now
  });

  it('planned→executed copies round-trip without a precision fork', async () => {
    const { rows: planned } = await pool.query(
      `INSERT INTO planned_transactions (planned_date, amount, memo)
       VALUES ('2026-09-01', '123.4567', $1) RETURNING id, amount`,
      [MARK],
    );
    plannedIds.push(planned[0].id);
    expect(planned[0].amount).toBe('123.4567'); // stored, not rounded to 123.46

    // Copy the planned amount into a real transaction the way an execution does —
    // straight from the stored column — and compare in SQL, where NUMERIC equality
    // is exact.
    const txId = await insertTx(planned[0].amount);
    const { rows } = await pool.query(
      `SELECT t.amount = pt.amount AS symmetric
       FROM transactions t, planned_transactions pt
       WHERE t.id = $1 AND pt.id = $2`,
      [txId, planned[0].id],
    );
    expect(rows[0].symmetric).toBe(true);
  });

  it('holds boundary magnitudes: 14 integer digits at 4 dp', async () => {
    const max = '99999999999999.9999'; // NUMERIC(18,4) upper bound
    const txId = await insertTx('-1.0000', max);
    const { rows } = await pool.query(`SELECT balance FROM transactions WHERE id = $1`, [txId]);
    expect(rows[0].balance).toBe(max);

    const { rows: loan } = await pool.query(
      `INSERT INTO planned_transactions (planned_date, amount, memo, loan_principal)
       VALUES ('2026-09-01', '0.0001', $1, $2) RETURNING loan_principal`,
      [MARK, max],
    );
    const planned = await pool.query(`SELECT id FROM planned_transactions WHERE memo = $1`, [MARK]);
    for (const r of planned.rows) if (!plannedIds.includes(r.id)) plannedIds.push(r.id);
    expect(loan[0].loan_principal).toBe(max);
  });

  // ── Repository guards at storage precision ────────────────────────────────
  // Storage stopped rounding to cents, so the validation/settle paths must
  // compare at the same 4-dp scale. Pre-0088 these three were masked by
  // (15,2) storage rounding the overshoot away; with (18,4) they were live
  // regressions until the guards moved to storage precision with the columns.
  describe('split guards validate at NUMERIC(18,4) storage precision', () => {
    it('rejects a sub-cent over-payment (two 25.0025 payments on a 50.00 split)', async () => {
      const txId = await insertTx('-50.0000');
      const { rows: split } = await pool.query(
        `INSERT INTO transaction_splits (transaction_id, recipient_id, amount)
         VALUES ($1, $2, '50.0000') RETURNING id`,
        [txId, recipientId],
      );
      const splitId = split[0].id;

      await splitRepository.addPayment({ split_id: splitId, amount: 25.0025 });
      // Second identical payment projects 50.0050 > 50.0000 — a cent-precision
      // cap saw ROUND(50.0050, 2) = 50.00 and admitted it.
      await expect(
        splitRepository.addPayment({ split_id: splitId, amount: 25.0025 }),
      ).rejects.toThrow(/exceed split outstanding balance/);

      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS paid FROM split_payments WHERE split_id = $1`,
        [splitId],
      );
      expect(rows[0].paid).toBe('25.0025'); // only the first payment landed
    });

    it('rejects a sub-cent over-allocation on the single-split path', async () => {
      const txId = await insertTx('-100.0000');
      await splitRepository.createSplitAtomic({
        transaction_id: txId, recipient_id: recipientId, amount: 50.0, note: null,
      });
      // 50.0049 projects the split total to 100.0049 > 100.0000; the pre-fix
      // path validated AND stored the raw value while the batch path rounded
      // to cents — both now normalize to 4 dp and compare at 4 dp.
      await expect(
        splitRepository.createSplitAtomic({
          transaction_id: txId, recipient_id: recipientId, amount: 50.0049, note: null,
        }),
      ).rejects.toThrow(/exceeds transaction total/);

      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transaction_splits WHERE transaction_id = $1`,
        [txId],
      );
      expect(rows[0].total).toBe('50.0000');
    });

    it('stores 4-dp batch splits verbatim (no cent rounding) and allocates a 4-dp parent exactly', async () => {
      const txId = await insertTx('-100.0001');
      const created = await splitRepository.createSplitsBatchAtomic({
        transaction_id: txId,
        splits: [
          { recipient_id: recipientId, amount: 50.0 },
          { recipient_id: recipientId, amount: 50.0001 },
        ],
      });
      expect(created.map((s) => s.amount)).toEqual([50, 50.0001]);
      const { rows } = await pool.query(
        `SELECT SUM(ts.amount) = ABS(t.amount) AS exact
         FROM transactions t JOIN transaction_splits ts ON ts.transaction_id = t.id
         WHERE t.id = $1 GROUP BY t.id, t.amount`,
        [txId],
      );
      expect(rows[0].exact).toBe(true); // the batch path used to round 50.0001 → 50.00
    });

    it('auto-settles only on an exact 4-dp cover, and a settled split takes no more payments', async () => {
      const txId = await insertTx('-50.0001');
      const { rows: split } = await pool.query(
        `INSERT INTO transaction_splits (transaction_id, recipient_id, amount)
         VALUES ($1, $2, '50.0001') RETURNING id`,
        [txId, recipientId],
      );
      const splitId = split[0].id;

      // A cent-rounded cover (50.00 vs 50.0001) must NOT settle — the old
      // ROUND(…, 2) comparison froze the 0.0001 residue as "settled" forever.
      await splitRepository.addPayment({ split_id: splitId, amount: 50.0 });
      let state = await pool.query(`SELECT is_settled FROM transaction_splits WHERE id = $1`, [splitId]);
      expect(state.rows[0].is_settled).toBe(false);

      // Paying off the residue reaches the exact amount and settles.
      await splitRepository.addPayment({ split_id: splitId, amount: 0.0001 });
      state = await pool.query(`SELECT is_settled FROM transaction_splits WHERE id = $1`, [splitId]);
      expect(state.rows[0].is_settled).toBe(true);

      // Settled means closed: further payments are rejected (pre-0088 a 0.0001
      // payment died on the positive-amount CHECK by rounding to 0.00; at 4 dp
      // it would have been accepted silently).
      await expect(
        splitRepository.addPayment({ split_id: splitId, amount: 0.0001 }),
      ).rejects.toThrow(/already settled/);
    });
  });
});

// ── Downgrade pre-flight (R4) ───────────────────────────────────────────────
// Runs on its own scratch database (adr109Conversion pattern): downgrading the
// shared harness DB mid-suite would yank the schema out from under the other
// suites. alembic drives the real migration chain end-to-end.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ALEMBIC_BIN = process.env.ALEMBIC_BIN || 'alembic';
const ALEMBIC_CONFIG = path.join(REPO_ROOT, 'config/alembic.ini');
const execFileAsync = promisify(execFile);

function scratchDbName() {
  const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://x/x').pathname.replace(/^\//, '');
  return `${base}_0088down`;
}

function scratchUrl() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://x/x');
  url.pathname = `/${scratchDbName()}`;
  return url.toString();
}

function alembic(...args) {
  return execFileAsync(ALEMBIC_BIN, ['-c', ALEMBIC_CONFIG, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: scratchUrl() },
    timeout: 180_000,
  });
}

describeDb('migration 0088 downgrade pre-flight refuses sub-cent rows', () => {
  /** @type {pg.Client|null} */ let db = null;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${scratchDbName()}`);
    await admin.end();

    db = new pg.Client({ connectionString: scratchUrl() });
    await db.connect();
    // Same preflight db-migrate performs: modern revision ids overflow the
    // VARCHAR(32) alembic would otherwise create.
    await db.query(
      'CREATE TABLE alembic_version (version_num VARCHAR(64) NOT NULL, CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))',
    );
    await alembic('upgrade', 'head');
  }, 240_000);

  afterAll(async () => {
    if (db) await db.end();
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`);
    await admin.end();
  });

  it('refuses with a curated row list while a sub-cent split exists, then downgrades clean', async () => {
    const { rows: rec } = await db.query(
      `INSERT INTO recipients (name, normalized_name) VALUES ('r0088', 'r0088') RETURNING id`,
    );
    const { rows: tx } = await db.query(
      `INSERT INTO transactions (date, amount, memo, currency, recipient_id)
       VALUES ('2026-08-01', '-1.0000', 'sub-cent', 'EUR', $1) RETURNING id`,
      [rec[0].id],
    );
    const { rows: split } = await db.query(
      `INSERT INTO transaction_splits (transaction_id, recipient_id, amount)
       VALUES ($1, $2, '0.0040') RETURNING id`,
      [tx[0].id, rec[0].id],
    );

    // Legal at (18,4); rounds to 0.00 under the downgrade's USING round(…, 2).
    let err = null;
    try {
      await alembic('downgrade', '-1');
    } catch (e) {
      err = e;
    }
    expect(err, 'expected the 0088 downgrade pre-flight to refuse').not.toBeNull();
    const output = `${err.stderr ?? ''}\n${err.stdout ?? ''}\n${err.message ?? ''}`;
    expect(output).toMatch(/0088 downgrade refused/);
    expect(output).toMatch(new RegExp(`transaction_splits id=${split[0].id} amount=0\\.0040`));

    // Refused BEFORE any DDL: still at 0088, columns still (18,4).
    const { rows: ver } = await db.query(`SELECT version_num FROM alembic_version`);
    expect(ver[0].version_num).toBe('0088_money_precision_alignment');
    const { rows: narrow } = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND numeric_precision = 15 AND numeric_scale = 2`,
    );
    expect(narrow[0].n).toBe(0);

    // Clear the offending row exactly as the message instructs; the downgrade
    // then completes and re-narrows everything.
    await db.query(`DELETE FROM transaction_splits WHERE id = $1`, [split[0].id]);
    await alembic('downgrade', '-1');
    const { rows: renarrowed } = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND numeric_precision = 15 AND numeric_scale = 2`,
    );
    expect(renarrowed[0].n).toBe(32);
  }, 240_000);
});
