/**
 * Row schemas for saved analyses, analysis monitors and research dossiers
 * (ADR-193).
 *
 * Like `../rowSchemas.ts`, each schema describes what node-postgres returns
 * with its default parsers and only checks. Saved-analysis ids are TEXT,
 * monitor and dossier ids are UUIDs (strings either way). The JSONB documents
 * Vision wrote (definitions, parameters, dossier content) are checked to be
 * JSON objects and typed as what Vision stored; their readers re-validate
 * the parts they depend on.
 */
import { z } from "zod";
import type { AnalysisDefinition } from "@vision/types/analysis";
import { pgBigint, pgInt, pgNumeric, pgTimestamptz } from "../rowSchemas.ts";
import { storedJsonObject } from "./ai.ts";
import type {
  SavedAnalysisParameters,
  SavedVersionState,
} from "../../services/savedAnalysisService.ts";
import type { DossierContent } from "../../services/researchDossierService.ts";

/** A bare `count(*)` aliased `n`. */
export const countNRowSchema = z
  .object({ n: pgBigint })
  .describe("count n row");

/** A `SELECT id` / `RETURNING id` row of a TEXT- or UUID-keyed table. */
export const textIdRowSchema = z.object({ id: z.string() }).describe("id row");

// ---------------------------------------------------------------------------
// Saved analyses
// ---------------------------------------------------------------------------

/** A `saved_analyses` row (`SELECT *`). */
export const savedAnalysisTableRowSchema = z
  .object({
    id: z.string(),
    definition_id: z.string(),
    name: z.string(),
    workspace: z.string(),
    current_version: pgInt,
    /** CHECK (refresh_mode IN ('live','frozen')). */
    refresh_mode: z.string(),
    /** JSONB object (default `{}`). */
    parameters_json: storedJsonObject<SavedAnalysisParameters>(),
    /** JSONB array (default `[]`; writers store validated arrays). */
    charts_json: z.array(z.unknown()),
    /** JSONB array (default `[]`). */
    source_references_json: z.array(z.unknown()),
    refresh_status: z.string(),
    last_successful_run_id: z.string().nullable(),
    last_error_json: z.unknown(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
  })
  .describe("saved_analyses row");
export type SavedAnalysisTableRow = z.output<
  typeof savedAnalysisTableRowSchema
>;

/**
 * `listSavedAnalyses` / `getSavedAnalysis`: the row joined to its current
 * definition version and (LEFT JOIN) its last successful run's result.
 */
export const savedAnalysisRowSchema = savedAnalysisTableRowSchema
  .extend({
    definition_json: storedJsonObject<AnalysisDefinition>(),
    /** NULL without a successful run. */
    result_json: z.unknown(),
  })
  .describe("saved analysis with definition row");
export type SavedAnalysisRow = z.output<typeof savedAnalysisRowSchema>;

/** `listSavedAnalysisVersions` (camelCase aliases). */
export const savedAnalysisVersionRowSchema = z
  .object({
    version: pgInt,
    definition: storedJsonObject<AnalysisDefinition>(),
    /** NULL on legacy versions saved before state was recorded. */
    state: storedJsonObject<SavedVersionState>().nullable(),
    createdAt: pgTimestamptz,
  })
  .describe("saved_analysis_definition_versions row");

/** `restoreSavedAnalysisVersion`'s source version read. */
export const savedAnalysisVersionSourceRowSchema = z
  .object({
    definition_json: storedJsonObject<AnalysisDefinition>(),
    state_json: storedJsonObject<SavedVersionState>().nullable(),
  })
  .describe("saved_analysis_definition_versions source row");

/** The current version's `definition_json` alone. */
export const savedAnalysisDefinitionRowSchema =
  savedAnalysisVersionSourceRowSchema
    .pick({ definition_json: true })
    .describe("saved analysis definition row");

// ---------------------------------------------------------------------------
// Analysis monitors
// ---------------------------------------------------------------------------

/** An `analysis_monitors` row (`SELECT *` / `RETURNING *`). */
export const analysisMonitorRowSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    title: z.string(),
    enabled: z.boolean(),
    /** SET NULL when the saved analysis is deleted. */
    saved_analysis_id: z.string().nullable(),
    /** SET NULL when the dossier is deleted. */
    dossier_id: z.string().nullable(),
    historical_target_id: z.string(),
    target_label: z.string(),
    field_id: z.string().nullable(),
    operator: z.string().nullable(),
    /** NUMERIC */
    threshold: pgNumeric.nullable(),
    interval_minutes: pgInt,
    cooldown_minutes: pgInt,
    next_due_at: pgTimestamptz,
    last_checked_at: pgTimestamptz.nullable(),
    last_status: z.string().nullable(),
    condition_revision: pgInt,
    active_episode_key: z.string().nullable(),
    pending_signature: z.string().nullable(),
    pending_since: pgTimestamptz.nullable(),
    last_notified_at: pgTimestamptz.nullable(),
    lease_token: z.string().nullable(),
    lease_expires_at: pgTimestamptz.nullable(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
  })
  .describe("analysis_monitors row");
