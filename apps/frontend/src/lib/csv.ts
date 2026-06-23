/**
 * CSV utilities — escape + formula-injection guard (frontend mirror of the
 * backend `lib/csv.js`). Use for any CSV composed client-side before handing it
 * to a Blob/download.
 *
 * Divergence from the backend escaper: the backend receives already-stringified
 * values and neutralises every dangerous leading char, which also quote-prefixes
 * legitimate negative numbers (e.g. `-5` -> `'-5`). Here the cell value is typed,
 * so numbers and booleans pass through verbatim and only *string* cells — the
 * actual injection vector — are neutralised. That keeps numeric cells numeric in
 * spreadsheet software while still defusing `=`, `+`, `-`, `@`, tab and CR.
 */

const DANGEROUS_CSV_FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function neutralizeCsvFormula(value: string): string {
  if (!value) return value;
  // Strip only safe leading whitespace (space, NBSP) before inspecting the
  // first character — tab and CR are themselves dangerous prefixes, so trimming
  // them would hide a leading "\t=SUM()" from the check.
  const leading = value.replace(/^[ \u00a0]+/, "");
  if (!leading) return value;
  if (!DANGEROUS_CSV_FORMULA_PREFIXES.has(leading.charAt(0))) return value;
  return `'${value}`;
}

function quoteIfNeeded(value: string): string {
  // Quote on \r as well as \n — a bare CR can split a row for strict parsers.
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function escapeCsvValue(
  value: string | number | boolean | null | undefined,
): string {
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean") {
    return quoteIfNeeded(String(value));
  }
  return quoteIfNeeded(neutralizeCsvFormula(value));
}
