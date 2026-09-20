import { createHash } from "node:crypto";
import { query } from "../database/connection.js";
import {
  readAuditHead,
  readAuditSegment,
} from "../repositories/auditChainRepository.js";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  canonicalAuditPayload,
  verifyAuditChain,
} from "../lib/auditChainCore.js";

const HASH = /^[0-9a-f]{64}$/;
const digest = (values) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");

function fail(code, sequence, detail) {
  return { status: "failed", code, sequence, ...(detail ? { detail } : {}) };
}

async function verifyDomainRow(payload, runQuery) {
  if (!["db_editor", "split", "portfolio_retag"].includes(payload.stream))
    return null;
  const id =
    payload.stream === "portfolio_retag"
      ? payload.receipt_id
      : payload.auditRowId;
  if (typeof id !== "string" || !/^[1-9]\d*$/.test(id))
    return "invalid_reference";
  if (payload.stream === "db_editor") {
    const result = await runQuery(
      `SELECT table_name, op, pk_json::text AS pk_text,
              before_json::text AS before_text, after_json::text AS after_text,
              statement,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
         FROM db_editor_audit WHERE id = $1`,
      [id],
    );
    if (result.rows.length !== 1) return "missing_domain_row";
    const row = result.rows[0];
    if (
      payload.table !== row.table_name ||
      payload.event !== row.op ||
      payload.occurred_at !== row.occurred_at
    )
      return "domain_metadata";
    const expected = digest([
      row.table_name,
      row.op,
      row.pk_text,
      row.before_text,
      row.after_text,
      row.statement,
      row.occurred_at,
    ]);
    return expected === payload.auditDigest ? null : "domain_digest";
  }
  if (payload.stream === "split") {
    const result = await runQuery(
      `SELECT split_id::text AS split_id_text, action, actor,
              payload::text AS payload_text,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
         FROM split_audit WHERE id = $1`,
      [id],
    );
    if (result.rows.length !== 1) return "missing_domain_row";
    const row = result.rows[0];
    if (
      payload.splitId !== row.split_id_text ||
      payload.event !== row.action ||
      payload.actor !== row.actor ||
      payload.occurred_at !== row.occurred_at
    )
      return "domain_metadata";
    const expected = digest([
      row.split_id_text,
      row.action,
      row.actor,
      row.payload_text,
      row.occurred_at,
    ]);
    return expected === payload.auditDigest ? null : "domain_digest";
  }
  if (payload.stream === "portfolio_retag") {
    const result = await runQuery(
      `SELECT id,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
              idempotency_key, request_fingerprint,
              from_account_id, to_account_id, transaction_ids,
              previous_assignments, selected_count, changed_count
         FROM portfolio_retag_audit WHERE id = $1`,
      [id],
    );
    if (result.rows.length !== 1) return "missing_domain_row";
    const row = result.rows[0];
    const expected = {
      stream: "portfolio_retag",
      event: "receipt_created",
      receipt_id: String(row.id),
      occurred_at: row.occurred_at,
      idempotency_key: row.idempotency_key,
      request_fingerprint: row.request_fingerprint,
      from_account_id: row.from_account_id,
      to_account_id: row.to_account_id,
      transaction_ids: row.transaction_ids,
      previous_assignments: row.previous_assignments,
      selected_count: row.selected_count,
      changed_count: row.changed_count,
    };
    return canonicalAuditPayload(expected) === canonicalAuditPayload(payload)
      ? null
      : "domain_digest";
  }
  return null;
}

/**
 * Scan the complete chain without writes. `trustedCheckpoint` must have been
 * authenticated outside PostgreSQL; a row in audit_chain_checkpoints is not
 * such a receipt. A checkpoint behind the head anchors only its prefix.
 *
 * @param {{trustedCheckpoint?: {sequence:number, hash:string}, pageSize?:number,
 *   readSegment?:typeof readAuditSegment, readHead?:typeof readAuditHead,
 *   runQuery?:typeof query}} [options]
 */
