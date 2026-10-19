import type { AiInvestigationRequest } from "@vision/types/aiResearch";
import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { Json } from "../database/schema.generated.ts";
import {
  aiInvestigationJobRowSchema,
  aiInvestigationStepRowSchema,
  aiInvestigationStepTableRowSchema,
  uuidIdRowSchema,
} from "../database/rows/ai.ts";
import type {
  AiInvestigationJobRow,
  AiInvestigationStepRow,
  AiInvestigationStepTableRow,
} from "../database/rows/ai.ts";

/*
 * The JSONB columns hold shapes that changed over time (for example `scope`
 * is either the bare scope or the `{ scope, researchMode, ... }` envelope),
 * so the row types leave them `unknown` and the service narrows them.
 */
export type { AiInvestigationJobRow, AiInvestigationStepRow };

const COLUMNS = [
  "id",
  "conversation_id as conversationId",
  "question",
  "route",
  "model",
  "depth",
  "language",
  "state",
  "scope_json as scope",
  "plan_json as plan",
  "checkpoint_json as checkpoint",
  "result_json as result",
  "error_json as error",
  "grant_id as grantId",
  "cancel_requested_at as cancelRequestedAt",
  "started_at as startedAt",
  "completed_at as completedAt",
  "created_at as createdAt",
  "updated_at as updatedAt",
] as const;

const now = () => sql<Date>`NOW()`;

function jsonb(value: unknown) {
  return sql<Json>`${JSON.stringify(value)}::jsonb`;
}

function nullableJsonb(value: unknown) {
  return value == null ? null : jsonb(value);
}

function selectJobs() {
  return db.selectFrom("ai_investigation_jobs").select(COLUMNS);
}

export async function createJob(
  request: AiInvestigationRequest & { conversationId?: string | null },
  referenceExpiresAt: string | null = null,
): Promise<AiInvestigationJobRow> {
  return withTransaction(async () => {
    const job = await checkedRow(
      aiInvestigationJobRowSchema,
      db
        .insertInto("ai_investigation_jobs")
        .values({
          conversation_id: request.conversationId ?? null,
          question: request.question,
          route: request.route,
          model: request.model,
          depth: request.depth,
          language: request.language,
          state: "queued",
          scope_json: jsonb({
            scope: request.scope,
            researchMode: request.researchMode,
            publicQuestion: request.publicQuestion,
            publicWebQuery: request.publicWebQuery,
            publicSymbols: request.publicSymbols,
            publicMacroQueries: request.publicMacroQueries,
            clarification: request.clarification,
            selectedSummary: request.selectedSummary,
            selectedEvidence: request.selectedEvidence,
            referenceScopeId: request.referenceScopeId,
            savedAnalysisId: request.savedAnalysisId,
          }),
          grant_id: request.grantId,
        })
        .returning(COLUMNS),
    );
    if (!job) throw new Error("ai_investigation_jobs insert returned no row");
    if (request.referenceScopeId) {
      const claimed = await checkedRow(
        uuidIdRowSchema,
        db
          .updateTable("ai_reference_scopes")
          .set({
            job_id: job.id,
            claimed_at: now(),
            expires_at: sql<Date>`${referenceExpiresAt}::timestamptz`,
          })
          .where("id", "=", request.referenceScopeId)
          .where("job_id", "is", null)
          .where("expires_at", ">", now())
          .returning("id"),
      );
      if (!claimed)
        throw Object.assign(
          new Error(
            "The reversible reference preview expired or was already used",
          ),
          { code: "REFERENCE_SCOPE_INACTIVE", status: 409 },
        );
    }
    return job;
  });
}
export async function listJobs(): Promise<AiInvestigationJobRow[]> {
  return checkedRows(
    aiInvestigationJobRowSchema,
    selectJobs().orderBy("updated_at", "desc").limit(200),
  );
}
export async function listRecoverableJobs(): Promise<AiInvestigationJobRow[]> {
  return checkedRows(
    aiInvestigationJobRowSchema,
    selectJobs()
      .where("state", "in", ["queued", "running"])
      .where("cancel_requested_at", "is", null)
      .orderBy("created_at", "asc"),
  );
}
export async function getJob(
  id: string,
): Promise<AiInvestigationJobRow | null> {
  return (
    (await checkedRow(
      aiInvestigationJobRowSchema,
      selectJobs().where("id", "=", id),
    )) ?? null
  );
}
export async function setPlan(
  id: string,
  plan: unknown,
): Promise<AiInvestigationJobRow | null> {
  return (
    (await checkedRow(
      aiInvestigationJobRowSchema,
      db
        .updateTable("ai_investigation_jobs")
        .set({
          plan_json: jsonb(plan),
          state: "running",
          started_at: sql<Date>`COALESCE(started_at,NOW())`,
          updated_at: now(),
        })
        .where("id", "=", id)
        .where("cancel_requested_at", "is", null)
        .returning(COLUMNS),
    )) ?? null
  );
}
export async function setWaiting(
  id: string,
  plan: unknown,
): Promise<AiInvestigationJobRow | null> {
  return (
    (await checkedRow(
      aiInvestigationJobRowSchema,
      db
        .updateTable("ai_investigation_jobs")
        .set({ plan_json: jsonb(plan), state: "waiting", updated_at: now() })
        .where("id", "=", id)
        .where("cancel_requested_at", "is", null)
        .returning(COLUMNS),
    )) ?? null
  );
}
export async function resolveWaiting(
  id: string,
  clarification: string,
  scope: unknown,
): Promise<AiInvestigationJobRow | null> {
  return (
    (await checkedRow(
      aiInvestigationJobRowSchema,
      db
        .updateTable("ai_investigation_jobs")
        .set({
          scope_json: sql<Json>`jsonb_set(jsonb_set(scope_json,'{clarification}',to_jsonb(${clarification}::text),true),'{scope}',${JSON.stringify(scope)}::jsonb,true)`,
          plan_json: null,
          state: "queued",
          updated_at: now(),
        })
        .where("id", "=", id)
        .where("state", "=", "waiting")
        .where("cancel_requested_at", "is", null)
        .returning(COLUMNS),
    )) ?? null
  );
}
export async function seedSteps(
  id: string,
  steps: readonly { id: string }[],
): Promise<void> {
  for (const step of steps)
    await db
      .insertInto("ai_investigation_steps")
      .values({ job_id: id, step_id: step.id, state: "pending" })
      .onConflict((oc) => oc.doNothing())
      .execute();
}
export async function getSteps(id: string): Promise<AiInvestigationStepRow[]> {
  return checkedRows(
    aiInvestigationStepRowSchema,
    db
      .selectFrom("ai_investigation_steps")
      .select([
        "step_id as stepId",
        "state",
        "attempt",
        "result_json as result",
        "error_json as error",
        "started_at as startedAt",
        "completed_at as completedAt",
      ])
      .where("job_id", "=", id)
      .orderBy("step_id"),
  );
}
export async function startStep(
  jobId: string,
  stepId: string,
): Promise<AiInvestigationStepTableRow | null> {
  return (
    (await checkedRow(
      aiInvestigationStepTableRowSchema,
      db
        .updateTable("ai_investigation_steps")
        .set((eb) => ({
          state: "running",
          attempt: eb("attempt", "+", 1),
          started_at: now(),
          updated_at: now(),
        }))
        .where("job_id", "=", jobId)
        .where("step_id", "=", stepId)
        .where("state", "<>", "completed")
        .returningAll(),
    )) ?? null
  );
}
export async function finishStep(
  jobId: string,
  stepId: string,
  result: unknown,
  error: unknown = null,
): Promise<void> {
  await db
    .updateTable("ai_investigation_steps")
    .set({
      state: error ? "failed" : "completed",
      result_json: nullableJsonb(result),
      error_json: nullableJsonb(error),
      completed_at: now(),
      updated_at: now(),
    })
    .where("job_id", "=", jobId)
    .where("step_id", "=", stepId)
    .execute();
}

