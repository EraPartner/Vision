/**
 * Real-Postgres tests for the import pipeline COMMIT phase.
 *
 * The mock suite (importPipeline.test.js) choreographs SQL results on a fake
 * client, so it asserts the statements we wrote rather than the rows Postgres
 * actually returns. Commit is the phase that decides which real bank rows
 * enter the ledger and which are silently discarded as duplicates, and its
 * verdicts depend on genuine NUMERIC equality, genuine NULL semantics, the
 * partial unique index over versioned fingerprints, and rows inserted
 * earlier in the same transaction. All four are invisible to a mock.
 *
 * The current commit phase groups rows into chunks, resolves account IDs, and
 * uses versioned occurrence fingerprints with a legacy field-count fallback.
 * These tests exercise those verdicts against the real schema.
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
  deleteAllCategoryFixtures,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { commitBatch } from "../src/services/importPipeline/commit.js";
import { transactionRepository } from "../src/repositories/transactionRepository.js";
import { closePool } from "../src/database/connection.js";
import {
  assignImportIdentities,
  budgetingIdentityBase,
} from "../src/services/importIdentity.js";

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
const stagedByBatch = new Map();

function identityFor(row, priorRows = []) {
  return assignImportIdentities(
    [...priorRows, row].map((r) => ({ ...r, source_id: r.sourceId })),
    (r) => budgetingIdentityBase(r, "belfius"),
  ).at(-1);
}

async function ensureAccount(name) {
  if (name == null || name.trim() === "") return null;
  await pool.query(
    `INSERT INTO accounts (name, display_name) VALUES ($1, $1)
     ON CONFLICT (lower(btrim(name))) DO NOTHING`,
    [name],
  );
  const { rows } = await pool.query(
    `SELECT id FROM accounts WHERE lower(btrim(name)) = lower(btrim($1))`,
    [name],
  );
  return rows[0].id;
}

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
  stagedByBatch.clear();
  await pool.query(`DELETE FROM transactions`);
  await pool.query(`DELETE FROM import_staging_rows`);
  await pool.query(`DELETE FROM import_batches`);
  await pool.query(`DELETE FROM recipients`);
  await deleteAllCategoryFixtures(pool);
  await pool.query(`DELETE FROM accounts`);
}

/** Create an import batch and return its id. */
async function newBatch(adapterName = "belfius") {
  const { rows } = await pool.query(
    `INSERT INTO import_batches (adapter_name, status, rows_total)
     VALUES ($1, 'awaiting_review', 0) RETURNING id`,
    [adapterName],
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
    sourceId: null,
    resolved_recipient_id: fx.recipientId,
    user_override_recipient_id: null,
    matched_pattern_id: null,
    override_category_id: null,
    ...over,
  };
  const byIdentity = stagedByBatch.get(batchId) ?? new Map();
  const base = budgetingIdentityBase(
    { ...r, source_id: r.sourceId },
    "belfius",
  ).base;
  const priorRows = byIdentity.get(base) ?? [];
  const identity = identityFor(r, priorRows);
  byIdentity.set(base, [...priorRows, r]);
  stagedByBatch.set(batchId, byIdentity);
  const { rows } = await pool.query(
    `INSERT INTO import_staging_rows
       (batch_id, row_index, status, tx_date, bank_account, recipient_raw, memo, amount,
        currency, balance, comment, source_transaction_id, source_record_hash,
        dedup_fingerprint, dedup_fingerprint_version, dedup_occurrence,
        resolved_recipient_id, user_override_recipient_id, matched_pattern_id,
        override_category_id)
     VALUES ($1, $2, 'matched', $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, $17, $18, $19)
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
      r.sourceId,
      identity.sourceRecordHash,
      identity.fingerprint,
      identity.version,
      identity.occurrence,
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
    sourceId: null,
    is_active: true,
    ...over,
  };
  const accountId = await ensureAccount(t.bank_account);
  const identity = t.sourceId
    ? identityFor({ ...t, sourceId: t.sourceId })
    : null;
  const { rows } = await pool.query(
    `INSERT INTO transactions
       (date, account_id, recipient_id, category_id, amount, currency, memo, comment,
        import_batch_id, dedup_fingerprint, dedup_fingerprint_version, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      t.date,
      accountId,
      t.recipient_id,
      t.category_id,
      t.amount,
      t.currency,
      t.memo,
      t.comment,
      t.import_batch_id,
      identity?.fingerprint ?? null,
      identity?.version ?? null,
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
    `SELECT t.id, to_char(t.date,'YYYY-MM-DD') AS date,
            t.amount::text AS amount, t.memo,
            a.name AS bank_account, t.recipient_id, t.category_id, t.currency,
            t.balance::text AS balance, t.dedup_fingerprint, t.matched_pattern_id
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.import_batch_id = $1 ORDER BY t.id`,
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

  it("makes Revolut-created accounts permanently multi-currency capable", async () => {
    const batchId = await newBatch("revolut");
    await stageRow(batchId, 0, { bank_account: "REVOLUT CURRENT" });

    await commitBatch({ batchId });
    const { rows } = await pool.query(
      `SELECT multi_currency_cash FROM accounts WHERE name = 'REVOLUT CURRENT'`,
    );
    expect(rows[0].multi_currency_cash).toBe(true);

    const ordinaryBatch = await newBatch("belfius");
    await stageRow(ordinaryBatch, 0, {
      bank_account: "REVOLUT CURRENT",
      memo: "SECOND ROW",
    });
    await commitBatch({ batchId: ordinaryBatch });
    const after = await pool.query(
      `SELECT multi_currency_cash FROM accounts WHERE name = 'REVOLUT CURRENT'`,
    );
    expect(after.rows[0].multi_currency_cash).toBe(true);
  });

  it("keeps two legitimate identical occurrences in one chunk", async () => {
    const batchId = await newBatch();
    await stageRow(batchId, 0);
    await stageRow(batchId, 1);

    expect(await commitBatch({ batchId })).toEqual({
      imported: 2,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });

    expect(await committedTxns(batchId)).toHaveLength(2);
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "committed",
      "committed",
    ]);
    const counters = await batchCounters(batchId);
    expect(counters.rows_imported).toBe(2);
    expect(counters.rows_duplicate).toBe(0);
    expect(counters.rows_error).toBe(0);
  });

  it("keeps same-field rows with distinct source IDs", async () => {
    const batchId = await newBatch();
    await stageRow(batchId, 0, { sourceId: "hash-a", balance: "1000.00" });
    await stageRow(batchId, 1, { sourceId: "hash-b", balance: "957.50" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 2,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });

    const txns = await committedTxns(batchId);
    expect(txns).toHaveLength(2);
    expect(new Set(txns.map((t) => t.dedup_fingerprint)).size).toBe(2);
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "committed",
      "committed",
    ]);
  });

  it("keeps distinct provider source IDs even when fields match", async () => {
    const priorBatch = await newBatch();
    await insertTxn({
      import_batch_id: priorBatch,
      sourceId: "bank-format-hash",
    });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { sourceId: "vision-format-hash" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect(await committedTxns(batchId)).toHaveLength(1);
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "committed",
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

    // Two labels resolve to two canonical account IDs.
    const { rows } = await pool.query(
      `SELECT t.account_id, a.name
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.import_batch_id = $1 ORDER BY t.id`,
      [batchId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].account_id).not.toBe(rows[1].account_id);
    for (const r of rows) {
      expect(r.name).toMatch(/^BE/);
    }
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

  it("dedups against a row repointed to the importing account", async () => {
    const txnId = await insertTxn({ bank_account: "BE68 5390 0754 7034" });
    const newAccountId = await ensureAccount("Fresh Edited Account");
    await transactionRepository.update(txnId, {
      account_id: newAccountId,
    });

    const { rows: edited } = await pool.query(
      `SELECT t.account_id, a.name FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = $1`,
      [txnId],
    );
    expect(edited[0].name).toBe("Fresh Edited Account");

    const batchId = await newBatch();
    await stageRow(batchId, 0, { bank_account: "Fresh Edited Account" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 0,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    // The import resolved onto the account selected by the update.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM accounts WHERE lower(btrim(name)) = 'fresh edited account'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it("repointing a label-less row avoids a false duplicate for a later label-less import", async () => {
    const txnId = await insertTxn({ bank_account: null });
    const newAccountId = await ensureAccount("Another Fresh Account");
    await transactionRepository.update(txnId, {
      account_id: newAccountId,
    });

    const { rows: edited } = await pool.query(
      "SELECT account_id FROM transactions WHERE id = $1",
      [txnId],
    );
    expect(edited[0].account_id).toBe(newAccountId);

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
    // The account resolver uses SQL btrim semantics, which preserve NBSP.
    const label = "NBSP Bank\u00A0"; // trailing U+00A0 (NBSP), not an ASCII space
    const batchId = await newBatch();
    await stageRow(batchId, 0, { bank_account: label });
    expect(await commitBatch({ batchId })).toEqual({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });

    // One account, name keeps the NBSP, and the committed row links to it.
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

  it("deduplicates a repeated source ID inside the same chunk", async () => {
    const batchId = await newBatch();
    // Field tuples differ, so only the shared source identity can catch this.
    await stageRow(batchId, 0, { sourceId: "same-hash", memo: "A" });
    await stageRow(batchId, 1, { sourceId: "same-hash", memo: "B" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1,
      duplicates: 1,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect(await committedTxns(batchId)).toHaveLength(1);
  });

  it("marks a fingerprint already on an inactive transaction as a duplicate", async () => {
    // The partial fingerprint index has no is_active predicate, so a
    // soft-deleted row still blocks the same source identity.
    await insertTxn({
      sourceId: "seen-before",
      is_active: false,
      memo: "ARCHIVED",
    });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { sourceId: "seen-before" });

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

  // ── validation failures stay isolated ────────────────────────────────────

  it("reports an invalid currency CHECK as an error", async () => {
    // Live vector: a bank adapter that hands through an unnormalized currency
    // ('eur') trips chk_transactions_currency_iso.
    const batchId = await newBatch();
    await stageRow(batchId, 0, {
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

  it("reports a row that overflows NUMERIC(18,4) balance as an error", async () => {
    // import_staging_rows.balance is NUMERIC(20,4) — deliberately wider than its
    // commit target, transactions.balance at NUMERIC(18,4) since migration 0088
    // (ADR-060 D7; 15 integer digits fit staging but overflow the target).
    const batchId = await newBatch();
    await stageRow(batchId, 0, {
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

  it("keeps clean rows when a constraint-violating row sits among them", async () => {
    const batchId = await newBatch();
    await stageRow(batchId, 0, { memo: "GOOD ONE" });
    await stageRow(batchId, 1, {
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

  it("keeps a distinct source ID beside a fallback occurrence", async () => {
    const batchId = await newBatch();
    await stageRow(batchId, 0, { sourceId: null });
    await stageRow(batchId, 1, { sourceId: "later-hash" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 2,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "committed",
      "committed",
    ]);
  });

  it("preserves repeated normalized memo occurrences and dedups a complete re-import", async () => {
    const spaceBatch = await newBatch();
    await stageRow(spaceBatch, 0, { memo: "COFFEE " });
    await stageRow(spaceBatch, 1, { memo: "COFFEE " });
    expect(await commitBatch({ batchId: spaceBatch })).toEqual({
      imported: 2,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });

    const tabBatch = await newBatch();
    await stageRow(tabBatch, 0, { memo: "TEA\t", bank_account: "BE00 OTHER" });
    await stageRow(tabBatch, 1, { memo: "TEA\t", bank_account: "BE00 OTHER" });
    expect(await commitBatch({ batchId: tabBatch })).toEqual({
      imported: 2,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });

    const reimport = await newBatch();
    await stageRow(reimport, 0, { memo: "TEA\t", bank_account: "BE00 OTHER" });
    await stageRow(reimport, 1, { memo: "TEA\t", bank_account: "BE00 OTHER" });
    expect(await commitBatch({ batchId: reimport })).toMatchObject({
      imported: 0,
      duplicates: 2,
      errors: 0,
    });
  });

  it("keeps distinct source IDs even when an older imported row lost its batch link", async () => {
    await insertTxn({ import_batch_id: null, sourceId: "orphaned-hash" });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { sourceId: "incoming-hash" });

    expect(await commitBatch({ batchId })).toEqual({
      imported: 1,
      duplicates: 0,
      errors: 0,
      autoLinkedCount: 0,
    });
  });

  it("field-matches an older unversioned row (the manual-entry case)", async () => {
    await insertTxn({ import_batch_id: null, sourceId: null });

    const batchId = await newBatch();
    await stageRow(batchId, 0, { sourceId: "incoming-hash" });

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
    // A failed insert must not make the NEXT identical row look like a
    // duplicate of a transaction that never existed.
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
    await stageRow(batchId, 2, { memo: "FRESH A" }); // second occurrence
    await stageRow(batchId, 3, { memo: "FRESH B", currency: "eur" }); // error
    await stageRow(batchId, 4, { memo: "FRESH C", sourceId: "x1" }); // insert
    await stageRow(batchId, 5, { memo: "FRESH D", sourceId: "x1" }); // source ID dup

    const result = await commitBatch({ batchId });
    expect(result.imported + result.duplicates + result.errors).toBe(6);
    expect(result).toEqual({
      imported: 3,
      duplicates: 2,
      errors: 1,
      autoLinkedCount: 0,
    });

    expect((await stagingStatuses(batchId)).map((r) => r.status)).toEqual([
      "duplicate",
      "committed",
      "committed",
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

  it("decides a row with no recipient into 'error' before its chunk is committed", async () => {
    // The matcher stamps a row it could not resolve 'matched' with a NULL
    // resolved_recipient_id (that is what keeps it fixable in review); if the
    // user commits without assigning one, commit must DECIDE the row into
    // 'error' before any INSERT attempts a NOT NULL violation. The decided
    // error carries the decision's message, not a constraint-violation string.
    const batchId = await newBatch();
    await stageRow(batchId, 0, {
      recipient_raw: "",
      resolved_recipient_id: null,
    });
    await stageRow(batchId, 1, { sourceId: "hash-a", balance: "1000.00" });
    await stageRow(batchId, 2, { sourceId: "hash-b", balance: "957.50" });

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
      sourceId: "h-cols",
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
      dedup_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
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
      // Row 1001 lands in the SECOND chunk and repeats row 0's source ID,
      // so its duplicate verdict must see the first chunk's committed row.
      rows.push(
        stageRow(batchId, i, {
          memo: i === 1001 ? "ROW 0" : `ROW ${i}`,
          sourceId: i === 0 || i === 1001 ? "row-zero" : null,
        }),
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
  }, 30_000);

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
