/**
 * Real-Postgres tests for portfolio import ROLLBACK.
 *
 * Rollback hard-deletes real trades, so the property under test is not "it is
 * fast" but "it deletes EXACTLY the rows this batch created, and nothing else".
 * That property is unprovable against a mock: it depends on the actual
 * `import_batch_id` stamp written by the commit pipeline (migration 0086), on
 * the two id sequences (`transactions` vs `portfolio_transactions`) genuinely
 * being independent, and on rows committed before 0086 (import_batch_id NULL)
 * still being reachable through the old per-id path.
 *
 * The decoys are deliberate:
 *   - a SECOND committed batch, so a scope-widened DELETE (missing/wrong WHERE)
 *     shows up as collateral damage rather than passing;
 *   - a manually-created lot with NO batch stamp, interleaved in the same id
 *     range;
 *   - a ledger `transactions` row whose id is FORCED (via setval) to equal a
 *     portfolio lot id of the OTHER batch — the exact shape of the pre-ffb13d7
 *     cross-table id-confusion bug, where rolling back a brokerage batch
 *     hard-deleted an unrelated trade that happened to share a cash row's number.
 *
 * The per-row loop this replaced also passes plain "the right rows are gone"
 * assertions, so exactness alone does not discriminate between old and new. The
 * statement-count assertions do: a 25-trade batch must cost ONE portfolio DELETE
 * (the loop cost 25).
 *
 * Isolation: per-test targeted DELETEs of the corpus this suite owns.
 * commitBatch/rollbackBatch open their own transactions, so a wrapping
 * transaction would nest.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';

// Passthrough spy on the shared query helper: every statement the pipeline and
// the repositories issue still hits the real database, but the call log is
// available for the statement-count assertions.
vi.mock('../src/database/connection.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    query: vi.fn((/** @type {any[]} */ ...args) => actual.query(...args)),
  };
});

import { query, closePool } from '../src/database/connection.js';
import { commitBatch } from '../src/services/portfolioImportPipeline/commit.js';
import { rollbackBatch } from '../src/services/portfolioImportBatchService.js';
import { __resetPortfolioTransactionSchemaCache } from '../src/repositories/portfolioTransactionRepository.js';

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;

/** Ids seeded by `seedFixtures()`. */
const fx = {};

async function seedFixtures() {
  const { rows: acct } = await pool.query(
    `INSERT INTO accounts (name, display_name) VALUES ('IBKR-ROLLBACK', 'IBKR-ROLLBACK') RETURNING id`,
  );
  fx.accountId = acct[0].id;
  const { rows: inv } = await pool.query(
    `INSERT INTO investments (name, symbol, asset_class, currency)
     VALUES ('Rollback Test Corp', 'RBT', 'stock', 'EUR') RETURNING id`,
  );
  fx.investmentId = inv[0].id;
  const { rows: rec } = await pool.query(
    `INSERT INTO recipients (name, normalized_name) VALUES ('BROKER CASH', 'broker cash') RETURNING id`,
  );
  fx.recipientId = rec[0].id;
}

async function wipe() {
  await pool.query(`DELETE FROM portfolio_transactions`);
  await pool.query(`DELETE FROM transactions`);
  await pool.query(`DELETE FROM portfolio_import_staging_rows`);
  await pool.query(`DELETE FROM portfolio_import_batches`);
  await pool.query(`DELETE FROM investments`);
  await pool.query(`DELETE FROM recipients`);
  await pool.query(`DELETE FROM accounts`);
}

/**
 * Create a portfolio import batch.
 * @param {{ brokerage?: boolean, withAccount?: boolean }} [opts]
 */
