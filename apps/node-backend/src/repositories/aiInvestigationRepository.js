import { query, withTransaction } from "../database/connection.js";

const COLUMNS = `id,conversation_id AS "conversationId",question,route,model,depth,language,state,
 scope_json AS scope,plan_json AS plan,checkpoint_json AS checkpoint,result_json AS result,
 error_json AS error,grant_id AS "grantId",cancel_requested_at AS "cancelRequestedAt",
 started_at AS "startedAt",completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"`;

export async function createJob(request, referenceExpiresAt = null) {
  return withTransaction(async (client) => {
    const job = (
      await client.query(
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
      )
    ).rows[0];
    if (request.referenceScopeId) {
      const claimed = (
        await client.query(
          `UPDATE ai_reference_scopes
           SET job_id=$2,claimed_at=NOW(),expires_at=$3
           WHERE id=$1 AND job_id IS NULL AND expires_at > NOW()
           RETURNING id`,
          [request.referenceScopeId, job.id, referenceExpiresAt],
        )
      ).rows[0];
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
export async function listJobs() {
  return (
    await query(
      `SELECT ${COLUMNS} FROM ai_investigation_jobs ORDER BY updated_at DESC LIMIT 200`,
    )
  ).rows;
}
export async function listRecoverableJobs() {
  return (
    await query(
      `SELECT ${COLUMNS} FROM ai_investigation_jobs
       WHERE state IN ('queued','running') AND cancel_requested_at IS NULL
       ORDER BY created_at ASC`,
    )
  ).rows;
}
export async function getJob(id) {
  return (
    (
      await query(`SELECT ${COLUMNS} FROM ai_investigation_jobs WHERE id=$1`, [
        id,
      ])
    ).rows[0] ?? null
  );
}
export async function setPlan(id, plan) {
  return (
    (
      await query(
        `UPDATE ai_investigation_jobs SET plan_json=$2::jsonb,state='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id=$1 AND cancel_requested_at IS NULL RETURNING ${COLUMNS}`,
        [id, JSON.stringify(plan)],
      )
    ).rows[0] ?? null
  );
}
export async function setWaiting(id, plan) {
  return (
    (
      await query(
        `UPDATE ai_investigation_jobs SET plan_json=$2::jsonb,state='waiting',updated_at=NOW() WHERE id=$1 AND cancel_requested_at IS NULL RETURNING ${COLUMNS}`,
        [id, JSON.stringify(plan)],
      )
    ).rows[0] ?? null
  );
}
export async function resolveWaiting(id, clarification, scope) {
  return (
    (
      await query(
        `UPDATE ai_investigation_jobs
         SET scope_json=jsonb_set(jsonb_set(scope_json,'{clarification}',to_jsonb($2::text),true),'{scope}',$3::jsonb,true),plan_json=NULL,state='queued',updated_at=NOW()
         WHERE id=$1 AND state='waiting' AND cancel_requested_at IS NULL RETURNING ${COLUMNS}`,
        [id, clarification, JSON.stringify(scope)],
      )
    ).rows[0] ?? null
  );
}
export async function seedSteps(id, steps) {
  for (const step of steps)
    await query(
      `INSERT INTO ai_investigation_steps (job_id,step_id,state) VALUES ($1,$2,'pending') ON CONFLICT DO NOTHING`,
      [id, step.id],
    );
}
export async function getSteps(id) {
  return (
    await query(
      `SELECT step_id AS "stepId",state,attempt,result_json AS result,error_json AS error,started_at AS "startedAt",completed_at AS "completedAt" FROM ai_investigation_steps WHERE job_id=$1 ORDER BY step_id`,
      [id],
    )
  ).rows;
}
export async function startStep(jobId, stepId) {
  return (
    (
      await query(
        `UPDATE ai_investigation_steps SET state='running',attempt=attempt+1,started_at=NOW(),updated_at=NOW() WHERE job_id=$1 AND step_id=$2 AND state <> 'completed' RETURNING *`,
        [jobId, stepId],
      )
    ).rows[0] ?? null
  );
}
export async function finishStep(jobId, stepId, result, error = null) {
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

export async function resetSteps(jobId, stepIds) {
  if (!stepIds.length) return 0;
  const result = await query(
    `UPDATE ai_investigation_steps
     SET state='pending',result_json=NULL,error_json=NULL,started_at=NULL,completed_at=NULL,updated_at=NOW()
     WHERE job_id=$1 AND step_id=ANY($2::text[]) AND state='completed'`,
    [jobId, stepIds],
  );
  return result.rowCount ?? 0;
}
export async function finishJob(id, state, result, error = null) {
  return (
    await query(
      `UPDATE ai_investigation_jobs SET state=$2,result_json=$3::jsonb,error_json=$4::jsonb,completed_at=CASE WHEN $2 IN ('completed','failed','cancelled') THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$1 RETURNING ${COLUMNS}`,
      [
        id,
        state,
        result == null ? null : JSON.stringify(result),
        error == null ? null : JSON.stringify(error),
      ],
    )
  ).rows[0];
}

export async function setProviderResult(id, result) {
  return (
    await query(
      `UPDATE ai_investigation_jobs
       SET checkpoint_json=jsonb_set(checkpoint_json,'{providerResult}',$2::jsonb,true),updated_at=NOW()
       WHERE id=$1 RETURNING id`,
      [id, JSON.stringify(result)],
    )
  ).rows[0];
}

export async function clearProviderResult(id) {
  return (
    await query(
      `UPDATE ai_investigation_jobs
       SET checkpoint_json=checkpoint_json - 'providerResult',updated_at=NOW()
       WHERE id=$1 RETURNING id`,
      [id],
    )
  ).rows[0];
}
export async function requestCancel(id) {
  return (
    (
      await query(
        `UPDATE ai_investigation_jobs SET cancel_requested_at=NOW(),state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,updated_at=NOW() WHERE id=$1 AND state NOT IN ('completed','failed','cancelled') RETURNING ${COLUMNS}`,
        [id],
      )
    ).rows[0] ?? null
  );
}
export async function deleteJob(id) {
  return (
    (
      await query(
        `DELETE FROM ai_investigation_jobs WHERE id=$1 RETURNING id`,
        [id],
      )
    ).rows.length > 0
  );
}
