/**
 * Tolerant zod helpers for the research provider adapters (ZOD-12).
 *
 * Third-party API JSON is validated at the response boundary with LOOSE
 * schemas whose failure path mirrors the optional-chain guards they replaced:
 * a malformed envelope degrades to the same null/empty fallback, a malformed
 * row is skipped, and a malformed leaf degrades like a missing field. Schema
 * failures must never introduce new throws on these hot paths — the
 * aggregator treats an adapter throw as "provider down" and falls through,
 * so accidental strictness would blank dashboard panels that previously
 * rendered partial data. A provider changing one field must cost at most
 * that field.
 */

import { z } from 'zod';
import { num } from './httpClient.js';

/**
 * Numeric-ish leaf: providers send numbers as strings ("190.5", "NA", ".").
 * Exact `num()` accept set — null/''/unparseable degrade to undefined.
 * `.optional()` keeps the key optional (a bare transform is a required key
 * in zod v4, which would fail whole responses over an absent field).
 */
export const numish = z.unknown().transform((value) => num(value)).optional();

/** String leaf that degrades like a missing field when the provider sends a non-string. */
export const looseString = z.string().nullish().catch(undefined);

/**
 * Array of tolerant rows: a non-array degrades to [], rows that fail the row
 * schema (non-objects) are skipped instead of failing the whole response.
 * @template {z.ZodType} R
 * @param {R} rowSchema
 */
export function looseArray(rowSchema) {
  return z
    .array(rowSchema.catch(null))
    .catch([])
    .transform((rows) => rows.filter((row) => row != null));
}

/**
 * `safeParse` returning `fallback` on failure — the adapters' tolerant boundary.
 * (Callers may pass `undefined` as the fallback and truthy-check the result.)
 * @template {z.ZodType} S
 * @param {S} schema
 * @param {unknown} value
 * @param {z.output<S>} fallback
 * @returns {z.output<S>}
 */
export function parseOr(schema, value, fallback) {
  const result = schema.safeParse(value);
  return result.success ? result.data : fallback;
}
