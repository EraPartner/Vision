/**
 * Row schemas for the audit hash chain and its verification reads (ADR-193).
 *
 * Like `../rowSchemas.ts`, each schema describes what node-postgres returns
 * with its default parsers and only checks. Sequences and audit ids are
 * BIGINT, so they arrive as strings; the hash columns are CHAR(64).
 */
import { z } from "zod";
import { pgBigint, pgInt, pgTimestamptz } from "../rowSchemas.ts";

/** `audit_chain_head`'s lock read. */
export const auditHeadRowSchema = z
  .object({
    last_sequence: pgBigint,
    last_hash: z.string(),
  })
  .describe("audit_chain_head row");
export type AuditHeadRow = z.output<typeof auditHeadRowSchema>;

/** `readAuditHead`: the head plus the legacy cutover high-water ids. */
export const auditHeadDetailRowSchema = auditHeadRowSchema
  .extend({
    updated_at: pgTimestamptz,
    legacy_db_editor_max_id: pgBigint,
    legacy_split_max_id: pgBigint,
    legacy_retag_max_id: pgBigint,
  })
  .describe("audit_chain_head detail row");

/** An `audit_chain_entries` row as `readAuditSegment` projects it. */
export const auditEntryRowSchema = z
  .object({
    sequence: pgBigint,
    /** SMALLINT */
    version: pgInt,
    previous_hash: z.string(),
    entry_hash: z.string(),
    /** JSONB, CHECK (jsonb_typeof(payload) = 'object'). */
    payload: z.record(z.string(), z.unknown()),
    created_at: pgTimestamptz,
  })
  .describe("audit_chain_entries row");
export type AuditEntryRow = z.output<typeof auditEntryRowSchema>;

/** The latest entry's `sequence, entry_hash`. */
export const auditLatestEntryRowSchema = auditEntryRowSchema
  .pick({ sequence: true, entry_hash: true })
  .describe("audit_chain_entries latest row");

/** `SELECT entry_hash FROM audit_chain_entries`. */
export const auditEntryHashRowSchema = auditEntryRowSchema
  .pick({ entry_hash: true })
  .describe("audit_chain_entries hash row");

/** The append's `RETURNING created_at`. */
export const auditEntryCreatedRowSchema = auditEntryRowSchema
  .pick({ created_at: true })
  .describe("audit_chain_entries created row");

/** An `audit_chain_checkpoints` row (BIGSERIAL id). */
export const auditCheckpointRowSchema = z
  .object({
    id: pgBigint,
    sequence: pgBigint,
    head_hash: z.string(),
    receipt_hash: z.string(),
    created_at: pgTimestamptz,
  })
  .describe("audit_chain_checkpoints row");

/** The checkpoint insert's `RETURNING id, created_at`. */
export const auditCheckpointInsertedRowSchema = auditCheckpointRowSchema
  .pick({ id: true, created_at: true })
  .describe("audit_chain_checkpoints inserted row");

// ---------------------------------------------------------------------------
// Verification reads of the linked domain audit tables
// ---------------------------------------------------------------------------

/** A `db_editor_audit` row with its JSONB columns cast to text. */
export const dbEditorAuditRowSchema = z
  .object({
    table_name: z.string(),
    op: z.string(),
    pk_text: z.string().nullable(),
    before_text: z.string().nullable(),
    after_text: z.string().nullable(),
    /** NOT NULL in the schema. */
    statement: z.string(),
    /** `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`. */
    occurred_at: z.string(),
  })
  .describe("db_editor_audit verification row");

/** A `split_audit` row with its ids and payload cast to text. */
export const splitAuditRowSchema = z
  .object({
    /** `split_id::text`; `split_id` is nullable. */
    split_id_text: z.string().nullable(),
    action: z.string(),
    actor: z.string().nullable(),
    payload_text: z.string().nullable(),
    occurred_at: z.string(),
  })
  .describe("split_audit verification row");

/** A `portfolio_retag_audit` receipt row. */
export const portfolioRetagAuditRowSchema = z
  .object({
    /** BIGSERIAL */
    id: pgBigint,
    occurred_at: z.string(),
    /** UUID */
    idempotency_key: z.string(),
    request_fingerprint: z.string(),
    from_account_id: pgInt.nullable(),
    to_account_id: pgInt.nullable(),
    /** JSONB */
    transaction_ids: z.unknown(),
    /** JSONB */
    previous_assignments: z.unknown(),
    selected_count: pgInt,
    changed_count: pgInt,
  })
  .describe("portfolio_retag_audit verification row");

/** `alembic_version`. */
export const alembicVersionRowSchema = z
  .object({ version_num: z.string() })
  .describe("alembic_version row");

/** The unlinked-row counts: bare `count(*)` subqueries are BIGINT strings. */
export const auditUnlinkedCountsRowSchema = z
  .object({
    db_editor_legacy: pgBigint,
    db_editor_missing: pgBigint,
    split_legacy: pgBigint,
    split_missing: pgBigint,
    portfolio_retag_legacy: pgBigint,
    portfolio_retag_missing: pgBigint,
  })
  .describe("audit unlinked counts row");

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** `min(sequence)`: BIGINT, NULL when no entry is recent. */
export const auditFirstRecentRowSchema = z
  .object({ first_recent: pgBigint.nullable() })
  .describe("audit retention first recent row");

/** `max((payload->>...)::bigint) FILTER (...)`: NULL when no row matched. */
export const auditDomainMaxRowSchema = z
  .object({
    db_editor_max: pgBigint.nullable(),
    split_max: pgBigint.nullable(),
    retag_max: pgBigint.nullable(),
  })
  .describe("audit retention domain max row");

/**
 * `payload->'heads'` of the latest schema_migration entry: a JSON array of
 * revision ids (verification rejects any other shape before retention reads
 * it), or NULL when the key is absent.
 */
export const auditMigrationHeadsRowSchema = z
  .object({ heads: z.array(z.string()).nullable() })
  .describe("audit retention migration heads row");

/** `audit_chain_prune_prefix(...)` returns BIGINT. */
export const auditPruneRowSchema = z
  .object({ removed: pgBigint })
  .describe("audit retention prune row");
