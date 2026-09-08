/**
 * Shared insights-digest builder — the single aggregation point over the three
 * detection services (subscription creep, category outliers, cash forecast).
 *
 * Both the AI-chat `insightsDigest` tool and the REST endpoint
 * (`GET /api/info/insights-digest`) read the digest through this function so
 * the contract stays identical across surfaces. It never recomputes anything
 * itself — the detection services cache internally.
 *
 * Dismissals are loaded once from the server-owned store and applied inside
 * each detector before results are returned to REST or AI callers.
 */

import { detectSubscriptionCreep } from "./subscriptionCreepService.js";
import { detectCategoryOutliers } from "./categoryOutlierService.js";
import { getCashForecastInsight } from "./cashForecastInsightService.js";
import insightDismissalRepository from "../repositories/insightDismissalRepository.js";
import { logger } from "../config/logger.js";

let refreshInFlight;
let refreshRetryAfter = 0;

function mapDismissals(rows) {
  return {
    subscriptions: rows
      .filter(
        (row) =>
          row.kind === "subscription_new" ||
          row.kind === "subscription_price_change",
      )
      .map((row) => ({
        recipientId: Number(row.recipient_id),
        findingType: row.kind === "subscription_new" ? "new" : "priceChange",
      })),
    outliers: rows
      .filter((row) => row.kind === "category_outlier")
      .map((row) => ({
        categoryId: Number(row.category_id),
        monthKey: row.month_key,
        dismissedAt: row.dismissed_at,
        deviationAtDismiss: Number(row.deviation_at_dismiss),
      })),
  };
}

function countDigest(digest) {
  return (
    digest.subscriptionCreep.new.length +
    digest.subscriptionCreep.priceChanges.length +
    digest.categoryOutliers.length +
    (digest.cashForecast?.prominence === "alert" ? 1 : 0)
  );
}

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
  const state = await insightDismissalRepository.getCountState();
  const version = Number(state?.dirty_version ?? 0);
  const dismissals = mapDismissals(
    await insightDismissalRepository.listDismissals(),
  );
  const [subscriptionCreep, categoryOutliers, cashForecast] = await Promise.all(
    [
      detectSubscriptionCreep({ dismissRecords: dismissals.subscriptions }),
      detectCategoryOutliers({ dismissRecords: dismissals.outliers }),
      getCashForecastInsight(),
    ],
  );

  const digest = {
    subscriptionCreep: {
      new: subscriptionCreep?.new ?? [],
      priceChanges: subscriptionCreep?.priceChanges ?? [],
    },
    categoryOutliers: Array.isArray(categoryOutliers) ? categoryOutliers : [],
    cashForecast: cashForecast ?? null,
  };
  await insightDismissalRepository.saveCountIfVersion(
    countDigest(digest),
    version,
  );
  return digest;
}

export async function getInsightsCount() {
  const state = await insightDismissalRepository.getCountState();
  const ready =
    state &&
    state.undismissed_count != null &&
    Number(state.dirty_version) === Number(state.computed_version) &&
    state.expires_at &&
    new Date(state.expires_at).getTime() > Date.now();
  if (ready) {
    return {
      count: Number(state.undismissed_count),
      status: "ready",
      computed_at: state.computed_at,
    };
  }

  if (Date.now() < refreshRetryAfter) {
    return {
      count: null,
      status: "unavailable",
      computed_at: null,
    };
  }

  if (!refreshInFlight) {
    refreshInFlight = getInsightsDigest()
      .catch((error) => {
        refreshRetryAfter = Date.now() + 60_000;
        logger.error("Background insight count refresh failed", {
          error: error.message,
        });
      })
      .finally(() => {
        refreshInFlight = undefined;
      });
  }
  return {
    count: null,
    status: state ? "pending" : "unavailable",
    computed_at: null,
  };
}
