import type { AiDisclosureGrant } from "@vision/types/aiResearch";
import { query, withTransaction } from "../database/connection.ts";

/** BIGINT columns arrive from pg as strings. */
export type AiDisclosureGrantRow = {
  id: string;
  route: string;
  mode: string;
  purpose: string;
  preview_payload_sha256: string;
  allowed_fields_json: string[];
  max_requests: number;
  max_input_characters: number;
  max_output_tokens: number;
  max_cost_micros: string;
  max_disclosure_units: number;
  used_requests: number;
  used_input_characters: string;
  used_output_tokens: string;
  used_cost_micros: string;
  policy_version: number;
  retain_exact_payload: boolean;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type AiDisclosureRecordRow = {
  id: string;
  grant_id: string;
  job_id: string | null;
  route: string;
  mode: string;
  purpose: string;
  field_manifest_json: string[];
  disclosure_units_json: string[];
  payload_sha256: string;
  payload_bytes: number;
  reserved_output_tokens: number;
  reserved_cost_micros: string;
  actual_input_tokens: number | null;
  actual_output_tokens: number | null;
  actual_cost_micros: string | null;
  status: string;
  provider_request_id: string | null;
  policy_snapshot_json: unknown;
  error_code: string | null;
  created_at: Date;
  completed_at: Date | null;
};

export type DisclosurePreview = {
  payloadSha256: string;
  fieldManifest: string[];
  disclosureUnits: string[];
  inputCharacters: number;
  payloadBytes: number;
};

export type DisclosureRecordPatch = {
  status: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costMicros?: number | null;
  providerRequestId?: string | null;
  errorCode?: string | null;
};

export async function createGrant(
  grant: AiDisclosureGrant,
): Promise<AiDisclosureGrantRow> {
  const result = await query<AiDisclosureGrantRow>(
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

export async function listGrants(): Promise<AiDisclosureGrantRow[]> {
  return (
    await query<AiDisclosureGrantRow>(
      `SELECT * FROM ai_disclosure_grants ORDER BY created_at DESC LIMIT 200`,
    )
  ).rows;
}
export async function listRecords(): Promise<AiDisclosureRecordRow[]> {
  return (
    await query<AiDisclosureRecordRow>(
      `SELECT * FROM ai_disclosure_records ORDER BY created_at DESC LIMIT 500`,
    )
  ).rows;
}
export async function revokeGrant(id: string): Promise<boolean> {
  return (
    (
      await query(
        `UPDATE ai_disclosure_grants SET revoked_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING id`,
        [id],
      )
    ).rows.length > 0
  );
}
export async function deleteHistory(): Promise<{
  records: number;
  grants: number;
}> {
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
}: {
  grantId: string;
  jobId: string;
  expectedMode: string;
  preview: DisclosurePreview;
  outputTokens: number;
  costMicros: number;
  monthlyBudgetMicros: number;
}): Promise<AiDisclosureRecordRow> {
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(884209113)`);
    const grant = (
      await client.query(
        `SELECT * FROM ai_disclosure_grants WHERE id=$1 FOR UPDATE`,
        [grantId],
      )
    ).rows[0] as AiDisclosureGrantRow | undefined;
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
    ).rows.flatMap(
      (row: Pick<AiDisclosureRecordRow, "disclosure_units_json">) =>
        row.disclosure_units_json || [],
    );
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
      // BIGINT counters arrive from pg as strings; add them as numbers.
      Number(grant.used_input_characters) + preview.inputCharacters >
        grant.max_input_characters ||
      Number(grant.used_output_tokens) + outputTokens >
        grant.max_output_tokens ||
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

export async function updateDisclosureRecord(
  id: string,
  patch: DisclosureRecordPatch,
): Promise<AiDisclosureRecordRow | undefined> {
  return (
    await query<AiDisclosureRecordRow>(
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

export async function findUncertainDisclosure(
  jobId: string,
): Promise<{ id: string } | null> {
  return (
    (
      await query<{ id: string }>(
        `SELECT id FROM ai_disclosure_records WHERE job_id=$1 AND status='sent' ORDER BY created_at DESC LIMIT 1`,
        [jobId],
      )
    ).rows[0] ?? null
  );
}
