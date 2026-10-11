/**
 * Row schemas for the bank-import repositories and pipeline (ADR-193):
 * import batches, staging rows, saved parser configs, and the recipient and
 * category resolution of the CSV data importer.
 *
 * Each schema describes what node-postgres returns with its default type
 * parsers for the projection named in its description; see
 * `../rowSchemas.ts` for the primitives and conventions. Schemas only check.
 */
import { z } from "zod";
import {
  pgBigint,
  pgDate,
  pgInt,
  pgNumeric,
  pgTimestamptz,
} from "../rowSchemas.ts";

// ---------------------------------------------------------------------------
// import_batches
// ---------------------------------------------------------------------------

/** The `import_batches.status` CHECK constraint. */
export const importBatchStatusSchema = z.enum([
  "pending",
  "staging",
  "validating",
  "matching",
  "committing",
  "complete",
  "failed",
  "aborted",
  "awaiting_review",
]);

/** `listBatches`' projection: the batch plus its live transaction count. */
export const importBatchListRowSchema = z
  .object({
    /** BIGSERIAL */
    id: pgBigint,
    adapter_name: z.string(),
    source_filename: z.string().nullable(),
    /** BIGINT */
    source_size_bytes: pgBigint.nullable(),
    status: importBatchStatusSchema,
    rows_total: pgInt,
    rows_imported: pgInt,
    rows_duplicate: pgInt,
    rows_error: pgInt,
    error_summary: z.string().nullable(),
    started_at: pgTimestamptz,
    completed_at: pgTimestamptz.nullable(),
    /** COUNT(t.id)::int over a LEFT JOIN: 0, never NULL. */
    transactions_remaining: pgInt,
  })
  .describe("import batch list row");
export type ImportBatchListRow = z.output<typeof importBatchListRowSchema>;

/** `getBatch`' projection: the list row plus the stored custom parser config. */
export const importBatchRowSchema = importBatchListRowSchema
  .extend({
    /** JSONB object written by `createBatch`, or NULL for built-in adapters. */
    custom_config: z.record(z.string(), z.unknown()).nullable(),
  })
  .describe("import batch row");
export type ImportBatchRow = z.output<typeof importBatchRowSchema>;

/** `SELECT COUNT(*)::int AS total FROM import_batches`. */
export const importBatchTotalRowSchema = z
  .object({ total: pgInt })
  .describe("import batch total row");

/** `createBatch`' `RETURNING id` (BIGSERIAL). */
export const importBatchIdRowSchema = z
  .object({ id: pgBigint })
  .describe("import batch id row");

/** `commitBatch`' status flip `RETURNING adapter_name`. */
export const importBatchAdapterRowSchema = z
  .object({ adapter_name: z.string() })
  .describe("import batch adapter row");

// ---------------------------------------------------------------------------
// import_staging_rows
// ---------------------------------------------------------------------------

/** The `import_staging_rows.status` CHECK constraint. */
export const importStagingStatusSchema = z.enum([
  "pending",
  "validated",
  "matched",
  "committed",
  "duplicate",
  "error",
]);

/** The `import_staging_rows.match_source` CHECK constraint. */
export const importMatchSourceSchema = z.enum([
  "pattern",
  "exact",
  "fuzzy",
  "new",
]);

/**
 * A row of `import_staging_rows`, the transaction import pipeline's work table
 * (migration 0001; `match_*` / `user_override_recipient_id` from 0015,
 * `override_category_id` from 0020). No query selects it whole: the pipeline
 * phases `pick` the columns they project.
 *
 * Everything the adapter produced is nullable on purpose: STAGE writes what it
 * parsed and VALIDATE rejects unusable rows. `tx_date` is a DATE, so a
 * local-midnight `Date` when selected raw; validate and commit project it as
 * `to_char(tx_date, 'YYYY-MM-DD')` instead. `match_similarity` is REAL, so a
 * number.
 */
