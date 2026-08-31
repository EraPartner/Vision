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

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { commitBatch } from "../src/services/importPipeline/commit.js";
import { transactionRepository } from "../src/repositories/transactionRepository.js";
import { closePool } from "../src/database/connection.js";

// The post-commit fan-out (MV refresh, planned-payment auto-link) is not what
// this suite measures and would need materialized views this database does not
// have. Both are already try/caught inside commitBatch; stubbing them keeps the
// assertions about commit itself.
vi.mock("../src/services/plannedMatchService.js", () => ({
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
    tx_date: "2026-03-04",
    bank_account: "BE68 5390 0754 7034",
    recipient_raw: "DELHAIZE 1234",
    memo: "CARD PAYMENT - CURRENT",
    amount: "-42.5000",
    currency: "EUR",
    balance: "1000.00",
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
      batchId,
      rowIndex,
      r.tx_date,
      r.bank_account,
      r.recipient_raw,
      r.memo,
      r.amount,
      r.currency,
      r.balance,
      r.comment,
      r.tx_hash,
      r.resolved_recipient_id,
      r.user_override_recipient_id,
      r.matched_pattern_id,
      r.override_category_id,
    ],
  );
  return rows[0].id;
}

/** Insert a canonical transaction directly (never through the pipeline). */
async function insertTxn(over = {}) {
  const t = {
    date: "2026-03-04",
    bank_account: "BE68 5390 0754 7034",
    recipient_id: fx.recipientId,
    category_id: null,
    amount: "-42.5000",
    currency: "EUR",
    memo: "CARD PAYMENT - CURRENT",
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
      t.date,
      t.bank_account,
      t.recipient_id,
      t.category_id,
      t.amount,
      t.currency,
      t.memo,
      t.comment,
      t.import_batch_id,
      t.tx_hash,
      t.is_active,
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

describeDb("importPipeline commit (real Postgres)", () => {
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

  it("marks the second of an intra-chunk identical pair as a duplicate", async () => {
    const batchId = await newBatch();
    await stageRow(batchId, 0);
    await stageRow(batchId, 1);

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });

    expect(await committedTxns(batchId)).toHaveLength(1);
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "committed",
      "duplicate",
    ]);
    const counters = await batchCounters(batchId);
    expect(counters.rows_imported).toBe(1);
    expect(counters.rows_duplicate).toBe(1);
    expect(counters.rows_error).toBe(0);
  });

  it("keeps both same-batch rows whose field tuple is identical but tx_hash differs", async () => {
    // The regression class this dedup was hardened against: two same-day card
    // payments carry the identical date/amount/recipient/memo/account (Revolut
    // stamps one memo on every card payment) and differ only by the running
    // balance folded into tx_hash. Collapsing them silently drops a REAL
    // transaction.
    const batchId = await newBatch();
    await stageRow(batchId, 0, { tx_hash: "hash-a", balance: "1000.00" });
    await stageRow(batchId, 1, { tx_hash: "hash-b", balance: "957.50" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 2,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });

    const txns = await committedTxns(batchId);
    expect(txns).toHaveLength(2);
    expect(txns.map((t) => t.tx_hash).sort()).toEqual(["hash-a", "hash-b"]);
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "committed",
      "committed",
    ]);
  });

  it("treats a cross-batch field duplicate as a duplicate even when both carry a tx_hash", async () => {
    // The hash exemption is scoped to THIS batch on purpose: tx_hash is a hash
    // of the source-format row, so a re-import from another export format
    // carries a different hash for the same transaction. Without the batch
    // scope, "re-import is a no-op" would break.
    const priorBatch = await newBatch();
    await insertTxn({
      import_batch_id: priorBatch,
      tx_hash: "bank-format-hash",
    });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { tx_hash: "vision-format-hash" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect(await committedTxns(batchId)).toHaveLength(0);
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "duplicate",
    ]);
  });

  it("does not dedup across bank accounts", async () => {
    const batchId = await newBatch();
    await stageRow(batchId, 0, { bank_account: "BE68 5390 0754 7034" });
    await stageRow(batchId, 1, { bank_account: "BE11 2222 3333 4444" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 2,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });

    // Two labels → two accounts, and BOTH halves of the dual-write landed:
    // the raw label string (feeds the sync trigger until the contract drop)
    // and the explicitly-resolved account_id (the decoupled half).
    const { rows } = await pool.query(
      `SELECT t.bank_account, t.account_id, a.name
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.import_batch_id = $1 ORDER BY t.id`,
      [batchId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].account_id).not.toBe(rows[1].account_id);
    for (const r of rows) expect(r.name).toBe(r.bank_account);
  });

  it("dedups two casings of the SAME account label (FK identity, ADR-088)", async () => {
    // The dup check now compares resolved account_id, not the raw string, so
    // 'be68…' and 'BE68…' are ONE account (0066 normalized identity) and the
    // second row is the same transaction re-imported, not a distinct one. The
    // old `bank_account IS NOT DISTINCT FROM` string compare missed this.
    await insertTxn({ bank_account: "BE68 5390 0754 7034" });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { bank_account: "be68 5390 0754 7034" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "duplicate",
    ]);
    // No twin account minted for the re-cased label.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM accounts
        WHERE lower(btrim(name)) = lower(btrim('BE68 5390 0754 7034'))`,
    );
    expect(rows[0].n).toBe(1);
  });

  it("a label-less staging row only dedups against label-less rows", async () => {
    // account_id null ↔ bank_account NULL: the FK compare keeps the old
    // NULL-tuple semantics (IS NOT DISTINCT FROM) — a row with no label
    // matches an existing no-label row, and never a labelled one.
    await insertTxn({ bank_account: null });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { bank_account: null });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  it("dedups against a row whose label was set by an API edit (ghost-row regression, direction A)", async () => {
    // Ghost scenario the UPDATE-path fix closes: a PATCH renames a stored
    // row's bank_account to a FIRST-SEEN label. The 0062 trigger is
    // lookup-only on UPDATE (never creates), so pre-fix the row kept its
    // STALE account_id while the import minted a fresh account — the FK
    // probe compared fresh-id vs stale-id and MISSED the duplicate, double
    // counting money the old string compare caught. Post-fix the PATCH
    // itself resolves-or-creates and stamps the FK, so both sides land on
    // the same account and the re-import is a no-op again.
    const txnId = await insertTxn({ bank_account: "BE68 5390 0754 7034" });
    await transactionRepository.update(txnId, {
      bank_account: "Fresh Edited Account",
    });

    const { rows: edited } = await pool.query(
      `SELECT t.account_id, a.name FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = $1`,
      [txnId],
    );
    expect(edited[0].name).toBe("Fresh Edited Account"); // FK moved WITH the edit

    const batchId = await newBatch();
    await stageRow(batchId, 0, { bank_account: "Fresh Edited Account" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    // Exactly one account for the label — the import resolved onto the one
    // the PATCH created, no twin.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM accounts WHERE lower(btrim(name)) = 'fresh edited account'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it("an API label edit cannot create a NULL-FK ghost that false-dups a label-less row (direction B)", async () => {
    // Pre-fix, editing a label onto a previously label-less row left
    // account_id NULL (lookup-only trigger, no account to find) — and a
    // label-less incoming row then matched it NULL-to-NULL, silently
    // discarding a GENUINE transaction. Post-fix the edit stamps the FK, so
    // the label-less incoming row shares no account identity with it.
    const txnId = await insertTxn({ bank_account: null });
    await transactionRepository.update(txnId, {
      bank_account: "Another Fresh Account",
    });

    const { rows: edited } = await pool.query(
      "SELECT account_id FROM transactions WHERE id = $1",
      [txnId],
    );
    expect(edited[0].account_id).not.toBeNull();

    const batchId = await newBatch();
    await stageRow(batchId, 0, { bank_account: null });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  it("a label padded with non-ASCII whitespace resolves to ONE account and re-imports as a duplicate", async () => {
    // btrim-parity regression: SQL btrim strips U+0020 only, JS String#trim
    // strips all Unicode whitespace. With a trailing NBSP the JS resolver
    // used to normalize to 'NBSP Bank' while the trigger kept 'NBSP Bank\u00A0'
    // — two accounts minted, the trigger overwrote the explicitly-written
    // account_id, and the re-import missed the dup. The resolver now
    // pre-trims with btrim semantics, so both identities are the same row.
    const label = "NBSP Bank\u00A0"; // trailing U+00A0 (NBSP), not an ASCII space
    const batchId = await newBatch();
    await stageRow(batchId, 0, { bank_account: label });
    expect(await commitBatch({ batchId })).toEqual({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });

    // One account, name keeps the NBSP (btrim does not strip it), and the
    // committed row's FK agrees with the trigger's own resolution.
    const { rows: accounts } = await pool.query(
      `SELECT id, name FROM accounts WHERE lower(btrim(name)) = lower(btrim($1))`,
      [label],
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0].name).toBe(label);
    const { rows: committed } = await pool.query(
      `SELECT account_id FROM transactions WHERE import_batch_id = $1`,
      [batchId],
    );
    expect(committed[0].account_id).toBe(accounts[0].id);

    // Re-import of the same file is a no-op.
    const batch2 = await newBatch();
    await stageRow(batch2, 0, { bank_account: label });
    expect(await commitBatch({ batchId: batch2 })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    const { rows: after } = await pool.query(
      `SELECT count(*)::int AS n FROM accounts WHERE lower(btrim(name)) = lower(btrim($1))`,
      [label],
    );
    expect(after[0].n).toBe(1);
  });

  it("deduplicates a repeated tx_hash inside the same chunk before the field check", async () => {
    const batchId = await newBatch();
    // Field tuples differ (different memo), so ONLY the hash can catch this.
    await stageRow(batchId, 0, { tx_hash: "same-hash", memo: "A" });
    await stageRow(batchId, 1, { tx_hash: "same-hash", memo: "B" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect(await committedTxns(batchId)).toHaveLength(1);
  });

  it("marks a row whose tx_hash already exists on an INACTIVE transaction as a duplicate", async () => {
    // uq_transactions_tx_hash is partial on `tx_hash IS NOT NULL` with no
    // is_active predicate, so a soft-deleted row still blocks the insert. The
    // field check (is_active = true) cannot see it — the hash check must.
    await insertTxn({
      tx_hash: "seen-before",
      is_active: false,
      memo: "ARCHIVED",
    });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { tx_hash: "seen-before" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "duplicate",
    ]);
  });

  // ── constraint checks happen BEFORE conflict resolution ───────────────────
  //
  // Postgres forms and validates the tuple (NOT NULL, CHECK, numeric overflow)
  // before it looks for an ON CONFLICT arbiter, but foreign keys are AFTER
  // triggers that never fire for a row DO NOTHING skipped. So a row that both
  // conflicts on tx_hash AND violates a constraint is an ERROR for the first
  // class and a DUPLICATE for the second. A commit path that decides "this
  // hash already exists, skip the insert" in JS collapses the first class into
  // 'duplicate' and the user silently loses the failure signal.

  it("reports a hash-conflicting row that also violates a CHECK as an error, not a duplicate", async () => {
    // Live vector: a bank adapter that hands through an unnormalized currency
    // ('eur') trips chk_transactions_currency_iso.
    await insertTxn({ tx_hash: "clash", memo: "ALREADY IMPORTED" });

    const batchId = await newBatch();
    await stageRow(batchId, 0, {
      tx_hash: "clash",
      currency: "eur",
      memo: "INCOMING",
    });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 0,
      errors: 1,
      autoLinkedCount: 0,
    });
    const staging = await stagingStatuses(batchId);
    expect(staging.map((r) => r.status)).toEqual(["error"]);
    expect(staging[0].error_message).toMatch(/chk_transactions_currency_iso/);
    expect((await batchCounters(batchId)).rows_error).toBe(1);
  });

  it("reports a hash-conflicting row that overflows NUMERIC(18,4) balance as an error", async () => {
    await insertTxn({ tx_hash: "clash-2", memo: "ALREADY IMPORTED" });

    // import_staging_rows.balance is NUMERIC(20,4) — deliberately wider than its
    // commit target, transactions.balance at NUMERIC(18,4) since migration 0088
    // (ADR-060 D7; 15 integer digits fit staging but overflow the target).
    const batchId = await newBatch();
    await stageRow(batchId, 0, {
      tx_hash: "clash-2",
      memo: "INCOMING",
      balance: "999999999999999.0000",
    });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 0,
      errors: 1,
      autoLinkedCount: 0,
    });
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "error",
    ]);
  });

  it("keeps the rest of the chunk when a constraint-violating conflict row sits among clean rows", async () => {
    await insertTxn({ tx_hash: "clash-3", memo: "ALREADY IMPORTED" });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { memo: "GOOD ONE" });
    await stageRow(batchId, 1, {
      tx_hash: "clash-3",
      currency: "eur",
      memo: "BAD",
    });
    await stageRow(batchId, 2, { memo: "GOOD TWO" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 2,
      duplicates: 0,
      errors: 1,
      autoLinkedCount: 0,
    });
    expect((await committedTxns(batchId)).map((t) => t.memo).sort()).toEqual([
      "GOOD ONE",
      "GOOD TWO",
    ]);
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "committed",
      "error",
      "committed",
    ]);
  });

  it("applies the hash exemption only when the STORED row also carries a hash", async () => {
    // The exemption needs a hash on BOTH sides (`t.tx_hash IS NOT NULL AND
    // $6 IS NOT NULL AND t.tx_hash <> $6`). A same-batch row committed without
    // one therefore still field-matches a later hashed row — an asymmetry a
    // symmetric "hashes differ ⇒ distinct" rewrite would silently lose.
    const batchId = await newBatch();
    await stageRow(batchId, 0, { tx_hash: null });
    await stageRow(batchId, 1, { tx_hash: "later-hash" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "committed",
      "duplicate",
    ]);
  });

  it("trims surrounding ASCII whitespace consistently on both memo sides", async () => {
    const spaceBatch = await newBatch();
    await stageRow(spaceBatch, 0, { memo: "COFFEE " });
    await stageRow(spaceBatch, 1, { memo: "COFFEE " });
    expect(await commitBatch({ batchId: spaceBatch })).toEqual({
      imported: 1,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });

    const tabBatch = await newBatch();
    await stageRow(tabBatch, 0, { memo: "TEA\t", bank_account: "BE00 OTHER" });
    await stageRow(tabBatch, 1, { memo: "TEA\t", bank_account: "BE00 OTHER" });
    expect(await commitBatch({ batchId: tabBatch })).toEqual({
      imported: 1,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  it("field-matches an orphaned hashed row after its batch metadata is deleted", async () => {
    // transactions_import_batch_id_fkey is ON DELETE SET NULL, so deleting an
    // import batch leaves its rows with a tx_hash and no import_batch_id. In
    // batch leaves its transaction in place. Deleting metadata must not make
    // the transaction silently re-importable merely because its source hash
    // differs from a round-trip export hash.
    await insertTxn({ import_batch_id: null, tx_hash: "orphaned-hash" });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { tx_hash: "incoming-hash" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  it("field-matches an orphaned UNHASHED row (the manual-entry case)", async () => {
    // Same orphan, no tx_hash: `t.tx_hash IS NOT NULL` is FALSE, the exemption
    // collapses to FALSE, and the candidate matches normally.
    await insertTxn({ import_batch_id: null, tx_hash: null });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { tx_hash: "incoming-hash" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  it("compares amounts numerically, not textually", async () => {
    // transactions.amount is NUMERIC(18,4), import_staging_rows.amount is
    // NUMERIC(20,4): the dup key must not depend on the rendered scale.
    await insertTxn({ amount: "-42.5" });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { amount: "-42.5000" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  it("ignores an inactive transaction when field-deduping", async () => {
    await insertTxn({ is_active: false });

    const batchId = await newBatch();
    await stageRow(batchId, 0);

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  // ── failure isolation ─────────────────────────────────────────────────────

  it("isolates a poison row: the rest of the chunk lands and only it is failed", async () => {
    // Staging accepts the raw source currency, while the transaction table's
    // ISO currency CHECK rejects this lowercase value during commit.
    const batchId = await newBatch();
    await stageRow(batchId, 0, { memo: "GOOD ONE" });
    await stageRow(batchId, 1, { memo: "POISON", currency: "eur" });
    await stageRow(batchId, 2, { memo: "GOOD TWO" });

    const result = await commitBatch({ batchId });
    expect(result).toEqual({
      imported: 2,
      duplicates: 0,
      errors: 1,
      autoLinkedCount: 0,
    });

    const txns = await committedTxns(batchId);
    expect(txns.map((t) => t.memo).sort()).toEqual(["GOOD ONE", "GOOD TWO"]);

    const staging = await stagingStatuses(batchId);
    expect(staging.map((r) => r.status)).toEqual([
      "committed",
      "error",
      "committed",
    ]);
    expect(staging[1].error_message).toBeTruthy();

    const counters = await batchCounters(batchId);
    expect(counters.rows_imported).toBe(2);
    expect(counters.rows_duplicate).toBe(0);
    expect(counters.rows_error).toBe(1);
  });

  it("does not let a poison row change the verdict of a row that follows it", async () => {
    // The batched planner speculates that every planned insert lands, so a
    // failed insert could otherwise make the NEXT identical row look like a
    // duplicate of a transaction that never existed. The per-row replay is
    // what makes both rows fail instead.
    const batchId = await newBatch();
    await stageRow(batchId, 0, { currency: "eur" });
    await stageRow(batchId, 1, { currency: "eur" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 0,
      errors: 2,
      autoLinkedCount: 0,
    });
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "error",
      "error",
    ]);
  });

  it("keeps inserted + duplicate + failed = total across a mixed batch", async () => {
    await insertTxn({ memo: "ALREADY THERE" });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { memo: "ALREADY THERE" }); // cross-batch dup
    await stageRow(batchId, 1, { memo: "FRESH A" }); // insert
    await stageRow(batchId, 2, { memo: "FRESH A" }); // intra-chunk dup
    await stageRow(batchId, 3, { memo: "FRESH B", currency: "eur" }); // error
    await stageRow(batchId, 4, { memo: "FRESH C", tx_hash: "x1" }); // insert
    await stageRow(batchId, 5, { memo: "FRESH D", tx_hash: "x1" }); // hash dup

    const result = await commitBatch({ batchId });
    expect(result.imported + result.duplicates + result.errors).toBe(6);
    expect(result).toEqual({
      imported: 2,
      duplicates: 3,
      errors: 1,
      autoLinkedCount: 0,
    });

    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "duplicate",
      "committed",
      "duplicate",
      "error",
      "committed",
      "duplicate",
    ]);
    const counters = await batchCounters(batchId);
    expect(
      counters.rows_imported + counters.rows_duplicate + counters.rows_error,
    ).toBe(6);
  });

  // ── unresolved recipients ─────────────────────────────────────────────────

  it("decides a row with no recipient into 'error' up front, keeping its chunk on the batched path", async () => {
    // The matcher stamps a row it could not resolve 'matched' with a NULL
    // resolved_recipient_id (that is what keeps it fixable in review); if the
    // user commits without assigning one, commit must DECIDE the row into
    // 'error' rather than let it 23502 on transactions.recipient_id NOT NULL
    // inside the bulk INSERT — which would also demote the whole chunk to the
    // per-row replay. The decided error carries the decision's message, not a
    // constraint-violation string, which is what this pins.
    const batchId = await newBatch();
    await stageRow(batchId, 0, {
      recipient_raw: "",
      resolved_recipient_id: null,
    });
    await stageRow(batchId, 1, { tx_hash: "hash-a", balance: "1000.00" });
    await stageRow(batchId, 2, { tx_hash: "hash-b", balance: "957.50" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 2,
      duplicates: 0,
      errors: 1,
      autoLinkedCount: 0,
    });

    const staging = await stagingStatuses(batchId);
    expect(staging.map((r) => r.status)).toEqual([
      "error",
      "committed",
      "committed",
    ]);
    expect(staging[0].error_message).toMatch(/unresolved recipient/);
    expect(await committedTxns(batchId)).toHaveLength(2);
    const counters = await batchCounters(batchId);
    expect(counters.rows_imported).toBe(2);
    expect(counters.rows_error).toBe(1);
  });

  it("commits an unresolved row once the user assigned a recipient in review", async () => {
    // The review-UI fix path: the unresolved row stayed 'matched', the user
    // set user_override_recipient_id, and commit honours the override.
    const batchId = await newBatch();
    await stageRow(batchId, 0, {
      resolved_recipient_id: null,
      user_override_recipient_id: fx.otherRecipientId,
    });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
    const txns = await committedTxns(batchId);
    expect(txns).toHaveLength(1);
    expect(txns[0].recipient_id).toBe(fx.otherRecipientId);
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "committed",
    ]);
  });

  // ── written-column fidelity ───────────────────────────────────────────────

  it("writes the same columns the per-row insert wrote", async () => {
    const batchId = await newBatch();
    await stageRow(batchId, 0, {
      comment: "holiday",
      currency: null, // must default to EUR, never NULL
      balance: "1234.56",
      tx_hash: "h-cols",
    });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });

    const [t] = await committedTxns(batchId);
    expect(t).toMatchObject({
      date: "2026-03-04",
      amount: "-42.5000",
      memo: "CARD PAYMENT - CURRENT",
      bank_account: "BE68 5390 0754 7034",
      recipient_id: fx.recipientId,
      // ADR-046: no per-row override → the recipient's default category.
      category_id: fx.categoryId,
      currency: "EUR",
      balance: "1234.5600", // transactions.balance NUMERIC(18,4) since migration 0088
      tx_hash: "h-cols",
    });
  });

  it("prefers the row override over the recipient default and clears matched_pattern_id", async () => {
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

  it("dedups across chunk boundaries (chunk size is 1000)", async () => {
    const batchId = await newBatch();
    const rows = [];
    for (let i = 0; i < 1002; i++) {
      // Row 1001 lands in the SECOND chunk and repeats row 0 exactly, so its
      // duplicate verdict can only come from the previous chunk's committed
      // rows being re-read by the next chunk's pre-load.
      rows.push(
        stageRow(batchId, i, { memo: i === 1001 ? "ROW 0" : `ROW ${i}` }),
      );
    }
    await Promise.all(rows);

    const progress = [];
    const result = await commitBatch({
      batchId,
      onProgress: (p) => progress.push(p),
    });
    expect(result).toEqual({
      imported: 1001,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect(await committedTxns(batchId)).toHaveLength(1001);

    // SSE progress: an initial 0/total, then one event per chunk.
    expect(progress[0]).toEqual({
      phase: "committing",
      current: 0,
      total: 1002,
    });
    expect(progress.at(-1)).toEqual({
      phase: "committing",
      current: 1002,
      total: 1002,
      imported: 1001,
      duplicates: 1,
      errors: 0,
    });
    expect(progress).toHaveLength(3);
  });

  it("returns zeroes and touches nothing for a batch with no matched rows", async () => {
    const batchId = await newBatch();
    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect((await batchCounters(batchId)).status).toBe("committing");
  });
});
