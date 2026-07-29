/**
 * Simple in-memory rate limiter middleware.
 * For production, consider redis-based rate limiting.
 */

import { RateLimitedError } from './errorHandler.js';
import { getSettings } from '../config/config.js';

const settings = getSettings();

const requestCounts = new Map();

/**
 * Parse a dotted-quad IPv4 string to a uint32, or undefined if not IPv4.
 * @param {string} ip
 * @returns {number|undefined}
 */
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255 || !/^\d+$/.test(part)) return undefined;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

/**
 * Whether `addr` matches an IP or IPv4 CIDR `rule` (e.g. `172.18.0.1` or
 * `172.18.0.0/16`). Non-CIDR rules are matched exactly (works for IPv6 too).
 *
 * @param {string} addr
 * @param {string} rule
 * @returns {boolean}
 */
export function ipMatchesRule(addr, rule) {
  if (!addr || !rule) return false;
  if (addr === rule) return true;
  const slash = rule.indexOf('/');
  if (slash === -1) return false;
  const base = ipv4ToInt(rule.slice(0, slash));
  const bits = Number(rule.slice(slash + 1));
  const target = ipv4ToInt(addr);
  if (base === undefined || target === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = (bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1)) >>> 0;
  return (target & mask) === (base & mask);
}

/**
 * Whether `X-Forwarded-For` from this peer can be trusted to identify the real
 * client. Only honored when the immediate peer matches an explicitly configured
 * `TRUSTED_PROXIES` IP/CIDR. Empty config trusts nothing, so a LAN client can't
 * spoof XFF to mint a fresh rate-limit bucket per request (fail-safe default).
 *
 * @param {string} addr
 * @returns {boolean}
 */
function isTrustedProxyAddr(addr) {
  if (!addr) return false;
  const trusted = settings.security?.trustedProxies || [];
  if (trusted.length === 0) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return trusted.some((rule) => ipMatchesRule(a, rule) || ipMatchesRule(addr, rule));
}

// Clean up old entries every 60 seconds.
// .unref() so the timer does not keep test/CLI processes alive.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of requestCounts) {
    if (now - entry.windowStart > 60_000) {
      requestCounts.delete(key);
    }
  }
}, 60_000).unref();

/**
 * Rate limiter middleware factory.
 * @param {object} [options]
 * @param {number} [options.windowMs] - Time window in milliseconds (default: 60000)
 * @param {number} [options.maxRequests] - Max requests per window (default: 100)
 * @param {string} [options.keyPrefix] - Prefix for rate limit key (default: 'global')
 */
export function rateLimiter({ windowMs = 60_000, maxRequests = 100, keyPrefix = 'global' } = {}) {
  /**
   * @param {import('../types/express.js').ExpressRequest} req
   * @param {import('../types/express.js').ExpressResponse} res
   * @param {import('../types/express.js').ExpressNextFunction} next
   */
  return (req, res, next) => {
    // Dev bypass: skip throttling entirely so hot-reload doesn't trip limits.
    // Gated on an explicit VISION_DEV opt-in (not merely ENVIRONMENT) so an
    // unset/misconfigured env never silently disables rate limiting.
    if (settings.security?.devBypass) {
      return next();
    }

    const remoteAddr = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    // x-forwarded-for is a single comma-joined header in practice (Node/Express
    // fold repeated headers into one string, except set-cookie); typed
    // string|string[] only because that's the general header-value shape.
    const xff = /** @type {string} */ (req.headers?.['x-forwarded-for'] ?? '');
    const forwarded = isTrustedProxyAddr(remoteAddr)
      ? xff.split(',')[0].trim()
      : '';
    const ip = forwarded || remoteAddr || 'unknown';
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    let entry = requestCounts.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { count: 0, windowStart: now };
      requestCounts.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil((entry.windowStart + windowMs) / 1000));

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return next(new RateLimitedError('Too many requests. Please try again later.', {
        details: { retryAfter },
      }));
    }

    next();
  };
}

/**
 * Baseline limiter mounted app-wide on the data plane (`/api`) before any
 * router. A DoS backstop above normal single-user bursts (default 1000/min per
 * IP, configurable via RATE_LIMIT_GLOBAL_MAX); the stricter per-route limiters
 * below sit on top of it for expensive endpoints.
 */
export const globalRateLimiter = rateLimiter({
  windowMs: settings.rateLimit?.globalWindowMs ?? 60_000,
  maxRequests: settings.rateLimit?.globalMax ?? 1000,
  keyPrefix: 'global',
});

/**
 * Rate limiter for admin routes (read-heavy observability hub).
 * Single-user self-hosted app: admin page makes 5-6 parallel GETs on load.
 */
export const adminRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 500, keyPrefix: 'admin' });

/**
 * Stricter limiter for destructive/expensive admin mutations (vacuum, reset, probe).
 */
export const adminMutateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'admin-mutate' });

/**
 * Rate limiter for import operations (expensive but single-user).
 */
export const importRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 20, keyPrefix: 'import' });

/**
 * Rate limiter for attachment upload/download endpoints.
 */
export const attachmentRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 60, keyPrefix: 'attachments' });

/**
 * Permissive limiter for the SPA static-file fallback so that an unauthenticated
 * client cannot loop on index.html. Tuned generously for normal browsing.
 */
export const spaRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 600, keyPrefix: 'spa' });

/**
 * Strict limiter for report generation. Each POST forks a Puppeteer/Chromium
 * render (heavy CPU + memory); without a cap a single client on the LAN can
 * fork-bomb the host. 30/min is far above any human's "generate PDF" cadence.
 */
export const reportRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'reports' });

/**
 * Limiter for market-lookup endpoints, which proxy the external Yahoo Finance
 * API. Caps how hard a client can make us hammer the upstream (and how much of
 * its rate budget we burn). Search is debounced client-side; 90/min is ample.
 */
export const marketRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 90, keyPrefix: 'market' });

/**
 * Limiter for the investments router. Mostly DB reads, but `refresh-prices`
 * reaches external providers — keep a generous per-client ceiling that still
 * bounds abuse while never tripping normal portfolio browsing.
 */
export const investmentRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 300, keyPrefix: 'investments' });

/**
 * Limiter for the aggregations router. GET-heavy (dashboard + statistics fan
 * out many calls per page), but the Monte-Carlo forecast endpoints are real
 * CPU. Set high enough for rapid navigation, low enough to bound a fork-bomb.
 */
export const aggregationRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 600, keyPrefix: 'aggregations' });
