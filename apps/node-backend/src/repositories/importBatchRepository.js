/**
 * importBatchRepository — CRUD for import_batches.
 *
 * Provides history listing, detail fetch, and rollback (delete committed
 * transactions + mark batch as aborted). All DB access goes through the
 * shared query helper — no raw pool references in this file.
 */

import { query, withTransaction } from '../database/connection.js';

/**
 * @param {{ limit?: number, offset?: number }} opts
 * @returns {Promise<{ batches: object[], total: number }>}
 */
export async function listBatches({ limit = 50, offset = 0 } = {}) {
    const [dataResult, countResult] = await Promise.all([
        query(
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
            [limit, offset]
        ),
        query('SELECT COUNT(*)::int AS total FROM import_batches'),
    ]);

    return {
        batches: dataResult.rows,
        total: countResult.rows[0].total,
    };
}

/**
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export async function getBatch(id) {
    const { rows } = await query(
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
        [id]
    );
    return rows[0] ?? null;
}

/**
 * Fetch staging rows for review preview. Joins recipient, default category,
 * override category, and matched pattern. Returns one row per staging row;
 * caller groups by effective recipient.
 *
 * @param {number} batchId
 * @returns {Promise<object[]>}
 */
export async function getPreviewRows(batchId) {
    const { rows } = await query(
        `SELECT
            isr.id,
            isr.row_index,
            isr.recipient_raw,
            isr.amount,
            isr.currency,
            isr.tx_date,
            isr.memo,
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
            oc.general AS override_category_general,
            oc.detail AS override_category_detail,
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
        [batchId]
    );
    return rows;
}

/**
 * Set (or clear) user_override_recipient_id on a single matched staging row.
 *
 * @param {{ batchId: number, rowId: number, recipientId: number|null }} args
 * @returns {Promise<number>} rowCount (0 if row not found / not in matched status)
 */
export async function overrideRecipient({ batchId, rowId, recipientId }) {
    const { rowCount } = await query(
        `UPDATE import_staging_rows
            SET user_override_recipient_id = $3
          WHERE id = $1 AND batch_id = $2 AND status = 'matched'`,
        [rowId, batchId, recipientId]
    );
    return rowCount ?? 0;
}

/**
 * Set (or clear) override_category_id on a single matched staging row.
 *
 * @param {{ batchId: number, rowId: number, categoryId: number|null }} args
 * @returns {Promise<number>} rowCount (0 if row not found / not in matched status)
 */
export async function overrideCategory({ batchId, rowId, categoryId }) {
    const { rowCount } = await query(
        `UPDATE import_staging_rows
            SET override_category_id = $3
          WHERE id = $1 AND batch_id = $2 AND status = 'matched'`,
        [rowId, batchId, categoryId]
    );
    return rowCount ?? 0;
}

/**
 * @param {number} categoryId
 * @returns {Promise<boolean>}
 */
export async function categoryExists(categoryId) {
    const { rows } = await query(
        `SELECT id FROM categories WHERE id = $1 LIMIT 1`,
        [categoryId]
    );
    return rows.length > 0;
}

/**
 * Rollback: delete all transactions created by this batch, then mark the
 * batch as 'aborted'. Runs in a single transaction so a partial failure
 * leaves the DB in a consistent state.
 *
 * @param {number} id
 * @returns {Promise<{ deleted: number }>}
 */
export async function rollbackBatch(id) {
    return withTransaction(async (client) => {
        const { rowCount: deleted } = await client.query(
            `DELETE FROM transactions WHERE import_batch_id = $1`,
            [id]
        );

        // Clean up recipients this import auto-created that are now orphaned.
        // Candidates: referenced by this batch's staging rows AND created during the
        // import window (created_at >= the batch start) AND no longer referenced by any
        // transaction, planned transaction, or merge alias. This prevents rolled-back
        // imports from leaving behind zero-transaction recipients, without touching
        // pre-existing recipients (older created_at) or any still in use.
        const { rows: orphanRows } = await client.query(
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
            [id]
        );
        const orphanIds = orphanRows.map((r) => r.id);
        let recipientsRemoved = 0;
        if (orphanIds.length > 0) {
            // recipient_bank_accounts FK is NO ACTION, so clear those first; the rest cascade.
            await client.query(
                `DELETE FROM recipient_bank_accounts WHERE recipient_id = ANY($1::int[])`,
                [orphanIds]
            );
            const { rowCount } = await client.query(
                `DELETE FROM recipients WHERE id = ANY($1::int[])`,
                [orphanIds]
            );
            recipientsRemoved = rowCount ?? 0;
        }

        await client.query(
            `UPDATE import_batches
                SET status = 'aborted',
                    completed_at = NOW(),
                    rows_imported = 0
              WHERE id = $1`,
            [id]
        );

        return { deleted: deleted ?? 0, recipientsRemoved };
    });
}
