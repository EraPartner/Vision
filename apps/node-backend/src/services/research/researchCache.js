/**
 * Research cache (ADR-079).
 *
 * In-memory TTL cache for live research data. This — not scheduling — is the
 * primary rate-limit defence: research tolerates staleness, so a hit avoids the
 * outbound call (and the quota spend) entirely. TTLs are keyed by data type
 * (quotes short, fundamentals long). Arbitrary-symbol research data lives here
 * only and is NEVER persisted to asset_price_history.
 */

/** Type-aware TTLs in milliseconds. */
export const TTL_BY_TYPE = Object.freeze({
  search: 10 * 60_000, //        10 min
  quote: 10 * 60_000, //         10 min
  chart: 12 * 60 * 60_000, //    12 h
  fundamentals: 24 * 60 * 60_000, // 24 h
  analyst: 24 * 60 * 60_000, //  24 h
  news: 2 * 60 * 60_000, //      2 h
});

const DEFAULT_TTL = 10 * 60_000;

/**
 * TTL for a research data type.
 * @param {string} dataType
 * @returns {number}
 */
export function ttlForType(dataType) {
  return TTL_BY_TYPE[dataType] ?? DEFAULT_TTL;
}

/**
 * Create a TTL cache. Pure (no timers); inject `now` for tests.
 * @param {{ now?: () => number }} [opts]
 */
export function createResearchCache({ now = () => Date.now() } = {}) {
  /** @type {Map<string, { value: unknown, expiresAt: number }>} */
  const store = new Map();

  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (now() >= entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key, value, ttlMs) {
    store.set(key, { value, expiresAt: now() + ttlMs });
  }

  function sweep() {
    const t = now();
    for (const [key, entry] of store) {
      if (t >= entry.expiresAt) store.delete(key);
    }
  }

  return { get, set, sweep, size: () => store.size };
}

/** Process-wide singleton used by the aggregator. */
export const researchCache = createResearchCache();

// Periodic sweep to bound Map growth (mirrors the price cache's 5-min sweep).
// unref so it never holds the process (or a test runner) open.
if (typeof setInterval === 'function') {
  const handle = setInterval(() => researchCache.sweep(), 5 * 60_000);
  if (handle && typeof handle.unref === 'function') handle.unref();
}
