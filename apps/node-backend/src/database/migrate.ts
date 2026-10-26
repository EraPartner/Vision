import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CompiledQuery, Kysely, PostgresDialect, sql } from "kysely";
import { Migrator } from "kysely/migration";
import type { Migration, MigrationResult } from "kysely/migration";
import pg from "pg";
import { logger } from "../config/logger.ts";
import { readSchemaInventory, schemaFingerprint } from "./schemaInventory.ts";
import { errorMessage } from "../lib/errors.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// repo root: apps/node-backend/src/database/ -> ../../../..
const REPO_ROOT = process.env.VISION_RUNTIME_ROOT
  ? path.resolve(process.env.VISION_RUNTIME_ROOT)
  : path.resolve(__dirname, "..", "..", "..", "..");

export const MIGRATIONS_DIR = path.join(REPO_ROOT, "db", "migrations");
export const BASELINE_MIGRATION = "0001_baseline";
/**
 * Normalized catalog fingerprint of `0001_baseline.sql` on PostgreSQL 18,
 * excluding migration bookkeeping. A fresh install must match it.
 */
export const BASELINE_SCHEMA_FINGERPRINT =
  "c79fae80e075e13fa995db08eda282bc4ede1a96791181457859f445bc075615";

const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+$/;

// A large migration can legitimately run for minutes (full-table rewrites).
// VISION_MIGRATE_TIMEOUT_MS overrides the 10-minute default (0 = no timeout).
function resolveTimeoutMs(): number {
  const raw = process.env.VISION_MIGRATE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 600_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 600_000;
}

const PUBLIC_TABLES_ANALYZE_SQL = `DO $vision_analyze$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT schemaname, tablename
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  LOOP
    EXECUTE format('ANALYZE %I.%I', item.schemaname, item.tablename);
  END LOOP;
END
$vision_analyze$`;

type Db = Kysely<unknown>;

export interface RunMigrationsResult {
  /** Latest applied migration after the run. */
  revision: string | undefined;
  applied: string[];
}

function migrationConnectionString(): string {
  const url =
    process.env.DATABASE_URL_MIGRATIONS?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Migration database URL is required");
  return url;
}

/**
 * A dedicated, short-lived Kysely instance as the schema owner. The
 * application pool deliberately lacks ownership of the schema, so migrations
 * never fall back to DATABASE_URL in the least-privilege setup.
 */
function createMigrationDb(): Db {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: migrationConnectionString(),
        max: 1,
        connectionTimeoutMillis: 5_000,
        statement_timeout: resolveTimeoutMs(),
      }),
    }),
  });
}

async function rows<R>(db: Db, text: string): Promise<R[]> {
  const result = await db.executeQuery<R>(CompiledQuery.raw(text, []));
  return [...result.rows];
}

async function currentFingerprint(db: Db): Promise<string> {
  const inventory = await readSchemaInventory(
    (text) => rows(db, text).then((r) => ({ rows: r })),
    REPO_ROOT,
  );
  return schemaFingerprint(inventory);
}

/** Dumped SQL scopes search_path to its transaction; restore it for what follows. */
async function restoreSearchPath(db: Db) {
  await sql`SELECT pg_catalog.set_config('search_path', '"$user", public', true)`.execute(
    db,
  );
}

/**
 * Install the baseline into an empty database inside the migrator's
 * transaction and lock. A database with objects but no ledger is refused.
 */
async function baselineUp(db: Db, baselineSql: string) {
  const [state] = await rows<{
    major: number;
    has_objects: boolean;
  }>(
    db,
    `SELECT current_setting('server_version_num')::int / 10000 AS major,
            EXISTS (
              SELECT 1 FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname IN ('public', 'vision_analysis')
                AND c.relkind IN ('r','p','v','m','S','f')
                AND c.relname NOT IN ('kysely_migration', 'kysely_migration_lock')
                AND NOT EXISTS (
                  SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                    AND d.objid = c.oid AND d.deptype = 'e'
                )
            ) OR to_regnamespace('vision_analysis') IS NOT NULL AS has_objects`,
  );
  if (state?.major !== 18) {
    throw new Error("The Vision baseline requires PostgreSQL 18");
  }

  if (state.has_objects) {
    throw new Error(
      "Database has application objects but no migration marker; refusing the baseline. " +
        "Restore a backup taken after the switch to TypeScript migrations, or reset the " +
        "Demo with bun run demo:reset-native.",
    );
  }
  await sql.raw(baselineSql).execute(db);
  await restoreSearchPath(db);
  if ((await currentFingerprint(db)) !== BASELINE_SCHEMA_FINGERPRINT) {
    throw new Error("Installed baseline differs from the reviewed schema");
  }
}

