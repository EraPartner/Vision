import { z } from "zod";

import { IdSchema, WireTimestampSchema, wireListOf } from "./common.ts";

/** A `tags` row (`SELECT * FROM tags`, migration 0031: every column NOT NULL but `color`). */
export const TagSchema = z.looseObject({
  id: IdSchema,
  slug: z.string(),
  color: z.string().nullable(),
  is_active: z.boolean(),
  created_at: WireTimestampSchema,
  updated_at: WireTimestampSchema,
});

/** `GET /api/tags`: `{items, total, links}` plus `limit`/`offset` when paginated. */
export const TagListSchema = wireListOf(TagSchema);
