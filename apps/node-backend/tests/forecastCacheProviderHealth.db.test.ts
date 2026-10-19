/**
 * Real-PostgreSQL behaviour of the cash-flow forecast caches, the forecast
 * accuracy history and the provider-health counters. Replaces mocked-pool
 * tests that asserted the SQL text and bound parameters of these repositories.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import accuracyRepo from "../src/repositories/cashflowForecastAccuracyRepository.ts";
import mcRepo from "../src/repositories/cashflowForecastMcRepository.ts";
import rollingRepo from "../src/repositories/cashflowForecastMcRollingRepository.ts";
import providerHealthRepo from "../src/repositories/providerHealthRepository.ts";

const USER = `forecast-boundary-${process.pid}`;
const PROVIDER_PREFIX = `fpb${process.pid}`;

/** YYYY-MM for the DB's current month minus `back` months. */
async function dbMonth(back: number): Promise<string> {
  const { rows } = await getTestPool()!.query(
    `SELECT to_char(date_trunc('month', CURRENT_DATE) - make_interval(months => $1), 'YYYY-MM') AS m`,
    [back],
  );
  return rows[0].m;
}

describe.skipIf(!hasTestDatabase())(
  "forecast caches and provider health (real DB)",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      const pool = getTestPool()!;
      await pool.query(
        "DELETE FROM cashflow_forecast_accuracy WHERE user_id = $1",
        [USER],
      );
      await pool.query("DELETE FROM cashflow_forecast_mc WHERE user_id = $1", [
        USER,
      ]);
      await pool.query(
        "DELETE FROM cashflow_forecast_mc_rolling WHERE user_id = $1",
        [USER],
      );
      await pool.query("DELETE FROM provider_health WHERE provider LIKE $1", [
        `${PROVIDER_PREFIX}%`,
      ]);
    });

    afterAll(async () => {
      try {
        await releaseDbSuiteLock();
      } finally {
        await closeTestPool();
        await closePool();
      }
    });

    it("overwrites a Monte Carlo cache entry on the same key and misses on another", async () => {
      const key = { userId: USER, month: "2026-03", filterHash: "h" };
      await mcRepo.upsert({ ...key, mcPaths: 10, payload: { v: 1 } });
      await mcRepo.upsert({ ...key, mcPaths: 20, payload: { v: 2 } });
      expect((await mcRepo.get(key))?.payload).toEqual({ v: 2 });
      expect(await mcRepo.get({ ...key, filterHash: "other" })).toBeNull();

      const rollingKey = {
        userId: USER,
        todayIso: "2026-03-15",
        daysBack: 30,
        daysForward: 60,
        filterHash: "h",
      };
      await rollingRepo.upsert({
        ...rollingKey,
        mcPaths: 10,
        payload: { r: 1 },
      });
      await rollingRepo.upsert({
        ...rollingKey,
        mcPaths: 10,
        payload: { r: 2 },
      });
      expect((await rollingRepo.get(rollingKey))?.payload).toEqual({ r: 2 });
      expect(
        await rollingRepo.get({ ...rollingKey, daysForward: 61 }),
      ).toBeNull();
    });

    it("keeps one accuracy row per method and month, newest first and limited", async () => {
      const [m0, m1, m2] = await Promise.all([
        dbMonth(0),
        dbMonth(1),
        dbMonth(2),
      ]);
      const base = {
        userId: USER,
        methodId: "naive",
        rmse: 2,
        mape: null,
        sampleDays: 30,
      };
      await accuracyRepo.upsert({ ...base, asOfMonth: m2, mae: 3 });
      await accuracyRepo.upsert({ ...base, asOfMonth: m1, mae: 2 });
      await accuracyRepo.upsert({ ...base, asOfMonth: m0, mae: 9 });
      // Same key again: replaces the metrics instead of adding a row.
      await accuracyRepo.upsert({ ...base, asOfMonth: m0, mae: 1 });

      const history = await accuracyRepo.getHistory({
        userId: USER,
        methodId: "naive",
      });
      expect(history.map((r) => [r.as_of_month, r.mae])).toEqual([
        [m0, 1],
        [m1, 2],
        [m2, 3],
      ]);
      const limited = await accuracyRepo.getHistory({
        userId: USER,
        methodId: "naive",
        limitMonths: 2,
      });
      expect(limited.map((r) => r.as_of_month)).toEqual([m0, m1]);
    });

    it("returns the newest row per method and the windowed history in chronological order", async () => {
      const [m0, m1, m5] = await Promise.all([
        dbMonth(0),
        dbMonth(1),
        dbMonth(5),
      ]);
      const base = { userId: USER, mae: 1, rmse: 1, mape: 0.1, sampleDays: 30 };
      await accuracyRepo.upsert({ ...base, methodId: "ewma", asOfMonth: m1 });
      await accuracyRepo.upsert({ ...base, methodId: "ewma", asOfMonth: m0 });
      await accuracyRepo.upsert({ ...base, methodId: "naive", asOfMonth: m5 });
      await accuracyRepo.upsert({ ...base, methodId: "naive", asOfMonth: m1 });

      const latest = await accuracyRepo.getLatestByMethod({ userId: USER });
      expect(latest.map((r) => [r.method_id, r.as_of_month])).toEqual([
        ["ewma", m0],
        ["naive", m1],
      ]);

      const all = await accuracyRepo.getAllHistory({ userId: USER });
      expect(all.map((r) => [r.method_id, r.as_of_month])).toEqual([
        ["ewma", m1],
        ["ewma", m0],
        ["naive", m5],
        ["naive", m1],
      ]);
      // A 3-month window drops the five-month-old row.
      const windowed = await accuracyRepo.getAllHistory({
        userId: USER,
        limitMonths: 3,
      });
      expect(windowed.map((r) => r.as_of_month)).not.toContain(m5);
    });

    it("counts consecutive provider failures, resets on success and truncates messages", async () => {
      const a = `${PROVIDER_PREFIX}-a`;
      const b = `${PROVIDER_PREFIX}-b`;
      expect(await providerHealthRepo.findByProvider(a)).toBeNull();

      await providerHealthRepo.recordError(a, "quote", "x".repeat(2000));
      await providerHealthRepo.recordError(a, "quote", "second");
      let row = await providerHealthRepo.findByProvider(a);
      expect(row).toMatchObject({
        consecutive_failures: 2,
        last_error: "second",
      });

      await providerHealthRepo.recordError(b, "fx", "y".repeat(2000));
      expect(
        (await providerHealthRepo.findByProvider(b))?.last_error,
      ).toHaveLength(1000);
      // @ts-expect-error -- a non-string error reaches the runtime String() coercion
      await providerHealthRepo.recordError(b, "fx", { code: 500 });
      expect((await providerHealthRepo.findByProvider(b))?.last_error).toBe(
        "[object Object]",
      );

      await providerHealthRepo.recordSuccess(a, "quote");
      row = await providerHealthRepo.findByProvider(a);
      expect(row?.consecutive_failures).toBe(0);
      expect(row?.last_success_at).toBeInstanceOf(Date);

      const ours = (await providerHealthRepo.listAll()).filter((r) =>
        r.provider.startsWith(PROVIDER_PREFIX),
      );
      // Ordered by kind, then provider: "fx" sorts before "quote".
      expect(ours.map((r) => r.provider)).toEqual([b, a]);
    });
  },
);
