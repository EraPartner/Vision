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

/**
 * Express middleware. Idempotent — safe to mount more than once, but typical
 * usage is a single mount right before routers.
 *
 * @type {import('express').RequestHandler}
 */
export function wrapResponse(req, res, next) {
  /**
   * Send a success envelope.
   *
   * @template T
   * @param {T} data
   * @param {import('@vision/types/api').ResponseMeta} [meta]
   * @returns {import('express').Response}
   */
  res.ok = function sendOk(data, meta) {
    const body = { ok: true, data };
    const mergedMeta = req.id ? { requestId: req.id, ...(meta ?? {}) } : meta;
    if (mergedMeta) body.meta = mergedMeta;
    return res.json(body);
  };
  next();
}
