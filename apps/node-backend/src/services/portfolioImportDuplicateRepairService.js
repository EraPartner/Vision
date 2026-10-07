import { ConflictError } from "../middleware/errorHandler.ts";
import { isDeepStrictEqual } from "node:util";
import {
  compareAndSetReconciledTransaction,
  markAdoptedSourceDuplicate,
} from "../repositories/portfolioImportReconciliationRepository.js";
import {
  deleteExactImportedCopy,
  getActiveDuplicateRepairReceipts,
  insertDuplicateRepairReceipt,
  readFullRepairTransaction,
  readOriginalRepairState,
  readRepairStagingByIds as readOriginalRepairStateByIds,
  replaceRepairBatch,
  replaceRepairStaging,
  restoreExactImportedCopy,
} from "../repositories/portfolioImportDuplicateRepairRepository.js";

export { getActiveDuplicateRepairReceipts };
export function financialRepairImage(full) {
  const { created_at: _created, updated_at: _updated, ...financial } = full;
  return financial;
}
const same = isDeepStrictEqual;
const conflict = () =>
  new ConflictError(
    "Duplicate repair history or provenance changed. Review is required.",
    { details: { reason: "duplicate_repair_changed" } },
  );

/** Caller holds sorted source-batch, account and portfolio writer locks. */
export async function applyDuplicatePortfolioRepair({
  row,
  before,
  after,
  imported,
  policy,
}) {
  const legacy = await readFullRepairTransaction(before.id);
  const existingCopy = await readFullRepairTransaction(imported.id);
  const originalBatchId = Number(imported.import_batch_id);
  const state = await readOriginalRepairState(originalBatchId, imported.id);
  if (
    !legacy ||
    !existingCopy ||
    !same(financialRepairImage(legacy), before) ||
    !same(financialRepairImage(existingCopy), imported) ||
    state.originalStaging.length !== 1 ||
    state.originalStaging[0].status !== "committed" ||
    !["complete", "complete_with_errors"].includes(
      state.originalBatch?.status,
    ) ||
    state.originalBatch.rows_imported < 1
  )
    throw conflict();
  const receiptBefore = { legacy, imported: existingCopy, ...state };
  // Clear the proven staging pointer before deleting its imported copy. The
  // foreign key otherwise clears it first and makes the guarded update stale.
  const source = state.originalStaging[0];
  const changedSource = await replaceRepairStaging(source, {
    ...source,
    status: "duplicate",
    committed_txn_id: null,
  });
  if (!changedSource) throw conflict();
  if (!(await deleteExactImportedCopy(existingCopy))) throw conflict();
  if (
    !(await compareAndSetReconciledTransaction(
      before,
      after,
      legacy.updated_at,
    ))
  )
    throw conflict();
  const changedBatch = await replaceRepairBatch(state.originalBatch, {
    ...state.originalBatch,
    rows_imported: state.originalBatch.rows_imported - 1,
    rows_duplicate: state.originalBatch.rows_duplicate + 1,
  });
  if (!changedBatch) throw conflict();
  const receiptAfter = {
    legacy: await readFullRepairTransaction(before.id),
    imported: null,
    originalBatch: changedBatch,
    originalStaging: [changedSource],
  };
  await insertDuplicateRepairReceipt({
    batchId: Number(row.batch_id),
    stagingRowId: Number(row.id),
    originalBatchId,
    legacyId: Number(before.id),
    importedId: Number(imported.id),
    action: "repair",
    policy,
    before: receiptBefore,
    after: receiptAfter,
  });
  await markAdoptedSourceDuplicate(Number(row.id), Number(row.batch_id));
}

/** Compare every after-image before any normal batch deletion or restoration. */
export async function validateDuplicatePortfolioRepairRollback(receipts) {
  const batches = new Map();
  for (const receipt of receipts) {
    const legacy = await readFullRepairTransaction(
      receipt.legacy_transaction_id,
    );
    if (
      !same(legacy, receipt.after_data.legacy) ||
      (await readFullRepairTransaction(receipt.imported_transaction_id))
    )
      throw conflict();
    const original = await readOriginalRepairState(
      Number(receipt.original_import_batch_id),
      receipt.imported_transaction_id,
    );
    // Cleared pointers mean the generic lookup finds no row after repair. Read
    // the known source rows by their preserved IDs instead.
    const currentSource = await readOriginalRepairStateByIds(
      receipt.after_data.originalStaging,
    );
    if (!same(currentSource, receipt.after_data.originalStaging))
      throw conflict();
    const currentBatch =
      batches.get(Number(receipt.original_import_batch_id)) ??
      original.originalBatch;
    if (!same(currentBatch, receipt.after_data.originalBatch)) throw conflict();
    batches.set(
      Number(receipt.original_import_batch_id),
      receipt.before_data.originalBatch,
    );
  }
}

export async function restoreDuplicatePortfolioRepairs(receipts) {
  for (const receipt of receipts) {
    const before = receipt.before_data;
    const after = receipt.after_data;
    if (
      !(await compareAndSetReconciledTransaction(
        financialRepairImage(after.legacy),
        financialRepairImage(before.legacy),
        after.legacy.updated_at,
      ))
    )
      throw conflict();
    if (!(await restoreExactImportedCopy(before.imported))) throw conflict();
    const restoredStaging = [];
    for (let index = 0; index < before.originalStaging.length; index++) {
      const restored = await replaceRepairStaging(
        after.originalStaging[index],
        before.originalStaging[index],
      );
      if (!restored) throw conflict();
      restoredStaging.push(restored);
    }
    const restoredBatch = await replaceRepairBatch(
      after.originalBatch,
      before.originalBatch,
    );
    if (!restoredBatch) throw conflict();
    await insertDuplicateRepairReceipt({
      batchId: Number(receipt.batch_id),
      stagingRowId: Number(receipt.staging_row_id),
      originalBatchId: Number(receipt.original_import_batch_id),
      legacyId: Number(receipt.legacy_transaction_id),
      importedId: Number(receipt.imported_transaction_id),
      action: "restore",
      policy: receipt.policy,
      before: after,
      after: {
        legacy: await readFullRepairTransaction(receipt.legacy_transaction_id),
        imported: await readFullRepairTransaction(
          receipt.imported_transaction_id,
        ),
        originalBatch: restoredBatch,
        originalStaging: restoredStaging,
      },
      previousEntryId: Number(receipt.id),
    });
  }
}
