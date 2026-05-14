/**
 * Simple in-memory rate limiter middleware.
 * For production, consider redis-based rate limiting.
 */

import { RateLimitedError } from './errorHandler.js';
import { getSettings } from '../config/config.js';

const settings = getSettings();

const requestCounts = new Map();

/**
 * Whether `X-Forwarded-For` from this peer can be trusted to identify the
 * real client. Loopback alone is too narrow: in the packaged Docker stack the
 * backend sits behind the bridge gateway, so the peer address is a private
 * (RFC1918) / link-local address. Trusting those lets each client keep its
 * own rate-limit bucket instead of all sharing the gateway's.
 *
 * @param {string} addr
 * @returns {boolean}
 */
function isTrustedProxyAddr(addr) {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  return (
    /^10\./.test(a) ||
    /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^169\.254\./.test(a) ||  // IPv4 link-local
    /^fd/i.test(a) ||         // IPv6 unique-local
    /^fe80:/i.test(a)         // IPv6 link-local
  );
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
  return (req, res, next) => {
    // Dev bypass: skip throttling entirely so hot-reload doesn't trip limits.
    if (settings.isDevelopment()) {
      return next();
    }

    const remoteAddr = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    const forwarded = isTrustedProxyAddr(remoteAddr)
      ? (req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim()
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
