/**
 * Canonical date formatters, layer-neutral (lib/) so routes and repositories can
 * share them. There are two, and the distinction is load-bearing:
 *
 * - `formatDateToYmd` (UTC extraction) is for dates that were *constructed* at a
 *   UTC anchor on purpose — e.g. `new Date(Date.UTC(y, m, 1))` month windows, or
 *   an end-of-day `monthAfter - 1ms`. Local extraction would roll those across a
 *   day boundary on a non-UTC server.
 *
 * - `formatPgDateToYmd` (local extraction) is for values node-postgres read out
 *   of a DATE/`date`-typed column: the driver parses `2026-06-01` into a
 *   *server-local-midnight* Date, so `toISOString()` rolls it back a day for any
 *   timezone east of UTC (all of Brussels). Local getters keep the calendar day.
 *
 * Using the wrong one shifts the date ±1 day. When in doubt for a pg column,
 * prefer `to_char(col, 'YYYY-MM-DD')` in SQL so the value never becomes a Date.
 */
export function formatDateToYmd(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Format a pg-read DATE value (server-local-midnight Date) as 'YYYY-MM-DD' using
 * local getters, so the calendar day is preserved instead of rolling back a day
 * via UTC extraction. Mirrors utils/portfolioMath.js `toYmd`.
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatPgDateToYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
