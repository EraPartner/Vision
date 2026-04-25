/**
 * CSV utilities — escape + formula-injection guard.
 *
 * Excel/Sheets auto-execute leading =, +, -, @ as formulas. Prefix with a
 * single quote so the cell renders as a literal string. Apply to any
 * user-controllable field before serialising to CSV.
 */

const DANGEROUS_CSV_FORMULA_PREFIXES = new Set(['=', '+', '-', '@']);

export function neutralizeCsvFormula(value) {
  if (!value) return value;
  const trimmedStart = value.trimStart();
  if (!trimmedStart) return value;
  const firstChar = trimmedStart.charAt(0);
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
