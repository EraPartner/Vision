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
 * @param {import('../types/express.js').ExpressRequest} req
 * @param {import('../types/express.js').ExpressResponse} res
 * @param {import('../types/express.js').ExpressNextFunction} next
 */
export function wrapResponse(req, res, next) {
  /**
   * Send a success envelope.
   *
   * @template T
   * @param {T} data
   * @param {import('@vision/types/api').ResponseMeta} [meta]
   * @returns {import('../types/express.js').ExpressResponse}
   */
  res.ok = function sendOk(data, meta) {
    /** @type {{ ok: true, data: T, meta?: import('@vision/types/api').ResponseMeta }} */
    const body = { ok: true, data };
    const mergedMeta = req.id ? { requestId: req.id, ...(meta ?? {}) } : meta;
    if (mergedMeta) body.meta = mergedMeta;
    return res.json(body);
  };
  next();
}
