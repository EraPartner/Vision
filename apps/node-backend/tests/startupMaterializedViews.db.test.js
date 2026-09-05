/**
 * Boot-ordering test for the deferred materialized-view lifecycle.
 *
 * `main.js` used to `await createMaterializedViews()` + `ensureMaterializedViewIndexes()`
 * between alembic and `app.listen()`. `CREATE MATERIALIZED VIEW IF NOT EXISTS` is a
 * metadata no-op once the views exist, but a fresh install has none of them (0045
 * dropped all three and 0084/0085 drop two more to redefine them, and nothing in the
 * chain recreates them) — so on a first boot, and on any upgrade past one of those
 * migrations, full aggregation scans of `transactions` sat inside the pre-`/health`
 * window the Electron 60s poll budget is racing. They now run in the post-listen warmup.
 *
 * Booting `main.js` in-process is not possible (it calls `start()` at import and installs
 * `process.exit` handlers — it is excluded from coverage for the same reason), so this
 * spawns the real entrypoint as a child process against a throwaway database of its own.
 * Nothing here touches TEST_DATABASE_URL's tables.
 *
 * The ordering is pinned deterministically rather than by racing a stopwatch: an
 * ACCESS EXCLUSIVE lock is held on `transactions` across the boot, which blocks
 * `CREATE MATERIALIZED VIEW` (it needs ACCESS SHARE to read the table) and nothing on
 * the pre-listen path. With the old ordering `/health` never answers while that lock is
 * held; with the deferred ordering it answers immediately and MV creation completes once
 * the lock is released.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hasTestDatabase } from "./setup/db.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const MAIN_JS = path.join(REPO_ROOT, "apps/node-backend/src/main.js");
const DB_MIGRATE_JS = path.join(
  REPO_ROOT,
  "apps/node-backend/scripts/db-migrate.js",
);

const MANAGED_VIEWS = ["mv_monthly_summary", "mv_category_totals"];
const MANAGED_VIEW_INDEXES = [
  "idx_mv_monthly_summary",
  "idx_mv_category_totals",
];

/** Throwaway database, derived from TEST_DATABASE_URL so host/credentials match. */
function scratchDbName() {
  const base = new URL(
    process.env.TEST_DATABASE_URL ?? "postgres://x/x",
  ).pathname.replace(/^\//, "");
  return `${base}_bootorder`;
}

function scratchUrl() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "postgres://x/x");
  url.pathname = `/${scratchDbName()}`;
  return url.toString();
}

/** An unused TCP port, so a developer's own backend on 3002 is never disturbed. */
async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve(undefined)),
  );
  const { port } = /** @type {net.AddressInfo} */ (srv.address());
  await new Promise((resolve) => srv.close(() => resolve(undefined)));
  return port;
}

