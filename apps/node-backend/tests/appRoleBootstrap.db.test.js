/**
 * Real-Postgres tests for the least-privilege role bootstrap
 * (src/database/appRoleBootstrap.js).
 *
 * What is being pinned:
 *   1. A database that has only ever run single-role is upgraded IN PLACE —
 *      the role is created, granted, and the materialized views it must
 *      REFRESH are handed over. This is the population `01-app-role.sh` can
 *      never reach (its data volume was initialised long ago; the packaged
 *      desktop compose does not even mount the init directory).
 *   2. FUTURE objects are covered. A migration that adds a table after the
 *      bootstrap ran must not 500 the app — ALTER DEFAULT PRIVILEGES, not a
 *      one-time GRANT sweep.
 *   3. Every privileged-ish thing the RUNTIME does still works as the app
 *      role: REFRESH MATERIALIZED VIEW (needs ownership!), CREATE
 *      MATERIALIZED VIEW + its unique index, the dbEditor catalog queries,
 *      to_regclass / pg_attribute probes, sequence resync via setval, and an
 *      ordinary insert/update/delete write path.
 *   4. Partial prior state is tolerated: role without grants, drifted
 *      password, a role that was left SUPERUSER, and a second identical run.
 *   5. FAIL OPEN. Every failure mode leaves the runtime pool on the
 *      privileged URL — the exact behaviour the install had before — instead
 *      of refusing to boot.
 *
 * Everything runs against a throwaway database of its own; nothing here
 * touches TEST_DATABASE_URL's tables. The one piece of shared cluster state is
 * the test role, named distinctly (`ftm_app_test`) and dropped in afterAll.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { canProvisionRolesAndDatabases } from './setup/db.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DB_MIGRATE_JS = path.join(REPO_ROOT, 'apps/node-backend/scripts/db-migrate.js');

const APP_ROLE = 'ftm_app_test';
const APP_PASSWORD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
const OTHER_PASSWORD = 'ffffffffffffffffffffffffffffffff';
const MANAGED_VIEWS = ['mv_monthly_summary', 'mv_category_totals', 'mv_cashflow_daily'];

/**
 * Quote a catalog-derived identifier for interpolation into test DDL.
 * @param {string} name
 * @returns {string}
 */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function scratchDbName() {
  const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://x/x').pathname.replace(/^\//, '');
  return `${base}_approle`;
}

/** Privileged (superuser) URL for the scratch database — plays DATABASE_URL_MIGRATIONS. */
function privilegedUrl() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://x/x');
  url.pathname = `/${scratchDbName()}`;
  return url.toString();
}

/** App-role URL for the scratch database — plays DATABASE_URL. */
function appUrl(password = APP_PASSWORD) {
  const url = new URL(privilegedUrl());
  url.username = APP_ROLE;
  url.password = password;
  return url.toString();
}

