import { z } from "zod";

import { IdSchema, WireLinkSchema, wireListOf } from "./common.ts";

/** Fixture contract: the exact `RECIPIENT_STUB` body the MSW tests serve. */
export const RecipientItemSchema = z.strictObject({
  id: z.number().int().positive(),
  name: z.string(),
  normalized_name: z.string(),
  default_category_id: z.number().int().positive().nullable(),
  primary_recipient_id: z.number().int().positive().nullable(),
  notes: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
  links: z.array(z.unknown()),
});

/**
 * Wire contract for an `EnrichedRecipientRow` plus `links: []` (list and detail
 * reads). Required: `id`, `name`.
 */
export const RecipientSchema = z.looseObject({
  ...RecipientItemSchema.partial().shape,
  id: RecipientItemSchema.shape.id,
  name: RecipientItemSchema.shape.name,
  default_category_name: z.string().nullable().optional(),
  primary_bank_account: z.string().nullable().optional(),
  primary_recipient_name: z.string().nullable().optional(),
  alias_count: z.number().int().nonnegative().optional(),
  links: z.array(WireLinkSchema).optional(),
});

/** `GET /api/recipients` (always paginated by the backend). */
export const RecipientListSchema = wireListOf(RecipientSchema);

/** A `recipient_match_patterns` row (`SELECT *`, migration 0015). */
export const RecipientPatternSchema = z.looseObject({
  id: IdSchema,
  pattern: z.string(),
  pattern_kind: z.enum(["literal_prefix", "glob", "regex"]),
  case_sensitive: z.boolean(),
  priority: z.number().int(),
  is_active: z.boolean(),
  source: z.enum(["user", "suggested", "system"]),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** `GET /api/recipients/:id/patterns` — `{ items, total }`. */
export const RecipientPatternListSchema = wireListOf(RecipientPatternSchema);