/** @param {string} file @param {NodeJS.ProcessEnv} env */
function runToCompletion(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env, cwd: REPO_ROOT });
    let output = "";
    child.stdout.on("data", (c) => {
      output += c;
    });
    child.stderr.on("data", (c) => {
      output += c;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${file} exited ${code}:\n${output}`)),
    );
  });
}

/**
 * Poll `fn` until it resolves truthy or the budget runs out.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} budgetMs
 * @returns {Promise<T|undefined>}
 */
async function waitFor(fn, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!hasTestDatabase())(
  "startup: materialized views are built after listen",
  () => {
    /** @type {pg.Client} */
    let admin;
    /** @type {pg.Pool} */
    let scratch;
    /** @type {pg.Client|null} */
    let locker = null;
    /** @type {import('node:child_process').ChildProcess|null} */
    let backend = null;
    let backendLog = "";
    /** @type {string} */
    let baseUrl;

    beforeAll(async () => {
      admin = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      await admin.connect();
      // FORCE: a previous aborted run may have left the locker session connected.
      await admin.query(
        `DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`,
      );
      await admin.query(
        `CREATE DATABASE ${scratchDbName()} WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'`,
      );

      // Own cache dir: the alembic skip-at-head cache is keyed on revision +
      // versions/ fingerprint, so a throwaway database's entry must never be
      // consulted for — or overwrite — the developer's real one.
      const cacheDir = mkdtempSync(path.join(tmpdir(), "vision-bootorder-"));
      const childEnv = {
        ...process.env,
        DATABASE_URL: scratchUrl(),
        TEST_DATABASE_URL: scratchUrl(),
        VISION_CACHE_DIR: cacheDir,
      };
      await runToCompletion(DB_MIGRATE_JS, childEnv);

      scratch = new pg.Pool({ connectionString: scratchUrl(), max: 4 });
      // afterAll's `DROP DATABASE ... WITH (FORCE)` deliberately terminates whatever
      // is still attached, so a 57P01 ("terminating connection due to administrator
      // command") on these connections is expected teardown noise, not a result. It
      // still has to be *listened* for: pg re-emits an idle client's error on the
      // Pool, and an EventEmitter 'error' with no listener throws — which vitest
      // reports as an uncaught exception and exits non-zero even when every test
      // passed. Observed on CI 2026-08-04: 222 files / 3593 tests green, run failed.
      // A connection error that matters still fails the run through the assertions
      // that depend on it, so swallowing the event here hides nothing.
      scratch.on("error", () => {});
      // A corpus the views actually aggregate — an empty MV would prove nothing
      // about the scan that made this finding.
      const {
        rows: [cat],
      } = await scratch.query(
        `INSERT INTO categories (general, detail) VALUES ('Food', 'Groceries') RETURNING id`,
      );
      const {
        rows: [rec],
      } = await scratch.query(
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

      baseUrl = `http://127.0.0.1:${await freePort()}`;
      // Held across the boot: blocks CREATE MATERIALIZED VIEW, nothing pre-listen.
      locker = new pg.Client({ connectionString: scratchUrl() });
      locker.on("error", () => {}); // same FORCE-drop termination, same reason
      await locker.connect();
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE transactions IN ACCESS EXCLUSIVE MODE");

      backend = spawn(process.execPath, [MAIN_JS], {
        cwd: REPO_ROOT,
        env: {
          ...childEnv,
          PORT: String(new URL(baseUrl).port),
          SERVER_HOST: "127.0.0.1",
          ADMIN_AUTH_TOKEN: "boot-order-test-token",
        },
      });
      backend.stdout?.on("data", (c) => {
        backendLog += c;
      });
      backend.stderr?.on("data", (c) => {
        backendLog += c;
      });
    }, 180_000);

    afterAll(async () => {
      if (backend && !backend.killed) {
        backend.kill("SIGKILL");
        await new Promise((r) => setTimeout(r, 200));
      }
      try {
        await locker?.query("ROLLBACK");
      } catch {
        /* already gone */
      }
      await locker?.end().catch(() => {});
      await scratch?.end().catch(() => {});
      await admin.query(
        `DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`,
      );
      await admin.end();
    }, 60_000);

    it("listens (and answers /health) while MV creation is still blocked", async () => {
      const healthy = await waitFor(
        () =>
          fetch(`${baseUrl}/health`)
            .then((r) => r.ok)
            .catch(() => false),
        60_000,
      );
      expect(healthy, `backend never became healthy:\n${backendLog}`).toBe(
        true,
      );

      // The discriminator. Under the old pre-listen ordering the process is still
      // inside createMaterializedViews() here and /health has not been served yet.
      const { rows } = await scratch.query(
        `SELECT matviewname FROM pg_matviews WHERE matviewname = ANY($1)`,
        [MANAGED_VIEWS],
      );
      expect(rows).toHaveLength(0);

      const detailed = await fetch(`${baseUrl}/health/detailed`).then((r) =>
        r.json(),
      );
      expect(detailed.status).toBe("warming");
      expect(detailed.caches.materializedViews).toBe(false);
      expect(detailed.warmup.materializedViews).toBe("pending");

      // Release immediately: warmup deliberately lifts statement_timeout for
      // full MV builds, so this test owns the bounded release point.
      await locker?.query("ROLLBACK");
    }, 90_000);

    it("serves correct aggregations while the views are still being built", async () => {
      // Creation is in flight (and for the next 60s `mvAvailable`'s negative cache
      // keeps this on the base-table path regardless), so this is the window a
      // request lands in post-listen: mvAvailable() sees no relation, the repository
      // falls back to the live query, and the numbers are already right — the MV is
      // a speed artifact, never a source of truth.
      const res = await fetch(`${baseUrl}/api/aggregations/category-breakdown`);
      expect(res.status).toBe(200);
      // { ok, data: { data: { categories }, meta } } — the response envelope
      // (ADR-026) wrapping the aggregation envelope.
      const body = await res.json();
      const food = body.data.data.categories.find(
        (/** @type {any} */ c) => c.name === "Food:Groceries",
      );
      expect(Number(food.total)).toBe(-2000); // 200 rows × −10.00
      expect(Number(food.count)).toBe(200);
    }, 60_000);

    it("completes creation, indexing and refresh post-listen, then flips the health flag", async () => {
      const ready = await waitFor(
        () =>
          fetch(`${baseUrl}/health/detailed`)
            .then((r) => r.json())
            .then((d) => d.caches.materializedViews === true)
            .catch(() => false),
        60_000,
      );
      expect(ready, `materializedViews never settled:\n${backendLog}`).toBe(
        true,
      );

      const { rows: views } = await scratch.query(
        `SELECT matviewname, ispopulated FROM pg_matviews WHERE matviewname = ANY($1) ORDER BY 1`,
        [MANAGED_VIEWS],
      );
      expect(views.map((v) => v.matviewname)).toEqual(
        [...MANAGED_VIEWS].sort(),
      );
      expect(views.every((v) => v.ispopulated)).toBe(true);

      // The unique indexes REFRESH ... CONCURRENTLY depends on.
      const { rows: idx } = await scratch.query(
        `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1) ORDER BY 1`,
        [MANAGED_VIEW_INDEXES],
      );
      expect(idx).toHaveLength(MANAGED_VIEWS.length);

      // And the aggregation the MV now serves agrees with the live answer above.
      const { rows: totals } = await scratch.query(
        `SELECT name, count, total FROM mv_category_totals WHERE name = 'Food:Groceries'`,
      );
      expect(Number(totals[0].total)).toBe(-2000);
      expect(Number(totals[0].count)).toBe(200);
    }, 90_000);
  },
);
