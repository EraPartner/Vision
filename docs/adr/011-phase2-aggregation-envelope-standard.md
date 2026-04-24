---
title: ADR-011 - Phase 2 Aggregation Envelope Standard
type: adr
status: Accepted
date: 2026-04-16
tags: [adr, backend, aggregations, phase-2, api-design, frontend]
description: Standard envelope for aggregation endpoints with source metadata (mv vs. live distinction) to surface data freshness and enable shadow-mode testing
aliases: [adr-011, aggregation-envelope, source-metadata]
---

# ADR-011: Phase 2 Aggregation Envelope Standard

## Status
Accepted (Phase 9 Cutover Complete)

## Date
2026-04-16

## Updated
2026-04-25 — Phase 9 cutover complete; `/api/aggregations/*` is now the sole aggregation path. Legacy `/api/info/*` fallback removed from wiring (note: info.js itself stays for unrelated endpoints like portfolio-performance, net-worth, exchange-rates, etc.)

## Context

Phase 1 ([[docs/adr/010-phase1-aggregation-strategy|ADR-010]]) established Postgres materialized views and trigger-maintained tables as the aggregation caching tier. Phase 2 introduces a new `/api/aggregations/*` endpoint surface to replace the legacy `/api/info/*` aggregation routes during Phases 2–8, with removal in Phase 9 after shadow-mode parity is proven.

Two design questions arise:

1. **Data freshness visibility**: When the frontend reads an aggregation endpoint, how does it know whether the data was served from a fast, pre-computed materialized view (~15 min stale) or computed live on the spot? This is crucial for:
   - **UI labeling**: "Dashboard last updated 5 minutes ago (from materialized view)" vs. "Current (computed live)"
   - **Shadow-mode testing in Phase 8**: Comparing MV read vs. live compute to detect regressions
   - **Performance analysis**: Understanding which requests are cache hits vs. expensive full scans

2. **Exclusion semantics**: When a user applies category or recipient exclusions to a dashboard stat, should the request return the same envelope shape as the unfiltered query, or should it diverge? Answering this defines what the UI must handle and what the API contract guarantees.

## Decision

### Envelope Structure

All `/api/aggregations/*` endpoints return a standardized envelope:

```json
{
  "data": { /* endpoint-specific aggregation result */ },
  "meta": {
    "source": "mv" | "live",
    "computedAt": "2026-04-16T12:34:56.789Z"
  }
}
```

**Field semantics:**

| Field | Type | Meaning |
|-------|------|---------|
| `data` | object | Calculation-specific result (monthly summary, category breakdown, etc.) |
| `meta.source` | enum | `'mv'` = served from materialized view; `'live'` = computed on demand |
| `meta.computedAt` | ISO 8601 | Timestamp when the response was computed (server time) |

### Source Heuristic

The `source` field is determined by the request parameters:

1. **Unfiltered request** → `'mv'`
   - No `excluded_category_ids[]` parameter
   - No `excluded_recipient_ids[]` parameter
   - Response is served from a materialized view (pre-computed, fast, ~15 min stale)
   - Example: `GET /api/aggregations/monthly-summary?currency=EUR` → `source: 'mv'`

2. **Filtered request** → `'live'`
   - At least one `excluded_category_ids[]` OR `excluded_recipient_ids[]` is present
   - Response is computed live by scanning all transactions and applying exclusions
   - Slower (order of seconds on large datasets) but reflects current state
   - Example: `GET /api/aggregations/monthly-summary?currency=EUR&excluded_category_ids=5&excluded_category_ids=10` → `source: 'live'`

3. **Endpoints with no exclusion parameters** → Determined per-endpoint
   - `/category-breakdown`, `/recipient-insights`, `/bank-balances`, `/average-vs-current` do not accept exclusion parameters
   - These use heuristics specific to their computation (e.g., `average-vs-current` always uses `'live'` because "current period" is inherently time-dependent)

### Implementation Pattern

#### Route Layer

Routes parse query parameters and invoke a pure calculation service:

```javascript
// apps/node-backend/src/routes/aggregations.js
router.get('/monthly-summary', async (req, res) => {
  try {
    const envelope = await computeMonthlySummary({
      targetCurrency: getTargetCurrency(req),
      excludedCategoryIds: parseNumericArrayQueryParam(req.query.excluded_category_ids),
      excludedRecipientIds: parseNumericArrayQueryParam(req.query.excluded_recipient_ids),
    });
    res.json(envelope);  // Already wrapped by computeMonthlySummary
  } catch (err) {
    respondError(res, 'monthly-summary', err);
  }
});
```

#### Service Layer

Calculation services determine source, compute result, and wrap in envelope:

