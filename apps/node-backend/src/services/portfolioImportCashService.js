/** Coordinates pure cash evidence with owned inserts and rollback reads. */
import { ConflictError } from "../middleware/errorHandler.ts";
import {
  readReconciliationSources,
  readReconciliationBatchScope,
} from "../repositories/portfolioImportReconciliationRepository.ts";
import {
  insertKinesisCash,
  readCashImagesForUpdate,
} from "../repositories/portfolioImportCashRepository.js";
import { portfolioPrimaryRawData } from "./portfolioPerformanceReferenceEvidence.js";
import {
  cashReceipt,
  cashImageEqual,
  proveKinesisCashSources,
  cashFeeFingerprint,
} from "./portfolioKinesisCashScope.js";
const stale = () =>
  new ConflictError("Owned cash source or ledger image changed", {
    details: { reason: "cash_receipt_changed" },
  });
/** @typedef {import('../repositories/portfolioImportCashRepository.js').KinesisCashValues} KinesisCashValues */

/**
 * @param {{ row: any, values: KinesisCashValues, proof: any, feeValues?: KinesisCashValues }} member
 *   a proven cash group member (see proveKinesisCashSources)
 */
export function recordKinesisCash(member) {
  return insertKinesisCash({
    ...member,
    primaryRawData: portfolioPrimaryRawData(member.row.raw_data),
    feeFingerprint: member.feeValues
      ? cashFeeFingerprint(member.row)
      : undefined,
  });
}
/** Validate the entire owned removal set before the first ledger delete. */
/**
 * @param {number} batchId
 * @returns {Promise<number[]>} the owned transaction ids to remove
 */
export async function validateKinesisCashRollback(batchId) {
  const sources = await readReconciliationSources([batchId]);
  const owned = sources.filter((row) => cashReceipt(row));
  if (!owned.length) return [];
  const batches = await readReconciliationBatchScope([batchId]);
  const evidence = proveKinesisCashSources(
    sources,
    batches,
    "own_account_transfer",
  );
  if (
    evidence.blockers.length ||
    owned.some((row) => !evidence.proofs.has(Number(row.id)))
  )
    throw stale();
  const ids = owned.flatMap((row) =>
    [cashReceipt(row).after.id, cashReceipt(row).feeAfter?.id].filter(
      (id) => id != null,
    ),
  );
  if (new Set(ids).size !== ids.length) throw stale();
  const current = await readCashImagesForUpdate(ids);
  for (const row of owned) {
    const receipt = cashReceipt(row);
    const member = evidence.groups
      .flatMap((group) => group.members)
      .find((item) => item.row.id === row.id);
    if (
      receipt.version !== 1 ||
      row.status !== "committed" ||
      Number(row.committed_txn_id) !== receipt.after.id ||
      !cashImageEqual(receipt.proof, member.proof) ||
      !cashImageEqual(receipt.values, member.values) ||
      !cashImageEqual(receipt.feeValues, member.feeValues) ||
      (member.feeValues &&
        (!receipt.feeAfter ||
          receipt.feeAfter.dedup_fingerprint !== cashFeeFingerprint(row) ||
          !cashImageEqual(
            receipt.feeAfter,
            current.find((item) => item.id === receipt.feeAfter.id),
          ))) ||
      !cashImageEqual(
        receipt.after,
        current.find((item) => item.id === receipt.after.id),
      )
    )
      throw stale();
  }
  return ids;
}
