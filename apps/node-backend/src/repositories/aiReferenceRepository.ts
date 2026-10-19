import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  aiReferenceEntryRowSchema,
  aiReferenceScopeRowSchema,
} from "../database/rows/ai.ts";
import type {
  AiReferenceEntry,
  AiReferenceScopeRow,
} from "../database/rows/ai.ts";

export type { AiReferenceEntry, AiReferenceScopeRow };

export type AiReferenceScope = AiReferenceScopeRow & {
  entries: AiReferenceEntry[];
};

export async function createScope({
  id,
  expiresAt,
  entries,
}: {
  id: string;
  /** ISO timestamp */
  expiresAt: string;
  entries: AiReferenceEntry[];
}): Promise<{ id: string; expiresAt: string }> {
  return withTransaction(async () => {
    await db
      .insertInto("ai_reference_scopes")
      .values({ id, expires_at: expiresAt })
      .execute();
    for (const entry of entries)
      await db
        .insertInto("ai_reference_entries")
        .values({
          scope_id: id,
          token: entry.token,
          reference_type: entry.referenceType,
          ciphertext: entry.ciphertext,
          nonce: entry.nonce,
          auth_tag: entry.authTag,
        })
        .execute();
    return { id, expiresAt };
  });
}

function selectScope() {
  return db
    .selectFrom("ai_reference_scopes")
    .select(["id", "job_id as jobId", "expires_at as expiresAt"]);
}

export async function getScope(id: string): Promise<AiReferenceScope | null> {
  const scope = await checkedRow(
    aiReferenceScopeRowSchema,
    selectScope().where("id", "=", id),
  );
  if (!scope) return null;
  const entries = await checkedRows(
    aiReferenceEntryRowSchema,
    db
      .selectFrom("ai_reference_entries")
      .select([
        "token",
        "reference_type as referenceType",
        "ciphertext",
        "nonce",
        "auth_tag as authTag",
      ])
      .where("scope_id", "=", id)
      .orderBy("token"),
  );
  return { ...scope, entries };
}

export async function getScopeForJob(
  jobId: string,
): Promise<AiReferenceScope | null> {
  const scope = await checkedRow(
    aiReferenceScopeRowSchema,
    selectScope().where("job_id", "=", jobId),
  );
  return scope ? getScope(scope.id) : null;
}

export async function deleteExpiredUnclaimed(): Promise<number | null> {
  const result = await db
    .deleteFrom("ai_reference_scopes")
    .where("job_id", "is", null)
    .where("expires_at", "<=", sql<Date>`NOW()`)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
