/**
 * Real-PostgreSQL persistence of exchange rates and asset price history.
 * Replaces the SQL-text cases of rateFetcher.test.ts (latest-marker rewrite,
 * historical upsert) and priceCache.test.ts (date-range binding, upsert,
 * default source) with the rows the database holds afterwards.
 *
 * Uses the ISO 4217 testing codes XTS/XXX so no real currency row is touched.
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
import { todayAppDateString } from "../src/lib/timezone.ts";
import investmentRepository from "../src/repositories/investmentRepository.ts";
import {
  loadFromDatabase,
  saveHistoricalRate,
  saveToDatabase,
} from "../src/services/currency/rateFetcher.ts";
import {
  loadHistoricalPointsFromDatabase,
  saveHistoricalPointsToDatabase,
} from "../src/services/prices/priceCache.ts";
import {
  asCurrencyCode,
} from "@vision/types/brands";
import { must } from "./helpers/must.ts";

/** A result row whose columns the test reads without a fixed shape. */
type DbRow = Record<string, unknown>;

const CODES = ["XTS", "XXX"];
let investmentId: number | undefined;

async function rateRows(code: string) {
  const { rows } = await must(getTestPool(), "getTestPool()").query<DbRow>(
    `SELECT to_char(rate_date, 'YYYY-MM-DD') AS day, rate_to_eur::text AS rate, is_latest
       FROM exchange_rates WHERE currency_code = $1 ORDER BY rate_date`,
    [code],
  );
  return rows;
}

describe.skipIf(!hasTestDatabase())(
  "rate and price persistence (real DB)",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
      await must(getTestPool(), "getTestPool()").query(
        "DELETE FROM exchange_rates WHERE currency_code = ANY($1)",
        [CODES],
      );
    }, 180_000);

    afterAll(async () => {
      try {
        const db = must(getTestPool(), "getTestPool()");
        await db.query(
          "DELETE FROM exchange_rates WHERE currency_code = ANY($1)",
          [CODES],
        );
        if (investmentId !== undefined) {
          await db.query(
            "DELETE FROM asset_price_history WHERE investment_id = $1",
            [investmentId],
          );
          await db.query(
            "DELETE FROM investment_ticker_prefs WHERE investment_id = $1",
            [investmentId],
          );
          await db.query("DELETE FROM investments WHERE id = $1", [
            investmentId,
          ]);
        }
      } finally {
        await releaseDbSuiteLock();
        await closeTestPool();
        await closePool();
      }
    });

    it("moves the latest marker to today's rate and loads only latest rows", async () => {
      await must(getTestPool(), "getTestPool()").query(
        `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
         VALUES ('XTS', 0.4, '2001-01-02', true)`,
      );

      await saveToDatabase({ EUR: 1, XTS: 0.5, XXX: 2 });

      const today = todayAppDateString();
      const xts = await rateRows("XTS");
      expect(xts.map((row) => [row.day, row.is_latest])).toEqual([
        ["2001-01-02", false],
        [today, true],
      ]);
      expect((await rateRows("XXX")).filter((row) => row.is_latest)).toHaveLength(1);
      expect(await loadFromDatabase()).toMatchObject({ EUR: 1, XTS: 0.5, XXX: 2 });

      // Re-saving the same day rewrites that row instead of adding another.
      await saveToDatabase({ EUR: 1, XTS: 0.6 });
      expect((await rateRows("XTS")).map((row) => Number(row.rate))).toEqual([
        0.4, 0.6,
      ]);
    });

    it("stores historical rates as non-latest and upserts by currency and day", async () => {
      await saveHistoricalRate("XXX", "1999-01-04", 0.7);
      await saveHistoricalRate("XXX", "1999-01-04", 0.8);
      const historical = (await rateRows("XXX")).find(
        (row) => row.day === "1999-01-04",
      );
      expect(historical).toMatchObject({ is_latest: false });
      expect(Number(must(historical, "historical").rate)).toBe(0.8);

      // A historical write landing on today's latest row keeps it latest.
      await saveHistoricalRate("XXX", todayAppDateString(), 3);
      expect(
        (await rateRows("XXX")).filter((row) => row.is_latest).map((row) => Number(row.rate)),
      ).toEqual([3]);
    });

    it("loads stored price history within an inclusive date range and defaults the source", async () => {
      const created = await investmentRepository.create({
        name: `Price persistence ${process.pid}`,
        asset_class: "crypto",
        currency: asCurrencyCode("EUR"),
        current_price: 1,
      });
      investmentId = Number(must(created, "created").id);
      const day = (d: number) => Date.UTC(2025, 3, d, 12);

      await saveHistoricalPointsToDatabase(
        investmentId,
        [
          { timestampMs: day(1), price: 100 },
          { timestampMs: day(2), price: 110 },
          { timestampMs: day(3), price: 120 },
        ],
        "binance",
      );
      // Same day again: the upsert replaces the price rather than duplicating.
      await saveHistoricalPointsToDatabase(
        investmentId,
        [{ timestampMs: day(3), price: 125 }],
        undefined,
      );

      expect(
        (await loadHistoricalPointsFromDatabase(investmentId)).map((p) => p.price),
      ).toEqual([100, 110, 125]);
      expect(
        (
          await loadHistoricalPointsFromDatabase(investmentId, {
            fromMs: Date.UTC(2025, 3, 2),
            toMs: Date.UTC(2025, 3, 3),
          })
        ).map((p) => p.price),
      ).toEqual([110, 125]);

      const { rows } = await must(getTestPool(), "getTestPool()").query<DbRow>(
        `SELECT source FROM asset_price_history
          WHERE investment_id = $1 ORDER BY price_date`,
        [investmentId],
      );
      expect(rows.map((row) => row.source)).toEqual([
        "binance",
        "binance",
        "provider",
      ]);
    });

    it("leaves unchanged price points untouched when a series is saved again", async () => {
      expect(investmentId).toBeDefined();
      const day = (d: number) => Date.UTC(2025, 3, d, 12);
      const stamps = async () => {
        const { rows } = await must(getTestPool(), "getTestPool()").query<{
          day: string;
          updated_at: string;
        }>(
          `SELECT to_char(price_date, 'YYYY-MM-DD') AS day, updated_at::text AS updated_at
             FROM asset_price_history WHERE investment_id = $1 ORDER BY price_date`,
          [investmentId],
        );
        return Object.fromEntries(rows.map((row) => [row.day, row.updated_at]));
      };
      const before = await stamps();

      await saveHistoricalPointsToDatabase(
        must(investmentId, "investmentId"),
        [
          { timestampMs: day(1), price: 100 },
          { timestampMs: day(2), price: 111 },
        ],
        "binance",
      );

      const after = await stamps();
      expect(after["2025-04-01"]).toBe(before["2025-04-01"]);
      expect(after["2025-04-02"]).not.toBe(before["2025-04-02"]);
      expect(
        (await loadHistoricalPointsFromDatabase(must(investmentId, "investmentId"))).map((p) => p.price),
      ).toEqual([100, 111, 125]);
    });
  },
);
