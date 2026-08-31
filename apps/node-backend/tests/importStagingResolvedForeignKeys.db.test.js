/**
 * Real-Postgres pins for migration 0091. The suite verifies the catalog shape
 * and database behavior that source-level migration inspection cannot prove.
 * Every data mutation is rolled back.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;

const FOREIGN_KEYS = [
  [
    "fk_import_staging_rows_resolved_recipient",
    "resolved_recipient_id",
    "recipients",
  ],
  [
    "fk_import_staging_rows_resolved_bank_account",
    "resolved_bank_account_id",
    "recipient_bank_accounts",
  ],
];

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const ALEMBIC_BIN = process.env.ALEMBIC_BIN || "alembic";
const ALEMBIC_CONFIG = path.join(REPO_ROOT, "config/alembic.ini");
const execFileAsync = promisify(execFile);

function scratchDbName() {
  const base = new URL(
    process.env.TEST_DATABASE_URL ?? "postgres://x/x",
  ).pathname.replace(/^\//, "");
  return `${base}_0091fks`;
}

function scratchUrl() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "postgres://x/x");
  url.pathname = `/${scratchDbName()}`;
  return url.toString();
}

function alembic(...args) {
  return execFileAsync(ALEMBIC_BIN, ["-c", ALEMBIC_CONFIG, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: scratchUrl() },
    timeout: 180_000,
  });
}

describeDb("import staging resolved foreign keys (migration 0091)", () => {
  beforeAll(async () => {
    await acquireDbSuiteLock();
  }, 180_000);

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
  });

  it("has validated ON DELETE SET NULL constraints and covering indexes", async () => {
    for (const [constraint, column, parentTable] of FOREIGN_KEYS) {
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
      const account = await client.query(
        `INSERT INTO recipient_bank_accounts (recipient_id, account_number)
         VALUES ($1, '_0091_account')
         RETURNING id`,
        [recipientId],
      );
      const accountId = account.rows[0].id;
      const batch = await client.query(
        `INSERT INTO import_batches (adapter_name)
         VALUES ('_0091')
         RETURNING id`,
      );
      const batchId = batch.rows[0].id;
      const staging = await client.query(
        `INSERT INTO import_staging_rows
           (batch_id, row_index, resolved_recipient_id, resolved_bank_account_id)
         VALUES ($1, 0, $2, $3)
         RETURNING id`,
        [batchId, recipientId, accountId],
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

      await client.query("SAVEPOINT before_dangling_account");
      const danglingAccountError = await client
        .query(
          `INSERT INTO import_staging_rows
             (batch_id, row_index, resolved_bank_account_id)
           VALUES ($1, 2, 2147483647)`,
          [batchId],
        )
        .then(
          () => null,
          (error) => error,
        );
      expect(danglingAccountError?.code).toBe("23503");
      expect(danglingAccountError?.constraint).toBe(
        "fk_import_staging_rows_resolved_bank_account",
      );
      await client.query("ROLLBACK TO SAVEPOINT before_dangling_account");

      await client.query("DELETE FROM recipient_bank_accounts WHERE id = $1", [
        accountId,
      ]);
      await client.query("DELETE FROM recipients WHERE id = $1", [recipientId]);
      const cleared = await client.query(
        `SELECT resolved_recipient_id, resolved_bank_account_id
           FROM import_staging_rows
          WHERE id = $1`,
        [stagingId],
      );
      expect(cleared.rows).toEqual([
        { resolved_recipient_id: null, resolved_bank_account_id: null },
      ]);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});

describeDb("migration 0091 orphan cleanup and rollback", () => {
  /** @type {pg.Client|null} */ let db = null;

  beforeAll(async () => {
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    await admin.query(
      `DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`,
    );
    await admin.query(
      `CREATE DATABASE ${scratchDbName()} WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'`,
    );
    await admin.end();

    db = new pg.Client({ connectionString: scratchUrl() });
    await db.connect();
    await db.query(
      "CREATE TABLE alembic_version (version_num VARCHAR(64) NOT NULL, CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))",
    );
    await alembic("upgrade", "0090_constraint_index_naming");

    const recipient = await db.query(
      `INSERT INTO recipients (name, normalized_name)
       VALUES ('_0091_valid', '_0091_valid')
       RETURNING id`,
    );
    const recipientId = recipient.rows[0].id;
    const account = await db.query(
      `INSERT INTO recipient_bank_accounts (recipient_id, account_number)
       VALUES ($1, '_0091_valid')
       RETURNING id`,
      [recipientId],
    );
    const accountId = account.rows[0].id;
    const batch = await db.query(
      `INSERT INTO import_batches (adapter_name)
       VALUES ('_0091_upgrade')
       RETURNING id`,
    );

    await db.query(
      `INSERT INTO import_staging_rows
         (batch_id, row_index, resolved_recipient_id, resolved_bank_account_id)
       VALUES
         ($1, 0, 2147483647, $2),
         ($1, 1, $3, 2147483647),
         ($1, 2, 2147483647, 2147483647),
         ($1, 3, $3, $2)`,
      [batch.rows[0].id, accountId, recipientId],
    );
  }, 240_000);

  afterAll(async () => {
    if (db) await db.end();
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    await admin.query(
      `DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`,
    );
    await admin.end();
  });

  it("cleans single and dual orphans, then downgrades and re-upgrades", async () => {
    await alembic("upgrade", "0091_import_staging_resolved_fks");
    const cleaned = await db.query(
      `SELECT row_index, resolved_recipient_id, resolved_bank_account_id
         FROM import_staging_rows
        ORDER BY row_index`,
    );
    expect(cleaned.rows).toEqual([
      {
        row_index: 0,
        resolved_recipient_id: null,
        resolved_bank_account_id: expect.any(Number),
      },
      {
        row_index: 1,
        resolved_recipient_id: expect.any(Number),
        resolved_bank_account_id: null,
      },
      {
        row_index: 2,
        resolved_recipient_id: null,
        resolved_bank_account_id: null,
      },
      {
        row_index: 3,
        resolved_recipient_id: expect.any(Number),
        resolved_bank_account_id: expect.any(Number),
      },
    ]);

    const validated = await db.query(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname = ANY($1)
        ORDER BY conname`,
      [FOREIGN_KEYS.map(([name]) => name)],
    );
    expect(validated.rows).toEqual(
      FOREIGN_KEYS.map(([conname]) => ({ conname, convalidated: true })).sort(
        (a, b) => a.conname.localeCompare(b.conname),
      ),
    );

    await alembic("downgrade", "0090_constraint_index_naming");
    const constraints = await db.query(
      `SELECT count(*)::int AS count
         FROM pg_constraint
        WHERE conname = ANY($1)`,
      [FOREIGN_KEYS.map(([name]) => name)],
    );
    const indexes = await db.query(
      `SELECT count(*)::int AS count
         FROM pg_indexes
        WHERE indexname = ANY($1)`,
      [FOREIGN_KEYS.map(([, column]) => `idx_import_staging_rows_${column}`)],
    );
    expect(constraints.rows).toEqual([{ count: 0 }]);
    expect(indexes.rows).toEqual([{ count: 0 }]);

    await alembic("upgrade", "0091_import_staging_resolved_fks");
    const restored = await db.query("SELECT version_num FROM alembic_version");
    expect(restored.rows).toEqual([
      { version_num: "0091_import_staging_resolved_fks" },
    ]);
  }, 240_000);
});
