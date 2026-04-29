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

import { query } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import { scheduleRefresh, refreshMaterializedViews } from '../materializedViewService.js';

import { createBatch, stageBatch } from './stage.js';
import { validateBatch } from './validate.js';
import { matchBatch } from './match.js';
import { commitBatch } from './commit.js';

export { createBatch, stageBatch, validateBatch, matchBatch, commitBatch };

/**
 * Stage → validate → match a batch that already exists.
 * Decides whether the batch needs user review or can be auto-committed.
 *
 * @param {{ batchId: number, filePath: string, adapterName: string, customConfig?: object, filename?: string, sizeBytes?: number, onProgress?: Function }} args
 * @returns {Promise<{ batchId: number, rowsTotal: number, requiresReview: boolean, matchSourceCounts: object }>}
 */
export async function prepareImport({ batchId, filePath, adapterName, customConfig, filename: _filename, sizeBytes: _sizeBytes, onProgress }) {
  const { rowsTotal } = await stageBatch({ batchId, filePath, adapterName, customConfig, onProgress });

  const { errors: validateErrors } = await validateBatch({ batchId, onProgress });

  const { matchSourceCounts } = await matchBatch({ batchId, onProgress });

  // Review is required when any row was resolved by something other than an
  // exact normalized match — fuzzy hits, pattern hits, and new recipients
  // all warrant user confirmation before committing.
  const requiresReview = (
    (matchSourceCounts.fuzzy || 0) > 0 ||
    (matchSourceCounts.pattern || 0) > 0 ||
    (matchSourceCounts.new || 0) > 0
  );

  if (requiresReview) {
    await query(
      `UPDATE import_batches SET status = 'awaiting_review' WHERE id = $1`,
      [batchId]
    );
    logger.info('[pipeline] awaiting review', { batchId, matchSourceCounts, validateErrors });
  }

  return { batchId, rowsTotal, requiresReview, matchSourceCounts, validateErrors };
}

/**
 * Commit a prepared (or reviewed) batch.
 * Applies user_override_recipient_id before writing transactions.
 *
 * @param {{ batchId: number, onProgress?: Function }} args
 * @returns {Promise<{ imported: number, duplicates: number, errors: number }>}
 */
export async function commitImport({ batchId, onProgress }) {
  const { imported, duplicates, errors } = await commitBatch({ batchId, onProgress });

  await query(
    `UPDATE import_batches
        SET status = 'complete',
            completed_at = NOW()
      WHERE id = $1`,
    [batchId]
  );

  if (imported > 100) {
    await refreshMaterializedViews().catch((err) => {
      logger.warn('[pipeline] MV refresh failed (non-fatal)', { err: err?.message });
    });
  } else {
    scheduleRefresh();
  }

  logger.info('[pipeline] committed', { batchId, imported, duplicates, errors });
  return { imported, duplicates, errors };
}

/**
 * Full one-shot pipeline for the upload route.
 *
 * Creates the batch, prepares it (stage + validate + match), and either
 * auto-commits (all rows exact) or leaves the batch in 'awaiting_review'
 * for the frontend to present the ImportReviewPage.
 *
 * @param {{ filePath: string, adapterName: string, customConfig?: object, filename?: string, sizeBytes?: number, onProgress?: Function }} args
 * @returns {Promise<{ batchId: number, total: number, requiresReview: boolean, imported?: number, duplicates?: number, errors?: number }>}
 */
export async function runImportPipeline({ filePath, adapterName, customConfig, filename, sizeBytes, onProgress }) {
  const batchId = await createBatch({ adapterName, filename, sizeBytes, customConfig });
  logger.info('[pipeline] created batch', { batchId, adapterName });

  try {
    const { rowsTotal, requiresReview, matchSourceCounts, validateErrors } = await prepareImport({
      batchId,
      filePath,
      adapterName,
      customConfig,
      filename,
      sizeBytes,
      onProgress,
    });

    if (requiresReview) {
      return { batchId, total: rowsTotal, requiresReview: true, matchSourceCounts };
    }

    // All rows resolved exactly — auto-commit without review.
    const { imported, duplicates, errors: commitErrors } = await commitImport({ batchId, onProgress });

    const totalErrors = (validateErrors || 0) + (commitErrors || 0);
    await query(
      `UPDATE import_batches SET rows_error = $2 WHERE id = $1`,
      [batchId, totalErrors]
    );

    logger.info('[pipeline] complete', { batchId, total: rowsTotal, imported, duplicates, errors: totalErrors });
    return { batchId, total: rowsTotal, requiresReview: false, imported, duplicates, errors: totalErrors };
  } catch (err) {
    await query(
      `UPDATE import_batches
          SET status = 'failed',
              completed_at = NOW(),
              error_summary = $2
        WHERE id = $1`,
      [batchId, String(err?.message || err).slice(0, 2000)]
    ).catch((updateErr) => {
      logger.error('[pipeline] failed to mark batch as failed', { batchId, error: updateErr?.message });
    });
    logger.error('[pipeline] failed', { batchId, error: err?.message });
    throw err;
  }
}
