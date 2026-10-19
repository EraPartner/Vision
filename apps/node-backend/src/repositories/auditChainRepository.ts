/**
 * Persistence for the versioned audit hash chain. Call appendAuditEvent inside
 * the same withTransaction callback as the domain mutation. The row lock on
 * audit_chain_head serializes concurrent writers across processes.
 *
 * This repository does not create or verify the independent anchor receipt.
 * A database-local chain and checkpoint table cannot detect a coordinated
 * privileged rewrite or restore of an older database snapshot.
 */
import { sql } from "kysely";
import { query, withTransaction } from "../database/connection.ts";
import type { PgQueryResult } from "../database/connection.ts";
import { checkedRow, checkedRows, compileQuery, db } from "../database/db.ts";
import type { BuiltQuery } from "../database/db.ts";
import { checkRows } from "../database/rowContracts.ts";
import {
  auditCheckpointInsertedRowSchema,
  auditCheckpointRowSchema,
  auditEntryCreatedRowSchema,
  auditEntryHashRowSchema,
  auditEntryRowSchema,
  auditHeadDetailRowSchema,
  auditHeadRowSchema,
  auditLatestEntryRowSchema,
} from "../database/rows/audit.ts";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  AUDIT_CHAIN_VERSION,
  canonicalAuditPayload,
  createAuditEntry,
} from "../lib/auditChainCore.ts";
import type { AuditEntry } from "../lib/auditChainCore.ts";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

type RunQuery = (text: string, params?: unknown[]) => Promise<PgQueryResult>;

/** The chain head is a single row keyed by `singleton = true`. */
const SINGLETON = sql.lit(true);

function lockHead() {
  return db
    .selectFrom("audit_chain_head")
    .select(["last_sequence", "last_hash"])
    .where("singleton", "=", SINGLETON)
    .forUpdate();
}

export type StoredAuditEntry = Omit<AuditEntry, "payload"> & {
  payload: Record<string, unknown>;
  createdAt: Date;
};

export type AuditCheckpointReceipt = {
  sequence: number;
  headHash: string;
  anchorKind: string;
  receiptId: string;
  receiptHash: string;
};

