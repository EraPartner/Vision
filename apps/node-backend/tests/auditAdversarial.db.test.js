import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { appendAuditEvent } from "../src/repositories/auditChainRepository.js";
import { verifyAuditHistory } from "../src/services/auditVerificationService.js";
import {
  planAuditRetention,
  pruneAuditRetention,
} from "../src/services/auditRetentionService.js";

const pool = getTestPool();

beforeAll(acquireDbSuiteLock, 180_000);
afterAll(async () => {
  await releaseDbSuiteLock();
  await closeTestPool();
});

describe("audit chain adversarial PostgreSQL verification", () => {
  it.skipIf(!pool)(
    "prunes only a complete old prefix behind a recorded external checkpoint",
    async () => {
      const client = await pool.connect();
      await client.query("BEGIN");
      try {
        const before = await client.query(
          "SELECT last_sequence FROM audit_chain_head WHERE singleton = true",
        );
        const start = Number(before.rows[0].last_sequence);
        for (const label of ["old-a", "old-b", "new"]) {
          await appendAuditEvent(
            { stream: "test_retention", event: label },
            client,
          );
        }
        const through = start + 2;
        const prefixCount = await client.query(
          "SELECT count(*) AS count FROM audit_chain_entries WHERE sequence <= $1",
          [through],
        );
        const boundary = await client.query(
          "SELECT entry_hash FROM audit_chain_entries WHERE sequence = $1",
          [through],
        );
        await client.query("SAVEPOINT audit_retention_reject");
        await expect(
          client.query("SELECT audit_chain_prune_prefix($1, $2::char(64))", [
            through,
            boundary.rows[0].entry_hash,
          ]),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT audit_retention_reject");
        await client.query(
          `INSERT INTO audit_chain_checkpoints
             (sequence, head_hash, anchor_kind, receipt_id, receipt_hash)
           SELECT last_sequence, last_hash, 'macos_keychain_witness_hmac_v3',
                  'synthetic-retention-test', repeat('f',64)
             FROM audit_chain_head WHERE singleton = true`,
        );
        await client.query(
          "ALTER TABLE audit_chain_entries DISABLE TRIGGER audit_chain_entries_immutable",
        );
        await client.query(
          "UPDATE audit_chain_entries SET created_at = now() - interval '2 years' WHERE sequence <= $1",
          [through],
        );
        await client.query(
          "ALTER TABLE audit_chain_entries ENABLE TRIGGER audit_chain_entries_immutable",
        );
        await client.query("SAVEPOINT audit_retention_wrong_hash");
        await expect(
          client.query("SELECT audit_chain_prune_prefix($1, $2::char(64))", [
            through,
            "a".repeat(64),
          ]),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT audit_retention_wrong_hash");
        const pruned = await client.query(
          "SELECT audit_chain_prune_prefix($1, $2::char(64)) AS removed",
          [through, boundary.rows[0].entry_hash],
        );
        expect(Number(pruned.rows[0].removed)).toBe(
          Number(prefixCount.rows[0].count),
        );
        const remaining = await client.query(
          "SELECT sequence, previous_hash FROM audit_chain_entries ORDER BY sequence",
        );
        expect(Number(remaining.rows[0].sequence)).toBe(through + 1);
        expect(remaining.rows[0].previous_hash).toBe(
          boundary.rows[0].entry_hash,
        );
        const repeated = await client.query(
          "SELECT audit_chain_prune_prefix($1, $2::char(64)) AS removed",
          [through, boundary.rows[0].entry_hash],
        );
        expect(Number(repeated.rows[0].removed)).toBe(0);
        await client.query("SAVEPOINT audit_retention_immutable");
        await expect(
          client.query("DELETE FROM audit_chain_entries WHERE sequence = $1", [
            through + 1,
          ]),
        ).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT audit_retention_immutable");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    },
  );
  it.skipIf(!pool)(
    "detects altered, missing, inserted, reordered, and rolled-back entries",
    async () => {
      const client = await pool.connect();
      await client.query("BEGIN");
      try {
        const initial = await client.query(
          "SELECT last_sequence FROM audit_chain_head WHERE singleton = true",
        );
        const firstSequence = Number(initial.rows[0].last_sequence) + 1;
        for (const label of ["one", "two", "three"]) {
          await appendAuditEvent(
            { stream: "test_adversarial", event: label, actor: "synthetic" },
            client,
          );
        }
        const headQuery = async () => {
          const result = await client.query(
            `SELECT last_sequence, last_hash,
                    legacy_db_editor_max_id, legacy_split_max_id,
                    legacy_retag_max_id
               FROM audit_chain_head WHERE singleton = true`,
          );
          const row = result.rows[0];
          return {
            sequence: Number(row.last_sequence),
            hash: row.last_hash,
            legacyCutover: {
              dbEditorMaxId: Number(row.legacy_db_editor_max_id),
              splitMaxId: Number(row.legacy_split_max_id),
              retagMaxId: Number(row.legacy_retag_max_id),
            },
          };
        };
        const readSegment = async ({ afterSequence, limit }) => {
          const result = await client.query(
            `SELECT sequence, version, previous_hash, entry_hash, payload, created_at
               FROM audit_chain_entries
              WHERE sequence > $1 ORDER BY sequence LIMIT $2`,
            [afterSequence, limit],
          );
          return result.rows.map((row) => ({
            sequence: Number(row.sequence),
            version: row.version,
            previousHash: row.previous_hash,
            hash: row.entry_hash,
            payload: row.payload,
            createdAt: row.created_at,
          }));
        };
        const head = await headQuery();
        const verify = () =>
          verifyAuditHistory({
            trustedCheckpoint: head,
            readHead: headQuery,
            readSegment,
            runQuery: (sql, params) => client.query(sql, params),
          });
        expect((await verify()).status).toBe("verified");

        async function mutated(sql, expectedCodes) {
          await client.query("SAVEPOINT audit_attack");
          try {
            await client.query(
              "ALTER TABLE audit_chain_entries DISABLE TRIGGER audit_chain_entries_immutable",
            );
            await client.query(sql);
            const result = await verify();
            expect(result.status).toBe("failed");
            expect(expectedCodes).toContain(result.code);
          } finally {
            await client.query("ROLLBACK TO SAVEPOINT audit_attack");
          }
        }

        await mutated(
          `UPDATE audit_chain_entries
              SET payload = '{"stream":"test_adversarial","event":"altered"}'::jsonb
            WHERE sequence = ${firstSequence}`,
          ["hash"],
        );
        await mutated(
          `DELETE FROM audit_chain_entries WHERE sequence = ${firstSequence + 1}`,
          ["sequence"],
        );
        await mutated(
          `INSERT INTO audit_chain_entries
             (sequence, version, previous_hash, entry_hash, payload)
           VALUES (${head.sequence + 1}, 1, repeat('0',64), repeat('a',64),
                   '{"stream":"test_adversarial","event":"inserted"}'::jsonb)`,
          ["concurrent_change_or_head_mismatch"],
        );
        await mutated(
          `UPDATE audit_chain_entries SET sequence = 1000000
            WHERE sequence = ${firstSequence};
           UPDATE audit_chain_entries SET sequence = ${firstSequence}
            WHERE sequence = ${firstSequence + 1};
           UPDATE audit_chain_entries SET sequence = ${firstSequence + 1}
            WHERE sequence = 1000000`,
          ["sequence", "previous_hash", "hash"],
        );
        await client.query("SAVEPOINT audit_rollback");
        try {
          await client.query(
            "ALTER TABLE audit_chain_entries DISABLE TRIGGER audit_chain_entries_immutable",
          );
          await client.query(
            "DELETE FROM audit_chain_entries WHERE sequence = $1",
            [head.sequence],
          );
          await client.query(
            `UPDATE audit_chain_head SET last_sequence = $1,
                    last_hash = (SELECT entry_hash FROM audit_chain_entries WHERE sequence = $1)
              WHERE singleton = true`,
            [head.sequence - 1],
          );
          expect((await verify()).code).toBe("rollback");
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT audit_rollback");
        }
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    },
  );
  it.skipIf(!pool)(
    "plans, signs, prunes, and verifies a retained suffix through the backend service",
    async () => {
      for (const event of ["old-a", "old-b", "new"]) {
        await appendAuditEvent({ stream: "test_retention_service", event });
      }
      const head = await pool.query(
        "SELECT last_sequence, last_hash FROM audit_chain_head WHERE singleton = true",
      );
      const checkpoint = {
        sequence: Number(head.rows[0].last_sequence),
        hash: head.rows[0].last_hash,
      };
      const through = checkpoint.sequence - 1;
      await pool.query(
        `INSERT INTO audit_chain_checkpoints
           (sequence, head_hash, anchor_kind, receipt_id, receipt_hash)
         VALUES ($1, $2, 'macos_keychain_witness_hmac_v3',
                 'synthetic-service-retention', repeat('f',64))`,
        [checkpoint.sequence, checkpoint.hash],
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "ALTER TABLE audit_chain_entries DISABLE TRIGGER audit_chain_entries_immutable",
        );
        await client.query(
          "UPDATE audit_chain_entries SET created_at = now() - interval '2 years' WHERE sequence <= $1",
          [through],
        );
        await client.query(
          "ALTER TABLE audit_chain_entries ENABLE TRIGGER audit_chain_entries_immutable",
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      expect(
        (await verifyAuditHistory({ trustedCheckpoint: checkpoint })).status,
      ).toBe("verified");
      const plan = await planAuditRetention(checkpoint);
      expect(plan).toMatchObject({ eligible: true, through });
      const signed = {
        ...checkpoint,
        retention: {
          through: plan.through,
          hash: plan.hash,
          domainMax: plan.domainMax,
          migrationHeads: plan.migrationHeads,
        },
      };
      expect(
        (await verifyAuditHistory({ trustedCheckpoint: signed })).status,
      ).toBe("verified");
      expect((await pruneAuditRetention(signed)).removed).toBe(through);
      expect((await pruneAuditRetention(signed)).removed).toBe(0);
      expect(
        await verifyAuditHistory({ trustedCheckpoint: signed }),
      ).toMatchObject({
        status: "verified",
        retentionThrough: through,
      });
      expect(
        (await verifyAuditHistory({ trustedCheckpoint: checkpoint })).status,
      ).toBe("failed");
    },
    30_000,
  );

  it.skipIf(!pool || process.env.VISION_RUN_AUDIT_PERFORMANCE !== "1")(
    "measures a bounded audit append sample on disposable PostgreSQL",
    async () => {
      const client = await pool.connect();
      const samples = [];
      try {
        await client.query("BEGIN");
        for (let index = 0; index < 100; index += 1) {
          const start = performance.now();
          await appendAuditEvent(
            { stream: "synthetic_audit_performance", index },
            client,
          );
          samples.push(performance.now() - start);
        }
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      samples.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          auditAppendSample: "single transaction, 100 synthetic entries",
          medianMs: Number(samples[49].toFixed(3)),
          p95Ms: Number(samples[94].toFixed(3)),
          maxMs: Number(samples[99].toFixed(3)),
        }),
      );
      expect(samples).toHaveLength(100);
    },
    30_000,
  );
});
