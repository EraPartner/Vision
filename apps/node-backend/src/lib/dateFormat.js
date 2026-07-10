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
 */
export function formatDateToYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
