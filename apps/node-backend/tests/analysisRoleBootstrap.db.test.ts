/**
 * The analysis executor bootstrap against the native role topology: a
 * non-superuser owner that owns the migrated schema, and an app role that
 * creates the materialized views at runtime. The owner cannot administer
 * those views, so the bootstrap must not touch relations the executor holds
 * no grant on.
 */

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureAnalysisRole } from "../src/database/analysisRoleBootstrap.ts";
import { ensureAppRole } from "../src/database/roleBootstrap.ts";
import {
  createEmptyDatabase,
  hasIsolatedTestDatabase,
  migrateDatabase,
} from "./setup/migratedDatabase.ts";
import type { DisposableDatabase } from "./setup/migratedDatabase.ts";
import { must } from "./helpers/must.ts";

const OWNER = "vb_ar_owner";
const APP = "vb_ar_app";
const EXECUTOR = "vision_analysis_executor";
const OWNER_PASSWORD = "vb_ar_owner_pw";
const APP_PASSWORD = "vb_ar_app_pw";

let database: DisposableDatabase | undefined;
let urls: { owner: string; app: string; analysis: string };

function urlFor(base: string, user: string, password: string) {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
}

async function withClient<T>(url: string, run: (c: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

describe.skipIf(
  !hasIsolatedTestDatabase() || !process.env.DATABASE_URL_ANALYSIS,
)("analysis role bootstrap (real Postgres, native roles)", () => {
  beforeAll(async () => {
    const analysis = new URL(must(process.env.DATABASE_URL_ANALYSIS, "process.env.DATABASE_URL_ANALYSIS"));
    await withClient(must(process.env.TEST_DATABASE_URL, "process.env.TEST_DATABASE_URL"), async (admin) => {
      await admin.query(
        `CREATE ROLE ${OWNER} LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(
        `CREATE ROLE ${APP} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
      );
      const exists = await admin.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [EXECUTOR],
      );
      if (exists.rows.length === 0) {
        await admin.query(
          `CREATE ROLE ${EXECUTOR} LOGIN PASSWORD '${decodeURIComponent(analysis.password)}' ` +
            "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
        );
      }
    });
    database = await createEmptyDatabase("vb_ar");
    urls = {
      owner: urlFor(database.url, OWNER, OWNER_PASSWORD),
      app: urlFor(database.url, APP, APP_PASSWORD),
      analysis: urlFor(
        database.url,
        EXECUTOR,
        decodeURIComponent(analysis.password),
      ),
    };
    await withClient(database.url, async (admin) => {
      await admin.query(`ALTER DATABASE ${must(database, "database").name} OWNER TO ${OWNER}`);
      for (const extension of ["pg_stat_statements", "pg_trgm", "pgcrypto"]) {
        await admin.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
      }
    });
    await migrateDatabase(urls.owner);
    const appRole = await ensureAppRole({
      databaseUrl: urls.app,
      migrationsUrl: urls.owner,
    });
    expect(appRole.status).not.toBe("unavailable");
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
    await withClient(must(process.env.TEST_DATABASE_URL, "process.env.TEST_DATABASE_URL"), async (admin) => {
      await admin.query(`DROP ROLE IF EXISTS ${APP}`);
      await admin.query(`DROP ROLE IF EXISTS ${OWNER}`);
    });
  });

  it("grants the approved views when the app role owns a materialized view", async () => {
    await withClient(urls.app, (app) =>
      app.query(
        "CREATE MATERIALIZED VIEW mv_category_totals AS SELECT 1 AS total",
      ),
    );
    // A stray direct grant the bootstrap must still remove.
    await withClient(must(database, "database").url, (admin) =>
      admin.query(`GRANT SELECT ON public.transactions TO ${EXECUTOR}`),
    );

    const warnings: string[] = [];
    const result = await ensureAnalysisRole({
      databaseUrl: urls.app,
      analysisUrl: urls.analysis,
      migrationsUrl: urls.owner,
      log: { warn: (message: unknown) => warnings.push(String(message)) },
    });

    expect(warnings).toEqual([]);
    expect(result).toEqual({ status: "exists" });
    const grants = await withClient(must(database, "database").url, async (admin) =>
      (
        await admin.query(
          `SELECT table_schema || '.' || table_name AS relation
             FROM information_schema.role_table_grants
            WHERE grantee = $1
            ORDER BY 1`,
          [EXECUTOR],
        )
      ).rows.map((row) => row.relation as string),
    );
    expect(grants).toEqual([
      "vision_analysis.accounts_v1",
      "vision_analysis.cash_flows_v1",
      "vision_analysis.cash_flows_v2",
      "vision_analysis.holding_events_v1",
      "vision_analysis.transactions_v1",
      "vision_analysis.transactions_v2",
    ]);
  });
});
