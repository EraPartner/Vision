/**
 * Unified response envelope middleware (see docs/adr/026-unified-api-response-envelope.md).
 *
 * Attaches `res.ok(data, meta?)` so route handlers write success responses in a
 * single shape across all 108 endpoints:
 *   { ok: true, data, meta? }
 *
 * Failure envelopes are emitted by the error handler (see errorHandler.js) —
 * route handlers throw typed errors rather than hand-shaping the failure case.
 */

import type { ResponseMeta } from "@vision/types/api";
import type {
  ExpressNextFunction,
  ExpressRequest,
  ExpressResponse,
} from "../types/express.ts";

/**
 * Express middleware. Idempotent — safe to mount more than once, but typical
 * usage is a single mount right before routers.
 */
export function wrapResponse(
  req: ExpressRequest,
  res: ExpressResponse,
  next: ExpressNextFunction,
) {
  /** Send a success envelope. */
  res.ok = function sendOk<T>(data: T, meta?: ResponseMeta): ExpressResponse {
    const body: { ok: true; data: T; meta?: ResponseMeta } = { ok: true, data };
    const mergedMeta = req.id ? { requestId: req.id, ...(meta ?? {}) } : meta;
    if (mergedMeta) body.meta = mergedMeta;
    return res.json(body);
  };
  next();
}
