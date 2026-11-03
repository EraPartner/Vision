/**
 * Row schemas for the admin database-maintenance reads (ADR-193, ADR-263).
 * These read SQLite's catalog: `pragma_table_list`, `dbstat` (when the SQLite
 * build has it) and the page counters. Counts and byte sizes are read through
 * a `::bigint` alias hint, so they arrive as decimal strings, the form the
 * `/database/stats` contract kept from PostgreSQL's BIGINT counters.
 */
import { z } from "zod";
import {
  pgBigint,
} from "../rowSchemas.ts";

/**
 * One row of `/database/stats`, assembled from the reads below. SQLite keeps
 * no per-table maintenance history: `dead_rows` is always "0" (a deleted row
 * frees its space at once; there are no dead tuples), `last_vacuum` and
 * `last_analyze` are the times this backend process last ran VACUUM/ANALYZE
 * (ISO 8601, NULL until then), and the autovacuum/autoanalyze times are NULL.
 */
export const tableStatsRowSchema = z
  .object({
    /** SQLite's schema name: always "main". */
    schemaname: z.string(),
    table_name: z.string(),
    live_rows: pgBigint,
    dead_rows: pgBigint,
    last_vacuum: z.string().nullable(),
    last_autovacuum: z.string().nullable(),
    last_analyze: z.string().nullable(),
    last_autoanalyze: z.string().nullable(),
    /** pg_size_pretty() text of `size_bytes`, or "—" without dbstat. */
    size: z.string(),
    /** Pages of the table and its indexes, in bytes ("0" without dbstat). */
    size_bytes: pgBigint,
  })
  .describe("database table stats row");
export type TableStatsRow = z.output<typeof tableStatsRowSchema>;

/** `count(*) AS "live_rows::bigint"` per table. */
export const tableRowCountRowSchema = z
  .object({ table_name: z.string(), live_rows: pgBigint })
  .describe("table row count row");

/** `sum(dbstat.pgsize)` over a table's own b-tree and its indexes. */
export const tableSizeRowSchema = z
  .object({ table_name: z.string(), size_bytes: pgBigint })
  .describe("table size row");

/** `page_count * page_size`: the database's size in bytes. */
export const databaseSizeRowSchema = z
  .object({ size_bytes: pgBigint })
  .describe("database size row");
