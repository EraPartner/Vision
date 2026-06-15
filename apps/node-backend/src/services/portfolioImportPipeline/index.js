/**
 * Portfolio import pipeline — orchestrator.
 *
 *   runPortfolioImportPipeline(args) — full one-shot flow. Auto-commits only
 *     when every row matched by exact symbol with no errors/unresolved rows;
 *     otherwise stops at 'awaiting_review' (a wrong instrument match silently
 *     corrupts cost basis, so name-matched / unmatched rows go to review).
 *
 *   prepareImport(args)  — stage → validate → matchInvestments.
 *   commitPortfolioImport({ batchId, onProgress }) — commit matched rows.
 *
 * Phase primitives are re-exported for the routes/tests.
 *
 * Deliberate divergences from the transaction orchestrator (importPipeline):
 *  - Post-commit freshening invalidates the in-memory portfolio caches rather
 *    than refreshing materialized views — portfolio reads are cache-backed, not
 *    MV-backed, so there is no MV to refresh and no large-batch tiering.
 *  - Batch counters (rows_imported/duplicate/error) are persisted incrementally
 *    by each phase (validate.js, commit.js), so the orchestrator does not write
 *    a final summed rows_error the way runImportPipeline does — the row is
 *    already correct when the auto-commit path returns.
 */

import { query } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import { invalidatePortfolioCaches } from '../../routes/info/_cache.js';

import { createBatch, stageBatch } from './stage.js';
import { validateBatch } from './validate.js';
import { matchBatch } from './matchInvestments.js';
import { commitBatch } from './commit.js';

export { createBatch, stageBatch, validateBatch, matchBatch, commitBatch };

export async function prepareImport({ batchId, filePath, customConfig, onProgress }) {
  const { rowsTotal } = await stageBatch({ batchId, filePath, customConfig, onProgress });
  const { errors: validateErrors } = await validateBatch({ batchId, onProgress });
  const { matchSourceCounts, unresolved } = await matchBatch({ batchId, onProgress });

  // Conservative: only a batch where every row matched by exact symbol and
  // nothing errored or went unresolved is safe to auto-commit. Name matches are
  // weaker (homonyms) and unresolved rows have no instrument yet.
  const requiresReview = (
    (validateErrors || 0) > 0 ||
    (matchSourceCounts.name_exact || 0) > 0 ||
    (unresolved || 0) > 0
  );

  if (requiresReview) {
    await query(`UPDATE portfolio_import_batches SET status = 'awaiting_review' WHERE id = $1`, [batchId]);
    logger.info('[portfolio-pipeline] awaiting review', { batchId, matchSourceCounts, validateErrors });
  }

  return { batchId, rowsTotal, requiresReview, matchSourceCounts, validateErrors };
}

/**
 * @param {{ batchId: number, onProgress?: Function }} args
 */
export async function commitPortfolioImport({ batchId, onProgress }) {
  const { imported, duplicates, errors } = await commitBatch({ batchId, onProgress });

  await query(
    `UPDATE portfolio_import_batches SET status = 'complete', completed_at = NOW() WHERE id = $1`,
    [batchId],
  );

  if (imported > 0) {
    try {
      invalidatePortfolioCaches();
    } catch (err) {
      logger.warn('[portfolio-pipeline] cache invalidation failed (non-fatal)', { err: err?.message });
    }
  }

  logger.info('[portfolio-pipeline] committed', { batchId, imported, duplicates, errors });
  return { imported, duplicates, errors };
}

/**
 * @param {{ filePath: string, adapterName: string, customConfig: object, defaultAssetClass?: string, defaultType?: string, filename?: string, sizeBytes?: number, onProgress?: Function }} args
 */
export async function runPortfolioImportPipeline({ filePath, adapterName, customConfig, defaultAssetClass, defaultType, filename, sizeBytes, onProgress }) {
  const batchId = await createBatch({ adapterName, filename, sizeBytes, customConfig, defaultAssetClass, defaultType });
  logger.info('[portfolio-pipeline] created batch', { batchId, adapterName });

  try {
    const { rowsTotal, requiresReview, matchSourceCounts, validateErrors } = await prepareImport({
      batchId, filePath, customConfig, onProgress,
    });

    if (requiresReview) {
      return { batchId, total: rowsTotal, requiresReview: true, matchSourceCounts };
    }

    const { imported, duplicates, errors: commitErrors } = await commitPortfolioImport({ batchId, onProgress });
    const totalErrors = (validateErrors || 0) + (commitErrors || 0);

    logger.info('[portfolio-pipeline] complete', { batchId, total: rowsTotal, imported, duplicates, errors: totalErrors });
    return { batchId, total: rowsTotal, requiresReview: false, imported, duplicates, errors: totalErrors };
  } catch (err) {
    await query(
      `UPDATE portfolio_import_batches SET status = 'failed', completed_at = NOW(), error_summary = $2 WHERE id = $1`,
      [batchId, String(err?.message || err).slice(0, 2000)],
    ).catch((updateErr) => {
      logger.error('[portfolio-pipeline] failed to mark batch failed', { batchId, error: updateErr?.message });
    });
    logger.error('[portfolio-pipeline] failed', { batchId, error: err?.message });
    throw err;
  }
}
