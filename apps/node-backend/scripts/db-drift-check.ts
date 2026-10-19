#!/usr/bin/env bun
/**
 * One-off, read-only check before the switch to TypeScript migrations
 * (ADR-221): does this database's schema match db/migrations/0001_baseline.sql?
 *
 * Usage: bun run db:drift-check [--env-file <runtime.env>]
 *   Default env file: ~/Library/Application Support/Vision/native/vision/runtime.env
 *   (Vision must be running so its PostgreSQL accepts connections.)
 *   DATABASE_URL_MIGRATIONS or DATABASE_URL in the environment win over the file.
 *
 * Prints the revision marker, both fingerprints and, on a mismatch, the names
 * of the differing objects. Never prints row data or the connection URL. The
 * comparison installs the baseline into a temporary database on the same
 * server and drops it again; the checked database is only read.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import {
  BASELINE_SCHEMA_FINGERPRINT,
  FINAL_ALEMBIC_REVISION,
  MIGRATIONS_DIR,
  BASELINE_MIGRATION,
} from "../src/database/migrate.ts";
import {
  diffSchemaInventory,
  readSchemaInventory,
  schemaFingerprint,
} from "../src/database/schemaInventory.ts";
import type { SchemaInventoryEntry } from "../src/database/schemaInventory.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DEFAULT_ENV_FILE = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Vision",
  "native",
  "vision",
  "runtime.env",
);

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

function resolveUrl(): string {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--env-file");
  const fromEnv =
    process.env.DATABASE_URL_MIGRATIONS?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (flag === -1 && fromEnv) return fromEnv;
  const file = flag === -1 ? DEFAULT_ENV_FILE : args[flag + 1];
  if (!file || !existsSync(file)) {
    throw new Error(`Env file not found: ${file ?? "(missing value)"}`);
  }
  const env = readEnvFile(file);
  const url = env.DATABASE_URL_MIGRATIONS || env.DATABASE_URL;
  if (!url) throw new Error(`No database URL in ${file}`);
  return url;
}

async function inventoryOf(client: pg.Client): Promise<SchemaInventoryEntry[]> {
  return readSchemaInventory((text) => client.query(text), REPO_ROOT);
}

async function baselineInventory(url: string): Promise<SchemaInventoryEntry[]> {
  const scratch = `vision_drift_check_${process.pid}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${scratch}`);
    const target = new URL(url);
    target.pathname = `/${scratch}`;
    const client = new pg.Client({ connectionString: target.toString() });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        readFileSync(path.join(MIGRATIONS_DIR, `${BASELINE_MIGRATION}.sql`), "utf8"),
      );
      await client.query('SET LOCAL search_path = "$user", public');
      const inventory = await inventoryOf(client);
      await client.query("ROLLBACK");
      return inventory;
    } finally {
      await client.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${scratch}`).catch(() => {});
    await admin.end();
  }
}

const url = resolveUrl();
const client = new pg.Client({ connectionString: url });
await client.connect();
let actual: SchemaInventoryEntry[];
let alembic: string | null = null;
let kysely: string | null = null;
try {
  await client.query("BEGIN TRANSACTION READ ONLY");
  const tables = await client.query<{ alembic: boolean; kysely: boolean }>(
    `SELECT to_regclass('public.alembic_version') IS NOT NULL AS alembic,
            to_regclass('public.kysely_migration') IS NOT NULL AS kysely`,
  );
  if (tables.rows[0]?.alembic) {
    const result = await client.query<{ value: string | null }>(
      "SELECT string_agg(version_num, ',') AS value FROM public.alembic_version",
    );
    alembic = result.rows[0]?.value ?? null;
  }
  if (tables.rows[0]?.kysely) {
    const result = await client.query<{ value: string | null }>(
      "SELECT string_agg(name, ',' ORDER BY name) AS value FROM public.kysely_migration",
    );
    kysely = result.rows[0]?.value ?? null;
  }
  console.log(`PostgreSQL:        ${(await client.query("SHOW server_version")).rows[0]?.server_version}`);
  console.log(`Alembic revision:  ${alembic ?? "(none)"}`);
  console.log(`Kysely migrations: ${kysely ?? "(none)"}`);
  actual = await inventoryOf(client);
  await client.query("ROLLBACK");
} finally {
  await client.end();
}

const fingerprint = schemaFingerprint(actual);
console.log(`Schema objects:    ${actual.length}`);
console.log(`Fingerprint:       ${fingerprint}`);
console.log(`Baseline:          ${BASELINE_SCHEMA_FINGERPRINT}`);

const revisionOk = alembic === FINAL_ALEMBIC_REVISION || (kysely ?? "").length > 0;
if (fingerprint === BASELINE_SCHEMA_FINGERPRINT && revisionOk) {
  console.log("\nMATCH: this database can switch to the TypeScript migrations.");
  process.exit(0);
}
if (!revisionOk) {
  console.log(
    `\nREVISION: expected Alembic ${FINAL_ALEMBIC_REVISION}; start the current Vision once to upgrade it first.`,
  );
}
if (fingerprint !== BASELINE_SCHEMA_FINGERPRINT) {
  const diff = diffSchemaInventory(await baselineInventory(url), actual);
  console.log("\nDRIFT: the schema differs from the baseline.");
  for (const [label, names] of Object.entries(diff)) {
    if (names.length === 0) continue;
    console.log(`  ${label} (${names.length}):`);
    for (const name of names) console.log(`    ${name}`);
  }
}
process.exit(1);
