/**
 * Quote Backfill Service tests.
 * Tests holding window computation, spike sanitization, and backfill orchestration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockLogger } from "./helpers/mockLogger.js";

vi.mock("../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

vi.mock("../src/database/connection.js", () => ({
  query: vi.fn(),
}));

vi.mock("../src/services/priceProviderService.js", () => ({
  fetchHistoricalPrices: vi.fn(),
  saveHistoricalPointsToDatabase: vi.fn(),
}));

import {
  computeHoldingWindows,
  sanitizeIsolatedSpikes,
  backfillHistoricalAssetQuotes,
  refreshActiveHoldingQuotes,
  refreshQuotesForInvestment,
  cleanupStaleQuotes,
  holdingWindowsNeedBackfill,
  backfillHoldingGaps,
} from "../src/services/quoteBackfillService.js";
import { query } from "../src/database/connection.js";
import {
  fetchHistoricalPrices,
  saveHistoricalPointsToDatabase,
} from "../src/services/priceProviderService.js";

describe("Quote Backfill Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── computeHoldingWindows ────────────────────────────────────────────────

  describe("computeHoldingWindows", () => {
    it("returns empty array for no transactions", () => {
      expect(computeHoldingWindows([])).toEqual([]);
      expect(computeHoldingWindows(null)).toEqual([]);
      expect(computeHoldingWindows(undefined)).toEqual([]);
    });

    it("returns single open window for a buy with no sell", () => {
      const txns = [{ id: 1, type: "buy", date: "2025-01-15", units: 10 }];

      const windows = computeHoldingWindows(txns);

      expect(windows).toEqual([{ fromDate: "2025-01-15", toDate: null }]);
    });

    it("returns one closed window for buy then full sell", () => {
      const txns = [
        { id: 1, type: "buy", date: "2025-01-01", units: 10 },
        { id: 2, type: "sell", date: "2025-03-01", units: 10 },
      ];

      const windows = computeHoldingWindows(txns);

      expect(windows).toEqual([
        { fromDate: "2025-01-01", toDate: "2025-03-01" },
      ]);
    });

    it("returns two windows for buy, sell, then buy again", () => {
      const txns = [
        { id: 1, type: "buy", date: "2025-01-01", units: 10 },
        { id: 2, type: "sell", date: "2025-03-01", units: 10 },
        { id: 3, type: "buy", date: "2025-06-01", units: 5 },
      ];

      const windows = computeHoldingWindows(txns);

      expect(windows).toEqual([
        { fromDate: "2025-01-01", toDate: "2025-03-01" },
        { fromDate: "2025-06-01", toDate: null },
      ]);
    });

    it("handles multiple partial sells reducing to zero", () => {
      const txns = [
        { id: 1, type: "buy", date: "2025-01-01", units: 10 },
        { id: 2, type: "sell", date: "2025-02-01", units: 3 },
        { id: 3, type: "sell", date: "2025-03-01", units: 4 },
        { id: 4, type: "sell", date: "2025-04-01", units: 3 },
      ];

      const windows = computeHoldingWindows(txns);

      expect(windows).toEqual([
        { fromDate: "2025-01-01", toDate: "2025-04-01" },
      ]);
    });

    it("handles same-date transactions with stable id ordering", () => {
      const txns = [
        { id: 2, type: "sell", date: "2025-01-01", units: 5 },
        { id: 1, type: "buy", date: "2025-01-01", units: 10 },
      ];

      const windows = computeHoldingWindows(txns);

      // Sorted by date then id: buy(id=1) first, then sell(id=2)
      // Balance: 0 → 10 (open window), 10 → 5 (still holding)
      expect(windows).toEqual([{ fromDate: "2025-01-01", toDate: null }]);
    });

    it("handles gift transactions as buys", () => {
      const txns = [
        { id: 1, type: "gift", date: "2025-01-01", units: 5 },
        { id: 2, type: "sell", date: "2025-06-01", units: 5 },
      ];

      const windows = computeHoldingWindows(txns);

      expect(windows).toEqual([
        { fromDate: "2025-01-01", toDate: "2025-06-01" },
      ]);
    });

    it("clamps balance to zero on oversell", () => {
      const txns = [
        { id: 1, type: "buy", date: "2025-01-01", units: 5 },
        { id: 2, type: "sell", date: "2025-02-01", units: 10 }, // oversell
        { id: 3, type: "buy", date: "2025-03-01", units: 3 },
      ];

      const windows = computeHoldingWindows(txns);

      expect(windows).toEqual([
        { fromDate: "2025-01-01", toDate: "2025-02-01" },
        { fromDate: "2025-03-01", toDate: null },
      ]);
    });
  });

  // ─── sanitizeIsolatedSpikes ───────────────────────────────────────────────

  describe("sanitizeIsolatedSpikes", () => {
    it("returns empty array for null/undefined input", () => {
      expect(sanitizeIsolatedSpikes(null)).toEqual([]);
      expect(sanitizeIsolatedSpikes(undefined)).toEqual([]);
    });

    it("passes through arrays with fewer than 3 points unchanged", () => {
      const points = [
        { timestampMs: 1000, price: 100 },
        { timestampMs: 2000, price: 200 },
      ];

      const result = sanitizeIsolatedSpikes(points);

      expect(result).toEqual(points);
      // Returns a new array (shallow copy)
      expect(result).not.toBe(points);
    });

    it("replaces a 10x single-day spike with geometric mean", () => {
      const points = [
        { timestampMs: 1000, price: 100 },
        { timestampMs: 2000, price: 100 },
        { timestampMs: 3000, price: 1000 }, // 10× spike
        { timestampMs: 4000, price: 100 },
        { timestampMs: 5000, price: 100 },
      ];

      const result = sanitizeIsolatedSpikes(points);

      // Geometric mean of 100 and 100 = 100
      expect(result[2].price).toBeCloseTo(100, 5);
      // Other points unchanged
      expect(result[0].price).toBe(100);
      expect(result[1].price).toBe(100);
      expect(result[3].price).toBe(100);
      expect(result[4].price).toBe(100);
    });

    it("catches a 3x spike", () => {
      const points = [
        { timestampMs: 1000, price: 100 },
        { timestampMs: 2000, price: 100 },
        { timestampMs: 3000, price: 300 }, // 3× spike
        { timestampMs: 4000, price: 100 },
        { timestampMs: 5000, price: 100 },
      ];

      const result = sanitizeIsolatedSpikes(points);

      expect(result[2].price).toBeCloseTo(100, 5);
    });

    it("does not alter normal price movements below threshold", () => {
      const points = [
        { timestampMs: 1000, price: 100 },
        { timestampMs: 2000, price: 105 },
        { timestampMs: 3000, price: 110 },
        { timestampMs: 4000, price: 108 },
        { timestampMs: 5000, price: 112 },
      ];

      const result = sanitizeIsolatedSpikes(points);

      expect(result.map((p) => p.price)).toEqual([100, 105, 110, 108, 112]);
    });

    it("does not modify original array (immutability)", () => {
      const points = [
        { timestampMs: 1000, price: 100 },
        { timestampMs: 2000, price: 100 },
        { timestampMs: 3000, price: 1000 },
        { timestampMs: 4000, price: 100 },
        { timestampMs: 5000, price: 100 },
      ];

      sanitizeIsolatedSpikes(points);

      // Original should be untouched
      expect(points[2].price).toBe(1000);
    });

    it("handles trough spike (sudden drop and recovery)", () => {
      const points = [
        { timestampMs: 1000, price: 100 },
        { timestampMs: 2000, price: 100 },
        { timestampMs: 3000, price: 10 }, // 10× trough
        { timestampMs: 4000, price: 100 },
        { timestampMs: 5000, price: 100 },
      ];

      const result = sanitizeIsolatedSpikes(points);

      expect(result[2].price).toBeCloseTo(100, 5);
    });

    it("catches known May 2022 Kinesis-style pattern", () => {
      // Simulates: stable prices, 10x spike for one day, back to normal
      const points = [
        { timestampMs: 1, price: 50 },
        { timestampMs: 2, price: 51 },
        { timestampMs: 3, price: 50.5 },
        { timestampMs: 4, price: 51 },
        { timestampMs: 5, price: 500 }, // 10× spike
        { timestampMs: 6, price: 50 },
        { timestampMs: 7, price: 51 },
        { timestampMs: 8, price: 50.5 },
      ];

      const result = sanitizeIsolatedSpikes(points);

      // Spike should be corrected
      expect(result[4].price).toBeLessThan(200);
      // Non-spike prices should be unmodified
      expect(result[0].price).toBe(50);
      expect(result[5].price).toBe(50);
    });
  });

  // ─── backfillHistoricalAssetQuotes ────────────────────────────────────────

  describe("backfillHistoricalAssetQuotes", () => {
    it("returns zero summary when no investments have holding windows", async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await backfillHistoricalAssetQuotes();

      expect(result).toEqual({ processed: 0, withHistory: 0, failed: 0 });
    });

    it("backfills quotes for correct holding window date ranges", async () => {
      // Mock getInvestmentsWithHoldingWindows query
      query.mockResolvedValueOnce({
        rows: [
          {
            id: 10,
            asset_class: "stock",
            currency: "USD",
            price_provider: "yahoo",
            price_provider_id: "AAPL",
            symbol: "AAPL",
            price_provider_url: null,
            price_provider_latest_url: null,
            price_provider_latest_path: null,
            price_provider_history_url: null,
            price_provider_history_path: null,
            price_provider_history_ts_path: null,
            price_provider_history_price_path: null,
            tx_id: 1,
            tx_type: "buy",
            tx_date: "2025-01-01",
            tx_units: 10,
          },
          {
            id: 10,
            asset_class: "stock",
            currency: "USD",
            price_provider: "yahoo",
            price_provider_id: "AAPL",
            symbol: "AAPL",
            price_provider_url: null,
            price_provider_latest_url: null,
            price_provider_latest_path: null,
            price_provider_history_url: null,
            price_provider_history_path: null,
            price_provider_history_ts_path: null,
            price_provider_history_price_path: null,
            tx_id: 2,
            tx_type: "sell",
            tx_date: "2025-03-01",
            tx_units: 10,
          },
        ],
      });

      fetchHistoricalPrices.mockResolvedValue([
        { timestampMs: Date.parse("2025-01-01T12:00:00Z"), price: 150 },
        { timestampMs: Date.parse("2025-01-02T12:00:00Z"), price: 151 },
      ]);
      saveHistoricalPointsToDatabase.mockResolvedValue();

      // Mock for cleanupStaleQuotes
      query.mockResolvedValueOnce({ rowCount: 0 });

      const result = await backfillHistoricalAssetQuotes();

      expect(result).toEqual({ processed: 1, withHistory: 1, failed: 0 });
      expect(fetchHistoricalPrices).toHaveBeenCalledWith(
        expect.objectContaining({ id: 10, price_provider: "yahoo" }),
        expect.objectContaining({
          fromMs: Date.parse("2025-01-01T00:00:00.000Z"),
          toMs: Date.parse("2025-03-01T23:59:59.999Z"),
        }),
      );
      expect(saveHistoricalPointsToDatabase).toHaveBeenCalledTimes(1);
    });

    it("increments failed count when historical fetch throws", async () => {
      query.mockResolvedValueOnce({
        rows: [
          {
            id: 20,
            asset_class: "crypto",
            currency: "USD",
            price_provider: "binance",
            price_provider_id: "BTCUSDT",
            symbol: "BTC",
            price_provider_url: null,
            price_provider_latest_url: null,
            price_provider_latest_path: null,
            price_provider_history_url: null,
            price_provider_history_path: null,
            price_provider_history_ts_path: null,
            price_provider_history_price_path: null,
            tx_id: 1,
            tx_type: "buy",
            tx_date: "2025-01-01",
            tx_units: 0.5,
          },
        ],
      });

      fetchHistoricalPrices.mockRejectedValue(new Error("provider down"));

      // Mock for cleanupStaleQuotes
      query.mockResolvedValueOnce({ rowCount: 0 });

      const result = await backfillHistoricalAssetQuotes();

      expect(result).toEqual({ processed: 1, withHistory: 0, failed: 1 });
    });

    it("applies spike sanitization before saving", async () => {
      query.mockResolvedValueOnce({
        rows: [
          {
            id: 30,
            asset_class: "metals",
            currency: "USD",
            price_provider: "kinesis",
            price_provider_id: "KAU",
            symbol: "KAU",
            price_provider_url: null,
            price_provider_latest_url: null,
            price_provider_latest_path: null,
            price_provider_history_url: null,
            price_provider_history_path: null,
            price_provider_history_ts_path: null,
            price_provider_history_price_path: null,
            tx_id: 1,
            tx_type: "buy",
            tx_date: "2025-01-01",
            tx_units: 100,
          },
        ],
      });

      // Return points with a spike
      fetchHistoricalPrices.mockResolvedValue([
        { timestampMs: 1000, price: 50 },
        { timestampMs: 2000, price: 50 },
        { timestampMs: 3000, price: 500 }, // 10× spike
        { timestampMs: 4000, price: 50 },
        { timestampMs: 5000, price: 50 },
      ]);
      saveHistoricalPointsToDatabase.mockResolvedValue();
      query.mockResolvedValueOnce({ rowCount: 0 }); // cleanup

      await backfillHistoricalAssetQuotes();

      // Verify saved points have the spike corrected
      const savedPoints = saveHistoricalPointsToDatabase.mock.calls[0][1];
      expect(savedPoints[2].price).toBeCloseTo(50, 5);
    });
  });

  // ─── refreshQuotesForInvestment ───────────────────────────────────────────

  describe("refreshQuotesForInvestment", () => {
    it("cleans up all quotes when no holding windows remain", async () => {
      // getInvestmentWithHoldingWindows returns null (no transactions)
      query.mockResolvedValueOnce({ rows: [] });
      // DELETE query
      query.mockResolvedValueOnce({ rowCount: 3 });

      await refreshQuotesForInvestment(42);

      expect(query).toHaveBeenCalledTimes(2);
      expect(query).toHaveBeenLastCalledWith(
        "DELETE FROM asset_price_history WHERE investment_id = $1",
        [42],
      );
    });

    it("backfills and cleans up for a valid investment", async () => {
      // getInvestmentWithHoldingWindows query
      query.mockResolvedValueOnce({
        rows: [
          {
            id: 50,
            asset_class: "stock",
            currency: "EUR",
            price_provider: "yahoo",
            price_provider_id: "SIE.DE",
            symbol: "SIE",
            price_provider_url: null,
            price_provider_latest_url: null,
            price_provider_latest_path: null,
            price_provider_history_url: null,
            price_provider_history_path: null,
            price_provider_history_ts_path: null,
            price_provider_history_price_path: null,
            tx_id: 1,
            tx_type: "buy",
            tx_date: "2025-06-01",
            tx_units: 20,
          },
        ],
      });

      fetchHistoricalPrices.mockResolvedValue([
        { timestampMs: 1000, price: 180 },
      ]);
      saveHistoricalPointsToDatabase.mockResolvedValue();
      // Cleanup query
      query.mockResolvedValueOnce({ rowCount: 0 });

      await refreshQuotesForInvestment(50);

      expect(fetchHistoricalPrices).toHaveBeenCalledTimes(1);
      expect(saveHistoricalPointsToDatabase).toHaveBeenCalledTimes(1);
    });
  });

  // ─── cleanupStaleQuotes ───────────────────────────────────────────────────

  describe("cleanupStaleQuotes", () => {
    it("deletes rows outside holding windows", async () => {
      query.mockResolvedValueOnce({ rowCount: 5 });

      const investmentWindows = new Map([
        [
          1,
          {
            investment: { id: 1 },
            holdingWindows: [{ fromDate: "2025-01-01", toDate: "2025-03-01" }],
          },
        ],
      ]);

      const deleted = await cleanupStaleQuotes(investmentWindows);

      expect(deleted).toBe(5);
      // Single-statement cleanup: [invIds, windowInvIds, fromDates, toDates]
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM asset_price_history"),
        [[1], [1], ["2025-01-01"], ["2025-03-01"]],
      );
    });

    it("handles open windows by using today as toDate", async () => {
      query.mockResolvedValueOnce({ rowCount: 0 });

      const investmentWindows = new Map([
        [
          1,
          {
            investment: { id: 1 },
            holdingWindows: [{ fromDate: "2025-01-01", toDate: null }],
          },
        ],
      ]);

      await cleanupStaleQuotes(investmentWindows);

      const callArgs = query.mock.calls[0][1];
      expect(callArgs[2]).toEqual(["2025-01-01"]);
      // toDate should be today's date string
      expect(callArgs[3][0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("uses UTC for the open-window today sentinel (not the server local time)", async () => {
      // Pin "now" to a moment where UTC and a non-UTC zone disagree on the
      // calendar day: 2025-06-15T23:30:00Z is still 2025-06-15 in UTC but
      // 2025-06-16 in any positive-offset zone. The sentinel must follow
      // the column's UTC storage, not the server's local clock.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-15T23:30:00Z"));

      try {
        query.mockResolvedValueOnce({ rowCount: 0 });

        const investmentWindows = new Map([
          [
            1,
            {
              investment: { id: 1 },
              holdingWindows: [{ fromDate: "2025-01-01", toDate: null }],
            },
          ],
        ]);

        await cleanupStaleQuotes(investmentWindows);

        const callArgs = query.mock.calls[0][1];
        expect(callArgs[3]).toEqual(["2025-06-15"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips investments with no holding windows", async () => {
      const investmentWindows = new Map([
        [
          1,
          {
            investment: { id: 1 },
            holdingWindows: [],
          },
        ],
      ]);

      const deleted = await cleanupStaleQuotes(investmentWindows);

      expect(deleted).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });
  });

  // ─── holdingWindowsNeedBackfill ───────────────────────────────────────────

  describe("holdingWindowsNeedBackfill", () => {
    it("returns false for a dense daily series covering the window", () => {
      const stored = Array.from(
        { length: 31 },
        (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`,
      );
      const windows = [{ fromDate: "2026-01-01", toDate: "2026-01-31" }];
      expect(
        holdingWindowsNeedBackfill(windows, stored, { todayUtc: "2026-02-01" }),
      ).toBe(false);
    });

    it("returns true for a biweekly (sparse) series", () => {
      const stored = ["2026-01-01", "2026-01-15", "2026-01-29"];
      const windows = [{ fromDate: "2026-01-01", toDate: "2026-01-31" }];
      expect(
        holdingWindowsNeedBackfill(windows, stored, { todayUtc: "2026-02-01" }),
      ).toBe(true);
    });

    it("returns true for an empty window (full-span gap)", () => {
      const windows = [{ fromDate: "2026-01-01", toDate: "2026-01-31" }];
      expect(
        holdingWindowsNeedBackfill(windows, [], { todayUtc: "2026-02-01" }),
      ).toBe(true);
    });

    it("returns false for a single-day window with no rows", () => {
      const windows = [{ fromDate: "2026-01-01", toDate: "2026-01-01" }];
      expect(
        holdingWindowsNeedBackfill(windows, [], { todayUtc: "2026-02-01" }),
      ).toBe(false);
    });

    it("detects a trailing gap on an open window using todayUtc", () => {
      const windows = [{ fromDate: "2026-01-01", toDate: null }];
      expect(
        holdingWindowsNeedBackfill(windows, ["2026-01-01"], {
          todayUtc: "2026-01-15",
        }),
      ).toBe(true);
    });

    it("respects a custom threshold", () => {
      const stored = ["2026-01-01", "2026-01-08", "2026-01-15"];
      const windows = [{ fromDate: "2026-01-01", toDate: "2026-01-15" }];
      // 7-day gaps: under default(9) → dense, but a threshold of 5 flags them.
      expect(
        holdingWindowsNeedBackfill(windows, stored, { todayUtc: "2026-02-01" }),
      ).toBe(false);
      expect(
        holdingWindowsNeedBackfill(windows, stored, {
          thresholdDays: 5,
          todayUtc: "2026-02-01",
        }),
      ).toBe(true);
    });

    it("does not treat malformed boundaries as evidence of a quote gap", () => {
      const windows = [{ fromDate: "2026-02-30", toDate: "2026-03-05" }];
      expect(
        holdingWindowsNeedBackfill(windows, [], { todayUtc: "2026-03-05" }),
      ).toBe(false);
    });
  });

  // ─── backfillHoldingGaps ──────────────────────────────────────────────────

  describe("backfillHoldingGaps", () => {
    it("force-refetches a sparse investment and counts a fill when rows grow", async () => {
      query
        // getInvestmentsWithHoldingWindows: one open stock position
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              asset_class: "stock",
              currency: "EUR",
              price_provider: "yahoo",
              price_provider_id: "AAPL",
              symbol: "AAPL",
              tx_id: 1,
              tx_type: "buy",
              tx_date: "2026-01-01",
              tx_units: "10",
            },
          ],
        })
        // getStoredPriceDates (before): a single sparse row
        .mockResolvedValueOnce({ rows: [{ d: "2026-01-01" }] })
        // getStoredPriceDates (after): densified
        .mockResolvedValueOnce({
          rows: Array.from({ length: 10 }, (_, i) => ({
            d: `2026-01-${String(i + 1).padStart(2, "0")}`,
          })),
        });

      fetchHistoricalPrices.mockResolvedValue([
        { timestampMs: Date.UTC(2026, 0, 2), price: 101 },
      ]);
      saveHistoricalPointsToDatabase.mockResolvedValue(undefined);

      const result = await backfillHoldingGaps();

      expect(result).toEqual({ checked: 1, needed: 1, filled: 1, failed: 0 });
      expect(fetchHistoricalPrices).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ force: true }),
      );
    });

    it("skips an already-dense investment without refetching", async () => {
      query
        // closed window 2026-01-01 → 2026-01-05
        .mockResolvedValueOnce({
          rows: [
            {
              id: 2,
              asset_class: "stock",
              currency: "EUR",
              price_provider: "yahoo",
              price_provider_id: "MSFT",
              symbol: "MSFT",
              tx_id: 1,
              tx_type: "buy",
              tx_date: "2026-01-01",
              tx_units: "5",
            },
            {
              id: 2,
              asset_class: "stock",
              currency: "EUR",
              price_provider: "yahoo",
              price_provider_id: "MSFT",
              symbol: "MSFT",
              tx_id: 2,
              tx_type: "sell",
              tx_date: "2026-01-05",
              tx_units: "5",
            },
          ],
        })
        // getStoredPriceDates: dense across the window
        .mockResolvedValueOnce({
          rows: [
            "2026-01-01",
            "2026-01-02",
            "2026-01-03",
            "2026-01-04",
            "2026-01-05",
          ].map((d) => ({ d })),
        });

      const result = await backfillHoldingGaps();

      expect(result).toEqual({ checked: 1, needed: 0, filled: 0, failed: 0 });
      expect(fetchHistoricalPrices).not.toHaveBeenCalled();
    });
  });
});
