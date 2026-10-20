import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import router from "../../src/routes/researchPresentation.ts";
import { routeAgent } from "../helpers/routeApp.ts";
import { bodyAt } from "../helpers/responseBody.ts";
import {
  computeResearchPresentation,
  RESEARCH_PRESENTATION_MAX_BYTES,
} from "../../src/services/research/presentationService.ts";

const api = routeAgent(router, { mountPath: "/api/research" });
const path = "/api/research/presentation";
const post = (value: unknown) =>
  api
    .post(path)
    .attach("file", Buffer.from(JSON.stringify(value)), {
      filename: "presentation.json",
      contentType: "application/json",
    });
const golden: { cases: { name: string; input: unknown; expected: unknown }[] } =
  JSON.parse(
    readFileSync(
      new URL(
        "../../../frontend/src/lib/research/__tests__/presentation.golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
describe("Stateless Research presentation", () => {
  for (const item of golden.cases)
    it(item.name, async () => {
      const result = await post(item.input);
      expect(result.status).toBe(200);
      expect(bodyAt(result, "data", "result")).toEqual(item.expected);
    });
  it("batches independent watchlist facts without merging booking/quote currencies", async () => {
    const result = await post({
      kind: "watchlistBatch",
      entries: [
        { id: 7, targetPrice: 10, currentPrice: 8, addedPrice: 4 },
        { id: 8, targetPrice: 10, currentPrice: null, addedPrice: null },
      ],
    });
    expect(bodyAt(result, "data")).toEqual({
      kind: "watchlistBatch",
      result: {
        entries: [
          {
            id: 7,
            list: {
              distancePercent: -20,
              absoluteDistancePercent: 20,
              isAtOrBelowTarget: true,
              sinceAddedPercent: 100,
            },
          },
          {
            id: 8,
            list: {
              distancePercent: null,
              absoluteDistancePercent: null,
              isAtOrBelowTarget: false,
              sinceAddedPercent: null,
            },
          },
        ],
      },
    });
  });
  it("preserves invalid historical target list and chart differences with nonfinite JSON null", async () => {
    const result = await post({
      kind: "watchlist",
      targetPrice: 0,
      currentPrice: 8,
      addedPrice: 0,
      points: [
        { time: 1, close: 2 },
        { time: 2, close: -1 },
      ],
    });
    expect(
      bodyAt(result, "data", "result", "list", "distancePercent"),
    ).toBeNull();
    expect(bodyAt(result, "data", "result", "chart")).toEqual({
      distancePercent: null,
      absoluteDistancePercent: null,
      isAtOrBelowTarget: false,
      hasValidTarget: false,
      domain: [1.96, 2.04],
    });
    expect(bodyAt(result, "data", "result", "preview")).toBeNull();
  });
  it("retains provider native quote, first-zero fallback and empty source null", async () => {
    const input = {
      kind: "providerQuote",
      points: [
        { time: 1, close: 0 },
        { time: 2, close: 8 },
      ],
      investment: {
        name: "Metal",
        currency: "USD",
        priceProvider: "kinesis",
        symbol: null,
      },
      selectedSymbol: "KAU",
    };
    const result = await post(input);
    expect(bodyAt(result, "data", "result")).toEqual({
      symbol: "KAU",
      name: "Metal",
      price: 8,
      change: 8,
      changePercent: 0,
      currency: "USD",
      exchange: "",
      type: "KINESIS",
    });
    expect(
      bodyAt(await post({ ...input, points: [] }), "data", "result"),
    ).toBeNull();
  });
  it.each([
    [6, 0, 4, 0, 0, "market.strongBuy", "success"],
    [0, 9, 11, 0, 0, "market.buy", "success"],
    [0, 0, 4, 0, 6, "market.strongSell", "destructive"],
    [0, 0, 11, 9, 0, "market.sell", "destructive"],
    [0, 0, 1, 0, 0, "market.hold", "warning"],
  ])(
    "retains consensus thresholds %s/%s/%s/%s/%s",
    async (strongBuy, buy, hold, sell, strongSell, key, tone) => {
      const result = await post({
        kind: "analyst",
        consensus: { strongBuy, buy, hold, sell, strongSell },
      });
      expect(bodyAt(result, "data", "result", "verdictKey")).toBe(key);
      expect(bodyAt(result, "data", "result", "tone")).toBe(tone);
    },
  );
  it("represents missing and zero-count analysts as unavailable", async () => {
    expect(
      bodyAt(
        await post({ kind: "analyst", consensus: null }),
        "data",
        "result",
      ),
    ).toBeNull();
    expect(
      bodyAt(
        await post({
          kind: "analyst",
          consensus: { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 },
        }),
        "data",
        "result",
      ),
    ).toBeNull();
  });
  it("reuses exact existing two-of-three previews and disabled derivation", async () => {
    expect(
      bodyAt(
        await post({ kind: "marketAdd", amount: 100, units: 3 }),
        "data",
        "result",
      ),
    ).toEqual({
      derivedPrice: 33.333333,
      effectivePrice: 33.333333,
      effectiveAmount: 100,
      effectiveUnits: 3,
      providedCount: 2,
      isConsistent: true,
    });
    expect(
      bodyAt(
        await post({ kind: "marketAdd", amount: 100, units: 3, price: 33.33 }),
        "data",
        "result",
        "isConsistent",
      ),
    ).toBe(true);
    expect(
      bodyAt(
        await post({ kind: "marketAdd", amount: 100, units: 3, derive: false }),
        "data",
        "result",
      ),
    ).toEqual({
      effectiveAmount: 100,
      effectiveUnits: 3,
      providedCount: 2,
      isConsistent: false,
    });
  });
  it("keeps histories above global JSON limit without truncating", async () => {
    const points = Array.from({ length: 20000 }, (_, i) => ({
      time: i,
      close: 100 + i / 100,
      high: 100 + i / 100 + 1,
      low: 100 + i / 100 - 1,
      volume: 12345678,
    }));
    const input = {
      kind: "chart",
      series: [{ id: "price", field: "price", type: "line", points }],
      indicators: [],
      rebase: false,
      oscillator: "none",
      oscillatorSeriesId: null,
    };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(1_000_000);
    const result = await post(input);
    expect(result.status).toBe(200);
    expect(bodyAt(result, "data", "result", "rows", "length")).toBe(20000);
    expect(bodyAt(result, "data", "result", "rows", 19999, "price")).toBe(
      299.99,
    );
  });
  it.each([
    { kind: "unknown" },
    // Removed by ADR-230.
    {
      kind: "lifeScenarioPrepare",
      scenario: {
        id: "s",
        interruptionMonths: 3,
        monthlySurplus: 900,
        monthlyIncomeLoss: 700,
        monthlyContribution: 500,
      },
      forecastInput: { horizonMonths: 12 },
    },
    { kind: "lifeScenarioCompare", baseline: {}, interrupted: {} },
    {
      kind: "compare",
      series: Array.from({ length: 7 }, () => ({ symbol: "A", points: [] })),
    },
    {
      kind: "chart",
      series: [],
      indicators: [{ id: "i", type: "sma", period: 501, seriesId: "missing" }],
      rebase: false,
      oscillator: "none",
      oscillatorSeriesId: null,
    },
    { kind: "marketAdd", price: 0 },
    { kind: "marketAdd", amount: "12.50" },
    {
      kind: "watchlistBatch",
      entries: Array.from({ length: 5001 }, (_, i) => ({
        id: i + 1,
        targetPrice: 1,
        currentPrice: null,
        addedPrice: null,
      })),
    },
  ])("rejects unsupported/bounded request %#", async (input) => {
    const result = await post(input);
    expect(result.status).toBe(400);
    expect(bodyAt(result, "error", "code")).toBe("VALIDATION_ERROR");
  });
  it("rejects malformed JSON, missing/repeated files and extra multipart fields", async () => {
    expect((await api.post(path)).status).toBe(400);
    expect(
      (await api.post(path).attach("file", Buffer.from("{"), "bad.json"))
        .status,
    ).toBe(400);
    expect(
      (
        await api
          .post(path)
          .attach("file", Buffer.from("{}"), "first.json")
          .attach("file", Buffer.from("{}"), "second.json")
      ).status,
    ).toBe(400);
    expect(
      (await post({ kind: "analyst", consensus: null }).field("format", "csv"))
        .status,
    ).toBe(400);
  });
  it("documents and enforces scoped64MiB transport", async () => {
    expect(RESEARCH_PRESENTATION_MAX_BYTES).toBe(67_108_864);
    const result = await api
      .post(path)
      .attach(
        "file",
        Buffer.alloc(RESEARCH_PRESENTATION_MAX_BYTES + 1),
        "oversize.json",
      );
    expect(result.status).toBe(400);
    expect(bodyAt(result, "error", "code")).toBe("VALIDATION_ERROR");
  }, 30000);
  it("pure dispatcher never fetches data for empty submitted series", () => {
    expect(
      computeResearchPresentation({
        kind: "compare",
        series: [{ symbol: "EMPTY", points: [] }],
      }),
    ).toEqual({
      kind: "compare",
      result: {
        rows: [],
        stats: [
          {
            symbol: "EMPTY",
            totalReturn: null,
            volatility: null,
            maxDrawdown: null,
            firstTime: undefined,
            lastTime: undefined,
          },
        ],
        correlation: { symbols: ["EMPTY"], matrix: [[1]] },
      },
    });
  });
});
