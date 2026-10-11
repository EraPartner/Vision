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

import { isBelgianHoliday } from "./holidays/be.ts";

const MIN_BUCKET_SAMPLES = 3;

export interface BucketStats {
  mean: number;
  variance: number;
  std: number;
  n: number;
}

export interface SeasonalityBuckets {
  byDowDom: Map<string, BucketStats>;
  byDow: Map<number, BucketStats>;
  overall: BucketStats;
}

function dayOfWeek(isoDateStr: string) {
  // A missing part is NaN, as it was when read past the end of the split.
  const [y = NaN, m = NaN, d = NaN] = isoDateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export { dayOfWeek as __dayOfWeek };

export function dayOfMonth(isoDateStr: string) {
  return Number(isoDateStr.slice(8, 10));
}

function stats(values: number[]): BucketStats {
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

export function buildSeasonalityBuckets(
  history: Array<{ date: string; net: number }>,
): SeasonalityBuckets {
  const byDowDom = new Map<string, number[]>();
  const byDow = new Map<number, number[]>();
  const all: number[] = [];

  for (const row of history) {
    const dow = dayOfWeek(row.date);
    const dom = dayOfMonth(row.date);
    const key = `${dow}:${dom}`;
    if (!byDowDom.has(key)) byDowDom.set(key, []);
    byDowDom.get(key)!.push(row.net);
    if (!byDow.has(dow)) byDow.set(dow, []);
    byDow.get(dow)!.push(row.net);
    all.push(row.net);
  }

  const finalize = <K>(map: Map<K, number[]>): Map<K, BucketStats> => {
    const out = new Map<K, BucketStats>();
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
export function lookupBucket(
  buckets: SeasonalityBuckets,
  isoDateStr: string,
): BucketStats {
  const dow = dayOfWeek(isoDateStr);
  const dom = dayOfMonth(isoDateStr);
  const exact = buckets.byDowDom.get(`${dow}:${dom}`);
  if (exact && exact.n >= MIN_BUCKET_SAMPLES) return exact;
  const byDow = buckets.byDow.get(dow);
  if (byDow && byDow.n >= MIN_BUCKET_SAMPLES) return byDow;
  return buckets.overall;
}

export { isBelgianHoliday };

export default {
  buildSeasonalityBuckets,
  lookupBucket,
  dayOfWeek,
  dayOfMonth,
  isBelgianHoliday,
};
