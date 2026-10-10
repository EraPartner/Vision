/**
 * Data access for `cashflow_forecast_accuracy`.
 * Table created by Alembic migration 0012_cashflow_forecast_accuracy.
 * All mutations use parameterised queries; UPSERT is idempotent on
 * (user_id, method_id, as_of_month).
 */

import { query } from "../database/connection.ts";
import { queryRows } from "../database/rowContracts.ts";
import { forecastAccuracyRowSchema } from "../database/rows/info.ts";
import type { ForecastAccuracyRow } from "../database/rows/info.ts";

/**
 * A `cashflow_forecast_accuracy` read (`as_of_month` as 'YYYY-MM'), derived
 * from its checked row schema. `mape` is NULL when no month had a percentage
 * sample.
 */
export type AccuracyRow = ForecastAccuracyRow;

export interface AccuracyUpsert {
  userId: string;
  methodId: string;
  /** 'YYYY-MM' */
  asOfMonth: string;
  mae: number;
  rmse: number;
  mape: number | null;
  sampleDays: number;
}

/**
 * Upsert a backtest result. Idempotent per (user_id, method_id, as_of_month).
 */
async function upsert({
  userId,
  methodId,
  asOfMonth,
  mae,
  rmse,
  mape,
  sampleDays,
}: AccuracyUpsert): Promise<void> {
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
 */
async function getHistory({
  userId,
  methodId,
  limitMonths = 24,
}: {
  userId: string;
  methodId: string;
  limitMonths?: number;
}): Promise<AccuracyRow[]> {
  return queryRows(
    forecastAccuracyRowSchema,
    `SELECT user_id, method_id, to_char(as_of_month, 'YYYY-MM') AS as_of_month,
            mae, rmse, mape, sample_days, recorded_at
       FROM cashflow_forecast_accuracy
      WHERE user_id = $1 AND method_id = $2
      ORDER BY as_of_month DESC
      LIMIT $3`,
    [userId, methodId, limitMonths],
  );
}

/**
 * Return the most recent accuracy row per method for a given user.
 */
async function getLatestByMethod({
  userId,
}: {
  userId: string;
}): Promise<AccuracyRow[]> {
  return queryRows(
    forecastAccuracyRowSchema,
    `SELECT DISTINCT ON (method_id)
            user_id, method_id, to_char(as_of_month, 'YYYY-MM') AS as_of_month,
            mae, rmse, mape, sample_days, recorded_at
       FROM cashflow_forecast_accuracy
      WHERE user_id = $1
      ORDER BY method_id, as_of_month DESC`,
    [userId],
  );
}

/**
 * Return the most recent N months of accuracy for all methods, for a given user.
 * Useful for building trend sparklines per method in one query.
 */
async function getAllHistory({
  userId,
  limitMonths = 24,
}: {
  userId: string;
  limitMonths?: number;
}): Promise<AccuracyRow[]> {
  return queryRows(
    forecastAccuracyRowSchema,
    `SELECT user_id, method_id, to_char(as_of_month, 'YYYY-MM') AS as_of_month,
            mae, rmse, mape, sample_days, recorded_at
       FROM cashflow_forecast_accuracy
      WHERE user_id = $1
        AND as_of_month >=
            (date_trunc('month', CURRENT_DATE) - make_interval(months => $2))::date
      ORDER BY method_id, as_of_month ASC`,
    [userId, limitMonths],
  );
}

export default { upsert, getHistory, getLatestByMethod, getAllHistory };
