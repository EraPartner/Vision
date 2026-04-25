/**
 * Request Metrics Middleware
 *
 * Tracks per-route request counts, error counts, and latency (p50/p95)
 * in a rolling in-memory window. Resets on backend restart.
 *
 * Exposed via GET /api/admin/metrics/requests
 */

const WINDOW_MINUTES = 15;
const BUCKET_MS = 60_000; // 1-minute buckets
const MAX_LATENCY_SAMPLES_PER_BUCKET = 1000; // cap memory; reservoir-sample beyond

// Map<routeKey, BucketStore>
// routeKey = "METHOD /path/pattern"
const stores = new Map();

/**
 * @typedef {Object} BucketStore
 * @property {Map<number, Bucket>} buckets  key = bucket start timestamp (floored to BUCKET_MS)
 */

/**
 * @typedef {Object} Bucket
 * @property {number} count
 * @property {number} errors
 * @property {number[]} latencies
 */

function bucketKey(now) {
  return Math.floor(now / BUCKET_MS) * BUCKET_MS;
}

function getOrCreateBucket(store, key) {
  if (!store.buckets.has(key)) {
    store.buckets.set(key, { count: 0, errors: 0, latencies: [], sampled: 0 });
  }
  return store.buckets.get(key);
}

// Reservoir sample so unbounded traffic does not balloon memory while keeping
// percentile estimates statistically representative.
function recordLatency(bucket, durationMs) {
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

function evictOldBuckets(store, now) {
  const cutoff = now - WINDOW_MINUTES * BUCKET_MS;
  for (const key of store.buckets.keys()) {
    if (key < cutoff) store.buckets.delete(key);
  }
}

function getOrCreateStore(routeKey) {
  if (!stores.has(routeKey)) {
    stores.set(routeKey, { buckets: new Map() });
  }
  return stores.get(routeKey);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function normalizeRoute(req) {
  // Prefer matched Express route pattern over raw URL to group :param routes
  const pattern = req.route?.path ?? req.path ?? req.url ?? '/';
  const base = req.baseUrl ?? '';
  return `${req.method} ${base}${pattern}`;
}

/**
 * Express middleware — record timing and status after response finishes.
 * @type {import('express').RequestHandler}
 */
export function requestMetrics(req, res, next) {
  const startMs = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - startMs;
    const now = Date.now();
    const routeKey = normalizeRoute(req);
    const store = getOrCreateStore(routeKey);

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
 * @returns {Object[]}
 */
export function getMetrics() {
  const now = Date.now();
  const cutoff = now - WINDOW_MINUTES * BUCKET_MS;
  const results = [];

  for (const [routeKey, store] of stores.entries()) {
    let count = 0;
    let errors = 0;
    const allLatencies = [];

    for (const [key, bucket] of store.buckets.entries()) {
      if (key < cutoff) continue;
      count += bucket.count;
      errors += bucket.errors;
      allLatencies.push(...bucket.latencies);
    }

    if (count === 0) continue;

    allLatencies.sort((a, b) => a - b);

    const [method, ...pathParts] = routeKey.split(' ');
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
export function resetMetrics() {
  stores.clear();
}
