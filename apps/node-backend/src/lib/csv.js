/**
 * CSV utilities — escape + formula-injection guard.
 *
 * Excel/Sheets auto-execute leading =, +, -, @ as formulas. Tab (\t) and
 * carriage return (\r) are also documented bypass vectors. Prefix with a
 * single quote so the cell renders as a literal string. Apply to any
 * user-controllable field before serialising to CSV.
 */

const DANGEROUS_CSV_FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

export function neutralizeCsvFormula(value) {
  if (!value) return value;
  // Strip only *safe* leading whitespace (space, NBSP) before inspecting the
  // first character. Tab and CR are themselves dangerous prefixes \u2014 trimming
  // them away (as a generic \s trim did) hid a leading "\t=SUM()" from the
  // check entirely. The neutralising quote is then prepended so it is always
  // the literal first character of the returned cell.
  const leading = value.replace(/^[ \u00a0]+/, '');
  if (!leading) return value;
  const firstChar = leading.charAt(0);
  if (!DANGEROUS_CSV_FORMULA_PREFIXES.has(firstChar)) return value;
  return `'${value}`;
}

/**
 * Escape a machine-generated numeric cell (pg NUMERIC strings like "-12.34").
 *
 * Numeric columns are app-produced, never user-controllable, so they must NOT
 * pass through the formula-injection guard: a leading "-" is a legitimate minus
 * sign, and prefixing "'" corrupts the value so a re-imported Vision export
 * NaN-drops every expense row (and nulls negative balances). Still applies the
 * ordinary CSV quoting rules in case a locale decimal ever contains a comma.
 */
export function escapeCsvNumeric(value) {
  if (value == null) return '';
  const stringValue = String(value);
  return (
    stringValue.includes(',') ||
    stringValue.includes('"') ||
    stringValue.includes('\n') ||
    stringValue.includes('\r')
  )
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}

// A strictly numeric cell can't be a spreadsheet formula, so the guard must
// not touch it: a pg-NUMERIC negative like "-12.34" starts with "-", a
// dangerous prefix, and quoting it exports "'-12.34" \u2014 which our own importer
// fails to parse (NaN), silently dropping every expense row on a
// Vision-export round-trip. Detected here rather than flagged by callers so a
// future export column can't reintroduce the bug by forgetting an option.
// (escapeCsvNumeric above is the explicit variant for known-numeric columns;
// this keeps escapeCsvValue numeric-safe for callers that pass mixed cells.)
const STRICT_NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/**
 * @param {unknown} value
 */
export function escapeCsvValue(value) {
  if (value == null) return '';
  const raw = String(value);
  const stringValue =
    typeof value === 'number' || STRICT_NUMERIC_RE.test(raw) ? raw : neutralizeCsvFormula(raw);
  // Quote on \r as well as \n \u2014 a bare CR can split a row for strict parsers.
  return (
    stringValue.includes(',') ||
    stringValue.includes('"') ||
    stringValue.includes('\n') ||
    stringValue.includes('\r')
  )
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}
