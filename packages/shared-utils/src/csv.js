/**
 * CSV utilities — escape + formula-injection guard, shared by the frontend
 * (lib/csv.ts) and backend (lib/csv.js) so the two mirrored escapers can no
 * longer drift (SIMP-10).
 *
 * Excel/Sheets auto-execute leading =, +, -, @ as formulas. Tab (\t) and
 * carriage return (\r) are also documented bypass vectors. Prefix such a cell
 * with a single quote so it renders as a literal string.
 */

const DANGEROUS_CSV_FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);
const STRICT_NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/**
 * Neutralise a leading formula character on a string cell.
 * @param {string} value
 * @returns {string}
 */
export function neutralizeCsvFormula(value) {
  if (!value) return value;
  // Strip only *safe* leading whitespace (space, NBSP) before inspecting the
  // first character. Tab and CR are themselves dangerous prefixes — trimming
  // them away would hide a leading "\t=SUM()" from the check entirely.
  const leading = value.replace(/^[  ]+/, '');
  if (!leading) return value;
  if (!DANGEROUS_CSV_FORMULA_PREFIXES.has(leading.charAt(0))) return value;
  return `'${value}`;
}

/**
 * Quote a cell if it contains a delimiter, quote, or line break. Quotes on \r
 * as well as \n — a bare CR can split a row for strict parsers.
 * @param {string} value
 * @returns {string}
 */
export function quoteCsvValue(value) {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Escape a single value for CSV output.
 *
 * When `treatNumericStringsAsSafe` is true (backend export path), a strictly
 * numeric string such as a pg-NUMERIC "-12.34" is treated as a number and left
 * unquoted-prefixed — quoting it to "'-12.34" would break a Vision-export
 * round-trip. When false (frontend), only typed numbers/booleans bypass the
 * guard, so a numeric-looking *string* is still neutralised.
 * @param {unknown} value
 * @param {{ treatNumericStringsAsSafe?: boolean }} [options]
 * @returns {string}
 */
export function escapeCsvValue(value, { treatNumericStringsAsSafe = false } = {}) {
  if (value == null) return '';
  const raw = String(value);
  const isSafeNumeric =
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (treatNumericStringsAsSafe && STRICT_NUMERIC_RE.test(raw));
  return quoteCsvValue(isSafeNumeric ? raw : neutralizeCsvFormula(raw));
}
