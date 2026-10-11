import { query } from "../database/connection.ts";
import { queryOne } from "../database/rowContracts.ts";
import { forecastMcCacheRowSchema } from "../database/rows/info.ts";
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
  const row = await queryOne(
    forecastMcCacheRowSchema,
    `SELECT payload, computed_at
       FROM cashflow_forecast_mc_rolling
      WHERE user_id = $1 AND today_iso = $2::date AND days_back = $3
        AND days_forward = $4 AND filter_hash = $5
      LIMIT 1`,
    [userId, todayIso, daysBack, daysForward, filterHash],
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
  await query(
    `INSERT INTO cashflow_forecast_mc_rolling
       (user_id, today_iso, days_back, days_forward, filter_hash, mc_paths, payload, computed_at)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7::jsonb, NOW())
     ON CONFLICT (user_id, today_iso, days_back, days_forward, filter_hash)
     DO UPDATE SET
       mc_paths    = EXCLUDED.mc_paths,
       payload     = EXCLUDED.payload,
       computed_at = NOW()`,
    [
      userId,
      todayIso,
      daysBack,
      daysForward,
      filterHash,
      mcPaths,
      JSON.stringify(payload),
    ],
  );
}

/**
 * Drop all cached rolling forecasts — invalidated alongside the monthly cache
 * when transactions change so diagnostics recompute against fresh data.
 */
export async function clearAll(): Promise<void> {
  await query("DELETE FROM cashflow_forecast_mc_rolling");
}

export default { get, isFresh, upsert, clearAll };
