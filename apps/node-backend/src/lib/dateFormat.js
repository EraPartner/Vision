/**
 * Canonical date formatter, layer-neutral (lib/) so routes and repositories can
 * share it. formatDateToYmd renders a Date as 'YYYY-MM-DD' using LOCAL getters.
 *
 * pg reads a DATE column as a Date at *local* midnight, so the previous UTC
 * extraction (toISOString) shifted every value back one calendar day on any
 * server east of UTC (Brussels: all day, every day) — despite this file's old
 * doc comment claiming UTC extraction was "correct for pg-read DATE values".
 * Local extraction matches the reference implementation the portfolio code
 * already uses (services/calculations/portfolioMath.js toYmd).
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
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Normalize a date-like database value to its calendar-day wire form.
 * PostgreSQL DATE values arrive as local-midnight Date objects; local getters
 * preserve that day while strings are already safe to truncate.
 *
 * @param {string|Date} value
 * @returns {string}
 */
export function toYmd(value) {
  if (value instanceof Date) return formatDateToYmd(value);
  return String(value).slice(0, 10);
}

/**
 * Normalize a DATE-like value to YYYY-MM-DD. PostgreSQL DATE objects use
 * local calendar getters; strings with a YMD prefix retain that prefix after
 * strict calendar validation; other parseable strings retain the historical
 * local-Date fallback. Invalid and nullish values fail closed as undefined.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function normalizeDateLikeToYmd(value) {
  if (value == null || value === "") return undefined;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : formatDateToYmd(value);
  }
  if (typeof value !== "string") return undefined;

  const stringValue = value.trim();
  if (
    stringValue === "" ||
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(stringValue)
  ) {
    return undefined;
  }
  const prefix = stringValue.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(prefix)) {
    const ms = Date.parse(`${prefix}T00:00:00.000Z`);
    if (
      Number.isFinite(ms) &&
      new Date(ms).toISOString().slice(0, 10) === prefix
    ) {
      return prefix;
    }
    return undefined;
  }

  const parsed = new Date(stringValue);
  return Number.isNaN(parsed.getTime()) ? undefined : formatDateToYmd(parsed);
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