/** @param {string} file @param {NodeJS.ProcessEnv} env */
function runToCompletion(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env, cwd: REPO_ROOT });
    let output = '';
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${file} exited ${code}:\n${output}`)),
    );
  });
}

/**
 * Import a FRESH copy of the bootstrap + connection modules under the given
 * env and run ensureAppRole(). Both modules snapshot settings at import, so
 * every scenario needs its own module registry — this is also what proves the
 * decision is made before the pool exists.
 *
 * @param {{ databaseUrl: string, appDbUrl?: string|undefined, migrationsUrl?: string|undefined, disable?: boolean }} opts
 */
async function runBootstrap({ databaseUrl, appDbUrl, migrationsUrl, disable }) {
  vi.resetModules();
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_APP: process.env.DATABASE_URL_APP,
    DATABASE_URL_MIGRATIONS: process.env.DATABASE_URL_MIGRATIONS,
    VISION_DISABLE_APP_ROLE_BOOTSTRAP: process.env.VISION_DISABLE_APP_ROLE_BOOTSTRAP,
  };
  process.env.DATABASE_URL = databaseUrl;
  if (appDbUrl) process.env.DATABASE_URL_APP = appDbUrl;
  else delete process.env.DATABASE_URL_APP;
  if (migrationsUrl) process.env.DATABASE_URL_MIGRATIONS = migrationsUrl;
  else delete process.env.DATABASE_URL_MIGRATIONS;
  if (disable) process.env.VISION_DISABLE_APP_ROLE_BOOTSTRAP = 'true';
  else delete process.env.VISION_DISABLE_APP_ROLE_BOOTSTRAP;

  try {
    const bootstrap = await import('../src/database/appRoleBootstrap.js');
    const connection = await import('../src/database/connection.js');
    const result = await bootstrap.ensureAppRole();
    // The bootstrap never queries through the pool, so nothing to close here —
    // asserting on the connection string is what proves which role the pool
    // would open with.
    return { result, runtimeUrl: connection.getRuntimeConnectionString() };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// CI's database role owns the schema but is neither SUPERUSER nor CREATEROLE,
// so it cannot stand up this suite's throwaway role + scratch database. Probe
// rather than assume the local superuser: a failure to create the fixture role
// would otherwise read exactly like the bootstrap itself being broken. CI still
// covers the shipped single-role path (it never sets DATABASE_URL_APP).
const CAN_PROVISION = await canProvisionRolesAndDatabases();

describe.skipIf(!CAN_PROVISION)('least-privilege app-role bootstrap', () => {
  /** @type {pg.Client} */
  let admin;      // superuser on TEST_DATABASE_URL — creates/drops the scratch DB
  /** @type {pg.Pool} */
  let scratch;    // superuser on the scratch DB — plays the migration role

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${scratchDbName()}`);

    // Own alembic head-cache dir: the skip-at-head cache is keyed on revision +
    // versions/ fingerprint, so a throwaway database must not consult — or
    // overwrite — the developer's real entry.
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vision-approle-'));
    await runToCompletion(DB_MIGRATE_JS, {
      ...process.env,
      DATABASE_URL: privilegedUrl(),
      TEST_DATABASE_URL: privilegedUrl(),
      VISION_CACHE_DIR: cacheDir,
    });

    scratch = new pg.Pool({ connectionString: privilegedUrl(), max: 4 });

    // A corpus so the materialized views are non-trivial, then build them AS
    // THE SUPERUSER — this is precisely the state an install that has been
    // running single-role is in, and the state that breaks `REFRESH` the
    // moment the runtime pool drops to a non-owner role.
    const { rows: [cat] } = await scratch.query(
      `INSERT INTO categories (general, detail) VALUES ('Food', 'Groceries') RETURNING id`,
    );
    const { rows: [rec] } = await scratch.query(
      `INSERT INTO recipients (name, normalized_name, default_category_id)
       VALUES ('Aldi', 'aldi', $1) RETURNING id`,
      [cat.id],
    );
    await scratch.query(
      `INSERT INTO transactions (date, amount, currency, recipient_id, is_active, is_transfer)
       SELECT (date_trunc('month', CURRENT_DATE) + (g % 20) * interval '1 day')::date,
              -10.00, 'EUR', $1, true, false
         FROM generate_series(1, 50) g`,
      [rec.id],
    );

    vi.resetModules();
    process.env.DATABASE_URL = privilegedUrl();
    delete process.env.DATABASE_URL_MIGRATIONS;
    const mvService = await import('../src/services/materializedViewService.js');
    await mvService.createMaterializedViews();
    const connection = await import('../src/database/connection.js');
    await connection.closePool();
  }, 300_000);

  afterAll(async () => {
    if (scratch) await scratch.end().catch(() => {});
    if (admin) {
      // DROP OWNED also revokes every privilege granted TO the role and clears
      // the default-ACL rows naming it, which DROP ROLE would otherwise refuse.
      const cleaner = new pg.Client({ connectionString: privilegedUrl() });
      await cleaner.connect().catch(() => {});
      await cleaner.query(`DROP OWNED BY ${APP_ROLE}`).catch(() => {});
      await cleaner.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }, 60_000);

  /** Wipe every trace of the app role so each scenario starts from a known state. */
  async function dropAppRole() {
    // Ownership of the managed views goes back to the superuser FIRST: this
    // restores the "existing single-role install" starting condition, and
    // `DROP OWNED BY` would otherwise DROP the views the role now owns.
    for (const view of MANAGED_VIEWS) {
      await scratch.query(`ALTER MATERIALIZED VIEW ${view} OWNER TO CURRENT_USER`).catch(() => {});
    }
    await scratch.query(`DROP OWNED BY ${APP_ROLE}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {});
  }

  beforeEach(dropAppRole, 60_000);

  // ── 1. The upgrade path ────────────────────────────────────────────────────

  it('upgrades an already-initialised single-role database in place', async () => {
    const { result, runtimeUrl } = await runBootstrap({
      databaseUrl: privilegedUrl(),
      appDbUrl: appUrl(),
    });

    expect(result.mode).toBe('two-role');
    expect(runtimeUrl).toBe(appUrl());

    const { rows: [role] } = await scratch.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE],
    );
    expect(role).toMatchObject({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: true,
      rolreplication: false,
      rolbypassrls: false,
    });

    const { rows: [privs] } = await scratch.query(
      `SELECT
         has_database_privilege($1, current_database(), 'CONNECT') AS db_connect,
         has_schema_privilege($1, 'public', 'USAGE')  AS usage,
         has_schema_privilege($1, 'public', 'CREATE') AS create_,
         (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
             AND NOT (has_table_privilege($1, c.oid, 'SELECT') AND has_table_privilege($1, c.oid, 'INSERT')
                      AND has_table_privilege($1, c.oid, 'UPDATE') AND has_table_privilege($1, c.oid, 'DELETE'))
         ) AS tables_missing,
         (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'S'
             AND NOT (has_sequence_privilege($1, c.oid, 'USAGE') AND has_sequence_privilege($1, c.oid, 'SELECT')
                      AND has_sequence_privilege($1, c.oid, 'UPDATE'))
         ) AS sequences_missing`,
      [APP_ROLE],
    );
    expect(privs).toMatchObject({ db_connect: true, usage: true, create_: true, tables_missing: 0, sequences_missing: 0 });

    // The critical one: REFRESH MATERIALIZED VIEW requires ownership.
    const { rows: owners } = await scratch.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'm'`,
    );
    expect(owners.length).toBeGreaterThanOrEqual(MANAGED_VIEWS.length);
    for (const row of owners) expect(row.owner).toBe(APP_ROLE);
  }, 120_000);

  it('covers objects a FUTURE migration creates (ALTER DEFAULT PRIVILEGES, not a one-time sweep)', async () => {
    await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });

    // Stand in for "the next upgrade adds a table" — created by the migration
    // role AFTER the bootstrap already ran.
    await scratch.query('CREATE TABLE approle_future (id serial PRIMARY KEY, note text)');
    try {
      const { rows: [p] } = await scratch.query(
        `SELECT has_table_privilege($1, 'approle_future', 'SELECT')  AS s,
                has_table_privilege($1, 'approle_future', 'INSERT')  AS i,
                has_table_privilege($1, 'approle_future', 'UPDATE')  AS u,
                has_table_privilege($1, 'approle_future', 'DELETE')  AS d,
                has_sequence_privilege($1, 'approle_future_id_seq', 'USAGE')  AS sq_u,
                has_sequence_privilege($1, 'approle_future_id_seq', 'SELECT') AS sq_s,
                has_sequence_privilege($1, 'approle_future_id_seq', 'UPDATE') AS sq_up`,
        [APP_ROLE],
      );
      expect(p).toEqual({ s: true, i: true, u: true, d: true, sq_u: true, sq_s: true, sq_up: true });

      // A future VIEW too: `GRANT ... ON ALL TABLES` and the default
      // privileges both cover relkind 'v', and the runtime reads through views.
      await scratch.query('CREATE VIEW approle_future_v AS SELECT id, note FROM approle_future');

      // And the app role can really use them (serial default → nextval).
      const client = new pg.Client({ connectionString: appUrl() });
      await client.connect();
      try {
        await client.query(`INSERT INTO approle_future (note) VALUES ('x')`);
        const { rows } = await client.query('SELECT count(*)::int AS n FROM approle_future');
        expect(rows[0].n).toBe(1);
        const view = await client.query('SELECT count(*)::int AS n FROM approle_future_v');
        expect(view.rows[0].n).toBe(1);
      } finally {
        await client.end();
      }
    } finally {
      await scratch.query('DROP VIEW IF EXISTS approle_future_v');
      await scratch.query('DROP TABLE IF EXISTS approle_future');
    }
  }, 120_000);

  // ── 2. The runtime-privilege map, exercised as the app role ────────────────

  describe('runtime operations under the app role', () => {
    /** @type {pg.Client|undefined} */
    let asApp;

    beforeEach(async () => {
      await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });
      asApp = new pg.Client({ connectionString: appUrl() });
      await asApp.connect();
    }, 120_000);

    afterEach(async () => {
      await asApp?.end().catch(() => {});
      asApp = undefined;
    });

    it('can REFRESH the managed materialized views, concurrently and plainly', async () => {
      for (const view of MANAGED_VIEWS) {
        await expect(asApp.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`)).resolves.toBeTruthy();
        await expect(asApp.query(`REFRESH MATERIALIZED VIEW ${view}`)).resolves.toBeTruthy();
        // materializedViewService ANALYZEs the views after building them;
        // ANALYZE needs ownership (or MAINTAIN) too.
        await expect(asApp.query(`ANALYZE ${view}`)).resolves.toBeTruthy();
      }
    }, 120_000);

    it('can CREATE a materialized view and its unique index (warmup path on a fresh install)', async () => {
      await asApp.query(`CREATE MATERIALIZED VIEW IF NOT EXISTS mv_approle_probe AS
                         SELECT t.currency, sum(t.amount) AS net FROM transactions t GROUP BY t.currency`);
      await asApp.query('CREATE UNIQUE INDEX IF NOT EXISTS mv_approle_probe_idx ON mv_approle_probe (currency)');
      await asApp.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_approle_probe');
      await asApp.query('DROP MATERIALIZED VIEW mv_approle_probe');
    }, 120_000);

    it('can run the dbEditor catalog queries and pg_catalog probes', async () => {
      // dbEditor's table allowlist.
      const tables = await asApp.query(`SELECT relname FROM pg_stat_user_tables WHERE schemaname = 'public'`);
      expect(tables.rows.length).toBeGreaterThan(10);

      // information_schema is privilege-FILTERED — a role without grants sees
      // no columns at all, which would silently empty the editor.
      const cols = await asApp.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'transactions'`,
      );
      expect(cols.rows.length).toBeGreaterThan(3);

      // dbEditor's primary-key introspection (pg_index + pg_attribute).
      const pk = await asApp.query(
        `SELECT a.attname FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'transactions'::regclass AND i.indisprimary`,
      );
      expect(pk.rows.map((r) => r.attname)).toContain('id');

      // xmin optimistic-concurrency token.
      const xmin = await asApp.query('SELECT xmin FROM transactions LIMIT 1');
      expect(xmin.rows[0].xmin).toBeDefined();

      // to_regclass / pg_attribute existence probes used across the repositories.
      const probe = await asApp.query(`SELECT to_regclass('public.transactions') AS t`);
      expect(probe.rows[0].t).toBe('transactions');

      // Admin DB-stats route.
      const stats = await asApp.query(
        `SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`,
      );
      expect(stats.rows[0].db_size).toBeTruthy();
    }, 120_000);

    it('can run a representative write path incl. sequence resync', async () => {
      const { rows: [cat] } = await asApp.query(
        `INSERT INTO categories (general, detail) VALUES ('Probe', 'Write') RETURNING id`,
      );
      await asApp.query('UPDATE categories SET detail = $1 WHERE id = $2', ['Write2', cat.id]);
      // setval via pg_get_serial_sequence — the repositories' collision-recovery path.
      await asApp.query(
        `SELECT setval(pg_get_serial_sequence('categories', 'id'),
                       COALESCE((SELECT MAX(id) FROM categories), 0) + 1, false)`,
      );
      await asApp.query('DELETE FROM categories WHERE id = $1', [cat.id]);
    }, 120_000);

    it('is NOT a superuser and cannot reach outside its database', async () => {
      const { rows } = await asApp.query('SELECT current_setting($1, true) AS v', ['is_superuser']);
      expect(rows[0].v).toBe('off');
      await expect(asApp.query('CREATE ROLE approle_escalation LOGIN')).rejects.toThrow();
      await expect(asApp.query(`CREATE DATABASE approle_escalation`)).rejects.toThrow();
    }, 120_000);
  });

  // ── 3. Partial prior state ─────────────────────────────────────────────────

  it('repairs a role that exists with no grants at all', async () => {
    await scratch.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`);
    const { result } = await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });
    expect(result.mode).toBe('two-role');

    const client = new pg.Client({ connectionString: appUrl() });
    await client.connect();
    try {
      await expect(client.query('SELECT count(*) FROM transactions')).resolves.toBeTruthy();
    } finally {
      await client.end();
    }
  }, 120_000);

  it('resyncs a drifted password to the one in DATABASE_URL', async () => {
    await scratch.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${OTHER_PASSWORD}'`);
    const { result } = await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });
    expect(result.mode).toBe('two-role');

    const client = new pg.Client({ connectionString: appUrl() });
    try {
      // Logging in at all is the assertion: the role was created with
      // OTHER_PASSWORD, so this only succeeds if the bootstrap re-synced it.
      await client.connect();
      const { rows } = await client.query('SELECT current_user AS u');
      expect(rows[0].u).toBe(APP_ROLE);
    } finally {
      await client.end().catch(() => {});
    }
  }, 120_000);

  it('strips SUPERUSER from a role that was left privileged', async () => {
    await scratch.query(`CREATE ROLE ${APP_ROLE} LOGIN SUPERUSER PASSWORD '${APP_PASSWORD}'`);
    const { result } = await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });
    expect(result.mode).toBe('two-role');
    const { rows } = await scratch.query('SELECT rolsuper FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    expect(rows[0].rolsuper).toBe(false);
  }, 120_000);

  it('is idempotent across repeated boots', async () => {
    const first = await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });
    const second = await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });
    expect(first.result.mode).toBe('two-role');
    expect(second.result.mode).toBe('two-role');
    expect(second.runtimeUrl).toBe(appUrl());

    // No duplicated default-ACL rows, no drift in the grant set.
    const { rows } = await scratch.query(
      `SELECT count(*)::int AS n FROM pg_default_acl d
         JOIN pg_namespace n ON n.oid = d.defaclnamespace
        WHERE n.nspname = 'public'`,
    );
    expect(rows[0].n).toBeLessThanOrEqual(4); // one row per (owner, object type)
  }, 180_000);

  // ── D1: no version-skew brick ──────────────────────────────────────────────

  it('leaves DATABASE_URL on the privileged role, so an OLD backend image still works', async () => {
    // The regression this guards: an app image predating the bootstrap reads
    // ONLY DATABASE_URL. If two-role configuration repointed it at the app
    // role, that image would connect as a role which does not exist yet and
    // die in its readiness loop — with the UI, and the in-app image-update
    // button, never reachable.
    const { result, runtimeUrl } = await runBootstrap({
      databaseUrl: privilegedUrl(),
      appDbUrl: appUrl(),
    });
    expect(result.mode).toBe('two-role');
    expect(runtimeUrl).toBe(appUrl());

    // Now behave like the old image: read DATABASE_URL, connect, do DDL.
    const oldImage = new pg.Client({ connectionString: privilegedUrl() });
    await oldImage.connect();
    try {
      // The exact statement kind stampBaselineIfLegacy() runs before alembic.
      await oldImage.query('CREATE TABLE approle_oldimage (version_num VARCHAR(64) NOT NULL)');
      await oldImage.query('ALTER TABLE approle_oldimage ALTER COLUMN version_num TYPE VARCHAR(128)');
      const { rows } = await oldImage.query('SELECT current_user AS u');
      expect(rows[0].u).not.toBe(APP_ROLE);
    } finally {
      await oldImage.query('DROP TABLE IF EXISTS approle_oldimage').catch(() => {});
      await oldImage.end();
    }
  }, 120_000);

  // ── D2: escalation by role MEMBERSHIP ──────────────────────────────────────

  it('revokes superuser membership granted to the app role (rolsuper stays false)', async () => {
    await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });

    // The superuser to grant is resolved from the catalog, not hardcoded: the
    // bootstrap superuser is `postgres` on a stock local install but takes the
    // POSTGRES_USER name in CI's image, and a missing role would fail this test
    // with 42704 rather than exercising the escalation it is about.
    const { rows: supers } = await scratch.query(
      `SELECT rolname FROM pg_roles WHERE rolsuper AND rolcanlogin ORDER BY rolname LIMIT 1`,
    );
    const superRole = supers[0]?.rolname;
    expect(superRole, 'no superuser role to grant — cannot exercise the escalation').toBeTruthy();

    // `GRANT <superuser> TO ftm_app` leaves rolsuper = false, so a naive check
    // passes while the pool is one SET ROLE from superuser — and with the
    // default INHERIT, not even that.
    await scratch.query(`GRANT ${quoteIdent(superRole)} TO ${APP_ROLE}`);
    const before = await scratch.query(
      `SELECT rolsuper, pg_has_role($1, $2, 'MEMBER') AS member FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE, superRole],
    );
    expect(before.rows[0]).toMatchObject({ rolsuper: false, member: true });

    const { result, runtimeUrl } = await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });
    expect(result.mode).toBe('two-role');
    expect(runtimeUrl).toBe(appUrl());

    const after = await scratch.query(
      `SELECT pg_has_role($1, $2, 'MEMBER') AS member FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE, superRole],
    );
    expect(after.rows[0].member).toBe(false);

    // And the escalation is really gone at the wire level.
    const asApp = new pg.Client({ connectionString: appUrl() });
    await asApp.connect();
    try {
      await expect(asApp.query(`SET ROLE ${quoteIdent(superRole)}`)).rejects.toThrow();
    } finally {
      await asApp.end();
    }
  }, 180_000);

  // ── D4: CONNECTION LIMIT ───────────────────────────────────────────────────

  it('resets a CONNECTION LIMIT that would starve the pool', async () => {
    await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });
    // A limit of 1 lets every single-connection check here pass while the
    // pool (max 10) 53300s under real concurrency.
    await scratch.query(`ALTER ROLE ${APP_ROLE} CONNECTION LIMIT 1`);

    const { result } = await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });
    expect(result.mode).toBe('two-role');
    const { rows } = await scratch.query('SELECT rolconnlimit FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    expect(rows[0].rolconnlimit).toBe(-1);

    // Prove concurrency actually works.
    const clients = [0, 1, 2, 3].map(() => new pg.Client({ connectionString: appUrl() }));
    try {
      await Promise.all(clients.map((c) => c.connect()));
      const results = await Promise.all(clients.map((c) => c.query('SELECT 1 AS ok')));
      expect(results.every((r) => r.rows[0].ok === 1)).toBe(true);
    } finally {
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
    }
  }, 180_000);

  // ── D3: VACUUM/ANALYZE do not error for a non-owner — they SKIP ────────────

  it('documents that a non-owner VACUUM silently skips instead of failing', async () => {
    await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });

    const asApp = new pg.Client({ connectionString: appUrl() });
    /** @type {{ severity: string, code: string, message: string }[]} */
    const notices = [];
    asApp.on('notice', (n) => notices.push(n));
    await asApp.connect();
    try {
      const before = await scratch.query(
        `SELECT last_vacuum FROM pg_stat_user_tables WHERE relname = 'transactions'`,
      );
      // No throw — this is the whole point. On PostgreSQL < 17 the app role
      // neither owns `transactions` nor can hold MAINTAIN.
      await expect(asApp.query('VACUUM ANALYZE "transactions"')).resolves.toBeTruthy();

      const { rows: [{ v }] } = await scratch.query(`SELECT current_setting('server_version_num')::int AS v`);
      if (v < 170000) {
        // A WARNING (SQLSTATE 01000), not an error — which is exactly why
        // routes/admin.js pre-checks the catalog rather than catching 42501.
        expect(notices.some((n) => n.severity === 'WARNING')).toBe(true);
        const after = await scratch.query(
          `SELECT last_vacuum FROM pg_stat_user_tables WHERE relname = 'transactions'`,
        );
        expect(after.rows[0].last_vacuum).toEqual(before.rows[0].last_vacuum);
      }
    } finally {
      await asApp.end();
    }
  }, 180_000);

  // ── 4. Fail-open ───────────────────────────────────────────────────────────

  it('does nothing at all when DATABASE_URL_APP is unset (CI / single-role default)', async () => {
    const { result, runtimeUrl } = await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: undefined });
    expect(result.mode).toBe('single-role');
    expect(runtimeUrl).toBe(privilegedUrl());
    const { rows } = await scratch.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    expect(rows).toHaveLength(0);
  }, 60_000);

  it('treats an identical app URL as single-role', async () => {
    const { result, runtimeUrl } = await runBootstrap({
      databaseUrl: privilegedUrl(),
      appDbUrl: privilegedUrl(),
    });
    expect(result.mode).toBe('single-role');
    expect(runtimeUrl).toBe(privilegedUrl());
  }, 60_000);

  it('fails open to the privileged role when the escape hatch is set', async () => {
    const { result, runtimeUrl } = await runBootstrap({
      databaseUrl: privilegedUrl(),
      appDbUrl: appUrl(),
      disable: true,
    });
    expect(result.mode).toBe('fail-open');
    expect(runtimeUrl).toBe(privilegedUrl());
    const { rows } = await scratch.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    expect(rows).toHaveLength(0);
  }, 60_000);

  it('fails open when the privileged URL cannot authenticate and the app role does not exist', async () => {
    const bad = new URL(privilegedUrl());
    bad.password = 'definitely-not-the-password';
    const { result, runtimeUrl } = await runBootstrap({
      databaseUrl: bad.toString(),
      appDbUrl: appUrl(),
    });
    expect(result.mode).toBe('fail-open');
    expect(runtimeUrl).toBe(bad.toString());
  }, 120_000);

  it('fails open when the privileged role lacks the rights to create the app role', async () => {
    // A "migration role" that is not actually privileged: CREATE ROLE fails,
    // the bootstrap must not turn that into a boot failure.
    await scratch.query(`DROP ROLE IF EXISTS ftm_weak_test`);
    await scratch.query(`CREATE ROLE ftm_weak_test LOGIN PASSWORD '${OTHER_PASSWORD}' NOSUPERUSER NOCREATEROLE`);
    await scratch.query(`GRANT CONNECT ON DATABASE ${scratchDbName()} TO ftm_weak_test`);
    const weak = new URL(privilegedUrl());
    weak.username = 'ftm_weak_test';
    weak.password = OTHER_PASSWORD;
    try {
      const { result, runtimeUrl } = await runBootstrap({
        databaseUrl: weak.toString(),
        appDbUrl: appUrl(),
      });
      expect(result.mode).toBe('fail-open');
      expect(runtimeUrl).toBe(weak.toString());
    } finally {
      await scratch.query(`DROP OWNED BY ftm_weak_test`).catch(() => {});
      await scratch.query(`DROP ROLE IF EXISTS ftm_weak_test`).catch(() => {});
    }
  }, 120_000);

  it('keeps least privilege when the privileged URL is down but the app role already works', async () => {
    await runBootstrap({ databaseUrl: privilegedUrl(), appDbUrl: appUrl() });

    const unreachable = new URL(privilegedUrl());
    unreachable.password = 'definitely-not-the-password';
    const { result, runtimeUrl } = await runBootstrap({
      databaseUrl: unreachable.toString(),
      appDbUrl: appUrl(),
    });
    expect(result.mode).toBe('two-role');
    expect(runtimeUrl).toBe(appUrl());
  }, 120_000);
});
