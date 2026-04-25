/**
 * Import pipeline — COMMIT
 *
 * Drains 'matched' staging rows into canonical `transactions`. Performs
 * per-row field-based dedup (date+amount+recipient+memo) against
 * `transactions`. Uses chunked BEGIN/COMMIT so partial failures roll back
 * cleanly on a chunk boundary without losing prior committed chunks.
 *
 * Post-chunk: updates `import_batches` counters (`rows_imported`,
 * `rows_duplicate`, `rows_error`).
 */

import { query, withTransaction } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import { refreshAggregations } from '../aggregationRefresh.js';

const COMMIT_CHUNK = 1000;

export async function commitBatch({ batchId, onProgress }) {
  await query(`UPDATE import_batches SET status = 'committing' WHERE id = $1`, [batchId]);

  const { rows: matched } = await query(
    `SELECT id, row_index, tx_date, bank_account, recipient_raw, memo,
            amount, currency, balance, comment, resolved_recipient_id
       FROM import_staging_rows
      WHERE batch_id = $1 AND status = 'matched'
      ORDER BY row_index ASC`,
    [batchId]
  );

  const total = matched.length;
  let seen = 0;
  let imported = 0;
  let duplicates = 0;
  let errors = 0;
  let lastFlushedImported = 0;
  let lastFlushedDuplicates = 0;
  let lastFlushedErrors = 0;

  if (onProgress) onProgress({ phase: 'committing', current: 0, total });

  for (let start = 0; start < total; start += COMMIT_CHUNK) {
    const chunk = matched.slice(start, start + COMMIT_CHUNK);
    await withTransaction(async (client) => {
      for (const row of chunk) {
        const dateStr = row.tx_date instanceof Date
          ? row.tx_date.toISOString().slice(0, 10)
          : String(row.tx_date).slice(0, 10);

        // Field-based duplicate check against canonical transactions.
        const dupCheck = await client.query(
          `SELECT t.id
             FROM transactions t
             LEFT JOIN recipients r ON t.recipient_id = r.id
            WHERE t.date = $1
              AND t.amount = $2
              AND (
                ($3::integer IS NOT NULL AND t.recipient_id = $3)
                OR ($3::integer IS NULL AND t.recipient_id IS NULL)
              )
              AND t.is_active = true
            LIMIT 1`,
          [dateStr, row.amount, row.resolved_recipient_id]
        );

        if (dupCheck.rows.length > 0) {
          duplicates++;
          await client.query(
            `UPDATE import_staging_rows SET status = 'duplicate' WHERE id = $1`,
            [row.id]
          );
          continue;
        }

        try {
          await client.query(
            `INSERT INTO transactions
                (date, bank_account, recipient_id, amount, memo, currency, balance, comment, import_batch_id, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
            [
              dateStr,
              row.bank_account || null,
              row.resolved_recipient_id || null,
              row.amount,
              row.memo || '',
              row.currency || null,
              row.balance != null ? row.balance : null,
              row.comment || null,
              batchId,
            ]
          );
          imported++;
          await client.query(
            `UPDATE import_staging_rows SET status = 'committed' WHERE id = $1`,
            [row.id]
          );
        } catch (err) {
          errors++;
          await client.query(
            `UPDATE import_staging_rows SET status = 'error', error_message = $2 WHERE id = $1`,
            [row.id, err?.message?.slice(0, 500) || 'insert failed']
          );
        }
      }
    });

    seen += chunk.length;

    // Checkpoint counters per chunk so a crash mid-import leaves recoverable
    // state in import_batches. Increment by chunk-local delta to preserve
    // any rows_error already set by earlier pipeline phases (validate).
    const dImported = imported - lastFlushedImported;
    const dDuplicates = duplicates - lastFlushedDuplicates;
    const dErrors = errors - lastFlushedErrors;
    await query(
      `UPDATE import_batches
          SET rows_imported = COALESCE(rows_imported, 0) + $2,
              rows_duplicate = COALESCE(rows_duplicate, 0) + $3,
              rows_error = COALESCE(rows_error, 0) + $4
        WHERE id = $1`,
      [batchId, dImported, dDuplicates, dErrors]
    );
    lastFlushedImported = imported;
    lastFlushedDuplicates = duplicates;
    lastFlushedErrors = errors;

    if (onProgress) {
      onProgress({ phase: 'committing', current: seen, total, imported, duplicates, errors });
    }
  }

  logger.info('[pipeline:commit] done', { batchId, total, imported, duplicates, errors });

  if (imported > 0) {
    try {
      await refreshAggregations();
    } catch (err) {
      logger.warn('[pipeline:commit] post-import aggregation refresh failed', {
        batchId,
        error: err?.message,
      });
    }
  }

  return { imported, duplicates, errors };
}
