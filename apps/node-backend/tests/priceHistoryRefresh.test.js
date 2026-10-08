import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
import { mockLogger } from "./helpers/mockLogger.ts";

const { chart, loadHistory, saveHistory } = vi.hoisted(() => ({
  chart: vi.fn(),
  loadHistory: vi.fn(),
  saveHistory: vi.fn(),
}));

vi.mock("yahoo-finance2", () => ({
  default: vi.fn().mockImplementation(function YahooClient() {
    return { chart, quote: vi.fn() };
  }),
}));
vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));
vi.mock("../src/database/connection.ts", () => mockConnection());
vi.mock("../src/lib/urlSafety.ts", () => ({ assertPublicHttpUrl: vi.fn() }));
vi.mock("../src/services/prices/priceCache.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  loadHistoricalPointsFromDatabase: loadHistory,
  saveHistoricalPointsToDatabase: saveHistory,
}));

import {
  __resetPriceCache,
  fetchHistoricalPrices,
} from "../src/services/priceProviderService.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const fromMs = Date.UTC(2026, 0, 1);
const toMs = Date.UTC(2026, 0, 31, 23, 59, 59, 999);
const middleMs = Date.UTC(2026, 0, 15, 12);
const coveredHistory = [
  { timestampMs: fromMs + DAY_MS / 2, price: 90 },
  { timestampMs: Date.UTC(2026, 0, 31, 12), price: 110 },
];

function investment(provider) {
  return {
    id: 42,
    price_provider: provider,
    price_provider_id:
      provider === "binance"
        ? "BTCUSDT"
        : provider === "kinesis"
          ? "XAU_USD"
          : "AAPL",
    currency: "USD",
    price_provider_history_url: "https://example.com/history",
  };
}

function providerPayload(provider, price) {
  if (provider === "yahoo") {
    return { quotes: [{ date: new Date(middleMs), close: price }] };
  }
  if (provider === "binance") {
    return [[middleMs, "0", "0", "0", String(price), "0"]];
  }
  if (provider === "kinesis") {
    return {
      XAU_USD: [{ createdAt: new Date(middleMs).toISOString(), price }],
    };
  }
  return { points: [{ timestamp_ms: middleMs, price }] };
}

