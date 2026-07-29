/**
 * Seasonality bucketing for daily-net history.
 *
 * Buckets history by (day-of-week, day-of-month) with hierarchical fallback
 * for sparse cells: (dow, dom) → (dow) → (overall). Returns per-cell mean
 * and standard deviation used by parametric-MC and Holt-Winters init.
 *
 * Holiday flagging is optional and orthogonal; callers decide whether to
 * overlay a dummy adjustment.
 */

import { isBelgianHoliday } from './holidays/be.js';

const MIN_BUCKET_SAMPLES = 3;

/**
 * @typedef {{ mean: number, variance: number, std: number, n: number }} BucketStats
 * @typedef {{
 *   byDowDom: Map<string, BucketStats>,
 *   byDow: Map<number, BucketStats>,
 *   overall: BucketStats,
 * }} SeasonalityBuckets
 */

/** @param {string} isoDateStr */
export function dayOfWeek(isoDateStr) {
  const [y, m, d] = isoDateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** @param {string} isoDateStr */
export function dayOfMonth(isoDateStr) {
  return Number(isoDateStr.slice(8, 10));
}

/**
 * @param {number[]} values
 * @returns {BucketStats}
 */
function stats(values) {
  const n = values.length;
  if (n === 0) return { mean: 0, variance: 0, std: 0, n: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  const mean = sum / n;
  let sq = 0;
  for (const v of values) {
    const dv = v - mean;
    sq += dv * dv;
  }
  const variance = n > 1 ? sq / (n - 1) : 0;
  return { mean, variance, std: Math.sqrt(variance), n };
}

/**
 * @param {Array<{date: string, net: number}>} history
 * @returns {SeasonalityBuckets}
 */
export function buildSeasonalityBuckets(history) {
  /** @type {Map<string, number[]>} */
  const byDowDom = new Map();
  /** @type {Map<number, number[]>} */
  const byDow = new Map();
  /** @type {number[]} */
  const all = [];

  for (const row of history) {
    const dow = dayOfWeek(row.date);
    const dom = dayOfMonth(row.date);
    const key = `${dow}:${dom}`;
    if (!byDowDom.has(key)) byDowDom.set(key, []);
    /** @type {number[]} */ (byDowDom.get(key)).push(row.net);
    if (!byDow.has(dow)) byDow.set(dow, []);
    /** @type {number[]} */ (byDow.get(dow)).push(row.net);
    all.push(row.net);
  }

  /**
   * @template K
   * @param {Map<K, number[]>} map
   * @returns {Map<K, BucketStats>}
   */
  const finalize = (map) => {
    /** @type {Map<K, BucketStats>} */
    const out = new Map();
    for (const [k, arr] of map) out.set(k, stats(arr));
    return out;
  };

  return {
    byDowDom: finalize(byDowDom),
    byDow: finalize(byDow),
    overall: stats(all),
  };
}

/**
 * Look up bucket stats for a target date with hierarchical fallback.
 *
 * @param {SeasonalityBuckets} buckets
 * @param {string} isoDateStr
 * @returns {BucketStats}
 */
export function lookupBucket(buckets, isoDateStr) {
  const dow = dayOfWeek(isoDateStr);
  const dom = dayOfMonth(isoDateStr);
  const exact = buckets.byDowDom.get(`${dow}:${dom}`);
  if (exact && exact.n >= MIN_BUCKET_SAMPLES) return exact;
  const byDow = buckets.byDow.get(dow);
  if (byDow && byDow.n >= MIN_BUCKET_SAMPLES) return byDow;
  return buckets.overall;
}

export { isBelgianHoliday };

export default { buildSeasonalityBuckets, lookupBucket, dayOfWeek, dayOfMonth, isBelgianHoliday };