async function newBatch({ brokerage = false, withAccount = true } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_import_batches
       (adapter_name, status, rows_total, account_id, is_brokerage, default_asset_class)
     VALUES ('generic', 'awaiting_review', 0, $1, $2, 'stock') RETURNING id`,
    [withAccount ? fx.accountId : null, brokerage],
  );
  return Number(rows[0].id);
}

/** Stage one 'matched' TRADE row (route defaults to portfolio). */
async function stageTrade(batchId, rowIndex, over = {}) {
  const r = {
    tx_date: `2026-03-${String((rowIndex % 28) + 1).padStart(2, '0')}`,
    type: 'buy',
    type_raw: 'buy',
    route: 'portfolio',
    units: 3,
    price_per_unit: 100,
    amount: 300,
    currency: 'EUR',
    ...over,
  };
  const { rows } = await pool.query(
    `INSERT INTO portfolio_import_staging_rows
       (batch_id, row_index, status, tx_date, type, type_raw, route, units, price_per_unit,
        amount, currency, resolved_investment_id)
     VALUES ($1, $2, 'matched', $3, $4::portfolio_txn_type, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [batchId, rowIndex, r.tx_date, r.type, r.type_raw, r.route, r.units, r.price_per_unit,
      r.amount, r.currency, fx.investmentId],
  );
  return rows[0].id;
}

/**
 * Land one brokerage CASH row in the state a successful commit leaves behind: a
 * `transactions` row on the sleeve plus a `committed` staging row whose
 * `route='cash'` and whose `committed_txn_id` is that TRANSACTIONS id.
 *
 * Seeded rather than driven through `commitBatch` on purpose: these fixtures
 * FORCE the ledger id (setval) to collide with a portfolio lot id, which the
 * real commit path can never do, and the routing invariant under test is about
 * the ID SHAPE, not about who wrote it. The commit path itself (which now
 * supplies `recipient_id` — NOT NULL since migration 0001) is exercised
 * end-to-end in portfolioImportBrokerageCash.db.test.js, including rollback of
 * rows it actually committed.
 *
 * @param {number} batchId
 * @param {number} rowIndex
 * @param {number} [ledgerId] force this transactions.id (collision fixtures)
 */
async function commitCashRow(batchId, rowIndex, ledgerId) {
  if (ledgerId != null) {
    await pool.query(`SELECT setval(pg_get_serial_sequence('transactions', 'id'), $1, false)`, [ledgerId]);
  }
  const { rows: tx } = await pool.query(
    `INSERT INTO transactions (date, amount, currency, memo, account_id, recipient_id, is_active)
     VALUES ('2026-02-01', 1000, 'EUR', $1, $2, $3, true) RETURNING id`,
    [`CASH ROW ${rowIndex}`, fx.accountId, fx.recipientId],
  );
  const committedId = Number(tx[0].id);
  await pool.query(
    `INSERT INTO portfolio_import_staging_rows
       (batch_id, row_index, status, tx_date, type_raw, route, amount, currency, note, committed_txn_id)
     VALUES ($1, $2, 'committed', '2026-02-01', 'deposit', 'cash', 1000, 'EUR', $3, $4)`,
    [batchId, rowIndex, `CASH ROW ${rowIndex}`, committedId],
  );
  return committedId;
}

