/**
 * Row schemas for the AI repositories (ADR-193): chat, investigations,
 * research documents.
 *
 * Like `../rowSchemas.ts`, each schema describes what the database driver
 * returns (the node-postgres shapes, ADR-263) and only checks; callers receive
 * the driver's own objects.
 * Most projections alias snake_case columns to camelCase in SQL, so the keys
 * below are the aliases.
 */
import { z } from "zod";
import type { AiInvestigationPlan } from "@vision/types/aiResearch";
import { dbInt, dbTimestamptz } from "../rowSchemas.ts";

/** A UUID column. */
const dbUuid = z.string();

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
    id: dbUuid,
    title: z.string(),
    model: z.string(),
    createdAt: dbTimestamptz,
    updatedAt: dbTimestamptz,
  })
  .describe("ai_conversations row");
export type AiConversationRow = z.output<typeof aiConversationRowSchema>;

/** `aiChatRepository`'s `MESSAGE_COLUMNS` (snake_case aliased to camelCase). */
export const aiMessageRowSchema = z
  .object({
    id: dbUuid,
    conversationId: dbUuid,
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
    createdAt: dbTimestamptz,
  })
  .describe("ai_messages row");
export type AiMessageRow = z.output<typeof aiMessageRowSchema>;

/** `SELECT count(*) AS total` (a bare SQLite count is a number). */
export const intTotalRowSchema = z
  .object({ total: dbInt })
  .describe("int total row");

/** A `RETURNING id` row of a UUID-keyed table. */
export const uuidIdRowSchema = z.object({ id: dbUuid }).describe("uuid id row");

// ---------------------------------------------------------------------------
// AI investigations (ai_investigation_jobs + ai_investigation_steps)
// ---------------------------------------------------------------------------

/** `aiInvestigationRepository`'s `COLUMNS` projection. */
export const aiInvestigationJobRowSchema = z
  .object({
    id: dbUuid,
    conversationId: dbUuid.nullable(),
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
     * `checkpoint_json` (NOT NULL, default `{}`, only changed by `json_set`
     * and `json_remove(..., '$.providerResult')`, which keep it an object).
     */
    checkpoint: jsonObject,
    /** `result_json`: the stored answer. */
    result: z.unknown(),
    /** `error_json`: usually `{ code, message }`. */
    error: z.unknown(),
    cancelRequestedAt: dbTimestamptz.nullable(),
    startedAt: dbTimestamptz.nullable(),
    completedAt: dbTimestamptz.nullable(),
    createdAt: dbTimestamptz,
    updatedAt: dbTimestamptz,
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
    attempt: dbInt,
    /** `result_json`: the tool result envelope, or NULL. */
    result: z.unknown(),
    /** `error_json`. */
    error: z.unknown(),
    startedAt: dbTimestamptz.nullable(),
    completedAt: dbTimestamptz.nullable(),
  })
  .describe("ai_investigation_steps row");
export type AiInvestigationStepRow = z.output<
  typeof aiInvestigationStepRowSchema
>;

/** `startStep`'s `RETURNING *` (raw `ai_investigation_steps` columns). */
export const aiInvestigationStepTableRowSchema = z
  .object({
    job_id: dbUuid,
    step_id: z.string(),
    state: z.string(),
    attempt: dbInt,
    result_json: z.unknown(),
    error_json: z.unknown(),
    started_at: dbTimestamptz.nullable(),
    completed_at: dbTimestamptz.nullable(),
    updated_at: dbTimestamptz,
  })
  .describe("ai_investigation_steps table row");
export type AiInvestigationStepTableRow = z.output<
  typeof aiInvestigationStepTableRowSchema
>;

// ---------------------------------------------------------------------------
// Research documents (ai_research_documents + ai_research_passages)
// ---------------------------------------------------------------------------

/** `aiResearchDocumentRepository`'s `DOCUMENT_COLUMNS` (camelCase aliases). */
export const researchDocumentRowSchema = z
  .object({
    id: dbUuid,
    title: z.string(),
    sourceName: z.string(),
    mediaType: z.string(),
    contentSha256: z.string(),
    version: dbInt,
    extractionStatus: z.string(),
    extractionError: z.string().nullable(),
    createdAt: dbTimestamptz,
    updatedAt: dbTimestamptz,
  })
  .describe("ai_research_documents row");
export type ResearchDocumentRow = z.output<typeof researchDocumentRowSchema>;

/** `COALESCE(MAX(version),0)+1`: INTEGER arithmetic, a number. */
export const nextVersionRowSchema = z
  .object({ version: dbInt })
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
    id: dbUuid,
    documentId: dbUuid,
    ordinal: dbInt,
    pageNumber: dbInt.nullable(),
    section: z.string().nullable(),
    content: z.string(),
    embedding: researchPassageEmbeddingSchema.nullable(),
    title: z.string(),
    sourceName: z.string(),
    version: dbInt,
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
