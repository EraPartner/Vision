import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAuditEntry,
  AUDIT_CHAIN_GENESIS_HASH,
} from "../src/lib/auditChainCore.js";
import { verifyAuditHistory } from "../src/services/auditVerificationService.js";

const digest = (values) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");

function fixture(
  payloads,
  { head, rows = {}, coverage = {}, revisions = [] } = {},
) {
  const entries = [];
  let hash = AUDIT_CHAIN_GENESIS_HASH;
  for (const payload of payloads) {
    const entry = createAuditEntry({
      sequence: entries.length + 1,
      previousHash: hash,
      payload,
    });
    entries.push(entry);
    hash = entry.hash;
  }
  const currentHead = {
    sequence: entries.length,
    hash,
    legacyCutover: { dbEditorMaxId: 0, splitMaxId: 0, retagMaxId: 0 },
    ...head,
  };
  return {
    entries,
    head: currentHead,
    options: {
      pageSize: 1,
      readHead: async () => currentHead,
      readSegment: async ({ afterSequence, limit }) =>
        entries.filter((e) => e.sequence > afterSequence).slice(0, limit),
      runQuery: async (sql) => {
        if (sql.includes("FROM alembic_version"))
          return { rows: revisions.map((version_num) => ({ version_num })) };
        if (sql.includes("FROM db_editor_audit WHERE id"))
          return { rows: rows.dbEditor ?? [] };
        if (sql.includes("FROM split_audit WHERE id"))
          return { rows: rows.split ?? [] };
        if (sql.includes("FROM portfolio_retag_audit WHERE id"))
          return { rows: rows.retag ?? [] };
        return {
          rows: [
            {
              db_editor_legacy: "0",
              db_editor_missing: "0",
              split_legacy: "0",
              split_missing: "0",
              portfolio_retag_legacy: "0",
              portfolio_retag_missing: "0",
              ...coverage,
            },
          ],
        };
      },
    },
  };
}