/**
 * Every `db/migrations/NNNN_name.sql` is one migration; an optional
 * `NNNN_name.down.sql` makes it reversible.
 */
export function loadMigrations(
  dir = MIGRATIONS_DIR,
): Record<string, Migration> {
  if (!existsSync(dir)) throw new Error(`Migrations directory missing: ${dir}`);
  const files = readdirSync(dir);
  const names = files
    .filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql"))
    .map((file) => file.slice(0, -".sql".length))
    .sort();
  if (names[0] !== BASELINE_MIGRATION) {
    throw new Error(`The first migration must be ${BASELINE_MIGRATION}`);
  }
  const migrations: Record<string, Migration> = {};
  names.forEach((name) => {
    if (!MIGRATION_NAME.test(name)) {
      throw new Error(`Invalid migration file name: ${name}.sql`);
    }
    const upSql = readFileSync(path.join(dir, `${name}.sql`), "utf8");
    if (name === BASELINE_MIGRATION) {
      migrations[name] = { up: (db) => baselineUp(db, upSql) };
      return;
    }
    const downFile = path.join(dir, `${name}.down.sql`);
    const migration: Migration = {
      up: async (db) => {
        await sql.raw(upSql).execute(db);
        await restoreSearchPath(db);
      },
    };
    if (existsSync(downFile)) {
      const downSql = readFileSync(downFile, "utf8");
      migration.down = async (db) => {
        await sql.raw(downSql).execute(db);
        await restoreSearchPath(db);
      };
    }
    migrations[name] = migration;
  });
  return migrations;
}

function createMigrator(db: Db): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve().then(() => loadMigrations()) },
  });
}

function assertSucceeded(
  error: unknown,
  results: readonly MigrationResult[] | undefined,
): string[] {
  for (const result of results ?? []) {
    if (result.status === "Error") {
      logger.error(
        { migration: result.migrationName, direction: result.direction },
        "migration failed",
      );
    }
  }
  if (error) {
    throw error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : JSON.stringify(error));
  }
  return (results ?? [])
    .filter((result) => result.status === "Success")
    .map((result) => result.migrationName);
}

async function latestApplied(migrator: Migrator) {
  const migrations = await migrator.getMigrations();
  return migrations.filter((m) => m.executedAt).at(-1)?.name;
}

/**
 * Best-effort ANALYZE of the tables migrations most likely rewrote, so the
 * first queries after an upgrade plan with fresh statistics. Never fails boot.
 */
async function analyzeAfterMigrations(db: Db) {
  for (const table of ["transactions", "asset_price_history"]) {
    try {
      await sql.raw(`ANALYZE ${table}`).execute(db);
    } catch (err) {
      logger.warn(
        { err: errorMessage(err), table },
        "post-migration ANALYZE failed; non-fatal",
      );
    }
  }
}

/**
 * Refresh database-wide planner statistics through the migration/owner role in
 * split-role installs. The caller keeps this best-effort so an ANALYZE failure
 * can never block backend readiness.
 */
export async function runDatabaseAnalyze(): Promise<void> {
  const db = createMigrationDb();
  try {
    await sql.raw(PUBLIC_TABLES_ANALYZE_SQL).execute(db);
  } finally {
    await db.destroy();
  }
}

/** Apply every pending migration in one transaction under the migration lock. */
export async function runMigrations(): Promise<RunMigrationsResult> {
  const db = createMigrationDb();
  try {
    const migrator = createMigrator(db);
    const { error, results } = await migrator.migrateToLatest();
    const applied = assertSucceeded(error, results);
    if (applied.length > 0) {
      logger.info({ applied }, "migrations applied");
      await analyzeAfterMigrations(db);
    }
    return {
      revision: await latestApplied(migrator),
      applied,
    };
  } finally {
    await db.destroy();
  }
}

/** Revert the latest migration. Only migrations with a `.down.sql` can revert. */
export async function revertLatestMigration(): Promise<string | undefined> {
  const db = createMigrationDb();
  try {
    const migrator = createMigrator(db);
    const current = await latestApplied(migrator);
    if (!current || !loadMigrations()[current]?.down) {
      throw new Error(
        `${current ?? "No migration"} has no down migration; restore a backup instead`,
      );
    }
    const { error, results } = await migrator.migrateDown();
    assertSucceeded(error, results);
    return await latestApplied(migrator);
  } finally {
    await db.destroy();
  }
}

export interface MigrationStatus {
  name: string;
  executedAt: Date | undefined;
}

export async function readMigrationStatus(): Promise<MigrationStatus[]> {
  const db = createMigrationDb();
  try {
    const migrations = await createMigrator(db).getMigrations();
    return migrations.map(({ name, executedAt }) => ({ name, executedAt }));
  } finally {
    await db.destroy();
  }
}
