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
} from "../../src/database/rows/ai.ts";

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
