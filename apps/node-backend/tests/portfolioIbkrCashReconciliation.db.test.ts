import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";
import { acquireDbSuiteLock, releaseDbSuiteLock, getTestPool, hasTestDatabase, closeTestPool } from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { syntheticIbkrCashCorrection } from "./helpers/ibkrCashReconciliation.ts";
import { readReconciliationSources, readReconciliationBatchScope } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import { __CASH_SNAPSHOT_SQL } from "../src/repositories/portfolioImportCashRepository.ts";
import {
  readIbkrCashCorrectionContext, proveIbkrCashCorrections, applyIbkrCashCorrection, settleIbkrCashCorrectionRepeat,
  validateIbkrCashCorrectionRollback, restoreIbkrCashCorrection, guardOriginalIbkrCashRollback, __findIbkrCashSourceAlias,
} from "../src/services/portfolioIbkrCashReconciliation.ts";

const pool = getTestPool()!;
const owned: { batches: number[]; accounts: number[]; recipients: number[] } = { batches: [], accounts: [], recipients: [] };
const fields = ["row_index", "status", "tx_date", "type_raw", "type", "route", "symbol_raw", "name_raw", "units", "price_per_unit",
  "amount", "fees", "taxes", "currency", "fx_rate_to_eur", "note", "raw_data", "source_record_hash", "source_transaction_id", "source_account_identity",
  "dedup_fingerprint", "dedup_fingerprint_version", "dedup_occurrence", "committed_txn_id"];
async function sourceRow(row: Record<string, unknown>, batchId: number, transactionId: number | null = null) {
  const params = [batchId, ...fields.map((field) => field === "committed_txn_id" ? transactionId : row[field] ?? null)];
  return Number((await pool.query(`INSERT INTO portfolio_import_staging_rows(batch_id,${fields.join(",")})
    VALUES(${params.map((_, index) => `$${index + 1}`).join(",")}) RETURNING id`, params)).rows[0].id);
}
async function fixture() {
  const source = syntheticIbkrCashCorrection();
  const account = (await pool.query("INSERT INTO accounts(name,type,currency) VALUES('Synthetic IBKR funding','brokerage','EUR') RETURNING id")).rows[0].id;
  owned.accounts.push(account);
  const recipient = (await pool.query("INSERT INTO recipients(name,normalized_name) VALUES('Synthetic funding institution','synthetic funding institution') RETURNING id")).rows[0].id;
  owned.recipients.push(recipient);
  const originalBatch = Number((await pool.query(`INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,rows_imported,account_id,is_brokerage)
    VALUES('ibkr_transaction_history',$1,'complete',1,1,$2,true) RETURNING id`, [JSON.stringify(source.original.custom_config), account])).rows[0].id);
  const nativeBatch = Number((await pool.query(`INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,account_id,is_brokerage)
    VALUES('ibkr_funding_history',$1,'awaiting_review',1,$2,true) RETURNING id`, [JSON.stringify(source.native.custom_config), account])).rows[0].id);
  owned.batches.push(originalBatch, nativeBatch);
  const transactionId = (await pool.query(`INSERT INTO transactions(date,amount,currency,memo,comment,account_id,recipient_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,is_active)
    VALUES('2026-01-01',80,'EUR',$1,'Keep user comment',$2,$3,$4,$5,1,true) RETURNING id`,
  [source.original.note, account, recipient, source.original.source_record_hash, source.original.dedup_fingerprint])).rows[0].id;
  await sourceRow(source.original, originalBatch, transactionId);
  await sourceRow(source.native, nativeBatch);
  return { account, transactionId, originalBatch, nativeBatch };
}
type Seeded = Awaited<ReturnType<typeof fixture>>;
async function plan(f: Seeded) {
  return proveIbkrCashCorrections(await readReconciliationSources([f.nativeBatch]), await readReconciliationBatchScope([f.nativeBatch]), await readIbkrCashCorrectionContext());
}
async function image(id: number) {
  return (await pool.query(`SELECT ${__CASH_SNAPSHOT_SQL} AS snapshot FROM transactions t WHERE t.id=$1`, [id])).rows[0]?.snapshot;
}
async function receipts(f: Seeded) {
  return (await pool.query("SELECT * FROM portfolio_import_reconciliation_journal WHERE batch_id=$1 ORDER BY id", [f.nativeBatch])).rows;
}
async function cleanup() {
  await pool.query("ALTER TABLE portfolio_import_reconciliation_journal DISABLE TRIGGER portfolio_import_reconciliation_immutable");
  try { await pool.query("DELETE FROM portfolio_import_reconciliation_journal WHERE batch_id=ANY($1::bigint[])", [owned.batches]); }
  finally { await pool.query("ALTER TABLE portfolio_import_reconciliation_journal ENABLE TRIGGER portfolio_import_reconciliation_immutable"); }
  await pool.query("DELETE FROM portfolio_import_batches WHERE id=ANY($1::bigint[])", [owned.batches]);
  await pool.query("DELETE FROM transactions WHERE account_id=ANY($1::integer[])", [owned.accounts]);
  await pool.query("DELETE FROM accounts WHERE id=ANY($1::integer[])", [owned.accounts]);
  await pool.query("DELETE FROM recipients WHERE id=ANY($1::integer[])", [owned.recipients]);
  owned.batches = []; owned.accounts = []; owned.recipients = [];
}

