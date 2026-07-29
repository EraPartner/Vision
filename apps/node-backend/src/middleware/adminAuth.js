/**
 * Admin auth middleware.
 *
 * When ADMIN_AUTH_TOKEN is set: enforce a timing-safe Bearer token on every admin
 * request. When unset: admin routes are open — the protection is then the
 * loopback-only host port binding (docker-compose publishes 127.0.0.1:PORT) plus
 * the CSRF guard (see middleware/csrfGuard.js), which together block LAN devices
 * and cross-site browser requests.
 *
 * IMPORTANT: if you publish the port on 0.0.0.0, SET ADMIN_AUTH_TOKEN — without a
 * token there is no per-request identity check.
 *
 * (This previously fell back to an RFC1918 IP allowlist. That was largely
 * redundant with the loopback binding and gave false confidence: it trusted the
 * entire private range and could not stop a browser-CSRF request that originates
 * from loopback. It was replaced by token-or-open + the CSRF guard.)
 */

import { Buffer } from 'buffer';
import { timingSafeEqual } from 'crypto';
import { UnauthorizedError } from './errorHandler.js';

/**
 * @param {string} provided
 * @param {string} configured
 * @returns {boolean}
 */
function safeTokenEquals(provided, configured) {
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(configured), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * True when a bind address only accepts local connections. Used by startup to
 * decide whether running with no ADMIN_AUTH_TOKEN is tolerable: on loopback
 * the OS restricts who can connect; on any other bind there is no
 * per-request identity check at all, so startup refuses instead of warning
 * (unless ADMIN_ALLOW_TOKENLESS_NONLOOPBACK acknowledges an outer layer, e.g.
 * Docker publishing the container port on host loopback only).
 */
/**
 * @param {string|null|undefined} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  // Entire 127.0.0.0/8 block, incl. IPv4-mapped IPv6 (::ffff:127.x.x.x).
  return /^(::ffff:)?127(\.\d{1,3}){3}$/.test(h);
}

/**
 * @param {unknown} authorizationHeader
 * @returns {string|undefined}
 */
export function extractAdminBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return undefined;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}

/**
 * @param {() => string|undefined} getConfiguredToken
 */
export function createAdminAuthMiddleware(getConfiguredToken) {
  /**
   * @param {import('../types/express.js').ExpressRequest} req
   * @param {import('../types/express.js').ExpressResponse} res
   * @param {import('../types/express.js').ExpressNextFunction} next
   */
  return function adminAuthMiddleware(req, res, next) {
    const configuredToken = getConfiguredToken();
    if (!configuredToken) {
      // No token configured → rely on the loopback binding + CSRF guard.
      return next();
    }

    const providedToken = extractAdminBearerToken(req.headers.authorization);
    if (!providedToken || !safeTokenEquals(providedToken, configuredToken)) {
      return next(new UnauthorizedError('Unauthorized'));
    }

    return next();
  };
}
