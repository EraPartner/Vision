import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/repositories/plannedTransactionRepository.js", () => ({
  plannedTransactionRepository: { getAll: vi.fn(), getById: vi.fn() },
}));

vi.mock("../src/repositories/infoRepository.js", () => ({
  infoRepository: { getBankBalances: vi.fn() },
}));

vi.mock("../src/services/aiChat/tools/_financialMetrics.js", () => ({
  loadCanonicalPortfolioSummary: vi.fn(),
}));

import { plannedTransactionRepository } from "../src/repositories/plannedTransactionRepository.js";
import { infoRepository } from "../src/repositories/infoRepository.js";
import { loadCanonicalPortfolioSummary } from "../src/services/aiChat/tools/_financialMetrics.js";
import {
  getUnrealizedGains,
  getBestWorstPerformers,
} from "../src/services/aiChat/tools/portfolio.js";
import { getProjectedBalance } from "../src/services/aiChat/tools/planned.js";

beforeEach(() => {
  vi.resetAllMocks();
  loadCanonicalPortfolioSummary.mockResolvedValue({
    currency: "EUR",
    summaries: [],
    totals: { totalPortfolioValue: 0 },
  });
});

describe("getUnrealizedGains", () => {
  it("uses the canonical remaining basis after a partial sale", async () => {
    loadCanonicalPortfolioSummary.mockResolvedValueOnce({
      currency: "USD",
      summaries: [
        {
          id: 1,
          name: "Apple",
          symbol: "AAPL",
          asset_class: "stock",
          originalCurrency: "USD",
          totalUnits: 6,
          currentValue: 900,
          unrealizedGain: 300,
        },
      ],
      totals: { totalPortfolioValue: 900 },
    });

    const r = await getUnrealizedGains.run({});
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({
      id: 1,
      name: "Apple",
      assetClass: "stock",
      units: 6,
      costBasis: 600,
      marketValue: 900,
      unrealizedGain: 300,
      gainPercent: 50,
    });
  });

  it("skips a canonically closed position", async () => {
    loadCanonicalPortfolioSummary.mockResolvedValueOnce({
      currency: "EUR",
      summaries: [
        {
          id: 1,
          name: "Sold",
          asset_class: "stock",
          totalUnits: 0,
          currentValue: 0,
          unrealizedGain: 0,
        },
      ],
      totals: { totalPortfolioValue: 0 },
    });

    const r = await getUnrealizedGains.run({});
    expect(r.data).toEqual([]);
  });

  it("returns null gainPercent when cost basis is zero (gifted shares)", async () => {
    loadCanonicalPortfolioSummary.mockResolvedValueOnce({
      currency: "EUR",
      summaries: [
        {
          id: 1,
          name: "Gift",
          asset_class: "stock",
          totalUnits: 10,
          currentValue: 500,
          unrealizedGain: 500,
        },
      ],
      totals: { totalPortfolioValue: 500 },
    });
    const r = await getUnrealizedGains.run({});
    expect(r.data[0].gainPercent).toBeNull();
  });

  it("reports a zero canonical basis without inventing a gain percentage", async () => {
    loadCanonicalPortfolioSummary.mockResolvedValueOnce({
      currency: "EUR",
      summaries: [
        {
          id: 1,
          name: "Gift",
          asset_class: "stock",
          totalUnits: 2,
          currentValue: 100,
          unrealizedGain: 100,
        },
      ],
      totals: { totalPortfolioValue: 100 },
    });
    const r = await getUnrealizedGains.run({});

    expect(r.data[0]).toMatchObject({
      costBasis: 0,
      marketValue: 100,
      unrealizedGain: 100,
      gainPercent: null,
    });
  });

  it("filters canonical summaries by asset class", async () => {
    loadCanonicalPortfolioSummary.mockResolvedValueOnce({
      currency: "EUR",
      summaries: [
        {
          id: 1,
          name: "Equity",
          asset_class: "stock",
          totalUnits: 1,
          currentValue: 100,
          unrealizedGain: 10,
        },
        {
          id: 2,
          name: "Bitcoin",
          asset_class: "crypto",
          totalUnits: 1,
          currentValue: 200,
          unrealizedGain: 20,
        },
      ],
      totals: { totalPortfolioValue: 300 },
    });

    const r = await getUnrealizedGains.run({ assetClass: "crypto" });

    expect(r.data).toEqual([expect.objectContaining({ id: 2 })]);
  });

  it("returns empty when the canonical summary has no active investments", async () => {
    const r = await getUnrealizedGains.run({});
    expect(r.data).toEqual([]);
  });

  it("rejects unknown asset class", async () => {
    await expect(
      getUnrealizedGains.run({ assetClass: "magic" }),
    ).rejects.toThrow(/assetClass/);
  });

  it("sorts results by unrealizedGain descending", async () => {
    loadCanonicalPortfolioSummary.mockResolvedValueOnce({
      currency: "EUR",
      summaries: [
        {
          id: 1,
          name: "A",
          asset_class: "stock",
          totalUnits: 1,
          currentValue: 100,
          unrealizedGain: 50,
        },
        {
          id: 2,
          name: "B",
          asset_class: "stock",
          totalUnits: 1,
          currentValue: 300,
          unrealizedGain: 200,
        },
      ],
      totals: { totalPortfolioValue: 400 },
    });
    const r = await getUnrealizedGains.run({});
    expect(r.data[0].id).toBe(2); // gain 200 > 50
  });
});

