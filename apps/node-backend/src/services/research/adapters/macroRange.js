/**
 * Range / period helpers for macro series (ADR-082).
 *
 * Macro data is monthly/quarterly AND lags publication, so a chart range maps to
 * a month lookback anchored on the LAST AVAILABLE observation — never on "now".
 * Anchoring on now would drop a series whose latest point is older than the
 * window (e.g. "6mo" of an index published with a multi-month lag → empty chart).
 * All three adapters fetch the series, then trim client-side via `trimToRange`.
 */

import { makeChartRangeMap } from "@vision/types/chartRanges";

const RANGE_MONTHS = makeChartRangeMap([1, 1, 1, 3, 6, 12, 24, 60, 0]);

/**
 * Keep the last `range` worth of points, measured back from the most recent
 * point (not the wall clock). Points must be sorted ascending by `time`. `max`
 * (or an unknown range) keeps everything.
 * @template {{ time: number }} P
 * @param {P[]} points
 * @param {string} range
 * @returns {P[]}
 */
export function trimToRange(points, range) {
  if (range === "max" || !Array.isArray(points) || points.length === 0)
    return points;
  const months = RANGE_MONTHS[/** @type {keyof typeof RANGE_MONTHS} */ (range)];
  if (!months) return points;
  const lastTime = points[points.length - 1].time;
  const d = new Date(lastTime);
  d.setMonth(d.getMonth() - months);
  const start = d.getTime();
  return points.filter((p) => p.time >= start);
}

/**
 * Parse a statistical period string to epoch ms (UTC, period start). Handles
 * `YYYY`, `YYYY-MM`, `YYYY-Qn`, `YYYY-Sn`, `YYYY-MM-DD`, falling back to
 * `Date.parse`. Returns undefined when unparseable.
 * @param {string} period
 * @returns {number | undefined}
 */
export function periodToMs(period) {
  if (!period) return undefined;
  const s = String(period).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)))
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) return Date.UTC(+m[1], +m[2] - 1, 1);
  if ((m = s.match(/^(\d{4})-?Q([1-4])$/i)))
    return Date.UTC(+m[1], (+m[2] - 1) * 3, 1);
  if ((m = s.match(/^(\d{4})-?S([1-2])$/i)))
    return Date.UTC(+m[1], (+m[2] - 1) * 6, 1);
  if ((m = s.match(/^(\d{4})$/))) return Date.UTC(+m[1], 0, 1);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}
