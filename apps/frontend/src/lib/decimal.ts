/**
 * parseDecimal — safe monetary value parser.
 *
 * Handles EU (1.234,56) and US (1,234.56) number formats, plus
 * null/undefined/empty, and non-finite results with a fallback.
 */
import { parseLocaleNumber } from '../utils/currency';

export function parseDecimal(
  value: string | number | null | undefined,
  fallback = 0,
): number {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const n = parseLocaleNumber(value);
  return Number.isFinite(n) ? n : fallback;
}
