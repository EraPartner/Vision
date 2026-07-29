/**
 * CSRF guard for state-changing requests.
 *
 * The API is published on the host loopback (docker-compose maps
 * 127.0.0.1:PORT), so the realistic cross-origin threat is a malicious web page
 * the user visits issuing fetch()/form POSTs to http://localhost:PORT/... . CORS
 * hides the *response* but does NOT stop the *request* from executing, so a
 * destructive POST (e.g. /api/admin/database/reset) could still fire. This guard
 * rejects cross-site state-changing requests.
 *
 * Strategy (zero-config, no tokens/cookies needed):
 *   - Safe methods (GET/HEAD/OPTIONS) are never blocked.
 *   - `Sec-Fetch-Site` (sent by all current browsers) is authoritative: allow
 *     `same-origin` and `none` (user-initiated, e.g. typed URL); reject
 *     `same-site` and `cross-site`.
 *   - When `Sec-Fetch-Site` is absent (older browsers / non-browser clients),
 *     fall back to `Origin`: a present Origin must be on the allowlist; an absent
 *     Origin is treated as a non-browser client (curl, server-to-server, the
 *     Electron main process) and allowed.
 */

import { ForbiddenError } from './errorHandler.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * @param {() => (string | string[])} getAllowedOrigins  returns the CORS origin
 *        allowlist ('*' for wildcard, an array, or a single origin string).
 */
export function createCsrfGuard(getAllowedOrigins) {
  /**
   * @param {import('../types/express.js').ExpressRequest} req
   * @param {import('../types/express.js').ExpressResponse} res
   * @param {import('../types/express.js').ExpressNextFunction} next
   */
  return function csrfGuard(req, res, next) {
    if (SAFE_METHODS.has(String(req.method).toUpperCase())) return next();

    const secFetchSite = req.headers['sec-fetch-site'];
    if (typeof secFetchSite === 'string' && secFetchSite.length > 0) {
      if (secFetchSite === 'same-origin' || secFetchSite === 'none') return next();
      return next(new ForbiddenError('Cross-site request blocked'));
    }

    // No Sec-Fetch-Site header: rely on Origin when the client sent one.
    const origin = req.headers.origin;
    if (!origin) return next(); // non-browser client

    const allowed = getAllowedOrigins();
    if (allowed === '*') return next();
    // `origin` is typed string|string[] (the header type in general), but an
    // Origin header is never repeated in practice; a duplicate would fail
    // both branches below exactly as before this cast (array !== any allowed
    // string, and Array.prototype.includes never matches an array element),
    // so this only narrows the type, not the behavior.
    const originValue = /** @type {string} */ (origin);
    const isAllowed = Array.isArray(allowed) ? allowed.includes(originValue) : allowed === originValue;
    if (isAllowed) return next();

    return next(new ForbiddenError('Cross-origin request blocked'));
  };
}
