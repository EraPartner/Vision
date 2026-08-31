/**
 * Aggregation Refresh Orchestrator.
 *
 * Single entrypoint for refreshing the Postgres-backed aggregation layer that
 * powers the dashboard / statistics endpoints: the legacy materialized views
 * managed by `materializedViewService`, plus a record of the trigger-maintained
 * tables that never need application-side refresh.
 *
 * `mv_recipient_monthly` was previously refreshed here on every mutation, but
 * nothing ever read it — the recipient-insight reads (getRecipientInsights /
 * getRecipientByYear / getRecipientPivot) are live scans, and the view's monthly
 * granularity can't reproduce their per-date-FX / exact-first-seen / spending-only
 * outputs anyway. It has been removed from the refresh set to drop that
 * write-amplification; a companion migration drops the view itself. See the
 * "wire mv_recipient_monthly reads" investigation in TODO/ git history.
 */

import {
  refreshMaterializedViews as refreshLegacyMaterializedViews,
  scheduleRefresh as scheduleLegacyRefresh,
} from "./materializedViewService.js";
import mcCacheRepo from "../repositories/cashflowForecastMcRepository.js";
import mcRollingCacheRepo from "../repositories/cashflowForecastMcRollingRepository.js";
import { logger } from "../config/logger.js";

/** Trigger-maintained tables — documented here, never refreshed from app code. */
export const TRIGGER_MAINTAINED_TABLES = Object.freeze([
  "agg_split_outstanding",
]);

/**
 * Refresh every managed aggregation source after a data change:
 *  - the legacy materialized views (`materializedViewService` serialises them), and
 *  - invalidate the cashflow-forecast MC caches so the forecast and its
 *    walk-forward backtest diagnostics recompute against the new data instead
 *    of serving a stale 6-hour cache entry (the error rates were "static"
 *    between imports otherwise).
 */
export async function refreshAggregations() {
  await refreshLegacyMaterializedViews();
  await clearForecastMcCaches();
}

/**
 * Invalidate both forecast Monte Carlo caches and wait until the invalidation
 * attempts finish. Bulk mutations use this narrow operation before returning
 * so a forecast request cannot observe a stale six-hour entry while the much
 * heavier materialized-view rebuild runs asynchronously.
 */
export function clearForecastMcCaches() {
  return Promise.all([
    mcCacheRepo.clearAll().catch((err) =>
      logger.warn("Forecast MC cache invalidation failed", {
        error: err.message,
      }),
    ),
    mcRollingCacheRepo.clearAll().catch((err) =>
      logger.warn("Rolling forecast MC cache invalidation failed", {
        error: err.message,
      }),
    ),
  ]);
}

// Mirrors the legacy service's 1s coalescing window for rapid single-row edits.
const MC_CLEAR_DEBOUNCE_MS = 1000;
/** @type {ReturnType<typeof setTimeout>|null} */
let mcClearTimer = null;

/**
 * Debounced refresh for single-row mutations: delegates the MV refresh to the
 * legacy service (which owns its own debounce) AND clears the 6-hour
 * cashflow-forecast MC caches. Without the latter, a single create/edit/delete
 * left the forecast serving pre-edit data for up to 6 hours. Bulk imports use
 * the exported synchronous cache-clear operation before returning.
 */
export function scheduleAggregationRefresh() {
  scheduleLegacyRefresh();
  if (mcClearTimer) clearTimeout(mcClearTimer);
  mcClearTimer = setTimeout(() => {
    mcClearTimer = null;
    clearForecastMcCaches();
  }, MC_CLEAR_DEBOUNCE_MS);
  if (typeof mcClearTimer.unref === "function") mcClearTimer.unref();
}

/**
 * Schedule only the materialized-view portion of an aggregation refresh.
 * Bulk mutation paths clear the forecast caches synchronously, then call this
 * after all follow-up writes (for example transfer reconciliation) are done.
 */
export function scheduleMaterializedViewRefresh() {
  scheduleLegacyRefresh();
}

/**
 * Cancel any pending debounced MC-cache clear (graceful shutdown calls this;
 * the legacy MV service manages its own pending work).
 */
export function cancelPendingAggregationRefresh() {
  if (mcClearTimer) {
    clearTimeout(mcClearTimer);
    mcClearTimer = null;
  }
}

export default {
  refreshAggregations,
  clearForecastMcCaches,
  scheduleAggregationRefresh,
  scheduleMaterializedViewRefresh,
  cancelPendingAggregationRefresh,
  TRIGGER_MAINTAINED_TABLES,
};
