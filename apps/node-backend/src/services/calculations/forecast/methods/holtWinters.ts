/**
 * Double-seasonal Holt-Winters (additive) on the full daily-net series.
 * Seasons: weekly (m1 = 7) and monthly (m2 = 30 approx).
 * Recursion (Taylor 2003):
 *   ℓ_t = α(y_t − s1_{t−m1} − s2_{t−m2}) + (1−α)(ℓ_{t−1} + b_{t−1})
 *   b_t = β(ℓ_t − ℓ_{t−1}) + (1−β) b_{t−1}
 *   s1_t = γ1(y_t − ℓ_t − s2_{t−m2}) + (1−γ1) s1_{t−m1}
 *   s2_t = γ2(y_t − ℓ_t − s1_{t−m1}) + (1−γ2) s2_{t−m2}
 *   ŷ_{t+h} = ℓ_t + h·b_t + s1_{t+h−m1·⌈h/m1⌉} + s2_{t+h−m2·⌈h/m2⌉}
 *
 * Params fit via simple grid over (α, β, γ1, γ2) ∈ {0.05, 0.2, 0.4}^4
 * minimizing in-sample SSE. Cheap; converges well enough for forecast display.
 */

import { densifyDailyHistory } from "../_densify.ts";

const M1 = 7;
const M2 = 30;
const GRID = [0.05, 0.2, 0.4];

export const id = "holt_winters";
export const label = "Holt-Winters";

interface HoltWintersFit {
  sse: number;
  level: number;
  trend: number;
  s1: number[];
  s2: number[];
  n: number;
  params?: { alpha: number; beta: number; gamma1: number; gamma2: number };
}

/** Series value at an index the recurrence guarantees is in range. */
function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`holt-winters: index ${index} out of range`);
  }
  return value;
}

function fitRecurrence(
  y: number[],
  alpha: number,
  beta: number,
  g1: number,
  g2: number,
): HoltWintersFit | null {
  const n = y.length;
  if (n < M2 * 2) return null;

  const s1: number[] = new Array(n).fill(0);
  const s2: number[] = new Array(n).fill(0);
  // Initial seasonals: average deviation from mean within each season index.
  const initMean = y.slice(0, M2).reduce((s, v) => s + v, 0) / M2;
  for (let i = 0; i < M1; i++) {
    let cnt = 0;
    let sum = 0;
    for (let k = i; k < M2; k += M1) {
      sum += at(y, k) - initMean;
      cnt++;
    }
    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    s1[i] = cnt > 0 ? sum / cnt : 0;
  }
  for (let i = 0; i < M2; i++) {
    s2[i] = at(y, i) - initMean - at(s1, i % M1);
  }

  let level = initMean;
  let trend = (at(y, M2 - 1) - at(y, 0)) / M2;
  let sse = 0;
  const fitted: number[] = new Array(n).fill(0);

  for (let t = 0; t < n; t++) {
    const s1Lag = at(s1, t >= M1 ? t - M1 : t);
    const s2Lag = at(s2, t >= M2 ? t - M2 : t);
    const yt = at(y, t);
    const forecast = level + trend + s1Lag + s2Lag;
    fitted[t] = forecast;
    const err = yt - forecast;
    sse += err * err;

    const newLevel =
      alpha * (yt - s1Lag - s2Lag) + (1 - alpha) * (level + trend);
    const newTrend = beta * (newLevel - level) + (1 - beta) * trend;
    s1[t] = g1 * (yt - newLevel - s2Lag) + (1 - g1) * s1Lag;
    s2[t] = g2 * (yt - newLevel - s1Lag) + (1 - g2) * s2Lag;
    level = newLevel;
    trend = newTrend;
  }

  return { sse, level, trend, s1, s2, n };
}

function forecast({
  history,
  forecastDates,
}: {
  history: Array<{ date: string; net: number }>;
  forecastDates: string[];
}): Array<{ date: string; value: number }> {
  const y = densifyDailyHistory(history).map((r) => r.net);
  if (y.length < M2 * 2) {
    return forecastDates.map((date) => ({ date, value: 0 }));
  }

  let best: HoltWintersFit | null = null;
  for (const a of GRID) {
    for (const b of GRID) {
      for (const g1 of GRID) {
        for (const g2 of GRID) {
          const fit = fitRecurrence(y, a, b, g1, g2);
          if (fit && (best === null || fit.sse < best.sse)) {
            best = fit;
            best.params = { alpha: a, beta: b, gamma1: g1, gamma2: g2 };
          }
        }
      }
    }
  }
  if (!best) return forecastDates.map((date) => ({ date, value: 0 }));

  const { level, trend, s1, s2, n } = best;
  return forecastDates.map((date, hIdx) => {
    const h = hIdx + 1;
    const s1Idx = n - M1 + ((h - 1) % M1);
    const s2Idx = n - M2 + ((h - 1) % M2);
    const value = level + h * trend + (s1[s1Idx] ?? 0) + (s2[s2Idx] ?? 0);
    return { date, value };
  });
}

export { forecast };
