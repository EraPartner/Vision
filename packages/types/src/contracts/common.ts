import { z } from "zod";

/*
 * Two families of schemas live in this module tree:
 *
 * - Fixture contracts (`z.strictObject`): the exact bodies the MSW test
 *   fixtures must reproduce. An unknown key fails, so a mock cannot drift
 *   silently. Used by the frontend contract tests.
 * - Wire contracts (`z.looseObject`): what the frontend checks at runtime on a
 *   real response. They reuse the fixture field definitions and accept added
 *   fields, so a new backend column does not break a screen. Only the identity
 *   fields a screen cannot render without are required; every other field is
 *   optional but type-checked when present, so a type drift (a NUMERIC string
 *   where a number belongs, a renamed enum value) is caught while a partial
 *   test fixture or a narrower projection still passes.
 */

export const LinkSchema = z.strictObject({ rel: z.string(), href: z.string() });

export const paginatedOf = <T extends z.ZodTypeAny>(item: T) =>
  z.strictObject({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    links: z.array(LinkSchema),
  });

/** `{ items, total }` — the canonical body for unpaginated collection GETs. */
export const collectionSchema = (item: z.ZodTypeAny = z.unknown()) =>
  z.strictObject({
    items: z.array(item),
    total: z.number().int().nonnegative(),
  });

/** Category lists include hypermedia links even when pagination is omitted. */
export const linkedCollectionOf = <T extends z.ZodTypeAny>(item: T) =>
  collectionSchema(item).extend({ links: z.array(LinkSchema) });

// ── Wire contracts ───────────────────────────────────────────────────────────

export const IdSchema = z.number().int().positive();
const CountSchema = z.number().int().nonnegative();

/**
 * A money/NUMERIC figure: a JSON number, or the decimal string node-postgres
 * returns for an unconverted NUMERIC column. Only for fields whose client
 * coerces with `Number(...)` at the fetch boundary.
 */
export const NumericSchema = z.union([
  z.number(),
  z.string().regex(/^-?\d+(\.\d+)?$/),
]);

export const WireLinkSchema = z.looseObject({
  rel: z.string(),
  href: z.string(),
});

/**
 * List body `{ items, total }` plus the pagination fields and `links` when
 * present. Some routes always paginate (`PaginationFields` in openapi.yaml),
 * others only on request (`OptionalPaginationFields`); both pass here.
 */
export const wireListOf = <T extends z.ZodTypeAny>(item: T) =>
  z.looseObject({
    items: z.array(item),
    total: CountSchema,
    limit: z.number().int().positive().optional(),
    offset: CountSchema.optional(),
    links: z.array(WireLinkSchema).optional(),
  });
