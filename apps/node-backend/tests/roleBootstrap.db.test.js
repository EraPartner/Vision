/**
 * Real-Postgres tests for the runtime least-privilege role bootstrap
 * (src/database/roleBootstrap.js) — the mechanism that gives ALREADY-
 * INITIALISED databases the non-superuser app role which
 * docker/postgres-init/01-app-role.sh only creates on first volume init.
 *
 * This is a DB suite on purpose: the interesting behaviour is Postgres's —
 * role creation, grant application, default privileges for future tables,
 * and privilege-denied degradation — none of which a mock can observe.
 *
 * Topologies covered (mirroring the security-backlog decision table):
 *   - single-role setup (no migrations URL)          → no-op skip
 *   - existing install, superuser migration role      → role created + granted
 *   - re-run on the same database                     → idempotent 'exists'
 *   - app role pre-exists (externally managed)        → never altered
 *   - migration role without CREATEROLE               → graceful 'degraded'
 *   - unreachable/unauthenticated migration role      → 'unavailable', fast
 *
 * The suite creates throwaway roles (vb_rb_* prefix) and drops them — plus
 * everything they own or were granted — in afterAll, leaving the shared test
 * database exactly as found.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import {
  ensureAppRole,
  renderGrantStatements,
} from "../src/database/roleBootstrap.js";

const TEST_URL = process.env.TEST_DATABASE_URL;

/** Silent logger stub that records messages for assertions. */
function makeLog() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  return {
    lines,
    info: (msg) => lines.info.push(String(msg)),
    warn: (msg) => lines.warn.push(String(msg)),
    error: (msg) => lines.error.push(String(msg)),
    debug: (msg) => lines.debug.push(String(msg)),
  };
}

/** Build a connection URL for `user`/`password` on the test database. */
function urlFor(user, password) {
  const u = new URL(TEST_URL);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  return u.toString();
}

