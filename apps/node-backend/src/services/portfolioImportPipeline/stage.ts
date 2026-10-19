/**
 * Portfolio import pipeline — STAGE
 *
 * Parses the uploaded CSV via the portfolio generic adapter and bulk-inserts
 * each parsed row into `portfolio_import_staging_rows` (status='pending').
 * Creates the parent `portfolio_import_batches` row. No type normalization,
 * instrument matching, or dedup happens here.
 */

import { sql } from "kysely";
import type { RawBuilder } from "kysely";
import { withTransaction } from "../../database/connection.ts";
import { checkedRow, db } from "../../database/db.ts";
import type { Json } from "../../database/schema.generated.ts";
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
  filename?: string | null | undefined;
  sizeBytes?: number | null | undefined;
  customConfig?: object | null | undefined;
  defaultAssetClass?: string | null | undefined;
  defaultType?: string | null | undefined;
  isBrokerage?: boolean | undefined;
  accountId?: number | string | null | undefined;
}): Promise<number> {
  // A template, not the builder: the asset class and type defaults arrive as
  // unchecked strings and the column CHECK constraints validate them.
  const inserted = await checkedRow(
    bigintIdRowSchema,
    sql`INSERT INTO portfolio_import_batches
       (adapter_name, source_filename, source_size_bytes, custom_config, default_asset_class, default_type, is_brokerage, account_id, status, started_at)
     VALUES (${adapterName}, ${filename || null}, ${sizeBytes ?? null},
       ${customConfig ? JSON.stringify(customConfig) : null}, ${defaultAssetClass || null},
       ${defaultType || null}, ${!!isBrokerage}, ${accountId != null ? Number(accountId) : null},
       'pending', NOW())
     RETURNING id`,
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
  onProgress?: PortfolioImportProgressCallback | undefined;
}): Promise<{ rowsTotal: number; rowsSkipped: number }> {
  return runImportStageLifecycle({
    batchId,
    markStaging: () =>
      db
        .updateTable("portfolio_import_batches")
        .set({ status: "staging" })
        .where("id", "=", String(batchId))
        .execute(),
    parseRows: async () => {
      const parsed = await parseWithConfig(filePath, customConfig);
      if (customConfig.format === "ibkr_funding_history") {
        if (customConfig.included_symbols)
          throw new Error(
            "IBKR funding history cannot be filtered by investment symbol",
          );
        const context = parsed.ibkrFundingSourceContext;
        await mergeBatchConfig(
          batchId,
          "ibkr_funding_source_context",
          sql`${JSON.stringify(context)}::jsonb`,
        );
      }
      if (customConfig.format === "kinesis_transaction_history") {
        const context = await captureKinesisSourceContext(filePath, parsed);
        await mergeBatchConfig(
          batchId,
          "kinesis_source_context",
          sql`${JSON.stringify(context)}::jsonb`,
        );
      }
      const rows = applyPortfolioAssetScope(
        parsed,
        customConfig.included_symbols,
      );
      if (customConfig.included_symbols)
        await mergeBatchConfig(
          batchId,
          "scope_excluded_rows",
          sql`${parsed.length - rows.length}::int`,
        );
      if (rows.sourceColumns)
        await mergeBatchConfig(
          batchId,
          "source_columns",
          sql`${rows.sourceColumns}::text[]`,
        );
      const ibkrSourceContext = rows.ibkrSourceContext;
      if (ibkrSourceContext)
        await mergeBatchConfig(
          batchId,
          "ibkr_source_context",
          sql`${JSON.stringify(ibkrSourceContext)}::jsonb`,
        );
      return rows;
    },
    persistTotal: (total) =>
      db
        .updateTable("portfolio_import_batches")
        .set({ rows_total: total })
        .where("id", "=", String(batchId))
        .execute(),
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

/** Add one key to the batch's stored config, keeping the keys already there. */
async function mergeBatchConfig(
  batchId: PortfolioImportBatchId,
  key: string,
  value: RawBuilder<unknown>,
): Promise<void> {
  await db
    .updateTable("portfolio_import_batches")
    .set({
      custom_config: sql<Json>`COALESCE(custom_config,'{}'::jsonb)||jsonb_build_object(${key}::text,${value})`,
    })
    .where("id", "=", String(batchId))
    .execute();
}

/** Select complete parsed asset rows without changing literal source records or parse errors. */
function applyPortfolioAssetScope(
  rows: ParsedPortfolioRows,
  symbols: string[] | undefined,
): ParsedPortfolioRows {
  if ((symbols?.length ?? 0) === 0) return rows;
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
  if (rows.length === 0) return;
  const json = (value: unknown) =>
    value ? sql<Json>`${JSON.stringify(value)}::json` : null;
  await withTransaction(async () => {
    // status defaults to 'pending' via the column default.
    await db
      .insertInto("portfolio_import_staging_rows")
      .values(
        rows.map((r, i) => ({
          batch_id: batchId,
          row_index: startIndex + i,
          tx_date: parsedDateToYmd(r.date) ?? null,
          type_raw: r.typeRaw || null,
          symbol_raw: r.symbolRaw || null,
          name_raw: r.nameRaw || null,
          units: r.units ?? null,
          price_per_unit: r.pricePerUnit ?? null,
          amount: r.amount ?? null,
          fees: r.fees ?? null,
          taxes: r.taxes ?? null,
          currency: r.currency || null,
          fx_rate_to_eur: r.fxRateToEur ?? null,
          note: r.note || null,
          raw_data: r.rawData || null,
          source_transaction_id: r.sourceId || null,
          source_account_identity: r.sourceAccountIdentity || null,
          asset_transfer_details: json(r.assetTransfer),
          asset_adjustment_details: json(r.assetAdjustment),
        })),
      )
      .execute();
  });
}

export { applyPortfolioAssetScope as __applyPortfolioAssetScope };
