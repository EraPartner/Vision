/**
 * Import pipeline — STAGE
 *
 * Parses the uploaded CSV via the resolved adapter and inserts each parsed
 * transaction into `import_staging_rows` with status='pending'. Creates the
 * parent `import_batches` row and transitions it through 'staging' →
 * next stage. No recipient resolution or dedup happens here.
 */

import { query, withTransaction } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import { parsedDateToYmd } from '../../lib/importDates.js';
import { getAdapter } from './adapters/index.js';
import generic from './adapters/generic.js';

/**
 * @typedef {import('../../types/rows.js').ImportStagingRow} ImportStagingRow
 * @typedef {import('./index.js').ImportBatchId} ImportBatchId
 * @typedef {import('./index.js').ImportProgressCallback} ImportProgressCallback
 */

const STAGE_INSERT_CHUNK = 500;

/**
 * Create a new import batch row.
 *
 * @param {{ adapterName: string, filename?: string|null, sizeBytes?: number|null, customConfig?: object|null }} args
 * @returns {Promise<string>} the new batch id — `import_batches.id` is BIGSERIAL,
 *   so node-postgres hands it back as a STRING, not a number.
 */
export async function createBatch({ adapterName, filename, sizeBytes, customConfig }) {
  const result = await query(
    `INSERT INTO import_batches
       (adapter_name, source_filename, source_size_bytes, custom_config, status, started_at)
     VALUES ($1, $2, $3, $4, 'pending', NOW())
     RETURNING id`,
    [adapterName, filename || null, sizeBytes || null, customConfig ? JSON.stringify(customConfig) : null]
  );
  return result.rows[0].id;
}

/**
 * Run the stage phase: parse the file, bulk-insert staging rows.
 *
 * @param {{ batchId: ImportBatchId, filePath: string, adapterName: string, customConfig?: object|null, onProgress?: ImportProgressCallback }} args
 * @returns {Promise<{ rowsTotal: number, rowsSkipped: number }>} `rowsSkipped` is
 *   the adapter's own count of data rows it could not interpret.
 */
export async function stageBatch({ batchId, filePath, adapterName, customConfig, onProgress }) {
  await query(
    `UPDATE import_batches SET status = 'staging' WHERE id = $1`,
    [batchId]
  );

  // When a customConfig is supplied the import is column-mapping driven, not
  // tied to a built-in bank. The adapterName is then a free-form label (e.g. a
  // saved parser's name) that won't be in the static registry, so fall back to
  // the generic adapter — mirroring createAdapter() in adapters/index.js.
  const adapter = (customConfig && !getAdapter(adapterName)) ? generic : getAdapter(adapterName);
  if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);

  const rows = await (customConfig && typeof adapter.parseWithConfig === 'function'
    ? adapter.parseWithConfig(filePath, customConfig)
    : adapter.parse(filePath));

  const total = rows.length;
  // Adapters attach a `skipped` count of unparseable data rows so an import that
  // silently dropped rows (encoding glitch, format drift) is visible rather than
  // "succeeding" with fewer rows and no signal.
  const skipped = Number(rows.skipped) || 0;
  logger.info('[pipeline:stage] parsed rows', { batchId, adapterName, total, skipped });

  await query(`UPDATE import_batches SET rows_total = $1 WHERE id = $2`, [total, batchId]);

  if (onProgress) onProgress({ phase: 'staging', current: 0, total });

  // Bulk insert in chunks using multi-VALUES statements.
  let inserted;
  for (let start = 0; start < total; start += STAGE_INSERT_CHUNK) {
    const end = Math.min(start + STAGE_INSERT_CHUNK, total);
    const slice = rows.slice(start, end);
    await insertStagingChunk(batchId, slice, start);
    inserted = end;
    if (onProgress) onProgress({ phase: 'staging', current: inserted, total });
  }

  return { rowsTotal: total, rowsSkipped: skipped };
}

/**
 * Bulk-insert one chunk of parsed rows as `import_staging_rows` (status
 * 'pending') in a single multi-VALUES statement.
 *
 * @param {ImportBatchId} batchId
 * @param {import('./adapters/_shared.js').ParsedBankTransaction[]} rows
 * @param {number} startIndex the chunk's offset, written to `row_index`
 * @returns {Promise<void>}
 */
async function insertStagingChunk(batchId, rows, startIndex) {
  if (!rows.length) return;
  await withTransaction(async (client) => {
    /** @type {any[]} */
    const values = [];
    /** @type {string[]} */
    const placeholders = [];
    rows.forEach((r, i) => {
      const idx = startIndex + i;
      const dateStr = parsedDateToYmd(r.date) ?? null;

      const base = values.length;
      placeholders.push(
        `($${base + 1},$${base + 2},'pending',$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14})`
      );
      values.push(
        batchId,
        idx,
        dateStr,
        r.bankAccount || null,
        r.recipient || null,
        r.memo || null,
        r.amount != null ? r.amount : null,
        r.currency || null,
        r.balance != null ? r.balance : null,
        r.recipientAccount || null,
        r.recipientAddress || null,
        r.recipientBankName || null,
        r.comment || null,
        r.rawData || null,
      );
    });

    const sql = `INSERT INTO import_staging_rows
      (batch_id, row_index, status, tx_date, bank_account, recipient_raw, memo,
       amount, currency, balance, recipient_account, recipient_address,
       recipient_bank_name, comment, raw_data)
      VALUES ${placeholders.join(',')}`;

    await client.query(sql, values);
  });
}
