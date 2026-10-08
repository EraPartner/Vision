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

import { detectSubscriptionCreep } from "./subscriptionCreepService.ts";
import type {
  NewSubscriptionFinding,
  SubscriptionDismissRecord,
  SubscriptionPriceChangeFinding,
} from "./subscriptionCreepService.ts";
import { detectCategoryOutliers } from "./categoryOutlierService.ts";
import type {
  CategoryOutlierDismissRecord,
  CategoryOutlierFinding,
} from "./categoryOutlierService.ts";
import { getCashForecastInsight } from "./cashForecastInsightService.ts";
import type { CashForecastInsight } from "./cashForecastInsightService.ts";
import insightDismissalRepository from "../repositories/insightDismissalRepository.ts";
import type { InsightDismissalRow } from "../repositories/insightDismissalRepository.ts";
import { logger } from "../config/logger.ts";

export interface InsightsDigest {
  subscriptionCreep: {
    new: NewSubscriptionFinding[];
    priceChanges: SubscriptionPriceChangeFinding[];
  };
  categoryOutliers: CategoryOutlierFinding[];
  cashForecast: CashForecastInsight | null;
}

type DismissalRow = Omit<InsightDismissalRow, "id">;

/** chk_insight_dismissals_shape makes these columns NOT NULL for outliers. */
type OutlierDismissalRow = DismissalRow & {
  kind: "category_outlier";
  category_id: number;
  month_key: string;
};

function isOutlierDismissal(row: DismissalRow): row is OutlierDismissalRow {
  return row.kind === "category_outlier";
}

let refreshInFlight: Promise<InsightsDigest | void> | undefined;
let refreshRetryAfter = 0;

function mapDismissals(rows: DismissalRow[]): {
  subscriptions: SubscriptionDismissRecord[];
  outliers: CategoryOutlierDismissRecord[];
} {
  return {
    subscriptions: rows
      .filter(
        (row) =>
          row.kind === "subscription_new" ||
          row.kind === "subscription_price_change",
      )
      .map((row): SubscriptionDismissRecord => ({
        recipientId: Number(row.recipient_id),
        findingType: row.kind === "subscription_new" ? "new" : "priceChange",
      })),
    outliers: rows.filter(isOutlierDismissal).map((row) => ({
      categoryId: Number(row.category_id),
      monthKey: row.month_key,
      dismissedAt: row.dismissed_at,
      deviationAtDismiss: Number(row.deviation_at_dismiss),
    })),
  };
}

function countDigest(digest: InsightsDigest) {
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
 * @returns cashForecast is null when no forecast insight is available.
 */
export async function getInsightsDigest(): Promise<InsightsDigest> {
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

  const digest: InsightsDigest = {
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
