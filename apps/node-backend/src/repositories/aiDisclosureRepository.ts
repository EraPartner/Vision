import type { AiDisclosureGrant } from "@vision/types/aiResearch";
import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { Json } from "../database/schema.generated.ts";
import {
  aiDisclosureGrantRowSchema,
  aiDisclosureRecordRowSchema,
  disclosureMonthlyTotalRowSchema,
  disclosureUnitsRowSchema,
  uuidIdRowSchema,
} from "../database/rows/ai.ts";
import type {
  AiDisclosureGrantRow,
  AiDisclosureRecordRow,
} from "../database/rows/ai.ts";

/** BIGINT columns arrive from pg as strings. */
export type { AiDisclosureGrantRow, AiDisclosureRecordRow };

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
  providerRequestId?: string | null | undefined;
  errorCode?: string | null;
};

function jsonb(value: unknown) {
  return sql<Json>`${JSON.stringify(value)}::jsonb`;
}

export async function createGrant(
  grant: AiDisclosureGrant,
): Promise<AiDisclosureGrantRow> {
  const row = await checkedRow(
    aiDisclosureGrantRowSchema,
    db
      .insertInto("ai_disclosure_grants")
      .values({
        route: grant.route,
        mode: grant.mode,
        purpose: grant.purpose,
        preview_payload_sha256: grant.previewHash,
        allowed_fields_json: jsonb(grant.allowedFields),
        max_requests: grant.maxRequests,
        max_input_characters: grant.maxInputCharacters,
        max_output_tokens: grant.maxOutputTokens,
        max_cost_micros: grant.maxCostMicros,
        max_disclosure_units: grant.maxDisclosureUnits,
        expires_at: grant.expiresAt,
        retain_exact_payload: false,
      })
      .returningAll(),
  );
  if (!row) throw new Error("ai_disclosure_grants insert returned no row");
  return row;
}

export async function listGrants(): Promise<AiDisclosureGrantRow[]> {
  return checkedRows(
    aiDisclosureGrantRowSchema,
    db
      .selectFrom("ai_disclosure_grants")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(200),
  );
}
export async function listRecords(): Promise<AiDisclosureRecordRow[]> {
  return checkedRows(
    aiDisclosureRecordRowSchema,
    db
      .selectFrom("ai_disclosure_records")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(500),
  );
}
export async function revokeGrant(id: string): Promise<boolean> {
  const rows = await db
    .updateTable("ai_disclosure_grants")
    .set({ revoked_at: sql<Date>`NOW()`, updated_at: sql<Date>`NOW()` })
    .where("id", "=", id)
    .returning("id")
    .execute();
  return rows.length > 0;
}
export async function deleteHistory(): Promise<{
  records: number;
  grants: number;
}> {
  return withTransaction(async () => {
    const records = await db
      .deleteFrom("ai_disclosure_records")
      .executeTakeFirst();
    const grants = await db
      .deleteFrom("ai_disclosure_grants")
      .executeTakeFirst();
    return {
      records: Number(records.numDeletedRows),
      grants: Number(grants.numDeletedRows),
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
  return withTransaction(async () => {
    await sql`SELECT pg_advisory_xact_lock(884209113)`.execute(db);
    const grant = await checkedRow(
      aiDisclosureGrantRowSchema,
      db
        .selectFrom("ai_disclosure_grants")
        .selectAll()
        .where("id", "=", grantId)
        .forUpdate(),
    );
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
      await checkedRows(
        disclosureUnitsRowSchema,
        db
          .selectFrom("ai_disclosure_records")
          .select("disclosure_units_json")
          .where("grant_id", "=", grantId)
          .where("status", "<>", "blocked"),
      )
    ).flatMap((row) => row.disclosure_units_json ?? []);
    const distinctUnits = new Set([...priorUnits, ...preview.disclosureUnits]);
    const monthlyReserved = Number(
      (
        await checkedRow(
          disclosureMonthlyTotalRowSchema,
          db
            .selectFrom("ai_disclosure_records")
            .select(
              sql<string>`COALESCE(SUM(reserved_cost_micros),0)`.as("total"),
            )
            .where("created_at", ">=", sql<Date>`date_trunc('month',NOW())`)
            .where("status", "<>", "blocked"),
        )
      )?.total ?? 0,
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
    const record = await checkedRow(
      aiDisclosureRecordRowSchema,
      db
        .insertInto("ai_disclosure_records")
        .values({
          grant_id: grantId,
          job_id: jobId,
          route: "openai-api",
          mode: grant.mode,
          purpose: grant.purpose,
          field_manifest_json: jsonb(preview.fieldManifest),
          disclosure_units_json: jsonb(preview.disclosureUnits),
          payload_sha256: preview.payloadSha256,
          payload_bytes: preview.payloadBytes,
          reserved_output_tokens: outputTokens,
          reserved_cost_micros: costMicros,
          status: "authorized",
          policy_snapshot_json: jsonb({
            version: grant.policy_version,
            allowedFields: [...allowed],
            retainExactPayload: false,
          }),
        })
        .returningAll(),
    );
    if (!record)
      throw new Error("ai_disclosure_records insert returned no row");
    await db
      .updateTable("ai_disclosure_grants")
      .set((eb) => ({
        used_requests: eb("used_requests", "+", 1),
        used_input_characters: sql<string>`used_input_characters + ${preview.inputCharacters}`,
        used_output_tokens: sql<string>`used_output_tokens + ${outputTokens}`,
        used_cost_micros: sql<string>`used_cost_micros + ${costMicros}`,
        updated_at: sql<Date>`NOW()`,
      }))
      .where("id", "=", grantId)
      .execute();
    return record;
  });
}

export async function updateDisclosureRecord(
  id: string,
  patch: DisclosureRecordPatch,
): Promise<AiDisclosureRecordRow | undefined> {
  return checkedRow(
    aiDisclosureRecordRowSchema,
    db
      .updateTable("ai_disclosure_records")
      .set({
        status: patch.status,
        actual_input_tokens: patch.inputTokens ?? null,
        actual_output_tokens: patch.outputTokens ?? null,
        actual_cost_micros: patch.costMicros ?? null,
        provider_request_id: patch.providerRequestId ?? null,
        error_code: patch.errorCode ?? null,
        completed_at: sql<Date | null>`CASE WHEN ${patch.status}::text IN ('completed','failed','cancelled','blocked') THEN NOW() ELSE NULL END`,
      })
      .where("id", "=", id)
      .returningAll(),
  );
}

export async function findUncertainDisclosure(
  jobId: string,
): Promise<{ id: string } | null> {
  return (
    (await checkedRow(
      uuidIdRowSchema,
      db
        .selectFrom("ai_disclosure_records")
        .select("id")
        .where("job_id", "=", jobId)
        .where("status", "=", "sent")
        .orderBy("created_at", "desc")
        .limit(1),
    )) ?? null
  );
}
