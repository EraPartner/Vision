/**
 * Real-Postgres tests for the import pipeline COMMIT phase.
 *
 * The mock suite (importPipeline.test.js) choreographs SQL results on a fake
 * client, so it asserts the statements we wrote rather than the rows Postgres
 * actually returns. Commit is the phase that decides which real bank rows
 * enter the ledger and which are silently discarded as duplicates, and its
 * verdicts depend on genuine NUMERIC equality, genuine NULL semantics, the
 * partial unique index over `tx_hash`, and the visibility of rows inserted
 * earlier in the same transaction. All four are invisible to a mock.
 *
 * This suite exists specifically because the commit phase was rewritten from a
 * per-row loop (dup-check SELECT + SAVEPOINT + INSERT + staging UPDATE +
 * RELEASE, five round trips per row) to a per-chunk plan (two pre-load SELECTs
 * + one multi-row INSERT + batched staging UPDATEs). Every semantic the old
 * loop got from the database — and one it got from three-valued logic almost
 * by accident — is pinned here against the real schema.
 *
 * Isolation: per-test targeted DELETEs of the corpus this suite owns.
 * commitBatch opens its own transactions, so a wrapping transaction would
 * nest; and the point of the suite is what survives COMMIT.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import { commitBatch } from '../src/services/importPipeline/commit.js';
import { closePool } from '../src/database/connection.js';

// The post-commit fan-out (MV refresh, planned-payment auto-link) is not what
// this suite measures and would need materialized views this database does not
// have. Both are already try/caught inside commitBatch; stubbing them keeps the
// assertions about commit itself.
vi.mock('../src/services/aggregationRefresh.js', () => ({
  refreshAggregations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/services/plannedMatchService.js', () => ({
  autoLinkTransactions: vi.fn().mockResolvedValue({ autoLinkedCount: 0 }),
}));

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;

/** Ids seeded by `seedFixtures()`. */
const fx = {};

async function seedFixtures() {
  const { rows: cat } = await pool.query(
    `INSERT INTO categories (general, detail) VALUES ('Food', 'Groceries') RETURNING id`,
  );
  fx.categoryId = cat[0].id;
  const { rows: rec } = await pool.query(
    `INSERT INTO recipients (name, normalized_name, default_category_id)
     VALUES ('DELHAIZE', 'delhaize', $1) RETURNING id`,
    [fx.categoryId],
  );
  fx.recipientId = rec[0].id;
  const { rows: rec2 } = await pool.query(
    `INSERT INTO recipients (name, normalized_name) VALUES ('COLRUYT', 'colruyt') RETURNING id`,
  );
  fx.otherRecipientId = rec2[0].id;
}

async function wipe() {
  await pool.query(`DELETE FROM transactions`);
  await pool.query(`DELETE FROM import_staging_rows`);
  await pool.query(`DELETE FROM import_batches`);
  await pool.query(`DELETE FROM recipients`);
  await pool.query(`DELETE FROM categories`);
  await pool.query(`DELETE FROM accounts`);
}

/** Create an import batch and return its id. */
async function newBatch() {
  const { rows } = await pool.query(
    `INSERT INTO import_batches (adapter_name, status, rows_total)
     VALUES ('belfius', 'awaiting_review', 0) RETURNING id`,
  );
  return rows[0].id;
}

/**
 * Stage one 'matched' row. Defaults describe an ordinary resolved bank row;
 * every field the dup check reads is overridable.
 */
