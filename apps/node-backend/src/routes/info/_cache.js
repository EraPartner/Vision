/**
 * Shared TTL caches for /api/info routes.
 * Exposes both cache Map instances + helper functions so sub-routers and
 * the cache-warmer all share the same module-scoped caches.
 */

export const NET_WORTH_CACHE_TTL_MS = 300_000; // 5min
export const PERF_CACHE_TTL_MS = 300_000; // 5min
export const PORTFOLIO_SUMMARY_CACHE_TTL_MS = 60_000; // 1min — realtime-ish
export const MAX_CACHE_ENTRIES = 100;

export const netWorthResponseCache = new Map();
export const perfResponseCache = new Map();
export const portfolioSummaryCache = new Map();

/**
 * Invalidate every cache that depends on portfolio investments or transactions.
 * Call this from controllers after any investment/transaction write so the next
 * request recomputes from fresh DB state. Performance snapshots have their own
 * rebuild lifecycle and are not cleared here.
 */
export function invalidatePortfolioCaches() {
  portfolioSummaryCache.clear();
  netWorthResponseCache.clear();
  perfResponseCache.clear();
}

function pruneExpiredCacheEntries(cache) {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    const hasInflight = Boolean(value?.inflight);
    if (!hasInflight && (value?.expiresAt || 0) <= now) {
      cache.delete(key);
    }
  }
}

function enforceCacheSizeLimit(cache, maxEntries = MAX_CACHE_ENTRIES) {
  if (cache.size <= maxEntries) return;

  const overflow = cache.size - maxEntries;
  const removableKeys = [];
  for (const [key, value] of cache.entries()) {
    if (!value?.inflight) {
      removableKeys.push(key);
    }
    if (removableKeys.length >= overflow) break;
  }

  for (const key of removableKeys) {
    cache.delete(key);
  }
}

function getFreshCachedData(cache, key, { requireData = false } = {}) {
  pruneExpiredCacheEntries(cache);
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt > Date.now() && (!requireData || cached.data)) return cached.data;
  if (!cached.inflight) {
    cache.delete(key);
  }
  return undefined;
}

export function setCachedData(cache, key, data, ttlMs) {
  pruneExpiredCacheEntries(cache);
  cache.set(key, {
    data,
    inflight: undefined,
    expiresAt: Date.now() + ttlMs,
  });
  enforceCacheSizeLimit(cache);
}

function setInflightCache(cache, key, inflight, { keepPreviousData = false } = {}) {
  pruneExpiredCacheEntries(cache);
  const current = cache.get(key);
  cache.set(key, {
    data: keepPreviousData ? current?.data : undefined,
    inflight,
    expiresAt: keepPreviousData ? (current?.expiresAt || 0) : 0,
  });
  enforceCacheSizeLimit(cache);
}

export async function resolveCacheWithInflight(cache, key, { ttlMs, requireData = false, keepPreviousData = false, loader }) {
  const cachedData = getFreshCachedData(cache, key, { requireData });
  if (cachedData !== undefined) {
    return cachedData;
  }

  const cachedEntry = cache.get(key);
  if (cachedEntry?.inflight) {
    return cachedEntry.inflight;
  }

  const inflight = loader()
    .then((data) => {
      setCachedData(cache, key, data, ttlMs);
      return data;
    })
    .catch((error) => {
      const current = cache.get(key);
      if (current?.inflight === inflight) {
        cache.delete(key);
      }
      throw error;
    });

  setInflightCache(cache, key, inflight, { keepPreviousData });
  return inflight;
}
