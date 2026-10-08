import { lockKinesisCashLedger } from "../repositories/portfolioImportCashRepository.ts";
import { validateKinesisCashRollback } from "./portfolioImportCashService.js";
import { scheduleRefresh } from "./materializedViewService.js";
import {
  proveKinesisNetworkBindings,
  proveKinesisNativeGiftGroups,
} from "./portfolioKinesisNetworkProof.js";
import {
  restorePairedPortfolioIncomeForBatch,
  readPairedIncomeRollbackBatchIds,
} from "../repositories/portfolioIncomeRecognitionRepository.ts";
/**
 * Portfolio import batch service — the route-facing seam over
 * portfolioImportBatchRepository (eslint vision-local/no-repo-direct-from-route).
 *
 * Pure history and per-row override access is re-exported from the repository.
 * Preview assembly and the operations that coordinate multiple repositories —
 * creating a holding from a row and rollback — live here.
 */

import portfolioTransactionService from "./portfolio/portfolioTransactionService.ts";
import portfolioTransactionRepository from "../repositories/portfolioTransactionRepository.ts";
import investmentRepository from "../repositories/investmentRepository.ts";
import { rollbackPortfolioAssetTransfersForBatch } from "./portfolio/portfolioAssetTransferService.ts";
import { rollbackPortfolioAssetAdjustmentsForBatch } from "./portfolio/portfolioAssetAdjustmentService.ts";
import {
  getActiveDuplicateRepairReceipts,
  restoreDuplicatePortfolioRepairs,
} from "./portfolioImportDuplicateRepairService.js";
import { query, withTransaction } from "../database/connection.ts";
import { ConflictError } from "../middleware/errorHandler.ts";
import {
  restorePortfolioImportAdoptions,
  validatePortfolioImportAdoptionRollback,
} from "./portfolioImportReconciliationService.js";
import {
  getActiveAdoptionReceipts,
  lockReconciliationAccountsAndHistory,
  readReconciliationSources,
  readReconciliationBatchScope,
  assertNoActiveKinesisNetworkConsumers,
  readReconciliationHistory,
  readKinesisNetworkContext,
  readKinesisNativeGiftContext,
} from "../repositories/portfolioImportReconciliationRepository.ts";
import {
  getRowForInvestmentCreation,
  getPreviewRows,
  lockBatchForUpdate,
  lockInvestmentResolutionRows,
  overrideInvestment,
  overrideInvestments,
  getCommittedRows,
  markBatchAborted,
  resetCommittedRowsToMatched,
} from "../repositories/portfolioImportBatchRepository.ts";

const KINESIS_METAL_SYMBOLS = new Set(["KAU", "KAG"]);

export {
  listBatches,
  getBatch,
  overrideInvestment,
  setBatchAccount,
} from "../repositories/portfolioImportBatchRepository.ts";

/**
 * Build the portfolio-import preview consumed by the review page.
 * @param {any[]} rows
 */
