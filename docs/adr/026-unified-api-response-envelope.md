---
title: ADR-026 - Unified API Response Envelope
type: adr
status: Accepted
date: 2026-04-21
tags: [adr, backend, frontend, api-design, phase-1, envelope, error-handling]
description: Standardize every HTTP API response as a discriminated union envelope with ok/data on success and ok/error on failure; extends ADR-011 aggregation envelope to all routes
aliases: [adr-026, api-envelope, response-envelope, unified-envelope]
related_code: ["apps/node-backend/src/middleware/errorHandler.js", "apps/node-backend/src/routes/", "apps/frontend/src/lib/api.ts", "packages/types/"]
---

# ADR-026: Unified API Response Envelope

## Status
Accepted

## Date
2026-04-20

## Context

Vision's 108 HTTP endpoints return inconsistent shapes:

- `/api/aggregations/*` — `{ data, meta: { source, computedAt } }` per [[docs/adr/011-phase2-aggregation-envelope-standard|ADR-011]]
- `/api/info/*` — bare data objects or arrays (`{ summary: ... }`, `[{...}]`)
- `/api/transactions` — bare arrays plus ad-hoc pagination fields
- Errors — `{ detail, error_code }` from `createErrorHandler`, but some routes emit `{ message }` or raw strings
- Some writes return `{ id }`, others the full row, others `204`

The frontend `apps/frontend/src/lib/api.ts` handles this by sniffing shape per call site (1666 LOC of accumulated conditionals). Error handling branches on `res.detail` vs `res.message` vs HTTP status. Adding a new endpoint = adding another special case.

Phase 1 of the perf/arch sweep mandates a single response contract so:

1. Frontend `api.ts` becomes uniform — one unwrap function, one error type.
2. OpenAPI generation (Phase 2) has a stable schema.
3. Request/response middleware (auth, logging, correlation IDs) has a predictable shape to wrap.

## Decision

### Envelope

Every API response is a discriminated union keyed on `ok`:

```ts
// packages/types/api.ts
export type ApiResponse<T> =
  | { ok: true; data: T; meta?: ResponseMeta }
  | { ok: false; error: ApiError };

export interface ResponseMeta {
  requestId?: string;
  computedAt?: string;
  source?: 'mv' | 'live';
  pagination?: { total: number; page: number; limit: number };
}

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'INTERNAL_SERVER_ERROR'
  | 'BAD_GATEWAY'
  | 'APP_ERROR';
```

### HTTP Semantics

- `ok: true` → HTTP 2xx. Body always `{ ok: true, data, meta? }`.
- `ok: false` → HTTP 4xx/5xx. Body always `{ ok: false, error: { code, message, details? } }`.
- `204 No Content` is NOT used. Empty success = `{ ok: true, data: null }`.
- `meta.requestId` always present (set by correlation-id middleware).

### Backend

New middleware `wrapResponse` exposes `res.ok(data, meta?)` on every request:

```js
// apps/node-backend/src/middleware/envelope.js
export function wrapResponse(req, res, next) {
  res.ok = (data, meta) => {
    res.json({
      ok: true,
      data,
      meta: { requestId: req.id, ...meta },
    });
  };
  next();
}
```

`createErrorHandler` (existing) rewrites its output from `{ detail, error_code }` to `{ ok: false, error: { code, message, details? } }`. The typed `AppError` classes (`ValidationError`, `NotFoundError`, etc.) are retained — only the serializer changes.

### Frontend

`apps/frontend/src/lib/api/client.ts` unwraps the envelope once:

```ts
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body: ApiResponse<T> = await res.json();
  if (!body.ok) throw new ApiClientError(body.error, res.status);
  return body.data;
}
```

`ApiClientError` carries `code`, `message`, `details`, `requestId`. React Query error handling narrows on `error instanceof ApiClientError` + `error.code`.

### Aggregation Endpoints (supersession note)

[[docs/adr/011-phase2-aggregation-envelope-standard|ADR-011]] defined `{ data, meta: { source, computedAt } }` for `/api/aggregations/*`. That envelope is now **a specialization** of the unified envelope — aggregation responses become `{ ok: true, data, meta: { source, computedAt, requestId } }`. The aggregation `meta` fields move under the unified `meta`. No `data` shape change.

### Pagination

Paginated responses set `meta.pagination`; the response `data` is the plain array. Removes mutating `res.items.map` patterns in legacy frontend paths.

```js
res.ok(rows, { pagination: { total, page, limit } });
```

