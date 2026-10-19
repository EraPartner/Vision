/**
 * Import pipeline — STAGE
 *
 * Parses the uploaded CSV via the resolved adapter and inserts each parsed
 * transaction into `import_staging_rows` with status='pending'. Creates the
 * parent `import_batches` row and transitions it through 'staging' →
 * next stage. No recipient resolution or dedup happens here.
 */

import { sql } from "kysely";
import { withTransaction } from "../../database/connection.ts";
import { checkedRows, db } from "../../database/db.ts";
import { importBatchIdRowSchema } from "../../database/rows/imports.ts";
import { ValidationError } from "../../middleware/errorHandler.ts";
import { logger } from "../../config/logger.ts";
import { parsedDateToYmd } from "../../lib/importDates.ts";
import { getAdapter } from "./adapters/index.ts";
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
  filename?: string | null | undefined;
  sizeBytes?: number | null | undefined;
  customConfig?: object | null | undefined;
}): Promise<number> {
  const [row] = await checkedRows(
    importBatchIdRowSchema,
    db
      .insertInto("import_batches")
      .values({
        adapter_name: adapterName,
        source_filename: filename || null,
        source_size_bytes: sizeBytes ?? null,
        custom_config: customConfig ? JSON.stringify(customConfig) : null,
        status: "pending",
        started_at: sql<Date>`NOW()`,
      })
      .returning("id"),
  );
  // INSERT ... RETURNING without ON CONFLICT yields its row or throws.
  if (!row) throw new Error("import_batches insert returned no row");
  return normalizeCreatedBatchId(row.id);
}

/**
 * Run the stage phase: parse the file, bulk-insert staging rows.
 *
 * Reject malformed data before inserting any rows. `rowsSkipped` on success
 * counts only deliberately excluded non-settled records.
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
  customConfig?: CustomTransactionParserConfig | null | undefined;
  onProgress?: ImportProgressCallback | undefined;
}): Promise<{ rowsTotal: number; rowsSkipped: number }> {
  // When a customConfig is supplied the import is column-mapping driven, not
  // tied to a built-in bank. The adapterName is then a free-form label (e.g. a
  // saved parser's name) that won't be in the static registry, so fall back to
  // the generic adapter — mirroring createAdapter() in adapters/index.ts.
  const adapter =
    customConfig && !getAdapter(adapterName)
      ? getAdapter("generic")
      : getAdapter(adapterName);
  if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);

  return runImportStageLifecycle({
    batchId,
    markStaging: () =>
      db
        .updateTable("import_batches")
        .set({ status: "staging" })
        .where("id", "=", String(batchId))
        .execute(),
    parseRows: async () => {
      const rows = await (customConfig &&
      typeof adapter.parseWithConfig === "function"
        ? adapter.parseWithConfig(filePath, customConfig)
        : adapter.parse(filePath));
      const rejected = (rows.skipped ?? 0) - (rows.excluded ?? 0);
      if (rejected > 0) {
        const diagnostics = rows.issues && rows.issues.length > 0
          ? ` ${rows.issues.join("; ")}.`
          : "";
        throw new ValidationError(
          `Import stopped: ${rejected} source row(s) could not be parsed. No transactions were imported.${diagnostics} Correct the invalid dates, amounts or CSV structure and import the file again.`,
          { details: { rejected_rows: rejected, parsed_rows: rows.length } },
        );
      }
      return rows;
    },
    persistTotal: (total) =>
      db
        .updateTable("import_batches")
        .set({ rows_total: total })
        .where("id", "=", String(batchId))
        .execute(),
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
  if (rows.length === 0) return;
  await withTransaction(async () => {
    await db
      .insertInto("import_staging_rows")
      .values(
        rows.map((r, i) => ({
          batch_id: String(batchId),
          row_index: startIndex + i,
          status: "pending",
          tx_date: parsedDateToYmd(r.date) ?? null,
          bank_account: r.bankAccount || null,
          recipient_raw: r.recipient || null,
          memo: r.memo || null,
          amount: r.amount ?? null,
          currency: r.currency || null,
          balance: r.balance ?? null,
          recipient_account: r.recipientAccount || null,
          recipient_address: r.recipientAddress || null,
          recipient_bank_name: r.recipientBankName || null,
          comment: r.comment || null,
          raw_data: r.rawData || null,
          source_transaction_id: r.sourceId || null,
          source_account_identity: r.bankAccount || null,
          bank_sequence: r.bankSequence ?? null,
        })),
      )
      .execute();
  });
}
