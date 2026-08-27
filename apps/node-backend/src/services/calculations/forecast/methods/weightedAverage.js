/**
 * Weighted-average forecast with linear recency decay by month-offset.
 * Weight of observation at month-offset k (0 = oldest, K-1 = newest) is
 *   w_k = k + 1, normalized to sum to 1 within each day-of-month bucket.
 * Heavier weight on recent months without the sharper discount of EWMA.
 */

import { dayOfMonth } from '../seasonality.js';
import { monthKey, orderedMonthKeys } from '../months.js';

export const id = 'weighted_avg';
export const label = 'Weighted average';

/**
 * @param {{history: Array<{date:string, net:number}>, forecastDates: string[]}} ctx
 * @returns {Array<{date:string, value:number}>}
 */
export function forecast({ history, forecastDates }) {
  const monthOrder = orderedMonthKeys(history);
  const monthRank = new Map(monthOrder.map((mk, i) => [mk, i]));

  const buckets = new Map();
  for (const r of history) {
    const d = dayOfMonth(r.date);
    const rank = monthRank.get(monthKey(r.date)) ?? 0;
    const w = rank + 1;
    if (!buckets.has(d)) buckets.set(d, { sumW: 0, sumWX: 0 });
    const b = buckets.get(d);
    b.sumW += w;
    b.sumWX += w * r.net;
  }

  return forecastDates.map((date) => {
    const d = dayOfMonth(date);
    const b = buckets.get(d);
    const v = b && b.sumW > 0 ? b.sumWX / b.sumW : 0;
    return { date, value: v };
  });
}
