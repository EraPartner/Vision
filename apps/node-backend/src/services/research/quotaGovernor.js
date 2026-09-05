/**
 * Quota governor (ADR-079).
 *
 * Per-provider token buckets that keep the research aggregation layer off the
 * free-tier rate limits. Two windows:
 *
 *   - per-minute: in-memory only (cheap, self-healing on restart).
 *   - per-day:    mirrored in memory but backed by a persistent store
 *                 (provider_quota table), because an in-memory-only daily counter
 *                 would reset on restart and let a frequently-restarted backend
 *                 blow a small daily cap (e.g. Alpha Vantage's ~25/day).
 *
 * `canSpend(provider)` is checked before every outbound call; the router moves to
 * the next provider in the capability chain on `false` instead of incurring a 429.
 * `spend(provider)` is called after a successful issue.
 *
 * The store and clock are injected so the governor is unit-testable without a DB
 * or real time. Default limits reflect documented free-tier ceilings; a provider
 * absent from the table (e.g. yahoo, binance) is treated as unmetered here and is
 * governed instead by cache TTLs and providerHealthService.
 */

import { epochMsToUtcYmd } from '../../lib/dateFormat.js';

const ONE_MINUTE_MS = 60_000;

/** Documented free-tier ceilings. Absent provider = unmetered by this governor. */
 const PROVIDER_LIMITS = Object.freeze({
  twelve_data: { perMinute: 8, perDay: 800 },
  finnhub: { perMinute: 60 },
  fmp: { perDay: 250 },
  alpha_vantage: { perMinute: 5, perDay: 25 },
  // Macro vertical (ADR-082). FRED's documented limit is generous and requests
  // are mostly cache-served; Eurostat/DBnomics are keyless and left unmetered.
  fred: { perMinute: 120 },
});

/**
 * UTC day key (YYYY-MM-DD) for a timestamp — the per-day bucket boundary.
 * @param {number} ms
 * @returns {string}
 */
 function dayKeyUtc(ms) {
  return epochMsToUtcYmd(ms);
}

/**
 * @typedef {Object} QuotaStore
 * @property {(provider: string, dayKey: string) => Promise<number>} getDayCount
 * @property {(provider: string, dayKey: string, delta: number) => Promise<void>} addDayCount
 */

/**
 * Create a quota governor.
 *
 * @param {Object} [opts]
 * @param {Record<string, {perMinute?: number, perDay?: number}>} [opts.limits]
 * @param {QuotaStore} [opts.store]  Persistence for per-day counters; omit for in-memory only.
 * @param {() => number} [opts.now]  Clock (ms); injectable for tests.
 * @returns {{ canSpend: (p: string) => Promise<boolean>, spend: (p: string, n?: number) => Promise<void>, snapshot: () => object }}
 */
export function createQuotaGovernor({ limits = PROVIDER_LIMITS, store, now = () => Date.now() } = {}) {
  /** @type {Map<string, {startMs: number, count: number}>} */
  const minuteBuckets = new Map();
  /** @type {Map<string, number>} mirror keyed `${provider}:${dayKey}` */
  const dayMirror = new Map();

  /** @param {string} provider */
  const limitFor = (provider) => limits[provider] ?? {};

  /**
   * @param {string} provider
   * @param {number} t
   */
  function minuteBucket(provider, t) {
    let bucket = minuteBuckets.get(provider);
    if (!bucket || t - bucket.startMs >= ONE_MINUTE_MS) {
      bucket = { startMs: t, count: 0 };
      minuteBuckets.set(provider, bucket);
    }
    return bucket;
  }

  /**
   * @param {string} provider
   * @param {string} dk
   */
  async function dayCount(provider, dk) {
    const key = `${provider}:${dk}`;
    // Evict mirror entries for days other than dk. Without this the map grows one
    // row per (provider, day) forever — a per-day counter that never rolls over is
    // a slow memory leak. O(size); size is at most the metered-provider count for
    // today. Deleting during Map iteration is safe.
    for (const k of dayMirror.keys()) {
      if (k.slice(-10) !== dk) dayMirror.delete(k);
    }
    if (dayMirror.has(key)) return dayMirror.get(key);
    // Degrade to in-memory if the store is unavailable (e.g. provider_quota
    // migration 0042 not yet applied, or Postgres unreachable) — a quota check
    // must never break a research request. Mirrors the accuracyStore fallback.
    let stored = 0;
    if (store) {
      try {
        stored = await store.getDayCount(provider, dk);
      } catch {
        stored = 0;
      }
    }
    dayMirror.set(key, stored);
    return stored;
  }

  /** @param {string} provider */
  async function canSpend(provider) {
    const lim = limitFor(provider);
    if (lim.perMinute == null && lim.perDay == null) return true; // unmetered
    const t = now();
    if (lim.perMinute != null && minuteBucket(provider, t).count >= lim.perMinute) {
      return false;
    }
    if (lim.perDay != null && (await dayCount(provider, dayKeyUtc(t))) >= lim.perDay) {
      return false;
    }
    return true;
  }

  /**
   * @param {string} provider
   * @param {number} [n]
   */
  async function spend(provider, n = 1) {
    const lim = limitFor(provider);
    if (lim.perMinute == null && lim.perDay == null) return; // unmetered: don't track
    const t = now();
    if (lim.perMinute != null) {
      minuteBucket(provider, t).count += n;
    }
    const dk = dayKeyUtc(t);
    const current = await dayCount(provider, dk);
    dayMirror.set(`${provider}:${dk}`, current + n);
    if (store) {
      try {
        await store.addDayCount(provider, dk, n);
      } catch {
        // In-memory mirror still tracks the spend for this process lifetime.
      }
    }
  }

  function snapshot() {
    /** @type {Record<string, number>} */
    const minute = {};
    for (const [provider, b] of minuteBuckets) minute[provider] = b.count;
    /** @type {Record<string, number>} */
    const day = {};
    for (const [key, count] of dayMirror) day[key] = count;
    return { minute, day };
  }

  return { canSpend, spend, snapshot };
}

export { PROVIDER_LIMITS as __PROVIDER_LIMITS, dayKeyUtc as __dayKeyUtc };
