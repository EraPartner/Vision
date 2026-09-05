/**
 * Import pipeline — orchestrator.
 *
 * Exposed surface:
 *
 *   runImportPipeline(args)   — full one-shot flow (upload route).
 *                               If any staged row is not 'exact', stops after
 *                               match phase and sets status to 'awaiting_review'.
 *                               Otherwise auto-commits and returns full stats.
 *
 *   prepareImport(args)       — stage → validate → match.
 *                               Returns { batchId, requiresReview, matchSourceCounts }.
 *
 *   commitImport({ batchId, onProgress })
 *                             — commit all matched rows, honouring
 *                               user_override_recipient_id, refresh views.
 *
 * Phase primitives are also re-exported for direct use by route handlers.
 */

import { query } from "../../database/connection.js";
import { logger } from "../../config/logger.js";
import {
  clearForecastMcCaches,
  scheduleMaterializedViewRefresh,
} from "../aggregationRefresh.js";

import { createBatch, stageBatch } from "./stage.js";
import { validateBatch } from "./validate.js";
import { matchBatch } from "./match.js";
import { commitBatch } from "./commit.js";
import { reconcileTransfers } from "../transferReconciliationService.js";

export { createBatch, stageBatch, validateBatch, matchBatch, commitBatch };

/**
 * Progress reporter threaded through every pipeline phase. `imported` /
 * `duplicates` / `errors` are only supplied by the commit phase.
 *
 * @typedef {(progress: {
 *   phase: 'staging'|'validating'|'matching'|'committing',
 *   current: number,
 *   total: number,
 *   imported?: number,
 *   duplicates?: number,
 *   errors?: number,
 * }) => void} ImportProgressCallback
 */

/**
 * An `import_batches` id as it is actually passed around.
 *
 * Always a NUMBER. Two producers feed it and both now agree: `createBatch`
 * (stage.js) normalizes node-postgres's BIGSERIAL string at the boundary, and
 * the review/commit routes parse it out of the URL through `coercedIdSchema`
 * (lib/importBatchIds.js:17), which already yielded a number. It was a
 * `string|number` union until the two disagreed on the wire — see the note on
 * `createBatch` for why number won.
 *
 * @typedef {number} ImportBatchId
 */

/**
 * Stage → validate → match a batch that already exists.
 * Decides whether the batch needs user review or can be auto-committed.
 *
 * @param {{ batchId: ImportBatchId, filePath: string, adapterName: string, customConfig?: object, filename?: string, sizeBytes?: number, onProgress?: ImportProgressCallback }} args
 * @returns {Promise<{ batchId: ImportBatchId, rowsTotal: number, requiresReview: boolean, matchSourceCounts: object, validateErrors: number }>}
 */
async function prepareImport({
  batchId,
  filePath,
  adapterName,
  customConfig,
  filename: _filename,
  sizeBytes: _sizeBytes,
  onProgress,
}) {
  const { rowsTotal } = await stageBatch({
    batchId,
    filePath,
    adapterName,
    customConfig,
    onProgress,
  });

  const { errors: validateErrors } = await validateBatch({
    batchId,
    onProgress,
  });

  const { matchSourceCounts, unresolved } = await matchBatch({
    batchId,
    onProgress,
  });

  // Review is required when any row was resolved by something other than an
  // exact normalized match — fuzzy hits, pattern hits, and new recipients
  // all warrant user confirmation before committing. Unresolved rows (e.g. a
  // batch of blank `recipient_raw` rows) must NOT auto-commit either: they
  // would otherwise land as transactions with no resolved recipient.
  const requiresReview =
    (matchSourceCounts.fuzzy || 0) > 0 ||
    (matchSourceCounts.pattern || 0) > 0 ||
    (matchSourceCounts.new || 0) > 0 ||
    (unresolved || 0) > 0;

  if (requiresReview) {
    await query(
      `UPDATE import_batches SET status = 'awaiting_review' WHERE id = $1`,
      [batchId],
    );
    logger.info("[pipeline] awaiting review", {
      batchId,
      matchSourceCounts,
      validateErrors,
    });
  }

  return {
    batchId,
    rowsTotal,
    requiresReview,
    matchSourceCounts,
    validateErrors,
  };
}

