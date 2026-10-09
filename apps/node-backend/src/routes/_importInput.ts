/**
 * Request-schema helpers shared by the transaction and portfolio import
 * routers and their saved-parser CRUD routes (ADR-193). Requests are parsed
 * with `parseInput` (lib/zodInput.ts).
 */
import { z } from "zod";
import { bareMessages, guardField } from "../lib/zodInput.ts";
import { parseOverrideId } from "../lib/importBatchIds.ts";

/**
 * The optional FK id a review-override body carries: null/absent clears the
 * override, anything else must be a real id (see lib/importBatchIds.ts).
 */
export function overrideIdField(field: string) {
  return guardField((value) => parseOverrideId(value, field));
}

/**
 * A saved-parser `config` body: anything but a plain object is
 * `Missing or invalid "config"`, then `schema` validates and normalizes it.
 */
export function parserConfigBody<S extends z.ZodType>(schema: S) {
  return bareMessages(
    z
      .unknown()
      .refine(
        (value) =>
          !!value && typeof value === "object" && !Array.isArray(value),
        { error: 'Missing or invalid "config"', abort: true },
      )
      .pipe(schema),
  );
}
