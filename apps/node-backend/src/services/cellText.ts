/**
 * Stringification of untyped import cells (CSV/XLSX values, staged raw data).
 *
 * Import adapters receive `unknown` cells: strings from CSV, numbers/Dates from
 * workbooks, occasionally rich objects. The adapters and the identity/hash code
 * depend on `String(cell)`'s exact output, so this spells out each shape rather
 * than calling `String()` on a bare `unknown` (which may hit Object's default
 * "[object Object]" without anyone noticing). The output matches `String()` for
 * every value an import can produce.
 */
import Decimal from "decimal.js";

/** `String(value)` for an untyped cell. */
export function stringifyCell(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
    case "symbol":
    case "undefined":
    case "function":
      return String(value);
    case "object":
      if (value === null) return "null";
      if (
        value instanceof Date ||
        value instanceof Decimal ||
        Buffer.isBuffer(value)
      ) {
        return String(value);
      }
      if (Array.isArray(value)) return value.map(cellText).join(",");
      return "[object Object]";
  }
}

/** `String(value ?? "")`: nullish cells read as the empty string. */
export function cellText(value: unknown): string {
  return value === null || value === undefined ? "" : stringifyCell(value);
}