/**
 * Commit a prepared (or reviewed) batch.
 * Applies user_override_recipient_id before writing transactions.
 *
 * @param {{ batchId: ImportBatchId, onProgress?: ImportProgressCallback }} args
 * @returns {Promise<{ imported: number, duplicates: number, errors: number, autoLinkedCount: number }>}
 */
export async function commitImport({ batchId, onProgress }) {
  const { imported, duplicates, errors, autoLinkedCount } = await commitBatch({
    batchId,
    onProgress,
  });

  await query(
    `UPDATE import_batches
        SET status = 'complete',
            completed_at = NOW()
      WHERE id = $1`,
    [batchId],
  );

  // Detect internal transfers across the whole corpus (not just this batch) so
  // cross-bank pairs whose legs arrived in separate imports get matched (ADR-083).
  // Runs before the MV refresh so the views reflect the exclusion immediately.
  await reconcileTransfers().catch((err) => {
    logger.warn("[pipeline] transfer reconcile failed (non-fatal)", {
      err: err?.message,
    });
  });

  if (imported > 0) {
    await clearForecastMcCaches().catch((err) => {
      logger.warn("[pipeline] forecast cache invalidation failed (non-fatal)", {
        err: err?.message,
      });
    });
  }

  // The import response must not wait for three full materialized-view scans.
  // Schedule one coalesced rebuild only after transfer reconciliation, so the
  // eventual snapshot includes any transfer exclusions created above.
  scheduleMaterializedViewRefresh();

  logger.info("[pipeline] committed", {
    batchId,
    imported,
    duplicates,
    errors,
    autoLinkedCount,
  });
  return { imported, duplicates, errors, autoLinkedCount };
}

/**
 * Full one-shot pipeline for the upload route.
 *
 * Creates the batch, prepares it (stage + validate + match), and either
 * auto-commits (all rows exact) or leaves the batch in 'awaiting_review'
 * for the frontend to present the ImportReviewPage.
 *
 * @param {{ filePath: string, adapterName: string, customConfig?: object, filename?: string, sizeBytes?: number, onProgress?: ImportProgressCallback }} args
 * @returns {Promise<{ batchId: ImportBatchId, total: number, requiresReview: boolean, imported?: number, duplicates?: number, errors?: number, matchSourceCounts?: object, autoLinkedCount?: number }>}
 */
export async function runImportPipeline({
  filePath,
  adapterName,
  customConfig,
  filename,
  sizeBytes,
  onProgress,
}) {
  const batchId = await createBatch({
    adapterName,
    filename,
    sizeBytes,
    customConfig,
  });
  logger.info("[pipeline] created batch", { batchId, adapterName });

  try {
    const { rowsTotal, requiresReview, matchSourceCounts, validateErrors } =
      await prepareImport({
        batchId,
        filePath,
        adapterName,
        customConfig,
        filename,
        sizeBytes,
        onProgress,
      });

    if (requiresReview) {
      return {
        batchId,
        total: rowsTotal,
        requiresReview: true,
        matchSourceCounts,
      };
    }

    // All rows resolved exactly — auto-commit without review.
    const {
      imported,
      duplicates,
      errors: commitErrors,
      autoLinkedCount,
    } = await commitImport({ batchId, onProgress });

    const totalErrors = (validateErrors || 0) + (commitErrors || 0);
    await query(`UPDATE import_batches SET rows_error = $2 WHERE id = $1`, [
      batchId,
      totalErrors,
    ]);

    logger.info("[pipeline] complete", {
      batchId,
      total: rowsTotal,
      imported,
      duplicates,
      errors: totalErrors,
      autoLinkedCount,
    });
    return {
      batchId,
      total: rowsTotal,
      requiresReview: false,
      imported,
      duplicates,
      errors: totalErrors,
      autoLinkedCount,
    };
  } catch (err) {
    await query(
      `UPDATE import_batches
          SET status = 'failed',
              completed_at = NOW(),
              error_summary = $2
        WHERE id = $1`,
      [batchId, String(err?.message || err).slice(0, 2000)],
    ).catch((updateErr) => {
      logger.error("[pipeline] failed to mark batch as failed", {
        batchId,
        error: updateErr?.message,
      });
    });
    logger.error("[pipeline] failed", { batchId, error: err?.message });
    throw err;
  }
}

export { prepareImport };
