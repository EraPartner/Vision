#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBaselineManifest } from "../apps/node-backend/src/database/baselineManifest.js";
import pg from "../apps/node-backend/node_modules/pg/lib/index.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== "--backup" ||
  args[2] !== "--writers-stopped" ||
  args[3] !== "--maintenance-approved"
) {
  throw new Error(
    "Usage: bridge-squashed-baseline.mjs --backup /absolute/new.dump --writers-stopped --maintenance-approved",
  );
}
const backupPath = args[1];
if (!path.isAbsolute(backupPath) || existsSync(backupPath)) {
  throw new Error("Backup path must be absolute and must not already exist");
}
if (!statSync(path.dirname(backupPath)).isDirectory()) {
  throw new Error("Backup parent must be an existing directory");
}
const connectionString =
  process.env.DATABASE_URL_MIGRATIONS?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("Migration database URL is required");
const parsed = new URL(connectionString);
if (
  !["postgres:", "postgresql:"].includes(parsed.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
  !parsed.pathname.slice(1) ||
  !parsed.username
) {
  throw new Error("Bridge supports only an explicit local PostgreSQL URL");
}
const adminRole = process.env.VISION_POSTGRES_ADMIN_ROLE;
const adminPassword = process.env.VISION_POSTGRES_ADMIN_PASSWORD;
const readUrl = new URL(connectionString);
if (adminRole && adminPassword) {
  readUrl.username = adminRole;
  readUrl.password = adminPassword;
}
const readConnectionString = readUrl.toString();

const sourceExpected = new Set([
  "9e634493345024873f8dce83c2fc142d46cf090becf6e519ac56d492a20ea146",
  "8508bf6f1c047ff28ea0eaa3e0381580c7c4e5ea94d5f772b0e4e5a2bd6cbc10",
]);
const source = await readBaselineManifest({
  connectionString: readConnectionString,
  repoRoot,
});
if (
  source.revision !== "0118_audit_retention_pruner" ||
  !sourceExpected.has(source.schemaFingerprint)
) {
  throw new Error("Source is not the reviewed contracted 0118 schema");
}

async function assertStoppedWriters() {
  const client = new pg.Client({
    connectionString: readConnectionString,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT count(*)::int AS other_clients
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
    `);
    if (result.rows[0].other_clients !== 0) {
      throw new Error(
        "Other database clients remain connected; stop every writer",
      );
    }
  } finally {
    await client.end();
  }
}

function findPgTool(name) {
  const candidates = [
    process.env.VISION_TEST_POSTGRES_BIN,
    process.env.VISION_POSTGRES_BIN,
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/local/opt/postgresql@18/bin",
    "/usr/lib/postgresql/18/bin",
  ].filter(Boolean);
  for (const directory of candidates) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

const pgEnv = {
  ...process.env,
  PGHOST: parsed.hostname.replace(/^\[|\]$/g, ""),
  PGPORT: parsed.port || "5432",
  PGUSER: decodeURIComponent(readUrl.username),
  PGPASSWORD: decodeURIComponent(readUrl.password),
  PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
};
if (parsed.searchParams.has("sslmode")) {
  pgEnv.PGSSLMODE = parsed.searchParams.get("sslmode");
}

await assertStoppedWriters();
process.umask(0o077);
const workDir = mkdtempSync(path.join(os.tmpdir(), "vision-baseline-bridge-"));
try {
  const manifestPath = path.join(workDir, "source-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(source), {
    flag: "wx",
    mode: 0o600,
  });
  execFileSync(findPgTool("pg_dump"), ["-Fc", "-f", backupPath], {
    env: pgEnv,
    stdio: "pipe",
    timeout: 10 * 60_000,
  });
  if (!statSync(backupPath).size) throw new Error("Logical backup is empty");
  execFileSync(findPgTool("pg_restore"), ["--list", backupPath], {
    env: pgEnv,
    stdio: "pipe",
    timeout: 30_000,
  });
  execFileSync(path.join(repoRoot, "scripts", "with-test-db.sh"), [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      VISION_TEST_DB_TASK: "baseline-restore",
      VISION_BASELINE_BACKUP_PATH: backupPath,
      VISION_BASELINE_SOURCE_MANIFEST: manifestPath,
      TEST_DATABASE_URL: "",
    },
    stdio: "inherit",
    timeout: 10 * 60_000,
  });
  await assertStoppedWriters();
  const latest = await readBaselineManifest({
    connectionString: readConnectionString,
    repoRoot,
  });
  if (JSON.stringify(latest) !== JSON.stringify(source)) {
    throw new Error(
      "Source changed during backup verification; bridge refused",
    );
  }
  execFileSync(
    "bun",
    ["run", "apps/node-backend/scripts/db-migrate.js", "upgrade", "head"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: connectionString,
        DATABASE_URL_MIGRATIONS: connectionString,
        VISION_SKIP_CONFIG_ENV_LOCAL: "true",
        VISION_BASELINE_BRIDGE_APPROVED: "1",
      },
      stdio: "inherit",
      timeout: 10 * 60_000,
    },
  );
  const after = await readBaselineManifest({
    connectionString: readConnectionString,
    repoRoot,
  });
  const beforeDomain = source.tables.filter(
    (table) =>
      !["alembic_version", "audit_chain_entries", "audit_chain_head"].includes(
        table.name,
      ),
  );
  const afterDomain = after.tables.filter(
    (table) =>
      !["alembic_version", "audit_chain_entries", "audit_chain_head"].includes(
        table.name,
      ),
  );
  if (
    after.revision !== "0119_squashed_baseline" ||
    after.schemaFingerprint !== source.schemaFingerprint ||
    JSON.stringify(afterDomain) !== JSON.stringify(beforeDomain)
  ) {
    throw new Error(
      "Post-bridge revision or domain-data check failed; keep the backup",
    );
  }
  console.log("[baseline-bridge] 0119 reached; source domain rows unchanged.");
  console.log(`[baseline-bridge] Retain the verified backup at ${backupPath}.`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