describe("getBestWorstPerformers", () => {
  it("ranks investments by net cashflow returns", async () => {
    loadCanonicalPortfolioSummary
      .mockResolvedValueOnce({
        currency: "EUR",
        summaries: [
          {
            id: 1,
            name: "Apple",
            asset_class: "stock",
            totalIncome: 100,
            totalFees: 0,
            totalTaxes: 0,
          },
          {
            id: 2,
            name: "Tesla",
            asset_class: "stock",
            totalIncome: 0,
            totalFees: 50,
            totalTaxes: 0,
          },
          {
            id: 3,
            name: "BTC",
            asset_class: "crypto",
            totalIncome: 20,
            totalFees: 5,
            totalTaxes: 0,
          },
        ],
      })
      .mockResolvedValueOnce({ currency: "EUR", summaries: [] });
    const r = await getBestWorstPerformers.run({
      from: "2025-04-01",
      to: "2025-04-30",
      topN: 1,
    });
    expect(r.data).toHaveLength(2);
    expect(r.data[0]).toMatchObject({ id: 1, rank: "best", netIncome: 100 });
    expect(r.data[1]).toMatchObject({ id: 2, rank: "worst", netIncome: -50 });
  });

  it("subtracts cumulative summaries at the range boundaries", async () => {
    loadCanonicalPortfolioSummary
      .mockResolvedValueOnce({
        currency: "EUR",
        summaries: [
          {
            id: 1,
            name: "X",
            asset_class: "stock",
            totalIncome: 150,
            totalFees: 0,
            totalTaxes: 0,
          },
        ],
      })
      .mockResolvedValueOnce({
        currency: "EUR",
        summaries: [{ id: 1, totalIncome: 100, totalFees: 0, totalTaxes: 0 }],
      });
    const r = await getBestWorstPerformers.run({
      from: "2025-01-01",
      to: "2025-12-31",
    });
    expect(r.data[0].netIncome).toBe(50);
  });

  it("does not double-list same investment as best and worst", async () => {
    loadCanonicalPortfolioSummary
      .mockResolvedValueOnce({
        currency: "EUR",
        summaries: [
          {
            id: 1,
            name: "Only",
            asset_class: "stock",
            totalIncome: 50,
            totalFees: 0,
            totalTaxes: 0,
          },
        ],
      })
      .mockResolvedValueOnce({ currency: "EUR", summaries: [] });
    const r = await getBestWorstPerformers.run({
      from: "2025-01-01",
      to: "2025-12-31",
      topN: 5,
    });
    expect(r.data).toHaveLength(1);
    expect(r.data[0].rank).toBe("best");
  });

  it("rejects unknown assetClass", async () => {
    await expect(
      getBestWorstPerformers.run({
        from: "2025-01-01",
        to: "2025-12-31",
        assetClass: "unicorn",
      }),
    ).rejects.toThrow(/assetClass/);
  });

  it("rejects reversed date order", async () => {
    await expect(
      getBestWorstPerformers.run({ from: "2025-12-31", to: "2025-01-01" }),
    ).rejects.toThrow();
  });

  it("returns empty when no investments", async () => {
    const r = await getBestWorstPerformers.run({
      from: "2025-01-01",
      to: "2025-12-31",
    });
    expect(r.data).toEqual([]);
  });
});