describe("historical price refresh cache", () => {
  let fetchSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetPriceCache();
    loadHistory.mockReset().mockResolvedValue([]);
    saveHistory.mockReset().mockResolvedValue(undefined);
    chart.mockReset();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches an older Yahoo window after a narrow request and reuses its matching cache", async () => {
    const olderFrom = Date.UTC(2025, 0, 1);
    chart.mockImplementation(async (_symbol, options) => ({
      quotes: [{ date: options.period1, close: 100 }],
    }));

    await fetchHistoricalPrices(investment("yahoo"), { fromMs, toMs });
    const older = await fetchHistoricalPrices(investment("yahoo"), {
      fromMs: olderFrom,
      toMs,
    });
    const repeated = await fetchHistoricalPrices(investment("yahoo"), {
      fromMs: olderFrom,
      toMs,
    });

    expect(older).toEqual([
      { timestampMs: olderFrom + DAY_MS / 2, price: 100 },
    ]);
    expect(repeated).toEqual(older);
    expect(chart).toHaveBeenCalledTimes(2);
    expect(chart.mock.calls[1][1].period1.getTime()).toBe(olderFrom);
  });

  it("keys Yahoo history by the end of the requested window too", async () => {
    chart.mockImplementation(async (_symbol, options) => ({
      quotes: [
        { date: new Date(options.period2.getTime() - DAY_MS), close: 100 },
      ],
    }));
    const laterTo = Date.UTC(2026, 1, 28, 23, 59, 59, 999);

    await fetchHistoricalPrices(investment("yahoo"), { fromMs, toMs });
    const expanded = await fetchHistoricalPrices(investment("yahoo"), {
      fromMs,
      toMs: laterTo,
    });

    expect(chart).toHaveBeenCalledTimes(2);
    expect(expanded).toEqual([
      { timestampMs: Date.UTC(2026, 1, 28, 12), price: 100 },
    ]);
    expect(chart.mock.calls[1][1].period2.getTime()).toBe(Date.UTC(2026, 2, 1));
  });

  it("keeps overlapping Yahoo windows separate when the narrow request finishes last", async () => {
    const olderFrom = Date.UTC(2025, 0, 1);
    const pending = new Map();
    chart.mockImplementation(
      (_symbol, options) =>
        new Promise((resolve) => {
          pending.set(options.period1.getTime(), () =>
            resolve({
              quotes: [{ date: options.period1, close: 100 }],
            }),
          );
        }),
    );

    const narrowRequest = fetchHistoricalPrices(investment("yahoo"), {
      fromMs,
      toMs,
    });
    const olderRequest = fetchHistoricalPrices(investment("yahoo"), {
      fromMs: olderFrom,
      toMs,
    });
    await vi.waitFor(() => expect(chart).toHaveBeenCalledTimes(2));
    pending.get(olderFrom)();
    const older = await olderRequest;
    pending.get(fromMs)();
    await narrowRequest;

    const repeated = await fetchHistoricalPrices(investment("yahoo"), {
      fromMs: olderFrom,
      toMs,
    });

    expect(repeated).toEqual(older);
    expect(chart).toHaveBeenCalledTimes(2);
  });

  it("gives each Binance history page a separate timeout signal", async () => {
    const controllers = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    const firstPage = Array.from({ length: 1000 }, (_, day) => [
      fromMs + day * DAY_MS,
      "0",
      "0",
      "0",
      "100",
      "0",
    ]);
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => firstPage })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [[fromMs + 1000 * DAY_MS, "0", "0", "0", "101", "0"]],
      });

    const result = await fetchHistoricalPrices(investment("binance"), {
      fromMs,
      toMs: fromMs + 1001 * DAY_MS,
    });

    expect(result).toHaveLength(1001);
    expect(timeout.mock.calls).toEqual([[8000], [8000]]);
    expect(fetchSpy.mock.calls[0][1].signal).toBe(controllers[0].signal);
    expect(fetchSpy.mock.calls[1][1].signal).toBe(controllers[1].signal);
    expect(controllers[0].signal).not.toBe(controllers[1].signal);
  });

  it("returns DB history when a later Binance page times out and permits a fresh retry", async () => {
    const controllers = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    const firstPage = Array.from({ length: 1000 }, (_, day) => [
      fromMs + day * DAY_MS,
      "0",
      "0",
      "0",
      "100",
      "0",
    ]);
    loadHistory.mockResolvedValueOnce(coveredHistory);
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => firstPage })
      .mockImplementationOnce(async (_url, { signal }) => ({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            if (!signal) {
              reject(new Error("missing timeout signal"));
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [[middleMs, "0", "0", "0", "200", "0"]],
      });
    const opts = { fromMs, toMs: fromMs + 1001 * DAY_MS, force: true };
    const request = fetchHistoricalPrices(investment("binance"), opts);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    controllers[1]?.abort(
      new DOMException("provider timed out", "TimeoutError"),
    );

    expect(await request).toEqual(coveredHistory);
    expect(saveHistory).not.toHaveBeenCalled();
    const retry = await fetchHistoricalPrices(investment("binance"), opts);

    expect(retry).toEqual([{ timestampMs: middleMs, price: 200 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(controllers).toHaveLength(3);
    expect(fetchSpy.mock.calls[2][1].signal).toBe(controllers[2].signal);
    expect(controllers[2].signal.aborted).toBe(false);
    expect(saveHistory).toHaveBeenCalledTimes(1);
  });

  it.each(["yahoo", "binance", "kinesis", "custom"])(
    "%s force refresh bypasses both covered DB history and the provider cache",
    async (provider) => {
      let providerCalls = 0;
      chart.mockImplementation(async () =>
        providerPayload(provider, ++providerCalls * 100),
      );
      fetchSpy.mockImplementation(async () => ({
        ok: true,
        json: async () => providerPayload(provider, ++providerCalls * 100),
      }));
      const inv = investment(provider);

      await fetchHistoricalPrices(inv, { fromMs, toMs });
      await fetchHistoricalPrices(inv, { fromMs, toMs });
      expect(providerCalls).toBe(1);

      loadHistory.mockResolvedValueOnce(coveredHistory);
      const refreshed = await fetchHistoricalPrices(inv, {
        fromMs,
        toMs,
        force: true,
      });

      expect(providerCalls).toBe(2);
      expect(
        refreshed.find((point) => point.timestampMs === middleMs)?.price,
      ).toBe(200);
      expect(saveHistory).toHaveBeenLastCalledWith(
        inv.id,
        [{ timestampMs: middleMs, price: 200 }],
        provider,
      );
    },
  );

  it.each(["yahoo", "binance", "kinesis", "custom"])(
    "%s dbOnly takes precedence over force and makes no provider request",
    async (provider) => {
      loadHistory.mockResolvedValueOnce(coveredHistory);

      const result = await fetchHistoricalPrices(investment(provider), {
        fromMs,
        toMs,
        dbOnly: true,
        force: true,
      });

      expect(result).toEqual(coveredHistory);
      expect(chart).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(saveHistory).not.toHaveBeenCalled();
    },
  );

  it.each(["yahoo", "binance", "kinesis", "custom"])(
    "%s forced provider failure returns persisted history after a cache was populated",
    async (provider) => {
      chart.mockResolvedValue(providerPayload(provider, 100));
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => providerPayload(provider, 100),
      });
      const inv = investment(provider);
      await fetchHistoricalPrices(inv, { fromMs, toMs });
      loadHistory.mockResolvedValueOnce(coveredHistory);
      chart.mockRejectedValue(new Error("offline"));
      fetchSpy.mockRejectedValue(new Error("offline"));

      const result = await fetchHistoricalPrices(inv, {
        fromMs,
        toMs,
        force: true,
      });

      expect(result).toEqual(coveredHistory);
      expect(saveHistory).toHaveBeenCalledTimes(1);
      expect(provider === "yahoo" ? chart : fetchSpy).toHaveBeenCalledTimes(2);
    },
  );
});
