/**
 * Real-Postgres pins for the import staging resolved foreign keys: catalog
 * shape and database behaviour that source inspection cannot prove.
 * Every data mutation is rolled back.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";

// Only dereferenced inside the describeDb-gated suites.
const pool = getTestPool()!;
const describeDb = hasTestDatabase() ? describe : describe.skip;

const CURRENT_FOREIGN_KEYS = [
  [
    "fk_import_staging_rows_resolved_recipient",
    "resolved_recipient_id",
    "recipients",
  ],
] as const;

describeDb("current import staging resolved foreign keys", () => {
  beforeAll(async () => {
    await acquireDbSuiteLock();
  }, 180_000);

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
  });

  it("has validated ON DELETE SET NULL constraints and covering indexes", async () => {
    for (const [constraint, column, parentTable] of CURRENT_FOREIGN_KEYS) {
      const fk = await pool.query(
        `SELECT convalidated, confdeltype, confrelid::regclass::text AS parent_table
           FROM pg_constraint
          WHERE conname = $1
            AND conrelid = 'public.import_staging_rows'::regclass
            AND contype = 'f'`,
        [constraint],
      );
      expect(fk.rows, constraint).toEqual([
        {
          convalidated: true,
          confdeltype: "n",
          parent_table: parentTable,
        },
      ]);

      const index = await pool.query(
        `SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = $1`,
        [`idx_import_staging_rows_${column}`],
      );
      expect(index.rows, column).toHaveLength(1);
      expect(index.rows[0].indexdef).toContain(`(${column})`);
      expect(index.rows[0].indexdef).toContain(`WHERE (${column} IS NOT NULL)`);
    }
  });

  it("rejects dangling resolved ids and clears them when parents are deleted", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const recipient = await client.query(
        `INSERT INTO recipients (name, normalized_name)
         VALUES ('_0091_recipient', '_0091_recipient')
         RETURNING id`,
      );
      const recipientId = recipient.rows[0].id;
      const batch = await client.query(
        `INSERT INTO import_batches (adapter_name)
         VALUES ('_0091')
         RETURNING id`,
      );
      const batchId = batch.rows[0].id;
      const staging = await client.query(
        `INSERT INTO import_staging_rows
           (batch_id, row_index, resolved_recipient_id)
         VALUES ($1, 0, $2)
         RETURNING id`,
        [batchId, recipientId],
      );
      const stagingId = staging.rows[0].id;

      await client.query("SAVEPOINT before_dangling");
      const danglingError = await client
        .query(
          `INSERT INTO import_staging_rows
             (batch_id, row_index, resolved_recipient_id)
           VALUES ($1, 1, 2147483647)`,
          [batchId],
        )
        .then(
          () => null,
          (error) => error,
        );
      expect(danglingError?.code).toBe("23503");
      expect(danglingError?.constraint).toBe(
        "fk_import_staging_rows_resolved_recipient",
      );
      await client.query("ROLLBACK TO SAVEPOINT before_dangling");

      await client.query("DELETE FROM recipients WHERE id = $1", [recipientId]);
      const cleared = await client.query(
        `SELECT resolved_recipient_id
           FROM import_staging_rows
          WHERE id = $1`,
        [stagingId],
      );
      expect(cleared.rows).toEqual([{ resolved_recipient_id: null }]);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});
