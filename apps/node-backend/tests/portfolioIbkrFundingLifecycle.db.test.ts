import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { acquireDbSuiteLock, releaseDbSuiteLock, getTestPool, hasTestDatabase, closeTestPool } from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { syntheticIbkrCashCorrection } from "./helpers/ibkrCashReconciliation.ts";
import { readReconciliationSources } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import { __CASH_SNAPSHOT_SQL } from "../src/repositories/portfolioImportCashRepository.ts";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.ts";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.ts";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.ts";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("../src/services/materializedViewService.ts", async (original) => ({ ...(await original()), scheduleRefresh: refresh }));
const pool = getTestPool()!;
const owned: { batches: number[]; accounts: number[]; recipients: number[]; investments: number[] } =
  { batches: [], accounts: [], recipients: [], investments: [] };
let sequence = 0;
const fields = ["row_index", "status", "tx_date", "type_raw", "type", "route", "symbol_raw", "name_raw", "units", "price_per_unit",
  "amount", "fees", "taxes", "currency", "fx_rate_to_eur", "note", "raw_data", "source_record_hash", "source_transaction_id", "source_account_identity",
  "dedup_fingerprint", "dedup_fingerprint_version", "dedup_occurrence", "committed_txn_id"];
async function sourceRow(row: Record<string, unknown>, batchId: number, transactionId: number | null = null) {
  const params = [batchId, ...fields.map((field) => field === "committed_txn_id" ? transactionId : row[field] ?? null)];
  await pool.query(`INSERT INTO portfolio_import_staging_rows(batch_id,${fields.join(",")})
    VALUES(${params.map((_, index) => `$${index + 1}`).join(",")})`, params);
}
async function nativeBatch(source: ReturnType<typeof syntheticIbkrCashCorrection>, account: number) {
  const id = Number((await pool.query(`INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,account_id,is_brokerage)
    VALUES('ibkr_funding_history',$1,'awaiting_review',1,$2,true) RETURNING id`, [JSON.stringify(source.native.custom_config), account])).rows[0].id);
  owned.batches.push(id);
  await sourceRow(source.native, id);
  return id;
}
async function fixture() {
  const number = ++sequence;
  const source = syntheticIbkrCashCorrection({ sourceAccount: `U1234${String(number).padStart(4, "0")}` });
  const account = (await pool.query("INSERT INTO accounts(name,type,currency) VALUES($1,'brokerage','EUR') RETURNING id", [`Synthetic funding lifecycle ${number}`])).rows[0].id;
  owned.accounts.push(account);
  const recipient = (await pool.query("INSERT INTO recipients(name,normalized_name) VALUES($1,$2) RETURNING id", [`Synthetic institution ${number}`, `synthetic institution ${number}`])).rows[0].id;
  owned.recipients.push(recipient);
  const originalBatch = Number((await pool.query(`INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,rows_imported,account_id,is_brokerage)
    VALUES('ibkr_transaction_history',$1,'complete',1,1,$2,true) RETURNING id`, [JSON.stringify(source.original.custom_config), account])).rows[0].id);
  owned.batches.push(originalBatch);
  const transactionId = (await pool.query(`INSERT INTO transactions(date,amount,currency,memo,comment,account_id,recipient_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,is_active)
    VALUES('2026-01-01',80,'EUR',$1,'Keep user comment',$2,$3,$4,$5,1,true) RETURNING id`,
  [source.original.note, account, recipient, source.original.source_record_hash, source.original.dedup_fingerprint])).rows[0].id;
  await sourceRow(source.original, originalBatch, transactionId);
  const batch = await nativeBatch(source, account);
  const investment = (await pool.query("INSERT INTO investments(name,symbol,asset_class,currency) VALUES($1,$2,'stock','EUR') RETURNING id",
  [`Synthetic collision stock ${number}`, `FUNDCOLLISION${number}`])).rows[0].id;
  owned.investments.push(investment);
  // Equal IDs in separate ledgers must never cross the rollback projection.
  await pool.query("INSERT INTO portfolio_transactions(id,investment_id,type,date,units,amount,currency,note) VALUES($1,$2,'gift','2025-12-01',2,50,'EUR','Untouched stock history')", [transactionId, investment]);
  return { source, account, transactionId, originalBatch, nativeBatch: batch, investment };
}
type Seeded = Awaited<ReturnType<typeof fixture>>;
async function image(id: number) {
  return (await pool.query(`SELECT ${__CASH_SNAPSHOT_SQL} AS snapshot FROM transactions t WHERE t.id=$1`, [id])).rows[0]?.snapshot;
}
async function stockImage(id: number) { return (await pool.query("SELECT to_jsonb(pt) AS snapshot FROM portfolio_transactions pt WHERE id=$1", [id])).rows[0]?.snapshot; }
async function preview(ids: number[], reconciliationScope = "correct_existing_only") {
  return previewPortfolioImportReconciliation({ batchIds: ids, adoptPolicy: "prefer_source", reconciliationScope });
}
async function commit(ids: number[], reconciliationScope = "correct_existing_only") {
  const review = await preview(ids, reconciliationScope);
  expect(review.ready).toBe(true);
  return commitReviewedPortfolioImports({ batchIds: ids, adoptPolicy: "prefer_source", reconciliationScope, expectedPlanFingerprint: review.planFingerprint });
}
async function journalCount(f: Seeded) { return Number((await pool.query("SELECT count(*) AS count FROM portfolio_import_reconciliation_journal WHERE batch_id=$1", [f.nativeBatch])).rows[0].count); }
async function cleanup() {
  refresh.mockClear();
  await pool.query("DROP TRIGGER IF EXISTS synthetic_funding_failure ON transactions; DROP FUNCTION IF EXISTS synthetic_funding_failure()");
  await pool.query("ALTER TABLE portfolio_import_reconciliation_journal DISABLE TRIGGER portfolio_import_reconciliation_immutable");
  try { await pool.query("DELETE FROM portfolio_import_reconciliation_journal WHERE batch_id=ANY($1::bigint[])", [owned.batches]); }
  finally { await pool.query("ALTER TABLE portfolio_import_reconciliation_journal ENABLE TRIGGER portfolio_import_reconciliation_immutable"); }
  await pool.query("DELETE FROM portfolio_import_batches WHERE id=ANY($1::bigint[])", [owned.batches]);
  await pool.query("DELETE FROM transactions WHERE account_id=ANY($1::integer[])", [owned.accounts]);
  await pool.query("DELETE FROM portfolio_transactions WHERE investment_id=ANY($1::integer[])", [owned.investments]);
  await pool.query("DELETE FROM investments WHERE id=ANY($1::integer[])", [owned.investments]);
  await pool.query("DELETE FROM accounts WHERE id=ANY($1::integer[])", [owned.accounts]);
  await pool.query("DELETE FROM recipients WHERE id=ANY($1::integer[])", [owned.recipients]);
  owned.batches = []; owned.accounts = []; owned.recipients = []; owned.investments = [];
}

