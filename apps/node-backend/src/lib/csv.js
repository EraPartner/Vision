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
  const trimmed = value.replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '');
  if (!trimmed) return value;
  const firstChar = trimmed.charAt(0);
  if (!DANGEROUS_CSV_FORMULA_PREFIXES.has(firstChar)) return value;
  return `'${value}`;
}

export function escapeCsvValue(value) {
  if (value == null) return '';
  const stringValue = neutralizeCsvFormula(String(value));
  return stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}
