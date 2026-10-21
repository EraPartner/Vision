import { withTransaction } from "../database/connection.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../middleware/errorHandler.ts";
import {
  lockBatchForUpdate,
  setBatchAccount,
} from "../repositories/portfolioImportBatchRepository.ts";
import { batchConfigFields } from "../database/rows/portfolioImport.ts";
import { commitPortfolioImport } from "./portfolioImportPipeline/index.ts";
import { assertPortfolioImportAccount } from "./portfolioImportAccountService.ts";
import {
  assertPortfolioImportReadiness,
  isMaintainedPortfolioImport,
} from "./portfolioImportReadinessService.ts";
import {
  applyPortfolioImportReconciliation,
  getPortfolioImportPlanAccountIds,
} from "./portfolioImportReconciliationService.ts";
import {
  lockReconciliationAccountsAndHistory,
  readReconciliationSources,
} from "../repositories/portfolioImportReconciliationRepository.ts";
import { invalidatePortfolioCaches } from "./info/cache.ts";
import {
  previewPortfolioAssetTransfer,
  validatePortfolioAssetTransferHistory,
} from "./portfolio/portfolioAssetTransferService.ts";
import { previewPortfolioAssetAdjustment } from "./portfolio/portfolioAssetAdjustmentService.ts";
import { withPortfolioCustodyImportScope } from "./portfolio/portfolioCustodyImportScope.ts";
import { getEligibleYieldSourceHashes } from "../repositories/portfolioAssetAdjustmentRepository.ts";
import type { PortfolioImportBatchLockRow } from "../repositories/portfolioImportBatchRepository.ts";
import type {
  BatchPolicy,
  RowChoice,
} from "./portfolioImportReconciliationService.ts";
import type { AssetTransferEvent } from "./portfolio/portfolioAssetTransferService.ts";
import type { AssetAdjustmentEvent } from "./portfolio/portfolioAssetAdjustmentService.ts";
import { firstNonZero } from "../lib/math.ts";
import { asAccountId } from "@vision/types/brands";
import type { AccountId } from "@vision/types/brands";
import { scheduleRefresh } from "./materializedViewService.ts";
import { scheduleReconcile } from "./transferReconciliationService.ts";

/** A batch row locked for the commit, with its id. */
type LockedBatch = PortfolioImportBatchLockRow & { id: number };