describe("getProjectedBalance", () => {
  it("combines current bank balance with planned net change", async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({
      total_net_position: 5000,
    });
    plannedTransactionRepository.getAll.mockResolvedValueOnce({
      items: [
        {
          amount: "-100",
          planned_date: "2025-05-01",
          is_recurring: false,
          recipient_name: "Bills",
          category_name: "Utilities",
          memo: "",
        },
        {
          amount: "500",
          planned_date: "2025-05-15",
          is_recurring: false,
          recipient_name: "Salary",
          category_name: "Income",
          memo: "",
        },
      ],
    });

    const r = await getProjectedBalance.run({ horizonDays: 30 });
    expect(r.meta.currentBalance).toBe(5000);
    expect(r.meta.plannedNetChange).toBe(400);
    expect(r.meta.projectedBalance).toBe(5400);
    expect(r.data).toHaveLength(2);
  });

  it("expands recurring planned transactions across the horizon", async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({
      total_net_position: 0,
    });
    plannedTransactionRepository.getAll.mockResolvedValueOnce({
      items: [
        {
          amount: "-12",
          planned_date: new Date("2025-05-01T00:00:00Z"),
          is_recurring: true,
          recurrence_pattern: "monthly",
          recipient_name: "Sub",
          category_name: "Subs",
          memo: "",
        },
      ],
    });
    const r = await getProjectedBalance.run({ horizonDays: 90 });
    // Base + ~3 recurring fires (May, Jun, Jul) — pattern emits next-from-base
    expect(r.data.length).toBeGreaterThanOrEqual(3);
    expect(r.meta.plannedNetChange).toBeLessThan(-12);
  });

  it("rejects horizonDays out of bounds", async () => {
    await expect(getProjectedBalance.run({ horizonDays: 0 })).rejects.toThrow(
      /horizonDays/,
    );
    await expect(getProjectedBalance.run({ horizonDays: 999 })).rejects.toThrow(
      /horizonDays/,
    );
  });

  it("uses 30-day default when horizonDays missing", async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({
      total_net_position: 100,
    });
    plannedTransactionRepository.getAll.mockResolvedValueOnce({ items: [] });
    const r = await getProjectedBalance.run({});
    expect(r.meta.horizonDays).toBe(30);
  });

  it("coerces string total_net_position to number", async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({
      total_net_position: "1234.567",
    });
    plannedTransactionRepository.getAll.mockResolvedValueOnce({ items: [] });
    const r = await getProjectedBalance.run({});
    expect(r.meta.currentBalance).toBe(1234.57);
  });

  it("sorts entries chronologically", async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({
      total_net_position: 0,
    });
    plannedTransactionRepository.getAll.mockResolvedValueOnce({
      items: [
        {
          amount: "-50",
          planned_date: "2025-05-15",
          is_recurring: false,
          recipient_name: "B",
          category_name: "",
          memo: "",
        },
        {
          amount: "-30",
          planned_date: "2025-05-01",
          is_recurring: false,
          recipient_name: "A",
          category_name: "",
          memo: "",
        },
      ],
    });
    const r = await getProjectedBalance.run({ horizonDays: 30 });
    expect(r.data.map((d) => d.date)).toEqual(["2025-05-01", "2025-05-15"]);
  });
});
