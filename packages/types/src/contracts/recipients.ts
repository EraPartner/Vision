import { z } from "zod";

import {
  IdSchema,
  WireLinkSchema,
  WireTimestampSchema,
  wireCollectionOf,
  wirePageOf,
} from "./common.ts";

/**
 * An `EnrichedRecipientRow` plus `links: []`: `SELECT r.*` with the
 * default-category path, the primary bank account (LEFT JOIN LATERAL), the
 * primary recipient's name and the alias count (`COALESCE(..., 0)`). The list,
 * detail, create, update, merge and unmerge reads all use this projection.
 */
const recipientFields = {
  id: IdSchema,
  name: z.string(),
  normalized_name: z.string(),
  default_category_id: IdSchema.nullable(),
  primary_recipient_id: IdSchema.nullable(),
  notes: z.string().nullable(),
  is_active: z.boolean(),
  created_at: WireTimestampSchema.nullable(),
  updated_at: WireTimestampSchema,
  default_category_name: z.string().nullable(),
  primary_bank_account: z.string().nullable(),
  primary_recipient_name: z.string().nullable(),
  alias_count: z.number().int().nonnegative(),
  links: z.array(WireLinkSchema),
};

/** Fixture contract: the exact `RECIPIENT_STUB` body the MSW tests serve. */
export const RecipientItemSchema = z.strictObject(recipientFields);

/** Wire contract for an enriched recipient (list and detail reads). */
export const RecipientSchema = z.looseObject(recipientFields);

/** `POST /api/recipients`: `withCreateOutcome` adds `created`. */
export const RecipientCreatedSchema = RecipientSchema.extend({
  created: z.boolean(),
});

/** `GET /api/recipients` (always paginated by the backend). */
export const RecipientListSchema = wirePageOf(RecipientSchema);

export const RecipientPatternKindSchema = z.enum([
  "literal_prefix",
  "glob",
  "regex",
]);

/** `POST /api/recipients/:id/merge`. */
export const RecipientMergeResultSchema = z.looseObject({
  primary: RecipientSchema,
  merged_ids: z.array(IdSchema),
  reassigned: z.looseObject({
    transactions: z.number().int().nonnegative(),
    splits: z.number().int().nonnegative(),
    planned: z.number().int().nonnegative(),
    bankAccounts: z.number().int().nonnegative(),
  }),
  aliases: z.array(z.looseObject({ id: IdSchema, name: z.string() })),
  patternSuggestion: z
    .looseObject({
      pattern: z.string(),
      kind: RecipientPatternKindSchema,
      matchCount: z.number().int().nonnegative(),
      confidence: z.enum(["high", "medium", "low"]),
    })
    .nullable(),
});

/**
 * A `recipient_match_patterns` row as `listPatternsForRecipient` selects it
 * (migration 0015; `pattern_kind` and `source` are CHECK-constrained).
 */
export const RecipientPatternSchema = z.looseObject({
  id: IdSchema,
  pattern: z.string(),
  pattern_kind: RecipientPatternKindSchema,
  case_sensitive: z.boolean(),
  priority: z.number().int(),
  is_active: z.boolean(),
  source: z.enum(["user", "suggested", "system"]),
  notes: z.string().nullable(),
  created_at: WireTimestampSchema,
  updated_at: WireTimestampSchema,
});

/** `GET /api/recipients/:id/patterns` — `{ items, total }`. */
export const RecipientPatternListSchema = wireCollectionOf(
  RecipientPatternSchema,
);

/**
 * `POST /api/recipients/:id/patterns/preview` — `previewPatternMatches`;
 * `truncated` only on a `regex` preview.
 */
export const RecipientPatternPreviewSchema = z.looseObject({
  matchCount: z.number().int().nonnegative(),
  recipientIds: z.array(IdSchema),
  truncated: z.boolean().optional(),
});
