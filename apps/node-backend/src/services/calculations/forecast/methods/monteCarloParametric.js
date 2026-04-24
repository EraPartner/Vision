/**
 * Parametric Monte Carlo per (dow, dom) seasonality bucket.
 * Samples N paths of daily-net for the forecast horizon using bucket
 * mean + std with hierarchical fallback. Returns point estimate = median
 * path, plus P10/P50/P90 bands. Seeded for determinism.
 */

import { buildSeasonalityBuckets, lookupBucket } from '../seasonality.js';
import { makeRng, gaussian } from '../prng.js';

export const id = 'monte_carlo_parametric';
export const label = 'Monte Carlo (parametric)';

const DEFAULT_PATHS = 1000;
const DEFAULT_PERCENTILES = [10, 50, 90];

function quantile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

export function forecast({
  history,
  forecastDates,
  paths = DEFAULT_PATHS,
  percentiles = DEFAULT_PERCENTILES,
  seed = 'default',
}) {
  const buckets = buildSeasonalityBuckets(history);
  const rng = makeRng(seed);

  const H = forecastDates.length;
  if (H === 0) return { series: [], bands: {} };

  const samples = Array.from({ length: H }, () => new Array(paths));
  for (let p = 0; p < paths; p++) {
    for (let h = 0; h < H; h++) {
      const bucket = lookupBucket(buckets, forecastDates[h]);
      const std = Number.isFinite(bucket.std) ? bucket.std : 0;
      samples[h][p] = bucket.mean + std * gaussian(rng);
    }
  }

  const bands = {};
  for (const q of percentiles) bands[`p${q}`] = new Array(H);
  const median = new Array(H);

  for (let h = 0; h < H; h++) {
    const sorted = samples[h].slice().sort((a, b) => a - b);
    for (const q of percentiles) bands[`p${q}`][h] = quantile(sorted, q);
    median[h] = quantile(sorted, 50);
  }

  const series = forecastDates.map((date, h) => ({ date, value: median[h] }));
  const bandsByDate = {};
  for (const q of percentiles) {
    bandsByDate[`p${q}`] = forecastDates.map((date, h) => ({ date, value: bands[`p${q}`][h] }));
  }

  return { series, bands: bandsByDate };
}

export default { id, label, forecast };
