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
import { ValidationError } from '../../middleware/errorHandler.js';
import { invalidatePortfolioCaches } from '../../routes/info/_cache.js';

import { createBatch, stageBatch } from './stage.js';
import { validateBatch } from './validate.js';
import { matchBatch } from './matchInvestments.js';
import { commitBatch } from './commit.js';

export { createBatch, stageBatch, validateBatch, matchBatch, commitBatch };

export async function prepareImport({ batchId, filePath, customConfig, onProgress }) {
  const { rowsTotal, rowsSkipped } = await stageBatch({ batchId, filePath, customConfig, onProgress });

  // A mapping that matches no column (or a wrong date format) null-parses every
  // row: the adapter skips them all and the batch would sail through to a
  // "0 imported" success. Fail loudly instead — the user needs to fix the mapping.
  if (rowsTotal === 0) {
    throw new ValidationError(
      rowsSkipped > 0
        ? `No importable rows: all ${rowsSkipped} data rows failed to parse. Check the column mapping and date format.`
        : 'No importable rows found in the file.',
    );
  }

  const { errors: validateErrors } = await validateBatch({ batchId, onProgress });
  const { matchSourceCounts, unresolved } = await matchBatch({ batchId, onProgress });

  // Brokerage imports (ADR-095) ALWAYS go through staged review — the user must
  // confirm cash-vs-trade routing and instrument matching before any fan-out.
  const { rows: brRows } = await query(`SELECT is_brokerage FROM portfolio_import_batches WHERE id = $1`, [batchId]);
  const isBrokerage = brRows[0]?.is_brokerage === true;

  // Conservative: only a batch where every row matched by exact symbol and
  // nothing errored or went unresolved is safe to auto-commit. Name matches are
  // weaker (homonyms) and unresolved rows have no instrument yet.
  const requiresReview = (
    isBrokerage ||
    (validateErrors || 0) > 0 ||
    (matchSourceCounts.name_exact || 0) > 0 ||
    (unresolved || 0) > 0
  );

  if (requiresReview) {
    await query(`UPDATE portfolio_import_batches SET status = 'awaiting_review' WHERE id = $1`, [batchId]);
    logger.info('[portfolio-pipeline] awaiting review', { batchId, matchSourceCounts, validateErrors });
  }

  return { batchId, rowsTotal, rowsSkipped, requiresReview, matchSourceCounts, validateErrors };
}

/**
 * @param {{ batchId: number, onProgress?: Function }} args
 */
export async function commitPortfolioImport({ batchId, onProgress }) {
  const { imported, duplicates, errors } = await commitBatch({ batchId, onProgress });

  // A batch that still has any 'error' staging row is not truly done — it lands
  // in 'complete_with_errors' so it stays reviewable (the commit route re-accepts
  // it) and is signalled for repair, instead of reading as a clean 'complete'
  // while silently stranding the failed rows. The status is driven by the actual
  // remaining error rows, not this run's `errors` count, so a re-commit that
  // fixes the last error correctly flips the batch back to 'complete'.
  await query(
    `UPDATE portfolio_import_batches
        SET status = CASE
              WHEN EXISTS (
                SELECT 1 FROM portfolio_import_staging_rows
                 WHERE batch_id = $1 AND status = 'error'
              ) THEN 'complete_with_errors'
              ELSE 'complete'
            END,
            completed_at = NOW()
      WHERE id = $1`,
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
 * @param {{ filePath: string, adapterName: string, customConfig: object, defaultAssetClass?: string, defaultType?: string, filename?: string, sizeBytes?: number, isBrokerage?: boolean, accountId?: number, onProgress?: Function }} args
 */
export async function runPortfolioImportPipeline({ filePath, adapterName, customConfig, defaultAssetClass, defaultType, filename, sizeBytes, isBrokerage, accountId, onProgress }) {
  const batchId = await createBatch({ adapterName, filename, sizeBytes, customConfig, defaultAssetClass, defaultType, isBrokerage, accountId });
  logger.info('[portfolio-pipeline] created batch', { batchId, adapterName });

  try {
    const { rowsTotal, rowsSkipped, requiresReview, matchSourceCounts, validateErrors } = await prepareImport({
      batchId, filePath, customConfig, onProgress,
    });

    if (requiresReview) {
      return { batchId, total: rowsTotal, skipped: rowsSkipped, requiresReview: true, matchSourceCounts };
    }

    const { imported, duplicates, errors: commitErrors } = await commitPortfolioImport({ batchId, onProgress });
    const totalErrors = (validateErrors || 0) + (commitErrors || 0);

    logger.info('[portfolio-pipeline] complete', { batchId, total: rowsTotal, skipped: rowsSkipped, imported, duplicates, errors: totalErrors });
    return { batchId, total: rowsTotal, skipped: rowsSkipped, requiresReview: false, imported, duplicates, errors: totalErrors };
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
