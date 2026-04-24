/**
 * Import pipeline — VALIDATE
 *
 * Reads staging rows (status='pending'), validates required fields,
 * computes tx_hash per row via deduplication.createTransactionHash
 * (or fallback field-based hash if raw_data is missing), and marks
 * each row 'validated' or 'error'.
 */

import crypto from 'crypto';
import { query, withTransaction } from '../../database/connection.js';
import { logger } from '../../config/logger.js';

const VALIDATE_CHUNK = 500;

export async function validateBatch({ batchId, onProgress }) {
  await query(`UPDATE import_batches SET status = 'validating' WHERE id = $1`, [batchId]);

  const { rows: pending } = await query(
    `SELECT id, row_index, tx_date, amount, recipient_raw, memo, currency, raw_data, bank_account, balance
       FROM import_staging_rows
      WHERE batch_id = $1 AND status = 'pending'
      ORDER BY row_index ASC`,
    [batchId]
  );

  const total = pending.length;
  let seen = 0;
  let errors = 0;

  if (onProgress) onProgress({ phase: 'validating', current: 0, total });

  for (let start = 0; start < total; start += VALIDATE_CHUNK) {
    const chunk = pending.slice(start, start + VALIDATE_CHUNK);
    await withTransaction(async (client) => {
      for (const row of chunk) {
        const issue = validateRow(row);
        if (issue) {
          errors++;
          await client.query(
            `UPDATE import_staging_rows SET status = 'error', error_message = $2 WHERE id = $1`,
            [row.id, issue]
          );
          continue;
        }
        const txHash = computeRowHash(row);
        await client.query(
          `UPDATE import_staging_rows SET status = 'validated', tx_hash = $2 WHERE id = $1`,
          [row.id, txHash]
        );
      }
    });
    seen += chunk.length;
    if (onProgress) onProgress({ phase: 'validating', current: seen, total });
  }

  logger.info('[pipeline:validate] done', { batchId, total, errors });
  return { validated: total - errors, errors };
}

function validateRow(row) {
  if (!row.tx_date) return 'missing tx_date';
  if (row.amount == null) return 'missing amount';
  const n = Number(row.amount);
  if (!Number.isFinite(n)) return 'invalid amount';
  return null;
}

function computeRowHash(row) {
  let raw;
  if (row.raw_data) {
    raw = row.raw_data;
  } else {
    const dateStr = typeof row.tx_date === 'string'
      ? row.tx_date.slice(0, 10)
      : row.tx_date.toISOString().slice(0, 10);
    raw = `${dateStr}|${row.amount}|${row.recipient_raw || ''}|${row.memo || ''}`;
  }
  return crypto.createHash('sha256').update(raw, 'utf-8').digest('hex');
}
