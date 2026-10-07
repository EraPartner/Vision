/**
 * Provider Quota Repository — data access for the provider_quota table.
 *
 * Table is created by Alembic migration
 * 0042_add_research_provider_mapping_and_quota. Holds per-provider, per-UTC-day
 * request counters so the quota governor's daily budget survives restarts
 * (ADR-079). All mutations use parameterised queries.
 */

import { query } from "../database/connection.ts";

type QuotaCountRow = {
  count: number;
};

/**
 * Current request count for a provider on a given UTC day. 0 if no row yet.
 * @param windowDate  YYYY-MM-DD (UTC)
 */
export async function getDayCount(
  provider: string,
  windowDate: string,
): Promise<number> {
  const result = await query<QuotaCountRow>(
    `SELECT count FROM provider_quota WHERE provider = $1 AND window_date = $2`,
    [provider, windowDate],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Atomically add `delta` to a provider's day counter, creating the row if absent.
 * @param windowDate  YYYY-MM-DD (UTC)
 */
export async function addDayCount(
  provider: string,
  windowDate: string,
  delta: number,
): Promise<void> {
  await query(
    `INSERT INTO provider_quota (provider, window_date, count, updated_at)
          VALUES ($1, $2, $3, NOW())
     ON CONFLICT (provider, window_date) DO UPDATE
        SET count = provider_quota.count + EXCLUDED.count`,
    [provider, windowDate, delta],
  );
}

/** Atomically reserve quota without crossing a hard daily ceiling. */
export async function tryReserveDay(
  provider: string,
  windowDate: string,
  limit: number,
  delta = 1,
): Promise<number | null> {
  if (delta < 1 || delta > limit) return null;
  const result = await query<QuotaCountRow>(
    `INSERT INTO provider_quota (provider, window_date, count, updated_at)
          VALUES ($1,$2,$3,NOW())
     ON CONFLICT (provider, window_date) DO UPDATE
        SET count = provider_quota.count + EXCLUDED.count, updated_at=NOW()
      WHERE provider_quota.count + EXCLUDED.count <= $4
      RETURNING count`,
    [provider, windowDate, delta, limit],
  );
  return result.rows[0]?.count ?? null;
}

/**
 * Build a QuotaStore backed by this repository, for the quota governor.
 */
export function createDbQuotaStore(): {
  getDayCount: typeof getDayCount;
  addDayCount: typeof addDayCount;
  tryReserveDay: typeof tryReserveDay;
} {
  return { getDayCount, addDayCount, tryReserveDay };
}
