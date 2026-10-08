/**
 * Import pipeline — STAGE
 *
 * Parses the uploaded CSV via the resolved adapter and inserts each parsed
 * transaction into `import_staging_rows` with status='pending'. Creates the
 * parent `import_batches` row and transitions it through 'staging' →
 * next stage. No recipient resolution or dedup happens here.
 */

import { query, withTransaction } from "../../database/connection.ts";
import { logger } from "../../config/logger.ts";
import { parsedDateToYmd } from "../../lib/importDates.ts";
import { getAdapter } from "./adapters/index.ts";
import generic from "./adapters/generic.ts";
import type { CustomTransactionParserConfig } from "./adapters/generic.ts";
import type { ParsedBankTransaction } from "./adapters/_shared.ts";
import {
  normalizeCreatedBatchId,
  runImportStageLifecycle,
} from "../importStageLifecycle.ts";
import type { ImportBatchId, ImportProgressCallback } from "./index.ts";

/**
 * Create a new import batch row.
 *
 * @returns the new batch id, as a NUMBER.
 *
 *   `import_batches.id` is BIGSERIAL and node-postgres hands BIGINT back as a
 *   STRING, so this used to leak a string all the way to the wire: POST
 *   /api/import/csv answered `batch_id: "12"` while the review-commit route
 *   (routes/importRoutes.js:570), which reads the id back off the URL through
 *   `coercedIdSchema` (lib/importBatchIds.ts:17), answered `batch_id: 12` —
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
}: {
  adapterName: string;
  filename?: string | null;
  sizeBytes?: number | null;
  customConfig?: object | null;
}): Promise<number> {
  const result = await query<{ id: string }>(
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
 * @returns `rowsSkipped` is the adapter's own count of data rows it could not
 *   interpret.
 */
export async function stageBatch({
  batchId,
  filePath,
  adapterName,
  customConfig,
  onProgress,
}: {
  batchId: ImportBatchId;
  filePath: string;
  adapterName: string;
  customConfig?: CustomTransactionParserConfig | null;
  onProgress?: ImportProgressCallback;
}): Promise<{ rowsTotal: number; rowsSkipped: number }> {
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
 * @param startIndex the chunk's offset, written to `row_index`
 */
async function insertStagingChunk(
  batchId: ImportBatchId,
  rows: ParsedBankTransaction[],
  startIndex: number,
): Promise<void> {
  if (!rows.length) return;
  await withTransaction(async (client) => {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    rows.forEach((r, i) => {
      const idx = startIndex + i;
      const dateStr = parsedDateToYmd(r.date) ?? null;

      const base = values.length;
      placeholders.push(
        `($${base + 1},$${base + 2},'pending',$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15},$${base + 16})`,
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
        r.sourceId || null,
        r.bankAccount || null,
      );
    });

    const sql = `INSERT INTO import_staging_rows
      (batch_id, row_index, status, tx_date, bank_account, recipient_raw, memo,
       amount, currency, balance, recipient_account, recipient_address,
       recipient_bank_name, comment, raw_data, source_transaction_id,
       source_account_identity)
      VALUES ${placeholders.join(",")}`;

    await client.query(sql, values);
  });
}