```javascript
// apps/node-backend/src/services/calculations/aggregation/monthly.js
export async function computeMonthlySummary({
  targetCurrency,
  excludedCategoryIds,
  excludedRecipientIds,
}) {
  // Determine source based on exclusion presence
  const hasExclusions = excludedCategoryIds.length > 0 || excludedRecipientIds.length > 0;
  const source = hasExclusions ? 'live' : 'mv';

  // Fetch data (from MV or compute live)
  const data = await getMonthlyFinancialSummary(
    excludedCategoryIds,
    targetCurrency,
    excludedRecipientIds
  );

  // Wrap in envelope with source metadata
  return buildEnvelope(data, { source });
}
```

The `buildEnvelope` helper (in `_envelope.js`) is the single place where the response shape is constructed:

```javascript
export function buildEnvelope(data, { source = 'live', computedAt } = {}) {
  return {
    data,
    meta: {
      computedAt: computedAt ?? new Date().toISOString(),
      source,
    },
  };
}
```

#### Frontend Consumption

The frontend receives the envelope and can inspect `meta.source`:

```typescript
const envelope = await apiClient.getAggregationMonthlySummary({ currency: 'EUR' });

// Access data
const { total_income } = envelope.data.summary;

// Check freshness
if (envelope.meta.source === 'mv') {
  console.log(`Data from materialized view (stale by ~15 min)`);
} else {
  console.log(`Data computed live (current)`);
}

// Shadow-mode comparison (Phase 8)
if (SHADOW_MODE_ENABLED) {
  const liveEnvelope = await computeLiveAggregation(...);
  compareResults(envelope.data, liveEnvelope.data); // Detect regressions
}
```

### Repository Integration

**No breaking changes** to existing repository interfaces. Phase 2 adds a 3rd positional parameter to one method:

- `getMonthlyFinancialSummary(excludedCategoryIds, targetCurrency, excludedRecipientIds)` — now accepts `excludedRecipientIds` (defaults to `[]` for backward compatibility)
- `getCashflowComparison(...)` — already accepts both exclusion lists; no change

This allows calculation services to delegate exclusion filtering to the repository, which can use either MV or live scan depending on whether exclusions are present.

### Error Handling

Errors from aggregation endpoints follow the standard error envelope (no change to error format):

```json
{
  "detail": "Error message"
}
```

Errors are **not wrapped in `meta`**; they use the standard 5xx/4xx HTTP status codes.

## Consequences

### Positive

- **Transparency**: Frontend knows whether data is fresh or stale without guessing
- **Shadow-mode parity testing**: Phase 8 can compare `source: 'mv'` responses with `source: 'live'` to validate that the materialized view produces the same results as live compute
- **Performance visibility**: Logging/monitoring can track source distribution (e.g., "80% from MV, 20% live") to understand bottlenecks
- **Graceful degradation**: If a dashboard exclusion is slow to compute, the UI can warn the user with "Computing live results..." instead of silently timing out
- **Consistent shape**: All 6 aggregation endpoints follow the same envelope pattern; no exceptions

### Negative

- **Frontend complexity**: UI must handle `data` and `meta` separately; can no longer treat responses as plain objects
- **API versioning**: Moving `/api/info/*` → `/api/aggregations/*` requires frontend feature-flag or version detection during Phases 2–8
- **Envelope overhead**: Every response adds ~50 bytes of metadata; negligible in practice but adds one level of nesting
- **Backward compatibility**: Legacy `/api/info/*` endpoints do not return `meta.source`; clients must handle both patterns during coexistence period

### Migration Path

1. **Phase 2 (current)**: Launch `/api/aggregations/*` with envelope standard behind `AGGREGATIONS_V2_ENABLED` flag. Legacy `/api/info/*` coexists unchanged.
2. **Phase 3–7**: Shadow-mode testing confirms parity between MV and live sources for all endpoints.
3. **Phase 8**: Add property-based tests that exercise all combinations of exclusions and currencies; verify `source` heuristic is correctly applied.
4. **Phase 9**: Remove `/api/info/*` aggregation endpoints after proven parity; keep `/api/info/*` for portfolio and other non-aggregation queries.

### Rollback

If the envelope standard creates unforeseen integration issues:
1. Revert feature flag `AGGREGATIONS_V2_ENABLED=false` to hide new endpoints
2. Frontend reverts to `/api/info/*` (legacy behavior)
3. Calculation services (`computeMonthlySummary`, etc.) can be deleted or kept as internal utilities
4. No schema or database changes; completely reversible

## Related

- [[docs/adr/010-phase1-aggregation-strategy|ADR-010: Phase 1 Aggregation Strategy]] — materialized views + trigger-maintained tables
- [[docs/api/aggregations|Aggregations API]] — complete endpoint documentation
- [[docs/reference/code-patterns#aggregation-envelope-pattern|Code Patterns: Aggregation Envelope Pattern]] — implementation details
- [[docs/architecture/backend-architecture|Backend Architecture]] — aggregation layer UML
- [[docs/components/dashboard|Dashboard Components]] — frontend integration via `useFilteredDashboardStats`
