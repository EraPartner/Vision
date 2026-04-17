---
title: ADR-016 Aggregation Shadow Mode
type: adr
status: Accepted
date: 2026-04-17
tags: [adr, aggregation, migration, observability, phase-8]
description: Shadow middleware that cross-checks new /api/aggregations/* responses against legacy /api/info/* during the Phase 2 → Phase 9 migration window.
aliases: [adr-016, aggregation shadow, shadow mode]
---

# ADR-016: Aggregation Shadow Mode

## Status
Accepted

## Date
2026-04-17

## Context

Vision is mid-migration from the legacy `/api/info/*` endpoints (hand-rolled SQL + ad-hoc shapes) to the new `/api/aggregations/*` endpoints built on the Phase 1 materialized-view + trigger-maintained table strategy ([[docs/adr/010-phase1-aggregation-strategy]]) and the Phase 2 `{ data, meta }` envelope ([[docs/adr/011-phase2-aggregation-envelope-standard]]).

Both surfaces are live simultaneously. Golden-fixture tests ([[docs/reference/code-patterns#golden-fixture-pattern|Golden-Fixture Pattern]]) and property tests ([[docs/testing/testing#property-test-pattern-phase-8|Property Test Pattern]]) lock pure-calc correctness, but they cannot prove parity of the two HTTP surfaces under real request shapes (filter combinations, timezone handling, NUMERIC string coercion, empty-period edge cases).

Switching `/api/aggregations/*` on blind would either (a) risk silent drift from legacy for months until a user noticed, or (b) force a big-bang cutover with no rollback signal.

## Decision

Ship `createAggregationShadow` — an observational Express middleware factory that, for each successful `GET` on the new aggregation surface, replays the paired legacy call in the background and logs any numeric leaf delta above a configurable threshold.

### Factory signature

```
createAggregationShadow({
  fetchLegacy,          // (req) => Promise<unknown>  — required
  logger,               // { warn, error, debug? }     — required
  thresholdCents = 1,   // divergence floor in cents
  timeoutMs = 5000,     // cap for the legacy fetch
}) => RequestHandler
```

Source: `apps/node-backend/src/middleware/aggregationShadow.js`.

Pure helper exported for unit tests:

```
diffPayloads(nextPayload, legacyPayload, thresholdUnits)
  => Array<{ path, next, legacy, delta }>
```

### Behaviour

- **Non-blocking.** The legacy fetch runs inside `queueMicrotask` after the new response is sent. User latency is unaffected.
- **Envelope-aware.** The diff unwraps `{ data, meta }` (Phase 2) so `meta.computedAt` / `meta.source` drift never flags.
- **NUMERIC string coercion.** Strings matching `/^-?\d+(?:\.\d+)?$/` are coerced before comparison — Postgres NUMERIC comes through as string, legacy paths as number, both must compare equal.
- **Structural drift is tolerated** unless the present side exceeds threshold — one-sided leaves only flag when the nonzero magnitude is material.
- **Failures are swallowed.** Legacy timeout / throw logs at `warn` level (`aggregation-shadow: legacy fetch failed`) and never surfaces to the client.
- **Divergence log shape:** `warn` level, message `aggregation-shadow: divergence detected`, payload `{ path, query, count, divergences[≤20], thresholdCents }`. Top-20 cap keeps log volume bounded under large aggregations.
- **GET-only.** `POST`/`PUT`/`DELETE` skip the shadow path entirely.

### Threshold

Default `thresholdCents = 1`. Chosen to ignore the final-cent noise introduced by rounding-at-different-boundaries between legacy SQL (`ROUND()` in query) and the new pure-calc layer (`toFixed(2)` after aggregation). Any delta > 1¢ on any leaf is real and must be triaged.

## Consequences

### Positive

- Safe migration. Parity can be measured in production without user impact.
- Observability by construction. Every divergence is one `warn` log away from a dashboard alert.
- Testable. `createAggregationShadow` is a pure factory, `diffPayloads` is an exported pure function — both unit-testable with no Express / Postgres / fetch stack.
- Bounded log cost. 20-divergence cap + 5s timeout prevent a misbehaving legacy path from flooding logs or pinning workers.

### Negative

- Double the DB load on shadowed endpoints during the rollout window. Acceptable because `/api/info/*` was already the production path; shadow just keeps it warm a while longer.
- Parity is only measured on traffic that actually hits the new surface. Untrafficked endpoints get no signal — caller must plan synthetic probes if coverage matters.

### Neutral

- Adds one middleware layer per shadowed route. Non-invasive — mount at router boundary, remove without touching route handlers.

## Removal Criteria (Phase 9)

Remove `createAggregationShadow` and the `/api/info/*` fallback when **all** hold for one full release cycle:

1. Zero `aggregation-shadow: divergence detected` logs across all shadowed endpoints.
2. Zero `aggregation-shadow: legacy fetch failed` logs above baseline (i.e. not just transient network).
3. All routes listed in [[docs/reference/api-endpoint-matrix]] under the `aggregations` surface have been shadowed in production traffic, not just test traffic.
4. Frontend no longer imports any `/api/info/*` client helper.

Tracking item: `TODO.md` → Phase 9 → "Remove aggregation shadow + legacy /api/info/*".

## Related

- [[docs/adr/010-phase1-aggregation-strategy]] — MVs + trigger-maintained tables this migrates toward
- [[docs/adr/011-phase2-aggregation-envelope-standard]] — `{ data, meta }` envelope the shadow unwraps
- [[docs/reference/code-patterns#aggregation-envelope-pattern|Aggregation Envelope Pattern]]
- [[docs/testing/testing#property-test-pattern-phase-8|Property Test Pattern]] — invariants locked for calc parity
- [[apps/node-backend/tests/golden/INVENTORY|Calculation Inventory]] — G/P/S coverage matrix
- [[docs/adr/index|All ADRs]]