export async function resetSteps(
  jobId: string,
  stepIds: readonly string[],
): Promise<number> {
  if (stepIds.length === 0) return 0;
  const result = await db
    .updateTable("ai_investigation_steps")
    .set({
      state: "pending",
      result_json: null,
      error_json: null,
      started_at: null,
      completed_at: null,
      updated_at: now(),
    })
    .where("job_id", "=", jobId)
    .where(sql<boolean>`step_id = ANY(${stepIds}::text[])`)
    .where("state", "=", "completed")
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
export async function finishJob(
  id: string,
  state: string,
  result: unknown,
  error: unknown = null,
): Promise<AiInvestigationJobRow | undefined> {
  const resultJson = result == null ? null : JSON.stringify(result);
  const errorJson = error == null ? null : JSON.stringify(error);
  return checkedRow(
    aiInvestigationJobRowSchema,
    db
      .updateTable("ai_investigation_jobs")
      .set({
        state: sql<string>`CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE ${state}::text END`,
        result_json: sql<Json | null>`CASE WHEN cancel_requested_at IS NOT NULL THEN NULL ELSE ${resultJson}::jsonb END`,
        error_json: sql<Json | null>`CASE WHEN cancel_requested_at IS NOT NULL
             THEN '{"code":"CANCELLED"}'::jsonb ELSE ${errorJson}::jsonb END`,
        completed_at: sql<Date | null>`CASE WHEN cancel_requested_at IS NOT NULL
             OR ${state}::text IN ('completed','failed','cancelled') THEN NOW() ELSE NULL END`,
        updated_at: now(),
      })
      .where("id", "=", id)
      .returning(COLUMNS),
  );
}

export async function setProviderResult(
  id: string,
  result: unknown,
): Promise<{ id: string } | undefined> {
  return checkedRow(
    uuidIdRowSchema,
    db
      .updateTable("ai_investigation_jobs")
      .set({
        checkpoint_json: sql<Json>`jsonb_set(checkpoint_json,'{providerResult}',${JSON.stringify(result)}::jsonb,true)`,
        updated_at: now(),
      })
      .where("id", "=", id)
      .where("cancel_requested_at", "is", null)
      .returning("id"),
  );
}

export async function clearProviderResult(
  id: string,
): Promise<{ id: string } | undefined> {
  return checkedRow(
    uuidIdRowSchema,
    db
      .updateTable("ai_investigation_jobs")
      .set({
        checkpoint_json: sql<Json>`checkpoint_json - 'providerResult'`,
        updated_at: now(),
      })
      .where("id", "=", id)
      .returning("id"),
  );
}
export async function requestCancel(
  id: string,
): Promise<AiInvestigationJobRow | null> {
  return (
    (await checkedRow(
      aiInvestigationJobRowSchema,
      db
        .updateTable("ai_investigation_jobs")
        .set({
          cancel_requested_at: now(),
          state: sql<string>`CASE WHEN state='queued' THEN 'cancelled' ELSE state END`,
          checkpoint_json: sql<Json>`checkpoint_json - 'providerResult'`,
          updated_at: now(),
        })
        .where("id", "=", id)
        .where("state", "not in", ["completed", "failed", "cancelled"])
        .returning(COLUMNS),
    )) ?? null
  );
}
export async function deleteJob(id: string): Promise<boolean> {
  const rows = await db
    .deleteFrom("ai_investigation_jobs")
    .where("id", "=", id)
    .returning("id")
    .execute();
  return rows.length > 0;
}
