/**
 * Portfolio import pipeline — STAGE
 *
 * Parses the uploaded CSV via the portfolio generic adapter and bulk-inserts
 * each parsed row into `portfolio_import_staging_rows` (status='pending').
 * Creates the parent `portfolio_import_batches` row. No type normalization,
 * instrument matching, or dedup happens here.
 */

import { query, withTransaction } from "../../database/connection.ts";
import { queryOne } from "../../database/rowContracts.ts";
import { bigintIdRowSchema } from "../../database/rows/portfolioImport.ts";
import { logger } from "../../config/logger.ts";
import { parsedDateToYmd } from "../../lib/importDates.ts";
import { parseWithConfig } from "./portfolioGenericAdapter.ts";
import { captureKinesisSourceContext } from "../portfolioKinesisAdoptionScope.ts";
import {
  normalizeCreatedBatchId,
  runImportStageLifecycle,
} from "../importStageLifecycle.ts";
import type {
  ParsedPortfolioRow,
  ParsedPortfolioRows,
  PortfolioParserConfig,
} from "./portfolioGenericAdapter.ts";
import type {
  PortfolioImportBatchId,
  PortfolioImportProgressCallback,
} from "./index.ts";

/**
 * Create a new portfolio import batch row.
 *
 * @returns the new batch id, as a NUMBER.
 *
 *   `portfolio_import_batches.id` is BIGSERIAL and node-postgres hands BIGINT
 *   back as a STRING. Normalized here for the same reason as the transaction
 *   pipeline (see importPipeline/stage.js `createBatch`): the streaming/immediate
 *   import responses would otherwise emit `batch_id: "12"` while the review-commit
 *   route (routes/portfolioImportRoutes.js:491) emits `batch_id: 12`. NUMBER is
 *   the single wire type — it matches `coercedIdSchema` (lib/importBatchIds.ts:17)
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
}: {
  adapterName: string;
  filename?: string | null;
  sizeBytes?: number | null;
  customConfig?: object | null;
  defaultAssetClass?: string | null;
  defaultType?: string | null;
  isBrokerage?: boolean;
  accountId?: number | string | null;
}): Promise<number> {
  const inserted = await queryOne(
    bigintIdRowSchema,
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
  // INSERT ... RETURNING without ON CONFLICT yields exactly one row.
  return normalizeCreatedBatchId(inserted!.id);
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
  customConfig,
  onProgress,
}: {
  batchId: PortfolioImportBatchId;
  filePath: string;
  customConfig: PortfolioParserConfig;
  onProgress?: PortfolioImportProgressCallback;
}): Promise<{ rowsTotal: number; rowsSkipped: number }> {
  return runImportStageLifecycle({
    batchId,
    markStaging: () =>
      query(
        `UPDATE portfolio_import_batches SET status = 'staging' WHERE id = $1`,
        [batchId],
      ),
    parseRows: async () => {
      const parsed = await parseWithConfig(filePath, customConfig);
      if (customConfig.format === "ibkr_funding_history") {
        if (customConfig.included_symbols)
          throw new Error(
            "IBKR funding history cannot be filtered by investment symbol",
          );
        const context = parsed.ibkrFundingSourceContext;
        await query(
          "UPDATE portfolio_import_batches SET custom_config=COALESCE(custom_config,'{}'::jsonb)||jsonb_build_object('ibkr_funding_source_context',$2::jsonb) WHERE id=$1",
          [batchId, JSON.stringify(context)],
        );
      }
      if (customConfig.format === "kinesis_transaction_history") {
        const context = await captureKinesisSourceContext(filePath, parsed);
        await query(
          "UPDATE portfolio_import_batches SET custom_config=COALESCE(custom_config,'{}'::jsonb)||jsonb_build_object('kinesis_source_context',$2::jsonb) WHERE id=$1",
          [batchId, JSON.stringify(context)],
        );
      }
      const rows = applyPortfolioAssetScope(
        parsed,
        customConfig.included_symbols,
      );
      if (customConfig.included_symbols)
        await query(
          "UPDATE portfolio_import_batches SET custom_config=COALESCE(custom_config,'{}'::jsonb)||jsonb_build_object('scope_excluded_rows',$2::int) WHERE id=$1",
          [batchId, parsed.length - rows.length],
        );
      if (rows.sourceColumns)
        await query(
          "UPDATE portfolio_import_batches SET custom_config=COALESCE(custom_config,'{}'::jsonb)||jsonb_build_object('source_columns',$2::text[]) WHERE id=$1",
          [batchId, rows.sourceColumns],
        );
      const ibkrSourceContext = rows.ibkrSourceContext;
      if (ibkrSourceContext)
        await query(
          "UPDATE portfolio_import_batches SET custom_config=COALESCE(custom_config,'{}'::jsonb)||jsonb_build_object('ibkr_source_context',$2::jsonb) WHERE id=$1",
          [batchId, JSON.stringify(ibkrSourceContext)],
        );
      return rows;
    },
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

/** Select complete parsed asset rows without changing literal source records or parse errors. */
export function applyPortfolioAssetScope(
  rows: ParsedPortfolioRows,
  symbols: string[] | undefined,
): ParsedPortfolioRows {
  if (!symbols?.length) return rows;
  const selected = new Set(symbols);
  const found = new Set(
    rows.map((row) => row.symbolRaw?.toUpperCase()).filter(Boolean),
  );
  for (const symbol of selected)
    if (!found.has(symbol))
      throw new Error(`Selected asset ${symbol} is absent from the statement`);
  const scoped = rows.filter((row) =>
    selected.has(row.symbolRaw?.toUpperCase()),
  );
  // Cash legs belong to the same literal record as a selected asset leg.
  const records = new Set(scoped.map((row) => row.rawData));
  const result: ParsedPortfolioRows = rows.filter(
    (row) =>
      selected.has(row.symbolRaw?.toUpperCase()) ||
      (!row.symbolRaw && records.has(row.rawData)),
  );
  result.skipped = rows.skipped;
  result.sourceColumns = rows.sourceColumns;
  Object.assign(result, { ibkrSourceContext: rows.ibkrSourceContext });
  return result;
}

/**
 * Bulk-insert one chunk of parsed rows as `portfolio_import_staging_rows`
 * (status 'pending' via the column default) in one multi-VALUES statement.
 *
 * @param startIndex the chunk's offset, written to `row_index`
 */
async function insertStagingChunk(
  batchId: PortfolioImportBatchId,
  rows: ParsedPortfolioRow[],
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
      const ph = Array.from({ length: 19 }, (_, k) => `$${base + k + 1}`);
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
        r.sourceId || null,
        r.sourceAccountIdentity || null,
        r.assetTransfer ? JSON.stringify(r.assetTransfer) : null,
        r.assetAdjustment ? JSON.stringify(r.assetAdjustment) : null,
      );
    });

    const sql = `INSERT INTO portfolio_import_staging_rows
      (batch_id, row_index, tx_date, type_raw, symbol_raw, name_raw,
       units, price_per_unit, amount, fees, taxes, currency, fx_rate_to_eur, note, raw_data,
       source_transaction_id, source_account_identity, asset_transfer_details, asset_adjustment_details)
      VALUES ${placeholders.join(",")}`;
    await client.query(sql, values);
  });
}
