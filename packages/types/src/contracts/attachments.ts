import { z } from "zod";

import { IdSchema, WireTimestampSchema, wireListOf } from "./common.ts";

/**
 * `formatRow` (repositories/attachmentRepository.ts). `attachments.id` is a
 * BIGSERIAL, so it arrives as its decimal text; `size_bytes` (BIGINT) is
 * converted to a number by the formatter.
 */
export const AttachmentSchema = z.looseObject({
  id: z.string().regex(/^\d+$/),
  transaction_id: IdSchema,
  filename: z.string(),
  stored_path: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  created_at: WireTimestampSchema,
});

/** `GET /api/attachments/transaction/:id`. */
export const AttachmentListSchema = wireListOf(AttachmentSchema);
