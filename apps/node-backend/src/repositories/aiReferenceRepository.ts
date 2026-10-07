import { query, withTransaction } from "../database/connection.ts";

export type AiReferenceEntry = {
  token: string;
  referenceType: string;
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
};

export type AiReferenceScopeRow = {
  id: string;
  jobId: string | null;
  expiresAt: Date;
};

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
  const scope = (
    await query<AiReferenceScopeRow>(
      `SELECT id,job_id AS "jobId",expires_at AS "expiresAt"
       FROM ai_reference_scopes WHERE id=$1`,
      [id],
    )
  ).rows[0];
  if (!scope) return null;
  const entries = (
    await query<AiReferenceEntry>(
      `SELECT token,reference_type AS "referenceType",ciphertext,nonce,auth_tag AS "authTag"
       FROM ai_reference_entries WHERE scope_id=$1 ORDER BY token`,
      [id],
    )
  ).rows;
  return { ...scope, entries };
}

export async function getScopeForJob(
  jobId: string,
): Promise<AiReferenceScope | null> {
  const scope = (
    await query<AiReferenceScopeRow>(
      `SELECT id,job_id AS "jobId",expires_at AS "expiresAt"
       FROM ai_reference_scopes WHERE job_id=$1`,
      [jobId],
    )
  ).rows[0];
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
