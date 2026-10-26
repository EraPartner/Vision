/**
 * Text for an untyped value (an analysis cell, stored JSON, a provider field)
 * placed in a message or key. Primitives use their usual string form, objects
 * are serialised as JSON instead of "[object Object]", and functions and
 * symbols (never valid JSON values) render as "".
 */
export function valueText(value: unknown): string {
  if (value === undefined || value === null) return String(value);
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return String(value);
  return typeof value === "object" ? JSON.stringify(value) : "";
}
