import { epochMsToUtcYmd as toIso } from "../../../lib/dateFormat.ts";
import { ymdToEpochDay } from "../../../lib/timezone.ts";

/**
 * Densify a daily {date, net} history: fill every calendar date from the first
 * observed date through `endIso` with net 0 where there's no transaction.
 *
 * The point methods bucket by day-of-month and previously divided by the number
 * of days that HAD a transaction, biasing every per-day forecast away from zero
 * (a single −300 looked like the typical spend for that DOM, and EWMA never
 * decayed a stale one-off). Zero-filling centrally lets the methods see a dense
 * grid and lets every method share the same gap and duplicate-date handling.
 *
 * @param history  sparse daily history
 * @param endIso  fill through this YYYY-MM-DD (defaults to last observed)
 */
export function densifyDailyHistory(
  history: Array<{ date: string; net: number }>,
  endIso?: string,
): Array<{ date: string; net: number }> {
  if (!Array.isArray(history) || history.length === 0) return history;
  const byDate = new Map<string, number>();
  for (const r of history)
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + (Number(r.net) || 0));
  const sortedDates = [...byDate.keys()].sort();
  const startIso = sortedDates[0];
  const lastObserved = sortedDates[sortedDates.length - 1];
  const endStr = endIso && endIso >= startIso ? endIso : lastObserved;
  const out: Array<{ date: string; net: number }> = [];
  const startDay = ymdToEpochDay(startIso);
  const endDay = ymdToEpochDay(endStr);
  for (let day = startDay; day <= endDay; day += 1) {
    const iso = toIso(day * 86_400_000);
    out.push({ date: iso, net: byDate.get(iso) ?? 0 });
  }
  return out;
}

export default { densifyDailyHistory };
