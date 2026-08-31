/**
 * Import pipeline — STAGE
 *
 * Parses the uploaded CSV via the resolved adapter and inserts each parsed
 * transaction into `import_staging_rows` with status='pending'. Creates the
 * parent `import_batches` row and transitions it through 'staging' →
 * next stage. No recipient resolution or dedup happens here.
 */

import { query, withTransaction } from "../../database/connection.js";
import { logger } from "../../config/logger.js";
import { parsedDateToYmd } from "../../lib/importDates.js";
import { getAdapter } from "./adapters/index.js";
import generic from "./adapters/generic.js";
import {
  normalizeCreatedBatchId,
  runImportStageLifecycle,
} from "../importStageLifecycle.js";

/**
 * @typedef {import('../../types/rows.js').ImportStagingRow} ImportStagingRow
 * @typedef {import('./index.js').ImportBatchId} ImportBatchId
 * @typedef {import('./index.js').ImportProgressCallback} ImportProgressCallback
 */

/**
 * Create a new import batch row.
 *
 * @param {{ adapterName: string, filename?: string|null, sizeBytes?: number|null, customConfig?: object|null }} args
 * @returns {Promise<number>} the new batch id, as a NUMBER.
 *
 *   `import_batches.id` is BIGSERIAL and node-postgres hands BIGINT back as a
 *   STRING, so this used to leak a string all the way to the wire: POST
 *   /api/import/csv answered `batch_id: "12"` while the review-commit route
 *   (routes/importRoutes.js:570), which reads the id back off the URL through
 *   `coercedIdSchema` (lib/importBatchIds.js:17), answered `batch_id: 12` —
 *   same JSON field, two types, so strict-equality across the two responses
 *   broke. Normalizing here, at the single boundary where the id enters the
 *   application, makes NUMBER the one wire type; it matches the coerced input
 *   schema and the frontend runtime guards (`batch_id: z.number()` in
 *   apps/frontend/src/lib/api/imports.ts).
 *
 *   Safe for this app: BIGSERIAL starts at 1 and increments per CSV import, so
 *   reaching 2^53 is not physically attainable. If that ever changes, the fix
 *   is to make the WIRE type a string everywhere, not to reintroduce the split.
 */
export async function createBatch({
  adapterName,
  filename,
  sizeBytes,
  customConfig,
}) {
  const result = await query(
    `INSERT INTO import_batches
       (adapter_name, source_filename, source_size_bytes, custom_config, status, started_at)
     VALUES ($1, $2, $3, $4, 'pending', NOW())
     RETURNING id`,
    [
      adapterName,
      filename || null,
      sizeBytes || null,
      customConfig ? JSON.stringify(customConfig) : null,
    ],
  );
  return normalizeCreatedBatchId(result.rows[0].id);
}

/**
 * Run the stage phase: parse the file, bulk-insert staging rows.
 *
 * @param {{ batchId: ImportBatchId, filePath: string, adapterName: string, customConfig?: object|null, onProgress?: ImportProgressCallback }} args
 * @returns {Promise<{ rowsTotal: number, rowsSkipped: number }>} `rowsSkipped` is
 *   the adapter's own count of data rows it could not interpret.
 */
export async function stageBatch({
  batchId,
  filePath,
  adapterName,
  customConfig,
  onProgress,
}) {
  // When a customConfig is supplied the import is column-mapping driven, not
  // tied to a built-in bank. The adapterName is then a free-form label (e.g. a
  // saved parser's name) that won't be in the static registry, so fall back to
  // the generic adapter — mirroring createAdapter() in adapters/index.js.
  const adapter =
    customConfig && !getAdapter(adapterName)
      ? generic
      : getAdapter(adapterName);
  if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);

  return runImportStageLifecycle({
    batchId,
    markStaging: () =>
      query(`UPDATE import_batches SET status = 'staging' WHERE id = $1`, [
        batchId,
      ]),
    parseRows: () =>
      customConfig && typeof adapter.parseWithConfig === "function"
        ? adapter.parseWithConfig(filePath, customConfig)
        : adapter.parse(filePath),
    persistTotal: (total) =>
      query(`UPDATE import_batches SET rows_total = $1 WHERE id = $2`, [
        total,
        batchId,
      ]),
    insertChunk: (rows, start) => insertStagingChunk(batchId, rows, start),
    onParsed: ({ total, skipped }) =>
      logger.info("[pipeline:stage] parsed rows", {
        batchId,
        adapterName,
        total,
        skipped,
      }),
    onProgress,
  });
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
        `($${base + 1},$${base + 2},'pending',$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14})`,
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
      VALUES ${placeholders.join(",")}`;

    await client.query(sql, values);
  });
}