export const importStagingRowSchema = z
  .object({
    /** BIGSERIAL */
    id: pgBigint,
    /** BIGINT */
    batch_id: pgBigint,
    row_index: pgInt,
    status: importStagingStatusSchema,
    tx_date: pgDate.nullable(),
    bank_account: z.string().nullable(),
    recipient_raw: z.string().nullable(),
    memo: z.string().nullable(),
    /** NUMERIC(20,4) */
    amount: pgNumeric.nullable(),
    currency: z.string().nullable(),
    /** NUMERIC(20,4) */
    balance: pgNumeric.nullable(),
    recipient_account: z.string().nullable(),
    recipient_address: z.string().nullable(),
    recipient_bank_name: z.string().nullable(),
    comment: z.string().nullable(),
    raw_data: z.string().nullable(),
    source_transaction_id: z.string().nullable().optional(),
    source_account_identity: z.string().nullable().optional(),
    /** CHAR(64) hex digest. */
    source_record_hash: z.string().nullable().optional(),
    /** CHAR(64) hex digest. */
    dedup_fingerprint: z.string().nullable().optional(),
    /** SMALLINT */
    dedup_fingerprint_version: pgInt.nullable().optional(),
    dedup_occurrence: pgInt.nullable().optional(),
    resolved_recipient_id: pgInt.nullable(),
    error_message: z.string().nullable(),
    match_source: importMatchSourceSchema.nullable().optional(),
    matched_pattern_id: pgInt.nullable().optional(),
    /** REAL */
    match_similarity: z.number().nullable().optional(),
    user_override_recipient_id: pgInt.nullable().optional(),
    override_category_id: pgInt.nullable().optional(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz.optional(),
  })
  .describe("import_staging_rows row");
export type ImportStagingRow = z.output<typeof importStagingRowSchema>;

/**
 * VALIDATE's projection: the row joined to its batch's adapter, `tx_date`
 * through `to_char` and `source_transaction_id` aliased `source_id`.
 */
export const pendingStagingRowSchema = importStagingRowSchema
  .pick({
    id: true,
    row_index: true,
    status: true,
    amount: true,
    recipient_raw: true,
    memo: true,
    currency: true,
    raw_data: true,
    bank_account: true,
    balance: true,
  })
  .extend({
    tx_date: z.string().nullable(),
    source_id: z.string().nullable(),
    adapter_name: z.string(),
  })
  .describe("pending staging row");
export type PendingStagingRow = z.output<typeof pendingStagingRowSchema>;

/** MATCH's projection of the validated rows. */
export const matchStagingRowSchema = importStagingRowSchema
  .pick({ id: true, recipient_raw: true })
  .describe("match staging row");

/**
 * COMMIT's projection of the matched rows, joined to the effective
 * recipient's default category, `tx_date` through `to_char`. The SELECT
 * filters only on `batch_id` and `status = 'matched'`, so `tx_date` and
 * `amount` stay nullable even though VALIDATE marks a row missing either
 * 'error' before it can reach 'matched'.
 */
export const commitStagingRowSchema = importStagingRowSchema
  .pick({
    id: true,
    row_index: true,
    bank_account: true,
    recipient_raw: true,
    memo: true,
    currency: true,
    balance: true,
    comment: true,
    resolved_recipient_id: true,
  })
  .extend({
    tx_date: z.string().nullable(),
    amount: pgNumeric.nullable(),
    source_record_hash: z.string().nullable(),
    dedup_fingerprint: z.string().nullable(),
    dedup_fingerprint_version: pgInt.nullable(),
    dedup_occurrence: pgInt.nullable(),
    user_override_recipient_id: pgInt.nullable(),
    matched_pattern_id: pgInt.nullable(),
    override_category_id: pgInt.nullable(),
    /** LEFT JOIN recipients */
    recipient_default_category_id: pgInt.nullable(),
  })
  .describe("commit staging row");
export type CommitStagingRow = z.output<typeof commitStagingRowSchema>;

/**
 * `getPreviewRows`: a matched staging row joined to the effective recipient,
 * its default category, the override category and the matched pattern. Every
 * joined column comes through a LEFT JOIN, so it is nullable.
 */
export const importPreviewRowSchema = importStagingRowSchema
  .pick({
    id: true,
    row_index: true,
    recipient_raw: true,
    amount: true,
    currency: true,
    memo: true,
    bank_account: true,
    resolved_recipient_id: true,
  })
  .extend({
    tx_date: z.string().nullable(),
    match_source: importMatchSourceSchema.nullable(),
    match_similarity: z.number().nullable(),
    matched_pattern_id: pgInt.nullable(),
    user_override_recipient_id: pgInt.nullable(),
    override_category_id: pgInt.nullable(),
    effective_recipient_id: pgInt.nullable(),
    recipient_name: z.string().nullable(),
    recipient_default_category_id: pgInt.nullable(),
    recipient_default_category_general: z.string().nullable(),
    recipient_default_category_detail: z.string().nullable(),
    recipient_default_category_path: z.string().nullable(),
    override_category_general: z.string().nullable(),
    override_category_detail: z.string().nullable(),
    override_category_path: z.string().nullable(),
    matched_pattern_text: z.string().nullable(),
    matched_pattern_kind: z.string().nullable(),
  })
  .describe("import preview row");
export type ImportPreviewRow = z.output<typeof importPreviewRowSchema>;

// ---------------------------------------------------------------------------
// Recipients and categories resolved by an import
// ---------------------------------------------------------------------------

/** `SELECT r.id` / `RETURNING id` over the INTEGER `recipients.id`. */
export const recipientIdOnlyRowSchema = z
  .object({ id: pgInt })
  .describe("recipient id row");

/** `recipients` `id, normalized_name` (SELECT or INSERT ... RETURNING). */
export const recipientIdentityRowSchema = z
  .object({ id: pgInt, normalized_name: z.string() })
  .describe("recipient identity row");

/** `selectRecipients` in the CSV data importer. */
export const recipientResolutionRowSchema = recipientIdentityRowSchema
  .extend({
    notes: z.string().nullable(),
    default_category_id: pgInt.nullable(),
  })
  .describe("recipient resolution row");

/**
 * A category resolved by `general`/`detail`: `selectCategories` (the id is
 * COALESCE(category, merge-alias target) behind a WHERE that requires one of
 * them) and the INSERT ... RETURNING.
 */
export const categoryPairIdRowSchema = z
  .object({ id: pgInt, general: z.string(), detail: z.string() })
  .describe("category pair id row");

// ---------------------------------------------------------------------------
// custom_parser_configs
// ---------------------------------------------------------------------------

/**
 * A row of `custom_parser_configs` (migrations 0037 + 0041) as projected by
 * the repository's `COLUMNS`. `config_json` is JSONB, so pg hands it back
 * parsed; its shape is re-checked against the stored parser-config schema by
 * the repository's `mapRow`.
 */
export const customParserConfigRowSchema = z
  .object({
    id: pgInt,
    name: z.string(),
    /** CHECK constraint (migration 0041). */
    kind: z.enum(["transaction", "portfolio"]),
    /** JSONB NOT NULL: any JSON value (the parser-config check is separate). */
    config_json: z.json(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
  })
  .describe("custom_parser_configs row");
export type CustomParserConfigRow = z.output<
  typeof customParserConfigRowSchema
>;
