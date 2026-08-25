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

import { densifyDailyHistory } from '../_densify.js';

const M1 = 7;
const M2 = 30;
const GRID = [0.05, 0.2, 0.4];

export const id = 'holt_winters';
export const label = 'Holt-Winters';

/**
 * @param {number[]} y
 * @param {number} alpha
 * @param {number} beta
 * @param {number} g1
 * @param {number} g2
 * @returns {{ sse: number, level: number, trend: number, s1: number[], s2: number[], n: number, params?: {alpha: number, beta: number, gamma1: number, gamma2: number} } | null}
 */
function fitRecurrence(y, alpha, beta, g1, g2) {
  const n = y.length;
  if (n < M2 * 2) return null;

  const s1 = new Array(n).fill(0);
  const s2 = new Array(n).fill(0);
  // Initial seasonals: average deviation from mean within each season index.
  const initMean = y.slice(0, M2).reduce((s, v) => s + v, 0) / M2;
  for (let i = 0; i < M1; i++) {
    let cnt = 0;
    let sum = 0;
    for (let k = i; k < M2; k += M1) {
      sum += y[k] - initMean;
      cnt++;
    }
    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    s1[i] = cnt > 0 ? sum / cnt : 0;
  }
  for (let i = 0; i < M2; i++) s2[i] = y[i] - initMean - s1[i % M1];

  let level = initMean;
  let trend = (y[M2 - 1] - y[0]) / M2;
  let sse = 0;
  const fitted = new Array(n).fill(0);

  for (let t = 0; t < n; t++) {
    const s1Lag = t >= M1 ? s1[t - M1] : s1[t];
    const s2Lag = t >= M2 ? s2[t - M2] : s2[t];
    const forecast = level + trend + s1Lag + s2Lag;
    fitted[t] = forecast;
    const err = y[t] - forecast;
    sse += err * err;

    const newLevel = alpha * (y[t] - s1Lag - s2Lag) + (1 - alpha) * (level + trend);
    const newTrend = beta * (newLevel - level) + (1 - beta) * trend;
    s1[t] = g1 * (y[t] - newLevel - s2Lag) + (1 - g1) * s1Lag;
    s2[t] = g2 * (y[t] - newLevel - s1Lag) + (1 - g2) * s2Lag;
    level = newLevel;
    trend = newTrend;
  }

  return { sse, level, trend, s1, s2, n };
}

/**
 * @param {{history: Array<{date: string, net: number}>, forecastDates: string[]}} ctx
 * @returns {Array<{date: string, value: number}>}
 */
export function forecast({ history, forecastDates }) {
  const y = densifyDailyHistory(history).map((r) => r.net);
  if (y.length < M2 * 2) {
    return forecastDates.map((date) => ({ date, value: 0 }));
  }

  /** @type {ReturnType<typeof fitRecurrence>} */
  let best = null;
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
