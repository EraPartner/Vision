/**
 * A JavaScript value bound to a jsonb column, as canonical jsonb text
 * (ADR-263). node-postgres sent a string as JSON text and anything else
 * through JSON.stringify; PostgreSQL then stored its canonical jsonb form.
 */
import { canonicalJsonbText } from "./jsonb.ts";

export function canonicalJsonbValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return canonicalJsonbText(value);
  if (value instanceof Uint8Array) return value;
  return canonicalJsonbText(JSON.stringify(value));
}
