/**
 * Persistence for the audited portfolio broker re-tag operation.
 *
 * Every function uses the ambient transaction connection from query(). The
 * service wraps the complete compare-and-set mutation in withTransaction().
 */

import { query } from "../database/connection.js";

export async function lockPortfolioTransactionWrites() {
  await query("LOCK TABLE portfolio_transactions IN SHARE ROW EXCLUSIVE MODE");
}

/** @param {string} idempotencyKey */
export async function getAuditByIdempotencyKey(idempotencyKey) {
  const result = await query(
    `SELECT id, idempotency_key, request_fingerprint, from_account_id,
            to_account_id, transaction_ids, previous_assignments,
            selected_count, changed_count, created_at
       FROM portfolio_retag_audit
      WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0];
}

/** @param {number|null} accountId */
export async function lockEligibleDestinationAccount(accountId) {
  if (accountId == null) return undefined;
  const result = await query(
    `SELECT id, name, display_name, type, is_active
       FROM accounts
      WHERE id = $1
        AND is_active = true
        AND type = ANY($2::account_type[])
      FOR UPDATE`,
    [accountId, ["brokerage", "crypto_exchange", "wallet"]],
  );
  return result.rows[0];
}

/** @param {number[]} transactionIds */
export async function lockTransactions(transactionIds) {
  const result = await query(
    `SELECT id, investment_id, account_id
       FROM portfolio_transactions
      WHERE id = ANY($1::int[])
      ORDER BY id ASC
      FOR UPDATE`,
    [transactionIds],
  );
  return result.rows;
}

/** @param {number[]} investmentIds */
export async function getUnitEventsForInvestments(investmentIds) {
  const result = await query(
    `SELECT pt.id, pt.investment_id, pt.type,
            to_char(pt.date, 'YYYY-MM-DD') AS date,
            COALESCE(pt.amount, 0) AS amount,
            COALESCE(pt.units, 0) AS units,
            COALESCE(pt.fees, 0) AS fees,
            COALESCE(pt.taxes, 0) AS taxes,
            COALESCE(pt.currency, 'EUR') AS currency,
            pt.fx_rate_to_eur,
            CASE
              WHEN COALESCE(pt.currency, 'EUR') = 'EUR' THEN 1
              ELSE COALESCE(
                pt.fx_rate_to_eur,
                (SELECT er.rate_to_eur
                   FROM exchange_rates er
                  WHERE er.currency_code = pt.currency
                    AND er.rate_date <= pt.date
                  ORDER BY er.rate_date DESC
                  LIMIT 1)
              )
            END AS fx_multiplier_eur,
            pt.account_id,
            i.asset_class,
            COALESCE(i.current_price, 0) AS current_price,
            COALESCE(i.interest_rate, 0) AS interest_rate
       FROM portfolio_transactions pt
       JOIN investments i ON i.id = pt.investment_id
      WHERE pt.investment_id = ANY($1::int[])
      ORDER BY pt.investment_id ASC, pt.date ASC, pt.id ASC`,
    [investmentIds],
  );
  return result.rows;
}

export async function getHistoricalRates() {
  const result = await query(
    `SELECT currency_code,
            to_char(rate_date, 'YYYY-MM-DD') AS rate_date,
            rate_to_eur
       FROM exchange_rates
      ORDER BY currency_code ASC, rate_date ASC`,
  );
  return result.rows;
}

/**
 * @param {number[]} transactionIds
 * @param {number|null} fromAccountId
 * @param {number|null} toAccountId
 */
export async function compareAndSetAccount(
  transactionIds,
  fromAccountId,
  toAccountId,
) {
  const result = await query(
    `UPDATE portfolio_transactions
        SET account_id = $3
      WHERE id = ANY($1::int[])
        AND account_id IS NOT DISTINCT FROM $2
      RETURNING id`,
    [transactionIds, fromAccountId, toAccountId],
  );
  return result.rows.map((row) => Number(row.id));
}

/** @param {object} receipt */
export async function insertAudit(receipt) {
  const result = await query(
    `INSERT INTO portfolio_retag_audit
       (idempotency_key, request_fingerprint, from_account_id, to_account_id,
        transaction_ids, previous_assignments, selected_count, changed_count)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
     RETURNING id, idempotency_key, request_fingerprint, from_account_id,
               to_account_id, transaction_ids, previous_assignments,
               selected_count, changed_count, created_at`,
    [
      receipt.idempotency_key,
      receipt.request_fingerprint,
      receipt.from_account_id,
      receipt.to_account_id,
      JSON.stringify(receipt.transaction_ids),
      JSON.stringify(receipt.previous_assignments),
      receipt.selected_count,
      receipt.changed_count,
    ],
  );
  return result.rows[0];
}

export default {
  lockPortfolioTransactionWrites,
  getAuditByIdempotencyKey,
  lockEligibleDestinationAccount,
  lockTransactions,
  getUnitEventsForInvestments,
  getHistoricalRates,
  compareAndSetAccount,
  insertAudit,
};
