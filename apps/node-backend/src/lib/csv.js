/**
 * CSV utilities — escape + formula-injection guard. The implementation is
 * single-sourced in @vision/shared-utils/csv (SIMP-10). Apply to any
 * user-controllable field before serialising to CSV.
 *
 * The backend export path passes `treatNumericStringsAsSafe: true` so a strictly
 * numeric string (a pg-NUMERIC negative like "-12.34") is left unquoted — quoting
 * it to "'-12.34" would break a Vision-export round-trip. Detected via the option
 * rather than flagged by callers so a future export column can't reintroduce the
 * bug by forgetting it.
 */
import {
  neutralizeCsvFormula,
  escapeCsvValue as sharedEscapeCsvValue,
} from '@vision/shared-utils/csv';

export { neutralizeCsvFormula };

/**
 * @param {unknown} value
 */
export function escapeCsvValue(value) {
  return sharedEscapeCsvValue(value, { treatNumericStringsAsSafe: true });
}
