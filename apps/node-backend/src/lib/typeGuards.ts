/**
 * Runtime narrowing for values that arrive as `unknown` (parsed JSON, driver
 * rows, third-party payloads), so callers check a shape instead of asserting it.
 */

/**
 * Any non-null object, arrays included (`typeof` semantics), readable by key.
 * Reading a missing key yields `undefined`, which `unknown` already covers.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * `Array.isArray` that narrows to `unknown[]` rather than `any[]`, so the
 * elements stay `unknown` until they are checked.
 */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
