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
import { num } from './httpClient.ts';

export { looseString, looseArray, parseOr } from '../../../lib/looseJson.ts';

/**
 * Numeric-ish leaf: providers send numbers as strings ("190.5", "NA", ".").
 * Exact `num()` accept set — null/''/unparseable degrade to undefined.
 * `.optional()` keeps the key optional (a bare transform is a required key
 * in zod v4, which would fail whole responses over an absent field).
 */
export const numish = z.unknown().transform((value) => num(value)).optional();
