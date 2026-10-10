import { z } from "zod";

import { WireTimestampSchema, wireCollectionOf } from "./common.ts";

// ── Analysis workspace (routes/analysis.ts) ──────────────────────────────────

/** `AnalysisUnit`: only `kind` is always present. */
export const AnalysisUnitSchema = z.looseObject({ kind: z.string() });

/** A catalog field or measure, and a result column with a label. */
export const AnalysisFieldSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  unit: AnalysisUnitSchema.optional(),
});

/** `GET /api/analysis/catalog` (`getAnalysisCatalog`). */
export const AnalysisCatalogSchema = z.looseObject({
  version: z.number().int(),
  datasets: z.array(
    z.looseObject({
      id: z.string(),
      label: z.string(),
      relation: z.string(),
      fields: z.array(AnalysisFieldSchema),
      measures: z.array(AnalysisFieldSchema),
      joins: z.array(
        z.looseObject({
          id: z.string(),
          datasetId: z.string(),
          cardinality: z.string(),
          duplicationSafe: z.boolean(),
        }),
      ),
    }),
  ),
});

/** A result row: column id to cell. JSON and array columns keep their shape. */
const AnalysisRowSchema = z.record(z.string(), z.unknown());

/** A result column: `id` and `type` always, `label`/`nullable`/`unit` when declared. */
const AnalysisColumnSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  unit: AnalysisUnitSchema.optional(),
});

/** The paging window of `executeAnalysisSql` / `executeFinancialAnalysis`. */
const AnalysisWindowSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("page"),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    returnedRows: z.number().int().nonnegative(),
  }),
  z.looseObject({
    kind: z.literal("truncated"),
    returnedRows: z.number().int().nonnegative(),
    enforcedLimit: z.number().int().nonnegative(),
    reason: z.string(),
  }),
]);

/**
 * `POST /api/analysis/execute` and `POST /api/analysis/drill`: an executor
 * result (`executeAnalysisSql` or `executeFinancialAnalysis`) with
 * `generatedSql` and `declaredColumns`, after the optional scenario,
 * workbench and formula passes (services/analysisWorkbenchService.ts) added
 * their coverage, lineage and formula fields. `requestId` echoes the request
 * and is absent when the request carried none.
 */
export const AnalysisResultSchema = z.looseObject({
  requestId: z.string().optional(),
  startedAt: WireTimestampSchema,
  completedAt: WireTimestampSchema,
  executor: z.string(),
  rows: z.array(AnalysisRowSchema),
  columns: z.array(AnalysisColumnSchema),
  declaredColumns: z.array(AnalysisColumnSchema).optional(),
  window: AnalysisWindowSchema,
  byteLength: z.number().int().nonnegative(),
  generatedSql: z.string(),
  complete: z.boolean().optional(),
  coverage: z.record(z.string(), z.unknown()).optional(),
  provenance: z.record(z.string(), z.unknown()).optional(),
  formulaSummaries: z.record(z.string(), z.unknown()).optional(),
  formulaErrors: z.array(z.record(z.string(), z.unknown())).optional(),
  transformationErrors: z.array(z.record(z.string(), z.unknown())).optional(),
  transformationCoverage: z.array(z.record(z.string(), z.unknown())).optional(),
  preparationLineage: z.array(z.record(z.string(), z.unknown())).optional(),
  sourceResult: z.record(z.string(), z.unknown()).optional(),
});

/** `POST /api/analysis/pivot` (`executeAnalysisPivot`). */
export const AnalysisPivotResultSchema = z.looseObject({
  levels: z.array(
    z.looseObject({
      rowDepth: z.number().int().nonnegative(),
      columnDepth: z.number().int().nonnegative(),
      groups: z.array(z.string()),
      rows: z.array(AnalysisRowSchema),
      columns: z.array(AnalysisColumnSchema),
    }),
  ),
  partitions: z.array(z.string()),
  config: z.looseObject({
    rows: z.array(z.string()),
    columns: z.array(z.string()),
    values: z.array(z.string()),
    filters: z.array(z.unknown()),
  }),
  coverage: z.looseObject({
    complete: z.boolean(),
    rows: z.number().int().nonnegative(),
    financialComplete: z.boolean(),
    unavailableRows: z.number().int().nonnegative(),
  }),
});

const JsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * `mapSaved` (services/savedAnalysisService.ts) over a `saved_analyses` row
 * (migration 0110). The JSONB columns stay loosely typed: their content is
 * owned by the analysis definition contract. `lastResult` is the last
 * successful run's stored result, null before the first run.
 */
