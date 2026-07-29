/**
 * Stationary block bootstrap Monte Carlo.
 * Detrends daily-net by subtracting seasonality-bucket means, resamples
 * residuals in random-length blocks (geometric with mean L=7) to preserve
 * weekly autocorrelation, then recomposes forecast = bucket mean + residual.
 * Robust when IID assumption fails. Seeded for determinism.
 */

import { buildSeasonalityBuckets, lookupBucket } from '../seasonality.js';
import { makeRng } from '../prng.js';

export const id = 'monte_carlo_block_bootstrap';
export const label = 'Monte Carlo (block bootstrap)';

const DEFAULT_PATHS = 1000;
const DEFAULT_PERCENTILES = [10, 50, 90];
const MEAN_BLOCK_LENGTH = 7;

/**
 * @param {number[]} sortedAsc
 * @param {number} p
 */
function quantile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/**
 * @param {Array<{date: string, net: number}>} history
 * @param {import('../seasonality.js').SeasonalityBuckets} buckets
 */
function computeResiduals(history, buckets) {
  return history.map((r) => {
    const b = lookupBucket(buckets, r.date);
    return r.net - b.mean;
  });
}

/**
 * @param {{
 *   history: Array<{date: string, net: number}>,
 *   forecastDates: string[],
 *   paths?: number,
 *   percentiles?: number[],
 *   seed?: number|string,
 * }} ctx
 * @returns {{ series: Array<{date: string, value: number}>, bands: Record<string, Array<{date: string, value: number}>> }}
 */
export function forecast({
  history,
  forecastDates,
  paths = DEFAULT_PATHS,
  percentiles = DEFAULT_PERCENTILES,
  seed = 'default',
}) {
  const H = forecastDates.length;
  if (H === 0) return { series: [], bands: {} };

  const buckets = buildSeasonalityBuckets(history);
  const residuals = computeResiduals(history, buckets);
  const rng = makeRng(seed);

  if (residuals.length === 0) {
    const series = forecastDates.map((date) => ({ date, value: 0 }));
    /** @type {Record<string, Array<{date: string, value: number}>>} */
    const bands = {};
    for (const q of percentiles) bands[`p${q}`] = forecastDates.map((date) => ({ date, value: 0 }));
    return { series, bands };
  }

  // Stationary bootstrap: block length ~ Geom(1/L), start index ~ Uniform.
  const restartProb = 1 / MEAN_BLOCK_LENGTH;
  const N = residuals.length;
  /** @type {number[][]} */
  const samples = Array.from({ length: H }, () => new Array(paths));

  for (let p = 0; p < paths; p++) {
    let idx = Math.floor(rng() * N);
    for (let h = 0; h < H; h++) {
      if (rng() < restartProb) idx = Math.floor(rng() * N);
      const resid = residuals[idx];
      const bucket = lookupBucket(buckets, forecastDates[h]);
      samples[h][p] = bucket.mean + resid;
      idx = (idx + 1) % N;
    }
  }

  /** @type {Record<string, number[]>} */
  const bands = {};
  for (const q of percentiles) bands[`p${q}`] = forecastDates.map(() => 0);
  const series = new Array(H);

  for (let h = 0; h < H; h++) {
    const sorted = samples[h].slice().sort((a, b) => a - b);
    for (const q of percentiles) bands[`p${q}`][h] = quantile(sorted, q);
    series[h] = { date: forecastDates[h], value: quantile(sorted, 50) };
  }

  /** @type {Record<string, Array<{date: string, value: number}>>} */
  const bandsByDate = {};
  for (const q of percentiles) {
    bandsByDate[`p${q}`] = forecastDates.map((date, h) => ({ date, value: bands[`p${q}`][h] }));
  }

  return { series, bands: bandsByDate };
}
