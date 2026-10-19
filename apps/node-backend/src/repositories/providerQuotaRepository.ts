/**
 * Provider Quota Repository — data access for the provider_quota table.
 *
 * Table is defined in db/migrations/0001_baseline.sql. Holds per-provider, per-UTC-day
 * request counters so the quota governor's daily budget survives restarts
 * (ADR-079). All mutations use parameterised queries.
 */

import { sql } from "kysely";
import { checkedRow, db } from "../database/db.ts";
import { providerQuotaCountRowSchema } from "../database/rows/portfolio.ts";

/**
 * Current request count for a provider on a given UTC day. 0 if no row yet.
 * @param windowDate  YYYY-MM-DD (UTC)
 */
export async function getDayCount(
  provider: string,
  windowDate: string,
): Promise<number> {
  const row = await checkedRow(
    providerQuotaCountRowSchema,
    db
      .selectFrom("provider_quota")
      .select("count")
      .where("provider", "=", provider)
      .where("window_date", "=", sql<Date>`${windowDate}::date`),
  );
  return row?.count ?? 0;
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
  await db
    .insertInto("provider_quota")
    .values({
      provider,
      window_date: windowDate,
      count: delta,
      updated_at: sql<Date>`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(["provider", "window_date"]).doUpdateSet((eb) => ({
        count: eb("provider_quota.count", "+", eb.ref("excluded.count")),
      })),
    )
    .execute();
}

/** Atomically reserve quota without crossing a hard daily ceiling. */
export async function tryReserveDay(
  provider: string,
  windowDate: string,
  limit: number,
  delta = 1,
): Promise<number | null> {
  if (delta < 1 || delta > limit) return null;
  const row = await checkedRow(
    providerQuotaCountRowSchema,
    db
      .insertInto("provider_quota")
      .values({
        provider,
        window_date: windowDate,
        count: delta,
        updated_at: sql<Date>`NOW()`,
      })
      .onConflict((oc) =>
        oc
          .columns(["provider", "window_date"])
          .doUpdateSet((eb) => ({
            count: eb("provider_quota.count", "+", eb.ref("excluded.count")),
            updated_at: sql<Date>`NOW()`,
          }))
          .where(
            (eb) => eb("provider_quota.count", "+", eb.ref("excluded.count")),
            "<=",
            limit,
          ),
      )
      .returning("count"),
  );
  return row?.count ?? null;
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
