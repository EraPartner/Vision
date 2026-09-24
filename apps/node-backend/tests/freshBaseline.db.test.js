import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  FRESH_BASELINE_REVISION,
  installFreshBaseline,
} from "../src/database/freshBaseline.js";
import { __readBaselineManifest as readBaselineManifest } from "../src/database/baselineManifest.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const isolated =
  process.env.VISION_TEST_DB_ISOLATED === "1" &&
  Boolean(process.env.TEST_DATABASE_URL);

async function withDisposableDatabase(run) {
  const parent = new URL(process.env.TEST_DATABASE_URL);
  parent.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: parent.toString() });
  const databaseName = `vision_baseline_${randomUUID().replaceAll("-", "")}`;
  const child = new URL(parent);
  child.pathname = `/${databaseName}`;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    try {
      await run(child.toString());
    } finally {
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}

describe.skipIf(!isolated)(
  "reviewed fresh baseline on disposable PostgreSQL",
  () => {
    it("installs once and refuses a database with unversioned user objects", async () => {
      await withDisposableDatabase(async (connectionString) => {
        expect(await installFreshBaseline({ repoRoot, connectionString })).toBe(
          true,
        );
        const manifest = await readBaselineManifest({
          repoRoot,
          connectionString,
        });
        expect(manifest.revision).toBe(FRESH_BASELINE_REVISION);
        expect(manifest.tables.length).toBeGreaterThan(75);
        expect(await installFreshBaseline({ repoRoot, connectionString })).toBe(
          false,
        );
      });

      await withDisposableDatabase(async (connectionString) => {
        const client = new pg.Client({ connectionString });
        await client.connect();
        try {
          await client.query("CREATE TABLE public.unversioned_probe (id int)");
        } finally {
          await client.end();
        }
        await expect(
          installFreshBaseline({ repoRoot, connectionString }),
        ).rejects.toThrow("Database has objects but no revision marker");
        const check = new pg.Client({ connectionString });
        await check.connect();
        try {
          const result = await check.query(
            "SELECT to_regclass('public.alembic_version') AS version_table",
          );
          expect(result.rows[0].version_table).toBeNull();
        } finally {
          await check.end();
        }
      });
    });
  },
);
