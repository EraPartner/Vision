import { z } from "zod";

import {
  IdSchema,
  WireDateSchema,
  WireLinkSchema,
  WireTimestampSchema,
  wireCollectionOf,
} from "./common.ts";

const CountSchema = z.number().int().nonnegative();

/**
 * `buildImportResult` (routes/importRoutes.ts) over a committed import: the
 * 201 body of `POST /api/import/csv` and `/csv/custom`, and the body of
 * `POST /api/import/batches/:id/commit`. `status` is derived from `errors`.
 */
export const ImportCsvResultSchema = z.looseObject({
  total: CountSchema,
  imported: CountSchema,
  duplicates: CountSchema,
  errors: CountSchema,
  batch_id: IdSchema,
  auto_linked_count: CountSchema,
  status: z.string(),
  error_message: z.string().nullable(),
  links: z.array(WireLinkSchema),
});

/** `respondReviewRequired`: the 202 body when rows need review first. */
export const ImportCsvReviewRequiredSchema = z.looseObject({
  batch_id: IdSchema,
  requires_review: z.literal(true),
  match_source_counts: z.record(z.string(), z.number()),
});

/** Either outcome of the two non-streaming CSV import routes. */
export const ImportCsvResponseSchema = z.union([
  ImportCsvReviewRequiredSchema,
  ImportCsvResultSchema,
]);

/** `POST /api/import/recipients` and `/categories` (dataImportService). */
export const SimpleImportResultSchema = z.looseObject({
  total_processed: CountSchema,
  imported: CountSchema,
  skipped: CountSchema,
  errors: CountSchema,
  status: z.string(),
});

/**
 * One `import_batches` row as `listBatches` selects it (migration 0001). `id`
 * and `source_size_bytes` are BIGINT, so node-postgres returns their text.
 */
export const ImportBatchSchema = z.looseObject({
  id: z.string().regex(/^\d+$/),
  adapter_name: z.string(),
  source_filename: z.string().nullable(),
  source_size_bytes: z.string().regex(/^\d+$/).nullable(),
  status: z.string(),
  rows_total: z.number().int(),
  rows_imported: z.number().int(),
  rows_duplicate: z.number().int(),
  rows_error: z.number().int(),
  error_summary: z.string().nullable(),
  started_at: WireTimestampSchema,
  completed_at: WireTimestampSchema.nullable(),
  transactions_remaining: CountSchema,
});

/** `GET /api/import/batches`: always `{items, total, limit, offset}`. */
export const ImportBatchListSchema = z.looseObject({
  items: z.array(ImportBatchSchema),
  total: CountSchema,
  limit: z.number().int().positive(),
  offset: CountSchema,
});

/** `DELETE /api/import/batches/:id` (`rollbackBatch`). */
export const ImportRollbackResultSchema = z.looseObject({
  deleted: CountSchema,
  recipientsRemoved: CountSchema,
});

/**
 * One staging row of the review preview (`getPreviewRows`, migration 0001 plus
 * 0015/0020): BIGSERIAL `id` and NUMERIC `amount` as text, REAL
 * `match_similarity` as a number, `tx_date` via `to_char`.
 */
export const ImportStagingRowSchema = z.looseObject({
  id: z.string().regex(/^\d+$/),
  row_index: z.number().int(),
  recipient_raw: z.string().nullable(),
  amount: z.string().nullable(),
  currency: z.string().nullable(),
  tx_date: WireDateSchema.nullable(),
  memo: z.string().nullable(),
  bank_account: z.string().nullable(),
  match_source: z.string().nullable(),
  match_similarity: z.number().nullable(),
  matched_pattern_id: IdSchema.nullable(),
  user_override_recipient_id: IdSchema.nullable(),
  override_category_id: IdSchema.nullable(),
});

/** `GET /api/import/batches/:id/preview` (`buildImportBatchPreview`). */
export const ImportPreviewSchema = z.looseObject({
  batch_id: IdSchema,
  groups: z.array(
    z.looseObject({
      recipient_id: IdSchema.nullable(),
      recipient_name: z.string().nullable(),
      recipient_default_category_id: IdSchema.nullable(),
      recipient_default_category_label: z.string().nullable(),
      override_category_id: IdSchema.nullable(),
      current_category_id: IdSchema.nullable(),
      current_category_label: z.string().nullable(),
      matched_pattern_id: IdSchema.nullable(),
      matched_pattern_text: z.string().nullable(),
      matched_pattern_kind: z.string().nullable(),
      row_count: CountSchema,
      rows: z.array(ImportStagingRowSchema),
    }),
  ),
  totals: z.record(z.string(), CountSchema),
});

/** `mapRow` (repositories/customParserConfigRepository.ts). */
export const SavedParserConfigSchema = z.looseObject({
  id: IdSchema,
  name: z.string(),
  kind: z.string(),
  config: z.record(z.string(), z.unknown()),
  created_at: WireTimestampSchema,
  updated_at: WireTimestampSchema,
});

/** `GET /api/import/parsers`. */
export const SavedParserConfigListSchema = wireCollectionOf(
  SavedParserConfigSchema,
);
