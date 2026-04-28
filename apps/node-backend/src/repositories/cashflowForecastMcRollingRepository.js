import { query } from '../database/connection.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * @param {{ userId: string, todayIso: string, daysBack: number, daysForward: number, filterHash: string }} key
 * @returns {Promise<{ payload: object, computed_at: Date } | null>}
 */
export async function get({ userId, todayIso, daysBack, daysForward, filterHash }) {
  const res = await query(
    `SELECT payload, computed_at
       FROM cashflow_forecast_mc_rolling
      WHERE user_id = $1 AND today_iso = $2 AND days_back = $3
        AND days_forward = $4 AND filter_hash = $5
      LIMIT 1`,
    [userId, todayIso, daysBack, daysForward, filterHash],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0];
}

export function isFresh(computedAt) {
  return Date.now() - new Date(computedAt).getTime() < CACHE_TTL_MS;
}

/**
 * @param {{ userId: string, todayIso: string, daysBack: number, daysForward: number, filterHash: string, mcPaths: number, payload: object }} args
 */
export async function upsert({ userId, todayIso, daysBack, daysForward, filterHash, mcPaths, payload }) {
  await query(
    `INSERT INTO cashflow_forecast_mc_rolling
       (user_id, today_iso, days_back, days_forward, filter_hash, mc_paths, payload, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
     ON CONFLICT (user_id, today_iso, days_back, days_forward, filter_hash)
     DO UPDATE SET
       mc_paths    = EXCLUDED.mc_paths,
       payload     = EXCLUDED.payload,
       computed_at = NOW()`,
    [userId, todayIso, daysBack, daysForward, filterHash, mcPaths, JSON.stringify(payload)],
  );
}

export default { get, isFresh, upsert };
