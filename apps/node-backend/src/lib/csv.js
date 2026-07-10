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
 * @param {unknown} value
 * @param {{ neutralizeFormula?: boolean }} [opts] Set neutralizeFormula:false for
 *   numeric columns. A pg-NUMERIC negative like "-12.34" starts with "-", a
 *   dangerous prefix, so the guard would prepend "'" and export "'-12.34" \u2014 which
 *   our own importer then fails to parse (NaN), silently dropping every expense
 *   row on a Vision-export round-trip. Numbers can't be spreadsheet formulas, so
 *   the guard is unnecessary as well as harmful here.
 */
export function escapeCsvValue(value, { neutralizeFormula = true } = {}) {
  if (value == null) return '';
  const stringValue = neutralizeFormula ? neutralizeCsvFormula(String(value)) : String(value);
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
