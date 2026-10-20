/**
 * Parametric Monte Carlo per (dow, dom) seasonality bucket.
 * Samples N paths of daily-net for the forecast horizon using bucket
 * mean + std with hierarchical fallback. Returns point estimate = median
 * path, plus P10/P50/P90 bands. Seeded for determinism.
 */

import { buildSeasonalityBuckets, lookupBucket } from "../seasonality.ts";
import { makeRng, gaussian } from "../prng.ts";
import { summarizeSimulationPaths } from "../simulationBands.ts";
import type { SimulationSummary } from "../simulationBands.ts";

export const id = "monte_carlo_parametric";
export const label = "Monte Carlo (parametric)";

const DEFAULT_PATHS = 1000;
const DEFAULT_PERCENTILES = [10, 50, 90];

function forecast({
  history,
  forecastDates,
  paths = DEFAULT_PATHS,
  percentiles = DEFAULT_PERCENTILES,
  seed = "default",
}: {
  history: Array<{ date: string; net: number }>;
  forecastDates: string[];
  paths?: number;
  percentiles?: number[];
  seed?: number | string;
}): SimulationSummary {
  const buckets = buildSeasonalityBuckets(history);
  const rng = makeRng(seed);

  const H = forecastDates.length;
  if (H === 0) return { series: [], bands: {}, cumulative_bands: {} };

  // The bucket depends only on the date, so look it up once per day rather
  // than once per path.
  const rows = forecastDates.map((date) => {
    const bucket = lookupBucket(buckets, date);
    return {
      mean: bucket.mean,
      std: Number.isFinite(bucket.std) ? bucket.std : 0,
      values: new Array<number>(paths),
    };
  });
  for (let p = 0; p < paths; p++) {
    for (const row of rows) {
      row.values[p] = row.mean + row.std * gaussian(rng);
    }
  }

  const samples = rows.map((row) => row.values);
  return summarizeSimulationPaths(samples, forecastDates, percentiles);
}

export { forecast };