function parseSequence(value: string | number): number {
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
 */
export async function appendAuditEvent(
  payload: Record<string, unknown>,
  client?: { query: RunQuery },
): Promise<AuditEntry & { createdAt: Date | undefined }> {
  if (payload == null || Array.isArray(payload) || typeof payload !== "object") {
    throw new TypeError("Audit event payload must be an object");
  }
  const encodedPayload = canonicalAuditPayload(payload);
  // Snapshot before awaiting the head lock so a caller cannot mutate an
  // object between hashing and the JSONB insert.
  const stablePayload = JSON.parse(encodedPayload);
  const appendOn = async (runQuery: RunQuery) => {
    const run = (builder: BuiltQuery) => {
      const compiled = compileQuery(builder);
      return runQuery(compiled.sql, [...compiled.parameters]);
    };
    const headResult = await run(lockHead());
    const headRows = checkRows(auditHeadRowSchema, headResult.rows);
    const head = headRows[0];
    if (!head || headRows.length !== 1) {
      throw new Error("Audit chain head is missing or duplicated");
    }
    const lastSequence = parseSequence(head.last_sequence);
    const latestResult = await run(
      db
        .selectFrom("audit_chain_entries")
        .select(["sequence", "entry_hash"])
        .orderBy("sequence", "desc")
        .limit(1),
    );
    const [latest] = checkRows(auditLatestEntryRowSchema, latestResult.rows);
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
    const inserted = await run(
      db
        .insertInto("audit_chain_entries")
        .values({
          sequence: entry.sequence,
          version: AUDIT_CHAIN_VERSION,
          previous_hash: entry.previousHash,
          entry_hash: entry.hash,
          payload: sql`${encodedPayload}::jsonb`,
        })
        .returning("created_at"),
    );
    const updated = await run(
      db
        .updateTable("audit_chain_head")
        .set({
          last_sequence: entry.sequence,
          last_hash: entry.hash,
          updated_at: sql<Date>`now()`,
        })
        .where("singleton", "=", SINGLETON)
        .where("last_sequence", "=", String(lastSequence))
        .where("last_hash", "=", entry.previousHash),
    );
    if (updated.rowCount !== 1) {
      throw new Error("Audit chain head changed during append");
    }
    const [insertedRow] = checkRows(auditEntryCreatedRowSchema, inserted.rows);
    return { ...entry, createdAt: insertedRow?.created_at };
  };
  return client
    ? appendOn((text, params) => client.query(text, params))
    : withTransaction(() => appendOn(query));
}

export async function readAuditSegment({
  afterSequence = 0,
  limit = 1000,
}: { afterSequence?: number; limit?: number } = {}): Promise<
  StoredAuditEntry[]
> {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new RangeError("afterSequence must be a nonnegative safe integer");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError("Audit segment limit must be between 1 and 10000");
  }
  const rows = await checkedRows(
    auditEntryRowSchema,
    db
      .selectFrom("audit_chain_entries")
      .select([
        "sequence",
        "version",
        "previous_hash",
        "entry_hash",
        "payload",
        "created_at",
      ])
      .where("sequence", ">", String(afterSequence))
      .orderBy("sequence", "asc")
      .limit(limit),
  );
  return rows.map((row) => ({
    sequence: parseSequence(row.sequence),
    version: Number(row.version),
    previousHash: row.previous_hash,
    hash: row.entry_hash,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}

export async function readAuditHead(): Promise<{
  sequence: number;
  hash: string;
  updatedAt: Date;
  legacyCutover: {
    dbEditorMaxId: number;
    splitMaxId: number;
    retagMaxId: number;
  };
}> {
  const rows = await checkedRows(
    auditHeadDetailRowSchema,
    db
      .selectFrom("audit_chain_head")
      .select([
        "last_sequence",
        "last_hash",
        "updated_at",
        "legacy_db_editor_max_id",
        "legacy_split_max_id",
        "legacy_retag_max_id",
      ])
      .where("singleton", "=", SINGLETON),
  );
  const row = rows[0];
  if (!row || rows.length !== 1) {
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
 */
export async function recordAuditCheckpoint(
  receipt: AuditCheckpointReceipt,
): Promise<{ id: string; createdAt: Date }> {
  if (
    receipt == null ||
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
    const locked = await checkedRows(auditHeadRowSchema, lockHead());
    const [lockedHead] = locked;
    if (!lockedHead || locked.length !== 1) {
      throw new Error("Audit chain head is missing or duplicated");
    }
    const currentSequence = parseSequence(lockedHead.last_sequence);
    if (receipt.sequence > currentSequence) {
      throw new Error("Audit checkpoint is ahead of current head");
    }
    const anchoredHash =
      receipt.sequence === currentSequence
        ? lockedHead.last_hash
        : receipt.sequence === 0
          ? AUDIT_CHAIN_GENESIS_HASH
          : (
              await checkedRow(
                auditEntryHashRowSchema,
                db
                  .selectFrom("audit_chain_entries")
                  .select("entry_hash")
                  .where("sequence", "=", String(receipt.sequence)),
              )
            )?.entry_hash;
    if (anchoredHash !== receipt.headHash) {
      throw new Error("Audit checkpoint does not match stored history");
    }
    const checkpoint = compileQuery(
      db
        .insertInto("audit_chain_checkpoints")
        .values({
          sequence: receipt.sequence,
          head_hash: receipt.headHash,
          anchor_kind: receipt.anchorKind,
          receipt_id: receipt.receiptId,
          receipt_hash: receipt.receiptHash,
        })
        .onConflict((oc) => oc.columns(["anchor_kind", "receipt_id"]).doNothing())
        .returning(["id", "created_at"]),
    );
    const result = await query(checkpoint.sql, [...checkpoint.parameters]);
    const [inserted] = checkRows(auditCheckpointInsertedRowSchema, result.rows);
    if (result.rowCount === 1 && inserted) {
      return { id: inserted.id, createdAt: inserted.created_at };
    }
    const existing = await checkedRows(
      auditCheckpointRowSchema,
      db
        .selectFrom("audit_chain_checkpoints")
        .select(["id", "sequence", "head_hash", "receipt_hash", "created_at"])
        .where("anchor_kind", "=", receipt.anchorKind)
        .where("receipt_id", "=", receipt.receiptId),
    );
    const row = existing[0];
    if (
      !row ||
      existing.length !== 1 ||
      parseSequence(row.sequence) !== receipt.sequence ||
      row.head_hash !== receipt.headHash ||
      row.receipt_hash !== receipt.receiptHash
    ) {
      throw new Error("Audit checkpoint receipt identity conflicts");
    }
    return { id: row.id, createdAt: row.created_at };
  });
}
