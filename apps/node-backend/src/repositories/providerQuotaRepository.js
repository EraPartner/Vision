/**
 * Provider Quota Repository — data access for the provider_quota table.
 *
 * Table is created by Alembic migration
 * 0042_add_research_provider_mapping_and_quota. Holds per-provider, per-UTC-day
 * request counters so the quota governor's daily budget survives restarts
 * (ADR-079). All mutations use parameterised queries.
 */

import { query } from '../database/connection.js';

/**
 * Current request count for a provider on a given UTC day. 0 if no row yet.
 * @param {string} provider
 * @param {string} windowDate  YYYY-MM-DD (UTC)
 * @returns {Promise<number>}
 */
export async function getDayCount(provider, windowDate) {
  const result = await query(
    `SELECT count FROM provider_quota WHERE provider = $1 AND window_date = $2`,
    [provider, windowDate],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Atomically add `delta` to a provider's day counter, creating the row if absent.
 * @param {string} provider
 * @param {string} windowDate  YYYY-MM-DD (UTC)
 * @param {number} delta
 */
export async function addDayCount(provider, windowDate, delta) {
  await query(
    `INSERT INTO provider_quota (provider, window_date, count, updated_at)
          VALUES ($1, $2, $3, NOW())
     ON CONFLICT (provider, window_date) DO UPDATE
        SET count = provider_quota.count + EXCLUDED.count`,
    [provider, windowDate, delta],
  );
}

/**
 * Build a {@link QuotaStore} backed by this repository, for the quota governor.
 * @returns {{ getDayCount: typeof getDayCount, addDayCount: typeof addDayCount }}
 */
export function createDbQuotaStore() {
  return { getDayCount, addDayCount };
}
