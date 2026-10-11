/**
 * Row schemas for the catalog repositories and services (ADR-193):
 * categories (flat and hierarchy), recipients, recipient bank accounts,
 * recipient match patterns, tags, user settings, saved charts and
 * attachments.
 *
 * Each schema describes what node-postgres returns with its default type
 * parsers for the projection named in its description; see
 * `../rowSchemas.ts` for the primitives and conventions. Schemas only check.
 */
import { z } from "zod";
import {
  idRowSchema,
  pgBigint,
  pgDate,
  pgInt,
  pgNumeric,
  pgTimestamptz,
} from "../rowSchemas.ts";

// ---------------------------------------------------------------------------
// Shared narrow projections
// ---------------------------------------------------------------------------

// Re-exported so catalog callers keep one import site; defined once elsewhere.
export { idRowSchema } from "../rowSchemas.ts";
export { requireRow } from "../rowContracts.ts";
export type IdRow = z.output<typeof idRowSchema>;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** A row of `categories` as returned by `SELECT *` / `RETURNING *`. */
export const categoryRowSchema = z
  .object({
    id: pgInt,
    general: z.string(),
    detail: z.string(),
    description: z.string().nullable(),
    is_active: z.boolean(),
    created_at: pgTimestamptz.nullable(),
    updated_at: pgTimestamptz,
    /** Hierarchy parent (self-referencing). */
    parent_id: pgInt.nullable(),
    name: z.string(),
    hierarchy_only: z.boolean(),
    legacy_compatible: z.boolean(),
    /** Trigger-maintained `GENERAL:DETAIL`-style hierarchy path. */
    path_name: z.string(),
  })
  .describe("categories row");
export type CategoryRow = z.output<typeof categoryRowSchema>;

/** `NODE_SELECT`: `categories` joined to the `category_paths` view. */
export const categoryNodeRowSchema = z
  .object({
    id: pgInt,
    name: z.string(),
    parent_id: pgInt.nullable(),
    /** INTEGER[] from the recursive view; never NULL for a joined row. */
    ids: z.array(pgInt),
    names: z.array(z.string()),
    path_name: z.string(),
    /** `cardinality(ids)`: INTEGER. */
    depth: pgInt,
    description: z.string().nullable(),
    is_active: z.boolean(),
    hierarchy_only: z.boolean(),
    legacy_compatible: z.boolean(),
  })
  .describe("category node row");
export type CategoryNodeRow = z.output<typeof categoryNodeRowSchema>;

/** `SELECT id,is_active FROM categories ... FOR UPDATE` (parent check). */
export const categoryActiveRowSchema = z
  .object({ id: pgInt, is_active: z.boolean() })
  .describe("category active row");

/** `nextval(...) AS id`: BIGINT, so a string. */
export const categoryNextIdRowSchema = z
  .object({ id: pgBigint })
  .describe("category next id row");

/** The merge participants' locked projection. */
export const categoryMergeNodeRowSchema = z
  .object({
    id: pgInt,
    is_active: z.boolean(),
    general: z.string(),
    detail: z.string(),
    legacy_compatible: z.boolean(),
    hierarchy_only: z.boolean(),
  })
  .describe("category merge node row");

/** A single-column foreign key that references `categories` (pg_catalog `name`s). */
export const categoryReferenceRowSchema = z
  .object({
    schema_name: z.string(),
    table_name: z.string(),
    column_name: z.string(),
  })
  .describe("category reference row");

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/** A row of `recipients` as returned by `SELECT *` / `SELECT r.*`. */
export const recipientRowSchema = z
  .object({
    id: pgInt,
    name: z.string(),
    normalized_name: z.string(),
    default_category_id: pgInt.nullable(),
    /** Merge target (self-referencing). */
    primary_recipient_id: pgInt.nullable(),
    notes: z.string().nullable(),
    is_active: z.boolean(),
    created_at: pgTimestamptz.nullable(),
    updated_at: pgTimestamptz,
  })
  .describe("recipients row");
