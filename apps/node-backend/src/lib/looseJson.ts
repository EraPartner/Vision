/**
 * Tolerant zod helpers for third-party JSON (provider payloads, upstream
 * APIs). Failure paths mirror optional-chain guards: a malformed leaf behaves
 * like a missing field, a malformed row is skipped, and `parseOr` yields the
 * caller's existing fallback instead of throwing.
 */

import { z } from "zod";

/** String leaf that degrades like a missing field when the provider sends a non-string. */
export const looseString = z.string().nullish().catch(undefined);

/**
 * Array of tolerant rows: a non-array degrades to [], rows that fail the row
 * schema (non-objects) are skipped instead of failing the whole response.
 */
export function looseArray<R extends z.ZodType>(rowSchema: R) {
  return z
    .array(rowSchema.nullable().catch(null))
    .catch([])
    .transform((rows) =>
      rows.filter((row): row is NonNullable<typeof row> => row != null),
    );
}

/**
 * `safeParse` returning `fallback` on failure — the adapters' tolerant boundary.
 * (Callers may pass `undefined` as the fallback and truthy-check the result.)
 */
export function parseOr<S extends z.ZodType>(
  schema: S,
  value: unknown,
  fallback: z.output<S>,
): z.output<S>;
export function parseOr<S extends z.ZodType>(
  schema: S,
  value: unknown,
  fallback: undefined,
): z.output<S> | undefined;
export function parseOr<S extends z.ZodType>(
  schema: S,
  value: unknown,
  fallback: null,
): z.output<S> | null;
export function parseOr<S extends z.ZodType>(
  schema: S,
  value: unknown,
  fallback: z.output<S> | null | undefined,
): z.output<S> | null | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : fallback;
}
