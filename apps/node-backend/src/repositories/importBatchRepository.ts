import { lockAccountsForLedgerMutation } from "./accountLifecycleLock.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../middleware/errorHandler.ts";
import { z } from "zod";
import { protectPlannedExecutions } from "./plannedExecutionGuard.ts";
/**
 * importBatchRepository — CRUD for import_batches.
 *
 * Provides history listing, detail fetch, and rollback (delete committed
 * transactions + mark batch as aborted). All DB access goes through the
 * shared query helper — no raw pool references in this file.
 */

import { sql } from "kysely";
import { asCategoryId, asRecipientId } from "@vision/types/brands";
import type { RecipientId, TransactionId } from "@vision/types/brands";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import { transactionKeyRowSchema } from "../database/rowSchemas.ts";
import {
  importBatchListRowSchema,
  importBatchRowSchema,
  importBatchTotalRowSchema,
  importPreviewRowSchema,
  recipientIdOnlyRowSchema,
} from "../database/rows/imports.ts";
import type {
  ImportBatchListRow,
  ImportPreviewRow,
} from "../database/rows/imports.ts";

import type { ImportBatchRow } from "../types/rows.ts";

export type { ImportBatchRow, ImportPreviewRow };

const BATCH_LIST_COLUMNS = [
  "b.id",
  "b.adapter_name",
  "b.source_filename",
  "b.source_size_bytes",
  "b.status",
  "b.rows_total",
  "b.rows_imported",
  "b.rows_duplicate",
  "b.rows_error",
  "b.error_summary",
  "b.started_at",
  "b.completed_at",
] as const;

/** Batches grouped by id with the count of their still-active transactions. */
function batchesWithRemaining() {
  return db
    .selectFrom("import_batches as b")
    .leftJoin("transactions as t", (join) =>
      join.onRef("t.import_batch_id", "=", "b.id").on("t.is_active", "=", true),
    )
    .select(sql<number>`COUNT(t.id)::int`.as("transactions_remaining"))
    .groupBy("b.id");
}

export async function listBatches({
  limit = 50,
  offset = 0,
}: { limit?: number; offset?: number } = {}): Promise<{
  batches: ImportBatchListRow[];
  total: number;
}> {
  const [batches, countRows] = await Promise.all([
    checkedRows(
      importBatchListRowSchema,
      batchesWithRemaining()
        .select(BATCH_LIST_COLUMNS)
        .orderBy("b.started_at", "desc")
        .limit(limit)
        .offset(offset),
    ),
    checkedRows(
      importBatchTotalRowSchema,
      db
        .selectFrom("import_batches")
        .select(sql<number>`COUNT(*)::int`.as("total")),
    ),
  ]);

  // An ungrouped COUNT(*) always returns exactly one row.
  const [countRow] = countRows;
  if (!countRow) throw new Error("import batch count returned no row");
  return { batches, total: countRow.total };
}

export async function getBatch(
  id: number | string,
): Promise<ImportBatchRow | null> {
  const row = await checkedRow(
    importBatchRowSchema,
    batchesWithRemaining()
      .select([...BATCH_LIST_COLUMNS, "b.custom_config"])
      .where("b.id", "=", String(id)),
  );
  return row ?? null;
}

/**
 * Fetch staging rows for review preview. Joins recipient, default category,
 * override category, and matched pattern. Returns one row per staging row;
 * caller groups by effective recipient.
 *
 * @returns one row per matched staging row
 */
