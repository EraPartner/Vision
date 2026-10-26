/**
 * `String(value)` for a fixture value of unknown type, without relying on an
 * object's default stringification: primitives and dates convert as `String`
 * would, anything else yields the same `[object X]` tag `String` produces.
 */
export function plainString(value: unknown): string {
  if (value instanceof Date) return value.toString();
  if (Array.isArray(value)) return value.map(plainString).join(",");
  if (typeof value === "object" && value !== null) {
    return Object.prototype.toString.call(value);
  }
  if (typeof value === "function") return Function.prototype.toString.call(value);
  return String(value);
}
