/**
 * Zod building blocks for route request schemas (ADR-193).
 *
 * Routes parse `req.params`, `req.query` and `req.body` with `parseInput`
 * (lib/zodInput.ts). The pieces here wrap the accept sets the routes already
 * had — `validateId`, `parseBooleanQueryParam`, `parseIntClamped`, the opt-in
 * pagination rule — so moving a route onto zod does not change which inputs it
 * accepts.
 */
import { z } from "zod";
import { MAX_INT32_ID, validateId } from "../lib/validation.ts";
import { parseBooleanQueryParam } from "../lib/httpParams.ts";
import { parseIntClamped } from "../lib/pagination.ts";
import {
  AccountIdSchema,
  CategoryIdSchema,
  InvestmentIdSchema,
  PlannedTransactionIdSchema,
  PortfolioTransactionIdSchema,
  RecipientIdSchema,
  SplitIdSchema,
  TagIdSchema,
  TransactionIdSchema,
} from "@vision/types/brands";

/**
 * A field that may be absent. zod 4 rejects a missing object key even when its
 * schema is `z.unknown()`, so every raw query/body field is declared through
 * this (or `.optional()`), and transforms that supply a default chain off it.
 */
export const optionalValue = z.unknown().optional();

function toId(
  value: unknown,
  ctx: z.RefinementCtx,
  max: number,
): number | undefined {
  const result = validateId(value, "id", max);
  if (result.valid) return result.value;
  ctx.addIssue({ code: "custom", message: "must be a positive integer" });
  return undefined;
}

/**
 * A record id: a plain base-10 digit string or an integer number, 1..max
 * (`validateId`'s accept set). `'1e3'`, `'0x10'`, `'12abc'` and `' 5'` reject.
 * Wrap in `.optional()` when the field may be absent.
 */
export function idSchema(max = MAX_INT32_ID) {
  return z
    .unknown()
    .transform((value, ctx) => toId(value, ctx, max) ?? z.NEVER);
}

/** `{ id }` route params. */
export const idParams = z.object({ id: idSchema() });

/*
 * Entity ids: `idSchema`'s accept set, then the shared branded schema, so a
 * handler holds an `AccountId` (not a bare number) from the parse onwards.
 */
export const accountIdSchema = () => idSchema().pipe(AccountIdSchema);
export const transactionIdSchema = () => idSchema().pipe(TransactionIdSchema);
export const categoryIdSchema = () => idSchema().pipe(CategoryIdSchema);
export const recipientIdSchema = () => idSchema().pipe(RecipientIdSchema);
export const tagIdSchema = () => idSchema().pipe(TagIdSchema);
/** @public */
export const splitIdSchema = () => idSchema().pipe(SplitIdSchema);
/** @public */
export const plannedTransactionIdSchema = () =>
  idSchema().pipe(PlannedTransactionIdSchema);
export const investmentIdSchema = () => idSchema().pipe(InvestmentIdSchema);
/** @public */
export const portfolioTransactionIdSchema = () =>
  idSchema().pipe(PortfolioTransactionIdSchema);

/** `{ id }` params of an account route. */
export const accountIdParams = z.object({ id: accountIdSchema() });
/**
 * `{ id }` params of a transaction route.
 * @public
 */
export const transactionIdParams = z.object({ id: transactionIdSchema() });
/**
 * `{ id }` params of a category route.
 * @public
 */
export const categoryIdParams = z.object({ id: categoryIdSchema() });
/** `{ id }` params of a recipient route. */
export const recipientIdParams = z.object({ id: recipientIdSchema() });
/** `{ id }` params of a tag route. */
export const tagIdParams = z.object({ id: tagIdSchema() });
/**
 * `{ id }` params of an investment route.
 * @public
 */
export const investmentIdParams = z.object({ id: investmentIdSchema() });

/**
 * An optional id filter: absent, `null` and `''` mean "no filter"
 * (`assertOptionalId`'s convention); anything else must be a valid id.
 */
export const optionalIdFilter = optionalValue.transform((value, ctx) =>
  value == null || value === "" ? undefined : toId(value, ctx, MAX_INT32_ID),
);

/**
 * A nullable id in a write body: absent stays absent, `null` keeps its "clear"
 * meaning, and anything else must be a valid id.
 * @public
 */
export const nullableId = z.union([z.null(), idSchema()]).optional();

/** {@link optionalIdFilter} yielding an entity's branded id. */
export function optionalEntityIdFilter<S extends z.ZodType<number, number>>(
  brand: S,
) {
  return optionalIdFilter.pipe(brand.optional());
}

/** {@link nullableId} yielding an entity's branded id. */
export function nullableEntityId<S extends z.ZodType<number, number>>(
  brand: S,
) {
  return z.union([z.null(), idSchema().pipe(brand)]).optional();
}

/**
 * Boolean query flag with the shared spelling set (`true`/`false`/`1`/`0`).
 * Absent, empty or unrecognised values use `defaultValue`, as before.
 */
export function booleanQuery(defaultValue = false) {
  return optionalValue.transform((raw) =>
    parseBooleanQueryParam(raw, defaultValue),
  );
}

/**
 * Integer query knob clamped to `[min, max]`; a missing or unparseable value
 * uses `fallback` (`parseIntClamped`'s rule).
 */
export function clampedIntQuery(options: {
  min?: number;
  max?: number;
  fallback: number;
}) {
  return optionalValue.transform((raw) => parseIntClamped(raw, options));
}

/**
 * One optional single-valued query string. A repeated key (`?a=1&a=2`) or a
 * bracketed key (`?a[b]=1`) is a 400 instead of an array or object reaching
 * string methods or SQL parameters.
 */
export const singleQueryString = z
  .string({ error: "must be a single value" })
  .optional();

/**
 * Raw `limit`/`offset` fields. Routes hand them to `parsePagination` or
 * `parseOptionalPagination` in their schema's transform, so the clamp,
 * fallbacks and the opt-in rule stay those parsers'.
 */
export const pageFields = { limit: optionalValue, offset: optionalValue };

/**
 * `?active=` for the accounts and tags collections: `all` is their documented
 * "no filter" mode (`undefined`); anything else is the shared boolean flag
 * defaulting to `true`.
 */
export const activeOrAllQuery = optionalValue.transform((raw) =>
  raw === "all" ? undefined : parseBooleanQueryParam(raw, true),
);

/**
 * A required, non-empty body string (`!value` was the old presence check, so
 * `''` stays a "missing" 400).
 */
export const requiredString = z
  .string({
    error: (issue) =>
      issue.input === undefined ? "Missing required field" : "must be a string",
  })
  .min(1, "Missing required field");
