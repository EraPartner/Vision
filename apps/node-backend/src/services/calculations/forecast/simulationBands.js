import { quantile } from "./_statistics.js";

/**
 * Summarize path-correlated daily samples without discarding their cumulative
 * distribution. `samples[h][p]` is day h of simulation path p.
 *
 * @param {number[][]} samples
 * @param {string[]} forecastDates
 * @param {number[]} percentiles
 * @returns {{
 *   series: Array<{date: string, value: number}>,
 *   bands: Record<string, Array<{date: string, value: number}>>,
 *   cumulative_bands: Record<string, Array<{date: string, value: number}>>,
 * }}
 */
export function summarizeSimulationPaths(samples, forecastDates, percentiles) {
  const pathCount = samples[0]?.length ?? 0;
  const cumulativeByPath = new Array(pathCount).fill(0);
  const dailyValues = Object.fromEntries(
    percentiles.map((q) => [`p${q}`, new Array(forecastDates.length)]),
  );
  const cumulativeValues = Object.fromEntries(
    percentiles.map((q) => [`p${q}`, new Array(forecastDates.length)]),
  );
  const median = new Array(forecastDates.length);

  for (let h = 0; h < forecastDates.length; h++) {
    const dailySorted = samples[h].slice().sort((a, b) => a - b);
    for (let p = 0; p < pathCount; p++) {
      cumulativeByPath[p] += samples[h][p];
    }
    const cumulativeSorted = cumulativeByPath.slice().sort((a, b) => a - b);
    for (const q of percentiles) {
      dailyValues[`p${q}`][h] = quantile(dailySorted, q);
      cumulativeValues[`p${q}`][h] = quantile(cumulativeSorted, q);
    }
    median[h] = quantile(dailySorted, 50);
  }

  const withDates = (values) =>
    Object.fromEntries(
      percentiles.map((q) => [
        `p${q}`,
        forecastDates.map((date, h) => ({ date, value: values[`p${q}`][h] })),
      ]),
    );

  return {
    series: forecastDates.map((date, h) => ({ date, value: median[h] })),
    bands: withDates(dailyValues),
    cumulative_bands: withDates(cumulativeValues),
  };
}
