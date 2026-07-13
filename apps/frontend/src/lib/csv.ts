/**
 * CSV utilities — escape + formula-injection guard. The implementation is
 * single-sourced in @vision/shared-utils/csv (SIMP-10); this module is the
 * frontend entry point for CSV composed client-side before handing it to a
 * Blob/download.
 *
 * Divergence from the backend escaper: here the cell value is typed, so numbers
 * and booleans pass through verbatim and only *string* cells — the actual
 * injection vector — are neutralised (treatNumericStringsAsSafe left at its
 * default of false). The backend export path passes true so pg-NUMERIC strings
 * survive a round-trip.
 */
import {
  neutralizeCsvFormula,
  escapeCsvValue as sharedEscapeCsvValue,
} from "@vision/shared-utils/csv";

export { neutralizeCsvFormula };

export function escapeCsvValue(
  value: string | number | boolean | null | undefined,
): string {
  return sharedEscapeCsvValue(value);
}
