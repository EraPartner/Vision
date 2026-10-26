/**
 * What node-postgres really hands back for the SQL result types the backend
 * declares (`sql<T>`, row schemas, src/types/rows.ts), against real PostgreSQL.
 *
 * No global type parsers are installed, so these pins keep the declared types
 * honest: a bigint expression typed `number` (ROW_NUMBER, COUNT) is a string at
 * runtime, and a SUM over a nullable column is NULL, not zero.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { getSummary } from "../src/repositories/portfolioTxRepo.reads.ts";
import { asInvestmentId } from "@vision/types/brands";
import { must } from "./helpers/must.ts";

const describeDb = hasTestDatabase() ? describe : describe.skip;
const MARK = `srt${process.pid}`;

describeDb("SQL result types match node-postgres output (real DB)", () => {
  let investmentId: number;

  beforeAll(async () => {
    await acquireDbSuiteLock();
    const pool = must(getTestPool(), "test pool");
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO investments (name, symbol, asset_class, currency)
       VALUES ($1, $1, 'stock', 'EUR') RETURNING id`,
      [MARK],
    );
    investmentId = must(rows[0], "investment row").id;
  });

  afterAll(async () => {
    try {
      const pool = getTestPool();
      if (pool) {
        await pool.query(
          "DELETE FROM portfolio_transactions WHERE investment_id = $1",
          [investmentId],
        );
        await pool.query("DELETE FROM investments WHERE id = $1", [
          investmentId,
        ]);
      }
    } finally {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    }
  });

  it("returns bigint, numeric, date and window counters in their documented JS types", async () => {
    const pool = must(getTestPool(), "test pool");
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT 1::int AS i,
              COUNT(*) OVER () AS window_count,
              ROW_NUMBER() OVER () AS rn,
              COUNT(*)::int AS cast_count,
              1.50::numeric AS n,
              1.5::real AS r,
              DATE '2026-03-04' AS d,
              to_char(DATE '2026-03-04', 'YYYY-MM-DD') AS d_text,
              ARRAY[1,2]::int[] AS ids,
              '{"a":1}'::jsonb AS j
         FROM generate_series(1, 2)
        GROUP BY 1, 5, 6, 7, 8, 9, 10
        ORDER BY 1`,
    );
    const row = must(rows[0], "result row");
    expect(row.i).toBe(1);
    // bigint arrives as a string: a `sql<number>` over ROW_NUMBER() or an
    // un-cast COUNT(*) would be a lie.
    expect(row.window_count).toBe("1");
    expect(row.rn).toBe("1");
    expect(row.cast_count).toBe(2);
    expect(row.n).toBe("1.50");
    expect(row.r).toBe(1.5);
    expect(row.d).toBeInstanceOf(Date);
    expect(row.d_text).toBe("2026-03-04");
    expect(row.ids).toEqual([1, 2]);
    expect(row.j).toEqual({ a: 1 });
  });

  it("emits null totals for a summary group whose units, fees and taxes are all NULL", async () => {
    const pool = must(getTestPool(), "test pool");
    await pool.query(
      `INSERT INTO portfolio_transactions (investment_id, type, date, amount, fees, taxes, currency)
       VALUES ($1, 'dividend', '2026-01-02', 12.5, NULL, NULL, 'EUR'),
              ($1, 'dividend', '2026-02-02', 7.25, NULL, NULL, 'EUR')`,
      [investmentId],
    );
    await pool.query(
      `INSERT INTO portfolio_transactions
         (investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency)
       VALUES ($1, 'buy', '2026-01-03', 100, 4, 25, 1.5, 0.25, 'EUR')`,
      [investmentId],
    );

    const summary = await getSummary(asInvestmentId(investmentId));
    const byType = new Map(summary.map((row) => [row.type, row]));

    expect(byType.get("dividend")).toMatchObject({
      total_amount: 19.75,
      total_units: null,
      total_fees: null,
      total_taxes: null,
      count: 2,
    });
    expect(byType.get("buy")).toMatchObject({
      total_amount: 100,
      total_units: 4,
      total_fees: 1.5,
      total_taxes: 0.25,
      count: 1,
    });
  });
});
