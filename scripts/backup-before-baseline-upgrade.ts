#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type * as Pg from "../apps/node-backend/node_modules/@types/pg/index.d.ts";
import { readBaselineManifest } from "../apps/node-backend/src/database/baselineManifest.ts";

type Row = Record<string, unknown>;

const repoRoot = path.resolve(import.meta.dirname, "..");
// pg is a backend dependency; resolve it (and its published types) from there.
const pg: typeof Pg = createRequire(
  path.join(repoRoot, "apps", "node-backend", "package.json"),
)("pg");
const args = process.argv.slice(2);
const [backupFlag, backupPath, writersFlag, maintenanceFlag] = args;
if (
  args.length !== 4 ||
  backupFlag !== "--backup" ||
  backupPath === undefined ||
  writersFlag !== "--writers-stopped" ||
  maintenanceFlag !== "--maintenance-approved"
) {
  throw new Error(
    "Usage: backup-before-baseline-upgrade.ts --backup /absolute/new.dump --writers-stopped --maintenance-approved",
  );
}
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
const url = new URL(connectionString);
if (
  !["postgres:", "postgresql:"].includes(url.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !url.pathname.slice(1) ||
  !url.username
) {
  throw new Error("Backup supports only an explicit local PostgreSQL URL");
}
const adminRole = process.env.VISION_POSTGRES_ADMIN_ROLE;
const adminPassword = process.env.VISION_POSTGRES_ADMIN_PASSWORD;
const readUrl = new URL(connectionString);
if (adminRole && adminPassword) {
  readUrl.username = adminRole;
  readUrl.password = adminPassword;
}
const readConnectionString = readUrl.toString();

async function assertStoppedWriters(): Promise<void> {
  const client = new pg.Client({
    connectionString: readConnectionString,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const result = await client.query<Row>(`
      SELECT count(*)::int AS other_clients
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Client count query returned no row");
    if (row.other_clients !== 0) {
      throw new Error(
        "Other database clients remain connected; stop every writer",
      );
    }
  } finally {
    await client.end();
  }
}

function pgTool(name: string): string {
  for (const directory of [
    process.env.VISION_TEST_POSTGRES_BIN,
    process.env.VISION_POSTGRES_BIN,
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/local/opt/postgresql@18/bin",
    "/usr/lib/postgresql/18/bin",
  ]) {
    if (directory && existsSync(path.join(directory, name))) {
      return path.join(directory, name);
    }
  }
  return name;
}

const pgEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
  PGPORT: url.port || "5432",
  PGUSER: decodeURIComponent(readUrl.username),
  PGPASSWORD: decodeURIComponent(readUrl.password),
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
};
const sslmode = url.searchParams.get("sslmode");
if (sslmode !== null) {
  pgEnv.PGSSLMODE = sslmode;
}

await assertStoppedWriters();
process.umask(0o077);
const source = await readBaselineManifest({
  connectionString: readConnectionString,
  repoRoot,
});
if (
  !/^0\d{3}_[a-z0-9_]+$/.test(source.revision) ||
  source.revision === "0119_squashed_baseline"
) {
  throw new Error("Source revision is not a supported pre-baseline revision");
}
const workDir = mkdtempSync(
  path.join(os.tmpdir(), "vision-prebaseline-backup-"),
);
try {
  const manifestPath = path.join(workDir, "source-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(source), {
    flag: "wx",
    mode: 0o600,
  });
  await assertStoppedWriters();
  execFileSync(pgTool("pg_dump"), ["-Fc", "-f", backupPath], {
    env: pgEnv,
    stdio: "pipe",
    timeout: 10 * 60_000,
  });
  if (!statSync(backupPath).size) throw new Error("Logical backup is empty");
  execFileSync(pgTool("pg_restore"), ["--list", backupPath], {
    env: pgEnv,
    stdio: "pipe",
    timeout: 30_000,
  });
  execFileSync(path.join(repoRoot, "scripts", "with-test-db.sh"), [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      VISION_TEST_DB_TASK: "baseline-restore",
      VISION_BASELINE_RESTORE_STAGE: "preupgrade",
      VISION_BASELINE_BACKUP_PATH: backupPath,
      VISION_BASELINE_SOURCE_MANIFEST: manifestPath,
      TEST_DATABASE_URL: "",
    },
    stdio: "inherit",
    timeout: 10 * 60_000,
  });
  await assertStoppedWriters();
  const after = await readBaselineManifest({
    connectionString: readConnectionString,
    repoRoot,
  });
  if (JSON.stringify(after) !== JSON.stringify(source)) {
    throw new Error(
      "Source changed during backup verification; stop before upgrade",
    );
  }
  console.log(
    `[prebaseline-backup] Verified revision ${source.revision}; source unchanged.`,
  );
  console.log(
    `[prebaseline-backup] Retain the verified backup at ${backupPath}.`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
