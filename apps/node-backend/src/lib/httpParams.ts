import { ValidationError } from "../middleware/errorHandler.ts";

/**
 * Parse a boolean query parameter with one accepted spelling set.
 *
 * Express normally supplies strings, while listener-free handler tests and
 * internal callers sometimes supply primitive values. Absent, empty, or
 * unrecognised values use the caller-owned default. This preserves each
 * endpoint's documented default without letting individual routers invent a
 * different true/false vocabulary.
 */
export function parseBooleanQueryParam(
  raw: unknown,
  defaultValue = false,
): boolean {
  if (raw == null || raw === "") return defaultValue;
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;

  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return defaultValue;
}

/**
 * Read one optional single-valued query parameter. Express's default query
 * parser turns a repeated key (`?a=1&a=2`) into an array and a bracketed key
 * (`?a[b]=1`) into an object; a route that expects one string answers 400
 * instead of passing either shape on to string methods or SQL parameters.
 */
export function optionalQueryString(
  query: Record<string, unknown>,
  name: string,
): string | undefined {
  const raw = query[name];
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  throw new ValidationError(`${name} must be a single value`);
}
