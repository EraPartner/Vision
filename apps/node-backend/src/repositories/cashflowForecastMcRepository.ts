import { query } from "../database/connection.ts";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** A cached forecast: the JSONB payload and when it was computed. */
export type McCacheRow = { payload: object; computed_at: Date };

export async function get({
  userId,
  month,
  filterHash,
}: {
  userId: string;
  month: string;
  filterHash: string;
}): Promise<McCacheRow | null> {
  const res = await query<McCacheRow>(
    `SELECT payload, computed_at
       FROM cashflow_forecast_mc
      WHERE user_id = $1 AND month = ($2 || '-01')::date AND filter_hash = $3
      LIMIT 1`,
    [userId, month, filterHash],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0];
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
  await query(
    `INSERT INTO cashflow_forecast_mc (user_id, month, filter_hash, mc_paths, payload, computed_at)
     VALUES ($1, ($2 || '-01')::date, $3, $4, $5::jsonb, NOW())
     ON CONFLICT (user_id, month, filter_hash)
     DO UPDATE SET
       mc_paths    = EXCLUDED.mc_paths,
       payload     = EXCLUDED.payload,
       computed_at = NOW()`,
    [userId, month, filterHash, mcPaths, JSON.stringify(payload)],
  );
}

/**
 * Drop all cached forecasts. Called when transactions change so the next
 * forecast (and its walk-forward backtest diagnostics) recomputes against the
 * new data instead of serving a stale 6-hour cache entry. Single-user app, so
 * clearing the whole (tiny) table is fine.
 */
export async function clearAll(): Promise<void> {
  await query("DELETE FROM cashflow_forecast_mc");
}

/**
 * Returns distinct user_ids that have ever triggered a forecast (via accuracy records).
 * Used by the nightly job to know which users to pre-warm.
 */
export async function getActiveUserIds({
  strict = false,
}: { strict?: boolean } = {}): Promise<string[]> {
  try {
    const res = await query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM cashflow_forecast_accuracy`,
    );
    const ids = res.rows.map((r) => r.user_id);
    if (!ids.includes("anonymous")) ids.push("anonymous");
    return ids;
  } catch (err) {
    if (strict) throw err;
    return ["anonymous"];
  }
}

export default { get, isFresh, upsert, getActiveUserIds, clearAll };
