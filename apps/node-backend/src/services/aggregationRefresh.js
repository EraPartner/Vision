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
} from './materializedViewService.js';
import mcCacheRepo from '../repositories/cashflowForecastMcRepository.js';
import mcRollingCacheRepo from '../repositories/cashflowForecastMcRollingRepository.js';
import { logger } from '../config/logger.js';

/** Trigger-maintained tables — documented here, never refreshed from app code. */
export const TRIGGER_MAINTAINED_TABLES = Object.freeze([
  'agg_recipient_totals',
  'agg_split_outstanding',
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
  await Promise.all([
    mcCacheRepo.clearAll().catch((err) => logger.warn('Forecast MC cache invalidation failed', { error: err.message })),
    mcRollingCacheRepo.clearAll().catch((err) => logger.warn('Rolling forecast MC cache invalidation failed', { error: err.message })),
  ]);
}

/**
 * Debounced refresh for single-row mutations. Delegates to the legacy service,
 * which owns its own debounce/coalescing window.
 */
export function scheduleAggregationRefresh() {
  scheduleLegacyRefresh();
}

/**
 * Cancel any pending debounced refresh. Retained for API stability (graceful
 * shutdown calls it); now a no-op since the only app-side debounce
 * (mv_recipient_monthly) was removed and the legacy service manages its own.
 */
export function cancelPendingAggregationRefresh() {}

export default {
  refreshAggregations,
  scheduleAggregationRefresh,
  cancelPendingAggregationRefresh,
  TRIGGER_MAINTAINED_TABLES,
};
