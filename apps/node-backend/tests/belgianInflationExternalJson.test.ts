/**
 * Belgian inflation providers answering with JSON that is not the expected
 * shape fall back like an unreachable provider: Statbel to Eurostat, Eurostat
 * to the stored rates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockLogger } from "./helpers/mockLogger.ts";
import { mockPooledTxConnection } from "./helpers/repoMocks.ts";
vi.mock("../src/database/connection.ts", () => mockPooledTxConnection());
vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));

import {
  getClient as rawGetClient,
  query as rawQuery,
} from "../src/database/connection.ts";
import type {
  PgPoolClient,
  PgQueryResult,
} from "../src/database/connection.ts";
import {
  clearInflationMemoryCache,
  getInflationRates,
} from "../src/services/belgianInflationService.ts";
import { loose, partial } from "./helpers/partial.ts";

const query = vi.mocked(rawQuery);
const getClient = vi.mocked(rawGetClient);

function jsonOk(payload: unknown) {
  return { ok: true, json: () => Promise.resolve(payload) };
}

const fact = (Month: string, cpi: string) => ({
  Month,
  "Level 1": null,
  "Consumer price index": cpi,
});

const storedRows = partial<PgQueryResult>({
  rows: [{ month_date: new Date(2023, 11, 1), monthly_rate: "0.00150000" }],
});

describe("belgianInflationService with unexpected provider JSON", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClient.mockResolvedValue(
      loose<PgPoolClient>({ query, release: vi.fn() }),
    );
    clearInflationMemoryCache();
    query.mockResolvedValue(partial<PgQueryResult>({ rows: [] }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("skips Statbel facts that are not objects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonOk({
          facts: [
            null,
            "x",
            fact("January 2024", "100"),
            fact("February 2024", "101"),
          ],
        }),
      ),
    );

    const result = await getInflationRates({ forceRefresh: true });

    expect(result.source).toBe("statbel");
    expect(result.rates.map((rate) => rate.month)).toEqual(["2024-02"]);
  });

  it.each([
    ["mistyped containers", { facts: "none", dimension: [], value: "x" }],
    ["null", null],
    ["an array", [1, 2]],
  ])(
    "falls back to the stored rates when both providers answer with %s",
    async (_label, payload) => {
      vi.useFakeTimers();
      query.mockResolvedValue(storedRows);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk(payload)));

      const pending = getInflationRates({
        startMonth: "2023-12",
        forceRefresh: true,
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.source).toBe("database");
      expect(result.rates).toEqual([
        { month: "2023-12", monthly_rate: 0.0015 },
      ]);
    },
  );
});
