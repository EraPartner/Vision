/**
 * Aggregation response envelope.
 *
 * Phase 2 endpoints (`/api/aggregations/*`) return `{ data, meta }` where
 * meta.source indicates whether the aggregate was served from a materialized
 * view (`'mv'`) or computed live (`'live'`). Used by the frontend to surface
 * freshness and by the shadow-mode diff in Phase 8 to correlate divergences.
 */

export interface EnvelopeOptions {
  source?: string;
  computedAt?: string | Date;
}

export interface AggregationEnvelope<T> {
  data: T;
  meta: { computedAt: string; source: string };
}

export function buildEnvelope<T>(
  data: T,
  { source = 'live', computedAt }: EnvelopeOptions = {},
): AggregationEnvelope<T> {
  return {
    data,
    meta: {
      computedAt: computedAt instanceof Date
        ? computedAt.toISOString()
        : (computedAt ?? new Date().toISOString()),
      source,
    },
  };
}

export default { buildEnvelope };
