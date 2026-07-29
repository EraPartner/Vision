/**
 * Canonical date formatter, layer-neutral (lib/) so routes and repositories can
 * share it. formatDateToYmd renders a Date as 'YYYY-MM-DD' using LOCAL getters.
 *
 * pg reads a DATE column as a Date at *local* midnight, so the previous UTC
 * extraction (toISOString) shifted every value back one calendar day on any
 * server east of UTC (Brussels: all day, every day) — despite this file's old
 * doc comment claiming UTC extraction was "correct for pg-read DATE values".
 * Local extraction matches the reference implementation the portfolio code
 * already uses (utils/portfolioMath.js toYmd).
 *
 * Callers must pass pg-read or locally-constructed dates (new Date(y, m, d)).
 * Do NOT pass UTC-constructed values (new Date(Date.UTC(…)) or new Date('YYYY-MM-DD'))
 * — construct locally instead, or the day shifts west of UTC.
 * (For staging dates parsed from CSV adapters use lib/importDates.)
 * @param {Date} date
 * @returns {string}
 */
export function formatDateToYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Epoch-milliseconds → 'YYYY-MM-DD' in UTC. Deliberately named to stay
 * distinct from formatDateToYmd's LOCAL extraction: provider timestamps and
 * UTC-midnight day-grid arithmetic (Date.UTC ± 86_400_000) live on the UTC
 * calendar, so extracting with local getters would shift the day near
 * midnight. Do NOT use this for pg-read DATE values — those are local-midnight
 * Dates and belong to formatDateToYmd.
 * @param {number} ms
 * @returns {string}
 */
export function epochMsToUtcYmd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Null-safe wire formatter for DATE columns. pg reads DATE as a local-midnight
 * Date object; JSON-serializing that raw emits an ISO timestamp of the
 * PREVIOUS day east of UTC. Route/repo emit boundaries pass DATE values
 * through here: Dates become calendar-day strings, strings pass through,
 * null/undefined become null.
 * @param {Date|string|null|undefined} value
 * @returns {string|null}
 */
export function toWireDate(value) {
  if (value instanceof Date) return formatDateToYmd(value);
  return value ?? null;
}