describe.skipIf(!hasTestDatabase())("IBKR funding correction through reviewed import lifecycle", () => {
  beforeAll(acquireDbSuiteLock, 180000);
  afterEach(cleanup);
  afterAll(async () => { await releaseDbSuiteLock(); await closeTestPool(); await closePool(); });
  it.each(["correct_existing_only", "full"])("adopts cash with truthful counts in %s scope without touching the colliding portfolio ID", async (scope) => {
    const f = await fixture();
    const before = await stockImage(f.transactionId);
    const review = await preview([f.nativeBatch], scope);
    expect(review.summary).toMatchObject({ adopt: 1, insert: 0, cash: 0 });
    const result = await commit([f.nativeBatch], scope);
    expect(result).toMatchObject({ adopted: 1, imported: 0, duplicates: 1, errors: 0 });
    expect(await image(f.transactionId)).toMatchObject({ amount: "100.0000", currency: "USD" });
    expect(await stockImage(f.transactionId)).toEqual(before);
    expect((await pool.query("SELECT status,rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1", [f.nativeBatch])).rows[0])
      .toEqual({ status: "complete", rows_imported: 0, rows_duplicate: 1 });
    expect((await readReconciliationSources([f.nativeBatch]))[0]).toMatchObject({ status: "duplicate", committed_txn_id: null });
    expect(refresh).toHaveBeenCalled();
  });
  it("settles a new repeat batch and can undo that review without deleting the original cash or colliding stock", async () => {
    const f = await fixture();
    await commit([f.nativeBatch]);
    const cash = await image(f.transactionId);
    const stock = await stockImage(f.transactionId);
    const repeated = await nativeBatch(f.source, f.account);
    expect((await preview([repeated])).summary).toMatchObject({ adopt: 0, duplicate: 1 });
    expect(await commit([repeated])).toMatchObject({ adopted: 0, duplicates: 1, imported: 0 });
    expect(await journalCount(f)).toBe(1);
    expect(await rollbackBatch(repeated)).toMatchObject({ deleted: 0 });
    expect(await image(f.transactionId)).toEqual(cash);
    expect(await stockImage(f.transactionId)).toEqual(stock);
  });
  it("restores a corrected funding record and leaves the original source owner intact", async () => {
    const f = await fixture();
    const cash = await image(f.transactionId);
    const stock = await stockImage(f.transactionId);
    await commit([f.nativeBatch]);
    refresh.mockClear();
    expect(await rollbackBatch(f.nativeBatch)).toMatchObject({ deleted: 0 });
    expect(await image(f.transactionId)).toEqual(cash);
    expect(await stockImage(f.transactionId)).toEqual(stock);
    expect((await readReconciliationSources([f.originalBatch]))[0]).toMatchObject({ status: "committed", committed_txn_id: f.transactionId });
    expect(await journalCount(f)).toBe(2);
    expect(refresh).toHaveBeenCalled();
  });
  it("blocks undoing the original funding owner while a correction depends on it", async () => {
    const f = await fixture();
    await commit([f.nativeBatch]);
    const cash = await image(f.transactionId);
    const stock = await stockImage(f.transactionId);
    await expect(rollbackBatch(f.originalBatch)).rejects.toThrow("Owned cash source or ledger image changed");
    expect(await image(f.transactionId)).toEqual(cash);
    expect(await stockImage(f.transactionId)).toEqual(stock);
    expect((await pool.query("SELECT status FROM portfolio_import_batches WHERE id=$1", [f.originalBatch])).rows[0].status).toBe("complete");
  });
  it("rejects a stale review before any correction or counter changes", async () => {
    const f = await fixture();
    const review = await preview([f.nativeBatch]);
    await pool.query("UPDATE transactions SET amount=81 WHERE id=$1", [f.transactionId]);
    await expect(commitReviewedPortfolioImports({ batchIds: [f.nativeBatch], adoptPolicy: "prefer_source", reconciliationScope: "correct_existing_only", expectedPlanFingerprint: review.planFingerprint }))
      .rejects.toThrow("Portfolio history or source selection changed");
    expect(await journalCount(f)).toBe(0);
    expect((await readReconciliationSources([f.nativeBatch]))[0]!.status).toBe("matched");
    expect(await image(f.transactionId)).toMatchObject({ amount: "81.0000", currency: "EUR" });
  });
  it("rolls back the whole correction set when a later cash update fails", async () => {
    const first = await fixture();
    const second = await fixture();
    const review = await preview([first.nativeBatch, second.nativeBatch]);
    expect(review.ready).toBe(true);
    await pool.query(`CREATE FUNCTION synthetic_funding_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.account_id=${Number(second.account)} AND NEW.currency='USD' THEN RAISE EXCEPTION 'Forced synthetic correction failure'; END IF; RETURN NEW; END $$`);
    await pool.query("CREATE TRIGGER synthetic_funding_failure BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION synthetic_funding_failure()");
    await expect(commitReviewedPortfolioImports({ batchIds: [first.nativeBatch, second.nativeBatch], adoptPolicy: "prefer_source", reconciliationScope: "correct_existing_only", expectedPlanFingerprint: review.planFingerprint }))
      .rejects.toThrow("Forced synthetic correction failure");
    for (const f of [first, second]) {
      expect(await image(f.transactionId)).toMatchObject({ amount: "80.0000", currency: "EUR" });
      expect(await journalCount(f)).toBe(0);
      expect((await readReconciliationSources([f.nativeBatch]))[0]!.status).toBe("matched");
      expect((await pool.query("SELECT rows_duplicate FROM portfolio_import_batches WHERE id=$1", [f.nativeBatch])).rows[0].rows_duplicate).toBe(0);
    }
  });
  it("rejects rollback after retained native evidence changes without removing history", async () => {
    const f = await fixture();
    await commit([f.nativeBatch]);
    const cash = await image(f.transactionId);
    const stock = await stockImage(f.transactionId);
    await pool.query("UPDATE portfolio_import_staging_rows SET note='Altered receipt source' WHERE batch_id=$1", [f.nativeBatch]);
    await expect(rollbackBatch(f.nativeBatch)).rejects.toThrow("Owned cash source or ledger image changed");
    expect(await image(f.transactionId)).toEqual(cash);
    expect(await stockImage(f.transactionId)).toEqual(stock);
    expect(await journalCount(f)).toBe(1);
  });
  it("binds a legacy owner through a retained context source, guards that reference, and restores without changing either original", async () => {
    const f = await fixture();
    const referenceBatch = Number((await pool.query(`INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,rows_duplicate,account_id,is_brokerage)
      VALUES('ibkr_transaction_history',$1,'complete',1,1,$2,true) RETURNING id`, [JSON.stringify(f.source.original.custom_config), f.account])).rows[0].id);
    owned.batches.push(referenceBatch);
    await sourceRow({ ...f.source.original, status: "duplicate" }, referenceBatch);
    await pool.query("UPDATE portfolio_import_batches SET custom_config=custom_config-'ibkr_source_context' WHERE id=$1", [f.originalBatch]);
    const owner = (await readReconciliationSources([f.originalBatch]))[0];
    const reference = (await readReconciliationSources([referenceBatch]))[0]!;
    expect(await commit([f.nativeBatch])).toMatchObject({ adopted: 1, imported: 0 });
    const journal = (await pool.query("SELECT * FROM portfolio_import_reconciliation_journal WHERE batch_id=$1", [f.nativeBatch])).rows[0];
    expect(journal.after_data.proof).toMatchObject({ original: { batchId: f.originalBatch, sourceFileHash: null, contextOrigin: "retained_repeat_source" },
      primaryReference: { batchId: referenceBatch, stagingRowId: Number(reference.id) } });
    expect(journal.after_data.proof.sourceBindings).toHaveLength(3);
    await expect(rollbackBatch(referenceBatch)).rejects.toThrow("Owned cash source or ledger image changed");
    expect(await rollbackBatch(f.nativeBatch)).toMatchObject({ deleted: 0 });
    expect((await readReconciliationSources([f.originalBatch]))[0]).toEqual(owner);
    expect((await readReconciliationSources([referenceBatch]))[0]).toEqual(reference);
    expect(await image(f.transactionId)).toMatchObject({ amount: "80.0000", currency: "EUR" });
  });
});
