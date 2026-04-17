/**
 * Aggregation response envelope.
 *
 * Phase 2 endpoints (`/api/aggregations/*`) return `{ data, meta }` where
 * meta.source indicates whether the aggregate was served from a materialized
 * view (`'mv'`) or computed live (`'live'`). Used by the frontend to surface
 * freshness and by the shadow-mode diff in Phase 8 to correlate divergences.
 */

export function buildEnvelope(data, { source = 'live', computedAt } = {}) {
  return {
    data,
    meta: {
      computedAt: computedAt ?? new Date().toISOString(),
      source,
    },
  };
}

export default { buildEnvelope };
