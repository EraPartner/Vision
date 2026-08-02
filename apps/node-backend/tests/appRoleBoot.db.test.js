/**
 * End-to-end boot of the REAL backend entrypoint in the two-role
 * (least-privilege) configuration, against a database that has only ever run
 * single-role — i.e. the exact upgrade every existing docker/desktop install
 * goes through.
 *
 * The unit-level guarantees live in appRoleBootstrap.db.test.js. What only a
 * real boot can prove:
 *   - main.js runs the bootstrap BEFORE the first pool query, so the runtime
 *     pool opens as `ftm_app_test` even though that role did not exist when
 *     the process started;
 *   - `alembic upgrade head` still runs — its `alembic_version` preflight
 *     (CREATE TABLE / ALTER COLUMN TYPE) is DDL the app role must never be
 *     asked to perform, and rethrows if it fails;
 *   - the post-listen warmup completes: CREATE MATERIALIZED VIEW, the unique
 *     indexes, and REFRESH MATERIALIZED VIEW all succeed under the app role
 *     (`warmup.materializedViews === 'ready'`, not 'failed');
 *   - a real read path answers with correct numbers.
 *
 * Throwaway database and a distinctly-named role; nothing here touches
 * TEST_DATABASE_URL's tables.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hasTestDatabase } from './setup/db.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAIN_JS = path.join(REPO_ROOT, 'apps/node-backend/src/main.js');
const DB_MIGRATE_JS = path.join(REPO_ROOT, 'apps/node-backend/scripts/db-migrate.js');

const APP_ROLE = 'ftm_app_boot_test';
const APP_PASSWORD = 'bootbootbootbootbootbootbootboot';
const MANAGED_VIEWS = ['mv_monthly_summary', 'mv_category_totals', 'mv_cashflow_daily'];

function scratchDbName() {
  const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://x/x').pathname.replace(/^\//, '');
  return `${base}_approleboot`;
}

function privilegedUrl() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://x/x');
  url.pathname = `/${scratchDbName()}`;
  return url.toString();
}

function appUrl() {
  const url = new URL(privilegedUrl());
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {net.AddressInfo} */ (srv.address());
  await new Promise((resolve) => srv.close(() => resolve(undefined)));
  return port;
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
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} budgetMs
 */
