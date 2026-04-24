import { query } from '../database/connection.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * @param {{ userId: string, month: string, filterHash: string }} key
 * @returns {Promise<{ payload: object, computed_at: Date } | null>}
 */
export async function get({ userId, month, filterHash }) {
  const res = await query(
    `SELECT payload, computed_at
       FROM cashflow_forecast_mc
      WHERE user_id = $1 AND month = $2 AND filter_hash = $3
      LIMIT 1`,
    [userId, month, filterHash],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0];
}

export function isFresh(computedAt) {
  return Date.now() - new Date(computedAt).getTime() < CACHE_TTL_MS;
}

/**
 * @param {{ userId: string, month: string, filterHash: string, mcPaths: number, payload: object }} args
 */
export async function upsert({ userId, month, filterHash, mcPaths, payload }) {
  await query(
    `INSERT INTO cashflow_forecast_mc (user_id, month, filter_hash, mc_paths, payload, computed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
     ON CONFLICT (user_id, month, filter_hash)
     DO UPDATE SET
       mc_paths    = EXCLUDED.mc_paths,
       payload     = EXCLUDED.payload,
       computed_at = NOW()`,
    [userId, month, filterHash, mcPaths, JSON.stringify(payload)],
  );
}

/**
 * Returns distinct user_ids that have ever triggered a forecast (via accuracy records).
 * Used by the nightly job to know which users to pre-warm.
 */
export async function getActiveUserIds() {
  try {
    const res = await query(
      `SELECT DISTINCT user_id FROM cashflow_forecast_accuracy`,
    );
    const ids = res.rows.map((r) => r.user_id);
    if (!ids.includes('anonymous')) ids.push('anonymous');
    return ids;
  } catch {
    return ['anonymous'];
  }
}

export default { get, isFresh, upsert, getActiveUserIds };
