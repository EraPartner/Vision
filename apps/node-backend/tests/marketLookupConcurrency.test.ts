import { beforeEach, describe, expect, it, vi } from "vitest";

const yahoo = vi.hoisted(() => ({ quote: vi.fn(), quoteSummary: vi.fn() }));
// Keep the real payload schemas/helpers; only the client itself is faked.
vi.mock("../src/services/prices/yahooClient.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/services/prices/yahooClient.ts")
  >()),
  getYahooClient: vi.fn(async () => yahoo),
}));

import {
  __clearQuoteCacheForTests,
  getQuotes,
} from "../src/services/marketLookupService.ts";

beforeEach(() => {
  vi.clearAllMocks();
  yahoo.quote.mockReset();
  yahoo.quoteSummary.mockReset();
  __clearQuoteCacheForTests();
});

describe("market quote concurrency", () => {
  it("does not retry a failed duplicate queued beyond the first worker wave", async () => {
    yahoo.quote.mockImplementation(async (symbol) => {
      if (symbol === "FAILED") throw new Error("quote unavailable");
      return { symbol, regularMarketPrice: 42 };
    });
    const symbols = [
      "FAILED",
      ...Array.from({ length: 20 }, (_, i) => `TEST${i}`),
      "FAILED",
    ];
    const result = await getQuotes(symbols, true);
    expect(
      yahoo.quote.mock.calls.filter(([symbol]) => symbol === "FAILED"),
    ).toHaveLength(1);
    expect(result.items.map((quote) => quote.symbol)).toEqual(
      symbols.filter((symbol) => symbol !== "FAILED"),
    );
  });

  it.each([true, false])(
    "bounds basic=%s requests, preserves input order, and isolates failures",
    async (basic) => {
      let active = 0;
      let peak = 0;
      const pending: (() => void)[] = [];
      async function upstream(symbol: string, summary = false) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => pending.push(resolve));
        try {
          if (
            (!summary && symbol === "TEST13") ||
            (summary && symbol === "TEST17")
          ) {
            throw new Error("upstream failure");
          }
          return summary
            ? { summaryDetail: { marketCap: 200 } }
            : { symbol, regularMarketPrice: 42 };
        } finally {
          active -= 1;
        }
      }
      yahoo.quote.mockImplementation((symbol) => upstream(symbol));
      yahoo.quoteSummary.mockImplementation((symbol) => upstream(symbol, true));
      const symbols = Array.from({ length: 40 }, (_, i) => `TEST${i}`);
      const resultPromise = getQuotes(symbols, basic);
      await vi.waitFor(() => expect(pending).toHaveLength(6));
      expect(yahoo.quote).toHaveBeenCalledTimes(basic ? 6 : 3);
      let finished = false;
      resultPromise.then(() => {
        finished = true;
      });
      while (!finished) {
        await vi.waitFor(() =>
          expect(finished || pending.length > 0).toBe(true),
        );
        // Complete later symbols first to verify response ordering independently
        // of completion order, including partial quoteSummary failures.
        pending
          .splice(0)
          .reverse()
          .forEach((resolve) => resolve());
        await new Promise((resolve) => setImmediate(resolve));
      }
      const result = await resultPromise;
      expect(peak).toBe(6);
      expect(yahoo.quote).toHaveBeenCalledTimes(40);
      expect(yahoo.quoteSummary).toHaveBeenCalledTimes(basic ? 0 : 40);
      expect(result.total).toBe(39);
      expect(result.items.map((quote) => quote.symbol)).toEqual(
        symbols.filter((symbol) => symbol !== "TEST13"),
      );
      expect(
        result.items.find((quote) => quote.symbol === "TEST17")!.price,
      ).toBe(42);

      // Successful symbols retain cache hits; the failed symbol alone is retried.
      yahoo.quote.mockResolvedValue({
        symbol: "TEST13",
        regularMarketPrice: 43,
      });
      yahoo.quoteSummary.mockResolvedValue({});
      const cachedResult = await getQuotes(symbols, basic);
      expect(yahoo.quote).toHaveBeenCalledTimes(41);
      expect(cachedResult.items.map((quote) => quote.symbol)).toEqual(symbols);
    },
  );

  it("coalesces overlapping basic requests and keeps duplicate symbols in the response", async () => {
    let resolveQuote!: (quote: unknown) => void;
    yahoo.quote.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuote = resolve;
        }),
    );
    const first = getQuotes(["AAPL", "AAPL"], true);
    const second = getQuotes(["AAPL"], true);
    await vi.waitFor(() => expect(yahoo.quote).toHaveBeenCalledTimes(1));
    resolveQuote({ symbol: "AAPL", regularMarketPrice: 42 });
    expect((await first).items.map((quote) => quote.symbol)).toEqual([
      "AAPL",
      "AAPL",
    ]);
    expect((await second).total).toBe(1);
    expect(yahoo.quoteSummary).not.toHaveBeenCalled();
  });
});
