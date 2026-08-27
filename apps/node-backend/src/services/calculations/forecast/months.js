/** @param {string} date */
export function monthKey(date) {
  return date.slice(0, 7);
}

/**
 * Sorted unique month keys represented in a forecast history.
 *
 * @param {Array<{date: string}>} history
 * @returns {string[]}
 */
export function orderedMonthKeys(history) {
  return [...new Set(history.map((row) => monthKey(row.date)))].sort();
}
