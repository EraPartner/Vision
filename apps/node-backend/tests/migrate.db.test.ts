/**
 * The production migrator (src/database/migrate.ts) against real, disposable
 * PostgreSQL 18 databases: fresh install, idempotent re-run, fail-closed
 * refusals (unversioned objects, a database from before the baseline), and a later
 * reversible migration with its audit events.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { hasTestDatabase } from "./setup/db.ts";
import {
  createEmptyDatabase,
  createMigratedDatabase,
  hasIsolatedTestDatabase,
} from "./setup/migratedDatabase.ts";
import type { DisposableDatabase } from "./setup/migratedDatabase.ts";

type MigrateModule = typeof import("../src/database/migrate.ts");

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const created: DisposableDatabase[] = [];
const tempRoots: string[] = [];

async function track(database: Promise<DisposableDatabase>) {
  const db = await database;
  created.push(db);
  return db;
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

/** Run one migrate.ts export with the migrator pointed at `url`. */
async function withMigrationTarget<T>(
  url: string,
  run: () => Promise<T>,
  databaseUrl = url,
): Promise<T> {
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_MIGRATIONS: process.env.DATABASE_URL_MIGRATIONS,
  };
  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_URL_MIGRATIONS = url;
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Import a fresh copy of migrate.ts, optionally rooted at another runtime root. */
async function loadMigrator(runtimeRoot?: string): Promise<MigrateModule> {
  const saved = process.env.VISION_RUNTIME_ROOT;
  if (runtimeRoot) process.env.VISION_RUNTIME_ROOT = runtimeRoot;
  else delete process.env.VISION_RUNTIME_ROOT;
  vi.resetModules();
  try {
    return await import("../src/database/migrate.ts");
  } finally {
    if (saved === undefined) delete process.env.VISION_RUNTIME_ROOT;
    else process.env.VISION_RUNTIME_ROOT = saved;
  }
}

async function auditEvents(client: pg.Client) {
  const result = await client.query(
    "SELECT payload FROM audit_chain_entries ORDER BY sequence",
  );
  return result.rows.map((row) => row.payload as Record<string, unknown>);
}

async function appliedNames(client: pg.Client) {
  if (!(await regclass(client, "public.kysely_migration"))) return [];
  const result = await client.query(
    "SELECT name FROM public.kysely_migration ORDER BY name",
  );
  return result.rows.map((row) => row.name as string);
}

async function regclass(client: pg.Client, name: string) {
  return (await client.query("SELECT to_regclass($1)::text AS name", [name]))
    .rows[0].name as string | null;
}

/** A full schema without the Kysely ledger, as before the TypeScript baseline. */
async function preBaselineDatabase() {
  const db = await track(createMigratedDatabase("c_prebaseline"));
  await withClient(db.url, (client) =>
    client.query(
      "DROP TABLE public.kysely_migration, public.kysely_migration_lock",
    ),
  );
  return db;
}