function buildPortfolioImportBatchPreview(rows) {
  /** @type {Map<string, any>} */
  const groupMap = new Map();
  for (const row of rows) {
    const key =
      row.route === "cash"
        ? "cash"
        : row.effective_investment_id != null
          ? `inv:${row.effective_investment_id}`
          : `raw:${(row.symbol_raw || row.name_raw || "?").toLowerCase()}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        is_cash: row.route === "cash",
        investment_id: row.effective_investment_id,
        investment_name: row.investment_name,
        investment_symbol: row.investment_symbol,
        investment_asset_class: row.investment_asset_class,
        raw_symbol: row.route === "cash" ? null : row.symbol_raw,
        raw_name: row.route === "cash" ? null : row.name_raw,
        rows: [],
      });
    }
    groupMap.get(key).rows.push({
      id: row.id,
      row_index: row.row_index,
      status: row.status,
      route: row.route,
      tx_date: row.tx_date,
      type: row.type,
      type_raw: row.type_raw,
      symbol_raw: row.symbol_raw,
      name_raw: row.name_raw,
      units: row.units,
      price_per_unit: row.price_per_unit,
      amount: row.amount,
      fees: row.fees,
      taxes: row.taxes,
      currency: row.currency,
      fx_rate_to_eur: row.fx_rate_to_eur,
      note: row.note,
      match_source: row.match_source,
      error_message: row.error_message,
      user_override_investment_id: row.user_override_investment_id,
    });
  }

  const groups = [...groupMap.values()].map((group) => ({
    ...group,
    row_count: group.rows.length,
  }));
  /** @type {Record<string, number>} */
  const totals = { symbol: 0, name_exact: 0, unresolved: 0, error: 0 };
  for (const row of rows) {
    if (row.status === "error") {
      totals.error += 1;
      continue;
    }
    const source = row.match_source ?? "unresolved";
    totals[source] = (totals[source] || 0) + 1;
  }
  return { groups, totals };
}

/** @param {number} batchId */
export async function getPortfolioImportBatchPreview(batchId) {
  return buildPortfolioImportBatchPreview(await getPreviewRows(batchId));
}

/**
 * Create a new investment from a staging row's symbol/name and the batch's
 * default asset class, then point the row at it. Used by the review "create
 * new holding" action.
 *
 * @param {{ batchId: number, rowId: number }} args
 * @returns {Promise<import('../types/rows.ts').InvestmentRow|null|undefined>} the
 *          created investment row, `undefined` when the staging row does not
 *          exist, or (in principle) `null` per investmentRepository.create's
 *          own return type — never actually null here since the insert above
 *          always finds the row it just created.
 */
export async function createInvestmentForRow({ batchId, rowId }) {
  return withTransaction(async () => {
    const locked = await validateInvestmentResolutionRows({
      batchId,
      rowIds: [rowId],
      rejectExistingOverride: true,
    });
    if (!locked) return undefined;

    const investment = await createInvestmentFromRow({ batchId, rowId });
    await overrideInvestment({ batchId, rowId, investmentId: investment.id });
    return investment;
  });
}

/**
 * Validate and lock the full resolution set before any investment lookup or
 * creation. Returns undefined only when the batch itself does not exist.
 *
 * @param {{ batchId: number, rowIds: number[], rejectExistingOverride?: boolean }} args
 */
async function validateInvestmentResolutionRows({
  batchId,
  rowIds,
  rejectExistingOverride = false,
}) {
  const locked = await lockInvestmentResolutionRows({ batchId, rowIds });
  if (!locked.batchStatus) return undefined;

  if (
    !["awaiting_review", "complete_with_errors"].includes(locked.batchStatus)
  ) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(
        `Batch ${batchId} is not in a reviewable state (status: ${locked.batchStatus})`,
      )
    );
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  if (
    locked.rows.length !== rowIds.length ||
    locked.rows.some(
      (row) =>
        row.route === "cash" ||
        (row.status !== "matched" &&
          !(
            row.status === "error" &&
            row.error_message ===
              "unresolved instrument — pick or create a holding"
          )),
    )
  ) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(
        "One or more rows were not found in this batch or are no longer reviewable",
      )
    );
    err.code = "NOT_FOUND";
    throw err;
  }

  if (
    rejectExistingOverride &&
    locked.rows.some((row) => row.user_override_investment_id != null)
  ) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error("One or more rows already have a user-selected investment")
    );
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  return locked.rows;
}

/**
 * Create the holding after the caller has locked and validated its row set.
 *
 * @param {{ batchId: number, rowId: number }} args
 */
async function createInvestmentFromRow({ batchId, rowId }) {
  const row = await getRowForInvestmentCreation({ batchId, rowId });
  if (!row) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`Row ${rowId} not found in batch ${batchId}`)
    );
    err.code = "NOT_FOUND";
    throw err;
  }
  if (!row.default_asset_class) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error("batch has no default asset class for new holdings")
    );
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  const name = (row.name_raw || row.symbol_raw || "").trim();
  if (!name) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error("row has no symbol or name to create a holding from")
    );
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  // CSV-derived currency: coalesce to EUR unless it is a clean ISO-shaped code
  // (uppercased). investments.currency is VARCHAR(10) with no CHECK, so a
  // malformed CSV cell either stored garbage or (>10 chars) 500'd the insert —
  // fallback (not reject) matches the pipeline's existing `|| 'EUR'` coalescing.
  const rawCurrency = String(row.currency || "")
    .trim()
    .toUpperCase();
  let config = {};
  try {
    config =
      typeof row.custom_config === "string"
        ? JSON.parse(row.custom_config)
        : row.custom_config || {};
  } catch {
    // Malformed historical config falls back to the batch default, matching
    // the generic create-new behavior instead of blocking review.
  }
  const symbol = (row.symbol_raw || "").trim().toUpperCase();
  const assetClass =
    config.format === "kinesis_transaction_history" &&
    KINESIS_METAL_SYMBOLS.has(symbol)
      ? "metals"
      : row.default_asset_class;
  const holdingCurrency =
    config.format === "kinesis_transaction_history"
      ? "USD"
      : /^[A-Z]{3}$/.test(rawCurrency)
        ? rawCurrency
        : "EUR";
  const investment = await investmentRepository.create(
    /** @type {any} */ ({
      name,
      symbol: symbol || undefined,
      asset_class: assetClass,
      currency: holdingCurrency,
      price_provider: "manual",
    }),
  );

  return investment;
}

/**
 * Resolve a complete review group through one atomic operation. Existing
 * holdings are checked before any staging write. When a new holding is
 * requested, its creation and every staging-row override share the same
 * transaction, so an invalid row set cannot leave an orphan holding behind.
 *
 * @param {{ batchId: number, rowIds: number[], investmentId?: number, createNew?: boolean }} args
 * @returns {Promise<{ investmentId: number, created: boolean, resolved: number, investment?: import('../types/rows.ts').InvestmentRow }>}
 */
export async function resolveInvestmentRows({
  batchId,
  rowIds,
  investmentId,
  createNew = false,
}) {
  return withTransaction(async () => {
    const locked = await validateInvestmentResolutionRows({
      batchId,
      rowIds,
      rejectExistingOverride: createNew,
    });
    if (!locked) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Batch ${batchId} not found`)
      );
      err.code = "NOT_FOUND";
      throw err;
    }

    let investment;
    let effectiveId = investmentId;

    if (createNew) {
      investment = await createInvestmentFromRow({ batchId, rowId: rowIds[0] });
      effectiveId = investment.id;
    } else {
      investment = await investmentRepository.getById(effectiveId);
      if (!investment) {
        const err = /** @type {Error & { code?: string }} */ (
          new Error(`Investment ${effectiveId} not found`)
        );
        err.code = "NOT_FOUND";
        throw err;
      }
    }

    const result = await overrideInvestments({
      batchId,
      rowIds,
      investmentId: /** @type {number} */ (effectiveId),
    });
    if (result.updatedCount !== result.requestedCount) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(
          "One or more rows were not found in this batch or are no longer reviewable",
        )
      );
      err.code = "NOT_FOUND";
      throw err;
    }

    return {
      investmentId: /** @type {number} */ (effectiveId),
      created: createNew,
      resolved: result.updatedCount,
      ...(createNew ? { investment } : {}),
    };
  });
}

