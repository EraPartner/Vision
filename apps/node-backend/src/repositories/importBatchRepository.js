/**
 * importBatchRepository — CRUD for import_batches.
 *
 * Provides history listing, detail fetch, and rollback (delete committed
 * transactions + mark batch as aborted). All DB access goes through the
 * shared query helper — no raw pool references in this file.
 */

import { query, getClient } from '../database/connection.js';

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
 * Rollback: delete all transactions created by this batch, then mark the
 * batch as 'aborted'. Runs in a single transaction so a partial failure
 * leaves the DB in a consistent state.
 *
 * @param {number} id
 * @returns {Promise<{ deleted: number }>}
 */
export async function rollbackBatch(id) {
    const client = await getClient();
    try {
        await client.query('BEGIN');

        const { rowCount: deleted } = await client.query(
            `DELETE FROM transactions WHERE import_batch_id = $1`,
            [id]
        );

        await client.query(
            `UPDATE import_batches
                SET status = 'aborted',
                    completed_at = NOW(),
                    rows_imported = 0
              WHERE id = $1`,
            [id]
        );

        await client.query('COMMIT');
        return { deleted: deleted ?? 0 };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}