describe.skipIf(!hasTestDatabase() || !hasIsolatedTestDatabase())(
  "database migrator on disposable PostgreSQL",
  () => {
    afterAll(async () => {
      for (const db of created) await db.drop();
      for (const root of tempRoots)
        rmSync(root, { recursive: true, force: true });
    });

    it("installs the baseline into an empty database, then re-runs as a no-op", async () => {
      const migrator = await loadMigrator();
      const db = await track(createEmptyDatabase("c_fresh"));
      // The owner URL wins over an unusable application URL.
      const first = await withMigrationTarget(
        db.url,
        () => migrator.runMigrations(),
        "postgresql://nobody@127.0.0.1:1/unreachable",
      );
      expect(first).toEqual({
        revision: migrator.BASELINE_MIGRATION,
        applied: [migrator.BASELINE_MIGRATION],
      });

      await withClient(db.url, async (client) => {
        expect(await appliedNames(client)).toEqual(["0001_baseline"]);
        expect(await auditEvents(client)).toEqual([
          {
            stream: "schema_migration",
            event: "baseline_installed",
            direction: "bootstrap",
            revision: "0001_baseline",
            heads: ["0001_baseline"],
          },
        ]);
      });

      const second = await withMigrationTarget(db.url, () =>
        migrator.runMigrations(),
      );
      expect(second).toEqual({
        revision: "0001_baseline",
        applied: [],
      });
      const status = await withMigrationTarget(db.url, () =>
        migrator.readMigrationStatus(),
      );
      expect(status.map((m) => m.name)).toEqual(["0001_baseline"]);
      expect(status[0]?.executedAt).toBeInstanceOf(Date);
      await withClient(db.url, async (client) => {
        expect(await auditEvents(client)).toHaveLength(1);
      });

      await expect(
        withMigrationTarget(db.url, () => migrator.revertLatestMigration()),
      ).rejects.toThrow("0001_baseline has no down migration");
      await expect(
        withMigrationTarget(db.url, () => migrator.runDatabaseAnalyze()),
      ).resolves.toBeUndefined();
    }, 180_000);

    it("refuses to install the baseline over unversioned objects", async () => {
      const migrator = await loadMigrator();
      const db = await track(createEmptyDatabase("c_unversioned"));
      await withClient(db.url, (client) =>
        client.query("CREATE TABLE public.unversioned_probe (id int)"),
      );
      await expect(
        withMigrationTarget(db.url, () => migrator.runMigrations()),
      ).rejects.toThrow("no migration marker");
      await withClient(db.url, async (client) => {
        expect(await regclass(client, "public.accounts")).toBeNull();
        expect(await regclass(client, "public.unversioned_probe")).toBe(
          "unversioned_probe",
        );
      });
    }, 180_000);

    it("refuses a database from before the baseline without changing anything", async () => {
      const migrator = await loadMigrator();
      const db = await preBaselineDatabase();
      await expect(
        withMigrationTarget(db.url, () => migrator.runMigrations()),
      ).rejects.toThrow("no migration marker");
      await withClient(db.url, async (client) => {
        expect(await appliedNames(client)).toEqual([]);
        expect(await auditEvents(client)).toHaveLength(1);
      });
    }, 180_000);

    it("applies and reverts a later migration with audited revision events", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "vision-migrator-"));
      tempRoots.push(root);
      mkdirSync(path.join(root, "db", "migrations"), { recursive: true });
      cpSync(
        path.join(repoRoot, "db", "migrations", "0001_baseline.sql"),
        path.join(root, "db", "migrations", "0001_baseline.sql"),
      );
      cpSync(
        path.join(repoRoot, "db", "schema-inventory.sql"),
        path.join(root, "db", "schema-inventory.sql"),
      );
      writeFileSync(
        path.join(root, "db", "migrations", "0002_migrator_probe.sql"),
        "CREATE TABLE public.migrator_probe (id integer PRIMARY KEY);\n",
      );
      writeFileSync(
        path.join(root, "db", "migrations", "0002_migrator_probe.down.sql"),
        "DROP TABLE public.migrator_probe;\n",
      );

      const migrator = await loadMigrator(root);
      expect(migrator.MIGRATIONS_DIR).toBe(path.join(root, "db", "migrations"));
      const db = await track(createEmptyDatabase("c_later"));

      const up = await withMigrationTarget(db.url, () =>
        migrator.runMigrations(),
      );
      expect(up).toEqual({
        revision: "0002_migrator_probe",
        applied: ["0001_baseline", "0002_migrator_probe"],
      });
      await withClient(db.url, async (client) => {
        expect(await regclass(client, "public.migrator_probe")).toBe(
          "migrator_probe",
        );
        expect((await auditEvents(client)).at(-1)).toEqual({
          stream: "schema_migration",
          event: "revision_applied",
          direction: "upgrade",
          revision: "0002_migrator_probe",
          heads: ["0002_migrator_probe"],
        });
      });

      const reverted = await withMigrationTarget(db.url, () =>
        migrator.revertLatestMigration(),
      );
      expect(reverted).toBe("0001_baseline");
      await withClient(db.url, async (client) => {
        expect(await regclass(client, "public.migrator_probe")).toBeNull();
        expect(await appliedNames(client)).toEqual(["0001_baseline"]);
        const events = await auditEvents(client);
        expect(events).toHaveLength(3);
        expect(events.at(-1)).toEqual({
          stream: "schema_migration",
          event: "revision_applied",
          direction: "downgrade",
          revision: "0002_migrator_probe",
          heads: ["0001_baseline"],
        });
      });
    }, 180_000);
  },
);
