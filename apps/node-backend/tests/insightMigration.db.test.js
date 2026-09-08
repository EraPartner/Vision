import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hasTestDatabase } from "./setup/db.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const ALEMBIC_BIN = process.env.ALEMBIC_BIN || "alembic";
const ALEMBIC_CONFIG = path.join(REPO_ROOT, "config/alembic.ini");
const BEFORE = "0100_portfolio_retag_audit";
const TARGET = "0101_insight_dismissals_and_count";

function scratchDbName() {
  const base = new URL(
    process.env.TEST_DATABASE_URL ?? "postgres://x/x",
  ).pathname.replace(/^\//, "");
  return `${base}_insights_0101`;
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
    timeout: 120_000,
  });
}

/** @type {pg.Client|null} */
let db = null;

async function tableExists(name) {
  const result = await db.query("SELECT to_regclass($1) AS name", [name]);
  return result.rows[0].name !== null;
}

describe.skipIf(!hasTestDatabase())("migration 0101 insight state", () => {
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
    await alembic("upgrade", BEFORE);
  }, 180_000);

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

  it("upgrades, downgrades, and re-upgrades all insight persistence", async () => {
    await alembic("upgrade", TARGET);
    await expect(tableExists("insight_dismissals")).resolves.toBe(true);
    await expect(tableExists("insight_digest_state")).resolves.toBe(true);
    await expect(tableExists("insight_cash_projections")).resolves.toBe(true);

    const constraints = await db.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'insight_dismissals'::regclass
        ORDER BY conname`,
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        "fk_insight_dismissals_category_id",
        "fk_insight_dismissals_recipient_id",
      ]),
    );

    await alembic("downgrade", BEFORE);
    await expect(tableExists("insight_dismissals")).resolves.toBe(false);
    await expect(tableExists("insight_digest_state")).resolves.toBe(false);
    await expect(tableExists("insight_cash_projections")).resolves.toBe(false);

    await alembic("upgrade", TARGET);
    await expect(tableExists("insight_dismissals")).resolves.toBe(true);
    await expect(tableExists("insight_digest_state")).resolves.toBe(true);
    await expect(tableExists("insight_cash_projections")).resolves.toBe(true);
  }, 180_000);
});