export async function getPreviewRows(
  batchId: number | string,
): Promise<ImportPreviewRow[]> {
  return checkedRows(
    importPreviewRowSchema,
    sql`SELECT
            isr.id,
            isr.row_index,
            isr.recipient_raw,
            isr.amount,
            isr.currency,
            to_char(isr.tx_date, 'YYYY-MM-DD') AS tx_date,
            isr.memo,
            isr.bank_account,
            isr.match_source,
            isr.match_similarity,
            isr.matched_pattern_id,
            isr.resolved_recipient_id,
            isr.user_override_recipient_id,
            isr.override_category_id,
            COALESCE(isr.user_override_recipient_id, isr.resolved_recipient_id) AS effective_recipient_id,
            r.name AS recipient_name,
            r.default_category_id AS recipient_default_category_id,
            rdc.general AS recipient_default_category_general,
            rdc.detail AS recipient_default_category_detail,
            CASE WHEN rdc.legacy_compatible
                        AND rdc.path_name = rdc.general || ':' || rdc.detail
                 THEN NULL ELSE rdc.path_name END AS recipient_default_category_path,
            oc.general AS override_category_general,
            oc.detail AS override_category_detail,
            CASE WHEN oc.legacy_compatible
                        AND oc.path_name = oc.general || ':' || oc.detail
                 THEN NULL ELSE oc.path_name END AS override_category_path,
            rmp.pattern AS matched_pattern_text,
            rmp.pattern_kind AS matched_pattern_kind,
            -- Commit settles a row whose identity the ledger holds as a duplicate.
            EXISTS (
              SELECT 1 FROM transactions t
               WHERE t.dedup_fingerprint = isr.dedup_fingerprint
                 AND t.dedup_fingerprint_version = isr.dedup_fingerprint_version
            ) AS already_imported
           FROM import_staging_rows isr
           LEFT JOIN recipients r
             ON r.id = COALESCE(isr.user_override_recipient_id, isr.resolved_recipient_id)
           LEFT JOIN categories rdc ON rdc.id = r.default_category_id
           LEFT JOIN categories oc ON oc.id = isr.override_category_id
           LEFT JOIN recipient_match_patterns rmp ON rmp.id = isr.matched_pattern_id
          WHERE isr.batch_id = ${batchId}
            AND isr.status = 'matched'
          ORDER BY isr.row_index ASC`,
  );
}

/** Lock a batch still awaiting review, or refuse the override. */
async function lockBatchUnderReview(batchId: number): Promise<void> {
  const batch = await db
    .selectFrom("import_batches")
    .select("id")
    .where("id", "=", String(batchId))
    .where("status", "=", "awaiting_review")
    .forUpdate()
    .executeTakeFirst();
  if (!batch)
    throw new ConflictError(
      "Import review has ended; reload the batch before making changes",
    );
}

function updateMatchedStagingRow(batchId: number, rowId: number) {
  return db
    .updateTable("import_staging_rows")
    .where("id", "=", String(rowId))
    .where("batch_id", "=", String(batchId))
    .where("status", "=", "matched");
}

/**
 * Set (or clear) user_override_recipient_id on a single matched staging row.
 *
 * @returns rowCount (0 if row not found / not in matched status)
 */
export async function overrideRecipient({
  batchId,
  rowId,
  recipientId,
}: {
  batchId: number;
  rowId: number;
  recipientId: number | null;
}): Promise<number> {
  return withTransaction(async () => {
    await lockBatchUnderReview(batchId);
    const result = await updateMatchedStagingRow(batchId, rowId)
      .set({
        user_override_recipient_id:
          recipientId === null ? null : asRecipientId(recipientId),
      })
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  });
}

/**
 * Set (or clear) override_category_id on a single matched staging row.
 *
 * @returns rowCount (0 if row not found / not in matched status)
 */
export async function overrideCategory({
  batchId,
  rowId,
  categoryId,
}: {
  batchId: number;
  rowId: number;
  categoryId: number | null;
}): Promise<number> {
  return withTransaction(async () => {
    await lockBatchUnderReview(batchId);
    const result = await updateMatchedStagingRow(batchId, rowId)
      .set({
        override_category_id:
          categoryId === null ? null : asCategoryId(categoryId),
      })
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  });
}

