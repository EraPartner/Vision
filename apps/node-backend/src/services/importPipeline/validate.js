/**
 * Import pipeline — VALIDATE
 *
 * Reads staging rows (status='pending'), validates required fields,
 * computes tx_hash per row as sha256 of the literal raw_data (or a
 * fallback date|amount|recipient|memo|currency field hash if raw_data is
 * missing), and marks each row 'validated', 'duplicate' (a second row
 * in this same batch with an identical tx_hash), or 'error'.
 */

import crypto from "crypto";
import { query } from "../../database/connection.js";
import { logger } from "../../config/logger.js";
import { parsedDateToYmd } from "../../lib/importDates.js";

/**
 * @typedef {import('../../types/rows.js').ImportStagingRow} ImportStagingRow
 * @typedef {import('./index.js').ImportBatchId} ImportBatchId
 * @typedef {import('./index.js').ImportProgressCallback} ImportProgressCallback
 */

const VALIDATE_CHUNK = 500;

/**
 * The projection validate.js reads. `tx_date` is `to_char`-ed to a
 * 'YYYY-MM-DD' string rather than selected raw (see the comment below), so it
 * overrides the raw DATE on {@link ImportStagingRow}.
 *
 * @typedef {Pick<ImportStagingRow,
 *   'id'|'row_index'|'amount'|'recipient_raw'|'memo'|'currency'|'raw_data'|'bank_account'|'balance'>
 *   & { tx_date: string|null }} PendingStagingRow
 */

/**
 * Run the validate phase: reject unusable rows, hash the rest, and flag
 * intra-batch duplicates.
 *
 * @param {{ batchId: ImportBatchId, onProgress?: ImportProgressCallback }} args
 * @returns {Promise<{ validated: number, duplicates: number, errors: number }>}
 */
export async function validateBatch({ batchId, onProgress }) {
  await query(`UPDATE import_batches SET status = 'validating' WHERE id = $1`, [
    batchId,
  ]);

  // tx_date via to_char, matching commit.js: read raw, a pg DATE arrives as a
  // server-local-midnight Date whose toISOString() (in the fallback hash below)
  // rolls back a day east of UTC — and silently changes fallback hashes if the
  // server timezone ever changes between imports.
  const { rows: pending } = await query(
    `SELECT id, row_index, to_char(tx_date, 'YYYY-MM-DD') AS tx_date,
            amount, recipient_raw, memo, currency, raw_data, bank_account, balance
       FROM import_staging_rows
      WHERE batch_id = $1 AND status = 'pending'
      ORDER BY row_index ASC`,
    [batchId],
  );

  const total = pending.length;
  let seen = 0;
  let errors = 0;
  let duplicates = 0;
  // tx_hashes seen so far in this batch — a repeat is an intra-batch duplicate
  // (the same row twice in one CSV) and is dropped here rather than inserted
  // twice at commit time.
  /** @type {Set<string>} */
  const seenHashes = new Set();

  if (onProgress) onProgress({ phase: "validating", current: 0, total });

  for (let start = 0; start < total; start += VALIDATE_CHUNK) {
    const chunk = pending.slice(start, start + VALIDATE_CHUNK);
    /** @type {string[]} */
    const ids = [];
    /** @type {string[]} */
    const statuses = [];
    /** @type {(string|null)[]} */
    const txHashes = [];
    /** @type {(string|null)[]} */
    const errorMessages = [];
    for (const row of /** @type {PendingStagingRow[]} */ (chunk)) {
      const issue = validateRow(row);
      ids.push(row.id);
      if (issue) {
        errors++;
        statuses.push("error");
        txHashes.push(null);
        errorMessages.push(issue);
      } else {
        const hash = computeRowHash(row);
        if (seenHashes.has(hash)) {
          duplicates++;
          statuses.push("duplicate");
          txHashes.push(hash);
          errorMessages.push(null);
        } else {
          seenHashes.add(hash);
          statuses.push("validated");
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
      [ids, statuses, txHashes, errorMessages],
    );
    seen += chunk.length;
    if (onProgress) onProgress({ phase: "validating", current: seen, total });
  }

  if (duplicates > 0) {
    await query(
      `UPDATE import_batches
          SET rows_duplicate = COALESCE(rows_duplicate, 0) + $2
        WHERE id = $1`,
      [batchId, duplicates],
    );
  }

  // `total`, `errors`, and `duplicates` are row counts (not currency), so plain
  // integer arithmetic is correct here — exempt from the monetary-arithmetic rule.
  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  const validated = total - errors - duplicates;
  logger.info("[pipeline:validate] done", {
    batchId,
    total,
    validated,
    duplicates,
    errors,
  });
  return { validated, duplicates, errors };
}

/**
 * @param {PendingStagingRow} row
 * @returns {string|null} the rejection reason, or null when the row is usable
 */
function validateRow(row) {
  if (!row.tx_date) return "missing tx_date";
  if (row.amount == null) return "missing amount";
  const n = Number(row.amount);
  if (!Number.isFinite(n)) return "invalid amount";
  return null;
}

/**
 * sha256 of the literal source record, falling back to a
 * date|amount|recipient|memo|currency field hash when the adapter kept no raw record.
 *
 * @param {PendingStagingRow} row
 * @returns {string} lowercase hex digest
 */
function computeRowHash(row) {
  let raw;
  if (row.raw_data) {
    raw = row.raw_data;
  } else {
    const dateStr = parsedDateToYmd(row.tx_date);
    const currencyKey = String(row.currency ?? "").trim() || "EUR";
    raw = `${dateStr}|${row.amount}|${row.recipient_raw || ""}|${row.memo || ""}|${currencyKey}`;
  }
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
}
