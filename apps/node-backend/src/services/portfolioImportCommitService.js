import { withTransaction } from "../database/connection.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../middleware/errorHandler.ts";
import {
  lockBatchForUpdate,
  setBatchAccount,
  finalizeAdoptionOnlyBatch,
} from "../repositories/portfolioImportBatchRepository.ts";
import { commitPortfolioImport } from "./portfolioImportPipeline/index.js";
import { assertPortfolioImportAccount } from "./portfolioImportAccountService.js";
import {
  assertPortfolioImportReadiness,
  isMaintainedPortfolioImport,
} from "./portfolioImportReadinessService.js";
import {
  applyPortfolioImportReconciliation,
  getPortfolioImportRepairBatchIds,
  getPortfolioImportCompanionRowIds,
  getPortfolioImportScopedSelection,
  completePortfolioImportIncome,
  completePortfolioImportNativeGiftGroups,
} from "./portfolioImportReconciliationService.js";
import { lockReconciliationAccountsAndHistory } from "../repositories/portfolioImportReconciliationRepository.ts";
import { readReconciliationSources } from "../repositories/portfolioImportReconciliationRepository.ts";
import { invalidatePortfolioCaches } from "./info/cache.js";
import {
  previewPortfolioAssetTransfer,
  validatePortfolioAssetTransferHistory,
} from "./portfolio/portfolioAssetTransferService.js";
import { previewPortfolioAssetAdjustment } from "./portfolio/portfolioAssetAdjustmentService.js";
import { withPortfolioCustodyImportScope } from "./portfolio/portfolioCustodyImportScope.js";
import { getEligibleYieldSourceHashes } from "../repositories/portfolioAssetAdjustmentRepository.ts";

function assertReviewable(batch, batchId) {
  if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);
  if (
    !["awaiting_review", "matching", "complete_with_errors"].includes(
      batch.status,
    )
  )
    throw new ValidationError(
      `Batch ${batchId} is not in a reviewable state (status: ${batch.status})`,
    );
}

import { lockKinesisCashLedger } from "../repositories/portfolioImportCashRepository.js";
import { scheduleRefresh } from "./materializedViewService.js";

