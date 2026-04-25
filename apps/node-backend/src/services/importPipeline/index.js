/**
 * Import pipeline — orchestrator.
 *
 * Runs the staged pipeline end-to-end:
 *   createBatch → stage → validate → match → commit → complete.
 *
 * Each phase is idempotent at its boundary; on any phase throw, the batch
 * is marked `failed` and the error is propagated. Progress callbacks bubble
 * up so the SSE route can re-emit the standard event shape.
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
 * Run the full pipeline for a single upload.
 *
 * @param {object} args
 * @param {string} args.filePath
 * @param {string} args.adapterName
 * @param {object} [args.customConfig]
 * @param {string} [args.filename]
 * @param {number} [args.sizeBytes]
 * @param {(event: { phase: string, current: number, total: number, imported?: number, duplicates?: number, errors?: number }) => void} [args.onProgress]
 * @returns {Promise<{ batchId: number, total: number, imported: number, duplicates: number, errors: number }>}
 */
export async function runImportPipeline({
  filePath,
  adapterName,
  customConfig,
  filename,
  sizeBytes,
  onProgress,
}) {
  const batchId = await createBatch({ adapterName, filename, sizeBytes, customConfig });
  logger.info('[pipeline] created batch', { batchId, adapterName });

  try {
    const { rowsTotal } = await stageBatch({
      batchId,
      filePath,
      adapterName,
      customConfig,
      onProgress,
    });

    const { errors: validateErrors } = await validateBatch({ batchId, onProgress });
    await matchBatch({ batchId, onProgress });
    const { imported, duplicates, errors: commitErrors } = await commitBatch({ batchId, onProgress });

    const totalErrors = (validateErrors || 0) + (commitErrors || 0);

    await query(
      `UPDATE import_batches
          SET status = 'complete',
              completed_at = NOW(),
              rows_error = $2
        WHERE id = $1`,
      [batchId, totalErrors]
    );

    // Refresh aggregates. Large imports get an immediate awaited refresh so the
    // next read reflects the new data; small imports use the debounced path.
    if (imported > 100) {
      await refreshMaterializedViews().catch(err => {
        logger.warn('[pipeline] MV refresh failed (non-fatal)', { err: err?.message });
      });
    } else {
      scheduleRefresh();
    }

    logger.info('[pipeline] complete', {
      batchId,
      total: rowsTotal,
      imported,
      duplicates,
      errors: totalErrors,
    });

    return { batchId, total: rowsTotal, imported, duplicates, errors: totalErrors };
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
