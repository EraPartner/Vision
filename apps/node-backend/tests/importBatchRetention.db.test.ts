/**
 * Real-database (SQLite) boundary check for the startup prune of terminal
 * import batches (startup/warmup.ts). PostgreSQL deleted rows whose
 * `started_at < now() - interval '30 days'`; the port computes the same
 * instant with sub_interval(now(), '30 days') on canonical timestamp text
 * (ADR-263). A row exactly at the cutoff stays, one a millisecond older goes,
 * and only terminal statuses are pruned.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeTestPool, getTestPool } from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { __pruneOldImportBatches as pruneOldImportBatches } from "../src/startup/warmup.ts";

const ADAPTER = `retention-boundary-${process.pid}`;
const TABLES = ["import_batches", "portfolio_import_batches"] as const;

async function insertBatch(
  table: (typeof TABLES)[number],
  label: string,
  status: string,
  startedAt: Date,
) {
  await getTestPool().query(
    `INSERT INTO ${table} (adapter_name, source_filename, status, started_at)
     VALUES ($1, $2, $3, $4)`,
    [ADAPTER, label, status, startedAt],
  );
}

async function survivors(table: (typeof TABLES)[number]): Promise<string[]> {
  const { rows } = await getTestPool().query<{ source_filename: string }>(
    `SELECT source_filename FROM ${table} WHERE adapter_name = $1 ORDER BY source_filename`,
    [ADAPTER],
  );
  return rows.map((row) => row.source_filename);
}

describe("startup prune of old import batches (real DB)", () => {
  afterEach(async () => {
    vi.useRealTimers();
    for (const table of TABLES) {
      await getTestPool().query(`DELETE FROM ${table} WHERE adapter_name = $1`, [
        ADAPTER,
      ]);
    }
  });

  afterAll(async () => {
    await closeTestPool();
    await closePool();
  });

  // `now() - interval '30 days'` steps 30 calendar days back in the local zone
  // at the same wall-clock time, which is what Date#setDate does.
  const thirtyDaysBefore = (now: Date) => {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 30);
    return cutoff;
  };

  it.each([
    // 31 March minus 30 days is 1 March (February has 28 days in 2026).
    ["a month end", new Date(2026, 2, 31, 10), new Date(2026, 2, 1, 10)],
    // 30 March 2024 minus 30 days is the leap day.
    ["a leap year", new Date(2024, 2, 30, 0), new Date(2024, 1, 29, 0)],
    // Across the year boundary, a millisecond before midnight.
    ["a new year", new Date(2027, 0, 15, 23, 59, 59, 999), new Date(2026, 11, 16, 23, 59, 59, 999)],
  ])(
    "prunes terminal batches started before now() - 30 days at %s, keeping the cutoff instant",
    async (_label, now, cutoff) => {
      expect(thirtyDaysBefore(now)).toEqual(cutoff);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const at = (deltaMs: number) => new Date(cutoff.getTime() + deltaMs);
      for (const table of TABLES) {
        await insertBatch(table, "a-older-by-1ms", "complete", at(-1));
        await insertBatch(table, "b-at-cutoff", "complete", at(0));
        await insertBatch(table, "c-newer-by-1ms", "complete", at(1));
        await insertBatch(table, "d-failed-a-day-older", "failed", at(-86_400_000));
        await insertBatch(table, "e-aborted-older", "aborted", at(-1));
        await insertBatch(table, "f-pending-60-days-older", "pending", at(-60 * 86_400_000));
      }

      await pruneOldImportBatches();

      for (const table of TABLES) {
        expect(await survivors(table), table).toEqual([
          "b-at-cutoff",
          "c-newer-by-1ms",
          "f-pending-60-days-older",
        ]);
      }
    },
  );
});
