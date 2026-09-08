import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  listDismissals: vi.fn(),
  getCountState: vi.fn(),
  saveCountIfVersion: vi.fn(),
}));

vi.mock("../src/repositories/insightDismissalRepository.js", () => ({
  default: repository,
}));

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
import {
  getInsightsCount,
  getInsightsDigest,
} from "../src/services/insightsDigestService.js";

beforeEach(() => {
  vi.resetAllMocks();
  repository.listDismissals.mockResolvedValue([]);
  repository.getCountState.mockResolvedValue({ dirty_version: 3 });
  repository.saveCountIfVersion.mockResolvedValue({});
});

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
    monthEndNetCashflow: 1250.4,
    monthEndNetCashflowLow: 900.2,
    monthEndNetCashflowHigh: 1800.7,
    movedSignificantly: false,
    prominence: "standing",
    methodId: "monte_carlo_parametric",
    ...overrides,
  };
}

describe("getInsightsDigest", () => {
  it("returns the exact digest contract assembled from the three services", async () => {
    detectSubscriptionCreep.mockResolvedValueOnce({
      new: [newSubscriptionFinding()],
      priceChanges: [priceChangeFinding()],
    });
    detectCategoryOutliers.mockResolvedValueOnce([outlierFinding()]);
    getCashForecastInsight.mockResolvedValueOnce(cashForecastFinding());

    const digest = await getInsightsDigest();

    expect(digest).toEqual({
      subscriptionCreep: {
        new: [newSubscriptionFinding()],
        priceChanges: [priceChangeFinding()],
      },
      categoryOutliers: [outlierFinding()],
      cashForecast: cashForecastFinding(),
    });
  });

  it("passes persisted dismissals to both detectors before their caps", async () => {
    repository.listDismissals.mockResolvedValue([
      { kind: "subscription_new", recipient_id: 8 },
      {
        kind: "category_outlier",
        category_id: 7,
        month_key: "2026-07",
        dismissed_at: "2026-07-10T00:00:00Z",
        deviation_at_dismiss: 4.2,
      },
    ]);
    detectSubscriptionCreep.mockResolvedValueOnce({
      new: [],
      priceChanges: [],
    });
    detectCategoryOutliers.mockResolvedValueOnce([]);
    getCashForecastInsight.mockResolvedValueOnce(null);

    await getInsightsDigest();

    expect(detectSubscriptionCreep).toHaveBeenCalledWith({
      dismissRecords: [{ recipientId: 8, findingType: "new" }],
    });
    expect(detectCategoryOutliers).toHaveBeenCalledWith({
      dismissRecords: [
        {
          categoryId: 7,
          monthKey: "2026-07",
          dismissedAt: "2026-07-10T00:00:00Z",
          deviationAtDismiss: 4.2,
        },
      ],
    });
    expect(getCashForecastInsight).toHaveBeenCalledWith();
  });

  it("passes a null cashForecast through as null", async () => {
    detectSubscriptionCreep.mockResolvedValueOnce({
      new: [],
      priceChanges: [],
    });
    detectCategoryOutliers.mockResolvedValueOnce([]);
    getCashForecastInsight.mockResolvedValueOnce(null);

    const digest = await getInsightsDigest();

    expect(digest.cashForecast).toBeNull();
  });

  it("normalizes missing service payloads to empty lists", async () => {
    detectSubscriptionCreep.mockResolvedValueOnce(undefined);
    detectCategoryOutliers.mockResolvedValueOnce(undefined);
    getCashForecastInsight.mockResolvedValueOnce(undefined);

    const digest = await getInsightsDigest();

    expect(digest).toEqual({
      subscriptionCreep: { new: [], priceChanges: [] },
      categoryOutliers: [],
      cashForecast: null,
    });
  });

  it("rejects when any detection service rejects (route layer owns degradation)", async () => {
    detectSubscriptionCreep.mockResolvedValueOnce({
      new: [],
      priceChanges: [],
    });
    detectCategoryOutliers.mockRejectedValueOnce(new Error("db down"));
    getCashForecastInsight.mockResolvedValueOnce(null);

    await expect(getInsightsDigest()).rejects.toThrow("db down");
    expect(repository.saveCountIfVersion).not.toHaveBeenCalled();
  });

  it("writes the undismissed count only against the captured version", async () => {
    detectSubscriptionCreep.mockResolvedValueOnce({
      new: [newSubscriptionFinding()],
      priceChanges: [priceChangeFinding()],
    });
    detectCategoryOutliers.mockResolvedValueOnce([outlierFinding()]);
    getCashForecastInsight.mockResolvedValueOnce(
      cashForecastFinding({ prominence: "alert" }),
    );

    await getInsightsDigest();
    expect(repository.saveCountIfVersion).toHaveBeenCalledWith(4, 3);
  });
});

describe("getInsightsCount", () => {
  it("returns a valid projection without running detection", async () => {
    repository.getCountState.mockResolvedValue({
      undismissed_count: 6,
      dirty_version: 4,
      computed_version: 4,
      computed_at: "2026-09-08T00:00:00Z",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(getInsightsCount()).resolves.toEqual({
      count: 6,
      status: "ready",
      computed_at: "2026-09-08T00:00:00Z",
    });
    expect(detectSubscriptionCreep).not.toHaveBeenCalled();
  });

  it("returns pending promptly and coalesces a dirty refresh", async () => {
    repository.getCountState.mockResolvedValue({
      undismissed_count: 9,
      dirty_version: 5,
      computed_version: 4,
      computed_at: "2026-09-08T00:00:00Z",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    let release;
    detectSubscriptionCreep.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    detectCategoryOutliers.mockResolvedValue([]);
    getCashForecastInsight.mockResolvedValue(null);

    expect(await getInsightsCount()).toMatchObject({
      count: null,
      status: "pending",
    });
    expect(await getInsightsCount()).toMatchObject({ status: "pending" });
    await vi.waitFor(() =>
      expect(detectSubscriptionCreep).toHaveBeenCalledTimes(1),
    );
    release({ new: [], priceChanges: [] });
    await vi.waitFor(() =>
      expect(repository.saveCountIfVersion).toHaveBeenCalledWith(0, 5),
    );
  });

  it("backs off after a failed background refresh", async () => {
    repository.getCountState.mockResolvedValue({
      undismissed_count: 9,
      dirty_version: 5,
      computed_version: 4,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    detectSubscriptionCreep.mockRejectedValue(new Error("db down"));
    detectCategoryOutliers.mockResolvedValue([]);
    getCashForecastInsight.mockResolvedValue(null);

    await expect(getInsightsCount()).resolves.toMatchObject({
      status: "pending",
    });
    await vi.waitFor(() =>
      expect(detectSubscriptionCreep).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(async () =>
      expect(getInsightsCount()).resolves.toMatchObject({
        status: "unavailable",
      }),
    );
    expect(detectSubscriptionCreep).toHaveBeenCalledTimes(1);
  });
});