async function commitLockedScope(
  batches,
  adoptPolicy,
  expectedPlanFingerprint,
  batchPolicies = [],
  lockedBatchIds = batches.map((batch) => Number(batch.id)),
  reconciliationScope = "full",
  cashFundingPolicy = undefined,
) {
  const ids = batches.map((batch) => Number(batch.id));
  const sourceRows = await readReconciliationSources(ids);
  const preliminary =
    reconciliationScope === "full"
      ? await getPortfolioImportScopedSelection({
          batchIds: ids,
          adoptPolicy,
          batchPolicies,
        })
      : undefined;
  const accountIds = [
    ...new Set(
      [
        ...sourceRows.map((row) => row.asset_adjustment_details?.accountId),
        ...(preliminary?.actions ?? []).flatMap((action) => [
          action.transfer?.sourceAccountId,
          action.transfer?.destinationAccountId,
          action.adjustment?.accountId,
        ]),
        ...batches.flatMap((batch) => [
          batch.account_id,
          batch.custom_config?.transfer_destination_account_id,
          batch.custom_config?.transfer_origin_account_id,
        ]),
      ].filter((id) => id != null),
    ),
  ].sort((a, b) => a - b);
  // Existing broker-retag/account-lifecycle lock order: accounts, then writers.
  for (const accountId of accountIds)
    await assertPortfolioImportAccount(accountId);
  await lockReconciliationAccountsAndHistory(accountIds);
  if (
    reconciliationScope === "record_cash_only" ||
    (reconciliationScope === "full" &&
      batches.some(
        (batch) =>
          batch.custom_config?.format === "kinesis_transaction_history",
      ))
  )
    await lockKinesisCashLedger(accountIds);
  // A close or type change can commit while we wait for its account row. The
  // routing decision must use the state protected by the acquired locks.
  for (const accountId of accountIds)
    await assertPortfolioImportAccount(accountId);
  const provedCompanionRowIds = await getPortfolioImportCompanionRowIds({
    batchIds: ids,
    adoptPolicy,
    batchPolicies,
    reconciliationScope,
    cashFundingPolicy,
  });
  const selection =
    reconciliationScope !== "full"
      ? await getPortfolioImportScopedSelection({
          batchIds: ids,
          adoptPolicy,
          batchPolicies,
          reconciliationScope,
          cashFundingPolicy,
        })
      : undefined;
  for (const batch of batches)
    await assertPortfolioImportReadiness({
      batchId: Number(batch.id),
      batch,
      accountId: batch.account_id,
      reconciliationPlanned: true,
      provedCompanionRowIds,
      selectedRowIds: selection?.selectedRowIds,
    });
  const {
    plan,
    adoptedByBatch,
    repairedByBatch,
    companionsByBatch,
    recordedIncomeByBatch,
    recordedCashByBatch,
    deferredIncomeRowIds,
    nativeGiftGroups,
  } = await applyPortfolioImportReconciliation({
    batchIds: ids,
    adoptPolicy,
    expectedPlanFingerprint,
    batchPolicies,
    lockedBatchIds,
    reconciliationScope,
    cashFundingPolicy,
  });
  if (reconciliationScope !== "full") {
    const results = [];
    for (const batch of batches) {
      const progress = plan.batchProgress.find(
        (entry) => entry.batchId === Number(batch.id),
      );
      if (
        !(await finalizeAdoptionOnlyBatch(
          Number(batch.id),
          progress.pending,
          progress.complete,
        ))
      )
        throw new ConflictError("Adoption scope source changed during commit", {
          details: { reason: "stale_reconciliation_plan" },
        });
      const adopted = adoptedByBatch.get(Number(batch.id)) ?? 0;
      const recordedIncome = recordedIncomeByBatch.get(Number(batch.id)) ?? 0;
      const recordedCash = recordedCashByBatch.get(Number(batch.id)) ?? 0;
      results.push({
        ...(reconciliationScope === "record_cash_only" ? { recordedCash } : {}),
        ...(reconciliationScope === "record_in_kind_income_only"
          ? { recordedIncome }
          : {}),
        batch_id: Number(batch.id),
        imported: recordedIncome + recordedCash,
        duplicates: adopted + (companionsByBatch.get(Number(batch.id)) ?? 0),
        adopted,
        repaired: 0,
        errors: 0,
        reconciliationScope,
        pending: progress.pending,
        complete: progress.complete,
        deferredCounts: progress.deferredCounts,
      });
    }
    return {
      batches: results,
      ...(reconciliationScope === "record_cash_only"
        ? {
            recordedCash: results.reduce(
              (count, result) => count + result.imported,
              0,
            ),
          }
        : {}),
      ...(reconciliationScope === "record_in_kind_income_only"
        ? {
            recordedIncome: results.reduce(
              (count, result) => count + result.imported,
              0,
            ),
          }
        : {}),
      imported: results.reduce((count, result) => count + result.imported, 0),
      duplicates: results.reduce(
        (count, result) => count + result.duplicates,
        0,
      ),
      adopted: results.reduce((count, result) => count + result.adopted, 0),
      repaired: 0,
      errors: 0,
      reconciliationScope,
      selectedRowIds: plan.selectedRowIds,
      pending: plan.pending,
      complete: plan.complete,
      deferredCounts: plan.deferredCounts,
    };
  }
  const scheduledRows = (await readReconciliationSources(ids))
    .filter(
      (row) =>
        row.status === "matched" &&
        !deferredIncomeRowIds.includes(Number(row.id)),
    )
    .sort(
      (left, right) =>
        left.tx_date.localeCompare(right.tx_date) ||
        Number(left.batch_id) - Number(right.batch_id) ||
        left.row_index - right.row_index,
    );
  const runs = [];
  for (const row of scheduledRows) {
    const batchId = Number(row.batch_id);
    if (runs.at(-1)?.batchId !== batchId) runs.push({ batchId, rowIds: [] });
    runs.at(-1).rowIds.push(Number(row.id));
  }
  const results = batches.map((batch) => ({
    batch_id: Number(batch.id),
    imported: 0,
    duplicates:
      (adoptedByBatch.get(Number(batch.id)) ?? 0) +
      (repairedByBatch.get(Number(batch.id)) ?? 0) +
      (companionsByBatch.get(Number(batch.id)) ?? 0),
    adopted: adoptedByBatch.get(Number(batch.id)) ?? 0,
    repaired: repairedByBatch.get(Number(batch.id)) ?? 0,
    errors: 0,
    recordedIncome: 0,
    recordedCash: 0,
  }));
  const custodyEvents = [];
  for (const row of scheduledRows.filter((row) =>
    ["asset_transfer", "asset_adjustment"].includes(row.route),
  )) {
    const prepared =
      row.route === "asset_transfer"
        ? previewPortfolioAssetTransfer(row)
        : previewPortfolioAssetAdjustment(row, undefined, {
            sourceRows: scheduledRows,
          });
    if (prepared.error || !prepared.event)
      throw new ConflictError(
        "Reviewed custody source changed during commit preparation",
      );
    if (
      prepared.event.type === "asset_adjustment" &&
      prepared.event.adjustment_kind === "yield_reversal"
    )
      prepared.event.eligible_source_record_hashes =
        await getEligibleYieldSourceHashes(
          prepared.event.investment_id,
          prepared.event.account_id,
        );
    custodyEvents.push(prepared.event);
  }
  return withPortfolioCustodyImportScope(
    {
      events: custodyEvents,
      validateHistory: validatePortfolioAssetTransferHistory,
    },
    async () => {
      for (const { batchId, rowIds } of runs) {
        const result = await commitPortfolioImport({ batchId, rowIds });
        if (result.errors > 0)
          throw new ConflictError(
            "Import failed its atomic commit. No history changes were retained.",
            {
              details: {
                reason: "atomic_import_failed",
                batch_id: batchId,
                errors: result.errors,
              },
            },
          );
        const total = results.find((entry) => entry.batch_id === batchId);
        total.imported += result.imported;
        total.duplicates += result.duplicates;
      }
      await completePortfolioImportNativeGiftGroups(nativeGiftGroups);
      // Close fully drained generic receipt batches inside this transaction.
      // Income reproof must never treat an unfinished prior owner as active.
      for (const batchId of [
        ...new Set(
          nativeGiftGroups.flatMap((group) =>
            group.members.map((row) => Number(row.batch_id)),
          ),
        ),
      ]) {
        const result = await commitPortfolioImport({ batchId });
        if (
          result.errors > 0 ||
          result.imported !== 0 ||
          result.duplicates !== 0
        )
          throw new ConflictError(
            "Native receipt batch did not finish atomically",
            { details: { reason: "atomic_import_failed" } },
          );
      }
      const incomeCounts = await completePortfolioImportIncome({
        batchIds: ids,
        rowIds: deferredIncomeRowIds,
        adoptPolicy,
        batchPolicies,
      });
      for (const result of results) {
        result.recordedIncome = incomeCounts.get(result.batch_id) ?? 0;
        result.imported += result.recordedIncome;
      }
      // Empty/adopted-only batches still need truthful terminal status. These calls
      // find no matched rows and preserve the counters already persisted by runs.
      for (const batch of batches) {
        const result = await commitPortfolioImport({
          batchId: Number(batch.id),
        });
        if (result.errors > 0)
          throw new ConflictError(
            "Import failed its atomic commit. No history changes were retained.",
            {
              details: {
                reason: "atomic_import_failed",
                batch_id: Number(batch.id),
                errors: result.errors,
              },
            },
          );
      }
      return {
        batches: results,
        imported: results.reduce((count, result) => count + result.imported, 0),
        duplicates: results.reduce(
          (count, result) => count + result.duplicates,
          0,
        ),
        adopted: results.reduce((count, result) => count + result.adopted, 0),
        repaired: results.reduce((count, result) => count + result.repaired, 0),
        errors: 0,
        recordedIncome: results.reduce(
          (count, result) => count + result.recordedIncome,
          0,
        ),
        recordedCash: 0,
      };
    },
  );
}

