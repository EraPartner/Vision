/**
 * Real-PostgreSQL check that saving a cash projection also prunes projections
 * older than the two-month retention window, atomically with the save.
 * Replaces a mocked-pool test that asserted the statement's SQL text.
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
import insightCashProjectionRepository from "../src/repositories/insightCashProjectionRepository.ts";
import { must } from "./helpers/must.ts";

const METHOD = `retention-${process.pid}`;

/** YYYY-MM for the DB's current month minus `back` months. */
async function dbMonth(back: number): Promise<string> {
  const { rows } = await must(getTestPool(), "getTestPool()").query<{
    m: string;
  }>(
    `SELECT to_char(date_trunc('month', CURRENT_DATE) - make_interval(months => $1), 'YYYY-MM') AS m`,
    [back],
  );
  return must(rows[0], "rows[0]").m;
}

describe.skipIf(!hasTestDatabase())(
  "insight cash projection retention (real DB)",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      await must(getTestPool(), "getTestPool()").query(
        "DELETE FROM insight_cash_projections WHERE method_id = $1",
        [METHOD],
      );
    });

    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    it("drops projections older than two months when a new one is saved", async () => {
      const [current, twoBack, threeBack] = await Promise.all([
        dbMonth(0),
        dbMonth(2),
        dbMonth(3),
      ]);
      await must(getTestPool(), "getTestPool()").query(
        `INSERT INTO insight_cash_projections (month_start, currency, method_id, month_end_net_cashflow)
       VALUES (($1 || '-01')::date, 'EUR', $3, 10), (($2 || '-01')::date, 'EUR', $3, 20)`,
        [threeBack, twoBack, METHOD],
      );

      await insightCashProjectionRepository.saveProjection(
        current,
        "EUR",
        METHOD,
        250,
      );

      const get = (month: string) =>
        insightCashProjectionRepository.getProjection(month, "EUR", METHOD);
      expect(await get(current)).toBe(250);
      expect(await get(twoBack)).toBe(20);
      expect(await get(threeBack)).toBeUndefined();
    });
  },
);
