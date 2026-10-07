/**
 * Format a year and one-based month as a stable month key.
 *
 * @returns 'YYYY-MM'
 */
export function formatYearMonthKey(
  year: number | string,
  month: number | string,
): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Return a copy advanced by the requested number of UTC calendar days.
 */
export function addDaysUtc(date: Date, days = 1): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/**
 * @returns 'YYYY-MM-DD' (UTC)
 */
export function getDayKeyUtc(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * @returns 'YYYY-MM'
 */
export function extractYearMonth(value: string | Date): string {
  return String(value).substring(0, 7);
}
