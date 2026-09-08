/**
 * Parametric Monte Carlo per (dow, dom) seasonality bucket.
 * Samples N paths of daily-net for the forecast horizon using bucket
 * mean + std with hierarchical fallback. Returns point estimate = median
 * path, plus P10/P50/P90 bands. Seeded for determinism.
 */

import { buildSeasonalityBuckets, lookupBucket } from "../seasonality.js";
import { makeRng, gaussian } from "../prng.js";
import { summarizeSimulationPaths } from "../simulationBands.js";

export const id = "monte_carlo_parametric";
export const label = "Monte Carlo (parametric)";

const DEFAULT_PATHS = 1000;
const DEFAULT_PERCENTILES = [10, 50, 90];

/**
 * @param {{
 *   history: Array<{date: string, net: number}>,
 *   forecastDates: string[],
 *   paths?: number,
 *   percentiles?: number[],
 *   seed?: number|string,
 * }} ctx
 * @returns {{ series: Array<{date: string, value: number}>, bands: Record<string, Array<{date: string, value: number}>>, cumulative_bands: Record<string, Array<{date: string, value: number}>> }}
 */
function forecast({
  history,
  forecastDates,
  paths = DEFAULT_PATHS,
  percentiles = DEFAULT_PERCENTILES,
  seed = "default",
}) {
  const buckets = buildSeasonalityBuckets(history);
  const rng = makeRng(seed);

  const H = forecastDates.length;
  if (H === 0) return { series: [], bands: {}, cumulative_bands: {} };

  /** @type {number[][]} */
  const samples = Array.from({ length: H }, () => new Array(paths));
  for (let p = 0; p < paths; p++) {
    for (let h = 0; h < H; h++) {
      const bucket = lookupBucket(buckets, forecastDates[h]);
      const std = Number.isFinite(bucket.std) ? bucket.std : 0;
      samples[h][p] = bucket.mean + std * gaussian(rng);
    }
  }

  return summarizeSimulationPaths(samples, forecastDates, percentiles);
}

export { forecast };
