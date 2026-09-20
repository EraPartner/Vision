import { query, withTransaction } from "../database/connection.js";

export async function createGrant(grant) {
  const result = await query(
    `INSERT INTO ai_disclosure_grants
      (route,mode,purpose,preview_payload_sha256,allowed_fields_json,max_requests,max_input_characters,
       max_output_tokens,max_cost_micros,max_disclosure_units,expires_at,retain_exact_payload)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,false)
     RETURNING *`,
    [
      grant.route,
      grant.mode,
      grant.purpose,
      grant.previewHash,
      JSON.stringify(grant.allowedFields),
      grant.maxRequests,
      grant.maxInputCharacters,
      grant.maxOutputTokens,
      grant.maxCostMicros,
      grant.maxDisclosureUnits,
      grant.expiresAt,
    ],
  );
  return result.rows[0];
}

export async function listGrants() {
  return (
    await query(
      `SELECT * FROM ai_disclosure_grants ORDER BY created_at DESC LIMIT 200`,
    )
  ).rows;
}
export async function listRecords() {
  return (
    await query(
      `SELECT * FROM ai_disclosure_records ORDER BY created_at DESC LIMIT 500`,
    )
  ).rows;
}
export async function revokeGrant(id) {
  return (
    (
      await query(
        `UPDATE ai_disclosure_grants SET revoked_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING id`,
        [id],
      )
    ).rows.length > 0
  );
}
export async function deleteHistory() {
  return withTransaction(async (client) => {
    const records = await client.query(`DELETE FROM ai_disclosure_records`);
    const grants = await client.query(`DELETE FROM ai_disclosure_grants`);
    return {
      records: records.rowCount ?? 0,
      grants: grants.rowCount ?? 0,
    };
  });
}

export async function reserveDisclosure({
  grantId,
  jobId,
  expectedMode,
  preview,
  outputTokens,
  costMicros,
  monthlyBudgetMicros,
}) {
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(884209113)`);
    const grant = (
      await client.query(
        `SELECT * FROM ai_disclosure_grants WHERE id=$1 FOR UPDATE`,
        [grantId],
      )
    ).rows[0];
    if (!grant)
      throw Object.assign(new Error("Disclosure grant not found"), {
        code: "GRANT_NOT_FOUND",
      });
    if (grant.revoked_at || new Date(grant.expires_at).getTime() <= Date.now())
      throw Object.assign(new Error("Disclosure grant is inactive"), {
        code: "GRANT_INACTIVE",
      });
    if (grant.route !== "openai-api" || grant.mode !== expectedMode)
      throw Object.assign(
        new Error(
          "Disclosure grant route or mode differs from the approved request",
        ),
        { code: "GRANT_MODE_MISMATCH" },
      );
    if (grant.preview_payload_sha256 !== preview.payloadSha256)
      throw Object.assign(
        new Error("Payload differs from the inspected preview"),
        { code: "PAYLOAD_CHANGED" },
      );
    const allowed = new Set(grant.allowed_fields_json);
    if (preview.fieldManifest.some((field) => !allowed.has(field)))
      throw Object.assign(new Error("Payload contains an unapproved field"), {
        code: "FIELD_NOT_ALLOWED",
      });
    const priorUnits = (
      await client.query(
        `SELECT disclosure_units_json FROM ai_disclosure_records WHERE grant_id=$1 AND status <> 'blocked'`,
        [grantId],
      )
    ).rows.flatMap((row) => row.disclosure_units_json || []);
    const distinctUnits = new Set([...priorUnits, ...preview.disclosureUnits]);
    const monthlyReserved = Number(
      (
        await client.query(
          `SELECT COALESCE(SUM(reserved_cost_micros),0) AS total FROM ai_disclosure_records WHERE created_at >= date_trunc('month',NOW()) AND status <> 'blocked'`,
        )
      ).rows[0]?.total ?? 0,
    );
    if (
      monthlyBudgetMicros <= 0 ||
      monthlyReserved + costMicros > monthlyBudgetMicros
    ) {
      throw Object.assign(
        new Error("OpenAI monthly spend budget is disabled or exhausted"),
        { code: "MONTHLY_BUDGET_EXHAUSTED" },
      );
    }
    if (
      grant.used_requests + 1 > grant.max_requests ||
      grant.used_input_characters + preview.inputCharacters >
        grant.max_input_characters ||
      grant.used_output_tokens + outputTokens > grant.max_output_tokens ||
      Number(grant.used_cost_micros) + costMicros >
        Number(grant.max_cost_micros) ||
      distinctUnits.size > grant.max_disclosure_units
    ) {
      throw Object.assign(new Error("Disclosure grant budget exhausted"), {
        code: "GRANT_BUDGET_EXHAUSTED",
      });
    }
    const record = (
      await client.query(
        `INSERT INTO ai_disclosure_records
       (grant_id,job_id,route,mode,purpose,field_manifest_json,disclosure_units_json,payload_sha256,payload_bytes,reserved_output_tokens,reserved_cost_micros,status,policy_snapshot_json)
       VALUES ($1,$2,'openai-api',$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,'authorized',$11::jsonb) RETURNING *`,
        [
          grantId,
          jobId,
          grant.mode,
          grant.purpose,
          JSON.stringify(preview.fieldManifest),
          JSON.stringify(preview.disclosureUnits),
          preview.payloadSha256,
          preview.payloadBytes,
          outputTokens,
          costMicros,
          JSON.stringify({
            version: grant.policy_version,
            allowedFields: [...allowed],
            retainExactPayload: false,
          }),
        ],
      )
    ).rows[0];
    await client.query(
      `UPDATE ai_disclosure_grants SET used_requests=used_requests+1,used_input_characters=used_input_characters+$2,used_output_tokens=used_output_tokens+$3,used_cost_micros=used_cost_micros+$4,updated_at=NOW() WHERE id=$1`,
      [grantId, preview.inputCharacters, outputTokens, costMicros],
    );
    return record;
  });
}

export async function updateDisclosureRecord(id, patch) {
  return (
    await query(
      `UPDATE ai_disclosure_records SET status=$2,actual_input_tokens=$3,actual_output_tokens=$4,actual_cost_micros=$5,provider_request_id=$6,error_code=$7,
       completed_at=CASE WHEN $2 IN ('completed','failed','cancelled','blocked') THEN NOW() ELSE NULL END
       WHERE id=$1 RETURNING *`,
      [
        id,
        patch.status,
        patch.inputTokens ?? null,
        patch.outputTokens ?? null,
        patch.costMicros ?? null,
        patch.providerRequestId ?? null,
        patch.errorCode ?? null,
      ],
    )
  ).rows[0];
}

export async function findUncertainDisclosure(jobId) {
  return (
    (
      await query(
        `SELECT id FROM ai_disclosure_records WHERE job_id=$1 AND status='sent' ORDER BY created_at DESC LIMIT 1`,
        [jobId],
      )
    ).rows[0] ?? null
  );
}
