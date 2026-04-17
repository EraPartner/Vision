/**
 * Aggregation Refresh Orchestrator (Phase 1).
 *
 * Single entrypoint for refreshing the Postgres-backed aggregation layer
 * that powers dashboard / statistics / recipient-insights endpoints.
 *
 * Two maintenance strategies live behind this module:
 *
 *  1. Materialized views — refreshed on demand. Composes the existing
 *     `materializedViewService` (4 legacy MVs) and adds `mv_recipient_monthly`
 *     introduced in alembic 0026. REFRESH ... CONCURRENTLY requires each
 *     view to have a unique index and to have been populated at least once;
 *     we fall back to a plain REFRESH on the first call after migration.
 *
 *  2. Trigger-maintained tables — `agg_recipient_totals` and
 *     `agg_split_outstanding` (both introduced in alembic 0026) are kept
 *     in sync by row-level triggers on `transactions`, `transaction_splits`
 *     and `split_payments`. These never need refresh from application code;
 *     they are documented here so write-side services don't try to.
 *
 * Call sites (to be wired up in Phases 2–7):
 *   - after bulk transaction imports commit
 *   - after single-row mutations, via `scheduleAggregationRefresh()`
 *   - nightly cron (if configured)
 *
 * Request-coalescing: the existing `materializedViewService` already
 * serialises refreshes. This module reuses that coalescer for the legacy
 * MVs and adds its own guard around `mv_recipient_monthly`.
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';
import {
  refreshMaterializedViews as refreshLegacyMaterializedViews,
  scheduleRefresh as scheduleLegacyRefresh,
} from './materializedViewService.js';

/** Phase-1 materialized views not managed by the legacy service. */
const PHASE_1_MATERIALIZED_VIEWS = ['mv_recipient_monthly'];

/** Trigger-maintained tables — documented here, never refreshed from app code. */
export const TRIGGER_MAINTAINED_TABLES = Object.freeze([
  'agg_recipient_totals',
  'agg_split_outstanding',
]);

let phase1InFlight = false;
let phase1Queued = false;

/**
 * Refresh the Phase-1 materialized views (currently `mv_recipient_monthly`).
 *
 * Uses CONCURRENTLY when possible; falls back to a plain REFRESH the first
 * time the view is touched after a migration (before it has been populated
 * for a concurrent refresh).
 */
async function refreshPhase1Views() {
  if (phase1InFlight) {
    phase1Queued = true;
    return;
  }

  phase1InFlight = true;
  const start = Date.now();

  try {
    for (const view of PHASE_1_MATERIALIZED_VIEWS) {
      try {
        await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
      } catch (err) {
        const msg = err?.message ?? '';
        if (
          msg.includes('has not been populated') ||
          msg.includes('cannot refresh materialized view') ||
          msg.includes('concurrently')
        ) {
          logger.warn(`Falling back to non-concurrent refresh for ${view}`);
          await query(`REFRESH MATERIALIZED VIEW ${view}`);
        } else {
          logger.warn(`Failed to refresh ${view}`, { error: msg });
        }
      }
    }
    logger.info(`Phase-1 aggregations refreshed in ${Date.now() - start}ms`);
  } finally {
    phase1InFlight = false;
    if (phase1Queued) {
      phase1Queued = false;
      setTimeout(() => {
        refreshPhase1Views().catch(err =>
          logger.error('Deferred Phase-1 refresh failed', { error: err?.message })
        );
      }, 500);
    }
  }
}

/**
 * Refresh every managed aggregation source.
 *
 * - Legacy MVs: delegated to `materializedViewService.refreshMaterializedViews`.
 * - Phase-1 MVs: refreshed here.
 * - Trigger-maintained tables: no-op (kept in sync row-by-row).
 */
export async function refreshAggregations() {
  // Legacy + Phase-1 are independent sets — refresh in parallel.
  await Promise.all([refreshLegacyMaterializedViews(), refreshPhase1Views()]);
}

/**
 * Debounced refresh for single-row mutations. Coalesces bursts into one pass.
 * Phase-1 views follow the legacy debounce to avoid refresh storms under load.
 */
let debounceTimer = null;

export function scheduleAggregationRefresh() {
  // Legacy service has its own debounce; we reuse it and kick Phase-1 alongside.
  scheduleLegacyRefresh();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    refreshPhase1Views().catch(err =>
      logger.error('Scheduled Phase-1 refresh failed', { error: err?.message })
    );
  }, 1000);
}

export default { refreshAggregations, scheduleAggregationRefresh, TRIGGER_MAINTAINED_TABLES };