describe("verifyAuditHistory", () => {
  it("verifies a retained chain only from the signed one-year boundary", async () => {
    const f = fixture([
      { stream: "other", event: "old" },
      { stream: "other", event: "kept-a" },
      { stream: "other", event: "kept-b" },
    ]);
    const trustedCheckpoint = {
      sequence: f.head.sequence,
      hash: f.head.hash,
      retention: {
        through: 1,
        hash: f.entries[0].hash,
        domainMax: { dbEditor: 0, split: 0, retag: 0 },
        migrationHeads: [],
      },
    };
    expect(
      (await verifyAuditHistory({ ...f.options, trustedCheckpoint })).status,
    ).toBe("verified");
    const retained = {
      ...f.options,
      readSegment: async ({ afterSequence, limit }) =>
        f.entries
          .filter(
            (entry) => entry.sequence > afterSequence && entry.sequence > 1,
          )
          .slice(0, limit),
    };
    expect(
      await verifyAuditHistory({ ...retained, trustedCheckpoint }),
    ).toMatchObject({
      status: "verified",
      retentionThrough: 1,
    });
    expect(
      (await verifyAuditHistory({ ...retained, trustedCheckpoint: f.head }))
        .code,
    ).toBe("retention_boundary");
    expect(
      (
        await verifyAuditHistory({
          ...retained,
          trustedCheckpoint: {
            ...trustedCheckpoint,
            retention: { ...trustedCheckpoint.retention, hash: "a".repeat(64) },
          },
        })
      ).code,
    ).toBe("retention_boundary");
  });
  it("checks Alembic's current revision against the last chained migration event", async () => {
    const payload = {
      stream: "schema_migration",
      event: "revision_applied",
      direction: "upgrade",
      revision: "0117_audit_chain",
      heads: ["0117_audit_chain"],
    };
    const f = fixture([payload], { revisions: ["0117_audit_chain"] });
    expect(
      (await verifyAuditHistory({ ...f.options, trustedCheckpoint: f.head }))
        .status,
    ).toBe("verified");
    const changed = fixture([payload], {
      revisions: ["0116_analysis_monitors"],
    });
    expect(
      (
        await verifyAuditHistory({
          ...changed.options,
          trustedCheckpoint: changed.head,
        })
      ).code,
    ).toBe("migration_version_mismatch");
  });

  it("verifies bounded pages and an exact external checkpoint", async () => {
    const f = fixture([
      { stream: "other", event: "one" },
      { stream: "other", event: "two" },
    ]);
    expect(
      await verifyAuditHistory({ ...f.options, trustedCheckpoint: f.head }),
    ).toMatchObject({
      status: "verified",
      sequence: 2,
      anchoredThrough: 2,
    });
  });

  it("does not call database-local integrity a verified anchor", async () => {
    const f = fixture([{ stream: "other" }]);
    expect(await verifyAuditHistory(f.options)).toMatchObject({
      status: "unavailable",
      reason: "trusted_checkpoint_absent",
    });
    expect(
      await verifyAuditHistory({
        ...f.options,
        trustedCheckpoint: { sequence: 0, hash: AUDIT_CHAIN_GENESIS_HASH },
      }),
    ).toMatchObject({
      status: "partially_verified",
      anchoredThrough: 0,
    });
  });

  it("detects rollback, rewritten prefix, missing entry, and false head", async () => {
    const f = fixture([{ stream: "other" }, { stream: "other" }]);
    expect(
      (
        await verifyAuditHistory({
          ...f.options,
          trustedCheckpoint: { sequence: 3, hash: f.head.hash },
        })
      ).code,
    ).toBe("rollback");
    expect(
      (
        await verifyAuditHistory({
          ...f.options,
          trustedCheckpoint: { sequence: 1, hash: "a".repeat(64) },
        })
      ).code,
    ).toBe("checkpoint_hash");
    expect(
      (
        await verifyAuditHistory({
          ...f.options,
          readSegment: async ({ afterSequence }) =>
            f.entries.filter(
              (e) => e.sequence > afterSequence && e.sequence !== 1,
            ),
        })
      ).code,
    ).toBe("retention_boundary");
    expect(
      (
        await verifyAuditHistory({
          ...f.options,
          readHead: async () => ({ sequence: 2, hash: "b".repeat(64) }),
        })
      ).code,
    ).toBe("head_mismatch");
  });

  it("recomputes the DB editor digest from PostgreSQL text fields", async () => {
    const row = {
      table_name: "transactions",
      op: "UPDATE",
      pk_text: '{"id": 1}',
      before_text: '{"x": 1}',
      after_text: '{"x": 2}',
      statement: "UPDATE transactions",
      occurred_at: "2026-09-20T00:00:00.123456Z",
    };
    const payload = {
      stream: "db_editor",
      event: row.op,
      auditRowId: "9",
      table: row.table_name,
      occurred_at: row.occurred_at,
      auditDigest: digest([
        row.table_name,
        row.op,
        row.pk_text,
        row.before_text,
        row.after_text,
        row.statement,
        row.occurred_at,
      ]),
    };
    const f = fixture([payload], { rows: { dbEditor: [row] } });
    expect(
      (await verifyAuditHistory({ ...f.options, trustedCheckpoint: f.head }))
        .status,
    ).toBe("verified");
    row.after_text = '{"x": 3}';
    expect(
      (await verifyAuditHistory({ ...f.options, trustedCheckpoint: f.head }))
        .code,
    ).toBe("domain_digest");
    row.after_text = '{"x": 2}';
    row.occurred_at = "2026-09-20T00:00:00.123457Z";
    expect(
      (await verifyAuditHistory({ ...f.options, trustedCheckpoint: f.head }))
        .code,
    ).toBe("domain_metadata");
  });

  it("recomputes the split digest and checks metadata", async () => {
    const row = {
      split_id_text: "7",
      action: "create",
      actor: null,
      payload_text: '{"amount": 4}',
      occurred_at: "2026-09-20T00:00:00.123456Z",
    };
    const payload = {
      stream: "split",
      event: row.action,
      auditRowId: "4",
      splitId: row.split_id_text,
      actor: null,
      occurred_at: row.occurred_at,
      auditDigest: digest([
        row.split_id_text,
        row.action,
        row.actor,
        row.payload_text,
        row.occurred_at,
      ]),
    };
    const f = fixture([payload], { rows: { split: [row] } });
    expect(
      (await verifyAuditHistory({ ...f.options, trustedCheckpoint: f.head }))
        .status,
    ).toBe("verified");
    row.action = "delete";
    expect(
      (await verifyAuditHistory({ ...f.options, trustedCheckpoint: f.head }))
        .code,
    ).toBe("domain_metadata");
    row.action = "create";
    row.occurred_at = "2026-09-20T00:00:00.123457Z";
    expect(
      (await verifyAuditHistory({ ...f.options, trustedCheckpoint: f.head }))
        .code,
    ).toBe("domain_metadata");
  });

  it("compares the complete portfolio retag receipt", async () => {
    const row = {
      id: "6",
      created_at: new Date("2026-01-01T00:00:00Z"),
      occurred_at: "2026-01-01T00:00:00.000000Z",
      idempotency_key: "a",
      request_fingerprint: "f",
      from_account_id: 1,
      to_account_id: 2,
      transaction_ids: [3],
      previous_assignments: [{ transaction_id: 3, account_id: 1 }],
      selected_count: 1,
      changed_count: 1,
    };
    const payload = {
      stream: "portfolio_retag",
      event: "receipt_created",
      receipt_id: "6",
      occurred_at: row.occurred_at,
      idempotency_key: "a",
      request_fingerprint: "f",
      from_account_id: 1,
      to_account_id: 2,
      transaction_ids: [3],
      previous_assignments: [{ transaction_id: 3, account_id: 1 }],
      selected_count: 1,
      changed_count: 1,
    };
    const f = fixture([payload], { rows: { retag: [row] } });
    expect(
      (await verifyAuditHistory({ ...f.options, trustedCheckpoint: f.head }))
        .status,
    ).toBe("verified");
    row.changed_count = 0;
    expect(
      (await verifyAuditHistory({ ...f.options, trustedCheckpoint: f.head }))
        .code,
    ).toBe("domain_digest");
  });

  it("distinguishes unverified pre-cutover rows from missing later links", async () => {
    const f = fixture([], {
      head: {
        legacyCutover: {
          dbEditorMaxId: 10,
          splitMaxId: 4,
          retagMaxId: 2,
        },
      },
      coverage: {
        db_editor_legacy: "3",
        split_legacy: "1",
        portfolio_retag_legacy: "2",
      },
    });
    expect(
      await verifyAuditHistory({
        ...f.options,
        trustedCheckpoint: { sequence: 0, hash: AUDIT_CHAIN_GENESIS_HASH },
      }),
    ).toMatchObject({
      status: "verified",
      legacyCutover: { dbEditorMaxId: 10, splitMaxId: 4, retagMaxId: 2 },
      legacyUnverified: { dbEditor: "3", split: "1", portfolioRetag: "2" },
    });
    const missing = fixture([], { coverage: { db_editor_missing: "1" } });
    expect(
      (
        await verifyAuditHistory({
          ...missing.options,
          trustedCheckpoint: { sequence: 0, hash: AUDIT_CHAIN_GENESIS_HASH },
        })
      ).code,
    ).toBe("missing_post_cutover_domain_link");
  });
});
