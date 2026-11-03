/**
 * Row schemas for the admin database-maintenance reads (ADR-193, ADR-263).
 * These read SQLite's catalog: `pragma_table_list`, `dbstat` (when the SQLite
 * build has it) and the page counters. Counts and byte sizes are read through
 * a `::bigint` alias hint, so they arrive as decimal strings.
 */
import { z } from "zod";
import {
  dbBigint,
} from "../rowSchemas.ts";

/**
 * One row of `/database/stats`, assembled from the reads below. SQLite keeps
 * no per-table maintenance history: `last_vacuum` and `last_analyze` are the
 * times this backend process last ran VACUUM/ANALYZE (ISO 8601, NULL until
 * then).
 */
export const tableStatsRowSchema = z
  .object({
    table_name: z.string(),
    live_rows: dbBigint,
    last_vacuum: z.string().nullable(),
    last_analyze: z.string().nullable(),
    /** Human-readable `size_bytes` ("4096 kB"), or "—" without dbstat. */
    size: z.string(),
    /** Pages of the table and its indexes, in bytes ("0" without dbstat). */
    size_bytes: dbBigint,
  })
  .describe("database table stats row");
export type TableStatsRow = z.output<typeof tableStatsRowSchema>;

/** `count(*) AS "live_rows::bigint"` per table. */
export const tableRowCountRowSchema = z
  .object({ table_name: z.string(), live_rows: dbBigint })
  .describe("table row count row");

/** `sum(dbstat.pgsize)` over a table's own b-tree and its indexes. */
export const tableSizeRowSchema = z
  .object({ table_name: z.string(), size_bytes: dbBigint })
  .describe("table size row");

/** `page_count * page_size`: the database's size in bytes. */
export const databaseSizeRowSchema = z
  .object({ size_bytes: dbBigint })
  .describe("database size row");