async function stageRow(batchId, rowIndex, over = {}) {
  const r = {
    tx_date: '2026-03-04',
    bank_account: 'BE68 5390 0754 7034',
    recipient_raw: 'DELHAIZE 1234',
    memo: 'CARD PAYMENT - CURRENT',
    amount: '-42.5000',
    currency: 'EUR',
    balance: '1000.00',
    comment: null,
    tx_hash: null,
    resolved_recipient_id: fx.recipientId,
    user_override_recipient_id: null,
    matched_pattern_id: null,
    override_category_id: null,
    ...over,
  };
  const { rows } = await pool.query(
    `INSERT INTO import_staging_rows
       (batch_id, row_index, status, tx_date, bank_account, recipient_raw, memo, amount,
        currency, balance, comment, tx_hash, resolved_recipient_id,
        user_override_recipient_id, matched_pattern_id, override_category_id)
     VALUES ($1, $2, 'matched', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      batchId, rowIndex, r.tx_date, r.bank_account, r.recipient_raw, r.memo, r.amount,
      r.currency, r.balance, r.comment, r.tx_hash, r.resolved_recipient_id,
      r.user_override_recipient_id, r.matched_pattern_id, r.override_category_id,
    ],
  );
  return rows[0].id;
}

/** Insert a canonical transaction directly (never through the pipeline). */
async function insertTxn(over = {}) {
  const t = {
    date: '2026-03-04',
    bank_account: 'BE68 5390 0754 7034',
    recipient_id: fx.recipientId,
    category_id: null,
    amount: '-42.5000',
    currency: 'EUR',
    memo: 'CARD PAYMENT - CURRENT',
    comment: null,
    import_batch_id: null,
    tx_hash: null,
    is_active: true,
    ...over,
  };
  const { rows } = await pool.query(
    `INSERT INTO transactions
       (date, bank_account, recipient_id, category_id, amount, currency, memo, comment,
        import_batch_id, tx_hash, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      t.date, t.bank_account, t.recipient_id, t.category_id, t.amount, t.currency,
      t.memo, t.comment, t.import_batch_id, t.tx_hash, t.is_active,
    ],
  );
  return rows[0].id;
}

/** Staging statuses of a batch, ordered by row_index. */
async function stagingStatuses(batchId) {
  const { rows } = await pool.query(
    `SELECT row_index, status, error_message FROM import_staging_rows
      WHERE batch_id = $1 ORDER BY row_index`,
    [batchId],
  );
  return rows;
}

async function batchCounters(batchId) {
  const { rows } = await pool.query(
    `SELECT status, rows_imported, rows_duplicate, rows_error FROM import_batches WHERE id = $1`,
    [batchId],
  );
  return rows[0];
}

async function committedTxns(batchId) {
  const { rows } = await pool.query(
    `SELECT id, to_char(date,'YYYY-MM-DD') AS date, amount::text AS amount, memo,
            bank_account, recipient_id, category_id, currency, balance::text AS balance,
            tx_hash, matched_pattern_id
       FROM transactions WHERE import_batch_id = $1 ORDER BY id`,
    [batchId],
  );
  return rows;
}

