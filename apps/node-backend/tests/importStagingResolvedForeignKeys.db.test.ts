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
import { must } from "./helpers/must.ts";
import type { RecipientId } from "@vision/types/brands";

/** A result row whose columns the test reads without a fixed shape. */
type DbRow = Record<string, unknown>;

// Only dereferenced inside the describeDb-gated suites.
const maybePool = getTestPool();
const pool = () => must(maybePool, "test pool");
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
      const fk = await pool().query<DbRow>(
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

      const index = await pool().query<DbRow>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = $1`,
        [`idx_import_staging_rows_${column}`],
      );
      expect(index.rows, column).toHaveLength(1);
      expect(must(index.rows[0], "index.rows[0]").indexdef).toContain(
        `(${column})`,
      );
      expect(must(index.rows[0], "index.rows[0]").indexdef).toContain(
        `WHERE (${column} IS NOT NULL)`,
      );
    }
  });

  it("rejects dangling resolved ids and clears them when parents are deleted", async () => {
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      const recipient = await client.query<{ id: RecipientId }>(
        `INSERT INTO recipients (name, normalized_name)
         VALUES ('_0091_recipient', '_0091_recipient')
         RETURNING id`,
      );
      const recipientId = must(recipient.rows[0], "recipient.rows[0]").id;
      const batch = await client.query<{ id: string }>(
        `INSERT INTO import_batches (adapter_name)
         VALUES ('_0091')
         RETURNING id`,
      );
      const batchId = must(batch.rows[0], "batch.rows[0]").id;
      const staging = await client.query<{ id: string }>(
        `INSERT INTO import_staging_rows
           (batch_id, row_index, resolved_recipient_id)
         VALUES ($1, 0, $2)
         RETURNING id`,
        [batchId, recipientId],
      );
      const stagingId = must(staging.rows[0], "staging.rows[0]").id;

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
          (error: unknown) => error,
        );
      expect(danglingError).toMatchObject({
        code: "23503",
        constraint: "fk_import_staging_rows_resolved_recipient",
      });
      await client.query("ROLLBACK TO SAVEPOINT before_dangling");

      await client.query("DELETE FROM recipients WHERE id = $1", [recipientId]);
      const cleared = await client.query<DbRow>(
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
