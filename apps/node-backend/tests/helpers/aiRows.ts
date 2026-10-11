/**
 * Synthetic AI, analysis and audit rows shaped exactly like node-postgres
 * returns them (BIGINT as strings, TIMESTAMPTZ as `Date`, JSONB parsed), for
 * tests that mock `query()` under the checked reads of those repositories and
 * services. Pass `overrides` for the columns a test cares about.
 */
import type {
  AiConversationRow,
  AiDisclosureGrantRow,
  AiDisclosureRecordRow,
  AiInvestigationJobRow,
  AiInvestigationStepRow,
  AiMessageRow,
} from "../../src/database/rows/ai.ts";
import type {
  AnalysisMonitorRow,
  MonitorNotificationRow,
  MonitorObservationRow,
  ResearchDossierRow,
  SavedAnalysisRow,
  SavedAnalysisTableRow,
} from "../../src/database/rows/analysis.ts";

const CREATED = new Date("2026-01-01T00:00:00.000Z");
const UUID = "00000000-0000-4000-8000-000000000001";

export function conversationRow(
  overrides: Partial<AiConversationRow> = {},
): AiConversationRow {
  return {
    id: UUID,
    title: "Synthetic conversation",
    model: "synthetic-model",
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function messageRow(
  overrides: Partial<AiMessageRow> = {},
): AiMessageRow {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    conversationId: UUID,
    role: "user",
    content: "Synthetic message",
    toolName: null,
    toolArgs: null,
    toolResult: null,
    status: "complete",
    createdAt: CREATED,
    ...overrides,
  };
}

export function investigationJobRow(
  overrides: Partial<AiInvestigationJobRow> = {},
): AiInvestigationJobRow {
  return {
    id: UUID,
    conversationId: null,
    question: "Synthetic question",
    route: "local",
    model: null,
    depth: "quick",
    language: "en",
    state: "queued",
    scope: { scope: {} },
    plan: null,
    checkpoint: {},
    result: null,
    error: null,
    grantId: null,
    cancelRequestedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function investigationStepRow(
  overrides: Partial<AiInvestigationStepRow> = {},
): AiInvestigationStepRow {
  return {
    stepId: "step",
    state: "pending",
    attempt: 0,
    result: null,
    error: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

export function disclosureGrantRow(
  overrides: Partial<AiDisclosureGrantRow> = {},
): AiDisclosureGrantRow {
  return {
    id: UUID,
    route: "openai-api",
    mode: "cloud-plan-public",
    purpose: "Synthetic test",
    preview_payload_sha256: "a".repeat(64),
    allowed_fields_json: [],
    max_requests: 1,
    max_input_characters: 1000,
    max_output_tokens: 1000,
    max_cost_micros: "1000",
    max_disclosure_units: 10,
    used_requests: 0,
    used_input_characters: "0",
    used_output_tokens: "0",
    used_cost_micros: "0",
    policy_version: 1,
    retain_exact_payload: false,
    expires_at: new Date(Date.now() + 60_000),
    revoked_at: null,
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

export function disclosureRecordRow(
  overrides: Partial<AiDisclosureRecordRow> = {},
): AiDisclosureRecordRow {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    grant_id: UUID,
    job_id: null,
    route: "openai-api",
    mode: "cloud-plan-public",
    purpose: "Synthetic test",
    field_manifest_json: [],
    disclosure_units_json: [],
    payload_sha256: "a".repeat(64),
    payload_bytes: 0,
    reserved_output_tokens: 0,
    reserved_cost_micros: "0",
    actual_input_tokens: null,
    actual_output_tokens: null,
    actual_cost_micros: null,
    status: "authorized",
    provider_request_id: null,
    policy_snapshot_json: {},
    error_code: null,
    created_at: CREATED,
    completed_at: null,
    ...overrides,
  };
}

export function savedAnalysisTableRow(
  overrides: Partial<SavedAnalysisTableRow> = {},
): SavedAnalysisTableRow {
  return {
    id: "analysis-1",
    definition_id: "analysis:definition-1",
    name: "Synthetic analysis",
    workspace: "budgeting",
    current_version: 1,
    refresh_mode: "live",
    parameters_json: {},
    charts_json: [],
    source_references_json: [],
    refresh_status: "never-run",
    last_successful_run_id: null,
    last_error_json: null,
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

export function savedAnalysisRow(
  overrides: Partial<SavedAnalysisRow> = {},
): SavedAnalysisRow {
  return {
    ...savedAnalysisTableRow(),
    definition_json: {} as SavedAnalysisRow["definition_json"],
    result_json: null,
    ...overrides,
  };
}

export function monitorRow(
  overrides: Partial<AnalysisMonitorRow> = {},
): AnalysisMonitorRow {
  return {
    id: UUID,
    kind: "analysis-threshold",
    title: "Synthetic monitor",
    enabled: true,
    saved_analysis_id: "analysis-1",
    dossier_id: null,
    historical_target_id: "analysis-1",
    target_label: "Synthetic analysis",
    field_id: "total",
    operator: "above",
    threshold: "100",
    interval_minutes: 1440,
    cooldown_minutes: 1440,
    next_due_at: CREATED,
    last_checked_at: null,
    last_status: null,
    condition_revision: 1,
    active_episode_key: null,
    pending_signature: null,
    pending_since: null,
    last_notified_at: null,
    lease_token: null,
    lease_expires_at: null,
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

export function observationRow(
  overrides: Partial<MonitorObservationRow> = {},
): MonitorObservationRow {
  return {
    id: "00000000-0000-4000-8000-000000000004",
    monitor_id: UUID,
    status: "baseline",
    previous_value: null,
    current_value: "1",
    previous_evidence_version: null,
    current_evidence_version: null,
    evidence_hash: null,
    condition_revision: 1,
    analysis_definition_version: 1,
    analysis_run_id: null,
    historical_analysis_run_id: null,
    analysis_run_status: null,
    analysis_window_json: null,
    coverage_json: { status: "unknown" },
    reason_code: "baseline",
    reason: "Synthetic reason",
    checked_at: CREATED,
    ...overrides,
  };
}

export function notificationRow(
  overrides: Partial<MonitorNotificationRow> = {},
): MonitorNotificationRow {
  return {
    id: "00000000-0000-4000-8000-000000000005",
    monitor_id: UUID,
    observation_id: "00000000-0000-4000-8000-000000000004",
    kind: "analysis-threshold",
    title: "Synthetic monitor",
    reason_code: "threshold-crossed",
    reason: "Synthetic reason",
    previous_value: null,
    current_value: "1",
    created_at: CREATED,
    read_at: null,
    ...overrides,
  };
}

export function dossierRow(
  overrides: Partial<ResearchDossierRow> = {},
): ResearchDossierRow {
  return {
    id: UUID,
    version: 1,
    workspace: "research",
    title: "Synthetic dossier",
    content_json: {} as ResearchDossierRow["content_json"],
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}
