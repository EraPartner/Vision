/**
 * Persistence for the versioned audit hash chain. Call appendAuditEvent inside
 * the same withTransaction callback as the domain mutation. The row lock on
 * audit_chain_head serializes concurrent writers across processes.
 *
 * This repository does not create or verify the independent anchor receipt.
 * A database-local chain and checkpoint table cannot detect a coordinated
 * privileged rewrite or restore of an older database snapshot.
 */
import { query, withTransaction } from "../database/connection.js";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  AUDIT_CHAIN_VERSION,
  canonicalAuditPayload,
  createAuditEntry,
} from "../lib/auditChainCore.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function parseSequence(value) {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError("Audit sequence is outside the safe integer range");
  }
  return sequence;
}

/**
 * Append one event on the ambient transaction connection. The caller owns the
 * surrounding transaction; this function intentionally does not commit.
 * Every security-relevant value, including actor and event time, belongs in
 * payload so it is included in the hash.
 *
 * @param {Record<string, unknown>} payload
 * @param {{query: (sql: string, params?: unknown[]) => Promise<any>}} [client]
 */
export async function appendAuditEvent(payload, client) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new TypeError("Audit event payload must be an object");
  }
  const encodedPayload = canonicalAuditPayload(payload);
  // Snapshot before awaiting the head lock so a caller cannot mutate an
  // object between hashing and the JSONB insert.
  const stablePayload = JSON.parse(encodedPayload);
  const appendOn = async (runQuery) => {
    const headResult = await runQuery(
      `SELECT last_sequence, last_hash
       FROM audit_chain_head
      WHERE singleton = true
      FOR UPDATE`,
    );
    const head = headResult.rows[0];
    if (!head || headResult.rows.length !== 1) {
      throw new Error("Audit chain head is missing or duplicated");
    }
    const lastSequence = parseSequence(head.last_sequence);
    const latestResult = await runQuery(
      `SELECT sequence, entry_hash
       FROM audit_chain_entries
      ORDER BY sequence DESC
      LIMIT 1`,
    );
    const latest = latestResult.rows[0];
    const expectedHash = latest?.entry_hash ?? AUDIT_CHAIN_GENESIS_HASH;
    const expectedSequence = latest ? parseSequence(latest.sequence) : 0;
    if (lastSequence !== expectedSequence || head.last_hash !== expectedHash) {
      throw new Error("Audit chain head does not match stored history");
    }
    if (lastSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Audit chain sequence is exhausted");
    }

    const entry = createAuditEntry({
      sequence: lastSequence + 1,
      previousHash: head.last_hash,
      payload: stablePayload,
    });
    const inserted = await runQuery(
      `INSERT INTO audit_chain_entries
       (sequence, version, previous_hash, entry_hash, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING created_at`,
      [
        entry.sequence,
        AUDIT_CHAIN_VERSION,
        entry.previousHash,
        entry.hash,
        encodedPayload,
      ],
    );
    const updated = await runQuery(
      `UPDATE audit_chain_head
        SET last_sequence = $1, last_hash = $2, updated_at = now()
      WHERE singleton = true
        AND last_sequence = $3
        AND last_hash = $4`,
      [entry.sequence, entry.hash, lastSequence, entry.previousHash],
    );
    if (updated.rowCount !== 1) {
      throw new Error("Audit chain head changed during append");
    }
    return { ...entry, createdAt: inserted.rows[0]?.created_at };
  };
  return client
    ? appendOn((sql, params) => client.query(sql, params))
    : withTransaction(() => appendOn(query));
}

