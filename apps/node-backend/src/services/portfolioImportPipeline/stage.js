/**
 * Portfolio import pipeline — STAGE
 *
 * Parses the uploaded CSV via the portfolio generic adapter and bulk-inserts
 * each parsed row into `portfolio_import_staging_rows` (status='pending').
 * Creates the parent `portfolio_import_batches` row. No type normalization,
 * instrument matching, or dedup happens here.
 */

import { query, withTransaction } from "../../database/connection.js";
import { logger } from "../../config/logger.js";
import { parsedDateToYmd } from "../../lib/importDates.js";
import { parseWithConfig } from "./portfolioGenericAdapter.js";
import {
  normalizeCreatedBatchId,
  runImportStageLifecycle,
} from "../importStageLifecycle.js";

/**
 * @typedef {import('../../types/rows.js').PortfolioImportStagingRow} PortfolioImportStagingRow
 * @typedef {import('./index.js').PortfolioImportBatchId} PortfolioImportBatchId
 * @typedef {import('./index.js').PortfolioImportProgressCallback} PortfolioImportProgressCallback
 */

/**
 * Create a new portfolio import batch row.
 *
 * @param {{ adapterName: string, filename?: string|null, sizeBytes?: number|null, customConfig?: object|null, defaultAssetClass?: string|null, defaultType?: string|null, isBrokerage?: boolean, accountId?: number|string|null }} args
 * @returns {Promise<number>} the new batch id, as a NUMBER.
 *
 *   `portfolio_import_batches.id` is BIGSERIAL and node-postgres hands BIGINT
 *   back as a STRING. Normalized here for the same reason as the transaction
 *   pipeline (see importPipeline/stage.js `createBatch`): the streaming/immediate
 *   import responses would otherwise emit `batch_id: "12"` while the review-commit
 *   route (routes/portfolioImportRoutes.js:491) emits `batch_id: 12`. NUMBER is
 *   the single wire type — it matches `coercedIdSchema` (lib/importBatchIds.js:17)
 *   and the frontend guards (`batch_id: z.number()` in
 *   apps/frontend/src/lib/api/portfolioImports.ts).
 */
export async function createBatch({
  adapterName,
  filename,
  sizeBytes,
  customConfig,
  defaultAssetClass,
  defaultType,
  isBrokerage = false,
  accountId,
}) {
  const result = await query(
    `INSERT INTO portfolio_import_batches
       (adapter_name, source_filename, source_size_bytes, custom_config, default_asset_class, default_type, is_brokerage, account_id, status, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
     RETURNING id`,
    [
      adapterName,
      filename || null,
      sizeBytes || null,
      customConfig ? JSON.stringify(customConfig) : null,
      defaultAssetClass || null,
      defaultType || null,
      !!isBrokerage,
      accountId != null ? Number(accountId) : null,
    ],
  );
  return normalizeCreatedBatchId(result.rows[0].id);
}

/**
 * Run the stage phase: parse the file, bulk-insert staging rows.
 *
 * @param {{ batchId: PortfolioImportBatchId, filePath: string, customConfig: import('./portfolioGenericAdapter.js').PortfolioParserConfig, onProgress?: PortfolioImportProgressCallback }} args
 * @returns {Promise<{ rowsTotal: number, rowsSkipped: number }>} `rowsSkipped` is
 *   the adapter's own count of data rows it could not interpret.
 */
export async function stageBatch({
  batchId,
  filePath,
  customConfig,
  onProgress,
}) {
  return runImportStageLifecycle({
    batchId,
    markStaging: () =>
      query(
        `UPDATE portfolio_import_batches SET status = 'staging' WHERE id = $1`,
        [batchId],
      ),
    parseRows: () => parseWithConfig(filePath, customConfig),
    persistTotal: (total) =>
      query(
        `UPDATE portfolio_import_batches SET rows_total = $1 WHERE id = $2`,
        [total, batchId],
      ),
    insertChunk: (rows, start) => insertStagingChunk(batchId, rows, start),
    onParsed: ({ total, skipped }) =>
      logger.info("[portfolio-pipeline:stage] parsed rows", {
        batchId,
        total,
        skipped,
      }),
    onProgress,
  });
}

/**
 * Bulk-insert one chunk of parsed rows as `portfolio_import_staging_rows`
 * (status 'pending' via the column default) in one multi-VALUES statement.
 *
 * @param {PortfolioImportBatchId} batchId
 * @param {import('./portfolioGenericAdapter.js').ParsedPortfolioRow[]} rows
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
      const ph = Array.from({ length: 15 }, (_, k) => `$${base + k + 1}`);
      // status defaults to 'pending' via the column default.
      placeholders.push(`(${ph.join(",")})`);
      values.push(
        batchId,
        idx,
        dateStr,
        r.typeRaw || null,
        r.symbolRaw || null,
        r.nameRaw || null,
        r.units != null ? r.units : null,
        r.pricePerUnit != null ? r.pricePerUnit : null,
        r.amount != null ? r.amount : null,
        r.fees != null ? r.fees : null,
        r.taxes != null ? r.taxes : null,
        r.currency || null,
        r.fxRateToEur != null ? r.fxRateToEur : null,
        r.note || null,
        r.rawData || null,
      );
    });

    const sql = `INSERT INTO portfolio_import_staging_rows
      (batch_id, row_index, tx_date, type_raw, symbol_raw, name_raw,
       units, price_per_unit, amount, fees, taxes, currency, fx_rate_to_eur, note, raw_data)
      VALUES ${placeholders.join(",")}`;
    await client.query(sql, values);
  });
}
