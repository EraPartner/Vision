#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "../apps/node-backend/node_modules/pg/lib/index.js";
import { readBaselineManifest } from "../apps/node-backend/src/database/baselineManifest.js";

const argv = process.argv.slice(2);
if (
  argv.length !== 4 ||
  argv[0] !== "--journal" ||
  argv[2] !== "--writers-stopped" ||
  argv[3] !== "--maintenance-approved" ||
  !path.isAbsolute(argv[1])
) {
  throw new Error(
    "Usage: rollback-legacy-baseline.mjs --journal /absolute/conversion-journal.json --writers-stopped --maintenance-approved",
  );
}
const journalPath = argv[1];
if (!existsSync(journalPath)) throw new Error("Conversion journal not found");
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
if (
  journal.version !== 1 ||
  journal.stage !== "complete" ||
  ![journal.sourceDatabase, journal.rollbackDatabase].every(
    (name) => typeof name === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(name),
  ) ||
  ![journal.sourceDigest, journal.targetDigest].every(
    (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
  )
) {
  throw new Error("Conversion journal is incomplete or invalid");
}
const ownerUrl = new URL(process.env.DATABASE_URL_MIGRATIONS || "");
if (
  !["postgres:", "postgresql:"].includes(ownerUrl.protocol) ||
  ownerUrl.hostname !== "127.0.0.1" ||
  decodeURIComponent(ownerUrl.pathname.slice(1)) !== journal.sourceDatabase
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
oldUrl.pathname = `/${journal.rollbackDatabase}`;
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const digestManifest = (manifest) =>
  createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function connected(url, fn) {
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
  digestManifest(active) !== journal.targetDigest ||
  digestManifest(old) !== journal.sourceDigest
) {
  throw new Error(
    "Database changed since conversion; automatic rollback refused",
  );
}
const failedName = `${journal.sourceDatabase}_after_0119_${randomBytes(5).toString("hex")}`;
if (failedName.length > 63)
  throw new Error("Rollback database name is too long");
await connected(catalogUrl.toString(), async (client) => {
  const { rows } = await client.query(
    `SELECT datname, count(*)::int AS clients FROM pg_stat_activity
     WHERE datname IN ($1, $2) AND backend_type = 'client backend'
     GROUP BY datname`,
    [journal.sourceDatabase, journal.rollbackDatabase],
  );
  if (rows.some((row) => row.clients !== 0))
    throw new Error("Database clients remain connected; rollback refused");
  await client.query(
    `ALTER DATABASE ${quote(journal.sourceDatabase)} RENAME TO ${quote(failedName)}`,
  );
  try {
    await client.query(
      `ALTER DATABASE ${quote(journal.rollbackDatabase)} RENAME TO ${quote(journal.sourceDatabase)}`,
    );
  } catch (error) {
    await client.query(
      `ALTER DATABASE ${quote(failedName)} RENAME TO ${quote(journal.sourceDatabase)}`,
    );
    throw error;
  }
});
const restored = await readBaselineManifest({
  connectionString: adminUrl.toString(),
  repoRoot,
});
if (digestManifest(restored) !== journal.sourceDigest) {
  throw new Error("Rollback name swap completed but restored database differs");
}
writeFileSync(
  journalPath,
  `${JSON.stringify({ ...journal, stage: "rolled_back", convertedDatabase: failedName })}\n`,
  { mode: 0o600 },
);
console.log(`[baseline-rollback] Restored ${journal.sourceDatabase} at 0118.`);
console.log(
  `[baseline-rollback] Converted database retained as ${failedName}.`,
);