/**
 * Rollback: hard-delete every committed row this batch produced and mark the
 * batch aborted.
 *
 * ROUTING (ADR-095, the ffb13d7 fix) is the invariant to preserve: a cash row's
 * committed_txn_id is a `transactions.id`, a trade's is a portfolio-transaction
 * id — the sequences are independent, so feeding every id to the portfolio repo
 * removed UNRELATED trades that happened to share a cash row's number (and left
 * the imported cash row in the ledger). Nothing below ever crosses that line:
 * trades are deleted from the portfolio table, cash from `transactions`, and the
 * two id sets are kept apart by `route`.
 *
 * Three passes, in this order:
 *   1. TRADES, bulk — one `DELETE ... WHERE import_batch_id = $1` (migration
 *      0086), scoped by the batch stamp rather than by an id list, so it cannot
 *      touch a lot this batch did not create. Replaces the old per-row loop.
 *   2. CASH, batched — one `DELETE FROM transactions WHERE id = ANY(...)` over
 *      exactly the route='cash' ids. `transactions.import_batch_id` FKs to the
 *      BANK `import_batches` table and is never stamped with a portfolio batch
 *      id, so pass 1 structurally cannot have covered these.
 *   3. TRADES, per-id fallback — for rows committed BEFORE 0086 applied (and on
 *      an un-migrated database, where pass 1 is a no-op): their lots carry
 *      import_batch_id NULL, so they are invisible to the bulk DELETE. Only ids
 *      pass 1 did not already report as deleted are retried here, so nothing is
 *      double-counted and no batch is left un-rollbackable by the migration
 *      boundary.
 *
 * ATOMICITY: the whole rollback — all three passes, the staging-row reset and
 * the abort mark — runs inside ONE withTransaction. A mid-way failure (e.g.
 * between the trade pass and the cash pass) therefore rolls everything back:
 * no partial deletion is ever visible and the batch stays un-aborted, so the
 * caller can simply retry. (query()/queryPrepared join the ambient transaction
 * client via AsyncLocalStorage, so every repository call below participates.)
 *
 * ROUTE GUARD: the cash pass runs ONLY for a brokerage batch. On a
 * non-brokerage batch the commit path ignores `route` entirely (commit.js
 * checks `isBrokerage && row.route === 'cash'`), so every committed_txn_id is a
 * PORTFOLIO id — feeding a hypothetical route='cash' staging row (unreachable
 * through the app, but one UPDATE away in SQL) into the ledger DELETE would
 * destroy an innocent `transactions` row of the same number. Such rows are
 * treated as the trades they actually are.
 *
 * DIRECT DELETION of a `portfolio_import_batches` row (SQL / db editor — the
 * app itself never deletes batch rows) strands what the batch committed:
 * `portfolio_transactions.import_batch_id` is ON DELETE SET NULL (a deliberate
 * 0086 choice — "manually deleting a batch row preserves the lots it created")
 * while `portfolio_import_staging_rows` CASCADE-deletes, so a later
 * rollbackBatch has nothing left to find (`{deleted: 0}`; the DELETE route
 * 404s anyway once the batch row is gone). Documented rather than
 * FK-protected: RESTRICTing the FK would reverse 0086's explicit intent and
 * needs a new migration. Roll back FIRST if you want the data gone.
 *
 * @param {number} batchId
 * @returns {Promise<{ deleted: number }>} rows actually deleted (unchanged
 *          semantics: already-gone rows are not counted)
 */
