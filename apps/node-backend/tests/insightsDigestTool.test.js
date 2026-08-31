import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/subscriptionCreepService.js", () => ({
  detectSubscriptionCreep: vi.fn(),
}));

vi.mock("../src/services/categoryOutlierService.js", () => ({
  detectCategoryOutliers: vi.fn(),
}));

vi.mock("../src/services/cashForecastInsightService.js", () => ({
  getCashForecastInsight: vi.fn(),
}));

import { detectSubscriptionCreep } from "../src/services/subscriptionCreepService.js";
import { detectCategoryOutliers } from "../src/services/categoryOutlierService.js";
import { getCashForecastInsight } from "../src/services/cashForecastInsightService.js";
import { insightsDigest } from "../src/services/aiChat/tools/insights.js";
import { TOOLS, getToolSchemas } from "../src/services/aiChat/tools/index.js";

beforeEach(() => vi.resetAllMocks());

function newSubscriptionFinding(overrides = {}) {
  return {
    recipientId: 1,
    recipientName: "Netflix",
    findingType: "new",
    latestAmount: -12.99,
    currency: "EUR",
    detectedPattern: "monthly",
    intervalDays: 30,
    predictedNext: "2026-08-01",
    confidence: 0.95,
    ...overrides,
  };
}

function priceChangeFinding(overrides = {}) {
  return {
    recipientId: 2,
    recipientName: "Spotify",
    findingType: "priceChange",
    previousAmount: -9.99,
    newAmount: -11.99,
    percentChange: 20.02,
    direction: "increased",
    currency: "EUR",
    confidence: 0.9,
    ...overrides,
  };
}

function outlierFinding(overrides = {}) {
  return {
    categoryId: 7,
    categoryName: "Food:Groceries",
    monthKey: "2026-07",
    currentAmount: 620.5,
    baselineMedian: 410.25,
    deviation: 4.12,
    direction: "increased",
    ...overrides,
  };
}

function cashForecastFinding(overrides = {}) {
  return {
    month: "2026-07",
    currency: "EUR",
    monthEndProjected: 1250.4,
    minProjected: 320.1,
    monthEndLow: 900.2,
    monthEndHigh: 1800.7,
    crossesZero: false,
    movedSignificantly: false,
    prominence: "standing",
    methodId: "monte_carlo_parametric",
    ...overrides,
  };
}

describe("insightsDigest", () => {
  it("assembles the full contract from the three detection services", async () => {
    const subs = {
      new: [newSubscriptionFinding()],
      priceChanges: [priceChangeFinding()],
    };
    const outliers = [outlierFinding()];
    const forecast = cashForecastFinding();
    detectSubscriptionCreep.mockResolvedValueOnce(subs);
    detectCategoryOutliers.mockResolvedValueOnce(outliers);
    getCashForecastInsight.mockResolvedValueOnce(forecast);

    const result = await insightsDigest.run({});

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      subscriptionCreep: {
        new: [newSubscriptionFinding()],
        priceChanges: [priceChangeFinding()],
      },
      categoryOutliers: [outlierFinding()],
      cashForecast: cashForecastFinding(),
    });
    expect(result.meta).toEqual({
      counts: { newSubscriptions: 1, priceChanges: 1, categoryOutliers: 1 },
      hasCashForecast: true,
    });
  });

  it("passes no dismiss records and no previous projection to the services (v1)", async () => {
    detectSubscriptionCreep.mockResolvedValueOnce({
      new: [],
      priceChanges: [],
    });
    detectCategoryOutliers.mockResolvedValueOnce([]);
    getCashForecastInsight.mockResolvedValueOnce(null);

    await insightsDigest.run({});

    expect(detectSubscriptionCreep).toHaveBeenCalledWith();
    expect(detectCategoryOutliers).toHaveBeenCalledWith();
    expect(getCashForecastInsight).toHaveBeenCalledWith();
  });

  it("passes a null cashForecast through as null with hasCashForecast=false", async () => {
    detectSubscriptionCreep.mockResolvedValueOnce({
      new: [],
      priceChanges: [],
    });
    detectCategoryOutliers.mockResolvedValueOnce([]);
    getCashForecastInsight.mockResolvedValueOnce(null);

    const result = await insightsDigest.run({});

    expect(result.ok).toBe(true);
    expect(result.data.cashForecast).toBeNull();
    expect(result.meta.hasCashForecast).toBe(false);
  });

  it("meta.counts reflects the returned array lengths", async () => {
    detectSubscriptionCreep.mockResolvedValueOnce({
      new: [
        newSubscriptionFinding(),
        newSubscriptionFinding({ recipientId: 3 }),
      ],
      priceChanges: [priceChangeFinding()],
    });
    detectCategoryOutliers.mockResolvedValueOnce([
      outlierFinding(),
      outlierFinding({ categoryId: 8 }),
      outlierFinding({ categoryId: 9 }),
    ]);
    getCashForecastInsight.mockResolvedValueOnce(cashForecastFinding());

    const result = await insightsDigest.run({});

    expect(result.meta.counts).toEqual({
      newSubscriptions: 2,
      priceChanges: 1,
      categoryOutliers: 3,
    });
  });

  it("defensively caps each finding list to maxRows and counts the capped lists", async () => {
    detectSubscriptionCreep.mockResolvedValueOnce({
      new: [
        newSubscriptionFinding(),
        newSubscriptionFinding({ recipientId: 3 }),
      ],
      priceChanges: [
        priceChangeFinding(),
        priceChangeFinding({ recipientId: 4 }),
      ],
    });
    detectCategoryOutliers.mockResolvedValueOnce([
      outlierFinding(),
      outlierFinding({ categoryId: 8 }),
    ]);
    getCashForecastInsight.mockResolvedValueOnce(null);

    const result = await insightsDigest.run({}, { maxRows: 1 });

    expect(result.data.subscriptionCreep.new).toHaveLength(1);
    expect(result.data.subscriptionCreep.priceChanges).toHaveLength(1);
    expect(result.data.categoryOutliers).toHaveLength(1);
    expect(result.meta.counts).toEqual({
      newSubscriptions: 1,
      priceChanges: 1,
      categoryOutliers: 1,
    });
  });

  it("is registered in TOOLS and exposed via getToolSchemas()", () => {
    expect(TOOLS.insightsDigest).toBe(insightsDigest);

    const schema = getToolSchemas().find(
      (s) => s.function.name === "insightsDigest",
    );
    expect(schema).toBeDefined();
    expect(schema.type).toBe("function");
    expect(schema.function.parameters).toEqual({
      type: "object",
      properties: {},
    });
    expect(schema.function.description).toBe(insightsDigest.description);
  });
});