describe.skipIf(!hasTestDatabase())("IBKR native funding cash persistence", () => {
  beforeAll(acquireDbSuiteLock, 180000);
  afterEach(cleanup);
  afterAll(async () => { await releaseDbSuiteLock(); await closeTestPool(); await closePool(); });
  it("corrects the retained cash row, journals both images, and settles both source formats on repeat", async () => {
    const f = await fixture();
    const before = await image(f.transactionId);
    const selected = await plan(f);
    expect(selected.blockers).toEqual([]);
    await applyIbkrCashCorrection(selected.actions[0]);
    expect(await image(f.transactionId)).toMatchObject({ ...before, amount: "100.0000", currency: "USD", dedup_fingerprint: selected.actions[0].after.snapshot.dedup_fingerprint });
    const source = (await readReconciliationSources([f.originalBatch]))[0];
    expect(source).toMatchObject({ status: "committed", currency: "EUR", amount: "80.0000", committed_txn_id: f.transactionId });
    expect((await readReconciliationSources([f.nativeBatch]))[0]).toMatchObject({ status: "duplicate", committed_txn_id: null });
    expect(await __findIbkrCashSourceAlias(source)).toBe(f.transactionId);
    const repeated = await plan(f);
    expect(repeated).toMatchObject({ blockers: [], actions: [], duplicates: [{ settled: true, transactionId: f.transactionId }] });
    await settleIbkrCashCorrectionRepeat(repeated.duplicates[0]);
    expect(await receipts(f)).toHaveLength(1);
    expect((await pool.query("SELECT rows_duplicate FROM portfolio_import_batches WHERE id=$1", [f.nativeBatch])).rows[0].rows_duplicate).toBe(1);
  });
  it("rejects a stale financial image without journal, staging or batch changes", async () => {
    const f = await fixture();
    const selected = await plan(f);
    await pool.query("UPDATE transactions SET amount=81 WHERE id=$1", [f.transactionId]);
    await expect(applyIbkrCashCorrection(selected.actions[0])).rejects.toThrow("Owned cash source or ledger image changed");
    expect(await receipts(f)).toEqual([]);
    expect((await readReconciliationSources([f.nativeBatch]))[0].status).toBe("matched");
    expect((await image(f.transactionId)).amount).toBe("81.0000");
  });
  it("rejects a changed literal source atomically", async () => {
    const f = await fixture();
    const selected = await plan(f);
    await pool.query("UPDATE portfolio_import_staging_rows SET note='Edited after preview' WHERE batch_id=$1", [f.originalBatch]);
    await expect(applyIbkrCashCorrection(selected.actions[0])).rejects.toThrow("Owned cash source or ledger image changed");
    expect((await image(f.transactionId)).currency).toBe("EUR");
    expect(await receipts(f)).toEqual([]);
  });
  it("restores guarded cash images while preserving ordinary transfer metadata", async () => {
    const f = await fixture();
    const selected = await plan(f);
    await applyIbkrCashCorrection(selected.actions[0]);
    await expect(guardOriginalIbkrCashRollback(f.originalBatch)).rejects.toThrow("Owned cash source or ledger image changed");
    await pool.query("UPDATE transactions SET is_transfer=true,transfer_source='manual' WHERE id=$1", [f.transactionId]);
    const active = await validateIbkrCashCorrectionRollback(await receipts(f));
    await restoreIbkrCashCorrection(active[0]);
    expect(await image(f.transactionId)).toMatchObject({ amount: "80.0000", currency: "EUR", is_transfer: true, transfer_source: "manual" });
    await expect(guardOriginalIbkrCashRollback(f.originalBatch)).resolves.toBeUndefined();
    expect(await receipts(f)).toHaveLength(2);
  });
  it("refuses restoration after a financial or source change", async () => {
    const f = await fixture();
    await applyIbkrCashCorrection((await plan(f)).actions[0]);
    const receipt = (await receipts(f))[0];
    await pool.query("UPDATE transactions SET comment='Changed after adoption' WHERE id=$1", [f.transactionId]);
    await expect(validateIbkrCashCorrectionRollback([receipt])).rejects.toThrow("IBKR cash source or ledger image changed");
    await pool.query("UPDATE transactions SET comment='Keep user comment' WHERE id=$1", [f.transactionId]);
    await pool.query("UPDATE portfolio_import_staging_rows SET note='Changed source after adoption' WHERE batch_id=$1", [f.nativeBatch]);
    await expect(restoreIbkrCashCorrection(receipt)).rejects.toThrow("Owned cash source or ledger image changed");
    expect((await image(f.transactionId)).currency).toBe("USD");
    expect(await receipts(f)).toHaveLength(1);
  });
});
