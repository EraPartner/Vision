import { epochMsToUtcYmd as toIso } from '../../../lib/dateFormat.js';

/**
 * Densify a daily {date, net} history: fill every calendar date from the first
 * observed date through `endIso` with net 0 where there's no transaction.
 *
 * The point methods bucket by day-of-month and previously divided by the number
 * of days that HAD a transaction, biasing every per-day forecast away from zero
 * (a single −300 looked like the typical spend for that DOM, and EWMA never
 * decayed a stale one-off). Zero-filling centrally lets the methods see a dense
 * grid and need no change. Mirrors holtWinters' internal denseDaily.
 *
 * @param {Array<{date: string, net: number}>} history  sparse daily history
 * @param {string} [endIso]  fill through this YYYY-MM-DD (defaults to last observed)
 * @returns {Array<{date: string, net: number}>}
 */
export function densifyDailyHistory(history, endIso) {
  if (!Array.isArray(history) || history.length === 0) return history;
  const byDate = new Map();
  for (const r of history) byDate.set(r.date, (byDate.get(r.date) ?? 0) + (Number(r.net) || 0));
  const sortedDates = [...byDate.keys()].sort();
  const startIso = sortedDates[0];
  const lastObserved = sortedDates[sortedDates.length - 1];
  const endStr = endIso && endIso >= startIso ? endIso : lastObserved;
  /** @param {string} d */
  const parse = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
  const out = [];
  for (let t = parse(startIso); t <= parse(endStr); t += 86_400_000) {
    const iso = toIso(t);
    out.push({ date: iso, net: byDate.get(iso) ?? 0 });
  }
  return out;
}

export default { densifyDailyHistory };