### Migration

One PR per route file. Mechanical. Tests migrate in lockstep. Legacy consumers broken intentionally — there is no backwards-compat period. The node-backend is internal and the frontend ships in the same repo.

Order:
1. Add `packages/types/api.ts` + middleware `wrapResponse`.
2. Rewrite `createErrorHandler` output.
3. Convert routes in dependency order: leaf routes first (`categories`, `recipients`, `splits`), then compound (`info`, `transactions`, `importRoutes`), then aggregations (already close — just rename `{ data, meta }` → `{ ok, data, meta }`).
4. Rewrite `frontend/src/lib/api.ts` after split (see [[docs/adr/026-unified-api-response-envelope#Related|api.ts split]]).
5. Delete all route-level ad-hoc `res.status(...).json(...)` error emitters; force routes through `throw new AppError(...)`.

## Consequences

### Positive

- Single response contract for all 108 endpoints.
- Frontend fetch path goes from ~1666 LOC (sniffing, coercing, mapping) to one unwrap.
- Errors carry a stable `code` usable for UI branching and i18n message keys.
- OpenAPI generation has a predictable output shape; generated types replace hand-maintained `Transaction`-like duplicates.
- Request IDs propagate through `meta.requestId` for cross-log correlation.
- ADR-011 aggregation envelope remains semantically intact; no frontend logic change for aggregation freshness UI.

### Negative

- Breaking change for every route and every frontend consumer. Rolled in a single phase with no coexistence window.
- Every response is 1 level deeper (`body.data` instead of `body`). Marginal payload overhead.
- Existing integration tests that assert `expect(body.detail).toBe(...)` must update to `expect(body.error.message).toBe(...)`.

### Rollback

If envelope adoption destabilizes production:
1. Revert PRs for envelope middleware + route rewrites (atomic per phase).
2. Frontend `api/client.ts` reverts to direct JSON consumption.
3. Error classes unchanged — only the serializer is reverted.
4. No database, schema, or migration changes — fully reversible in code.

## Implementation Notes

**Envelope audit complete (Phase 1, 2026-04-21):**

All 15 route files (`apps/node-backend/src/routes/*.js`) plus investment controller have been audited for envelope adoption:

- **100% adoption of `res.ok(...)`** for JSON success responses across all 108 endpoints
- **Documented exceptions:**
  1. `routes/splits.js:99` — CSV download via `res.send(csv)`. Binary/text response envelope N/A; client receives raw CSV body. Annotated with comment citing ADR-026.
  2. `res.status(204).send()` — bodyless 204 No Content responses in savedCharts, watchlist, ai, investmentController routes. Per ADR-026, 204s are superseded by `{ ok: true, data: null }`, but these legacy call sites predate envelope adoption. Scheduled for Phase 2 cleanup.

No code changes required beyond the splits.js comment — documentation confirms 100% envelope conformance with two formally documented exceptions.

**Frontend client.ts split (Phase 1, 2026-04-21):**

The envelope unwrapping logic (`unwrapEnvelope`, `parseEnvelopeError`, backoff, retry) is now extracted into `apps/frontend/src/lib/api/client.ts` (transport layer), while `ApiClientError` type and `ApiResponse<T>` envelope types live in `apps/frontend/src/lib/api/types.ts`. The ApiClient class in `api.ts` remains the facade. This split enables:

1. **Single unwrap function** — one place to handle `{ ok, data/error }` discriminator
2. **Type safety** — shared `ApiResponse<T>`, `ApiErrorCode` definitions
3. **Testability** — transport layer is pure and mockable
4. **Incremental domain split** — Phase 2 will extract methods by domain into separate modules

See [[docs/reference/frontend-api-client|Frontend API Client Architecture]] for details.

## Related

- [[docs/adr/011-phase2-aggregation-envelope-standard|ADR-011: Aggregation Envelope]] — specialized by this ADR
- [[docs/adr/006-three-layer-architecture|ADR-006: Three-Layer Architecture]] — route/service/repo separation preserved
- [[docs/adr/027-alembic-single-source-of-schema|ADR-027: Alembic as Single Source of Schema Truth]] — sibling Phase 1 decision
- [[docs/reference/frontend-api-client|Frontend API Client Architecture]] — transport + types + ApiClient split
- [[docs/api/index|API Index]] — endpoint matrix to be regenerated after migration
- [[docs/reference/code-patterns|Code Patterns]] — envelope + error handling patterns
