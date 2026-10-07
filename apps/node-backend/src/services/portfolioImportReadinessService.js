import { ConflictError } from "../middleware/errorHandler.ts";
import {
  getImportReadinessProblems,
  getManualPortfolioOverlaps,
  lockImportReadinessHistory,
} from "../repositories/portfolioImportBatchRepository.ts";

const MAINTAINED_ADAPTERS = new Set([
  "ibkr",
  "kinesis",
  "nexo",
  "saxo",
  "ibkr_transaction_history",
  "kinesis_transaction_history",
  "nexo_transaction_history",
  "nexo_pro_spot_history",
  "saxo_transaction_history",
  "portfolio_performance_reference",
]);

/** @param {{adapter_name?: string, custom_config?: object|string|null}} batch */
export function isMaintainedPortfolioImport(batch) {
  let config = batch.custom_config;
  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      config = undefined;
    }
  }
  const format = /** @type {{format?: unknown}|undefined|null} */ (config)
    ?.format;
  return [batch.adapter_name, format].some(
    (value) =>
      typeof value === "string" &&
      MAINTAINED_ADAPTERS.has(value.trim().toLowerCase()),
  );
}

/**
 * Maintained adapters must be complete and must not silently append a second
 * history beside legacy manual events. The caller holds the batch lock and an
 * ambient transaction. This is a preflight, not a reconciliation operation or
 * a guarantee against runtime errors caught by the existing row savepoints.
 *
 * @param {{ batchId: number, batch: {adapter_name?: string, custom_config?: object|string|null, account_id?: number|null}, accountId?: number|null, reconciliationPlanned?: boolean }} args
 */
export async function assertPortfolioImportReadiness({
  batchId,
  batch,
  accountId = batch.account_id,
  reconciliationPlanned = false,
}) {
  if (!isMaintainedPortfolioImport(batch)) return;

  const problems = await getImportReadinessProblems(batchId, accountId);
  if (problems.length > 0) {
    throw new ConflictError(
      `Import needs repair: ${problems.length} source rows are incomplete or unresolved. No new transactions were imported.`,
      {
        details: {
          reason: "incomplete_source",
          count: problems.length,
          row_ordinals: problems.map((row) => row.row_index + 1),
        },
      },
    );
  }

  // The locked multi-batch reconciliation planner owns the stricter one-to-one
  // overlap decision. Its caller must apply that plan before canonical commit.
  if (reconciliationPlanned) return;

  await lockImportReadinessHistory(accountId);
  const overlaps = await getManualPortfolioOverlaps(batchId, accountId);
  if (overlaps.length > 0) {
    throw new ConflictError(
      `Import needs reconciliation: ${overlaps.length} source rows may already exist in portfolio history. No new transactions were imported.`,
      {
        details: {
          reason: "existing_history_overlap",
          count: overlaps.length,
          row_ordinals: overlaps.map((row) => row.row_index + 1),
        },
      },
    );
  }
}