/** One-shot query as a given role; returns rows or throws. */
async function queryAs(user, password, sql) {
  const client = new pg.Client({
    connectionString: urlFor(user, password),
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const res = await client.query(sql);
    return res.rows;
  } finally {
    await client.end();
  }
}

const APP_ROLE = "vb_rb_app";
const APP_PASS = "s3cret-App'x"; // deliberately quote-hostile: exercises literal escaping
const PLAIN_MIG_ROLE = "vb_rb_plain_mig";
const PRE_ROLE = "vb_rb_preexisting";
const ALL_ROLES = [APP_ROLE, PLAIN_MIG_ROLE, PRE_ROLE];

describe.skipIf(!hasTestDatabase())("roleBootstrap (real Postgres)", () => {
  /** @type {import('pg').Pool} */
  let pool;
  // Whether the server actually verifies passwords. The with-test-db.sh /CI
  // container does (scram); a local scratch cluster may run `trust`, where a
  // wrong password still connects — password-rejection assertions self-skip
  // there (the role/grant behaviour under test is auth-mode independent).
  let authEnforced = false;

  async function dropTestRoles() {
    for (const role of ALL_ROLES) {
      const { rows } = await pool.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [role],
      );
      if (rows.length === 0) continue;
      // PostgreSQL 16+ gives a CREATEROLE creator ADMIN but not SET membership
      // in the new role. DROP OWNED requires SET permission, so grant that
      // narrow membership option before removing the throwaway role.
      await pool.query(`GRANT "${role}" TO CURRENT_USER WITH SET TRUE`);
      // DROP OWNED revokes privileges granted TO the role (incl. default-ACL
      // entries) and drops objects it owns — required before DROP ROLE.
      await pool.query(`DROP OWNED BY "${role}"`);
      await pool.query(`DROP ROLE "${role}"`);
    }
  }

  beforeAll(async () => {
    await acquireDbSuiteLock();
    pool = getTestPool();
    await dropTestRoles();
    const migUser = new URL(TEST_URL).username || "vision_test";
    authEnforced = await queryAs(
      decodeURIComponent(migUser),
      "definitely-wrong-password",
      "SELECT 1",
    )
      .then(() => false)
      .catch(() => true);
  }, 180_000);

  afterAll(async () => {
    if (pool) {
      await pool.query("DROP TABLE IF EXISTS vb_rb_future_table");
      await dropTestRoles();
    }
    await releaseDbSuiteLock();
    await closeTestPool();
  });

  it("renders the shared grant template with quoted identifiers and no leftover placeholders", () => {
    const stmts = renderGrantStatements({
      appRole: 'a"pp',
      ownerRole: "own",
      dbName: "db",
    });
    expect(stmts).toHaveLength(6);
    const joined = stmts.join(";\n");
    expect(joined).not.toContain(':"');
    expect(joined).toContain('"a""pp"');
    expect(joined).toContain('GRANT CONNECT ON DATABASE "db" TO "a""pp"');
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "own" IN SCHEMA public',
    );
  });

  it("skips in single-role setups without touching the database", async () => {
    const log = makeLog();
    const noMig = await ensureAppRole({
      databaseUrl: TEST_URL,
      migrationsUrl: undefined,
      log,
    });
    expect(noMig).toMatchObject({ status: "skipped", reason: "single-role" });

    const sameUrl = await ensureAppRole({
      databaseUrl: TEST_URL,
      migrationsUrl: TEST_URL,
      log,
    });
    expect(sameUrl).toMatchObject({ status: "skipped", reason: "single-role" });

    const sameRole = await ensureAppRole({
      databaseUrl: TEST_URL,
      migrationsUrl: urlFor("vision_test", "vision_test") + "?x=1",
      log,
    });
    expect(sameRole).toMatchObject({ status: "skipped", reason: "same-role" });
  });

  it("refuses to bootstrap across different databases", async () => {
    const log = makeLog();
    const other = new URL(TEST_URL);
    other.pathname = "/some_other_db";
    const res = await ensureAppRole({
      databaseUrl: urlFor(APP_ROLE, APP_PASS),
      migrationsUrl: other.toString(),
      log,
    });
    expect(res).toMatchObject({
      status: "degraded",
      reason: "database-mismatch",
    });
  });

  it("creates the app role with the full grant set on an already-initialised database", async () => {
    const log = makeLog();
    const res = await ensureAppRole({
      databaseUrl: urlFor(APP_ROLE, APP_PASS),
      migrationsUrl: TEST_URL,
      log,
    });
    expect(res).toMatchObject({ status: "created", grantFailures: 0 });

    // Role shape: LOGIN, and none of the dangerous attributes.
    const { rows } = await pool.query(
      "SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = $1",
      [APP_ROLE],
    );
    expect(rows[0]).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
    });

    // The role can log in with the (quote-hostile) password and use DML on a
    // real migrated table, including sequence access via the serial default.
    const inserted = await queryAs(
      APP_ROLE,
      APP_PASS,
      "INSERT INTO categories (general, detail) VALUES ('vb_rb', 'probe') RETURNING id, detail",
    );
    expect(inserted[0].detail).toBe("probe");
    const read = await queryAs(
      APP_ROLE,
      APP_PASS,
      "SELECT id FROM categories WHERE general = 'vb_rb'",
    );
    expect(read).toHaveLength(1);
    await queryAs(
      APP_ROLE,
      APP_PASS,
      "DELETE FROM categories WHERE general = 'vb_rb'",
    );
  }, 30_000);

  it("covers tables created later by the migration role (default privileges)", async () => {
    // Simulates Alembic creating a new table AFTER the bootstrap ran.
    await pool.query(
      "CREATE TABLE vb_rb_future_table (id serial PRIMARY KEY, v text)",
    );
    const rows = await queryAs(
      APP_ROLE,
      APP_PASS,
      "INSERT INTO vb_rb_future_table (v) VALUES ('later') RETURNING id, v",
    );
    expect(rows[0]).toMatchObject({ id: 1, v: "later" });
    await pool.query("DROP TABLE vb_rb_future_table");
  });

  it("is idempotent: a second run reports exists and changes nothing", async () => {
    const log = makeLog();
    const res = await ensureAppRole({
      databaseUrl: urlFor(APP_ROLE, APP_PASS),
      migrationsUrl: TEST_URL,
      log,
    });
    expect(res).toMatchObject({ status: "exists", grantFailures: 0 });
    // Original password still valid — nothing was re-created or altered.
    const rows = await queryAs(APP_ROLE, APP_PASS, "SELECT 1 AS ok");
    expect(rows[0].ok).toBe(1);
  }, 30_000);

  it("reapplies ordinary-table grants when the app role owns a materialized view", async () => {
    await queryAs(
      APP_ROLE,
      APP_PASS,
      "CREATE MATERIALIZED VIEW vb_rb_app_owned_mv AS SELECT 1 AS value",
    );
    try {
      const log = makeLog();
      const res = await ensureAppRole({
        databaseUrl: urlFor(APP_ROLE, APP_PASS),
        migrationsUrl: TEST_URL,
        log,
      });
      expect(res).toMatchObject({ status: "exists", grantFailures: 0 });
      const rows = await queryAs(
        APP_ROLE,
        APP_PASS,
        "SELECT id FROM accounts LIMIT 0",
      );
      expect(rows).toEqual([]);
      expect(log.lines.warn).toEqual([]);
    } finally {
      await queryAs(
        APP_ROLE,
        APP_PASS,
        "DROP MATERIALIZED VIEW vb_rb_app_owned_mv",
      );
    }
  }, 30_000);

  it("never alters a pre-existing role (no password reset)", async () => {
    await pool.query(
      `CREATE ROLE "${PRE_ROLE}" LOGIN PASSWORD 'original-pw' NOSUPERUSER`,
    );
    const log = makeLog();
    // URL claims a DIFFERENT password than the role actually has.
    const res = await ensureAppRole({
      databaseUrl: urlFor(PRE_ROLE, "not-the-real-password"),
      migrationsUrl: TEST_URL,
      log,
    });
    expect(res.status).toBe("exists");
    // The real password still works; the URL's wrong one does not (the latter
    // only observable when the server verifies passwords at all).
    const rows = await queryAs(PRE_ROLE, "original-pw", "SELECT 1 AS ok");
    expect(rows[0].ok).toBe(1);
    if (authEnforced) {
      await expect(
        queryAs(PRE_ROLE, "not-the-real-password", "SELECT 1"),
      ).rejects.toThrow();
    }
  }, 30_000);

  it("degrades gracefully when the migration role lacks CREATEROLE", async () => {
    await pool.query(
      `CREATE ROLE "${PLAIN_MIG_ROLE}" LOGIN PASSWORD 'plain-pw' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    const log = makeLog();
    const res = await ensureAppRole({
      databaseUrl: urlFor("vb_rb_never_created", "whatever"),
      migrationsUrl: urlFor(PLAIN_MIG_ROLE, "plain-pw"),
      log,
    });
    expect(res).toMatchObject({ status: "degraded", reason: "no-createrole" });
    expect(log.lines.warn.join("\n")).toContain("lacks CREATEROLE");
    const { rows } = await pool.query(
      "SELECT 1 FROM pg_roles WHERE rolname = 'vb_rb_never_created'",
    );
    expect(rows).toHaveLength(0);
  }, 30_000);

  it("reports unavailable fast on an authentication failure (no cold-start retry loop)", async (ctx) => {
    if (!authEnforced) return ctx.skip(); // trust-auth cluster: wrong passwords cannot fail
    const log = makeLog();
    const started = Date.now();
    const res = await ensureAppRole({
      databaseUrl: urlFor(APP_ROLE, APP_PASS),
      migrationsUrl: urlFor("vision_test", "wrong-password"),
      log,
    });
    expect(res).toMatchObject({ status: "unavailable" });
    // Auth errors must not burn the 40-attempt cold-start budget (~37s).
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(log.lines.warn.join("\n")).toContain(
      "cannot connect as the migration role",
    );
  }, 30_000);

  it("never throws, even on a totally unreachable server", async () => {
    const log = makeLog();
    const res = await ensureAppRole({
      databaseUrl: urlFor(APP_ROLE, APP_PASS),
      migrationsUrl: "postgresql://x:y@127.0.0.1:59999/vision_test",
      maxAttempts: 2,
      log,
    });
    expect(res).toMatchObject({ status: "unavailable" });
  }, 30_000);
});
