/**
 * Real-PostgreSQL behaviour of investment writes: provider fields, the
 * ticker-preference side table, price updates and deletion. Replaces
 * mocked-pool tests that asserted INSERT/UPDATE/UNNEST SQL and parameters.
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
import investmentRepository from "../src/repositories/investmentRepository.ts";

const SUFFIX = `INB${process.pid}`;
const ids: number[] = [];

async function create(fields: Record<string, unknown> = {}) {
  const row = await investmentRepository.create({
    name: `Investment ${SUFFIX} ${ids.length}`,
    asset_class: "etf",
    currency: "EUR",
    current_price: 10,
    ...fields,
  });
  const id = Number(row!.id);
  ids.push(id);
  return id;
}

describe.skipIf(!hasTestDatabase())(
  "investment repository writes (real DB)",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      const db = getTestPool()!;
      const owned = ids.splice(0);
      await db.query(
        "DELETE FROM investment_ticker_prefs WHERE investment_id = ANY($1::int[])",
        [owned],
      );
      await db.query("DELETE FROM investments WHERE id = ANY($1::int[])", [
        owned,
      ]);
    });

    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    it("persists custom price-provider fields on create", async () => {
      const id = await create({
        name: `Napoleon ${SUFFIX}`,
        symbol: `NAP${process.pid}`,
        asset_class: "metals",
        current_price: 706.5,
        price_provider: "custom",
        price_provider_latest_url: "https://example.com/latest",
        price_provider_latest_path: "napoleon.price",
        price_provider_history_url: "https://example.com/history",
        price_provider_history_path: "points",
      });
      expect(await investmentRepository.getById(id)).toMatchObject({
        asset_class: "metals",
        price_provider: "custom",
        price_provider_latest_url: "https://example.com/latest",
        price_provider_latest_path: "napoleon.price",
        price_provider_history_url: "https://example.com/history",
        price_provider_history_path: "points",
      });
    });

    it("stores show_in_ticker without touching investment columns and returns the joined value", async () => {
      const id = await create();
      expect((await investmentRepository.getById(id))?.show_in_ticker).toBe(
        true,
      );
      const updated = await investmentRepository.update(id, {
        show_in_ticker: false,
      });
      expect(updated).toMatchObject({ id, show_in_ticker: false });
      expect(Number(updated?.current_price)).toBe(10);
      expect((await investmentRepository.getById(id))?.show_in_ticker).toBe(
        false,
      );
    });

    it("updates one price, bulk prices, and deletes", async () => {
      const first = await create();
      const second = await create();

      const priced = await investmentRepository.updatePrice(first, {
        current_price: 90.5,
        price_updated_at: new Date("2026-01-01T00:00:00Z"),
      });
      expect(Number(priced?.current_price)).toBe(90.5);
      expect(
        await investmentRepository.updatePrice(-1, {
          current_price: 1,
          price_updated_at: null,
        }),
      ).toBeNull();

      expect(
        await investmentRepository.updatePricesBulk([
          {
            id: first,
            current_price: 11,
            price_updated_at: "2026-01-02T00:00:00.000Z",
          },
          {
            id: second,
            current_price: 22,
            price_updated_at: "2026-01-02T00:00:00.000Z",
          },
        ]),
      ).toBe(2);
      expect(
        Number((await investmentRepository.getById(first))?.current_price),
      ).toBe(11);
      expect(
        Number((await investmentRepository.getById(second))?.current_price),
      ).toBe(22);

      expect(await investmentRepository.hardDelete(second)).toBe(true);
      expect(await investmentRepository.getById(second)).toBeFalsy();
    });
  },
);