async function waitFor(fn, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe.skipIf(!hasTestDatabase())('backend boots two-role on a previously single-role database', () => {
  /** @type {pg.Client} */
  let admin;
  /** @type {pg.Pool} */
  let scratch;
  /** @type {import('node:child_process').ChildProcess|null} */
  let backend = null;
  let backendLog = '';
  /** @type {string} */
  let baseUrl;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    await admin.query(`CREATE DATABASE ${scratchDbName()}`);

    const cacheDir = mkdtempSync(path.join(tmpdir(), 'vision-approleboot-'));

    // Phase 1 — the install's history: single-role, migrated by the superuser.
    await runToCompletion(DB_MIGRATE_JS, {
      ...process.env,
      DATABASE_URL: privilegedUrl(),
      TEST_DATABASE_URL: privilegedUrl(),
      VISION_CACHE_DIR: cacheDir,
    });

    scratch = new pg.Pool({ connectionString: privilegedUrl(), max: 4 });
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
         FROM generate_series(1, 200) g`,
      [rec.id],
    );

    // Phase 2 — the upgrade: the app role does not exist yet, and DATABASE_URL
    // already points at it. Only the boot-time bootstrap can make this work.
    baseUrl = `http://127.0.0.1:${await freePort()}`;
    backend = spawn(process.execPath, [MAIN_JS], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // DATABASE_URL stays PRIVILEGED — that is the whole point of the
        // three-variable model: an older cached backend image reads only this
        // and boots unchanged.
        DATABASE_URL: privilegedUrl(),
        DATABASE_URL_APP: appUrl(),
        TEST_DATABASE_URL: privilegedUrl(),
        VISION_CACHE_DIR: mkdtempSync(path.join(tmpdir(), 'vision-approleboot-run-')),
        PORT: String(new URL(baseUrl).port),
        SERVER_HOST: '127.0.0.1',
        ADMIN_AUTH_TOKEN: 'app-role-boot-test-token',
      },
    });
    backend.stdout?.on('data', (c) => { backendLog += c; });
    backend.stderr?.on('data', (c) => { backendLog += c; });
  }, 300_000);

  afterAll(async () => {
    if (backend && !backend.killed) {
      backend.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 300));
    }
    await scratch?.end().catch(() => {});
    if (admin) {
      const cleaner = new pg.Client({ connectionString: privilegedUrl() });
      await cleaner.connect().catch(() => {});
      // Reassign first: the app role now OWNS the materialized views, and
      // DROP OWNED would take them with it (harmless here, but the database is
      // dropped next anyway).
      await cleaner.query(`DROP OWNED BY ${APP_ROLE}`).catch(() => {});
      await cleaner.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }, 60_000);

  it('creates the role at boot and comes up healthy', async () => {
    const healthy = await waitFor(
      () => fetch(`${baseUrl}/health`).then((r) => r.ok).catch(() => false),
      120_000,
    );
    expect(healthy, `backend never became healthy:\n${backendLog}`).toBe(true);

    const { rows } = await scratch.query(
      'SELECT rolsuper, rolcanlogin, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1',
      [APP_ROLE],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false });
  }, 180_000);

  it('runs the runtime pool as the app role, not the migration role', async () => {
    const ok = await waitFor(
      () => scratch.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND usename = $1`,
        [APP_ROLE],
      ).then((r) => r.rows[0].n > 0).catch(() => false),
      60_000,
    );
    expect(ok, `no backend session ran as ${APP_ROLE}:\n${backendLog}`).toBe(true);
  }, 90_000);

  it('completes the MV warmup under the app role (create + index + REFRESH)', async () => {
    const ready = await waitFor(
      () => fetch(`${baseUrl}/health/detailed`)
        .then((r) => r.json())
        .then((d) => d.warmup.materializedViews !== 'pending' && d)
        .catch(() => false),
      120_000,
    );
    expect(ready, `materializedViews never settled:\n${backendLog}`).toBeTruthy();
    // 'failed' here is exactly the regression this whole change risks: a
    // non-owner cannot REFRESH a materialized view.
    expect(/** @type {any} */ (ready).warmup.materializedViews).toBe('ready');

    const { rows: views } = await scratch.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'm' AND c.relname = ANY($1) ORDER BY 1`,
      [MANAGED_VIEWS],
    );
    expect(views.map((v) => v.relname)).toEqual([...MANAGED_VIEWS].sort());
    for (const view of views) expect(view.owner).toBe(APP_ROLE);
  }, 180_000);

  it('serves correct aggregations through the least-privilege pool', async () => {
    const res = await fetch(`${baseUrl}/api/aggregations/category-breakdown`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const food = body.data.data.categories.find((/** @type {any} */ c) => c.name === 'Food:Groceries');
    expect(Number(food.total)).toBe(-2000); // 200 rows × −10.00
    expect(Number(food.count)).toBe(200);
  }, 60_000);

  it('refuses a VACUUM the app role cannot actually perform, instead of reporting a false 200', async () => {
    // Postgres answers a non-owner VACUUM with a WARNING and SKIPS the table,
    // so the statement succeeds having done nothing. Before the catalog
    // pre-check in routes/admin.js this route returned
    // 200 {"ok":true,"vacuumed":"transactions"} while last_vacuum never moved.
    const before = await scratch.query(
      `SELECT last_vacuum FROM pg_stat_user_tables WHERE relname = 'transactions'`,
    );
    const res = await fetch(`${baseUrl}/api/admin/database/vacuum`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer app-role-boot-test-token',
        // Satisfy the CSRF guard the way a real same-origin browser request
        // does — an Origin header alone is checked against CORS_ORIGINS.
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ table: 'transactions' }),
    });

    const { rows: [{ v }] } = await scratch.query(`SELECT current_setting('server_version_num')::int AS v`);
    if (v < 170000) {
      // No MAINTAIN privilege on this server, and the app role does not own
      // `transactions` — the honest answer is 403, not a silent success.
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(403);
      // Pin the REASON, so a 403 from the CSRF guard or admin auth can never
      // masquerade as this assertion passing.
      expect(body.error.message).toMatch(/neither owns it nor holds MAINTAIN/);
      const after = await scratch.query(
        `SELECT last_vacuum FROM pg_stat_user_tables WHERE relname = 'transactions'`,
      );
      expect(after.rows[0].last_vacuum).toEqual(before.rows[0].last_vacuum);
    } else {
      // PostgreSQL 17+: the bootstrap granted MAINTAIN, so it really vacuums.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.skipped).toEqual([]);
    }
  }, 60_000);

  it('reports skipped relations rather than claiming a clean whole-database sweep', async () => {
    const res = await fetch(`${baseUrl}/api/admin/database/vacuum`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer app-role-boot-test-token',
        // Satisfy the CSRF guard the way a real same-origin browser request
        // does — an Origin header alone is checked against CORS_ORIGINS.
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.data.vacuumed).toBe('all');
    expect(Array.isArray(body.data.skipped)).toBe(true);

    const { rows: [{ v }] } = await scratch.query(`SELECT current_setting('server_version_num')::int AS v`);
    if (v < 170000) {
      // Migration-owned tables are skipped; the app-owned matviews are not.
      expect(body.data.skipped).toContain('transactions');
      expect(body.data.skipped).not.toContain('mv_monthly_summary');
    }
  }, 90_000);
});
