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
 * @returns {Promise<object|undefined>}
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
 * @returns {Promise<object[]>}
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
 * Set (or clear) user_override_investment_id on a single matched staging row.
 *
 * @param {{ batchId: number, rowId: number, investmentId: number|null }} args
 * @returns {Promise<number>} rowCount (0 if row not found / not in matched status)
 */
export async function overrideInvestment({ batchId, rowId, investmentId }) {
  const result = await query(
    `UPDATE portfolio_import_staging_rows
        SET user_override_investment_id = $3
      WHERE batch_id = $1 AND id = $2 AND status = 'matched'`,
    [batchId, rowId, investmentId],
  );
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
 * Committed portfolio-transaction ids produced by a batch (for rollback).
 *
 * @param {number} batchId
 * @returns {Promise<number[]>}
 */
export async function getCommittedTxnIds(batchId) {
  const { rows } = await query(
    `SELECT committed_txn_id FROM portfolio_import_staging_rows
      WHERE batch_id = $1 AND committed_txn_id IS NOT NULL`,
    [batchId],
  );
  return rows.map((r) => r.committed_txn_id);
}

/**
 * @param {number} batchId
 * @returns {Promise<void>}
 */
export async function markBatchAborted(batchId) {
  await query(`UPDATE portfolio_import_batches SET status = 'aborted' WHERE id = $1`, [batchId]);
}
