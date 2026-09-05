/**
 * Data access for `cashflow_forecast_accuracy`.
 * Table created by Alembic migration 0012_cashflow_forecast_accuracy.
 * All mutations use parameterised queries; UPSERT is idempotent on
 * (user_id, method_id, as_of_month).
 */

import { query } from "../database/connection.js";

/**
 * @typedef {Object} AccuracyRow
 * @property {string} user_id
 * @property {string} method_id
 * @property {string} as_of_month  - 'YYYY-MM'
 * @property {number} mae
 * @property {number} rmse
 * @property {number} mape
 * @property {number} sample_days
 * @property {Date} recorded_at - TIMESTAMPTZ, pg default parser (see types/rows.js)
 */

/**
 * Upsert a backtest result. Idempotent per (user_id, method_id, as_of_month).
 * @param {{ userId: string, methodId: string, asOfMonth: string,
 *            mae: number, rmse: number, mape: number, sampleDays: number }} params
 */
async function upsert({
  userId,
  methodId,
  asOfMonth,
  mae,
  rmse,
  mape,
  sampleDays,
}) {
  await query(
    `INSERT INTO cashflow_forecast_accuracy
            (user_id, method_id, as_of_month, mae, rmse, mape, sample_days, recorded_at)
          VALUES ($1, $2, ($3 || '-01')::date, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id, method_id, as_of_month) DO UPDATE
        SET mae         = EXCLUDED.mae,
            rmse        = EXCLUDED.rmse,
            mape        = EXCLUDED.mape,
            sample_days = EXCLUDED.sample_days,
            recorded_at = NOW()`,
    [userId, methodId, asOfMonth, mae, rmse, mape, sampleDays],
  );
}

/**
 * Return historical accuracy rows for a single method, newest first.
 * @param {{ userId: string, methodId: string, limitMonths?: number }} params
 * @returns {Promise<AccuracyRow[]>}
 */
async function getHistory({ userId, methodId, limitMonths = 24 }) {
  const result = await query(
    `SELECT user_id, method_id, to_char(as_of_month, 'YYYY-MM') AS as_of_month,
            mae, rmse, mape, sample_days, recorded_at
       FROM cashflow_forecast_accuracy
      WHERE user_id = $1 AND method_id = $2
      ORDER BY as_of_month DESC
      LIMIT $3`,
    [userId, methodId, limitMonths],
  );
  return result.rows;
}

/**
 * Return the most recent accuracy row per method for a given user.
 * @param {{ userId: string }} params
 * @returns {Promise<AccuracyRow[]>}
 */
async function getLatestByMethod({ userId }) {
  const result = await query(
    `SELECT DISTINCT ON (method_id)
            user_id, method_id, to_char(as_of_month, 'YYYY-MM') AS as_of_month,
            mae, rmse, mape, sample_days, recorded_at
       FROM cashflow_forecast_accuracy
      WHERE user_id = $1
      ORDER BY method_id, as_of_month DESC`,
    [userId],
  );
  return result.rows;
}

/**
 * Return the most recent N months of accuracy for all methods, for a given user.
 * Useful for building trend sparklines per method in one query.
 * @param {{ userId: string, limitMonths?: number }} params
 * @returns {Promise<AccuracyRow[]>}
 */
async function getAllHistory({ userId, limitMonths = 24 }) {
  const result = await query(
    `SELECT user_id, method_id, to_char(as_of_month, 'YYYY-MM') AS as_of_month,
            mae, rmse, mape, sample_days, recorded_at
       FROM cashflow_forecast_accuracy
      WHERE user_id = $1
        AND as_of_month >=
            (date_trunc('month', CURRENT_DATE) - make_interval(months => $2))::date
      ORDER BY method_id, as_of_month ASC`,
    [userId, limitMonths],
  );
  return result.rows;
}

export default { upsert, getHistory, getLatestByMethod, getAllHistory };
