/**
 * Simple in-memory rate limiter middleware.
 * For production, consider redis-based rate limiting.
 */

import { RateLimitedError } from "./errorHandler.ts";
import settings from "../config/config.ts";
import type {
  ExpressNextFunction,
  ExpressRequest,
  ExpressResponse,
} from "../types/express.ts";

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const requestCounts = new Map<string, RateLimitEntry>();

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

export interface RateLimiterOptions {
  /** Time window in milliseconds (default: 60000). */
  windowMs?: number;
  /** Max requests per window (default: 100). */
  maxRequests?: number;
  /** Prefix for rate limit key (default: 'global'). */
  keyPrefix?: string;
}

/** Rate limiter middleware factory. */
export function rateLimiter({
  windowMs = 60_000,
  maxRequests = 100,
  keyPrefix = "global",
}: RateLimiterOptions = {}) {
  return (
    req: ExpressRequest,
    res: ExpressResponse,
    next: ExpressNextFunction,
  ) => {
    // Dev bypass: skip throttling entirely so hot-reload doesn't trip limits.
    // Gated on an explicit VISION_DEV opt-in (not merely ENVIRONMENT) so an
    // unset/misconfigured env never silently disables rate limiting.
    if (settings.security.devBypass) {
      return next();
    }

    // Keyed by the socket peer. The backend only listens on loopback and no
    // proxy sits in front of it, so forwarding headers are never consulted.
    const ip = req.socket?.remoteAddress || "unknown";
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    let entry = requestCounts.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { count: 0, windowStart: now };
      requestCounts.set(key, entry);
    }

    entry.count++;

    // Set rate limit headers
    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader(
      "X-RateLimit-Remaining",
      Math.max(0, maxRequests - entry.count),
    );
    res.setHeader(
      "X-RateLimit-Reset",
      Math.ceil((entry.windowStart + windowMs) / 1000),
    );

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      res.setHeader("Retry-After", retryAfter);
      return next(
        new RateLimitedError("Too many requests. Please try again later.", {
          details: { retry_after: retryAfter },
        }),
      );
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
  windowMs: settings.rateLimit.globalWindowMs,
  maxRequests: settings.rateLimit.globalMax,
  keyPrefix: "global",
});

/**
 * Rate limiter for admin routes (read-heavy observability hub).
 * Single-user self-hosted app: admin page makes 5-6 parallel GETs on load.
 */
export const adminRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 500,
  keyPrefix: "admin",
});

/**
 * Stricter limiter for destructive/expensive admin mutations (vacuum, reset, probe).
 */
export const adminMutateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  keyPrefix: "admin-mutate",
});

/**
 * Rate limiter for import operations (expensive but single-user).
 */
export const importRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
  keyPrefix: "import",
});

/**
 * Where {@link importRateLimiter} applies: the expensive import operations,
 * multipart uploads spooled to disk and whole-batch commits. Review traffic
 * (preview reads and per-row overrides) stays under the global limiter. Each
 * review edit is a small row update plus a preview refetch, so 20/min across
 * the whole router rejected a quick review session or a group assignment.
 */
export const IMPORT_RATE_LIMITED_PATHS = [
  "/api/import/csv",
  "/api/import/recipients",
  "/api/import/categories",
  "/api/import/batches/:id/commit",
  "/api/portfolio/import/csv",
  "/api/portfolio/import/probe",
  "/api/portfolio/import/batches/:id/commit",
  "/api/portfolio/import/reconciliation/commit",
];

/**
 * Rate limiter for attachment upload/download endpoints.
 */
export const attachmentRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 60,
  keyPrefix: "attachments",
});

/**
 * Permissive limiter for the SPA static-file fallback so that an unauthenticated
 * client cannot loop on index.html. Tuned generously for normal browsing.
 */
export const spaRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 600,
  keyPrefix: "spa",
});

/**
 * Strict limiter for report generation. Each POST runs report aggregation
 * queries and builds a full HTML document; without a cap one client could
 * monopolise the database. 30/min is far above any human's "generate PDF" cadence.
 */
export const reportRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  keyPrefix: "reports",
});

/**
 * Limiter for market-lookup endpoints, which proxy the external Yahoo Finance
 * API. Caps how hard a client can make us hammer the upstream (and how much of
 * its rate budget we burn). Search is debounced client-side; 90/min is ample.
 */
export const marketRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 90,
  keyPrefix: "market",
});

/**
 * Limiter for the investments router. Mostly DB reads, but `refresh-prices`
 * reaches external providers — keep a generous per-client ceiling that still
 * bounds abuse while never tripping normal portfolio browsing.
 */
export const investmentRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 300,
  keyPrefix: "investments",
});

/**
 * Limiter for the aggregations router. GET-heavy (dashboard + statistics fan
 * out many calls per page), but the Monte-Carlo forecast endpoints are real
 * CPU. Set high enough for rapid navigation, low enough to bound a fork-bomb.
 */
export const aggregationRateLimiter = rateLimiter({
  windowMs: 60_000,
  maxRequests: 600,
  keyPrefix: "aggregations",
});
