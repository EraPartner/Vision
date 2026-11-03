/**
 * Boot-ordering test for the deferred materialized-view lifecycle.
 *
 * `main.ts` used to `await createMaterializedViews()` + `ensureMaterializedViewIndexes()`
 * between migrations and `app.listen()`. On a fresh install the view tables are empty,
 * so on a first boot, and on any upgrade that empties one, full aggregation scans of
 * `transactions` sat inside the pre-`/health` window the Electron 60s poll budget is
 * racing. They now run in the post-listen warmup.
 *
 * Booting `main.ts` in-process is not possible (it calls `start()` at import and installs
 * `process.exit` handlers — it is excluded from coverage for the same reason), so this
 * spawns the real entrypoint as a child process against this test file's own database
 * copy (VISION_DATABASE_PATH, set by tests/setup/sqliteDatabase.ts).
 *
 * The ordering is pinned deterministically rather than by racing a stopwatch. The
 * PostgreSQL version held an ACCESS EXCLUSIVE lock on `transactions` across the boot,
 * which blocked CREATE MATERIALIZED VIEW and nothing pre-listen, and checked that
 * `/health` answered while the views were still missing. That mechanism has no SQLite
 * equivalent (ADR-263): the driver is synchronous, so a backend waiting for a write lock
 * another process holds is frozen as a whole — `/health` included — for up to the 10 s
 * busy timeout, and the fill itself also runs on the event loop. The discriminator is
 * therefore the backend's own log, written in order to one stream: with the deferred
 * ordering the listen line comes before the fill starts; with the old pre-listen
 * ordering the fill would be logged first. The boot summary printed at listen lists the
 * pre-listen phases, and none of them may be a view phase.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeTestPool, getTestPool } from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { refreshMaterializedViews } from "../src/services/materializedViewService.ts";
import { firstRow, must } from "./helpers/must.ts";

/** A row from an ad-hoc SQL read: column values are narrowed where used. */
type DbRow = Record<string, unknown>;
interface IdRow {
  id: number;
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const MAIN_JS = path.join(REPO_ROOT, "apps/node-backend/src/main.ts");

const MANAGED_VIEWS = ["mv_monthly_summary", "mv_category_totals"];
const MANAGED_VIEW_INDEXES = [
  "idx_mv_monthly_summary",
  "idx_mv_category_totals",
];

/** The `/health/detailed` fields these tests read. */
interface HealthDetailed {
  status: string;
  caches: { materializedViews: unknown };
  warmup: { materializedViews: string };
}

/** `/api/aggregations/category-breakdown` as far as these tests read it. */
interface CategoryBreakdownBody {
  data: {
    data: {
      categories: {
        name: string;
        total: number | string;
        count: number | string;
      }[];
    };
  };
}

/** An unused TCP port, so a developer's own backend on 3002 is never disturbed. */
async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve(undefined)),
  );
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((resolve) => srv.close(() => resolve(undefined)));
  return port;
}

/** Poll `fn` until it resolves truthy or the budget runs out. */
async function waitFor(
  fn: () => Promise<boolean>,
  budgetMs: number,
): Promise<true | undefined> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Row counts of the view tables, read from the last committed state. */
async function viewRowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const view of MANAGED_VIEWS) {
    const row = firstRow(
      await getTestPool().query<{ n: number }>(
        `SELECT count(*) AS n FROM ${view}`,
      ),
    );
    counts[view] = row.n;
  }
  return counts;
}

/** The backend's log lines that pin the boot order (logger INFO → stdout). */
const LISTEN_LINE = "Financial Transaction Manager API (Node.js) started";
const DB_OPEN_LINE = "Database opened";
const FILL_START_LINE = "Filling empty materialized-view tables";
const FILL_DONE_LINE = "Materialized views ready in";

