/**
 * Render an untyped value as text. Nullish becomes ""; everything else keeps
 * `String()` semantics, so Decimals and other objects with their own
 * `toString` render as before, arrays comma-join and plain objects read
 * "[object Object]" (CSV, workbook and chart-label output stay unchanged).
 */
export function stringifyUnknown(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Date) return String(value);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- deliberate String() semantics for output parity (Decimal.toString, array join)
  if (typeof value === "object") return String(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  )
    return String(value);
  return "";
}
