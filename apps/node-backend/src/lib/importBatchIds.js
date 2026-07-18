/**
 * Shared coerced id schema for the import-batch route params (transaction +
 * portfolio import routers). Both routers copy-pasted the same guard at ~5
 * sites each; this is the single source of truth so they cannot drift.
 *
 * The accept set matches the pre-zod guard exactly: Number() coercion, then
 * Number.isInteger(n) && n > 0 — so '12.0', ' 12 ', and '0x10' coerce, while
 * '12.5', '12abc', 0, and negatives reject. Deliberately NOT
 * z.coerce.number().int().positive(): zod's .int() also rejects unsafe
 * integers (e.g. '1e300'), which the old guard let through to a downstream
 * 404 — that would change the wire from 404 to 400.
 */

import { z } from 'zod';
import { ValidationError } from '../middleware/errorHandler.js';

export const coercedIdSchema = z.unknown().transform((value, ctx) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    ctx.addIssue({ code: 'custom', message: 'must be a positive integer' });
    return z.NEVER;
  }
  return id;
});

/** Parse `req.params.id` as a batch id or throw the canonical 400. */
export function parseBatchIdParam(req) {
  const result = coercedIdSchema.safeParse(req.params.id);
  if (!result.success) throw new ValidationError('Invalid batch id');
  return result.data;
}

/** Parse `req.params.{id,rowId}` as a batch/row id pair or throw the canonical 400. */
export function parseBatchRowIdParams(req) {
  const batch = coercedIdSchema.safeParse(req.params.id);
  const row = coercedIdSchema.safeParse(req.params.rowId);
  if (!batch.success || !row.success) throw new ValidationError('Invalid batch or row id');
  return { batchId: batch.data, rowId: row.data };
}