export async function rollbackBatch(batchId) {
  const repairScope = await getActiveDuplicateRepairReceipts(batchId);
  const pairedScope = await readPairedIncomeRollbackBatchIds(batchId);
  const nativeScope = await readReconciliationSources([batchId]);
  const nativeBatchIds = nativeScope
    .map((row) =>
      Number(row.asset_transfer_details?.networkBinding?.witnessBatchId),
    )
    .filter(Boolean);
  let deletedCash = 0;
  return withTransaction(async () => {
    deletedCash = 0;
    // Share the batch-first lock order with review resolution. This closes the
    // route pre-check race and prevents resolution from creating a holding while
    // rollback already owns staging rows (the opposite order could deadlock).
    const lockIds = [
      ...new Set([
        batchId,
        ...pairedScope,
        ...nativeBatchIds,
        ...repairScope.map((receipt) =>
          Number(receipt.original_import_batch_id),
        ),
      ]),
    ].sort((a, b) => a - b);
    let lockedBatch;
    for (const id of lockIds) {
      const locked = await lockBatchForUpdate(id);
      if (id === batchId) lockedBatch = locked;
    }
    if (!lockedBatch) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`Batch ${batchId} not found`)
      );
      err.code = "NOT_FOUND";
      throw err;
    }
    if (
      lockedBatch.status === "aborted" ||
      ["pending", "staging", "validating", "matching", "committing"].includes(
        lockedBatch.status,
      )
    ) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(
          `Batch ${batchId} cannot be rolled back from status ${lockedBatch.status}`,
        )
      );
      err.code = "VALIDATION_ERROR";
      throw err;
    }

    const activeRepairs = await getActiveDuplicateRepairReceipts(batchId);
    if (
      activeRepairs.some(
        (receipt) =>
          !lockIds.includes(Number(receipt.original_import_batch_id)),
      )
    )
      throw new ConflictError(
        "Duplicate repair provenance changed. Refresh the import before undoing it.",
        { details: { reason: "stale_reconciliation_plan" } },
      );
    if (
      (await readPairedIncomeRollbackBatchIds(batchId)).some(
        (id) => !lockIds.includes(id),
      )
    )
      throw new ConflictError("Paired income provenance changed", {
        details: { reason: "stale_reconciliation_plan" },
      });
    const rows = await getCommittedRows(batchId);
    const activeAdoptions = await getActiveAdoptionReceipts(batchId);
    const custodySourceRows = await readReconciliationSources([batchId]);
    if (lockedBatch)
      await lockReconciliationAccountsAndHistory(
        [
          ...new Set(
            [
              ...custodySourceRows.map(
                (row) => row.asset_adjustment_details?.accountId,
              ),
              ...custodySourceRows.flatMap((row) => [
                row.asset_transfer_details?.networkBinding?.originAccountId,
                row.asset_transfer_details?.networkBinding
                  ?.destinationAccountId,
              ]),
              ...activeAdoptions.flatMap((receipt) => [
                receipt.before_data.account_id,
                receipt.after_data.account_id,
              ]),
              ...activeRepairs.flatMap((receipt) => [
                receipt.before_data.legacy.account_id,
                receipt.after_data.legacy.account_id,
                receipt.before_data.imported.account_id,
              ]),
            ]
              .concat(
                lockedBatch.account_id,
                lockedBatch.custom_config?.transfer_destination_account_id,
                lockedBatch.custom_config?.transfer_origin_account_id,
              )
              .filter((id) => id != null),
          ),
        ].sort((a, b) => a - b),
      );

    await assertNoActiveKinesisNetworkConsumers(batchId);
    if (
      custodySourceRows.some(
        (row) =>
          row.asset_transfer_details?.networkBinding ||
          row.asset_transfer_details?.networkReceipt ||
          row.asset_transfer_details?.nativeGiftGroupReceipt ||
          row.asset_adjustment_details?.networkReceipt,
      )
    ) {
      const nativeHistory = await readReconciliationHistory([
        ...new Set(
          custodySourceRows
            .map((row) => Number(row.investment_id))
            .filter(Boolean),
        ),
      ]);
      const nativeContext = await readKinesisNetworkContext(nativeHistory);
      const nativeBatches = await readReconciliationBatchScope([batchId]);
      if (
        custodySourceRows.some(
          (row) =>
            row.asset_transfer_details?.networkBinding &&
            !lockIds.includes(
              Number(row.asset_transfer_details.networkBinding.witnessBatchId),
            ),
        ) ||
        proveKinesisNetworkBindings(
          custodySourceRows,
          nativeBatches,
          nativeHistory,
          nativeContext,
        ).blockers.length ||
        proveKinesisNativeGiftGroups(
          custodySourceRows,
          nativeBatches,
          nativeHistory,
          await readKinesisNativeGiftContext(nativeHistory),
        ).blockers.length
      )
        throw new ConflictError(
          "Native wallet source evidence changed. Refresh before undoing this import.",
          { details: { reason: "network_receipt_changed" } },
        );
    }
    await lockKinesisCashLedger();
    const ownedCashIds = await validateKinesisCashRollback(batchId);

    // Brokerage flag for the route guard (see docstring). Committed cash rows
    // can only exist on a brokerage batch (resolveAndCheck writes route='cash'
    // only when is_brokerage) — this re-check keeps a corrupted/hand-edited
    // staging row from crossing the transactions/portfolio id line.
    const isBrokerage = lockedBatch.is_brokerage === true;

    const portfolioRows = rows.filter(
      (r) => (!isBrokerage || r.route !== "cash") && r.id != null,
    );
    // Approve the complete stamped + legacy removal set before deleting any
    // row. Per-row validation would reject a batch's buy before its dependent
    // sell even though removing both restores the pre-import history.
    const adoptionReceipts = await validatePortfolioImportAdoptionRollback(
      batchId,
      portfolioRows,
    );
    // Removing dated custody events and acquisitions is one projection. The
    // transfer helper can use the restoration already validated above.
    const deletedTransfers = await rollbackPortfolioAssetTransfersForBatch(
      batchId,
      {
        omitTransactionIds: portfolioRows.map((row) => Number(row.id)),
        skipHistoryValidation: true,
      },
    );
    const deletedAdjustments = await rollbackPortfolioAssetAdjustmentsForBatch(
      batchId,
      {
        omitTransactionIds: portfolioRows.map((row) => Number(row.id)),
        skipHistoryValidation: true,
      },
    );
    if (adoptionReceipts.length === 0 && activeRepairs.length === 0)
      await portfolioTransactionService.validateImportBatchRemoval(
        batchId,
        portfolioRows,
      );

    await restorePairedPortfolioIncomeForBatch(batchId);

    // 1. Trades stamped with this batch — one statement.
    const bulkDeletedIds =
      await portfolioTransactionRepository.hardDeleteByImportBatch(batchId);
    let deleted = bulkDeletedIds.length + deletedTransfers + deletedAdjustments;
    // committed_txn_id is INTEGER while portfolio ids can arrive as BIGINT strings
    // from pg; compare as strings so the "already covered" test can't miss.
    const bulkDeleted = new Set(bulkDeletedIds.map(String));

    // 2. Cash rows → the ledger, never the portfolio table (brokerage only).
    const cashIds = isBrokerage
      ? [
          ...new Set([
            ...rows
              .filter((r) => r.route === "cash" && r.id != null)
              .map((r) => r.id),
            ...ownedCashIds,
          ]),
        ]
      : [];
    if (cashIds.length > 0) {
      const r = await query(
        "DELETE FROM transactions WHERE id = ANY($1::int[])",
        [cashIds],
      );
      deleted += r.rowCount ?? 0;
      deletedCash += r.rowCount ?? 0;
    }

    // 3. Pre-0086 trades the stamp cannot reach. On a non-brokerage batch this
    // includes route='cash' rows — they were committed as trades (see guard).
    const unstampedTradeIds = rows
      .filter(
        (r) =>
          (!isBrokerage || r.route !== "cash") &&
          r.id != null &&
          !bulkDeleted.has(String(r.id)),
      )
      .map((r) => r.id);
    for (const id of unstampedTradeIds) {
      const ok = await portfolioTransactionRepository.hardDelete(id);
      if (ok) deleted++;
    }

    await restorePortfolioImportAdoptions(adoptionReceipts);
    await restoreDuplicatePortfolioRepairs(activeRepairs);
    await resetCommittedRowsToMatched(batchId);
    await markBatchAborted(batchId);
    return {
      deleted,
      ...(activeRepairs.length > 0
        ? {
            restored: activeRepairs.length,
            restored_imported: activeRepairs.length,
          }
        : {}),
    };
  }).then((result) => {
    if (deletedCash > 0) scheduleRefresh();
    return result;
  });
}
