import { quantile } from "./_statistics.ts";

export interface SimulationSummary {
  series: Array<{ date: string; value: number }>;
  bands: Record<string, Array<{ date: string; value: number }>>;
  cumulative_bands: Record<string, Array<{ date: string; value: number }>>;
}

/**
 * Summarize path-correlated daily samples without discarding their cumulative
 * distribution. `samples[h][p]` is day h of simulation path p.
 */
/**
 * Ascending copy of `values`. A typed-array sort is numeric without a
 * comparator callback and several times faster, but it places NaN (and holes,
 * read as NaN) differently, so such samples keep the comparator sort.
 */
function sortedAscending(values: readonly number[]): ArrayLike<number> {
  const typed = Float64Array.from(values);
  for (const value of typed) {
    if (Number.isNaN(value)) return values.slice().sort((a, b) => a - b);
  }
  return typed.sort();
}

export function summarizeSimulationPaths(
  samples: number[][],
  forecastDates: string[],
  percentiles: number[],
): SimulationSummary {
  const pathCount = samples[0]?.length ?? 0;
  const cumulativeByPath: number[] = new Array<number>(pathCount).fill(0);
  const bands = percentiles.map((q) => ({
    key: `p${q}`,
    q,
    daily: new Array<{ date: string; value: number }>(),
    cumulative: new Array<{ date: string; value: number }>(),
  }));
  const series: Array<{ date: string; value: number }> = [];

  forecastDates.forEach((date, h) => {
    const daySamples = samples[h];
    // One sample row per forecast day; a missing row was a TypeError before.
    if (!daySamples)
      throw new TypeError(`Missing simulation samples for forecast day ${h}`);
    const dailySorted = sortedAscending(daySamples);
    for (let p = 0; p < pathCount; p++) {
      // A shorter row adds NaN, exactly as reading past its end did.
      cumulativeByPath[p] = (cumulativeByPath[p] ?? 0) + (daySamples[p] ?? NaN);
    }
    const cumulativeSorted = sortedAscending(cumulativeByPath);
    for (const band of bands) {
      band.daily.push({ date, value: quantile(dailySorted, band.q) });
      band.cumulative.push({ date, value: quantile(cumulativeSorted, band.q) });
    }
    series.push({ date, value: quantile(dailySorted, 50) });
  });

  return {
    series,
    bands: Object.fromEntries(bands.map((band) => [band.key, band.daily])),
    cumulative_bands: Object.fromEntries(
      bands.map((band) => [band.key, band.cumulative]),
    ),
  };
}
