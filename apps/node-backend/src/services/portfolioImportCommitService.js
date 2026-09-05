import { withTransaction } from "../database/connection.js";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.js";
import {
  lockBatchForUpdate,
  setBatchAccount,
} from "../repositories/portfolioImportBatchRepository.js";
import accountService from "./accountService.js";
import { commitPortfolioImport } from "./portfolioImportPipeline/index.js";

/**
 * Commit one reviewed batch while holding its batch-row lock. Account selection,
 * missing-account cash repair, and the commit's account read therefore share one
 * transaction and cannot be interleaved by a second recommit.
 *
 * @param {{ batchId: number, accountId?: number }} args
 */
export async function commitReviewedPortfolioImport({ batchId, accountId }) {
  return withTransaction(async () => {
    const batch = await lockBatchForUpdate(batchId);
    if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);
    if (
      !["awaiting_review", "matching", "complete_with_errors"].includes(
        batch.status,
      )
    ) {
      throw new ValidationError(
        `Batch ${batchId} is not in a reviewable state (status: ${batch.status})`,
      );
    }

    if (accountId !== undefined) {
      await accountService.get(accountId);
      await setBatchAccount(batchId, accountId);
    }

    return commitPortfolioImport({ batchId });
  });
}
