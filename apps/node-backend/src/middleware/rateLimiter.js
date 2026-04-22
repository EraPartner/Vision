/**
 * Simple in-memory rate limiter middleware.
 * For production, consider redis-based rate limiting.
 */

import { RateLimitedError } from './errorHandler.js';
import { getSettings } from '../config/config.js';

const requestCounts = new Map();

// Clean up old entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of requestCounts) {
    if (now - entry.windowStart > 60_000) {
      requestCounts.delete(key);
    }
  }
}, 60_000);

/**
 * Rate limiter middleware factory.
 * @param {object} options
 * @param {number} options.windowMs - Time window in milliseconds (default: 60000)
 * @param {number} options.maxRequests - Max requests per window (default: 100)
 * @param {string} options.keyPrefix - Prefix for rate limit key (default: 'global')
 */
export function rateLimiter({ windowMs = 60_000, maxRequests = 100, keyPrefix = 'global' } = {}) {
  return (req, res, next) => {
    if (getSettings().isDevelopment()) return next();

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
 * Stricter rate limiter for destructive/admin operations.
 */
export const adminRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 10, keyPrefix: 'admin' });

/**
 * Rate limiter for import operations (expensive).
 */
export const importRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 5, keyPrefix: 'import' });