/** Commit a reviewed complete source scope in one transaction. */
export async function commitReviewedPortfolioImports({
  batchIds,
  adoptPolicy,
  expectedPlanFingerprint,
  batchPolicies = [],
  reconciliationScope = "full",
  cashFundingPolicy = undefined,
}) {
  if (
    !Array.isArray(batchIds) ||
    batchIds.length === 0 ||
    batchIds.length > 100 ||
    batchIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    throw new ValidationError(
      "batch_ids must contain 1 to 100 positive import batch IDs",
    );
  const ids = [...new Set(batchIds)].sort((a, b) => a - b);
  return withTransaction(async () => {
    const repairBatchIds = await getPortfolioImportRepairBatchIds({
      batchIds: ids,
      adoptPolicy,
      batchPolicies,
      reconciliationScope,
      cashFundingPolicy,
    });
    const lockedIds = [...new Set([...ids, ...repairBatchIds])].sort(
      (a, b) => a - b,
    );
    const locked = new Map();
    for (const batchId of lockedIds) {
      const batch = await lockBatchForUpdate(batchId);
      if (ids.includes(batchId)) assertReviewable(batch, batchId);
      if (!batch) throw new NotFoundError(`Import batch ${batchId} not found`);
      locked.set(batchId, { ...batch, id: batchId });
    }
    const batches = ids.map((id) => locked.get(id));
    return commitLockedScope(
      batches,
      adoptPolicy,
      expectedPlanFingerprint,
      batchPolicies,
      lockedIds,
      reconciliationScope,
      cashFundingPolicy,
    );
  }).then((result) => {
    invalidatePortfolioCaches();
    if (result.recordedCash > 0) scheduleRefresh();
    return result;
  });
}

/**
 * Commit one reviewed batch while holding its batch-row lock. Account selection,
 * missing-account cash repair, and the commit's account read therefore share one
 * transaction and cannot be interleaved by a second recommit.
 *
 * @param {{ batchId: number, accountId?: number, adoptPolicy?: string, expectedPlanFingerprint?: string }} args
 */
export async function commitReviewedPortfolioImport({
  batchId,
  accountId,
  adoptPolicy,
  expectedPlanFingerprint,
}) {
  return withTransaction(async () => {
    const batch = await lockBatchForUpdate(batchId);
    assertReviewable(batch, batchId);

    if (accountId !== undefined) {
      await assertPortfolioImportAccount(accountId);
      await setBatchAccount(batchId, accountId);
    }

    if (isMaintainedPortfolioImport(batch) || adoptPolicy !== undefined) {
      const result = await commitLockedScope(
        [{ ...batch, id: batchId, account_id: accountId ?? batch.account_id }],
        adoptPolicy,
        expectedPlanFingerprint,
      );
      const { imported, duplicates, errors } = result.batches[0];
      return { imported, duplicates, errors };
    }

    await assertPortfolioImportReadiness({
      batchId,
      batch,
      accountId: accountId ?? batch.account_id,
    });

    return commitPortfolioImport({ batchId });
  }).then((result) => {
    invalidatePortfolioCaches();
    return result;
  });
}
