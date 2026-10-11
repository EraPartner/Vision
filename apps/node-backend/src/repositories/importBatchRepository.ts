/**
 * importBatchRepository — CRUD for import_batches.
 *
 * Provides history listing, detail fetch, and rollback (delete committed
 * transactions + mark batch as aborted). All DB access goes through the
 * shared query helper — no raw pool references in this file.
 */

import { query, withTransaction } from "../database/connection.ts";
import { queryOne, queryRows } from "../database/rowContracts.ts";
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

export async function listBatches({
  limit = 50,
  offset = 0,
}: { limit?: number; offset?: number } = {}): Promise<{
  batches: ImportBatchListRow[];
  total: number;
}> {
  const [batches, countRows] = await Promise.all([
    queryRows(
      importBatchListRowSchema,
      `SELECT
                b.id,
                b.adapter_name,
                b.source_filename,
                b.source_size_bytes,
                b.status,
                b.rows_total,
                b.rows_imported,
                b.rows_duplicate,
                b.rows_error,
                b.error_summary,
                b.started_at,
                b.completed_at,
                COUNT(t.id)::int AS transactions_remaining
             FROM import_batches b
             LEFT JOIN transactions t ON t.import_batch_id = b.id AND t.is_active = true
             GROUP BY b.id
             ORDER BY b.started_at DESC
             LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    queryRows(
      importBatchTotalRowSchema,
      "SELECT COUNT(*)::int AS total FROM import_batches",
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
  const row = await queryOne(
    importBatchRowSchema,
    `SELECT
            b.id,
            b.adapter_name,
            b.source_filename,
            b.source_size_bytes,
            b.custom_config,
            b.status,
            b.rows_total,
            b.rows_imported,
            b.rows_duplicate,
            b.rows_error,
            b.error_summary,
            b.started_at,
            b.completed_at,
            COUNT(t.id)::int AS transactions_remaining
         FROM import_batches b
         LEFT JOIN transactions t ON t.import_batch_id = b.id AND t.is_active = true
         WHERE b.id = $1
         GROUP BY b.id`,
    [id],
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
  return queryRows(
    importPreviewRowSchema,
    `SELECT
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
            rmp.pattern_kind AS matched_pattern_kind
           FROM import_staging_rows isr
           LEFT JOIN recipients r
             ON r.id = COALESCE(isr.user_override_recipient_id, isr.resolved_recipient_id)
           LEFT JOIN categories rdc ON rdc.id = r.default_category_id
           LEFT JOIN categories oc ON oc.id = isr.override_category_id
           LEFT JOIN recipient_match_patterns rmp ON rmp.id = isr.matched_pattern_id
          WHERE isr.batch_id = $1
            AND isr.status = 'matched'
          ORDER BY isr.row_index ASC`,
    [batchId],
  );
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
  const { rowCount } = await query(
    `UPDATE import_staging_rows
            SET user_override_recipient_id = $3
          WHERE id = $1 AND batch_id = $2 AND status = 'matched'`,
    [rowId, batchId, recipientId],
  );
  return rowCount ?? 0;
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
  const { rowCount } = await query(
    `UPDATE import_staging_rows
            SET override_category_id = $3
          WHERE id = $1 AND batch_id = $2 AND status = 'matched'`,
    [rowId, batchId, categoryId],
  );
  return rowCount ?? 0;
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
  const { rowCount } = await query(
    `UPDATE import_staging_rows SET status = 'duplicate' WHERE id = $1`,
    [rowId],
  );
  return rowCount ?? 0;
}

/** @returns rowCount */
export async function markStagingRowCommitted(
  rowId: number | string,
): Promise<number> {
  const { rowCount } = await query(
    `UPDATE import_staging_rows SET status = 'committed' WHERE id = $1`,
    [rowId],
  );
  return rowCount ?? 0;
}

/**
 * @param message  already truncated by the caller
 * @returns rowCount
 */
export async function markStagingRowError(
  rowId: number | string,
  message: string,
): Promise<number> {
  const { rowCount } = await query(
    `UPDATE import_staging_rows SET status = 'error', error_message = $2 WHERE id = $1`,
    [rowId, message],
  );
  return rowCount ?? 0;
}

export async function categoryExists(categoryId: number): Promise<boolean> {
  const { rows } = await query(
    `SELECT id FROM categories WHERE id = $1 LIMIT 1`,
    [categoryId],
  );
  return rows.length > 0;
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
    const { rowCount: deleted } = await client.query(
      `DELETE FROM transactions WHERE import_batch_id = $1`,
      [id],
    );

    // Clean up recipients this import auto-created that are now orphaned.
    // Candidates: referenced by this batch's staging rows AND created during the
    // import window (created_at >= the batch start) AND no longer referenced by any
    // transaction, planned transaction, or merge alias. This prevents rolled-back
    // imports from leaving behind zero-transaction recipients, without touching
    // pre-existing recipients (older created_at) or any still in use.
    const orphanRows = await queryRows(
      recipientIdOnlyRowSchema,
      `SELECT r.id FROM recipients r
              WHERE r.id IN (
                    SELECT resolved_recipient_id FROM import_staging_rows
                     WHERE batch_id = $1 AND resolved_recipient_id IS NOT NULL
                    UNION
                    SELECT user_override_recipient_id FROM import_staging_rows
                     WHERE batch_id = $1 AND user_override_recipient_id IS NOT NULL
                )
                AND r.created_at >= COALESCE(
                    (SELECT started_at FROM import_batches WHERE id = $1), to_timestamp(0))
                AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.recipient_id = r.id)
                AND NOT EXISTS (SELECT 1 FROM planned_transactions pt WHERE pt.recipient_id = r.id)
                AND NOT EXISTS (SELECT 1 FROM recipients r2 WHERE r2.primary_recipient_id = r.id)`,
      [id],
      client,
    );
    const orphanIds = orphanRows.map((r) => r.id);
    let recipientsRemoved = 0;
    if (orphanIds.length > 0) {
      // recipient_bank_accounts FK is NO ACTION, so clear those first; the rest cascade.
      await client.query(
        `DELETE FROM recipient_bank_accounts WHERE recipient_id = ANY($1::int[])`,
        [orphanIds],
      );
      const { rowCount } = await client.query(
        `DELETE FROM recipients WHERE id = ANY($1::int[])`,
        [orphanIds],
      );
      recipientsRemoved = rowCount ?? 0;
    }

    await client.query(
      `UPDATE import_batches
                SET status = 'aborted',
                    completed_at = NOW(),
                    rows_imported = 0
              WHERE id = $1`,
      [id],
    );

    return { deleted: deleted ?? 0, recipientsRemoved };
  });
}
