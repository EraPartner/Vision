import type { AiInvestigationRequest } from "@vision/types/aiResearch";
import { query, withTransaction } from "../database/connection.ts";
import { queryOne, queryRows } from "../database/rowContracts.ts";
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

const COLUMNS = `id,conversation_id AS "conversationId",question,route,model,depth,language,state,
 scope_json AS scope,plan_json AS plan,checkpoint_json AS checkpoint,result_json AS result,
 error_json AS error,grant_id AS "grantId",cancel_requested_at AS "cancelRequestedAt",
 started_at AS "startedAt",completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"`;

export async function createJob(
  request: AiInvestigationRequest & { conversationId?: string | null },
  referenceExpiresAt: string | null = null,
): Promise<AiInvestigationJobRow> {
  return withTransaction(async (client) => {
    const job = await queryOne(
      aiInvestigationJobRowSchema,
      `INSERT INTO ai_investigation_jobs (conversation_id,question,route,model,depth,language,state,scope_json,grant_id)
     VALUES ($1,$2,$3,$4,$5,$6,'queued',$7::jsonb,$8) RETURNING ${COLUMNS}`,
      [
        request.conversationId ?? null,
        request.question,
        request.route,
        request.model,
        request.depth,
        request.language,
        JSON.stringify({
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
        request.grantId,
      ],
      client,
    );
    if (!job) throw new Error("ai_investigation_jobs insert returned no row");
    if (request.referenceScopeId) {
      const claimed = await queryOne(
        uuidIdRowSchema,
        `UPDATE ai_reference_scopes
           SET job_id=$2,claimed_at=NOW(),expires_at=$3
           WHERE id=$1 AND job_id IS NULL AND expires_at > NOW()
           RETURNING id`,
        [request.referenceScopeId, job.id, referenceExpiresAt],
        client,
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
  return queryRows(
    aiInvestigationJobRowSchema,
    `SELECT ${COLUMNS} FROM ai_investigation_jobs ORDER BY updated_at DESC LIMIT 200`,
  );
}
export async function listRecoverableJobs(): Promise<AiInvestigationJobRow[]> {
  return queryRows(
    aiInvestigationJobRowSchema,
    `SELECT ${COLUMNS} FROM ai_investigation_jobs
       WHERE state IN ('queued','running') AND cancel_requested_at IS NULL
       ORDER BY created_at ASC`,
  );
}
export async function getJob(
  id: string,
): Promise<AiInvestigationJobRow | null> {
  return (
    (await queryOne(
      aiInvestigationJobRowSchema,
      `SELECT ${COLUMNS} FROM ai_investigation_jobs WHERE id=$1`,
      [id],
    )) ?? null
  );
}
export async function setPlan(
  id: string,
  plan: unknown,
): Promise<AiInvestigationJobRow | null> {
  return (
    (await queryOne(
      aiInvestigationJobRowSchema,
      `UPDATE ai_investigation_jobs SET plan_json=$2::jsonb,state='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id=$1 AND cancel_requested_at IS NULL RETURNING ${COLUMNS}`,
      [id, JSON.stringify(plan)],
    )) ?? null
  );
}
export async function setWaiting(
  id: string,
  plan: unknown,
): Promise<AiInvestigationJobRow | null> {
  return (
    (await queryOne(
      aiInvestigationJobRowSchema,
      `UPDATE ai_investigation_jobs SET plan_json=$2::jsonb,state='waiting',updated_at=NOW() WHERE id=$1 AND cancel_requested_at IS NULL RETURNING ${COLUMNS}`,
      [id, JSON.stringify(plan)],
    )) ?? null
  );
}
export async function resolveWaiting(
  id: string,
  clarification: string,
  scope: unknown,
): Promise<AiInvestigationJobRow | null> {
  return (
    (await queryOne(
      aiInvestigationJobRowSchema,
      `UPDATE ai_investigation_jobs
       SET scope_json=jsonb_set(jsonb_set(scope_json,'{clarification}',to_jsonb($2::text),true),'{scope}',$3::jsonb,true),plan_json=NULL,state='queued',updated_at=NOW()
       WHERE id=$1 AND state='waiting' AND cancel_requested_at IS NULL RETURNING ${COLUMNS}`,
      [id, clarification, JSON.stringify(scope)],
    )) ?? null
  );
}
export async function seedSteps(
  id: string,
  steps: readonly { id: string }[],
): Promise<void> {
  for (const step of steps)
    await query(
      `INSERT INTO ai_investigation_steps (job_id,step_id,state) VALUES ($1,$2,'pending') ON CONFLICT DO NOTHING`,
      [id, step.id],
    );
}
export async function getSteps(id: string): Promise<AiInvestigationStepRow[]> {
  return queryRows(
    aiInvestigationStepRowSchema,
    `SELECT step_id AS "stepId",state,attempt,result_json AS result,error_json AS error,started_at AS "startedAt",completed_at AS "completedAt" FROM ai_investigation_steps WHERE job_id=$1 ORDER BY step_id`,
    [id],
  );
}
export async function startStep(
  jobId: string,
  stepId: string,
): Promise<AiInvestigationStepTableRow | null> {
  return (
    (await queryOne(
      aiInvestigationStepTableRowSchema,
      `UPDATE ai_investigation_steps SET state='running',attempt=attempt+1,started_at=NOW(),updated_at=NOW() WHERE job_id=$1 AND step_id=$2 AND state <> 'completed' RETURNING *`,
      [jobId, stepId],
    )) ?? null
  );
}
export async function finishStep(
  jobId: string,
  stepId: string,
  result: unknown,
  error: unknown = null,
): Promise<void> {
  await query(
    `UPDATE ai_investigation_steps SET state=$3,result_json=$4::jsonb,error_json=$5::jsonb,completed_at=NOW(),updated_at=NOW() WHERE job_id=$1 AND step_id=$2`,
    [
      jobId,
      stepId,
      error ? "failed" : "completed",
      result == null ? null : JSON.stringify(result),
      error == null ? null : JSON.stringify(error),
    ],
  );
}

export async function resetSteps(
  jobId: string,
  stepIds: readonly string[],
): Promise<number> {
  if (!stepIds.length) return 0;
  const result = await query(
    `UPDATE ai_investigation_steps
     SET state='pending',result_json=NULL,error_json=NULL,started_at=NULL,completed_at=NULL,updated_at=NOW()
     WHERE job_id=$1 AND step_id=ANY($2::text[]) AND state='completed'`,
    [jobId, stepIds],
  );
  return result.rowCount ?? 0;
}
export async function finishJob(
  id: string,
  state: string,
  result: unknown,
  error: unknown = null,
): Promise<AiInvestigationJobRow | undefined> {
  return queryOne(
    aiInvestigationJobRowSchema,
    `UPDATE ai_investigation_jobs
       SET state=CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE $2 END,
           result_json=CASE WHEN cancel_requested_at IS NOT NULL THEN NULL ELSE $3::jsonb END,
           error_json=CASE WHEN cancel_requested_at IS NOT NULL
             THEN '{"code":"CANCELLED"}'::jsonb ELSE $4::jsonb END,
           completed_at=CASE WHEN cancel_requested_at IS NOT NULL
             OR $2 IN ('completed','failed','cancelled') THEN NOW() ELSE NULL END,
           updated_at=NOW()
       WHERE id=$1 RETURNING ${COLUMNS}`,
    [
      id,
      state,
      result == null ? null : JSON.stringify(result),
      error == null ? null : JSON.stringify(error),
    ],
  );
}

export async function setProviderResult(
  id: string,
  result: unknown,
): Promise<{ id: string } | undefined> {
  return queryOne(
    uuidIdRowSchema,
    `UPDATE ai_investigation_jobs
       SET checkpoint_json=jsonb_set(checkpoint_json,'{providerResult}',$2::jsonb,true),updated_at=NOW()
       WHERE id=$1 AND cancel_requested_at IS NULL RETURNING id`,
    [id, JSON.stringify(result)],
  );
}

export async function clearProviderResult(
  id: string,
): Promise<{ id: string } | undefined> {
  return queryOne(
    uuidIdRowSchema,
    `UPDATE ai_investigation_jobs
       SET checkpoint_json=checkpoint_json - 'providerResult',updated_at=NOW()
       WHERE id=$1 RETURNING id`,
    [id],
  );
}
export async function requestCancel(
  id: string,
): Promise<AiInvestigationJobRow | null> {
  return (
    (await queryOne(
      aiInvestigationJobRowSchema,
      `UPDATE ai_investigation_jobs SET cancel_requested_at=NOW(),state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,checkpoint_json=checkpoint_json - 'providerResult',updated_at=NOW() WHERE id=$1 AND state NOT IN ('completed','failed','cancelled') RETURNING ${COLUMNS}`,
      [id],
    )) ?? null
  );
}
export async function deleteJob(id: string): Promise<boolean> {
  return (
    (
      await query(
        `DELETE FROM ai_investigation_jobs WHERE id=$1 RETURNING id`,
        [id],
      )
    ).rows.length > 0
  );
}
