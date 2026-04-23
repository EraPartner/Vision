/**
 * parseDecimal — safe monetary value parser.
 *
 * Replaces bare parseFloat at monetary boundaries. Handles comma-formatted
 * strings, null/undefined/empty, and non-finite results with a fallback.
 */
export function parseDecimal(
  value: string | number | null | undefined,
  fallback = 0,
): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n =
    typeof value === 'number'
      ? value
      : parseFloat(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}
