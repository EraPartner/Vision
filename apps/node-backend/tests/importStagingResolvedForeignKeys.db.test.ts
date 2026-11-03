/**
 * Real-database pins for the import staging resolved foreign keys: catalog
 * shape and database behaviour that source inspection cannot prove.
 * Every data mutation is rolled back.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  inRollbackTransaction,
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
    const table = await pool().query<{ sql: string }>(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'import_staging_rows'",
    );
    const tableSql = must(table.rows[0], "import_staging_rows DDL").sql;
    for (const [constraint, column, parentTable] of CURRENT_FOREIGN_KEYS) {
      // SQLite's catalog has no constraint names: the name lives in the DDL,
      // and pragma_foreign_key_list gives the column, parent and action.
      expect(tableSql, constraint).toContain(
        `CONSTRAINT ${constraint} FOREIGN KEY (${column}) REFERENCES ${parentTable}(id) ON DELETE SET NULL`,
      );
      const fk = await pool().query<DbRow>(
        `SELECT "table" AS parent_table, "to" AS parent_column, on_delete
           FROM pragma_foreign_key_list('import_staging_rows')
          WHERE "from" = $1`,
        [column],
      );
      expect(fk.rows, constraint).toEqual([
        { parent_table: parentTable, parent_column: "id", on_delete: "SET NULL" },
      ]);

      const index = await pool().query<DbRow>(
        `SELECT s.sql AS indexdef, l.partial
           FROM sqlite_schema s
           JOIN pragma_index_list('import_staging_rows') l ON l.name = s.name
          WHERE s.type = 'index'
            AND s.name = $1`,
        [`idx_import_staging_rows_${column}`],
      );
      expect(index.rows, column).toHaveLength(1);
      expect(must(index.rows[0], "index.rows[0]").partial).toBe(1);
      expect(must(index.rows[0], "index.rows[0]").indexdef).toContain(
        `(${column})`,
      );
      expect(must(index.rows[0], "index.rows[0]").indexdef).toContain(
        `WHERE ${column} IS NOT NULL`,
      );
    }
    // Validated: no stored row violates a foreign key of the table.
    const violations = await pool().query<DbRow>(
      "SELECT * FROM pragma_foreign_key_check('import_staging_rows')",
    );
    expect(violations.rows).toEqual([]);
  });

  it("rejects dangling resolved ids and clears them when parents are deleted", async () => {
    // inRollbackTransaction is the BEGIN … ROLLBACK of a dedicated client: the
    // reads below run on the writer inside the same transaction.
    await inRollbackTransaction(async (client) => {
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
      // SQLite does not name the failed foreign key (src/database/sqlite/errors.ts);
      // batch_id is valid, so the resolved-recipient key is the one refused.
      expect(danglingError).toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT before_dangling");
      await client.query("RELEASE SAVEPOINT before_dangling");

      await client.query("DELETE FROM recipients WHERE id = $1", [recipientId]);
      const cleared = await client.query<DbRow>(
        `SELECT resolved_recipient_id
           FROM import_staging_rows
          WHERE id = $1`,
        [stagingId],
      );
      expect(cleared.rows).toEqual([{ resolved_recipient_id: null }]);
    });
    // Rolled back: nothing of the fixture is left behind.
    const left = await pool().query<DbRow>(
      "SELECT id FROM recipients WHERE normalized_name = '_0091_recipient'",
    );
    expect(left.rows).toEqual([]);
  });
});
