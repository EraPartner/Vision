import { sql } from "kysely";
import { checkedRow, db } from "../database/db.ts";
import { forecastMcCacheRowSchema } from "../database/rows/info.ts";
import type { Json } from "../database/schema.generated.ts";
import type { McCacheRow } from "./cashflowForecastMcRepository.ts";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface McRollingKey {
  userId: string;
  todayIso: string;
  daysBack: number;
  daysForward: number;
  filterHash: string;
}

export async function get({
  userId,
  todayIso,
  daysBack,
  daysForward,
  filterHash,
}: McRollingKey): Promise<McCacheRow | null> {
  const row = await checkedRow(
    forecastMcCacheRowSchema,
    db
      .selectFrom("cashflow_forecast_mc_rolling")
      .select(["payload", "computed_at"])
      .where("user_id", "=", userId)
      .where("today_iso", "=", sql<Date>`${todayIso}::date`)
      .where("days_back", "=", daysBack)
      .where("days_forward", "=", daysForward)
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
  todayIso,
  daysBack,
  daysForward,
  filterHash,
  mcPaths,
  payload,
}: McRollingKey & { mcPaths: number; payload: object }): Promise<void> {
  await db
    .insertInto("cashflow_forecast_mc_rolling")
    .values({
      user_id: userId,
      today_iso: sql<Date>`${todayIso}::date`,
      days_back: daysBack,
      days_forward: daysForward,
      filter_hash: filterHash,
      mc_paths: mcPaths,
      payload: sql<Json>`${JSON.stringify(payload)}::jsonb`,
      computed_at: sql<Date>`NOW()`,
    })
    .onConflict((oc) =>
      oc
        .columns(["user_id", "today_iso", "days_back", "days_forward", "filter_hash"])
        .doUpdateSet((eb) => ({
          mc_paths: eb.ref("excluded.mc_paths"),
          payload: eb.ref("excluded.payload"),
          computed_at: sql<Date>`NOW()`,
        })),
    )
    .execute();
}

/**
 * Drop all cached rolling forecasts — invalidated alongside the monthly cache
 * when transactions change so diagnostics recompute against fresh data.
 */
export async function clearAll(): Promise<void> {
  await db.deleteFrom("cashflow_forecast_mc_rolling").execute();
}

export default { get, isFresh, upsert, clearAll };
