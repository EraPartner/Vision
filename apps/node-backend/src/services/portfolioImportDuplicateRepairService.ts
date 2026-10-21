/**
 * Undo of duplicate repairs applied before ADR-236. New imports no longer
 * repair an imported copy against a manual twin; existing repair receipts stay
 * reversible through batch rollback.
 */
import { ConflictError } from "../middleware/errorHandler.ts";
import { isDeepStrictEqual } from "node:util";
import { compareAndSetReconciledTransaction } from "../repositories/portfolioImportReconciliationRepository.ts";
import {
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