export type RecipientRow = z.output<typeof recipientRowSchema>;

/** `recipientRowSchema` plus the derived columns the alias list projects. */
export const recipientAliasRowSchema = recipientRowSchema
  .extend({
    /** CASE over a LEFT JOIN. */
    default_category_name: z.string().nullable(),
  })
  .describe("recipient alias row");
export type RecipientAliasRow = z.output<typeof recipientAliasRowSchema>;

/** `recipientAliasRowSchema` plus the list / detail / update join columns. */
export const enrichedRecipientRowSchema = recipientAliasRowSchema
  .extend({
    /** VARCHAR from a LEFT JOIN LATERAL. */
    primary_bank_account: z.string().nullable(),
    primary_recipient_name: z.string().nullable(),
    /** `COALESCE(count(*)::int, 0)` */
    alias_count: pgInt,
  })
  .describe("enriched recipients row");
export type EnrichedRecipientRow = z.output<typeof enrichedRecipientRowSchema>;

/** `createOrGet`'s upsert: `RETURNING id, (xmax = 0) AS created`. */
export const recipientUpsertRowSchema = z
  .object({ id: pgInt, created: z.boolean() })
  .describe("recipient upsert row");

/** `lockByIdsForMerge`. */
export const recipientMergeLockRowSchema = z
  .object({ id: pgInt, primary_recipient_id: pgInt.nullable() })
  .describe("recipient merge lock row");

/** `getClusterRootMap`: `COALESCE(primary_recipient_id, id)` is never NULL. */
export const recipientClusterRootRowSchema = z
  .object({ id: pgInt, cluster_root: pgInt })
  .describe("recipient cluster root row");

/** `findRecipientClusters`' scan projection. */
export const clusterRecipientRowSchema = recipientRowSchema
  .pick({ id: true, name: true, default_category_id: true })
  .describe("cluster recipient row");

/** `previewPatternMatches`' regex scan projection. */
export const recipientNameRowSchema = recipientRowSchema
  .pick({ id: true, name: true })
  .describe("recipient name row");

/** A row of `recipient_bank_accounts` (`SELECT *` / `RETURNING *`). */
export const recipientBankAccountRowSchema = z
  .object({
    id: pgInt,
    recipient_id: pgInt.nullable(),
    /** VARCHAR(34), stored trimmed + uppercased. */
    account_number: z.string(),
    bank_name: z.string().nullable(),
    account_label: z.string().nullable(),
    address: z.string().nullable(),
    is_primary: z.boolean(),
    is_active: z.boolean(),
    created_at: pgTimestamptz.nullable(),
    updated_at: pgTimestamptz,
  })
  .describe("recipient_bank_accounts row");
export type RecipientBankAccountRow = z.output<
  typeof recipientBankAccountRowSchema
>;

/**
 * A row of `recipient_match_patterns` (migration 0015). `pattern_kind` is
 * CHECK-constrained to 'regex'|'glob'|'literal_prefix' and `source` to
 * 'user'|'suggested'|'system'; both are kept as plain strings.
 */