export const SavedAnalysisSchema = z.looseObject({
  id: z.string(),
  definitionId: z.string(),
  name: z.string(),
  workspace: z.enum(["budgeting", "portfolio", "research", "cross-workspace"]),
  version: z.number().int().positive(),
  refreshMode: z.enum(["live", "frozen"]),
  parameters: JsonObjectSchema,
  charts: z.array(z.unknown()),
  sourceReferences: z.array(z.unknown()),
  refreshStatus: z.enum([
    "never-run",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  lastSuccessfulRunId: z.string().nullable(),
  lastError: JsonObjectSchema.nullable(),
  createdAt: WireTimestampSchema,
  updatedAt: WireTimestampSchema,
  definition: JsonObjectSchema,
  lastResult: JsonObjectSchema.nullable(),
});

/** `GET /api/analysis/saved`. */
export const SavedAnalysisListSchema = wireCollectionOf(SavedAnalysisSchema);

/** `GET /api/analysis/saved/:id/versions`; `state` is NULL on pre-0111 versions. */
export const SavedAnalysisVersionListSchema = wireCollectionOf(
  z.looseObject({
    version: z.number().int().positive(),
    definition: JsonObjectSchema,
    state: JsonObjectSchema.nullable(),
    createdAt: WireTimestampSchema,
  }),
);

/** An `AiAnalysisEditProposal` (`aiAnalysisEditProposalSchema`), loosely. */
const AnalysisEditProposalSchema = z.looseObject({
  schemaVersion: z.literal(1),
  savedAnalysisId: z.string(),
  baseVersion: z.number().int().positive(),
  rationale: z.string(),
  operations: z.array(
    z.looseObject({
      op: z.enum(["add", "replace", "remove"]),
      path: z.string(),
      value: z.unknown().optional(),
    }),
  ),
});

/** `previewAnalysisProposal`: the preview and generate endpoints' body. */
export const AnalysisProposalPreviewSchema = z.looseObject({
  proposal: AnalysisEditProposalSchema,
  before: JsonObjectSchema,
  after: JsonObjectSchema,
  baseVersion: z.number().int().positive(),
});

// ── Monitors (services/analysisMonitorService.ts, migration 0116) ────────────

const MonitorKindSchema = z.enum(["analysis-threshold", "dossier-evidence"]);

/** `mapObservation`. `coverage` is a JSONB object, `analysisWindow` any JSONB. */
export const MonitorObservationSchema = z.looseObject({
  id: z.string(),
  monitorId: z.string(),
  status: z.enum([
    "baseline",
    "unchanged",
    "triggered",
    "cooldown-pending",
    "partial",
    "stale",
    "failed",
  ]),
  previousValue: z.string().nullable(),
  currentValue: z.string().nullable(),
  previousEvidenceVersion: z.number().int().nullable(),
  currentEvidenceVersion: z.number().int().nullable(),
  analysisDefinitionVersion: z.number().int().nullable(),
  analysisRunId: z.string().nullable(),
  historicalAnalysisRunId: z.string().nullable(),
  analysisRunStatus: z.string().nullable(),
  analysisWindow: z.unknown().optional(),
  coverage: JsonObjectSchema,
  reasonCode: z.string(),
  reason: z.string(),
  checkedAt: WireTimestampSchema,
});

/** `mapMonitor`, with `lastObservation` mapped when the monitor has one. */
export const AnalysisMonitorSchema = z.looseObject({
  id: z.string(),
  kind: MonitorKindSchema,
  title: z.string(),
  enabled: z.boolean(),
  savedAnalysisId: z.string().nullable(),
  dossierId: z.string().nullable(),
  historicalTargetId: z.string(),
  targetLabel: z.string(),
  targetAvailable: z.boolean(),
  fieldId: z.string().nullable(),
  operator: z.enum(["above", "below"]).nullable(),
  threshold: z.string().nullable(),
  intervalMinutes: z.number().int(),
  cooldownMinutes: z.number().int(),
  nextDueAt: WireTimestampSchema,
  lastCheckedAt: WireTimestampSchema.nullable(),
  lastStatus: z.string().nullable(),
  lastObservation: MonitorObservationSchema.nullable(),
  createdAt: WireTimestampSchema,
  updatedAt: WireTimestampSchema,
});

/** `mapNotification`. */
export const MonitorNotificationSchema = z.looseObject({
  id: z.string(),
  monitorId: z.string(),
  observationId: z.string(),
  kind: MonitorKindSchema,
  title: z.string(),
  reasonCode: z.string(),
  reason: z.string(),
  previousValue: z.string().nullable(),
  currentValue: z.string().nullable(),
  createdAt: WireTimestampSchema,
  readAt: WireTimestampSchema.nullable(),
});

/** The monitor list bodies: always `{items, total, limit, offset}`. */
const monitorPageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.looseObject({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  });

/** `GET /api/analysis/monitors`. */
export const AnalysisMonitorPageSchema = monitorPageOf(AnalysisMonitorSchema);

/** `GET /api/analysis/monitors/:id/observations`. */
export const MonitorObservationPageSchema = monitorPageOf(
  MonitorObservationSchema,
);

/** `GET /api/analysis/monitors/notifications`, with the inbox's unread count. */
export const MonitorNotificationPageSchema = monitorPageOf(
  MonitorNotificationSchema,
).extend({ unreadCount: z.number().int().nonnegative() });
