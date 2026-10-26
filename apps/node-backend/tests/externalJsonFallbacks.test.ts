/**
 * Third-party JSON that is not the shape the code expects takes the path the
 * code already had for "no usable data" (empty result, null, provider
 * unavailable), instead of crashing on a cast value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockLogger } from "./helpers/mockLogger.ts";
import { mockConnection } from "./helpers/repoMocks.ts";
import { partial } from "./helpers/partial.ts";

vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));
vi.mock("../src/database/connection.ts", () => mockConnection());
vi.mock("../src/config/kinesisConfig.ts", () => ({
  KINESIS_BASE_URL: "https://kinesis.example/api",
  KINESIS_DEFAULT_TIMEFRAME: "1d",
  KINESIS_DEFAULT_FROM_DATE: "2020-01-01",
  getKinesisAssetConfig: vi.fn(() => null),
}));

import { fetchFromErApi } from "../src/services/currency/rateFetcher.ts";
import { PROVIDERS } from "../src/services/prices/priceProviderRegistry.ts";
import type { InvestmentRow } from "../src/services/prices/priceProviderRegistry.ts";
import { ibkrFundingFactsFromRawData } from "../src/services/portfolioImportPipeline/ibkrFundingHistoryAdapter.ts";
import { searchPublicWeb } from "../src/services/webResearch.ts";

/** A fetch Response as the providers read it: ok, no length header, a JSON body. */
function jsonOk(payload: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(payload),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("exchange rates (open.er-api) with unexpected JSON", () => {
  it.each([
    ["null", null],
    ["an array", [1, 2]],
    ["a string", "oops"],
    ["no rates", { result: "success" }],
    ["rates that are not an object", { result: "success", rates: "x" }],
  ])("returns null for %s", async (_label, payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk(payload)));

    expect(await fetchFromErApi()).toBeNull();
  });

  it("ignores rate entries that are not usable numbers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonOk({
          result: "success",
          rates: { USD: 2, GBP: "x", JPY: null, CHF: 0 },
        }),
      ),
    );

    expect(await fetchFromErApi()).toEqual({ EUR: 1, USD: 0.5 });
  });
});

describe("price providers with unexpected JSON", () => {
  it.each([
    ["an object", { code: -1 }],
    ["null", null],
    ["a string", "down for maintenance"],
  ])("binance returns no prices for %s", async (_label, payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk(payload)));

    expect(await PROVIDERS.binance(["BTCUSDT"])).toEqual({});
  });

  it("binance skips ticker rows that are not usable objects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonOk([
          null,
          7,
          { symbol: "BTCUSDT", price: "100.5" },
          { symbol: 5, price: "1" },
          { symbol: "ETHUSDT", price: 7 },
          { symbol: "XRPUSDT", price: {} },
        ]),
      ),
    );

    const prices = await PROVIDERS.binance(["BTCUSDT", "ETHUSDT", "XRPUSDT"]);

    expect(Object.keys(prices).sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(prices.BTCUSDT?.price).toBe(100.5);
  });

  it.each([
    ["null", null],
    ["an array", [{ createdAt: "2026-07-01T00:00:00Z", price: 1 }]],
    ["a string", "nope"],
    ["points that are not an array", { TEST_USD: "x" }],
  ])("kinesis returns no price for %s", async (_label, payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk(payload)));
    const investment = partial<InvestmentRow>({
      id: 1,
      symbol: "TEST_USD",
      currency: "USD",
      price_provider_id: "TEST_USD",
    });

    expect(await PROVIDERS.kinesis([investment])).toEqual({});
  });
});

describe("web search (Brave) with unexpected JSON", () => {
  function search(body: string) {
    return searchPublicWeb(
      { query: "Belgian inflation outlook", count: 5 },
      {
        enabled: true,
        apiKey: "synthetic",
        reserve: () => Promise.resolve(1),
        fetchImpl: () =>
          Promise.resolve(
            partial<Response>({
              status: 200,
              ok: true,
              headers: new Headers({ "content-type": "application/json" }),
              body: null,
              arrayBuffer: () =>
                Promise.resolve(new TextEncoder().encode(body).buffer),
            }),
          ),
      },
    );
  }

  it.each([
    "null",
    "[]",
    '"text"',
    "{}",
    '{"web":null}',
    '{"web":{"results":"none"}}',
  ])("reports %s as INVALID_PROVIDER_RESPONSE", async (body) => {
    await expect(search(body)).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
    });
  });

  it("skips result entries that are not objects and ignores mistyped fields", async () => {
    const result = await search(
      JSON.stringify({
        web: {
          results: [
            null,
            "x",
            { title: 5, url: "https://example.org/a", description: ["d"] },
          ],
        },
      }),
    );

    expect(result.results).toEqual([
      {
        title: "Untitled",
        url: "https://example.org/a",
        snippet: "",
        publishedAt: null,
        trust: "untrusted-evidence",
      },
    ]);
  });
});

describe("IBKR funding raw_data with unexpected JSON", () => {
  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "7"],
    ["another schema", '{"schema":"other"}'],
    [
      "columns that are not strings",
      '{"schema":"ibkr_funding_workbook_row","sheet":"Deposit","row_number":2,"columns":[1],"cells":[]}',
    ],
    [
      "cells that are not an array",
      '{"schema":"ibkr_funding_workbook_row","sheet":"Deposit","row_number":2,"columns":[],"cells":{}}',
    ],
    ["invalid JSON", "{nope"],
  ])("has no facts for %s", (_label, rawData) => {
    expect(ibkrFundingFactsFromRawData(rawData)).toBeUndefined();
  });
});
