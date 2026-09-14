import { query, withTransaction } from "../database/connection.js";

export async function createScope({ id, expiresAt, entries }) {
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

export async function getScope(id) {
  const scope = (
    await query(
      `SELECT id,job_id AS "jobId",expires_at AS "expiresAt"
       FROM ai_reference_scopes WHERE id=$1`,
      [id],
    )
  ).rows[0];
  if (!scope) return null;
  const entries = (
    await query(
      `SELECT token,reference_type AS "referenceType",ciphertext,nonce,auth_tag AS "authTag"
       FROM ai_reference_entries WHERE scope_id=$1 ORDER BY token`,
      [id],
    )
  ).rows;
  return { ...scope, entries };
}

export async function getScopeForJob(jobId) {
  const scope = (
    await query(
      `SELECT id,job_id AS "jobId",expires_at AS "expiresAt"
       FROM ai_reference_scopes WHERE job_id=$1`,
      [jobId],
    )
  ).rows[0];
  return scope ? getScope(scope.id) : null;
}

export async function deleteScope(id) {
  return (await query(`DELETE FROM ai_reference_scopes WHERE id=$1`, [id]))
    .rowCount;
}

export async function deleteExpiredUnclaimed() {
  return (
    await query(
      `DELETE FROM ai_reference_scopes WHERE job_id IS NULL AND expires_at <= NOW()`,
    )
  ).rowCount;
}
