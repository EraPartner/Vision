import { withTransaction } from "../database/connection.ts";
import { queryOne, queryRows } from "../database/rowContracts.ts";
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
    const candidate = await queryOne(
      auditFirstRecentRowSchema,
      `SELECT min(sequence) AS first_recent
         FROM audit_chain_entries
        WHERE created_at >= now() - interval '1 year'`,
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
    const boundary = await queryRows(
      auditEntryHashRowSchema,
      `SELECT entry_hash FROM audit_chain_entries WHERE sequence = $1`,
      [through],
    );
    const [boundaryEntry] = boundary;
    if (!boundaryEntry || boundary.length !== 1) {
      return { eligible: false, reason: "boundary_missing" };
    }
    const head = await readAuditHead();
    const max = await queryOne(
      auditDomainMaxRowSchema,
      `SELECT
         max((payload->>'auditRowId')::bigint) FILTER
           (WHERE payload->>'stream' = 'db_editor') AS db_editor_max,
         max((payload->>'auditRowId')::bigint) FILTER
           (WHERE payload->>'stream' = 'split') AS split_max,
         max((payload->>'receipt_id')::bigint) FILTER
           (WHERE payload->>'stream' = 'portfolio_retag') AS retag_max
       FROM audit_chain_entries
       WHERE sequence > $1 AND sequence <= $2`,
      [floor, through],
    );
    if (!max) throw new Error("Audit retention aggregate returned no row");
    const previous = trustedCheckpoint.retention?.domainMax ?? {
      dbEditor: head.legacyCutover.dbEditorMaxId,
      split: head.legacyCutover.splitMaxId,
      retag: head.legacyCutover.retagMaxId,
    };
    const migration = await queryOne(
      auditMigrationHeadsRowSchema,
      `SELECT payload->'heads' AS heads
         FROM audit_chain_entries
        WHERE sequence > $1 AND sequence <= $2
          AND payload->>'stream' = 'schema_migration'
        ORDER BY sequence DESC LIMIT 1`,
      [floor, through],
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
  const result = await queryOne(
    auditPruneRowSchema,
    "SELECT audit_chain_prune_prefix($1::bigint, $2::char(64)) AS removed",
    [retention.through, retention.hash],
  );
  if (!result) throw new Error("Audit retention prune returned no row");
  return { removed: safeSequence(result.removed) };
}
