/**
 * Request Metrics Middleware
 *
 * Tracks per-route request counts, error counts, and latency (p50/p95)
 * in a rolling in-memory window. Resets on backend restart.
 *
 * Exposed via GET /api/admin/metrics/requests
 */

import type {
  ExpressNextFunction,
  ExpressRequest,
  ExpressResponse,
} from '../types/express.ts';

const WINDOW_MINUTES = 15;
const BUCKET_MS = 60_000; // 1-minute buckets
const MAX_LATENCY_SAMPLES_PER_BUCKET = 1000; // cap memory; reservoir-sample beyond
const MAX_ROUTE_STORES = 500; // prevent unbounded growth from unmatched/scanned URLs

export interface BucketStore {
  /** key = bucket start timestamp (floored to BUCKET_MS) */
  buckets: Map<number, Bucket>;
}

export interface Bucket {
  count: number;
  errors: number;
  latencies: number[];
  /** total observations seen (reservoir counter; >= latencies.length once capped) */
  sampled: number;
}

export interface RouteMetrics {
  route: string;
  method: string;
  path: string;
  count: number;
  errors: number;
  error_rate: number;
  p50_ms: number | null;
  p95_ms: number | null;
  window_minutes: number;
}

// routeKey = "METHOD /path/pattern"
const stores = new Map<string, BucketStore>();

function bucketKey(now: number): number {
  return Math.floor(now / BUCKET_MS) * BUCKET_MS;
}

function getOrCreateBucket(store: BucketStore, key: number): Bucket {
  let bucket = store.buckets.get(key);
  if (!bucket) {
    bucket = { count: 0, errors: 0, latencies: [], sampled: 0 };
    store.buckets.set(key, bucket);
  }
  return bucket;
}

/**
 * Reservoir sample so unbounded traffic does not balloon memory while keeping
 * percentile estimates statistically representative.
 */
function recordLatency(bucket: Bucket, durationMs: number) {
  bucket.sampled += 1;
  if (bucket.latencies.length < MAX_LATENCY_SAMPLES_PER_BUCKET) {
    bucket.latencies.push(durationMs);
    return;
  }
  const idx = Math.floor(Math.random() * bucket.sampled);
  if (idx < MAX_LATENCY_SAMPLES_PER_BUCKET) {
    bucket.latencies[idx] = durationMs;
  }
}

function evictOldBuckets(store: BucketStore, now: number) {
  const cutoff = now - WINDOW_MINUTES * BUCKET_MS;
  for (const key of store.buckets.keys()) {
    if (key < cutoff) store.buckets.delete(key);
  }
}

function getOrCreateStore(routeKey: string): BucketStore | null {
  let store = stores.get(routeKey);
  if (!store) {
    if (stores.size >= MAX_ROUTE_STORES) return null;
    store = { buckets: new Map() };
    stores.set(routeKey, store);
  }
  return store;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? null;
}

function normalizeRoute(req: ExpressRequest, matchedPath: string | undefined): string {
  // Unmatched routes (no req.route) collapse to a single bucket per method
  // to prevent URL scanners/bots from inflating the stores Map.
  if (!req.route) return `${req.method} <unmatched>`;
  if (matchedPath !== undefined) return `${req.method} ${matchedPath}`;
  const base = req.baseUrl;
  return `${req.method} ${base}${req.route.path}`;
}

/**
 * Record the full mounted path when the router matches a route. A router
 * restores `req.baseUrl` when an error leaves it for the app-level error
 * handler, so by `finish` a failed `POST /api/admin/database/tables/:table/mutate`
 * would read as `POST /database/tables/:table/mutate`. The router assigns
 * `req.route` while its own `baseUrl` is still set, so capture it then.
 */
function trackMatchedPath(req: ExpressRequest): () => string | undefined {
  let route: unknown = req.route;
  let matchedPath: string | undefined;
  try {
    Object.defineProperty(req, 'route', {
      configurable: true,
      enumerable: true,
      get: () => route,
      set: (next: unknown) => {
        route = next;
        const path = (next as { path?: unknown } | null | undefined)?.path;
        matchedPath =
          typeof path === 'string' ? `${req.baseUrl}${path}` : undefined;
      },
    });
  } catch {
    // A frozen or exotic request object: fall back to reading at finish.
  }
  return () => matchedPath;
}

/**
 * Express middleware — record timing and status after response finishes.
 */
export function requestMetrics(
  req: ExpressRequest,
  res: ExpressResponse,
  next: ExpressNextFunction,
) {
  const startMs = Date.now();
  const matchedPath = trackMatchedPath(req);

  res.on('finish', () => {
    const durationMs = Date.now() - startMs;
    const now = Date.now();
    const routeKey = normalizeRoute(req, matchedPath());
    const store = getOrCreateStore(routeKey);
    if (!store) return;

    evictOldBuckets(store, now);

    const bucket = getOrCreateBucket(store, bucketKey(now));
    bucket.count += 1;
    recordLatency(bucket, durationMs);
    if (res.statusCode >= 400) bucket.errors += 1;
  });

  next();
}

/**
 * Return aggregated metrics for all routes over the rolling window.
 */
export function getMetrics(): RouteMetrics[] {
  const now = Date.now();
  const cutoff = now - WINDOW_MINUTES * BUCKET_MS;
  const results: RouteMetrics[] = [];

  for (const [routeKey, store] of stores.entries()) {
    let count = 0;
    let errors = 0;
    const allLatencies: number[] = [];

    for (const [key, bucket] of store.buckets.entries()) {
      if (key < cutoff) continue;
      count += bucket.count;
      errors += bucket.errors;
      allLatencies.push(...bucket.latencies);
    }

    if (count === 0) continue;

    allLatencies.sort((a, b) => a - b);

    const [method = '', ...pathParts] = routeKey.split(' ');
    results.push({
      route: routeKey,
      method,
      path: pathParts.join(' '),
      count,
      errors,
      error_rate: count > 0 ? Math.round((errors / count) * 10000) / 100 : 0,
      p50_ms: percentile(allLatencies, 50),
      p95_ms: percentile(allLatencies, 95),
      window_minutes: WINDOW_MINUTES,
    });
  }

  return results.sort((a, b) => b.count - a.count);
}

/** Clear all metrics (for testing). */
 function resetMetrics() {
  stores.clear();
}

export { resetMetrics as __resetMetrics };
