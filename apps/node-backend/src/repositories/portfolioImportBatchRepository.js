/**
 * portfolioImportBatchRepository — data access for portfolio_import_batches and
 * portfolio_import_staging_rows. Mirrors importBatchRepository (the transaction
 * side): all SQL for the portfolio import review/history flow lives here so the
 * service layer stays free of raw queries. All access goes through the shared
 * query helper — no raw pool references.
 */

import { query } from '../database/connection.js';

const BATCH_COLUMNS = `id, adapter_name, source_filename, source_size_bytes,
  default_asset_class, default_type, status, account_id,
  rows_total, rows_imported, rows_duplicate, rows_error,
  error_summary, started_at, completed_at`;

/**
 * Set the batch-level brokerage account (ADR-095). Lots committed from this batch
 * inherit it as their account_id (ADR-091). Pass null to clear.
 *
 * @param {number|string} batchId
 * @param {number|null|undefined} accountId
 * @returns {Promise<void>}
 */
export async function setBatchAccount(batchId, accountId) {
  await query(
    `UPDATE portfolio_import_batches SET account_id = $2 WHERE id = $1`,
    [batchId, accountId ?? null],
  );
}

/**
 * @param {{ limit?: number, offset?: number }} opts
 * @returns {Promise<{ batches: object[], total: number }>}
 */
