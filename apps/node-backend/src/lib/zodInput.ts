/**
 * Shared zod parsing for untrusted HTTP input (ADR-193).
 *
 * Routes parse `req.body`, `req.query` and `req.params` through `parseInput`,
 * so a schema failure always becomes the same 400 `VALIDATION_ERROR` with the
 * issues joined into one message. Internal data checked with zod (stored JSON,
 * model output) should not use this helper: a failure there is a server fault,
 * not a bad request.
 */
import { z } from "zod";
import { ValidationError } from "../middleware/errorHandler.ts";

/**
 * Joins zod issues as `path: message`, or just `message` at the root or when
 * `omitPaths` is set (for schemas whose messages already name the field).
 */
export function formatZodIssues(
  error: z.ZodError,
  separator = "; ",
  omitPaths = false,
): string {
  return error.issues
    .map((issue) =>
      issue.path.length && !omitPaths
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join(separator);
}

export interface ParseInputOptions {
  /** Prepended to the joined issues, e.g. `Invalid settings` -> `Invalid settings: …`. */
  prefix?: string;
  /** Separator between issues (default `"; "`). */
  separator?: string;
  /** Leave out issue paths, for schemas whose custom messages name the field. */
  omitPaths?: boolean;
}

/** Parses `value` with `schema`, throwing a 400 `ValidationError` on failure. */
export function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  { prefix, separator, omitPaths }: ParseInputOptions = {},
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = formatZodIssues(result.error, separator, omitPaths);
    throw new ValidationError(prefix ? `${prefix}: ${issues}` : issues);
  }
  return result.data;
}

/**
 * A field backed by a throwing guard (`assertYmd`, `assertCurrency`, …): the
 * guard's return value is the parsed output and its `ValidationError` message
 * becomes the issue. Any other error is a server fault and propagates.
 *
 * Accepts an absent key (zod 4 rejects one for a bare `z.unknown()`), so the
 * guard decides what "missing" means.
 */
export function guardField<T>(guard: (value: unknown) => T) {
  return z
    .unknown()
    .optional()
    .transform((value, ctx): T => {
      try {
        return guard(value);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        ctx.addIssue({ code: "custom", message: err.message });
        return z.NEVER;
      }
    });
}

/**
 * Re-reports `schema`'s issues by message only. For schemas nested in a larger
 * one whose messages already name their field ("account_id must be a positive
 * integer"), so the 400 text stays the established one instead of gaining an
 * `account_id: ` path prefix. For a whole input, `parseInput`'s `omitPaths`
 * does the same.
 */
export function bareMessages<S extends z.ZodType>(schema: S) {
  return z
    .unknown()
    .optional()
    .transform((value, ctx): z.output<S> => {
      const result = schema.safeParse(value);
      if (result.success) return result.data;
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message });
      }
      return z.NEVER;
    });
}

/**
 * An optional field where null means "not given", as it did before the field
 * was validated: null and absent both parse to `undefined`.
 */
export function nullAsAbsent<S extends z.ZodType>(schema: S) {
  return schema.nullish().transform((value) => value ?? undefined);
}
