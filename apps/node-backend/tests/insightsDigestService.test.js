import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/subscriptionCreepService.js', () => ({
  detectSubscriptionCreep: vi.fn(),
}));

vi.mock('../src/services/categoryOutlierService.js', () => ({
  detectCategoryOutliers: vi.fn(),
}));

vi.mock('../src/services/cashForecastInsightService.js', () => ({
  getCashForecastInsight: vi.fn(),
}));

import { detectSubscriptionCreep } from '../src/services/subscriptionCreepService.js';
import { detectCategoryOutliers } from '../src/services/categoryOutlierService.js';
import { getCashForecastInsight } from '../src/services/cashForecastInsightService.js';
import { getInsightsDigest } from '../src/services/insightsDigestService.js';

beforeEach(() => vi.resetAllMocks());

function newSubscriptionFinding(overrides = {}) {
  return {
    recipientId: 1,
    recipientName: 'Netflix',
    findingType: 'new',
    latestAmount: -12.99,
    currency: 'EUR',
    detectedPattern: 'monthly',
    intervalDays: 30,
    predictedNext: '2026-08-01',
    confidence: 0.95,
    ...overrides,
  };
}

function priceChangeFinding(overrides = {}) {
  return {
    recipientId: 2,
    recipientName: 'Spotify',
    findingType: 'priceChange',
    previousAmount: -9.99,
    newAmount: -11.99,
    percentChange: 20.02,
    direction: 'increased',
    currency: 'EUR',
    confidence: 0.9,
    ...overrides,
  };
}

function outlierFinding(overrides = {}) {
  return {
    categoryId: 7,
    categoryName: 'Food:Groceries',
    monthKey: '2026-07',
    currentAmount: 620.5,
    baselineMedian: 410.25,
    deviation: 4.12,
    direction: 'increased',
    ...overrides,
  };
}

function cashForecastFinding(overrides = {}) {
  return {
    month: '2026-07',
    currency: 'EUR',
    monthEndProjected: 1250.4,
    minProjected: 320.1,
    monthEndLow: 900.2,
    monthEndHigh: 1800.7,
    crossesZero: false,
    movedSignificantly: false,
    prominence: 'standing',
    methodId: 'monte_carlo_parametric',
    ...overrides,
  };
}

describe('getInsightsDigest', () => {
  it('returns the exact digest contract assembled from the three services', async () => {
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

  it('calls the services with no dismiss records and no previous projection (v1)', async () => {
    detectSubscriptionCreep.mockResolvedValueOnce({ new: [], priceChanges: [] });
    detectCategoryOutliers.mockResolvedValueOnce([]);
    getCashForecastInsight.mockResolvedValueOnce(null);

    await getInsightsDigest();

    expect(detectSubscriptionCreep).toHaveBeenCalledWith();
    expect(detectCategoryOutliers).toHaveBeenCalledWith();
    expect(getCashForecastInsight).toHaveBeenCalledWith();
  });

  it('passes a null cashForecast through as null', async () => {
    detectSubscriptionCreep.mockResolvedValueOnce({ new: [], priceChanges: [] });
    detectCategoryOutliers.mockResolvedValueOnce([]);
    getCashForecastInsight.mockResolvedValueOnce(null);

    const digest = await getInsightsDigest();

    expect(digest.cashForecast).toBeNull();
  });

  it('normalizes missing service payloads to empty lists', async () => {
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

  it('rejects when any detection service rejects (route layer owns degradation)', async () => {
    detectSubscriptionCreep.mockResolvedValueOnce({ new: [], priceChanges: [] });
    detectCategoryOutliers.mockRejectedValueOnce(new Error('db down'));
    getCashForecastInsight.mockResolvedValueOnce(null);

    await expect(getInsightsDigest()).rejects.toThrow('db down');
  });
});
