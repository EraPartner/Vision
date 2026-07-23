/**
 * Shared insights-digest builder — the single aggregation point over the three
 * detection services (subscription creep, category outliers, cash forecast).
 *
 * Both the AI-chat `insightsDigest` tool and the REST endpoint
 * (`GET /api/info/insights-digest`) read the digest through this function so
 * the contract stays identical across surfaces. It never recomputes anything
 * itself — the detection services cache internally.
 *
 * v1 passes no dismiss records (undismissed filtering is owned by the client
 * surfacing layer) and no previous month-end projection.
 */

import { detectSubscriptionCreep } from './subscriptionCreepService.js';
import { detectCategoryOutliers } from './categoryOutlierService.js';
import { getCashForecastInsight } from './cashForecastInsightService.js';

/**
 * Aggregate the already-computed findings of the three detection services.
 *
 * @returns {Promise<{
 *   subscriptionCreep: { new: any[], priceChanges: any[] },
 *   categoryOutliers: any[],
 *   cashForecast: object|null,
 * }>} cashForecast is null when no forecast insight is available.
 */
export async function getInsightsDigest() {
  const [subscriptionCreep, categoryOutliers, cashForecast] = await Promise.all([
    detectSubscriptionCreep(),
    detectCategoryOutliers(),
    getCashForecastInsight(),
  ]);

  return {
    subscriptionCreep: {
      new: subscriptionCreep?.new ?? [],
      priceChanges: subscriptionCreep?.priceChanges ?? [],
    },
    categoryOutliers: Array.isArray(categoryOutliers) ? categoryOutliers : [],
    cashForecast: cashForecast ?? null,
  };
}
