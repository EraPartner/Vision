/**
 * Row schemas for the AI repositories (ADR-193): chat, investigations,
 * disclosure grants, research documents and reversible references.
 *
 * Like `../rowSchemas.ts`, each schema describes what node-postgres returns
 * with its default parsers and only checks; callers receive pg's own objects.
 * Most projections alias snake_case columns to camelCase in SQL, so the keys
 * below are the aliases.
 */
import { z } from "zod";
import type { AiInvestigationPlan } from "@vision/types/aiResearch";
import { pgBigint, pgInt, pgTimestamptz } from "../rowSchemas.ts";

/** A UUID column. */
const pgUuid = z.string();

/** A JSONB column constrained (by its only writers) to a JSON object. */
export const jsonObject = z.record(z.string(), z.unknown());

/**
 * A JSONB object column whose deep shape Vision itself wrote and whose
 * readers re-validate what they depend on. The check proves the column holds
 * a JSON object; the static type names what Vision stored there.
 */
export function storedJsonObject<T extends object>() {
  return z.custom<T>(
    (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value),
    { message: "expected a JSON object" },
  );
}

// ---------------------------------------------------------------------------
// AI chat (ai_conversations + ai_messages)
// ---------------------------------------------------------------------------

/** `aiChatRepository`'s `CONVERSATION_COLUMNS` (timestamps aliased to camelCase). */
export const aiConversationRowSchema = z
  .object({
    id: pgUuid,
    title: z.string(),
    model: z.string(),
    createdAt: pgTimestamptz,
    updatedAt: pgTimestamptz,
  })
  .describe("ai_conversations row");
export type AiConversationRow = z.output<typeof aiConversationRowSchema>;

/** `aiChatRepository`'s `MESSAGE_COLUMNS` (snake_case aliased to camelCase). */
export const aiMessageRowSchema = z
  .object({
    id: pgUuid,
    conversationId: pgUuid,
    /** CHECK (role IN ('user','assistant','tool','system')). */
    role: z.enum(["user", "assistant", "tool", "system"]),
    content: z.string().nullable(),
    toolName: z.string().nullable(),
    /**
     * JSONB: the args the tool actually received (the dispatcher-coerced
     * object); when coercion failed, the raw model-emitted value (for example
     * a malformed JSON string). NULL on non-tool rows.
     */
    toolArgs: z.unknown(),
    /** JSONB: the tool's result envelope, or NULL. */
    toolResult: z.unknown(),
    /** CHECK (status IN ('complete','streaming','aborted','error')). */
    status: z.enum(["complete", "streaming", "aborted", "error"]),
    createdAt: pgTimestamptz,
  })
  .describe("ai_messages row");
export type AiMessageRow = z.output<typeof aiMessageRowSchema>;

/** `SELECT COUNT(*)::int AS total`. */
export const intTotalRowSchema = z
  .object({ total: pgInt })
  .describe("int total row");

/** A `RETURNING id` row of a UUID-keyed table. */
export const uuidIdRowSchema = z.object({ id: pgUuid }).describe("uuid id row");

// ---------------------------------------------------------------------------
// AI investigations (ai_investigation_jobs + ai_investigation_steps)
// ---------------------------------------------------------------------------

/** `aiInvestigationRepository`'s `COLUMNS` projection. */
export const aiInvestigationJobRowSchema = z
  .object({
    id: pgUuid,
    conversationId: pgUuid.nullable(),
    question: z.string(),
    route: z.string(),
    model: z.string().nullable(),
    depth: z.string(),
    language: z.string(),
    state: z.string(),
    /**
     * `scope_json` (NOT NULL, no shape constraint): the
     * `{ scope, researchMode, ... }` envelope, or the bare scope on jobs
     * created before the envelope existed. The service narrows it.
     */
    scope: z.unknown(),
    /** `plan_json`: a plan Vision parsed with `aiInvestigationPlanSchema`. */
    plan: storedJsonObject<AiInvestigationPlan>().nullable(),
    /**
     * `checkpoint_json` (NOT NULL, default `{}`, only changed by `jsonb_set`
     * and `- 'providerResult'`, which keep it an object).
     */
    checkpoint: jsonObject,
    /** `result_json`: the stored answer. */
    result: z.unknown(),
    /** `error_json`: usually `{ code, message }`. */
    error: z.unknown(),
    grantId: pgUuid.nullable(),
    cancelRequestedAt: pgTimestamptz.nullable(),
    startedAt: pgTimestamptz.nullable(),
    completedAt: pgTimestamptz.nullable(),
    createdAt: pgTimestamptz,
    updatedAt: pgTimestamptz,
  })
  .describe("ai_investigation_jobs row");
