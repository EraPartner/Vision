/**
 * Shared id parsing for the two import routers (transaction + portfolio): the
 * coerced batch/row route params, and the optional FK id carried in an
 * override request body. Both routers copy-pasted the same guards at ~5 sites
 * each; this is the single source of truth so they cannot drift.
 *
 * The accept set is `validateId`'s, not a second one: this delegates to the
 * middleware validator so there is a single definition of a valid id rather
 * than two kept in step by hand. It used to be a bare `Number()` coercion,
 * which agreed with validateId on the obvious cases ('12abc', '12.5', 0,
 * negatives all rejected) but silently addressed a *different* record on
 * '1e3' (1000), '0x10' (16), '0o17' (15), '0b11' (3) and
 * '9007199254740993' (…992), and also took '+5', ' 12 ' and '12.0'.
 *
 * The one deliberate difference from a plain `validateId` call is the bound.
 * `import_batches.id` / `import_staging_rows.id` (and the portfolio pair) are
 * BIGSERIAL, so validateId's default int4 ceiling would be narrower than the
 * column; MAX_SAFE_ID is the honest limit, since the id crosses the wire as a
 * JSON number (services/importPipeline/stage.js createBatch).
 */

import { z } from "zod";
import { ValidationError } from "../middleware/errorHandler.js";
import { validateId, MAX_SAFE_ID } from "./validation.js";

/**
 * The slice of an Express `Request` these parsers read. Structural, not
 * `import('express').Request` — express ships no type declarations and
 * `@types/express` is not a workspace dependency, so referencing its types
 * resolves to an implicit `any` (TS7016) under `noImplicitAny` (same
 * reasoning as `ExpressResponse` in services/transactionExport.js).
 * @typedef {object} ExpressRequest
 * @property {Record<string, string>} params
 */

const coercedIdSchema = z.unknown().transform((value, ctx) => {
  const result = validateId(value, "id", MAX_SAFE_ID);
  if (!result.valid) {
    ctx.addIssue({ code: "custom", message: "must be a positive integer" });
    return z.NEVER;
  }
  return result.value;
});

/**
 * Parse `req.params.id` as a batch id or throw the canonical 400.
 * @param {ExpressRequest} req
 * @returns {number}
 */
export function parseBatchIdParam(req) {
  const result = coercedIdSchema.safeParse(req.params.id);
  if (!result.success) throw new ValidationError("Invalid batch id");
  return result.data;
}

/**
 * Parse `req.params.{id,rowId}` as a batch/row id pair or throw the canonical 400.
 * @param {ExpressRequest} req
 * @returns {{ batchId: number, rowId: number }}
 */
export function parseBatchRowIdParams(req) {
  const batch = coercedIdSchema.safeParse(req.params.id);
  const row = coercedIdSchema.safeParse(req.params.rowId);
  if (!batch.success || !row.success)
    throw new ValidationError("Invalid batch or row id");
  return { batchId: batch.data, rowId: row.data };
}

/**
 * Parse the optional FK id a review-override body carries (recipient, category,
 * investment). `null`/absent keeps its meaning — clear the override — and a
 * present value must be a real id.
 *
 * The accept set is `validateId`'s, for the same reason the route params use
 * it. The guard here used to be `Number.isInteger(Number(value))`, which
 * rejects `'12abc'` but takes `'1e3'` as 1000, `'0x10'` as 16, `true` as 1 and
 * `[7]` as 7 — so a malformed value did not fail, it pointed the override at a
 * *different* record than the caller named. These are writes on the commit
 * path, so the staging row then committed a transaction attributed to a
 * recipient/category/investment the user never chose. Zero and negatives now
 * reject too; they matched no row and reached Postgres as an FK violation.
 *
 * The referenced columns are all `INTEGER`, so the default `int4` bound
 * applies — unlike the batch/row ids above.
 *
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {number|null}
 */
export function parseOverrideId(value, fieldName) {
  if (value === undefined || value === null) return null;
  const result = validateId(value, fieldName);
  if (!result.valid) {
    throw new ValidationError(
      `${fieldName} must be a positive integer or null`,
    );
  }
  return result.value;
}

export { coercedIdSchema };
