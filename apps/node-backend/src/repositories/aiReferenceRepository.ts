import { query, withTransaction } from "../database/connection.ts";
import { queryOne, queryRows } from "../database/rowContracts.ts";
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
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO ai_reference_scopes (id,expires_at) VALUES ($1,$2)`,
      [id, expiresAt],
    );
    for (const entry of entries)
      await client.query(
        `INSERT INTO ai_reference_entries
           (scope_id,token,reference_type,ciphertext,nonce,auth_tag)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id,
          entry.token,
          entry.referenceType,
          entry.ciphertext,
          entry.nonce,
          entry.authTag,
        ],
      );
    return { id, expiresAt };
  });
}

export async function getScope(id: string): Promise<AiReferenceScope | null> {
  const scope = await queryOne(
    aiReferenceScopeRowSchema,
    `SELECT id,job_id AS "jobId",expires_at AS "expiresAt"
       FROM ai_reference_scopes WHERE id=$1`,
    [id],
  );
  if (!scope) return null;
  const entries = await queryRows(
    aiReferenceEntryRowSchema,
    `SELECT token,reference_type AS "referenceType",ciphertext,nonce,auth_tag AS "authTag"
       FROM ai_reference_entries WHERE scope_id=$1 ORDER BY token`,
    [id],
  );
  return { ...scope, entries };
}

export async function getScopeForJob(
  jobId: string,
): Promise<AiReferenceScope | null> {
  const scope = await queryOne(
    aiReferenceScopeRowSchema,
    `SELECT id,job_id AS "jobId",expires_at AS "expiresAt"
       FROM ai_reference_scopes WHERE job_id=$1`,
    [jobId],
  );
  return scope ? getScope(scope.id) : null;
}

export async function deleteScope(id: string): Promise<number | null> {
  return (await query(`DELETE FROM ai_reference_scopes WHERE id=$1`, [id]))
    .rowCount;
}

export async function deleteExpiredUnclaimed(): Promise<number | null> {
  return (
    await query(
      `DELETE FROM ai_reference_scopes WHERE job_id IS NULL AND expires_at <= NOW()`,
    )
  ).rowCount;
}