export async function listBatches({ limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${BATCH_COLUMNS} FROM portfolio_import_batches
      ORDER BY started_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const countResult = await query(`SELECT COUNT(*)::int AS total FROM portfolio_import_batches`);
  return { batches: rows, total: countResult.rows[0]?.total ?? 0 };
}

/**
 * @param {number} id
 * @returns {Promise<Record<string, any>|undefined>}
 */
export async function getBatch(id) {
  const { rows } = await query(`SELECT ${BATCH_COLUMNS} FROM portfolio_import_batches WHERE id = $1`, [id]);
  return rows[0];
}

/**
 * Staging rows for the review preview, joined to their effective investment.
 * Caller groups by effective investment.
 *
 * @param {number} batchId
 * @returns {Promise<Record<string, any>[]>}
 */
export async function getPreviewRows(batchId) {
  const { rows } = await query(
    `SELECT isr.id,
            isr.row_index,
            isr.status,
            isr.route,
            to_char(isr.tx_date, 'YYYY-MM-DD') AS tx_date,
            isr.type,
            isr.type_raw,
            isr.symbol_raw,
            isr.name_raw,
            isr.units,
            isr.price_per_unit,
            isr.amount,
            isr.fees,
            isr.taxes,
            isr.currency,
            isr.fx_rate_to_eur,
            isr.note,
            isr.match_source,
            isr.error_message,
            isr.resolved_investment_id,
            isr.user_override_investment_id,
            COALESCE(isr.user_override_investment_id, isr.resolved_investment_id) AS effective_investment_id,
            inv.name AS investment_name,
            inv.symbol AS investment_symbol,
            inv.asset_class AS investment_asset_class
       FROM portfolio_import_staging_rows isr
       LEFT JOIN investments inv
         ON inv.id = COALESCE(isr.user_override_investment_id, isr.resolved_investment_id)
      WHERE isr.batch_id = $1
      ORDER BY isr.row_index ASC`,
    [batchId],
  );
  return rows;
}

/**
 * Set (or clear) user_override_investment_id on a single reviewable staging row.
 *
 * Also the repair path for a commit-phase error: pointing an `error` row (e.g.
 * "unresolved instrument") at a real holding resets it to `matched` and clears
 * its error_message so a re-commit re-drains it, and decrements the batch's
 * rows_error so the counters stay honest (that row will be re-counted as
 * imported/duplicate/error on the next commit). Clearing the override (null)
 * leaves an error row in `error` — there's nothing to re-commit.
 *
 * @param {{ batchId: number, rowId: number, investmentId: number|null }} args
 * @returns {Promise<number>} rowCount (0 if row not found / not in a reviewable status)
 */
export async function overrideInvestment({ batchId, rowId, investmentId }) {
  // The CTE captures the row's status BEFORE the update (locked FOR UPDATE) so
  // the caller can tell an error→matched reset from a plain re-point of an
  // already-matched row — RETURNING alone only sees the post-update state, which
  // is indistinguishable between the two.
  const result = await query(
    `WITH prev AS (
        SELECT id, status AS old_status
          FROM portfolio_import_staging_rows
         WHERE batch_id = $1 AND id = $2 AND status IN ('matched', 'error')
         FOR UPDATE
     ),
     upd AS (
        UPDATE portfolio_import_staging_rows r
           SET user_override_investment_id = $3,
               status = CASE
                 WHEN prev.old_status = 'error' AND $3 IS NOT NULL THEN 'matched'
                 ELSE r.status
               END,
               error_message = CASE
                 WHEN prev.old_status = 'error' AND $3 IS NOT NULL THEN NULL
                 ELSE r.error_message
               END
          FROM prev
         WHERE r.id = prev.id
        RETURNING prev.old_status
     )
     SELECT old_status FROM upd`,
    [batchId, rowId, investmentId],
  );

  // If we flipped an error row back to matched, the batch's cumulative
  // rows_error over-counts it — decrement so total counts don't exceed rows_total.
  if (result.rowCount > 0 && investmentId != null && result.rows[0]?.old_status === 'error') {
    await query(
      `UPDATE portfolio_import_batches
          SET rows_error = GREATEST(COALESCE(rows_error, 0) - 1, 0)
        WHERE id = $1`,
      [batchId],
    );
  }

  return result.rowCount;
}

/**
 * Fetch a staging row plus its batch's default asset class — the source fields
 * for creating a new holding from the review "create new" action.
 *
 * @param {{ batchId: number, rowId: number }} args
 * @returns {Promise<{ symbol_raw: string|null, name_raw: string|null, currency: string|null, default_asset_class: string|null }|undefined>}
 */
export async function getRowForInvestmentCreation({ batchId, rowId }) {
  const { rows } = await query(
    `SELECT isr.symbol_raw, isr.name_raw, isr.currency, b.default_asset_class
       FROM portfolio_import_staging_rows isr
       JOIN portfolio_import_batches b ON b.id = isr.batch_id
      WHERE isr.batch_id = $1 AND isr.id = $2`,
    [batchId, rowId],
  );
  return rows[0];
}

/**
 * Committed (id, route) pairs produced by a batch (for rollback).
 *
 * The route MUST travel with the id: a route='cash' row stores a
 * `transactions.id` in committed_txn_id while every other row stores a
 * portfolio-transaction id, and the two sequences are independent — feeding a
 * cash id to the portfolio hard-delete removed an UNRELATED trade that
 * happened to share the number.
 *
 * @param {number} batchId
 * @returns {Promise<Array<{id:number, route:string|null}>>}
 */
export async function getCommittedRows(batchId) {
  const { rows } = await query(
    `SELECT committed_txn_id AS id, route FROM portfolio_import_staging_rows
      WHERE batch_id = $1 AND committed_txn_id IS NOT NULL`,
    [batchId],
  );
  return rows;
}

/**
 * Reset a rolled-back batch's staging rows from 'committed' back to 'matched'
 * and clear their committed_txn_id (which, post-rollback, would dangle at
 * deleted ledger/portfolio rows). Called by rollbackBatch inside its
 * transaction, right before markBatchAborted.
 *
 * 'matched' is the exact pre-commit state (both routes drain from it), it is in
 * the status CHECK (0040: pending/validated/matched/committed/duplicate/error —
 * there is no 'rolled_back'), and no reader depends on 'committed' persisting
 * after an abort: the commit route refuses aborted batches, the preview totals
 * count by match_source/error, and the batch-level counters live on
 * portfolio_import_batches. It also makes any future "re-commit after rollback"
 * feature import-once instead of double-importing.
 *
 * @param {number} batchId
 * @returns {Promise<void>}
 */
export async function resetCommittedRowsToMatched(batchId) {
  await query(
    `UPDATE portfolio_import_staging_rows
        SET status = 'matched', committed_txn_id = NULL
      WHERE batch_id = $1 AND status = 'committed'`,
    [batchId],
  );
}

/**
 * @param {number} batchId
 * @returns {Promise<void>}
 */
export async function markBatchAborted(batchId) {
  await query(`UPDATE portfolio_import_batches SET status = 'aborted' WHERE id = $1`, [batchId]);
}
