/**
 * Render an untyped value as text. Nullish becomes "", primitives and dates use
 * their natural string form, and any other object is serialised as JSON (the
 * default `String(object)` would yield "[object Object]").
 */
export function stringifyUnknown(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Date) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  )
    return String(value);
  return "";
}
