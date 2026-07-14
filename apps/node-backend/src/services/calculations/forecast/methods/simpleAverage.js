/**
 * Simple-average forecast.
 * Forecast future daily-net = mean of history on matching day-of-month bucket.
 * Preserves parity with the legacy cashflow-comparison average when history
 * window and filters are identical (regression-check target).
 */

import { dayOfMonth } from '../seasonality.js';

export const id = 'simple_avg';
export const label = 'Simple average';

/**
 * @param {{history: Array<{date:string, net:number}>, forecastDates: string[]}} ctx
 * @returns {Array<{date:string, value:number}>}
 */
export function forecast({ history, forecastDates }) {
  const byDom = new Map();
  for (const r of history) {
    const d = dayOfMonth(r.date);
    if (!byDom.has(d)) byDom.set(d, []);
    byDom.get(d).push(r.net);
  }
  const means = new Map();
  for (const [d, arr] of byDom) {
    let s = 0;
    for (const v of arr) s += v;
    means.set(d, s / arr.length);
  }

  return forecastDates.map((date) => {
    const d = dayOfMonth(date);
    const v = means.has(d) ? means.get(d) : 0;
    return { date, value: v };
  });
}
