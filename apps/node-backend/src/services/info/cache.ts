/**
 * Shared TTL caches for /api/info routes.
 * Exposes both cache Map instances + helper functions so sub-routers and
 * the cache-warmer all share the same module-scoped caches.
 */

export const NET_WORTH_CACHE_TTL_MS = 300_000; // 5min
export const PERF_CACHE_TTL_MS = 300_000; // 5min
export const PORTFOLIO_SUMMARY_CACHE_TTL_MS = 60_000; // 1min — realtime-ish
export const BANK_BALANCES_CACHE_TTL_MS = 60_000; // 1min — live SQL, short TTL
// Statistics pivots (category/recipient/tag) are all-time live scans that ship
// near-transaction-cardinality intermediate rows per request. They are cleared
// synchronously on every transaction/category/recipient mutation (see
// invalidateStatisticsCaches callers), so the TTL is only a safety net.
export const STATISTICS_CACHE_TTL_MS = 300_000; // 5min safety net
export const MAX_CACHE_ENTRIES = 100;

/**
 * One entry of an /api/info TTL cache.
 *
 * `data` holds the last resolved response, `inflight` the in-progress promise
 * that de-dupes concurrent misses (undefined when settled), and `expiresAt` is
 * an epoch-ms deadline — 0 while a cold miss is in flight.
 *
 * The payload type differs per cache (net-worth response, performance
 * response, portfolio summary, statistics pivots) and these helpers never look
 * inside it, so it is `unknown` rather than a guessed union;
 * {@link resolveCacheWithInflight} hands it back as its loader's type.
 */
export interface InfoCacheEntry {
  data: unknown;
  inflight: Promise<unknown> | undefined;
  expiresAt: number;
}

/**
 * A keyed TTL cache of {@link InfoCacheEntry}. Keys are the request-varying
 * dimension as a string (target currency, or a composed cache key).
 */
export type InfoCache = Map<string, InfoCacheEntry>;

export const netWorthResponseCache: InfoCache = new Map();
export const perfResponseCache: InfoCache = new Map();
export const portfolioSummaryCache: InfoCache = new Map();
export const bankBalancesResponseCache: InfoCache = new Map();
export const statisticsResponseCache: InfoCache = new Map();

/**
 * Invalidate every cache that depends on portfolio investments or transactions.
 * Call this from controllers after any investment/transaction write so the next
 * request recomputes from fresh DB state. Performance snapshots have their own
 * rebuild lifecycle and are not cleared here.
 */
export function invalidatePortfolioCaches(): void {
  portfolioSummaryCache.clear();
  netWorthResponseCache.clear();
  perfResponseCache.clear();
  bankBalancesResponseCache.clear();
}

/**
 * Invalidate the statistics-pivot response cache. Call this synchronously from
 * the transaction / category / recipient mutation funnels (scheduleReconcile,
 * scheduleRefresh, refreshMaterializedViews) so a data or label change is
 * reflected on the next statistics request instead of being masked for the TTL.
 * Kept separate from invalidatePortfolioCaches: these pivots depend on
 * transactions + category/recipient labels, not portfolio holdings.
 */
export function invalidateStatisticsCaches(): void {
  statisticsResponseCache.clear();
}

/**
 * Drop settled entries whose TTL has elapsed. In-flight entries are kept so a
 * concurrent miss can still join them.
 */
function pruneExpiredCacheEntries(cache: InfoCache): void {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    const hasInflight = Boolean(value?.inflight);
    if (!hasInflight && (value?.expiresAt || 0) <= now) {
      cache.delete(key);
    }
  }
}

/**
 * Evict settled entries (insertion order) until the cache is back under
 * `maxEntries`. In-flight entries are never evicted.
 */
function enforceCacheSizeLimit(
  cache: InfoCache,
  maxEntries: number = MAX_CACHE_ENTRIES,
): void {
  if (cache.size <= maxEntries) return;

  const overflow = cache.size - maxEntries;
  const removableKeys: string[] = [];
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

/**
 * Return the cached payload when it is still within its TTL, else undefined
 * (deleting the stale entry unless a refresh is already in flight).
 * `requireData` also rejects a fresh-but-empty entry.
 *
 * @returns the cached payload, or undefined on miss/stale
 */
function getFreshCachedData(
  cache: InfoCache,
  key: string,
  { requireData = false }: { requireData?: boolean } = {},
) {
  pruneExpiredCacheEntries(cache);
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt > Date.now() && (!requireData || cached.data))
    return cached.data;
  if (!cached.inflight) {
    cache.delete(key);
  }
  return undefined;
}

/**
 * Store a resolved payload with a fresh TTL, clearing any inflight marker.
 *
 * @param data the route's response payload — shape varies per cache
 */
export function setCachedData(
  cache: InfoCache,
  key: string,
  data: unknown,
  ttlMs: number,
): void {
  pruneExpiredCacheEntries(cache);
  cache.set(key, {
    data,
    inflight: undefined,
    expiresAt: Date.now() + ttlMs,
  });
  enforceCacheSizeLimit(cache);
}

/**
 * Publish the in-flight promise so concurrent callers join it instead of
 * starting a second load. `keepPreviousData` keeps serving the previous (stale)
 * payload while the refresh runs.
 */
function setInflightCache(
  cache: InfoCache,
  key: string,
  inflight: Promise<unknown>,
  { keepPreviousData = false }: { keepPreviousData?: boolean } = {},
): void {
  pruneExpiredCacheEntries(cache);
  const current = cache.get(key);
  cache.set(key, {
    data: keepPreviousData ? current?.data : undefined,
    inflight,
    expiresAt: keepPreviousData ? current?.expiresAt || 0 : 0,
  });
  enforceCacheSizeLimit(cache);
}

/**
 * Cache-or-load with single-flight de-duplication: serve a fresh entry, else
 * join an in-flight load, else start one (caching the result and evicting the
 * entry on rejection).
 *
 * The payload type is the loader's: a cache is keyed per route, so every entry
 * of one cache holds what that route's loader resolves; these helpers never
 * inspect the value.
 */
export async function resolveCacheWithInflight<T>(
  cache: InfoCache,
  key: string,
  {
    ttlMs,
    requireData = false,
    keepPreviousData = false,
    loader,
  }: {
    ttlMs: number;
    /** treat a fresh-but-empty entry as a miss */
    requireData?: boolean;
    /** keep serving the stale payload while the refresh runs */
    keepPreviousData?: boolean;
    loader: () => Promise<T>;
  },
): Promise<T> {
  // Every entry of one cache holds what that route's loader resolves (see
  // above), so the stored payload is the loader's T.
  const cachedData = getFreshCachedData(cache, key, {
    requireData,
  }) as T | undefined;
  if (cachedData !== undefined) {
    return cachedData;
  }

  const cachedEntry = cache.get(key);
  if (cachedEntry?.inflight) {
    return cachedEntry.inflight as Promise<T>;
  }

  const inflight: Promise<T> = loader()
    .then((data) => {
      setCachedData(cache, key, data, ttlMs);
      return data;
    })
    .catch((error: unknown) => {
      const current = cache.get(key);
      if (current?.inflight === inflight) {
        cache.delete(key);
      }
      throw error;
    });

  setInflightCache(cache, key, inflight, { keepPreviousData });
  return inflight;
}