export type AnalysisMonitorRow = z.output<typeof analysisMonitorRowSchema>;

/** An `analysis_monitor_observations` row (`SELECT *` / `RETURNING *`). */
export const monitorObservationRowSchema = z
  .object({
    id: z.string(),
    monitor_id: z.string(),
    status: z.string(),
    previous_value: z.string().nullable(),
    current_value: z.string().nullable(),
    previous_evidence_version: pgInt.nullable(),
    current_evidence_version: pgInt.nullable(),
    evidence_hash: z.string().nullable(),
    condition_revision: pgInt,
    analysis_definition_version: pgInt.nullable(),
    analysis_run_id: z.string().nullable(),
    historical_analysis_run_id: z.string().nullable(),
    analysis_run_status: z.string().nullable(),
    analysis_window_json: z.unknown(),
    /** JSONB, CHECK object. */
    coverage_json: z.unknown(),
    reason_code: z.string(),
    reason: z.string(),
    checked_at: pgTimestamptz,
  })
  .describe("analysis_monitor_observations row");
export type MonitorObservationRow = z.output<
  typeof monitorObservationRowSchema
>;

/**
 * `MONITOR_SELECT`'s `row_to_json(o.*)`: JSON numbers for the INTEGER
 * columns and an ISO string for `checked_at`.
 */
export const monitorObservationJsonSchema = z.object({
  id: z.string(),
  monitor_id: z.string(),
  status: z.string(),
  previous_value: z.string().nullable(),
  current_value: z.string().nullable(),
  previous_evidence_version: z.number().nullable(),
  current_evidence_version: z.number().nullable(),
  analysis_definition_version: z.number().nullable(),
  analysis_run_id: z.string().nullable(),
  historical_analysis_run_id: z.string().nullable(),
  analysis_run_status: z.string().nullable(),
  analysis_window_json: z.unknown(),
  coverage_json: z.unknown(),
  reason_code: z.string(),
  reason: z.string(),
  checked_at: z.string(),
});
export type MonitorObservationJson = z.output<
  typeof monitorObservationJsonSchema
>;

/** `MONITOR_SELECT`: the monitor plus its latest observation (or NULL). */
export const analysisMonitorWithObservationRowSchema = analysisMonitorRowSchema
  .extend({ last_observation: monitorObservationJsonSchema.nullable() })
  .describe("analysis monitor with last observation row");

/** An `analysis_monitor_notifications` row (`SELECT *` / `RETURNING *`). */
export const monitorNotificationRowSchema = z
  .object({
    id: z.string(),
    monitor_id: z.string(),
    observation_id: z.string(),
    kind: z.string(),
    title: z.string(),
    reason_code: z.string(),
    reason: z.string(),
    previous_value: z.string().nullable(),
    current_value: z.string().nullable(),
    created_at: pgTimestamptz,
    read_at: pgTimestamptz.nullable(),
  })
  .describe("analysis_monitor_notifications row");
export type MonitorNotificationRow = z.output<
  typeof monitorNotificationRowSchema
>;

/** Bare `count(*)` totals of the notification inbox. */
export const monitorNotificationCountsRowSchema = z
  .object({ total: pgBigint, unread: pgBigint })
  .describe("analysis monitor notification counts row");

/** A monitor target: a saved analysis (`id,name,refresh_mode`). */
export const monitorSavedAnalysisTargetRowSchema = z
  .object({ id: z.string(), name: z.string(), refresh_mode: z.string() })
  .describe("analysis monitor saved analysis target row");

/** A monitor target: a research dossier (`id,title`). */
export const monitorDossierTargetRowSchema = z
  .object({ id: z.string(), title: z.string() })
  .describe("analysis monitor dossier target row");

/** `SELECT refresh_mode FROM saved_analyses`. */
export const refreshModeRowSchema = z
  .object({ refresh_mode: z.string() })
  .describe("saved analysis refresh mode row");

