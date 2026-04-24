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

export function dayOfWeek(isoDateStr) {
  const [y, m, d] = isoDateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function dayOfMonth(isoDateStr) {
  return Number(isoDateStr.slice(8, 10));
}

function stats(values) {
  const n = values.length;
  if (n === 0) return { mean: 0, variance: 0, std: 0, n: 0 };
  let sum = 0;
  for (const v of values) sum += v;
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
 * @returns {{
 *   byDowDom: Map<string, {mean, variance, std, n}>,
 *   byDow: Map<number, {mean, variance, std, n}>,
 *   overall: {mean, variance, std, n}
 * }}
 */
export function buildSeasonalityBuckets(history) {
  const byDowDom = new Map();
  const byDow = new Map();
  const all = [];

  for (const row of history) {
    const dow = dayOfWeek(row.date);
    const dom = dayOfMonth(row.date);
    const key = `${dow}:${dom}`;
    if (!byDowDom.has(key)) byDowDom.set(key, []);
    byDowDom.get(key).push(row.net);
    if (!byDow.has(dow)) byDow.set(dow, []);
    byDow.get(dow).push(row.net);
    all.push(row.net);
  }

  const finalize = (map) => {
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
