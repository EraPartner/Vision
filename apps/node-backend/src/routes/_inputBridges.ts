/**
 * Zod bridges for the settings, splits, transactions, watchlist and info
 * routers, which parse `req.params`, `req.query` and `req.body` through
 * `parseInput` (lib/zodInput.ts, ADR-193).
 *
 * They wrap the existing value-level guards (lib/validation.ts,
 * lib/pagination.ts, lib/httpParams.ts) so accepted shapes, coercions,
 * fallbacks AND the established 400 texts ("account_id must be a positive
 * integer") stay identical to the hand-rolled parsing they replace.
 */

import { z } from "zod";
import { bareMessages } from "../lib/zodInput.ts";
import { validateId } from "../lib/validation.ts";
import { parseOptionalPagination, parsePagination } from "../lib/pagination.ts";
import { parseBooleanQueryParam } from "../lib/httpParams.ts";

/** A positive int4 id with `validateId`'s accepted shapes (digit string or integer). */
export function idField(field: string) {
  return z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      const result = validateId(value, field);
      if (!result.valid) {
        ctx.addIssue({ code: "custom", message: result.error });
        return z.NEVER;
      }
      return result.value;
    });
}

/** `/:id` route params ("id must be a positive integer" on failure). */
export const idParamsSchema = bareMessages(z.object({ id: idField("id") }));

/**
 * One optional single-valued query parameter — `optionalQueryString`'s rule: a
 * repeated (`?a=1&a=2`) or bracketed (`?a[b]=1`) key is a 400. Wrap the
 * enclosing object in `bareMessages` to keep the `<name> must be a single
 * value` text.
 */
export function singleQueryValue(name: string) {
  return z.string({ error: `${name} must be a single value` }).optional();
}

/** A boolean query flag with `parseBooleanQueryParam`'s lenient vocabulary. */
export function booleanQueryFlag(defaultValue = false) {
  return z
    .unknown()
    .optional()
    .transform((value) => parseBooleanQueryParam(value, defaultValue));
}

/** `limit`/`offset` with `parsePagination`'s clamp-and-fallback rules. */
export function paginationQuery(
  options: Parameters<typeof parsePagination>[1],
) {
  return z
    .looseObject({})
    .transform((query) => parsePagination(query, options));
}

/** Opt-in `limit`/`offset`: `null` when neither is supplied (whole collection). */
export function optionalPaginationQuery(
  options: Parameters<typeof parseOptionalPagination>[1],
) {
  return z
    .looseObject({})
    .transform((query) => parseOptionalPagination(query, options));
}
