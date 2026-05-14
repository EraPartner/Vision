/**
 * Small numeric helpers shared across services.
 */

/**
 * Median of a numeric array. Returns `undefined` for empty / non-array input.
 *
 * @param {number[]} values
 * @returns {number | undefined}
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
