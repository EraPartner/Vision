/**
 * Data access for `cashflow_forecast_accuracy`.
 * Table is defined in db/migrations/0001_baseline.sql.
 * All mutations use parameterised queries; UPSERT is idempotent on
 * (user_id, method_id, as_of_month).
 */

import { sql } from "kysely";
import { checkedRows, db } from "../database/db.ts";
import { forecastAccuracyRowSchema } from "../database/rows/info.ts";
import type { ForecastAccuracyRow } from "../database/rows/info.ts";

/**
 * A `cashflow_forecast_accuracy` read (`as_of_month` as 'YYYY-MM'), derived
 * from its checked row schema. `mape` is NULL when no month had a percentage
 * sample.
 */
export type AccuracyRow = ForecastAccuracyRow;

const accuracyColumns = [
  "user_id",
  "method_id",
  sql<string>`to_char(as_of_month, 'YYYY-MM')`.as("as_of_month"),
  "mae",
  "rmse",
  "mape",
  "sample_days",
  "recorded_at",
] as const;

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
  await db
    .insertInto("cashflow_forecast_accuracy")
    .values({
      user_id: userId,
      method_id: methodId,
      as_of_month: sql<Date>`(${asOfMonth} || '-01')::date`,
      mae,
      rmse,
      mape,
      sample_days: sampleDays,
      recorded_at: sql<Date>`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "method_id", "as_of_month"]).doUpdateSet((eb) => ({
        mae: eb.ref("excluded.mae"),
        rmse: eb.ref("excluded.rmse"),
        mape: eb.ref("excluded.mape"),
        sample_days: eb.ref("excluded.sample_days"),
        recorded_at: sql<Date>`NOW()`,
      })),
    )
    .execute();
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
  return checkedRows(
    forecastAccuracyRowSchema,
    db
      .selectFrom("cashflow_forecast_accuracy")
      .select(accuracyColumns)
      .where("user_id", "=", userId)
      .where("method_id", "=", methodId)
      .orderBy("as_of_month", "desc")
      .limit(limitMonths),
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
  return checkedRows(
    forecastAccuracyRowSchema,
    db
      .selectFrom("cashflow_forecast_accuracy")
      .distinctOn("method_id")
      .select(accuracyColumns)
      .where("user_id", "=", userId)
      .orderBy("method_id")
      .orderBy("as_of_month", "desc"),
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
  return checkedRows(
    forecastAccuracyRowSchema,
    db
      .selectFrom("cashflow_forecast_accuracy")
      .select(accuracyColumns)
      .where("user_id", "=", userId)
      .where(
        "as_of_month",
        ">=",
        sql<Date>`(date_trunc('month', CURRENT_DATE) - make_interval(months => ${limitMonths}))::date`,
      )
      .orderBy("method_id")
      .orderBy("as_of_month", "asc"),
  );
}

export default { upsert, getHistory, getLatestByMethod, getAllHistory };
