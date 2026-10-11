#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type * as Pg from "../apps/node-backend/node_modules/@types/pg/index.d.ts";
import {
  readBaselineManifest,
  type BaselineManifest,
} from "../apps/node-backend/src/database/baselineManifest.ts";

type Row = Record<string, unknown>;

const repoRoot = path.resolve(import.meta.dirname, "..");
// pg is a backend dependency; resolve it (and its published types) from there.
const pg: typeof Pg = createRequire(
  path.join(repoRoot, "apps", "node-backend", "package.json"),
)("pg");

const isDatabaseName = (name: unknown): name is string =>
  typeof name === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(name);
const isDigest = (digest: unknown): digest is string =>
  typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest);

const argv = process.argv.slice(2);
const [journalFlag, journalPath, writersFlag, maintenanceFlag] = argv;
if (
  argv.length !== 4 ||
  journalFlag !== "--journal" ||
  journalPath === undefined ||
  writersFlag !== "--writers-stopped" ||
  maintenanceFlag !== "--maintenance-approved" ||
  !path.isAbsolute(journalPath)
) {
  throw new Error(
    "Usage: rollback-legacy-baseline.ts --journal /absolute/conversion-journal.json --writers-stopped --maintenance-approved",
  );
}
if (!existsSync(journalPath)) throw new Error("Conversion journal not found");
const parsedJournal: unknown = JSON.parse(readFileSync(journalPath, "utf8"));
// Every other field (backup and archive paths, …) is carried over unchanged.
const journal: Record<string, unknown> =
  typeof parsedJournal === "object" && parsedJournal !== null
    ? { ...parsedJournal }
    : {};
const { sourceDatabase, rollbackDatabase, sourceDigest, targetDigest } =
  journal;
if (
  journal.version !== 1 ||
  journal.stage !== "complete" ||
  !isDatabaseName(sourceDatabase) ||
  !isDatabaseName(rollbackDatabase) ||
  !isDigest(sourceDigest) ||
  !isDigest(targetDigest)
) {
  throw new Error("Conversion journal is incomplete or invalid");
}
const ownerUrl = new URL(process.env.DATABASE_URL_MIGRATIONS || "");
if (
  !["postgres:", "postgresql:"].includes(ownerUrl.protocol) ||
  ownerUrl.hostname !== "127.0.0.1" ||
  decodeURIComponent(ownerUrl.pathname.slice(1)) !== sourceDatabase
) {
  throw new Error("Migration URL does not match the converted local database");
}
const adminUrl = new URL(ownerUrl);
if (
  process.env.VISION_POSTGRES_ADMIN_ROLE &&
  process.env.VISION_POSTGRES_ADMIN_PASSWORD
) {
  adminUrl.username = process.env.VISION_POSTGRES_ADMIN_ROLE;
  adminUrl.password = process.env.VISION_POSTGRES_ADMIN_PASSWORD;
}
const catalogUrl = new URL(adminUrl);
catalogUrl.pathname = "/postgres";
const oldUrl = new URL(adminUrl);
oldUrl.pathname = `/${rollbackDatabase}`;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const digestManifest = (manifest: BaselineManifest) =>
  createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

async function connected<T>(
  url: string,
  fn: (client: Pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const active = await readBaselineManifest({
  connectionString: adminUrl.toString(),
  repoRoot,
});
const old = await readBaselineManifest({
  connectionString: oldUrl.toString(),
  repoRoot,
});
if (
  active.revision !== "0119_squashed_baseline" ||
  old.revision !== "0118_audit_retention_pruner" ||
  digestManifest(active) !== targetDigest ||
  digestManifest(old) !== sourceDigest
) {
  throw new Error(
    "Database changed since conversion; automatic rollback refused",
  );
}
const failedName = `${sourceDatabase}_after_0119_${randomBytes(5).toString("hex")}`;
if (failedName.length > 63)
  throw new Error("Rollback database name is too long");
await connected(catalogUrl.toString(), async (client) => {
  const { rows } = await client.query<Row>(
    `SELECT datname, count(*)::int AS clients FROM pg_stat_activity
     WHERE datname IN ($1, $2) AND backend_type = 'client backend'
     GROUP BY datname`,
    [sourceDatabase, rollbackDatabase],
  );
  if (rows.some((row) => row.clients !== 0))
    throw new Error("Database clients remain connected; rollback refused");
  await client.query(
    `ALTER DATABASE ${quote(sourceDatabase)} RENAME TO ${quote(failedName)}`,
  );
  try {
    await client.query(
      `ALTER DATABASE ${quote(rollbackDatabase)} RENAME TO ${quote(sourceDatabase)}`,
    );
  } catch (error) {
    await client.query(
      `ALTER DATABASE ${quote(failedName)} RENAME TO ${quote(sourceDatabase)}`,
    );
    throw error;
  }
});
const restored = await readBaselineManifest({
  connectionString: adminUrl.toString(),
  repoRoot,
});
if (digestManifest(restored) !== sourceDigest) {
  throw new Error("Rollback name swap completed but restored database differs");
}
writeFileSync(
  journalPath,
  `${JSON.stringify({ ...journal, stage: "rolled_back", convertedDatabase: failedName })}\n`,
  { mode: 0o600 },
);
console.log(`[baseline-rollback] Restored ${sourceDatabase} at 0118.`);
console.log(
  `[baseline-rollback] Converted database retained as ${failedName}.`,
);
