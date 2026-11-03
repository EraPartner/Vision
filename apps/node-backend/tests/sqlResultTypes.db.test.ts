/**
 * What the SQLite driver really hands back for the SQL result types the
 * backend declares (`sql<T>`, row schemas, src/types/rows.ts), against the
 * per-file SQLite database (ADR-263, docs/reference/sqlite-sql-dialect.md).
 *
 * These pins keep the declared types honest: an expression column has no
 * declared type, so an un-hinted COUNT/ROW_NUMBER is a number while the
 * `::bigint` hint (or CAST AS TEXT) yields the string node-postgres returned
 * for int8; a BIGINT column reads as a string; and a dec_sum over a nullable
 * column is NULL, not zero.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestPool, getTestPool } from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { getSummary } from "../src/repositories/portfolioTxRepo.reads.ts";
import { asInvestmentId } from "@vision/types/brands";
import { must } from "./helpers/must.ts";

const MARK = `srt${process.pid}`;

describe("SQL result types match the documented driver output (real DB)", () => {
  let investmentId: number;

  beforeAll(async () => {
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
      await pool.query(
        "DELETE FROM portfolio_transactions WHERE investment_id = $1",
        [investmentId],
      );
      await pool.query("DELETE FROM investments WHERE id = $1", [
        investmentId,
      ]);
    } finally {
      await closeTestPool();
      await closePool();
    }
  });

  it("returns bigint, numeric, date and window counters in their documented JS types", async () => {
    const pool = must(getTestPool(), "test pool");
    const { rows } = await pool.query<Record<string, unknown>>(
      `WITH series(x) AS (VALUES (1), (2))
       SELECT 1 AS i,
              COUNT(*) OVER () AS window_count,
              COUNT(*) OVER () AS "window_count_hinted::bigint",
              ROW_NUMBER() OVER () AS rn,
              ROW_NUMBER() OVER () AS "rn_hinted::bigint",
              COUNT(*) AS cast_count,
              CAST(COUNT(*) AS TEXT) AS text_count,
              vision_numeric('1.5', 18, 2) AS n,
              1.5 AS r,
              '2026-03-04' AS "d::date",
              to_char('2026-03-04', 'YYYY-MM-DD') AS d_text,
              json_array(1, 2) AS "ids::json",
              vision_jsonb('{"a":1}') AS "j::json",
              (1 = 1) AS "b::bool"
         FROM series`,
    );
    const row = must(rows[0], "result row");
    expect(row.i).toBe(1);
    // An expression column has no declared type: an un-hinted window counter
    // or COUNT(*) is a number. The `::bigint` hint and CAST AS TEXT give the
    // decimal string node-postgres returned for int8, so a `sql<string>` over
    // them is honest and a `sql<number>` over the hinted form would be a lie.
    expect(row.window_count).toBe(1);
    expect(row.window_count_hinted).toBe("1");
    expect(row.rn).toBe(1);
    expect(row.rn_hinted).toBe("1");
    expect(row.cast_count).toBe(2);
    expect(row.text_count).toBe("2");
    expect(row.n).toBe("1.50");
    expect(row.r).toBe(1.5);
    expect(row.d).toBeInstanceOf(Date);
    expect((row.d as Date).getFullYear()).toBe(2026);
    expect((row.d as Date).getMonth()).toBe(2);
    expect((row.d as Date).getDate()).toBe(4);
    expect((row.d as Date).getHours()).toBe(0);
    expect(row.d_text).toBe("2026-03-04");
    expect(row.ids).toEqual([1, 2]);
    expect(row.j).toEqual({ a: 1 });
    expect(row.b).toBe(true);
    expect(Object.keys(row)).not.toContain("d::date");
  });

  it("reads DATE values and timestamp days as local calendar days on both DST change days", async () => {
    // ts_date (PostgreSQL `ts::date`) and the DATE reader follow the backend's
    // zone; the snapshot builder dates a holding's start with ts_date.
    const previousTz = process.env.TZ;
    process.env.TZ = "Europe/Brussels";
    try {
      const pool = must(getTestPool(), "test pool");
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT '2026-03-29' AS "spring::date",
                '2026-10-25' AS "autumn::date",
                to_char('2026-03-29', 'YYYY-MM-DD') AS spring_text,
                ts_date('2026-03-28T22:30:00.000000Z') AS spring_eve,
                ts_date('2026-03-28T23:30:00.000000Z') AS spring_after_midnight,
                ts_date('2026-10-24T22:30:00.000000Z') AS autumn_after_midnight,
                ts_date('2026-10-25T22:30:00.000000Z') AS autumn_eve_end,
                ts_date('2026-10-25T23:30:00.000000Z') AS autumn_next_day`,
      );
      const row = must(rows[0], "dst row");
      for (const [key, day] of [["spring", 29], ["autumn", 25]] as const) {
        const value = row[key] as Date;
        expect(value).toBeInstanceOf(Date);
        expect([value.getDate(), value.getHours(), value.getMinutes()]).toEqual([day, 0, 0]);
      }
      expect(row).toMatchObject({
        spring_text: "2026-03-29",
        // 23:30 CET on the 28th, then 00:30 CET on the 29th (UTC+1).
        spring_eve: "2026-03-28",
        spring_after_midnight: "2026-03-29",
        // 00:30 CEST (UTC+2) on the 25th; after the change UTC+1 again.
        autumn_after_midnight: "2026-10-25",
        autumn_eve_end: "2026-10-25",
        autumn_next_day: "2026-10-26",
      });
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });

  it("reads declared BIGINT, DECIMAL_TEXT and DATE_TEXT columns in their documented JS types", async () => {
    const pool = must(getTestPool(), "test pool");
    const { rows } = await pool.query<Record<string, unknown>>(
      `INSERT INTO portfolio_transactions (investment_id, type, date, amount, units, price_per_unit, currency)
       VALUES ($1, 'buy', '2026-03-04', vision_numeric('10.5', 18, 4),
               vision_numeric(dec_add('0.1', '0.2'), 18, 8), vision_numeric('35', 18, 6), 'EUR')
       RETURNING id, amount, units, price_per_unit, date`,
      [investmentId],
    );
    const row = must(rows[0], "inserted row");
    await pool.query("DELETE FROM portfolio_transactions WHERE id = $1", [row.id]);
    // portfolio_transactions.id is INT (integer in PostgreSQL) even though it
    // draws from the shared bigint sequence: it reads as a number.
    expect(typeof row.id).toBe("number");
    expect(row.amount).toBe("10.5000");
    expect(row.units).toBe("0.30000000");
    expect(row.price_per_unit).toBe("35.000000");
    expect(row.date).toBeInstanceOf(Date);
    expect((row.date as Date).getDate()).toBe(4);

    // The asset-adjustment and transfer keys from the same sequence are BIGINT
    // columns and read as decimal strings, as node-postgres returned int8.
    const { rows: seqRows } = await pool.query<Record<string, unknown>>(
      `SELECT name, type FROM pragma_table_info('portfolio_asset_adjustments') WHERE name = 'id'`,
    );
    expect(seqRows).toEqual([{ name: "id", type: "BIGINT" }]);
  });

  it("emits null totals for a summary group whose units, fees and taxes are all NULL", async () => {
    const pool = must(getTestPool(), "test pool");
    await pool.query(
      `INSERT INTO portfolio_transactions (investment_id, type, date, amount, fees, taxes, currency)
       VALUES ($1, 'dividend', '2026-01-02', vision_numeric('12.5', 18, 4), NULL, NULL, 'EUR'),
              ($1, 'dividend', '2026-02-02', vision_numeric('7.25', 18, 4), NULL, NULL, 'EUR')`,
      [investmentId],
    );
    await pool.query(
      `INSERT INTO portfolio_transactions
         (investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency)
       VALUES ($1, 'buy', '2026-01-03', vision_numeric('100', 18, 4), vision_numeric('4', 18, 8),
               vision_numeric('25', 18, 6), vision_numeric('1.5', 18, 4), vision_numeric('0.25', 18, 4), 'EUR')`,
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
