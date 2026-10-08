export function monthKey(date: string) {
  return date.slice(0, 7);
}

/**
 * Sorted unique month keys represented in a forecast history.
 */
export function orderedMonthKeys(history: Array<{ date: string }>): string[] {
  return [...new Set(history.map((row) => monthKey(row.date)))].sort();
}
