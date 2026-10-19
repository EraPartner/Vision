import { sql } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  forecastMcCacheRowSchema,
  forecastUserIdRowSchema,
} from "../database/rows/info.ts";
import type { ForecastMcCacheRow } from "../database/rows/info.ts";
import type { Json } from "../database/schema.generated.ts";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** A cached forecast: the JSONB payload and when it was computed. */
export type McCacheRow = ForecastMcCacheRow;

export async function get({
  userId,
  month,
  filterHash,
}: {
  userId: string;
  month: string;
  filterHash: string;
}): Promise<McCacheRow | null> {
  const row = await checkedRow(
    forecastMcCacheRowSchema,
    db
      .selectFrom("cashflow_forecast_mc")
      .select(["payload", "computed_at"])
      .where("user_id", "=", userId)
      .where("month", "=", sql<Date>`(${month} || '-01')::date`)
      .where("filter_hash", "=", filterHash)
      .limit(1),
  );
  return row ?? null;
}

/**
 * @param computedAt TIMESTAMPTZ — pg hands this back as a `Date`.
 */
export function isFresh(computedAt: Date | string | number): boolean {
  return Date.now() - new Date(computedAt).getTime() < CACHE_TTL_MS;
}

export async function upsert({
  userId,
  month,
  filterHash,
  mcPaths,
  payload,
}: {
  userId: string;
  month: string;
  filterHash: string;
  mcPaths: number;
  payload: object;
}): Promise<void> {
  await db
    .insertInto("cashflow_forecast_mc")
    .values({
      user_id: userId,
      month: sql<Date>`(${month} || '-01')::date`,
      filter_hash: filterHash,
      mc_paths: mcPaths,
      payload: sql<Json>`${JSON.stringify(payload)}::jsonb`,
      computed_at: sql<Date>`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "month", "filter_hash"]).doUpdateSet((eb) => ({
        mc_paths: eb.ref("excluded.mc_paths"),
        payload: eb.ref("excluded.payload"),
        computed_at: sql<Date>`NOW()`,
      })),
    )
    .execute();
}

/**
 * Drop all cached forecasts. Called when transactions change so the next
 * forecast (and its walk-forward backtest diagnostics) recomputes against the
 * new data instead of serving a stale 6-hour cache entry. Single-user app, so
 * clearing the whole (tiny) table is fine.
 */
export async function clearAll(): Promise<void> {
  await db.deleteFrom("cashflow_forecast_mc").execute();
}

/**
 * Returns distinct user_ids that have ever triggered a forecast (via accuracy records).
 * Used by the nightly job to know which users to pre-warm.
 */
export async function getActiveUserIds({
  strict = false,
}: { strict?: boolean } = {}): Promise<string[]> {
  try {
    const rows = await checkedRows(
      forecastUserIdRowSchema,
      db.selectFrom("cashflow_forecast_accuracy").select("user_id").distinct(),
    );
    const ids = rows.map((r) => r.user_id);
    if (!ids.includes("anonymous")) ids.push("anonymous");
    return ids;
  } catch (err) {
    if (strict) throw err;
    return ["anonymous"];
  }
}

export default { get, isFresh, upsert, getActiveUserIds, clearAll };