/** @param {{afterSequence?: number, limit?: number}} [options] */
export async function readAuditSegment({
  afterSequence = 0,
  limit = 1000,
} = {}) {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new RangeError("afterSequence must be a nonnegative safe integer");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError("Audit segment limit must be between 1 and 10000");
  }
  const result = await query(
    `SELECT sequence, version, previous_hash, entry_hash, payload, created_at
       FROM audit_chain_entries
      WHERE sequence > $1
      ORDER BY sequence ASC
      LIMIT $2`,
    [afterSequence, limit],
  );
  return result.rows.map((row) => ({
    sequence: parseSequence(row.sequence),
    version: Number(row.version),
    previousHash: row.previous_hash,
    hash: row.entry_hash,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}

export async function readAuditHead() {
  const result = await query(
    `SELECT last_sequence, last_hash, updated_at,
            legacy_db_editor_max_id, legacy_split_max_id,
            legacy_retag_max_id
       FROM audit_chain_head
      WHERE singleton = true`,
  );
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error("Audit chain head is missing or duplicated");
  }
  return {
    sequence: parseSequence(row.last_sequence),
    hash: row.last_hash,
    updatedAt: row.updated_at,
    legacyCutover: {
      dbEditorMaxId: parseSequence(row.legacy_db_editor_max_id),
      splitMaxId: parseSequence(row.legacy_split_max_id),
      retagMaxId: parseSequence(row.legacy_retag_max_id),
    },
  };
}

/**
 * Record metadata for a receipt already persisted by an independent anchor.
 * This call rechecks the anchored entry under a lock. It cannot make the
 * external receipt and database transaction atomic.
 *
 * @param {{sequence: number, headHash: string, anchorKind: string, receiptId: string, receiptHash: string}} receipt
 */
export async function recordAuditCheckpoint(receipt) {
  if (
    !receipt ||
    !Number.isSafeInteger(receipt.sequence) ||
    receipt.sequence < 0 ||
    !HASH_PATTERN.test(receipt.headHash) ||
    !HASH_PATTERN.test(receipt.receiptHash) ||
    typeof receipt.anchorKind !== "string" ||
    receipt.anchorKind.length < 1 ||
    receipt.anchorKind.length > 100 ||
    typeof receipt.receiptId !== "string" ||
    receipt.receiptId.length < 1 ||
    receipt.receiptId.length > 300
  ) {
    throw new TypeError("Invalid audit checkpoint metadata");
  }
  return withTransaction(async () => {
    const locked = await query(
      `SELECT last_sequence, last_hash
       FROM audit_chain_head
      WHERE singleton = true
      FOR UPDATE`,
    );
    if (locked.rows.length !== 1) {
      throw new Error("Audit chain head is missing or duplicated");
    }
    const currentSequence = parseSequence(locked.rows[0].last_sequence);
    if (receipt.sequence > currentSequence) {
      throw new Error("Audit checkpoint is ahead of current head");
    }
    const anchoredHash =
      receipt.sequence === currentSequence
        ? locked.rows[0].last_hash
        : receipt.sequence === 0
          ? AUDIT_CHAIN_GENESIS_HASH
          : (
              await query(
                `SELECT entry_hash FROM audit_chain_entries WHERE sequence = $1`,
                [receipt.sequence],
              )
            ).rows[0]?.entry_hash;
    if (anchoredHash !== receipt.headHash) {
      throw new Error("Audit checkpoint does not match stored history");
    }
    const result = await query(
      `INSERT INTO audit_chain_checkpoints
       (sequence, head_hash, anchor_kind, receipt_id, receipt_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (anchor_kind, receipt_id) DO NOTHING
     RETURNING id, created_at`,
      [
        receipt.sequence,
        receipt.headHash,
        receipt.anchorKind,
        receipt.receiptId,
        receipt.receiptHash,
      ],
    );
    if (result.rowCount === 1) {
      return { id: result.rows[0].id, createdAt: result.rows[0].created_at };
    }
    const existing = await query(
      `SELECT id, sequence, head_hash, receipt_hash, created_at
         FROM audit_chain_checkpoints
        WHERE anchor_kind = $1 AND receipt_id = $2`,
      [receipt.anchorKind, receipt.receiptId],
    );
    const row = existing.rows[0];
    if (
      existing.rows.length !== 1 ||
      parseSequence(row.sequence) !== receipt.sequence ||
      row.head_hash !== receipt.headHash ||
      row.receipt_hash !== receipt.receiptHash
    ) {
      throw new Error("Audit checkpoint receipt identity conflicts");
    }
    return { id: row.id, createdAt: row.created_at };
  });
}

export default {
  appendAuditEvent,
  readAuditSegment,
  readAuditHead,
  recordAuditCheckpoint,
};