export type AiInvestigationJobRow = z.output<
  typeof aiInvestigationJobRowSchema
>;

/** `getSteps` projection. */
export const aiInvestigationStepRowSchema = z
  .object({
    stepId: z.string(),
    state: z.string(),
    attempt: pgInt,
    /** `result_json`: the tool result envelope, or NULL. */
    result: z.unknown(),
    /** `error_json`. */
    error: z.unknown(),
    startedAt: pgTimestamptz.nullable(),
    completedAt: pgTimestamptz.nullable(),
  })
  .describe("ai_investigation_steps row");
export type AiInvestigationStepRow = z.output<
  typeof aiInvestigationStepRowSchema
>;

/** `startStep`'s `RETURNING *` (raw `ai_investigation_steps` columns). */
export const aiInvestigationStepTableRowSchema = z
  .object({
    job_id: pgUuid,
    step_id: z.string(),
    state: z.string(),
    attempt: pgInt,
    result_json: z.unknown(),
    error_json: z.unknown(),
    started_at: pgTimestamptz.nullable(),
    completed_at: pgTimestamptz.nullable(),
    updated_at: pgTimestamptz,
  })
  .describe("ai_investigation_steps table row");
export type AiInvestigationStepTableRow = z.output<
  typeof aiInvestigationStepTableRowSchema
>;

// ---------------------------------------------------------------------------
// AI disclosure (ai_disclosure_grants + ai_disclosure_records)
// ---------------------------------------------------------------------------

