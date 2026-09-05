/** Parameterized SQL writes for portfolio transactions. */

import { query } from "../database/connection.js";
import { buildSetClauses } from "../lib/sqlClauses.js";
import { mapPortfolioTxRow } from "./portfolioTxRepo.reads.js";
import { hasPortfolioTransactionImportBatchIdColumn } from "./portfolioTxRepo.common.js";

/** @typedef {import('../types/rows.js').PortfolioTransactionRow} PortfolioTransactionRow */

/** @param {import('../services/portfolio/portfolioTransactionRules.js').PortfolioTransactionInput} payload */
export async function insert(payload) {
  const columns = [
    "investment_id",
    "type",
    "date",
    "amount",
    "units",
    "price_per_unit",
    "fees",
    "taxes",
    "dividend_amount_convention",
    "currency",
    "note",
    "is_recurring",
    "recurrence_interval",
    "recurrence_end_date",
    "fx_rate_to_eur",
    "account_id",
  ];
  const values = [
    payload.investment_id,
    payload.type,
    payload.date,
    payload.amount,
    payload.units ?? null,
    payload.price_per_unit ?? null,
    payload.fees ?? 0,
    payload.taxes ?? 0,
    payload.dividend_amount_convention ?? "unknown",
    payload.currency,
    payload.note || null,
    payload.is_recurring || false,
    payload.recurrence_interval || null,
    payload.recurrence_end_date || null,
    payload.fx_rate_to_eur ?? null,
    payload.account_id ?? null,
  ];
  if (
    payload.import_batch_id != null &&
    (await hasPortfolioTransactionImportBatchIdColumn())
  ) {
    columns.push("import_batch_id");
    values.push(payload.import_batch_id);
  }
  const result = await query(
    `INSERT INTO portfolio_transactions
       (${columns.join(", ")})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
       RETURNING *`,
    values,
  );
  return mapPortfolioTxRow(result.rows[0]);
}

/** @param {number} id @param {Record<string, any>} fields @param {PortfolioTransactionRow|null} [unchanged] */
export async function updateFields(id, fields, unchanged = null) {
  const allowed = [
    "date",
    "amount",
    "units",
    "price_per_unit",
    "fees",
    "taxes",
    "dividend_amount_convention",
    "currency",
    "note",
    "is_recurring",
    "recurrence_interval",
    "recurrence_end_date",
    "fx_rate_to_eur",
    "account_id",
  ];
  const { clauses, params, nextIdx } = buildSetClauses(fields, { allowed });
  if (clauses.length === 0) return unchanged;
  params.push(id);
  const result = await query(
    `UPDATE portfolio_transactions SET ${clauses.join(", ")} WHERE id = $${nextIdx} RETURNING *`,
    params,
  );
  return result.rows[0] ? mapPortfolioTxRow(result.rows[0]) : null;
}

/** @param {number} id @returns {Promise<boolean>} */
export async function hardDelete(id) {
  const result = await query(
    "DELETE FROM portfolio_transactions WHERE id = $1",
    [id],
  );
  return result.rowCount > 0;
}

/** @param {number|string} batchId @returns {Promise<Array<number|string>>} */
export async function hardDeleteByImportBatch(batchId) {
  if (!(await hasPortfolioTransactionImportBatchIdColumn())) return [];
  const result = await query(
    "DELETE FROM portfolio_transactions WHERE import_batch_id = $1 RETURNING id",
    [batchId],
  );
  return result.rows.map((/** @type {{id: number|string}} */ row) => row.id);
}

/** @param {number} targetId @param {number[]} sourceIds @returns {Promise<number>} */
export async function repointAccount(targetId, sourceIds) {
  const result = await query(
    "UPDATE portfolio_transactions SET account_id = $1 WHERE account_id = ANY($2::int[])",
    [targetId, sourceIds],
  );
  return result.rowCount ?? 0;
}