export const recipientMatchPatternRowSchema = z
  .object({
    id: pgInt,
    /** FK → recipients, ON DELETE CASCADE */
    recipient_id: pgInt,
    pattern: z.string(),
    pattern_kind: z.string(),
    case_sensitive: z.boolean(),
    priority: pgInt,
    is_active: z.boolean(),
    source: z.string(),
    notes: z.string().nullable(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
  })
  .describe("recipient_match_patterns row");
export type RecipientMatchPatternRow = z.output<
  typeof recipientMatchPatternRowSchema
>;

/**
 * `loadActivePatterns`: `updated_at` is cast to text in SQL (it is used
 * verbatim in the compile-cache key), and `is_active` / `notes` /
 * `created_at` are not selected.
 */
export const activePatternRowSchema = recipientMatchPatternRowSchema
  .pick({
    id: true,
    recipient_id: true,
    pattern: true,
    pattern_kind: true,
    case_sensitive: true,
    priority: true,
    source: true,
  })
  .extend({ updated_at: z.string() })
  .describe("active recipient pattern row");
export type ActivePatternRow = z.output<typeof activePatternRowSchema>;

/** `updatePattern`'s stored-values read. */
export const patternDefinitionRowSchema = recipientMatchPatternRowSchema
  .pick({ pattern: true, pattern_kind: true, case_sensitive: true })
  .describe("recipient pattern definition row");

/** `listPatternsForRecipient`: every column but `recipient_id`. */
export const recipientPatternListRowSchema = recipientMatchPatternRowSchema
  .omit({ recipient_id: true })
  .describe("recipient pattern list row");
export type RecipientPatternListRow = z.output<
  typeof recipientPatternListRowSchema
>;

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** A row of `tags` (`SELECT *` / `RETURNING *`). */
export const tagRowSchema = z
  .object({
    id: pgInt,
    slug: z.string(),
    color: z.string().nullable(),
    is_active: z.boolean(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
  })
  .describe("tags row");
export type TagRow = z.output<typeof tagRowSchema>;

/** `findOrCreateBySlug`: `RETURNING *, (xmax <> 0) AS was_conflict`. */
export const tagUpsertRowSchema = tagRowSchema
  .extend({ was_conflict: z.boolean() })
  .describe("tag upsert row");

// ---------------------------------------------------------------------------
// User settings
// ---------------------------------------------------------------------------

/** `SELECT key, value FROM user_settings`; JSONB arrives parsed (any JSON). */
export const settingRowSchema = z
  .object({ key: z.string(), value: z.unknown() })
  .describe("user_settings row");

/** `SELECT value FROM user_settings WHERE key = $1`. */
export const settingValueRowSchema = settingRowSchema
  .pick({ value: true })
  .describe("user_settings value row");

// ---------------------------------------------------------------------------
// Saved charts
// ---------------------------------------------------------------------------

/**
 * A row of `saved_charts` as projected by `savedChartsRepository`'s `COLUMNS`
 * list. The membership arrays are `COALESCE(array_agg(...), '{}')`, so never
 * NULL, and the two DATE columns are `to_char` calendar-day strings.
 */
export const savedChartRowSchema = z
  .object({
    id: pgInt,
    name: z.string(),
    chart_type: z.string(),
    category_ids: z.array(pgInt),
    recipient_ids: z.array(pgInt),
    tag_ids: z.array(pgInt),
    all_categories: z.boolean(),
    all_recipients: z.boolean(),
    all_tags: z.boolean(),
    chart_variant: z.string(),
    time_bucket: z.string(),
    /** 'YYYY-MM-DD' */
    date_range_start: z.string().nullable(),
    /** 'YYYY-MM-DD' */
    date_range_end: z.string().nullable(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
  })
  .describe("saved_charts row");
export type SavedChartRow = z.output<typeof savedChartRowSchema>;

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * A row of `attachments` (`SELECT *` / `RETURNING *`). `id` and `size_bytes`
 * are BIGINT (strings); `transaction_id` is INTEGER since migration 0027.
 */
export const attachmentRowSchema = z
  .object({
    id: pgBigint,
    transaction_id: pgInt,
    filename: z.string(),
    stored_path: z.string(),
    mime_type: z.string(),
    size_bytes: pgBigint,
    created_at: pgTimestamptz,
  })
  .describe("attachments row");
export type AttachmentRow = z.output<typeof attachmentRowSchema>;

/** `listPathsByTransactionIds`. */
export const attachmentPathRowSchema = attachmentRowSchema
  .pick({ stored_path: true })
  .describe("attachment path row");

// ---------------------------------------------------------------------------
// Category outliers
// ---------------------------------------------------------------------------

/** `categoryOutlierService`'s expense scan (`category_id IS NOT NULL`). */
export const categoryOutlierExpenseRowSchema = z
  .object({
    date: pgDate,
    amount: pgNumeric,
    category_id: pgInt,
    /** LEFT JOIN categories. */
    category_name: z.string().nullable(),
  })
  .describe("category outlier expense row");