/** `SELECT status FROM saved_analysis_runs`. */
export const runStatusRowSchema = z
  .object({ status: z.string() })
  .describe("saved analysis run status row");

/** The parts of a stored run result a monitor reads. */
export interface MonitorRunResult {
  window?: {
    kind?: string;
    offset?: number;
    hasMore?: boolean;
    returnedRows?: number;
  };
  rows?: Array<Record<string, unknown>>;
  formulaErrors?: unknown;
}

/** A run joined to its saved analysis and the current definition. */
export const monitorRunRowSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    /** NOT NULL exactly when status is completed or partial. */
    result_json: storedJsonObject<MonitorRunResult>().nullable(),
    definition_version: pgInt,
    current_version: pgInt,
    definition_json: storedJsonObject<AnalysisDefinition>(),
  })
  .describe("analysis monitor run row");
export type MonitorRunRow = z.output<typeof monitorRunRowSchema>;

/** `SELECT version,content_json FROM research_dossiers` (monitor read). */
export const monitorDossierRowSchema = z
  .object({
    version: pgInt,
    /** JSONB, CHECK object. */
    content_json: z.record(z.string(), z.unknown()),
  })
  .describe("analysis monitor dossier row");

// ---------------------------------------------------------------------------
// Research dossiers
// ---------------------------------------------------------------------------

/** A `research_dossiers` row (`SELECT *` / `RETURNING *`). */
export const researchDossierRowSchema = z
  .object({
    id: z.string(),
    version: pgInt,
    workspace: z.string(),
    title: z.string(),
    /** JSONB, CHECK object; written from `normalizeContent`. */
    content_json: storedJsonObject<DossierContent>(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
  })
  .describe("research_dossiers row");
export type ResearchDossierRow = z.output<typeof researchDossierRowSchema>;

/** `listResearchDossiers`' summary projection. */
export const researchDossierSummaryRowSchema = z
  .object({
    id: z.string(),
    version: pgInt,
    workspace: z.string(),
    title: z.string(),
    /** `content_json->>'question'`: NULL when absent. */
    question: z.string().nullable(),
    /** `content_json->>'reviewDate'`: NULL when absent or JSON null. */
    review_date: z.string().nullable(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
  })
  .describe("research dossier summary row");

/** A `research_dossier_links` row as `hydrate` projects it. */
export const researchDossierLinkRowSchema = z
  .object({
    link_type: z.string(),
    historical_id: z.string(),
    label_snapshot: z.string(),
    category_id: pgInt.nullable(),
    investment_id: pgInt.nullable(),
    saved_analysis_id: z.string().nullable(),
  })
  .describe("research_dossier_links row");

/** The links whose live target was deleted (`replaceLinks`). */
export const researchDossierUnavailableLinkRowSchema =
  researchDossierLinkRowSchema
    .pick({ link_type: true, historical_id: true, label_snapshot: true })
    .describe("research_dossier_links unavailable row");

/** A dossier link target's label (`path_name` / `name`, both TEXT). */
export const researchDossierLinkLabelRowSchema = z
  .object({ label: z.unknown() })
  .describe("research dossier link label row");

/** The cited document's provenance (`validateDocuments`). */
export const researchDossierDocumentRowSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    version: pgInt,
    content_sha256: z.string(),
  })
  .describe("research dossier document row");

/** A `research_dossier_versions` row as `listResearchDossierVersions` reads it. */
export const researchDossierVersionRowSchema = z
  .object({
    version: pgInt,
    snapshot_json: z.unknown(),
    created_at: pgTimestamptz,
  })
  .describe("research_dossier_versions row");

/** `restoreResearchDossier`'s snapshot read. */
export const researchDossierSnapshotRowSchema = researchDossierVersionRowSchema
  .pick({ snapshot_json: true })
  .describe("research_dossier_versions snapshot row");

// ---------------------------------------------------------------------------
// Analysis executor (fixed session queries only; user SQL is dynamic)
// ---------------------------------------------------------------------------

/** `SELECT pg_backend_pid() AS pid` (INTEGER). */
export const backendPidRowSchema = z
  .object({ pid: pgInt })
  .describe("backend pid row");

/** `SELECT pg_cancel_backend($1) AS cancelled` (BOOLEAN). */
export const cancelBackendRowSchema = z
  .object({ cancelled: z.boolean() })
  .describe("cancel backend row");
