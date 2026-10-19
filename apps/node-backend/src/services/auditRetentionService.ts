import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  auditDomainMaxRowSchema,
  auditEntryHashRowSchema,
  auditFirstRecentRowSchema,
  auditMigrationHeadsRowSchema,
  auditPruneRowSchema,
} from "../database/rows/audit.ts";
import { readAuditHead } from "../repositories/auditChainRepository.ts";
import { verifyAuditHistory } from "./auditVerificationService.ts";
import type { TrustedAuditCheckpoint } from "./auditVerificationService.ts";

function safeSequence(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError("Audit retention sequence exceeds the safe range");
  }
  return parsed;
}

export async function planAuditRetention(
  trustedCheckpoint: TrustedAuditCheckpoint | undefined,
) {
  if (!trustedCheckpoint)
    throw new TypeError("Trusted audit checkpoint required");
  return withTransaction(async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    await client.query("SET LOCAL statement_timeout = '15s'");
    const verified = await verifyAuditHistory({ trustedCheckpoint });
    if (!["verified", "partially_verified"].includes(verified.status)) {
      return { eligible: false, reason: "history_not_fully_anchored" };
    }
    const floor = trustedCheckpoint.retention?.through ?? 0;
    const candidate = await checkedRow(
      auditFirstRecentRowSchema,
      db
        .selectFrom("audit_chain_entries")
        .select((eb) => eb.fn.min("sequence").as("first_recent"))
        .where("created_at", ">=", sql<Date>`now() - interval '1 year'`),
    );
    // An aggregate without GROUP BY always returns exactly one row.
    if (!candidate)
      throw new Error("Audit retention candidate query returned no row");
    const firstRecent =
      candidate.first_recent === null
        ? verified.sequence + 1
        : safeSequence(candidate.first_recent);
    const through = Math.min(firstRecent - 1, trustedCheckpoint.sequence - 1);
    if (through <= floor) return { eligible: false, reason: "nothing_due" };
    const boundary = await checkedRows(
      auditEntryHashRowSchema,
      db
        .selectFrom("audit_chain_entries")
        .select("entry_hash")
        .where("sequence", "=", String(through)),
    );
    const [boundaryEntry] = boundary;
    if (!boundaryEntry || boundary.length !== 1) {
      return { eligible: false, reason: "boundary_missing" };
    }
    const head = await readAuditHead();
    const max = await checkedRow(
      auditDomainMaxRowSchema,
      sql`SELECT
         max((payload->>'auditRowId')::bigint) FILTER
           (WHERE payload->>'stream' = 'db_editor') AS db_editor_max,
         max((payload->>'auditRowId')::bigint) FILTER
           (WHERE payload->>'stream' = 'split') AS split_max,
         max((payload->>'receipt_id')::bigint) FILTER
           (WHERE payload->>'stream' = 'portfolio_retag') AS retag_max
       FROM audit_chain_entries
       WHERE sequence > ${floor} AND sequence <= ${through}`,
    );
    if (!max) throw new Error("Audit retention aggregate returned no row");
    const previous = trustedCheckpoint.retention?.domainMax ?? {
      dbEditor: head.legacyCutover.dbEditorMaxId,
      split: head.legacyCutover.splitMaxId,
      retag: head.legacyCutover.retagMaxId,
    };
    const migration = await checkedRow(
      auditMigrationHeadsRowSchema,
      sql`SELECT payload->'heads' AS heads
         FROM audit_chain_entries
        WHERE sequence > ${floor} AND sequence <= ${through}
          AND payload->>'stream' = 'schema_migration'
        ORDER BY sequence DESC LIMIT 1`,
    );
    const migrationHeads =
      migration?.heads ?? trustedCheckpoint.retention?.migrationHeads ?? [];
    return {
      eligible: true,
      through,
      hash: boundaryEntry.entry_hash,
      domainMax: {
        dbEditor: Math.max(
          previous.dbEditor,
          safeSequence(max.db_editor_max ?? 0),
        ),
        split: Math.max(previous.split, safeSequence(max.split_max ?? 0)),
        retag: Math.max(previous.retag, safeSequence(max.retag_max ?? 0)),
      },
      migrationHeads: [...migrationHeads].sort(),
    };
  });
}

export async function pruneAuditRetention(
  trustedCheckpoint: TrustedAuditCheckpoint | undefined,
) {
  const retention = trustedCheckpoint?.retention;
  if (!retention)
    throw new TypeError("Signed audit retention boundary required");
  const verified = await verifyAuditHistory({ trustedCheckpoint });
  if (!["verified", "partially_verified"].includes(verified.status)) {
    throw new Error("Audit history is not fully verified for retention");
  }
  const result = await checkedRow(
    auditPruneRowSchema,
    sql`SELECT audit_chain_prune_prefix(${retention.through}::bigint, ${retention.hash}::char(64)) AS removed`,
  );
  if (!result) throw new Error("Audit retention prune returned no row");
  return { removed: safeSequence(result.removed) };
}