/** An `ai_disclosure_grants` row (`SELECT *` / `RETURNING *`). */
export const aiDisclosureGrantRowSchema = z
  .object({
    id: pgUuid,
    route: z.string(),
    mode: z.string(),
    purpose: z.string(),
    preview_payload_sha256: z.string(),
    /** JSONB array of approved field names. */
    allowed_fields_json: z.array(z.string()),
    max_requests: pgInt,
    max_input_characters: pgInt,
    max_output_tokens: pgInt,
    max_cost_micros: pgBigint,
    max_disclosure_units: pgInt,
    used_requests: pgInt,
    used_input_characters: pgBigint,
    used_output_tokens: pgBigint,
    used_cost_micros: pgBigint,
    policy_version: pgInt,
    retain_exact_payload: z.boolean(),
    expires_at: pgTimestamptz,
    revoked_at: pgTimestamptz.nullable(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
  })
  .describe("ai_disclosure_grants row");
export type AiDisclosureGrantRow = z.output<typeof aiDisclosureGrantRowSchema>;

/** An `ai_disclosure_records` row (`SELECT *` / `RETURNING *`). */
export const aiDisclosureRecordRowSchema = z
  .object({
    id: pgUuid,
    grant_id: pgUuid,
    job_id: pgUuid.nullable(),
    route: z.string(),
    mode: z.string(),
    purpose: z.string(),
    /** JSONB array of disclosed field names. */
    field_manifest_json: z.array(z.string()),
    /** JSONB array of disclosure unit ids. */
    disclosure_units_json: z.array(z.string()),
    payload_sha256: z.string(),
    payload_bytes: pgInt,
    reserved_output_tokens: pgInt,
    reserved_cost_micros: pgBigint,
    actual_input_tokens: pgInt.nullable(),
    actual_output_tokens: pgInt.nullable(),
    actual_cost_micros: pgBigint.nullable(),
    status: z.string(),
    provider_request_id: z.string().nullable(),
    policy_snapshot_json: z.unknown(),
    error_code: z.string().nullable(),
    created_at: pgTimestamptz,
    completed_at: pgTimestamptz.nullable(),
  })
  .describe("ai_disclosure_records row");
export type AiDisclosureRecordRow = z.output<
  typeof aiDisclosureRecordRowSchema
>;

/** `reserveDisclosure`'s prior-units read. */
export const disclosureUnitsRowSchema = aiDisclosureRecordRowSchema
  .pick({ disclosure_units_json: true })
  .describe("ai_disclosure_records units row");

/** `COALESCE(SUM(bigint), 0)` is NUMERIC: a string. */
export const disclosureMonthlyTotalRowSchema = z
  .object({ total: z.string() })
  .describe("ai disclosure monthly total row");

// ---------------------------------------------------------------------------
// Research documents (ai_research_documents + ai_research_passages)
// ---------------------------------------------------------------------------

/** `aiResearchDocumentRepository`'s `DOCUMENT_COLUMNS` (camelCase aliases). */
export const researchDocumentRowSchema = z
  .object({
    id: pgUuid,
    title: z.string(),
    sourceName: z.string(),
    mediaType: z.string(),
    contentSha256: z.string(),
    version: pgInt,
    extractionStatus: z.string(),
    extractionError: z.string().nullable(),
    createdAt: pgTimestamptz,
    updatedAt: pgTimestamptz,
  })
  .describe("ai_research_documents row");
export type ResearchDocumentRow = z.output<typeof researchDocumentRowSchema>;

/** `COALESCE(MAX(version),0)+1`: INTEGER arithmetic, a number. */
export const nextVersionRowSchema = z
  .object({ version: pgInt })
  .describe("next research document version row");

/** `embedding_json` as `createDocument` writes it. */
export const researchPassageEmbeddingSchema = z.object({
  model: z.string(),
  vector: z.array(z.number()),
});
export type ResearchPassageEmbedding = z.output<
  typeof researchPassageEmbeddingSchema
>;

/** A passage joined to its document (`semanticCandidates`). */
export const researchPassageRowSchema = z
  .object({
    id: pgUuid,
    documentId: pgUuid,
    ordinal: pgInt,
    pageNumber: pgInt.nullable(),
    section: z.string().nullable(),
    content: z.string(),
    embedding: researchPassageEmbeddingSchema.nullable(),
    title: z.string(),
    sourceName: z.string(),
    version: pgInt,
    documentHash: z.string(),
  })
  .describe("ai_research_passages row");
export type ResearchPassageRow = z.output<typeof researchPassageRowSchema>;

/** `keywordSearch`: `ts_rank_cd()` is REAL, which pg parses to a number. */
export const scoredResearchPassageRowSchema = researchPassageRowSchema
  .extend({ score: z.number() })
  .describe("scored ai_research_passages row");
export type ScoredResearchPassageRow = z.output<
  typeof scoredResearchPassageRowSchema
>;

// ---------------------------------------------------------------------------
// Reversible references (ai_reference_scopes + ai_reference_entries)
// ---------------------------------------------------------------------------

export const aiReferenceScopeRowSchema = z
  .object({
    id: pgUuid,
    jobId: pgUuid.nullable(),
    expiresAt: pgTimestamptz,
  })
  .describe("ai_reference_scopes row");
export type AiReferenceScopeRow = z.output<typeof aiReferenceScopeRowSchema>;

/** BYTEA columns arrive as Buffers. */
export const aiReferenceEntryRowSchema = z
  .object({
    token: z.string(),
    referenceType: z.string(),
    ciphertext: z.instanceof(Buffer),
    nonce: z.instanceof(Buffer),
    authTag: z.instanceof(Buffer),
  })
  .describe("ai_reference_entries row");
export type AiReferenceEntry = z.output<typeof aiReferenceEntryRowSchema>;