function assertReviewable(
  batch: PortfolioImportBatchLockRow | undefined,
  batchId: number,
): asserts batch is PortfolioImportBatchLockRow {
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

function atomicFailure(batchId: number, errors: number) {
  return new ConflictError(
    "Import failed its atomic commit. No history changes were retained.",
    {
      details: { reason: "atomic_import_failed", batch_id: batchId, errors },
    },
  );
}

async function commitLockedScope(
  batches: LockedBatch[],
  adoptPolicy: string | undefined,
  batchPolicies: BatchPolicy[] = [],
  rowChoices: RowChoice[] = [],
) {
  const ids = batches.map((batch) => Number(batch.id));
  const sourceRows = await readReconciliationSources(ids);
  const planAccountIds = await getPortfolioImportPlanAccountIds({
    batchIds: ids,
    adoptPolicy,
    batchPolicies,
    rowChoices,
  });
  const accountIds = [
    ...new Set(
      [
        ...sourceRows.map((row) => row.asset_adjustment_details?.accountId),
        ...planAccountIds,
        ...batches.flatMap((batch) => [
          batch.account_id,
          batchConfigFields(batch.custom_config)
            ?.transfer_destination_account_id,
          batchConfigFields(batch.custom_config)?.transfer_origin_account_id,
        ]),
      ].filter((id) => id != null),
    ),
  ]
    .sort((a, b) => a - b)
    // Stored review JSON names these accounts; the asserts below check them.
    .map(asAccountId);
  // Existing broker-retag/account-lifecycle lock order: accounts, then writers.
  for (const accountId of accountIds)
    await assertPortfolioImportAccount(accountId);
  await lockReconciliationAccountsAndHistory(accountIds);
  // A close or type change can commit while we wait for its account row. The
  // routing decision must use the state protected by the acquired locks.
  for (const accountId of accountIds)
    await assertPortfolioImportAccount(accountId);
  // Apply first: rows that another export already records (a Saxo CSV
  // dividend beside its workbook, say) settle here, and readiness then checks
  // what the canonical commit still has to write. Any failure rolls back both.
  const assertReady = async () => {
    for (const batch of batches)
      await assertPortfolioImportReadiness({
        batchId: Number(batch.id),
        batch,
        accountId: batch.account_id,
        reconciliationPlanned: true,
      });
  };
  let applied;
  try {
    applied = await applyPortfolioImportReconciliation({
      batchIds: ids,
      adoptPolicy,
      batchPolicies,
      rowChoices,
    });
  } catch (error) {
    // An unready plan writes nothing. Report the source-level reason (an
    // incomplete row, say) when readiness has one, as it did before.
    if (
      error instanceof ConflictError &&
      (error.details as { reason?: string } | undefined)?.reason ===
        "reconciliation_required"
    )
      await assertReady();
    throw error;
  }
  const { adoptedByBatch, settledByBatch } = applied;
  await assertReady();
  const scheduledRows = (await readReconciliationSources(ids))
    .filter((row) => row.status === "matched")
    .sort((left, right) =>
      // Matched rows carry their source date.
      firstNonZero(
        left.tx_date!.localeCompare(right.tx_date!),
        Number(left.batch_id) - Number(right.batch_id),
        left.row_index - right.row_index,
      ),
    );
  const runs: Array<{ batchId: number; rowIds: number[] }> = [];
  for (const row of scheduledRows) {
    const batchId = Number(row.batch_id);
    if (runs.at(-1)?.batchId !== batchId) runs.push({ batchId, rowIds: [] });
    runs.at(-1)!.rowIds.push(Number(row.id));
  }
  const results = batches.map((batch) => ({
    batch_id: Number(batch.id),
    imported: 0,
    duplicates: settledByBatch.get(Number(batch.id)) ?? 0,
    adopted: adoptedByBatch.get(Number(batch.id)) ?? 0,
    errors: 0,
  }));
  const custodyEvents: Array<AssetTransferEvent | AssetAdjustmentEvent> = [];
  for (const row of scheduledRows.filter(
    (row) =>
      row.route !== null &&
      ["asset_transfer", "asset_adjustment"].includes(row.route),
  )) {
    const prepared =
      row.route === "asset_transfer"
        ? previewPortfolioAssetTransfer(row)
        : previewPortfolioAssetAdjustment(row, undefined, {
            sourceRows: scheduledRows,
          });
    if (prepared.error || prepared.event == null)
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
        if (result.errors > 0) throw atomicFailure(batchId, result.errors);
        // Every run belongs to one of the selected batches.
        const total = results.find((entry) => entry.batch_id === batchId)!;
        total.imported += result.imported;
        total.duplicates += result.duplicates;
      }
      // Empty/adopted-only batches still need truthful terminal status. These calls
      // find no matched rows and preserve the counters already persisted by runs.
      for (const batch of batches) {
        const result = await commitPortfolioImport({
          batchId: Number(batch.id),
        });
        if (result.errors > 0)
          throw atomicFailure(Number(batch.id), result.errors);
      }
      return {
        batches: results,
        imported: results.reduce((count, result) => count + result.imported, 0),
        duplicates: results.reduce(
          (count, result) => count + result.duplicates,
          0,
        ),
        adopted: results.reduce((count, result) => count + result.adopted, 0),
        errors: 0,
      };
    },
  );
}

/** Commit a reviewed set of import batches in one transaction. */
export async function commitReviewedPortfolioImports({
  batchIds,
  adoptPolicy,
  batchPolicies = [],
  rowChoices = [],
}: {
  batchIds: number[];
  adoptPolicy?: string | undefined;
  batchPolicies?: BatchPolicy[] | undefined;
  rowChoices?: RowChoice[] | undefined;
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
    const batches: LockedBatch[] = [];
    for (const batchId of ids) {
      const batch = await lockBatchForUpdate(batchId);
      assertReviewable(batch, batchId);
      batches.push({ ...batch, id: batchId });
    }
    return commitLockedScope(batches, adoptPolicy, batchPolicies, rowChoices);
  }).then((result) => {
    invalidatePortfolioCaches();
    if (result.adopted > 0) {
      scheduleRefresh();
      scheduleReconcile();
    }
    return result;
  });
}

/**
 * Commit one reviewed batch while holding its batch-row lock. Account selection,
 * missing-account cash repair, and the commit's account read therefore share one
 * transaction and cannot be interleaved by a second recommit.
 */
export async function commitReviewedPortfolioImport({
  batchId,
  accountId,
  adoptPolicy,
}: {
  batchId: number;
  accountId?: AccountId | undefined;
  adoptPolicy?: string | undefined;
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
      );
      // commitLockedScope reports one result per locked batch; one was passed.
      // This response has no adoption count: an adopted row settles a source
      // row, so it is reported among the duplicates here.
      const { imported, duplicates, adopted, errors } = result.batches[0]!;
      return { imported, duplicates: duplicates + adopted, errors };
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
