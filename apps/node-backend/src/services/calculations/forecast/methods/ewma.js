/**
 * EWMA forecast per day-of-month bucket.
 * For each DOM, run exponential smoothing over the ordered monthly observations
 * with decay α (default 0.15 ⇒ half-life ≈ 4.5 months). The smoothed level at
 * the end of history is the forecast for that DOM.
 */

import { dayOfMonth } from '../seasonality.js';
import { monthKey, orderedMonthKeys } from '../months.js';

export const id = 'ewma';
export const label = 'EWMA';
const DEFAULT_ALPHA = 0.15;

/**
 * @param {{history: Array<{date:string, net:number}>, forecastDates: string[], alpha?: number}} ctx
 * @returns {Array<{date:string, value:number}>}
 */
export function forecast({ history, forecastDates, alpha = DEFAULT_ALPHA }) {
  const monthOrder = orderedMonthKeys(history);

  const series = new Map();
  for (const r of history) {
    const d = dayOfMonth(r.date);
    const mk = monthKey(r.date);
    if (!series.has(d)) series.set(d, new Map());
    series.get(d).set(mk, (series.get(d).get(mk) ?? 0) + r.net);
  }

  const levels = new Map();
  for (const [d, byMonth] of series) {
    /** @type {number|null} */
    let level = null;
    for (const mk of monthOrder) {
      const x = byMonth.get(mk);
      if (x === undefined) continue;
      level = level === null ? x : alpha * x + (1 - alpha) * /** @type {number} */ (level);
    }
    levels.set(d, level ?? 0);
  }

  return forecastDates.map((date) => {
    const d = dayOfMonth(date);
    return { date, value: levels.get(d) ?? 0 };
  });
}
