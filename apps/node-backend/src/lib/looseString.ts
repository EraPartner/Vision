/**
 * String form of an untrusted value, for validation and parsing code that
 * accepts `unknown` input (query params, body fields, DB values).
 *
 * Matches `String(value)` for primitives and arrays (comma-joined, nullish
 * elements empty); any other object reads as its `[object ...]` tag. Unlike
 * `String(value)` it never relies on an object's default stringification
 * implicitly.
 */
export function looseString(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "undefined":
      return "undefined";
    case "symbol":
      return value.toString();
    case "function":
      return "function";
    case "object":
      if (value === null) return "null";
      if (Array.isArray(value)) {
        const elements: unknown[] = value;
        return elements
          .map((element) => (element == null ? "" : looseString(element)))
          .join(",");
      }
      return Object.prototype.toString.call(value);
  }
}
