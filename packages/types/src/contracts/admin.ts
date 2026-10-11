import { z } from "zod";

import { WireTimestampSchema, wireCollectionOf } from "./common.ts";

/** A BIGINT counter from `pg_stat_user_tables`: node-postgres returns its text. */
const PgBigintTextSchema = z.string().regex(/^\d+$/);

/**
 * One row of `GET /api/admin/database/stats` (routes/admin.ts). The counters
 * and `size_bytes` are BIGINT, so they arrive as strings; the vacuum/analyze
 * times are `::text` casts and NULL for a table never vacuumed.
 */
export const DbTableStatSchema = z.looseObject({
  schemaname: z.string(),
  table_name: z.string(),
  live_rows: PgBigintTextSchema,
  dead_rows: PgBigintTextSchema,
  last_autovacuum: z.string().nullable(),
  last_autoanalyze: z.string().nullable(),
  size: z.string(),
  size_bytes: PgBigintTextSchema,
});

/** `GET /api/admin/database/stats`. */
export const DbStatsSchema = z.looseObject({
  tables: z.array(DbTableStatSchema),
  db_size: z.string().nullable(),
});

/**
 * `listProviderHealth` / `enrichRow` (services/providerHealthService.ts). The
 * timestamps are null until the provider first succeeds or fails. `kind` is
 * the provider definition's kind (`price`, `fx`, `inflation`, `research`).
 */
export const ProviderHealthSchema = z.looseObject({
  provider: z.string(),
  kind: z.string(),
  label: z.string(),
  last_success_at: WireTimestampSchema.nullable(),
  last_error_at: WireTimestampSchema.nullable(),
  last_error: z.string().nullable(),
  consecutive_failures: z.number().int().nonnegative(),
  updated_at: WireTimestampSchema.nullable(),
});

/** `GET /api/admin/providers/health`. */
export const ProviderHealthListSchema = wireCollectionOf(ProviderHealthSchema);

/** `POST /api/admin/providers/:provider/probe`; `error` only on a failed probe. */
export const ProbeResultSchema = z.looseObject({
  ok: z.boolean(),
  provider: ProviderHealthSchema,
  error: z.string().optional(),
});

/**
 * `getMetrics` (middleware/requestMetrics.ts). The percentiles are typed
 * nullable there (an empty latency sample), though a reported route has at
 * least one request.
 */
export const RouteMetricSchema = z.looseObject({
  route: z.string(),
  method: z.string(),
  path: z.string(),
  count: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  error_rate: z.number(),
  p50_ms: z.number().nullable(),
  p95_ms: z.number().nullable(),
  window_minutes: z.number(),
});

/** `GET /api/admin/metrics/requests`. */
export const RouteMetricListSchema = wireCollectionOf(RouteMetricSchema);

/** `GET /api/admin/endpoints` (`getRouteManifest`). */
export const EndpointManifestSchema = wireCollectionOf(
  z.looseObject({ method: z.string(), path: z.string() }),
);

// ── DB data editor (services/dbEditor.ts) ────────────────────────────────────

/** `ColumnMeta`: introspected from `information_schema.columns`. */
export const DbColumnSchema = z.looseObject({
  name: z.string(),
  dataType: z.string(),
  udtName: z.string(),
  nullable: z.boolean(),
  hasDefault: z.boolean(),
  generated: z.boolean(),
  writable: z.boolean(),
});

/** `GET /api/admin/database/tables/:table/schema` (`getTableMeta`). */
export const TableSchemaSchema = z.looseObject({
  table: z.string(),
  columns: z.array(DbColumnSchema),
  primaryKey: z.array(z.string()),
});

/** A row of any editable table: its columns are dynamic, so only the record shape is checked. */
const DbRowSchema = z.record(z.string(), z.unknown());

/**
 * `GET /api/admin/database/tables/:table/rows` (`readRows`). `total` is only
 * set on an unpaged first page; `nextCursor` is null on the last page.
 */
export const TableRowsSchema = TableSchemaSchema.extend({
  rows: z.array(DbRowSchema),
  total: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

/** `POST .../mutate` with `dryRun: true`. */
export const DbPreviewResultSchema = z.looseObject({
  dryRun: z.literal(true),
  count: z.number().int().nonnegative(),
  statements: z.array(z.looseObject({ op: z.string(), preview: z.string() })),
});

/** `POST .../mutate` without `dryRun`; a delete result has no `after`. */
export const DbCommitResultSchema = z.looseObject({
  dryRun: z.literal(false),
  applied: z.number().int().nonnegative(),
  results: z.array(
    z.looseObject({ op: z.string(), after: DbRowSchema.optional() }),
  ),
  refreshScheduled: z.boolean(),
});
