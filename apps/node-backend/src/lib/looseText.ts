/**
 * Text form of an untyped value (query string, multipart field, JSON body):
 * arrays join with commas as `String(array)` does, plain objects are
 * JSON-encoded instead of collapsing to "[object Object]".
 */
export function looseText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(looseText).join(",");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}
