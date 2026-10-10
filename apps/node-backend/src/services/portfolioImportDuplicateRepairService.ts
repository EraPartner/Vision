import { ConflictError } from "../middleware/errorHandler.ts";
import { isDeepStrictEqual } from "node:util";
import {
  compareAndSetReconciledTransaction,
  markAdoptedSourceDuplicate,
} from "../repositories/portfolioImportReconciliationRepository.ts";
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
} from "../repositories/portfolioImportDuplicateRepairRepository.ts";
import type {
  DuplicateRepairJournalRow,
  RepairBatchSnapshot,
} from "../repositories/portfolioImportDuplicateRepairRepository.ts";
import type {
  PortfolioTransactionSnapshot,
  ReconciliationSourceRow,
} from "../repositories/portfolioImportReconciliationRepository.ts";

export { getActiveDuplicateRepairReceipts };
/** The financial image of a full repair snapshot, without its timestamps. */
export function financialRepairImage<
  T extends { created_at?: unknown; updated_at?: unknown },
>(full: T): Omit<T, "created_at" | "updated_at"> {
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
}: {
  row: Pick<ReconciliationSourceRow, "id" | "batch_id">;
  before: PortfolioTransactionSnapshot;
  after: PortfolioTransactionSnapshot;
  imported: Pick<PortfolioTransactionSnapshot, "id" | "import_batch_id">;
  policy: DuplicateRepairJournalRow["policy"];
}): Promise<void> {
  const legacy = await readFullRepairTransaction(before.id);
  const existingCopy = await readFullRepairTransaction(imported.id);
  const originalBatchId = Number(imported.import_batch_id);
  const state = await readOriginalRepairState(originalBatchId, imported.id);
  const [source] = state.originalStaging;
  if (
    !legacy ||
    !existingCopy ||
    !same(financialRepairImage(legacy), before) ||
    !same(financialRepairImage(existingCopy), imported) ||
    state.originalStaging.length !== 1 ||
    !source ||
    source.status !== "committed" ||
    !state.originalBatch ||
    !["complete", "complete_with_errors"].includes(
      state.originalBatch.status,
    ) ||
    state.originalBatch.rows_imported < 1
  )
    throw conflict();
  const { originalBatch } = state;
  const receiptBefore = {
    legacy,
    imported: existingCopy,
    originalBatch,
    originalStaging: state.originalStaging,
  };
  // Clear the proven staging pointer before deleting its imported copy. The
  // foreign key otherwise clears it first and makes the guarded update stale.
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
  const changedBatch = await replaceRepairBatch(originalBatch, {
    ...originalBatch,
    rows_imported: originalBatch.rows_imported - 1,
    rows_duplicate: originalBatch.rows_duplicate + 1,
  });
  if (!changedBatch) throw conflict();
  // The legacy row was just updated under the caller's locks.
  const legacyAfter = await readFullRepairTransaction(before.id);
  if (!legacyAfter) throw conflict();
  const receiptAfter = {
    legacy: legacyAfter,
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
export async function validateDuplicatePortfolioRepairRollback(
  receipts: readonly DuplicateRepairJournalRow[],
): Promise<void> {
  const batches = new Map<number, RepairBatchSnapshot | undefined>();
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

export async function restoreDuplicatePortfolioRepairs(
  receipts: readonly DuplicateRepairJournalRow[],
): Promise<void> {
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
    for (const [index, previous] of before.originalStaging.entries()) {
      const current = after.originalStaging[index];
      // A journal whose after-image lacks this source row cannot be replayed.
      if (!current) throw conflict();
      const restored = await replaceRepairStaging(current, previous);
      if (!restored) throw conflict();
      restoredStaging.push(restored);
    }
    const restoredBatch = await replaceRepairBatch(
      after.originalBatch,
      before.originalBatch,
    );
    if (!restoredBatch) throw conflict();
    // Both rows were just written under the caller's locks.
    const legacy = await readFullRepairTransaction(
      receipt.legacy_transaction_id,
    );
    const imported = await readFullRepairTransaction(
      receipt.imported_transaction_id,
    );
    if (!legacy || !imported) throw conflict();
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
        legacy,
        imported,
        originalBatch: restoredBatch,
        originalStaging: restoredStaging,
      },
      previousEntryId: Number(receipt.id),
    });
  }
}
