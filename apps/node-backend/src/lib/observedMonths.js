import { formatDateToYmd } from './dateFormat.js';

/**
 * Convert a PostgreSQL DATE value to its YYYY-MM key.
 *
 * node-postgres may return DATE as a Date while mocked and projected paths use
 * strings. Keeping this conversion beside the shared denominator rule prevents
 * the two reporting repositories from drifting on either representation.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function monthKeyFromDbDate(value) {
  if (value == null) return null;
  const ymd = value instanceof Date ? formatDateToYmd(value) : String(value).slice(0, 10);
  return /^\d{4}-\d{2}/.test(ymd) ? ymd.slice(0, 7) : null;
}

/**
 * Count elapsed observed months for a historical monthly average.
 *
 * Empty months after the ledger starts are real zero observations. Months
 * before the first in-window transaction are not observations. The result is
 * therefore the inclusive span from ledger start through the last complete
 * month, clamped to the caller's lookback window and to at least one.
 *
 * @param {string|null} ledgerStartMonth YYYY-MM of the first in-window transaction.
 * @param {number} lastCompleteMonthIdx Absolute month index (year * 12 + zero-based month).
 * @param {number} windowMonths Lookback length in months.
 * @returns {number}
 */
export function countObservedMonths(ledgerStartMonth, lastCompleteMonthIdx, windowMonths) {
  if (!ledgerStartMonth) return 1;
  const startIdx = Number(ledgerStartMonth.slice(0, 4)) * 12
    + (Number(ledgerStartMonth.slice(5, 7)) - 1);
  const span = lastCompleteMonthIdx - startIdx + 1;
  return Math.min(windowMonths, Math.max(1, span));
}
