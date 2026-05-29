/**
 * Import pipeline — VALIDATE
 *
 * Reads staging rows (status='pending'), validates required fields,
 * computes tx_hash per row via deduplication.createTransactionHash
 * (or fallback field-based hash if raw_data is missing), and marks
 * each row 'validated', 'duplicate' (a second row in this same batch
 * with an identical tx_hash), or 'error'.
 */

import crypto from 'crypto';
import { query } from '../../database/connection.js';
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
  let duplicates = 0;
  // tx_hashes seen so far in this batch — a repeat is an intra-batch duplicate
  // (the same row twice in one CSV) and is dropped here rather than inserted
  // twice at commit time.
  const seenHashes = new Set();

  if (onProgress) onProgress({ phase: 'validating', current: 0, total });

  for (let start = 0; start < total; start += VALIDATE_CHUNK) {
    const chunk = pending.slice(start, start + VALIDATE_CHUNK);
    const ids = [];
    const statuses = [];
    const txHashes = [];
    const errorMessages = [];
    for (const row of chunk) {
      const issue = validateRow(row);
      ids.push(row.id);
      if (issue) {
        errors++;
        statuses.push('error');
        txHashes.push(null);
        errorMessages.push(issue);
      } else {
        const hash = computeRowHash(row);
        if (seenHashes.has(hash)) {
          duplicates++;
          statuses.push('duplicate');
          txHashes.push(hash);
          errorMessages.push(null);
        } else {
          seenHashes.add(hash);
          statuses.push('validated');
          txHashes.push(hash);
          errorMessages.push(null);
        }
      }
    }
    await query(
      `UPDATE import_staging_rows s
          SET status        = v.status,
              tx_hash       = v.tx_hash,
              error_message = v.error_message
         FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[])
              AS v(id, status, tx_hash, error_message)
        WHERE s.id = v.id`,
      [ids, statuses, txHashes, errorMessages]
    );
    seen += chunk.length;
    if (onProgress) onProgress({ phase: 'validating', current: seen, total });
  }

  if (duplicates > 0) {
    await query(
      `UPDATE import_batches
          SET rows_duplicate = COALESCE(rows_duplicate, 0) + $2
        WHERE id = $1`,
      [batchId, duplicates]
    );
  }

  // `total`, `errors`, and `duplicates` are row counts (not currency), so plain
  // integer arithmetic is correct here — exempt from the monetary-arithmetic rule.
  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  const validated = total - errors - duplicates;
  logger.info('[pipeline:validate] done', { batchId, total, validated, duplicates, errors });
  return { validated, duplicates, errors };
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