/** A lot created outside any import — the "someone else's trade" decoy. */
async function manualLot(date) {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_transactions
       (investment_id, type, date, amount, units, price_per_unit, currency, account_id)
     VALUES ($1, 'buy', $2, 500, 5, 100, 'EUR', $3) RETURNING id`,
    [fx.investmentId, date, fx.accountId],
  );
  return Number(rows[0].id);
}

/** Lot ids currently stamped with a batch. */
async function lotIdsOfBatch(batchId) {
  const { rows } = await pool.query(
    `SELECT id FROM portfolio_transactions WHERE import_batch_id = $1 ORDER BY id`,
    [batchId],
  );
  return rows.map((r) => Number(r.id));
}

async function allLotIds() {
  const { rows } = await pool.query(`SELECT id FROM portfolio_transactions ORDER BY id`);
  return rows.map((r) => Number(r.id));
}

async function allLedgerIds() {
  const { rows } = await pool.query(`SELECT id FROM transactions ORDER BY id`);
  return rows.map((r) => Number(r.id));
}

/** Statements issued through the shared helper matching `re`, since the last clear. */
function statementsMatching(re) {
  return query.mock.calls.map((c) => String(c[0])).filter((sql) => re.test(sql));
}

describeDb('portfolio import rollback — exact scope (real Postgres)', () => {
  beforeAll(acquireDbSuiteLock, 180_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetPortfolioTransactionSchemaCache();
    await wipe();
    await seedFixtures();
  });

  afterAll(async () => {
    if (!pool) return;
    await wipe();
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it('stamps import_batch_id on every lot the commit path creates', async () => {
    const batchId = await newBatch();
    for (let i = 0; i < 4; i++) await stageTrade(batchId, i);

    const res = await commitBatch({ batchId });
    expect(res.imported).toBe(4);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM portfolio_transactions WHERE import_batch_id = $1`,
      [batchId],
    );
    expect(rows[0].n).toBe(4);
    // Manual lots stay unstamped — the stamp means "this import made it".
    await manualLot('2026-05-05');
    const { rows: nulls } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM portfolio_transactions WHERE import_batch_id IS NULL`,
    );
    expect(nulls[0].n).toBe(1);
  });

  it('deletes exactly the batch\'s rows: a second batch, a manual lot and a colliding ledger id all survive', async () => {
    // ── Batch B commits first; its lot ids are the collision targets. ──
    const batchB = await newBatch();
    for (let i = 0; i < 3; i++) await stageTrade(batchB, i, { amount: 900, units: 9, price_per_unit: 100 });
    expect((await commitBatch({ batchId: batchB })).imported).toBe(3);
    const bLots = await lotIdsOfBatch(batchB);
    expect(bLots).toHaveLength(3);

    // ── A manual lot with no stamp, in the same id range. ──
    const decoyLot = await manualLot('2026-04-04');

    // ── Batch A: brokerage, trades + one cash row whose ledger id is FORCED to
    // equal one of batch B's lot ids. This is the pre-ffb13d7 collision: rolling
    // back A by feeding that id to the portfolio hard-delete would take out B's
    // unrelated trade of the same number. ──
    const collidingId = bLots[0];
    const batchA = await newBatch({ brokerage: true });
    for (let i = 1; i <= 5; i++) await stageTrade(batchA, i, { amount: 300 + i, units: 3, price_per_unit: (300 + i) / 3 });
    const commitA = await commitBatch({ batchId: batchA });
    expect(commitA.imported).toBe(5);
    const cashId = await commitCashRow(batchA, 0, collidingId);

    const aLots = await lotIdsOfBatch(batchA);
    expect(aLots).toHaveLength(5);
    expect(cashId).toBe(collidingId);       // the collision actually happened
    expect(bLots).toContain(collidingId);
    expect(await allLedgerIds()).toEqual([collidingId]);

    // ── Roll back A. ──
    const res = await rollbackBatch(batchA);
    expect(res).toEqual({ deleted: 6 }); // 5 trades + 1 cash row

    const remaining = await allLotIds();
    // Exactly B's three lots plus the manual decoy — including the lot whose id
    // equalled the deleted cash row's id.
    expect(remaining).toEqual([...bLots, decoyLot].sort((a, b) => a - b));
    expect(remaining).toContain(collidingId);
    expect(await allLedgerIds()).toEqual([]);

    const { rows: status } = await pool.query(
      `SELECT status FROM portfolio_import_batches WHERE id = $1`, [batchA],
    );
    expect(status[0].status).toBe('aborted');
  });

  it('rolls back rows committed BEFORE the migration (import_batch_id IS NULL)', async () => {
    const batchB = await newBatch();
    for (let i = 0; i < 2; i++) await stageTrade(batchB, i, { amount: 700, units: 7, price_per_unit: 100 });
    await commitBatch({ batchId: batchB });
    const bLots = await lotIdsOfBatch(batchB);

    const legacy = await newBatch();
    for (let i = 0; i < 4; i++) await stageTrade(legacy, i, { amount: 400 + i, units: 4, price_per_unit: (400 + i) / 4 });
    await commitBatch({ batchId: legacy });
    const legacyLots = await lotIdsOfBatch(legacy);
    expect(legacyLots).toHaveLength(4);

    // Simulate a batch committed before 0086 applied: the lots exist and the
    // staging rows still point at them, but nothing is stamped.
    await pool.query(
      `UPDATE portfolio_transactions SET import_batch_id = NULL WHERE import_batch_id = $1`,
      [legacy],
    );

    const res = await rollbackBatch(legacy);
    expect(res).toEqual({ deleted: 4 });
    expect(await allLotIds()).toEqual(bLots); // the stamped batch is untouched
  });

  it('rolls back a mixed-vintage batch exactly once per row', async () => {
    const batchId = await newBatch();
    for (let i = 0; i < 4; i++) await stageTrade(batchId, i, { amount: 100 + i, units: 1, price_per_unit: 100 + i });
    await commitBatch({ batchId });
    const lots = await lotIdsOfBatch(batchId);
    expect(lots).toHaveLength(4);

    // Half the batch predates the stamp.
    await pool.query(
      `UPDATE portfolio_transactions SET import_batch_id = NULL WHERE id = ANY($1::int[])`,
      [lots.slice(0, 2)],
    );

    const res = await rollbackBatch(batchId);
    expect(res).toEqual({ deleted: 4 }); // no double counting
    expect(await allLotIds()).toEqual([]);
  });

  it('never routes a cash id into the portfolio table, nor a trade id into the ledger', async () => {
    const batchId = await newBatch({ brokerage: true });
    await stageTrade(batchId, 1);
    await commitBatch({ batchId });
    await commitCashRow(batchId, 0);

    vi.clearAllMocks();
    await rollbackBatch(batchId);

    // Cash leaves through `transactions` only…
    const ledgerDeletes = statementsMatching(/DELETE FROM transactions\b/);
    expect(ledgerDeletes).toHaveLength(1);
    expect(ledgerDeletes[0]).toContain('ANY($1::int[])');
    // …and the portfolio DELETE is keyed on the batch, never on an id list.
    const lotDeletes = statementsMatching(/DELETE FROM portfolio_transactions(_base)?\b/);
    expect(lotDeletes).toHaveLength(1);
    expect(lotDeletes[0]).toContain('import_batch_id = $1');
  });

  // ── One statement, not N ────────────────────────────────────────────────

  it('costs ONE portfolio DELETE for a 25-row batch (the per-row loop cost 25)', async () => {
    const batchId = await newBatch();
    for (let i = 0; i < 25; i++) {
      await stageTrade(batchId, i, { amount: 100 + i, units: 1, price_per_unit: 100 + i });
    }
    expect((await commitBatch({ batchId })).imported).toBe(25);

    vi.clearAllMocks();
    const res = await rollbackBatch(batchId);

    expect(res).toEqual({ deleted: 25 });
    expect(statementsMatching(/DELETE FROM portfolio_transactions(_base)?\b/)).toHaveLength(1);
    // No per-row DELETE survives anywhere in the rollback path (the marker of
    // the old loop; the surviving `WHERE id = $1` is markBatchAborted's UPDATE).
    expect(statementsMatching(/DELETE FROM \w+ WHERE id = \$1/)).toHaveLength(0);
    expect(await allLotIds()).toEqual([]);
  });

  it('still pays one statement per row ONLY for the un-stamped fallback', async () => {
    const batchId = await newBatch();
    for (let i = 0; i < 5; i++) {
      await stageTrade(batchId, i, { amount: 200 + i, units: 2, price_per_unit: (200 + i) / 2 });
    }
    await commitBatch({ batchId });
    await pool.query(`UPDATE portfolio_transactions SET import_batch_id = NULL`);

    vi.clearAllMocks();
    const res = await rollbackBatch(batchId);

    expect(res).toEqual({ deleted: 5 });
    // 1 bulk (matches nothing) + 5 fallback deletes — the pre-migration cost,
    // paid only by pre-migration rows.
    expect(statementsMatching(/DELETE FROM portfolio_transactions(_base)?\b/)).toHaveLength(6);
  });
});
