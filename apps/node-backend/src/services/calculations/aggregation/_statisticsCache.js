/**
 * Shared TTL cache wrapper for the all-time statistics pivots
 * (category / recipient-by-year / recipient / tag).
 *
 * These endpoints group by t.date over the whole transactions table and then
 * push two conversion legs per row in JS, producing a near-transaction-cardinality
 * intermediate set on every statistics-page load with no date bound. The exact
 * per-date FX semantics are binding (DECIDED 2026-07-10 — no month-grain
 * pre-aggregation), so this is a pure memoization: same inputs → same output,
 * served from a short-lived process cache, busted synchronously on every
 * transaction/category/recipient mutation via invalidateStatisticsCaches().
 */

import {
  statisticsResponseCache,
  STATISTICS_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from '../../info/cache.js';

/**
 * Stable key fragment for an optional numeric-id array (order-independent).
 * Empty/absent → '' so `[]`, `null`, and `undefined` all share one cache slot.
 * @param {number[]|null|undefined} arr
 * @returns {string}
 */
export function statsKeyPart(arr) {
  if (!arr || arr.length === 0) return '';
  return [...arr].map(Number).sort((a, b) => a - b).join(',');
}

/**
 * Memoize a pivot compute behind the shared statistics cache + inflight dedup.
 * @param {string} key — fully-qualified, collision-free cache key (prefix per endpoint)
 * @param {() => Promise<any>} loader — recomputes the envelope on a miss
 */
export function withStatisticsCache(key, loader) {
  return resolveCacheWithInflight(statisticsResponseCache, key, {
    ttlMs: STATISTICS_CACHE_TTL_MS,
    requireData: true,
    keepPreviousData: true,
    loader,
  });
}
