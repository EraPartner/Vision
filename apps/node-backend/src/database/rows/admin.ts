/**
 * Row schemas for the admin database-maintenance reads (ADR-193). These read
 * PostgreSQL's statistics catalog, whose types are fixed by the server:
 * `name` columns arrive as strings, BIGINT counters and sizes as strings.
 */
import { z } from "zod";
import { pgBigint } from "../rowSchemas.ts";

/** A `pg_stat_user_tables` row as `/database/stats` projects it. */
export const tableStatsRowSchema = z
  .object({
    schemaname: z.string(),
    table_name: z.string(),
    live_rows: pgBigint,
    dead_rows: pgBigint,
    /** `last_autovacuum::text`: NULL until the first autovacuum. */
    last_autovacuum: z.string().nullable(),
    last_autoanalyze: z.string().nullable(),
    /** `pg_size_pretty(...)` */
    size: z.string(),
    /** `pg_total_relation_size(...)` is BIGINT. */
    size_bytes: pgBigint,
  })
  .describe("pg_stat_user_tables stats row");

/** `pg_size_pretty(pg_database_size(current_database()))`. */
export const databaseSizeRowSchema = z
  .object({ db_size: z.string() })
  .describe("database size row");

/** `SELECT relname FROM pg_stat_user_tables`. */
export const userTableNameRowSchema = z
  .object({ relname: z.string() })
  .describe("user table name row");

/** `INSERT INTO db_editor_audit ... RETURNING` in services/dbEditor.ts. */
export const dbEditorAuditRowSchema = z
  .object({
    /** BIGSERIAL. */
    id: pgBigint,
    /** Nullable JSONB columns cast `::text`. */
    pk_text: z.string().nullable(),
    before_text: z.string().nullable(),
    after_text: z.string().nullable(),
    statement: z.string(),
    /** `to_char(created_at ...)`: an ISO-8601 UTC string. */
    occurred_at: z.string(),
  })
  .describe("db editor audit row");
