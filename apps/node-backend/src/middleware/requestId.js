/**
 * Request ID middleware.
 *
 * Assigns each request a stable UUID (reusing an incoming `X-Request-Id` header
 * when it matches the safe allow-list regex). The id is attached to `req.id`,
 * echoed on the response `X-Request-Id` header, and propagated into the unified
 * envelope's `meta.requestId` by `wrapResponse` and `createErrorHandler`.
 *
 * See docs/adr/026-unified-api-response-envelope.md for the envelope contract.
 */

import { randomUUID } from 'node:crypto';

/** Accept client-supplied ids only when they look like opaque tokens we can trust. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * @param {import('../types/express.js').ExpressRequest} req
 * @param {import('../types/express.js').ExpressResponse} res
 * @param {import('../types/express.js').ExpressNextFunction} next
 */
export function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming)
    ? incoming
    : randomUUID();

  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}