async function setStagingRowStatus(
  rowId: number | string,
  values: { status: string; error_message?: string },
): Promise<number> {
  const result = await db
    .updateTable("import_staging_rows")
    .set(values)
    .where("id", "=", String(rowId))
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/**
 * Staging-row status transitions written by the commit phase. Composed inside
 * commitBatch's per-chunk withTransaction, so the ambient context routes them
 * onto the chunk's client and they roll back with it.
 *
 * @returns rowCount
 */
export async function markStagingRowDuplicate(
  rowId: number | string,
): Promise<number> {
  return setStagingRowStatus(rowId, { status: "duplicate" });
}

/** @returns rowCount */
export async function markStagingRowCommitted(
  rowId: number | string,
): Promise<number> {
  return setStagingRowStatus(rowId, { status: "committed" });
}

/**
 * @param message  already truncated by the caller
 * @returns rowCount
 */
export async function markStagingRowError(
  rowId: number | string,
  message: string,
): Promise<number> {
  return setStagingRowStatus(rowId, {
    status: "error",
    error_message: message,
  });
}

export async function categoryExists(categoryId: number): Promise<boolean> {
  const row = await db
    .selectFrom("categories")
    .select("id")
    .where("id", "=", asCategoryId(categoryId))
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Rollback: delete all transactions created by this batch, then mark the
 * batch as 'aborted'. Runs in a single transaction so a partial failure
 * leaves the DB in a consistent state.
 */
export async function rollbackBatch(
  id: number,
): Promise<{ deleted: number; recipientsRemoved: number }> {
  return withTransaction(async (client) => {
    // The route's earlier read is advisory. Serialize against the commit claim
    // and review overrides before discovering any ledger rows to remove.
    const batch = await checkedRow(
      z.object({ status: z.string() }),
      db
        .selectFrom("import_batches")
        .select("status")
        .where("id", "=", String(id))
        .forUpdate(),
    );
    if (!batch) throw new NotFoundError(`Import batch ${id} not found`);
    if (batch.status === "aborted")
      throw new ValidationError("Batch is already aborted");
    if (
      ["staging", "validating", "matching", "committing"].includes(batch.status)
    ) {
      throw new ValidationError(
        "Cannot rollback a batch that is still in progress",
      );
    }
    const targets = await checkedRows(
      transactionKeyRowSchema,
      db
        .selectFrom("transactions")
        .select("id")
        .where("import_batch_id", "=", String(id)),
    );
    const targetIds = targets.map((row) => row.id);
    await lockAccountsForLedgerMutation(client, targetIds);
    await protectPlannedExecutions(targetIds);
    const deleted = await db
      .deleteFrom("transactions")
      .where("import_batch_id", "=", String(id))
      .where("id", "=", sql<TransactionId>`ANY(${targetIds}::int[])`)
      .executeTakeFirst();

    // Clean up recipients this import auto-created that are now orphaned.
    // Candidates: referenced by this batch's staging rows AND created during the
    // import window (created_at >= the batch start) AND no longer referenced by any
    // transaction, planned transaction, or merge alias. This prevents rolled-back
    // imports from leaving behind zero-transaction recipients, without touching
    // pre-existing recipients (older created_at) or any still in use.
    const orphanRows = await checkedRows(
      recipientIdOnlyRowSchema,
      sql`SELECT r.id FROM recipients r
              WHERE r.id IN (
                    SELECT resolved_recipient_id FROM import_staging_rows
                     WHERE batch_id = ${id} AND resolved_recipient_id IS NOT NULL
                    UNION
                    SELECT user_override_recipient_id FROM import_staging_rows
                     WHERE batch_id = ${id} AND user_override_recipient_id IS NOT NULL
                )
                AND r.created_at >= COALESCE(
                    (SELECT started_at FROM import_batches WHERE id = ${id}), to_timestamp(0))
                AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.recipient_id = r.id)
                AND NOT EXISTS (SELECT 1 FROM planned_transactions pt WHERE pt.recipient_id = r.id)
                AND NOT EXISTS (SELECT 1 FROM recipients r2 WHERE r2.primary_recipient_id = r.id)`,
    );
    const orphanIds = orphanRows.map((r) => r.id);
    let recipientsRemoved = 0;
    if (orphanIds.length > 0) {
      // recipient_bank_accounts FK is NO ACTION, so clear those first; the rest cascade.
      const anyOrphan = sql<RecipientId>`ANY(${orphanIds}::int[])`;
      await db
        .deleteFrom("recipient_bank_accounts")
        .where("recipient_id", "=", anyOrphan)
        .execute();
      const removed = await db
        .deleteFrom("recipients")
        .where("id", "=", anyOrphan)
        .executeTakeFirst();
      recipientsRemoved = Number(removed.numDeletedRows);
    }

    await db
      .updateTable("import_batches")
      .set({
        status: "aborted",
        completed_at: sql<Date>`NOW()`,
        rows_imported: 0,
      })
      .where("id", "=", String(id))
      .execute();

    return { deleted: Number(deleted.numDeletedRows), recipientsRemoved };
  });
}
