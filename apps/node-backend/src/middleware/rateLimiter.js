/**
 * Simple in-memory rate limiter middleware.
 * For production, consider redis-based rate limiting.
 */

import { RateLimitedError } from './errorHandler.js';

const requestCounts = new Map();

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
 * @param {object} options
 * @param {number} options.windowMs - Time window in milliseconds (default: 60000)
 * @param {number} options.maxRequests - Max requests per window (default: 100)
 * @param {string} options.keyPrefix - Prefix for rate limit key (default: 'global')
 */
export function rateLimiter({ windowMs = 60_000, maxRequests = 100, keyPrefix = 'global' } = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
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
