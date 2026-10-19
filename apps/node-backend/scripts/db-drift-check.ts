#!/usr/bin/env bun
/**
 * One-off, read-only check before the switch to TypeScript migrations
 * (ADR-222): does this database's schema match db/migrations/0001_baseline.sql?
 *
 * Usage: bun run db:drift-check [--env-file <runtime.env> | --from-env]
 *   Default env file: ~/Library/Application Support/Vision/native/vision/runtime.env
 *   (Vision must be running so its PostgreSQL accepts connections.)
 *   --from-env uses DATABASE_URL_MIGRATIONS or DATABASE_URL from the environment
 *   instead. It is opt-in because Bun auto-loads a checkout's .env files.
 *
 * Prints the revision marker, both fingerprints and, on a mismatch, the names
 * of the differing objects. Never prints row data or the connection URL. A
 * database at an earlier adoptable Alembic revision is checked as it will look
 * after the adoption bridge: the bridge steps run in a transaction that is
 * rolled back. Differences are listed against db/baseline-inventory.json, so the
 * check needs no CREATEDB privilege. Nothing in the checked database changes.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import {
  ADOPTABLE_ALEMBIC_REVISIONS,
  BASELINE_SCHEMA_FINGERPRINT,
  alembicBridgeSteps,
  readAlembicBridgeStep,
} from "../src/database/migrate.ts";
import {
  diffSchemaInventory,
  hashSchemaInventory,
  readBaselineInventory,
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
  if (args.includes("--from-env")) {
    const fromEnv =
      process.env.DATABASE_URL_MIGRATIONS?.trim() ||
      process.env.DATABASE_URL?.trim();
    if (!fromEnv) throw new Error("--from-env: DATABASE_URL is not set");
    return fromEnv;
  }
  const flag = args.indexOf("--env-file");
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

const url = resolveUrl();
const client = new pg.Client({ connectionString: url });
await client.connect();
let actual: SchemaInventoryEntry[];
let alembic: string | null = null;
let kysely: string | null = null;
try {
  await client.query("BEGIN");
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
  const bridge = alembic ? (alembicBridgeSteps(alembic) ?? []) : [];
  for (const step of bridge) {
    await client.query(readAlembicBridgeStep(step));
    console.log(`Bridge step:       ${step} (rolled back after the check)`);
  }
  actual = await inventoryOf(client);
  await client.query("ROLLBACK");
} finally {
  await client.end();
}

const fingerprint = schemaFingerprint(actual);
console.log(`Schema objects:    ${actual.length}`);
console.log(`Fingerprint:       ${fingerprint}`);
console.log(`Baseline:          ${BASELINE_SCHEMA_FINGERPRINT}`);

const revisionOk =
  (alembic !== null && alembicBridgeSteps(alembic) !== undefined) ||
  (kysely ?? "").length > 0;
if (fingerprint === BASELINE_SCHEMA_FINGERPRINT && revisionOk) {
  console.log("\nMATCH: this database can switch to the TypeScript migrations.");
  process.exit(0);
}
if (!revisionOk) {
  console.log(
    `\nREVISION: expected one of Alembic ${ADOPTABLE_ALEMBIC_REVISIONS.join(", ")}.`,
  );
}
if (fingerprint !== BASELINE_SCHEMA_FINGERPRINT) {
  const diff = diffSchemaInventory(
    readBaselineInventory(REPO_ROOT),
    hashSchemaInventory(actual),
  );
  console.log("\nDRIFT: the schema differs from the baseline.");
  for (const [label, names] of Object.entries(diff)) {
    if (names.length === 0) continue;
    console.log(`  ${label} (${names.length}):`);
    for (const name of names) console.log(`    ${name}`);
  }
}
process.exit(1);
