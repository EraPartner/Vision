/**
 * Real-database (SQLite) check that saving a cash projection also prunes
 * projections older than the two-month retention window, atomically with the
 * save. Replaces a mocked-pool test that asserted the statement's SQL text.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeTestPool, getTestPool } from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import insightCashProjectionRepository from "../src/repositories/insightCashProjectionRepository.ts";
import { must } from "./helpers/must.ts";

const METHOD = `retention-${process.pid}`;

/** YYYY-MM for the DB's current month minus `back` months. */
async function dbMonth(back: number): Promise<string> {
  const { rows } = await must(getTestPool(), "getTestPool()").query<{
    m: string;
  }>(
    `SELECT to_char(add_months(date_trunc('month', today()), $1), 'YYYY-MM') AS m`,
    [-back],
  );
  return must(rows[0], "rows[0]").m;
}

async function seed(rows: Array<[month: string, value: string]>) {
  for (const [month, value] of rows) {
    await must(getTestPool(), "getTestPool()").query(
      `INSERT INTO insight_cash_projections (month_start, currency, method_id, month_end_net_cashflow)
       VALUES (ts_date($1 || '-01'), 'EUR', $2, vision_numeric($3, 20, 4))`,
      [month, METHOD, value],
    );
  }
}

const get = (month: string) =>
  insightCashProjectionRepository.getProjection(month, "EUR", METHOD);

describe("insight cash projection retention (real DB)", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await must(getTestPool(), "getTestPool()").query(
      "DELETE FROM insight_cash_projections WHERE method_id = $1",
      [METHOD],
    );
  });

  afterAll(async () => {
    await closeTestPool();
    await closePool();
  });

  it("drops projections older than two months when a new one is saved", async () => {
    const [current, twoBack, threeBack] = await Promise.all([
      dbMonth(0),
      dbMonth(2),
      dbMonth(3),
    ]);
    await seed([
      [threeBack, "10"],
      [twoBack, "20"],
    ]);

    await insightCashProjectionRepository.saveProjection(
      current,
      "EUR",
      METHOD,
      250,
    );

    expect(await get(current)).toBe(250);
    expect(await get(twoBack)).toBe(20);
    expect(await get(threeBack)).toBeUndefined();
  });

  // The cutoff is the first day of the month two months back, on the local
  // calendar: month ends, a leap day and a year boundary must not move it.
  it.each([
    ["31 March (month end, February two back)", new Date(2026, 2, 31, 12), "2026-01", "2025-12"],
    ["29 February of a leap year", new Date(2024, 1, 29, 12), "2023-12", "2023-11"],
    ["31 January (year boundary)", new Date(2027, 0, 31, 12), "2026-11", "2026-10"],
    ["the first of a month just after midnight", new Date(2026, 4, 1, 0, 0, 1), "2026-03", "2026-02"],
  ])(
    "keeps the month two back and drops the one before it on %s",
    async (_label, now, kept, dropped) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      expect([await dbMonth(2), await dbMonth(3)]).toEqual([kept, dropped]);
      await seed([
        [dropped, "10.0001"],
        [kept, "20.0001"],
      ]);

      await insightCashProjectionRepository.saveProjection(
        await dbMonth(0),
        "EUR",
        METHOD,
        0.1 + 0.2,
      );

      expect(await get(kept)).toBe(20.0001);
      expect(await get(dropped)).toBeUndefined();
      // The money column keeps its NUMERIC(20,4) scale exactly.
      const { rows } = await must(getTestPool(), "getTestPool()").query<{
        v: string;
      }>(
        `SELECT month_end_net_cashflow AS v FROM insight_cash_projections
          WHERE method_id = $1 AND month_start = ts_date($2 || '-01')`,
        [METHOD, await dbMonth(0)],
      );
      expect(rows).toEqual([{ v: "0.3000" }]);
    },
  );

  it("keeps the row it saves even when that month is already past the cutoff", async () => {
    const [threeBack, fourBack] = await Promise.all([dbMonth(3), dbMonth(4)]);
    await seed([[fourBack, "10"]]);

    await insightCashProjectionRepository.saveProjection(
      threeBack,
      "EUR",
      METHOD,
      30,
    );

    expect(await get(threeBack)).toBe(30);
    expect(await get(fourBack)).toBeUndefined();
  });
});