export async function verifyAuditHistory({
  trustedCheckpoint,
  pageSize = 500,
  readSegment = readAuditSegment,
  readHead = readAuditHead,
  runQuery = query,
} = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10_000) {
    throw new RangeError("pageSize must be between 1 and 10000");
  }
  if (
    trustedCheckpoint !== undefined &&
    (!trustedCheckpoint ||
      !Number.isSafeInteger(trustedCheckpoint.sequence) ||
      trustedCheckpoint.sequence < 0 ||
      typeof trustedCheckpoint.hash !== "string" ||
      !HASH.test(trustedCheckpoint.hash))
  )
    throw new TypeError("Invalid trusted audit checkpoint");

  const initialHead = await readHead();
  let sequence = 0;
  let hash = AUDIT_CHAIN_GENESIS_HASH;
  let migrationHeads;
  const observedDomainMax = {
    dbEditor: initialHead.legacyCutover?.dbEditorMaxId ?? 0,
    split: initialHead.legacyCutover?.splitMaxId ?? 0,
    retag: initialHead.legacyCutover?.retagMaxId ?? 0,
  };
  const retention = trustedCheckpoint?.retention;
  if (
    retention !== undefined &&
    (!Number.isSafeInteger(retention.through) ||
      retention.through < 1 ||
      retention.through >= trustedCheckpoint.sequence ||
      typeof retention.hash !== "string" ||
      !HASH.test(retention.hash) ||
      !Array.isArray(retention.migrationHeads) ||
      retention.migrationHeads.length > 16 ||
      retention.migrationHeads.some((head) => typeof head !== "string") ||
      !retention.domainMax ||
      ["dbEditor", "split", "retag"].some(
        (field) =>
          !Number.isSafeInteger(retention.domainMax[field]) ||
          retention.domainMax[field] < 0,
      ))
  ) {
    throw new TypeError("Invalid trusted audit retention boundary");
  }
  const earliest = await readSegment({ afterSequence: 0, limit: 1 });
  const firstSequence = earliest[0]?.sequence;
  if (firstSequence !== undefined && firstSequence !== 1) {
    if (
      !retention ||
      firstSequence !== retention.through + 1 ||
      earliest[0].previousHash !== retention.hash
    ) {
      return fail("retention_boundary", firstSequence);
    }
    sequence = retention.through;
    hash = retention.hash;
    migrationHeads = retention.migrationHeads;
  }
  if (firstSequence === undefined && initialHead.sequence > 0) {
    return fail("missing_entries", 1);
  }
  let checkpointMatched =
    trustedCheckpoint?.sequence === 0 ? trustedCheckpoint.hash === hash : false;
  if (trustedCheckpoint?.sequence === 0 && !checkpointMatched) {
    return fail("checkpoint_hash", 0);
  }
  if (trustedCheckpoint && trustedCheckpoint.sequence > initialHead.sequence) {
    return fail("rollback", initialHead.sequence);
  }

  while (sequence < initialHead.sequence) {
    const rows = await readSegment({
      afterSequence: sequence,
      limit: pageSize,
    });
    const segment = rows.filter((row) => row.sequence <= initialHead.sequence);
    if (!segment.length) return fail("missing_entries", sequence + 1);
    const result = verifyAuditChain(segment, {
      firstSequence: sequence + 1,
      previousHash: hash,
    });
    if (result.ok === false) {
      return fail(result.code, sequence + result.position + 1);
    }
    for (const row of segment) {
      const domainError = await verifyDomainRow(row.payload, runQuery);
      if (domainError) return fail(domainError, row.sequence);
      if (
        retention &&
        firstSequence === 1 &&
        row.sequence <= retention.through
      ) {
        const stream = row.payload?.stream;
        const field =
          stream === "db_editor"
            ? "dbEditor"
            : stream === "split"
              ? "split"
              : stream === "portfolio_retag"
                ? "retag"
                : undefined;
        if (field) {
          const id = Number(
            stream === "portfolio_retag"
              ? row.payload.receipt_id
              : row.payload.auditRowId,
          );
          if (Number.isSafeInteger(id))
            observedDomainMax[field] = Math.max(observedDomainMax[field], id);
        }
      }
      if (row.payload?.stream === "schema_migration") {
        if (
          !Array.isArray(row.payload.heads) ||
          row.payload.heads.some((head) => typeof head !== "string")
        )
          return fail("migration_heads_invalid", row.sequence);
        migrationHeads = [...row.payload.heads].sort();
      }
      if (
        retention &&
        row.sequence === retention.through &&
        row.hash !== retention.hash
      ) {
        return fail("retention_boundary_hash", row.sequence);
      }
      if (
        retention &&
        firstSequence === 1 &&
        row.sequence === retention.through &&
        (["dbEditor", "split", "retag"].some(
          (field) => observedDomainMax[field] !== retention.domainMax[field],
        ) ||
          JSON.stringify(migrationHeads ?? []) !==
            JSON.stringify(retention.migrationHeads))
      ) {
        return fail("retention_boundary_metadata", row.sequence);
      }
      if (row.sequence === trustedCheckpoint?.sequence) {
        checkpointMatched = row.hash === trustedCheckpoint.hash;
        if (!checkpointMatched) return fail("checkpoint_hash", row.sequence);
      }
    }
    sequence = result.lastSequence;
    hash = result.headHash;
  }
  if (sequence !== initialHead.sequence || hash !== initialHead.hash) {
    return fail("head_mismatch", sequence);
  }
  const extra = await readSegment({ afterSequence: sequence, limit: 1 });
  const finalHead = await readHead();
  if (
    finalHead.sequence !== initialHead.sequence ||
    finalHead.hash !== initialHead.hash ||
    JSON.stringify(finalHead.legacyCutover) !==
      JSON.stringify(initialHead.legacyCutover) ||
    extra.length
  )
    return fail("concurrent_change_or_head_mismatch", sequence);

  if (migrationHeads) {
    const currentRevisions = await runQuery(
      "SELECT version_num FROM alembic_version ORDER BY version_num",
    );
    const actualHeads = currentRevisions.rows.map((row) => row.version_num);
    if (JSON.stringify(actualHeads) !== JSON.stringify(migrationHeads)) {
      return fail("migration_version_mismatch", sequence);
    }
  }

  // Migration 0117 records the prior high-water IDs. Unlinked older rows are
  // unverified; every newer domain row must be linked to the chain.
  const cutover = initialHead.legacyCutover;
  if (
    !cutover ||
    [cutover.dbEditorMaxId, cutover.splitMaxId, cutover.retagMaxId].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  )
    return fail("cutover_unavailable", sequence);
  const coverageMax = {
    dbEditor: Math.max(
      cutover.dbEditorMaxId,
      retention?.domainMax.dbEditor ?? 0,
    ),
    split: Math.max(cutover.splitMaxId, retention?.domainMax.split ?? 0),
    retag: Math.max(cutover.retagMaxId, retention?.domainMax.retag ?? 0),
  };
  const unlinked = await runQuery(
    `SELECT
       (SELECT count(*) FROM db_editor_audit d WHERE d.id <= $1::bigint AND NOT EXISTS
          (SELECT 1 FROM audit_chain_entries e WHERE e.payload->>'stream' = 'db_editor'
             AND e.payload->>'auditRowId' = d.id::text)) AS db_editor_legacy,
       (SELECT count(*) FROM db_editor_audit d WHERE d.id > $4::bigint AND NOT EXISTS
          (SELECT 1 FROM audit_chain_entries e WHERE e.payload->>'stream' = 'db_editor'
             AND e.payload->>'auditRowId' = d.id::text)) AS db_editor_missing,
       (SELECT count(*) FROM split_audit s WHERE s.id <= $2::bigint AND NOT EXISTS
          (SELECT 1 FROM audit_chain_entries e WHERE e.payload->>'stream' = 'split'
             AND e.payload->>'auditRowId' = s.id::text)) AS split_legacy,
       (SELECT count(*) FROM split_audit s WHERE s.id > $5::bigint AND NOT EXISTS
          (SELECT 1 FROM audit_chain_entries e WHERE e.payload->>'stream' = 'split'
             AND e.payload->>'auditRowId' = s.id::text)) AS split_missing,
       (SELECT count(*) FROM portfolio_retag_audit p WHERE p.id <= $3::bigint AND NOT EXISTS
          (SELECT 1 FROM audit_chain_entries e WHERE e.payload->>'stream' = 'portfolio_retag'
             AND e.payload->>'receipt_id' = p.id::text)) AS portfolio_retag_legacy,
       (SELECT count(*) FROM portfolio_retag_audit p WHERE p.id > $6::bigint AND NOT EXISTS
          (SELECT 1 FROM audit_chain_entries e WHERE e.payload->>'stream' = 'portfolio_retag'
             AND e.payload->>'receipt_id' = p.id::text)) AS portfolio_retag_missing`,
    [
      cutover.dbEditorMaxId,
      cutover.splitMaxId,
      cutover.retagMaxId,
      coverageMax.dbEditor,
      coverageMax.split,
      coverageMax.retag,
    ],
  );
  const counts = unlinked.rows[0];
  if (!counts) return fail("coverage_unavailable", sequence);
  const legacyUnverified = {
    dbEditor: String(counts.db_editor_legacy),
    split: String(counts.split_legacy),
    portfolioRetag: String(counts.portfolio_retag_legacy),
  };
  if (
    [
      counts.db_editor_missing,
      counts.split_missing,
      counts.portfolio_retag_missing,
    ].some((count) => BigInt(count) > 0n)
  ) {
    return fail("missing_post_cutover_domain_link", sequence);
  }
  if (!trustedCheckpoint) {
    return {
      status: "unavailable",
      reason: "trusted_checkpoint_absent",
      sequence,
      hash,
      legacyCutover: cutover,
      legacyUnverified,
    };
  }
  if (!checkpointMatched)
    return fail("checkpoint_missing", trustedCheckpoint.sequence);
  return {
    status:
      trustedCheckpoint.sequence === sequence
        ? "verified"
        : "partially_verified",
    sequence,
    hash,
    anchoredThrough: trustedCheckpoint.sequence,
    ...(retention ? { retentionThrough: retention.through } : {}),
    legacyCutover: cutover,
    legacyUnverified,
  };
}

export default { verifyAuditHistory };