describeDb('importPipeline commit (real Postgres)', () => {
  beforeAll(acquireDbSuiteLock, 180_000);

  beforeEach(async () => {
    await wipe();
    await seedFixtures();
  });

  afterEach(async () => {
    await wipe();
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  // ── the core dedup verdicts ───────────────────────────────────────────────

  it('marks the second of an intra-chunk identical pair as a duplicate', async () => {
    const batchId = await newBatch();
    await stageRow(batchId, 0);
    await stageRow(batchId, 1);

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1, duplicates: 1, errors: 0, autoLinkedCount: 0,
    });

    expect(await committedTxns(batchId)).toHaveLength(1);
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual(['committed', 'duplicate']);
    const counters = await batchCounters(batchId);
    expect(counters.rows_imported).toBe(1);
    expect(counters.rows_duplicate).toBe(1);
    expect(counters.rows_error).toBe(0);
  });

  it('keeps both same-batch rows whose field tuple is identical but tx_hash differs', async () => {
    // The regression class this dedup was hardened against: two same-day card
    // payments carry the identical date/amount/recipient/memo/account (Revolut
    // stamps one memo on every card payment) and differ only by the running
    // balance folded into tx_hash. Collapsing them silently drops a REAL
    // transaction.
    const batchId = await newBatch();
    await stageRow(batchId, 0, { tx_hash: 'hash-a', balance: '1000.00' });
    await stageRow(batchId, 1, { tx_hash: 'hash-b', balance: '957.50' });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 2, duplicates: 0, errors: 0, autoLinkedCount: 0,
    });

    const txns = await committedTxns(batchId);
    expect(txns).toHaveLength(2);
    expect(txns.map((t) => t.tx_hash).sort()).toEqual(['hash-a', 'hash-b']);
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual(['committed', 'committed']);
  });

  it('treats a cross-batch field duplicate as a duplicate even when both carry a tx_hash', async () => {
    // The hash exemption is scoped to THIS batch on purpose: tx_hash is a hash
    // of the source-format row, so a re-import from another export format
    // carries a different hash for the same transaction. Without the batch
    // scope, "re-import is a no-op" would break.
    const priorBatch = await newBatch();
    await insertTxn({ import_batch_id: priorBatch, tx_hash: 'bank-format-hash' });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { tx_hash: 'vision-format-hash' });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0, duplicates: 1, errors: 0, autoLinkedCount: 0,
    });
    expect(await committedTxns(batchId)).toHaveLength(0);
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual(['duplicate']);
  });

  it('does not dedup across bank accounts', async () => {
    const batchId = await newBatch();
    await stageRow(batchId, 0, { bank_account: 'BE68 5390 0754 7034' });
    await stageRow(batchId, 1, { bank_account: 'BE11 2222 3333 4444' });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 2, duplicates: 0, errors: 0, autoLinkedCount: 0,
    });
  });

  it('deduplicates a repeated tx_hash inside the same chunk before the field check', async () => {
    const batchId = await newBatch();
    // Field tuples differ (different memo), so ONLY the hash can catch this.
    await stageRow(batchId, 0, { tx_hash: 'same-hash', memo: 'A' });
    await stageRow(batchId, 1, { tx_hash: 'same-hash', memo: 'B' });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1, duplicates: 1, errors: 0, autoLinkedCount: 0,
    });
    expect(await committedTxns(batchId)).toHaveLength(1);
  });

  it('marks a row whose tx_hash already exists on an INACTIVE transaction as a duplicate', async () => {
    // uniq_transactions_tx_hash is partial on `tx_hash IS NOT NULL` with no
    // is_active predicate, so a soft-deleted row still blocks the insert. The
    // field check (is_active = true) cannot see it — the hash check must.
    await insertTxn({ tx_hash: 'seen-before', is_active: false, memo: 'ARCHIVED' });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { tx_hash: 'seen-before' });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0, duplicates: 1, errors: 0, autoLinkedCount: 0,
    });
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual(['duplicate']);
  });

  it('applies the hash exemption only when the STORED row also carries a hash', async () => {
    // The exemption needs a hash on BOTH sides (`t.tx_hash IS NOT NULL AND
    // $6 IS NOT NULL AND t.tx_hash <> $6`). A same-batch row committed without
    // one therefore still field-matches a later hashed row — an asymmetry a
    // symmetric "hashes differ ⇒ distinct" rewrite would silently lose.
    const batchId = await newBatch();
    await stageRow(batchId, 0, { tx_hash: null });
    await stageRow(batchId, 1, { tx_hash: 'later-hash' });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1, duplicates: 1, errors: 0, autoLinkedCount: 0,
    });
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual(['committed', 'duplicate']);
  });

  it('trims the incoming memo with JS rules and the stored memo with SQL rules', async () => {
    // The dup check compares `COALESCE(TRIM(t.memo), '')` — SQL TRIM strips
    // ASCII SPACES only — against the incoming `(memo ?? '').trim()`, which
    // strips ALL whitespace. A trailing space collapses; a trailing TAB does
    // not, because the stored side keeps it. Pinned as-is: this asymmetry is
    // pre-existing behaviour, not something this rewrite decided.
    const spaceBatch = await newBatch();
    await stageRow(spaceBatch, 0, { memo: 'COFFEE ' });
    await stageRow(spaceBatch, 1, { memo: 'COFFEE ' });
    expect(await commitBatch({ batchId: spaceBatch })).toEqual({
      imported: 1, duplicates: 1, errors: 0, autoLinkedCount: 0,
    });

    const tabBatch = await newBatch();
    await stageRow(tabBatch, 0, { memo: 'TEA\t', bank_account: 'BE00 OTHER' });
    await stageRow(tabBatch, 1, { memo: 'TEA\t', bank_account: 'BE00 OTHER' });
    expect(await commitBatch({ batchId: tabBatch })).toEqual({
      imported: 2, duplicates: 0, errors: 0, autoLinkedCount: 0,
    });
  });

  it('does not field-match an orphaned hashed row (import_batch_id NULL, differing hash)', async () => {
    // transactions_import_batch_id_fkey is ON DELETE SET NULL, so deleting an
    // import batch leaves its rows with a tx_hash and no import_batch_id. In
    // the dup-check WHERE, `t.import_batch_id = $7` is then NULL, the whole
    // exemption conjunct is NULL, and `NOT NULL` is NULL — so the candidate is
    // filtered out and the incoming row is NOT a duplicate. Pinning the actual
    // three-valued behaviour rather than the comment's "this batch only".
    await insertTxn({ import_batch_id: null, tx_hash: 'orphaned-hash' });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { tx_hash: 'incoming-hash' });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1, duplicates: 0, errors: 0, autoLinkedCount: 0,
    });
  });

  it('field-matches an orphaned UNHASHED row (the manual-entry case)', async () => {
    // Same orphan, no tx_hash: `t.tx_hash IS NOT NULL` is FALSE, the exemption
    // collapses to FALSE, and the candidate matches normally.
    await insertTxn({ import_batch_id: null, tx_hash: null });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { tx_hash: 'incoming-hash' });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0, duplicates: 1, errors: 0, autoLinkedCount: 0,
    });
  });

  it('compares amounts numerically, not textually', async () => {
    // transactions.amount is NUMERIC(18,4), import_staging_rows.amount is
    // NUMERIC(20,4): the dup key must not depend on the rendered scale.
    await insertTxn({ amount: '-42.5' });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { amount: '-42.5000' });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0, duplicates: 1, errors: 0, autoLinkedCount: 0,
    });
  });

  it('ignores an inactive transaction when field-deduping', async () => {
    await insertTxn({ is_active: false });

    const batchId = await newBatch();
    await stageRow(batchId, 0);

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1, duplicates: 0, errors: 0, autoLinkedCount: 0,
    });
  });

  // ── failure isolation ─────────────────────────────────────────────────────

  it('isolates a poison row: the rest of the chunk lands and only it is failed', async () => {
    // resolved_recipient_id has no FK on import_staging_rows, so a stale id
    // survives staging and violates transactions_recipient_id_fkey on commit.
    const batchId = await newBatch();
    await stageRow(batchId, 0, { memo: 'GOOD ONE' });
    await stageRow(batchId, 1, { memo: 'POISON', resolved_recipient_id: 987654321 });
    await stageRow(batchId, 2, { memo: 'GOOD TWO' });

    const result = await commitBatch({ batchId });
    expect(result).toEqual({ imported: 2, duplicates: 0, errors: 1, autoLinkedCount: 0 });

    const txns = await committedTxns(batchId);
    expect(txns.map((t) => t.memo).sort()).toEqual(['GOOD ONE', 'GOOD TWO']);

    const staging = await stagingStatuses(batchId);
    expect(staging.map((r) => r.status)).toEqual(['committed', 'error', 'committed']);
    expect(staging[1].error_message).toBeTruthy();

    const counters = await batchCounters(batchId);
    expect(counters.rows_imported).toBe(2);
    expect(counters.rows_duplicate).toBe(0);
    expect(counters.rows_error).toBe(1);
  });

  it('does not let a poison row change the verdict of a row that follows it', async () => {
    // The batched planner speculates that every planned insert lands, so a
    // failed insert could otherwise make the NEXT identical row look like a
    // duplicate of a transaction that never existed. The per-row replay is
    // what makes both rows fail instead.
    const batchId = await newBatch();
    await stageRow(batchId, 0, { resolved_recipient_id: 987654321 });
    await stageRow(batchId, 1, { resolved_recipient_id: 987654321 });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0, duplicates: 0, errors: 2, autoLinkedCount: 0,
    });
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual(['error', 'error']);
  });

  it('keeps inserted + duplicate + failed = total across a mixed batch', async () => {
    await insertTxn({ memo: 'ALREADY THERE' });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { memo: 'ALREADY THERE' });            // cross-batch dup
    await stageRow(batchId, 1, { memo: 'FRESH A' });                   // insert
    await stageRow(batchId, 2, { memo: 'FRESH A' });                   // intra-chunk dup
    await stageRow(batchId, 3, { memo: 'FRESH B', resolved_recipient_id: 987654321 }); // error
    await stageRow(batchId, 4, { memo: 'FRESH C', tx_hash: 'x1' });    // insert
    await stageRow(batchId, 5, { memo: 'FRESH D', tx_hash: 'x1' });    // hash dup

    const result = await commitBatch({ batchId });
    expect(result.imported + result.duplicates + result.errors).toBe(6);
    expect(result).toEqual({ imported: 2, duplicates: 3, errors: 1, autoLinkedCount: 0 });

    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual(
      ['duplicate', 'committed', 'duplicate', 'error', 'committed', 'duplicate'],
    );
    const counters = await batchCounters(batchId);
    expect(counters.rows_imported + counters.rows_duplicate + counters.rows_error).toBe(6);
  });

  // ── written-column fidelity ───────────────────────────────────────────────

  it('writes the same columns the per-row insert wrote', async () => {
    const batchId = await newBatch();
    await stageRow(batchId, 0, {
      comment: 'holiday',
      currency: null,          // must default to EUR, never NULL
      balance: '1234.56',
      tx_hash: 'h-cols',
    });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1, duplicates: 0, errors: 0, autoLinkedCount: 0,
    });

    const [t] = await committedTxns(batchId);
    expect(t).toMatchObject({
      date: '2026-03-04',
      amount: '-42.5000',
      memo: 'CARD PAYMENT - CURRENT',
      bank_account: 'BE68 5390 0754 7034',
      recipient_id: fx.recipientId,
      // ADR-046: no per-row override → the recipient's default category.
      category_id: fx.categoryId,
      currency: 'EUR',
      balance: '1234.56',
      tx_hash: 'h-cols',
    });
  });

  it('prefers the row override over the recipient default and clears matched_pattern_id', async () => {
    const { rows: cat } = await pool.query(
      `INSERT INTO categories (general, detail) VALUES ('Leisure', 'Travel') RETURNING id`,
    );
    const batchId = await newBatch();
    await stageRow(batchId, 0, {
      override_category_id: cat[0].id,
      user_override_recipient_id: fx.otherRecipientId,
    });

    expect((await commitBatch({ batchId })).imported).toBe(1);
    const [t] = await committedTxns(batchId);
    expect(t.category_id).toBe(cat[0].id);
    expect(t.recipient_id).toBe(fx.otherRecipientId);
    expect(t.matched_pattern_id).toBeNull();
  });

  // ── chunking ──────────────────────────────────────────────────────────────

  it('dedups across chunk boundaries (chunk size is 1000)', async () => {
    const batchId = await newBatch();
    const rows = [];
    for (let i = 0; i < 1002; i++) {
      // Row 1001 lands in the SECOND chunk and repeats row 0 exactly, so its
      // duplicate verdict can only come from the previous chunk's committed
      // rows being re-read by the next chunk's pre-load.
      rows.push(stageRow(batchId, i, { memo: i === 1001 ? 'ROW 0' : `ROW ${i}` }));
    }
    await Promise.all(rows);

    const progress = [];
    const result = await commitBatch({ batchId, onProgress: (p) => progress.push(p) });
    expect(result).toEqual({ imported: 1001, duplicates: 1, errors: 0, autoLinkedCount: 0 });
    expect(await committedTxns(batchId)).toHaveLength(1001);

    // SSE progress: an initial 0/total, then one event per chunk.
    expect(progress[0]).toEqual({ phase: 'committing', current: 0, total: 1002 });
    expect(progress.at(-1)).toEqual({
      phase: 'committing', current: 1002, total: 1002, imported: 1001, duplicates: 1, errors: 0,
    });
    expect(progress).toHaveLength(3);
  });

  it('returns zeroes and touches nothing for a batch with no matched rows', async () => {
    const batchId = await newBatch();
    expect(await commitBatch({ batchId })).toEqual({
      imported: 0, duplicates: 0, errors: 0, autoLinkedCount: 0,
    });
    expect((await batchCounters(batchId)).status).toBe('committing');
  });
});
