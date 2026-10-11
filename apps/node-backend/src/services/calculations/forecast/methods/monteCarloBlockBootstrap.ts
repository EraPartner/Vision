/**
 * Stationary block bootstrap Monte Carlo.
 * Detrends daily-net by subtracting seasonality-bucket means, resamples
 * residuals in random-length blocks (geometric with mean L=7) to preserve
 * weekly autocorrelation, then recomposes forecast = bucket mean + residual.
 * Robust when IID assumption fails. Seeded for determinism.
 */

import { buildSeasonalityBuckets, lookupBucket } from "../seasonality.ts";
import type { SeasonalityBuckets } from "../seasonality.ts";
import { makeRng } from "../prng.ts";
import { summarizeSimulationPaths } from "../simulationBands.ts";
import type { SimulationSummary } from "../simulationBands.ts";

export const id = "monte_carlo_block_bootstrap";
export const label = "Monte Carlo (block bootstrap)";

const DEFAULT_PATHS = 1000;
const DEFAULT_PERCENTILES = [10, 50, 90];
const MEAN_BLOCK_LENGTH = 7;

function computeResiduals(
  history: Array<{ date: string; net: number }>,
  buckets: SeasonalityBuckets,
) {
  return history.map((r) => {
    const b = lookupBucket(buckets, r.date);
    return r.net - b.mean;
  });
}

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
  const H = forecastDates.length;
  if (H === 0) return { series: [], bands: {}, cumulative_bands: {} };

  const buckets = buildSeasonalityBuckets(history);
  const residuals = computeResiduals(history, buckets);
  const rng = makeRng(seed);

  if (residuals.length === 0) {
    const series = forecastDates.map((date) => ({ date, value: 0 }));
    const bands: Record<string, Array<{ date: string; value: number }>> = {};
    for (const q of percentiles)
      bands[`p${q}`] = forecastDates.map((date) => ({ date, value: 0 }));
    return { series, bands, cumulative_bands: bands };
  }

  // Stationary bootstrap: block length ~ Geom(1/L), start index ~ Uniform.
  const restartProb = 1 / MEAN_BLOCK_LENGTH;
  const N = residuals.length;
  const rows = forecastDates.map((date) => ({
    date,
    values: new Array<number>(paths),
  }));

  for (let p = 0; p < paths; p++) {
    let idx = Math.floor(rng() * N);
    for (const row of rows) {
      if (rng() < restartProb) idx = Math.floor(rng() * N);
      const resid = residuals[idx];
      // idx stays in [0, N) because rng() is in [0, 1).
      if (resid === undefined) {
        throw new RangeError(`block bootstrap: residual ${idx} out of range`);
      }
      const bucket = lookupBucket(buckets, row.date);
      row.values[p] = bucket.mean + resid;
      idx = (idx + 1) % N;
    }
  }

  const samples = rows.map((row) => row.values);
  return summarizeSimulationPaths(samples, forecastDates, percentiles);
}

export { forecast };