describe("startup: materialized views are built after listen", () => {
  let backend: ChildProcess | null = null;
  let backendLog = "";
  /** stdout alone: one stream, so its lines are in the order they were written. */
  let backendStdout = "";
  let baseUrl: string;

  beforeAll(async () => {
    const pool = getTestPool();
    // A corpus the views actually aggregate — an empty table would prove nothing
    // about the scan that made this finding.
    const cat = firstRow(
      await pool.query<IdRow>(
        `INSERT INTO categories (general, detail) VALUES ('Food', 'Groceries') RETURNING id`,
      ),
    );
    const rec = firstRow(
      await pool.query<IdRow>(
        `INSERT INTO recipients (name, normalized_name, default_category_id)
         VALUES ('Aldi', 'aldi', $1) RETURNING id`,
        [cat.id],
      ),
    );
    await pool.query(
      `WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 200)
       INSERT INTO transactions (date, amount, currency, recipient_id, is_active, is_transfer)
       SELECT add_days(date_trunc('month', today()), n % 20),
              vision_numeric('-10.00', 18, 4), 'EUR', $1, 1, 0
         FROM g`,
      [rec.id],
    );
    expect(await viewRowCounts()).toEqual({
      mv_monthly_summary: 0,
      mv_category_totals: 0,
    });

    baseUrl = `http://127.0.0.1:${await freePort()}`;

    backend = spawn(process.execPath, [MAIN_JS], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        VISION_DATABASE_PATH: must(
          process.env.VISION_DATABASE_PATH,
          "VISION_DATABASE_PATH",
        ),
        PORT: new URL(baseUrl).port,
        SERVER_HOST: "127.0.0.1",
        VISION_BOOT_TRACE: "1",
      },
    });
    backend.stdout?.on("data", (c) => {
      backendLog += c;
      backendStdout += c;
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
    await closeTestPool();
    await closePool();
  }, 60_000);

  it("listens (and answers /health) before the view-table fill starts", async () => {
    const healthy = await waitFor(
      () =>
        fetch(`${baseUrl}/health`)
          .then((r) => r.ok)
          .catch(() => false),
      60_000,
    );
    expect(healthy, `backend never became healthy:\n${backendLog}`).toBe(true);

    // The discriminator: the fill is logged after the listen line. Under the old
    // pre-listen ordering it would come between "Database opened" and the listen
    // line.
    const filled = await waitFor(
      () => Promise.resolve(backendStdout.includes(FILL_DONE_LINE)),
      60_000,
    );
    expect(filled, `the fill never finished:\n${backendLog}`).toBe(true);
    const at = (line: string) => {
      const index = backendStdout.indexOf(line);
      expect(index, `${line} missing:\n${backendLog}`).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at(DB_OPEN_LINE)).toBeLessThan(at(LISTEN_LINE));
    expect(at(LISTEN_LINE)).toBeLessThan(at(FILL_START_LINE));
    expect(at(FILL_START_LINE)).toBeLessThan(at(FILL_DONE_LINE));

    // The boot summary printed at listen holds every phase that finished before
    // it; no materialized-view phase may be among them.
    const summary = /\[startup\] (\{"phase":"backend_total".*\})\n/.exec(backendLog);
    const marks = (
      JSON.parse(must(summary?.[1], `boot summary:\n${backendLog}`)) as {
        marks: Array<{ phase: string }>;
      }
    ).marks.map((m) => m.phase);
    expect(marks).toContain("run_migrations");
    expect(marks.filter((phase) => phase.startsWith("materialized_views"))).toEqual([]);
  }, 90_000);

  it("serves the same aggregation from the live path and the view table", async () => {
    // Whichever path answers — the live query while the tables are empty (and for
    // 60s after, through `mvAvailable`'s negative cache), or the filled table —
    // the numbers are the same: the view table is a speed artifact, never a
    // source of truth.
    const res = await fetch(`${baseUrl}/api/aggregations/category-breakdown`);
    expect(res.status).toBe(200);
    // { ok, data: { data: { categories }, meta } } — the response envelope
    // (ADR-026) wrapping the aggregation envelope.
    const body = (await res.json()) as CategoryBreakdownBody;
    const food = body.data.data.categories.find(
      (c) => c.name === "Food:Groceries",
    );
    expect(Number(must(food, "food").total)).toBe(-2000); // 200 rows × −10.00
    expect(Number(must(food, "food").count)).toBe(200);
  }, 60_000);

  it("completes the fill, indexing and refresh post-listen, then flips the health flag", async () => {
    const ready = await waitFor(
      () =>
        fetch(`${baseUrl}/health/detailed`)
          .then((r) => r.json() as Promise<HealthDetailed>)
          .then((d) => d.caches.materializedViews === true)
          .catch(() => false),
      60_000,
    );
    expect(ready, `materializedViews never settled:\n${backendLog}`).toBe(
      true,
    );
    const detailed = await fetch(`${baseUrl}/health/detailed`).then(
      (r) => r.json() as Promise<HealthDetailed>,
    );
    expect(detailed.warmup.materializedViews).toBe("ready");

    const counts = await viewRowCounts();
    expect(counts.mv_monthly_summary).toBeGreaterThan(0);
    expect(counts.mv_category_totals).toBeGreaterThan(0);

    // The unique indexes that keep a refill from storing duplicate rows.
    const { rows: idx } = await getTestPool().query<DbRow>(
      `SELECT name, tbl_name FROM sqlite_master
        WHERE type = 'index' AND name IN (SELECT value FROM json_each($1))
        ORDER BY name`,
      [MANAGED_VIEW_INDEXES],
    );
    expect(idx).toEqual([
      { name: "idx_mv_category_totals", tbl_name: "mv_category_totals" },
      { name: "idx_mv_monthly_summary", tbl_name: "mv_monthly_summary" },
    ]);

    // And the aggregation the view table now serves agrees with the live answer above.
    const { rows: totals } = await getTestPool().query<DbRow>(
      `SELECT name, count, total FROM mv_category_totals WHERE name = 'Food:Groceries'`,
    );
    expect(totals).toEqual([
      { name: "Food:Groceries", count: "200", total: "-2000.0000" },
    ]);
  }, 90_000);

  // Replaces REFRESH MATERIALIZED VIEW CONCURRENTLY's guarantee: a refresh is
  // DELETE + INSERT ... SELECT in one write transaction, and readers (here this
  // process's reader connection, interleaved with the refresh's statements, and
  // the backend in its own process) see the old or the new contents, never an
  // empty table.
  it("never shows readers an empty view table while a refresh runs", async () => {
    const before = await viewRowCounts();
    expect(before.mv_category_totals).toBeGreaterThan(0);

    let settled = false;
    const refresh = refreshMaterializedViews().finally(() => {
      settled = true;
    });
    const running = () => !settled;
    // The backend reads in its own process while this one refreshes.
    const servedTotals = (async () => {
      const totals: number[] = [];
      do {
        const res = await fetch(`${baseUrl}/api/aggregations/category-breakdown`);
        const body = (await res.json()) as CategoryBreakdownBody;
        const food = body.data.data.categories.find(
          (c) => c.name === "Food:Groceries",
        );
        totals.push(Number(must(food, "food").total));
      } while (running());
      return totals;
    })();
    // Each read awaits, so these interleave with the refresh's statements.
    const seen: Array<Record<string, number>> = [];
    while (running()) seen.push(await viewRowCounts());
    await refresh;
    const served = await servedTotals;

    expect(seen.length).toBeGreaterThan(0);
    for (const counts of seen) expect(counts).toEqual(before);
    for (const total of served) expect(total).toBe(-2000);
    expect(await viewRowCounts()).toEqual(before);
  }, 60_000);
});
