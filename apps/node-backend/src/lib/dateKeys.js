/**
 * Format a year and one-based month as a stable month key.
 *
 * @param {number|string} year
 * @param {number|string} month
 * @returns {string} 'YYYY-MM'
 */
export function formatYearMonthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Return a copy advanced by the requested number of UTC calendar days.
 *
 * @param {Date} date
 * @param {number} [days]
 * @returns {Date}
 */
export function addDaysUtc(date, days = 1) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/**
 * @param {Date} date
 * @returns {string} 'YYYY-MM-DD' (UTC)
 */
export function getDayKeyUtc(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * @param {string|Date} value
 * @returns {string} 'YYYY-MM'
 */
export function extractYearMonth(value) {
  return String(value).substring(0, 7);
}
