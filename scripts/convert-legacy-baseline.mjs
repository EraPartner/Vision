#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
import pg from "../apps/node-backend/node_modules/pg/lib/index.js";
import { readBaselineManifest } from "../apps/node-backend/src/database/baselineManifest.js";
import { installFreshBaseline } from "../apps/node-backend/src/database/freshBaseline.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const argv = process.argv.slice(2);
if (
  argv.length !== 7 ||
  argv[0] !== "--backup" ||
  argv[2] !== "--archive" ||
  argv[4] !== "--writers-stopped" ||
  argv[5] !== "--maintenance-approved" ||
  argv[6] !== "--utc-timestamps"
) {
  throw new Error(
    "Usage: convert-legacy-baseline.mjs --backup /absolute/new.dump --archive /absolute/new.dump --writers-stopped --maintenance-approved --utc-timestamps",
  );
}
const backupPath = argv[1];
const archivePath = argv[3];
const journalPath = `${backupPath}.conversion-journal.json`;
if (existsSync(journalPath))
  throw new Error("Conversion journal already exists");
for (const file of [backupPath, archivePath]) {
  if (!path.isAbsolute(file) || existsSync(file))
    throw new Error("Backup and archive paths must be new absolute paths");
  const parent = statSync(path.dirname(file));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0)
    throw new Error("Backup and archive parent directories must be owner-only");
}
if (backupPath === archivePath)
  throw new Error("Backup and archive paths differ");

const ownerUrl = new URL(process.env.DATABASE_URL_MIGRATIONS || "");
const appUrl = new URL(process.env.DATABASE_URL || "");
const database = decodeURIComponent(ownerUrl.pathname.slice(1));
if (
  !["postgres:", "postgresql:"].includes(ownerUrl.protocol) ||
  ownerUrl.hostname !== "127.0.0.1" ||
  appUrl.hostname !== ownerUrl.hostname ||
  appUrl.port !== ownerUrl.port ||
  decodeURIComponent(appUrl.pathname.slice(1)) !== database ||
  !/^[a-z_][a-z0-9_]{0,40}$/.test(database) ||
  !ownerUrl.username
) {
  throw new Error(
    "Conversion requires matching explicit local Vision database URLs",
  );
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
const ownerRole = decodeURIComponent(ownerUrl.username);
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(ownerRole))
  throw new Error("Invalid migration owner role");
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const withDatabase = (url, name) => {
  const result = new URL(url);
  result.pathname = `/${name}`;
  return result.toString();
};
const sourceUrl = adminUrl.toString();
const nonce = randomBytes(5).toString("hex");
const targetName = `${database}_baseline_${nonce}`;
const archiveName = `${database}_archive_check_${nonce}`;
const rollbackName = `${database}_before_0119_${nonce}`;
for (const name of [targetName, archiveName, rollbackName]) {
  if (name.length > 63)
    throw new Error("Database name exceeds PostgreSQL limit");
}
const targetAdminUrl = withDatabase(adminUrl, targetName);
const targetOwnerUrl = withDatabase(ownerUrl, targetName);
const targetAppUrl = withDatabase(appUrl, targetName);
const expectedLegacyRestore =
  "8c4b5fc45fd472b1cd54ec0f64b8cd231324ff9392412df0a366f1404def3de6";
const expectedFreshSchema =
  "8508bf6f1c047ff28ea0eaa3e0381580c7c4e5ea94d5f772b0e4e5a2bd6cbc10";
const utcColumns = {
  "public.categories": ["created_at", "updated_at"],
  "public.exchange_rates": ["fetched_at", "updated_at"],
  "public.planned_transaction_executions": ["created_at"],
  "public.planned_transactions": ["created_at", "updated_at"],
  "public.recipient_bank_accounts": ["created_at", "updated_at"],
  "public.recipients": ["created_at", "updated_at"],
  "public.transactions": ["created_at", "updated_at"],
  "vision_analysis.cash_flows_v1": ["updated_at"],
  "vision_analysis.cash_flows_v2": ["updated_at"],
  "vision_analysis.transactions_v1": ["created_at", "updated_at"],
  "vision_analysis.transactions_v2": ["created_at", "updated_at"],
};

function pgTool(name) {
  for (const directory of [
    process.env.VISION_POSTGRES_BIN,
    process.env.VISION_TEST_POSTGRES_BIN,
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/local/opt/postgresql@18/bin",
  ]) {
    if (directory && existsSync(path.join(directory, name)))
      return path.join(directory, name);
  }
  return name;
}

function toolEnv(url, extra = {}) {
  const parsed = new URL(url);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    ...extra,
  };
}

function runTool(name, args, url, extraEnv = {}) {
  try {
    return execFileSync(pgTool(name), args, {
      cwd: repoRoot,
      env: toolEnv(url, extraEnv),
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10 * 60_000,
    });
  } catch (error) {
    throw new Error(
      `${name} failed (${error.status ?? error.signal ?? "unknown"})`,
    );
  }
}

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

async function assertStoppedWriters() {
  await connected(catalogUrl.toString(), async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS clients FROM pg_stat_activity
       WHERE datname = $1 AND backend_type = 'client backend'`,
      [database],
    );
    if (result.rows[0].clients !== 0)
      throw new Error("Other database clients remain connected");
  });
}

async function readTableDigest(url, table) {
  return connected(url, async (client) => {
    await client.query("SET TIME ZONE 'UTC'");
    const result = await client.query(`
      SELECT count(*)::text AS rows,
             encode(public.digest(convert_to(
               coalesce(string_agg(row_hash, '' ORDER BY row_hash), ''),
               'UTF8'), 'sha256'), 'hex') AS digest
      FROM (SELECT encode(public.digest(convert_to(to_jsonb(item)::text, 'UTF8'),
                          'sha256'), 'hex') AS row_hash
            FROM public.${quote(table)} AS item) AS hashed
    `);
    return result.rows[0];
  });
}

async function validateForeignKeys(url) {
  return connected(url, async (client) => {
    const { rows } = await client.query(`
      SELECT n.nspname, c.relname, k.conname,
             pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE k.contype = 'f' AND n.nspname IN ('public', 'vision_analysis')
      ORDER BY n.nspname, c.relname, k.conname
    `);
    await client.query("BEGIN");
    try {
      for (const row of rows) {
        await client.query(
          `ALTER TABLE ${quote(row.nspname)}.${quote(row.relname)} DROP CONSTRAINT ${quote(row.conname)}`,
        );
      }
      for (const row of rows) {
        await client.query(
          `ALTER TABLE ${quote(row.nspname)}.${quote(row.relname)} ADD CONSTRAINT ${quote(row.conname)} ${row.definition}`,
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(
        `Foreign key validation failed (${error.code || error.name})`,
      );
    }
    return rows.length;
  });
}

async function restoreSequenceState() {
  for (const [oldName, newName] of [
    ["investments_flat_id_seq", "investments_id_seq"],
    ["portfolio_transactions_flat_id_seq", "portfolio_transactions_id_seq"],
  ]) {
    const state = await connected(sourceUrl, async (client) => {
      const result = await client.query(
        `SELECT last_value, is_called FROM public.${quote(oldName)}`,
      );
      return result.rows[0];
    });
    await connected(targetAdminUrl, async (client) => {
      await client.query("SELECT pg_catalog.setval($1::regclass, $2, $3)", [
        `public.${newName}`,
        state.last_value,
        state.is_called,
      ]);
    });
  }
}

process.umask(0o077);
const workDir = mkdtempSync(path.join(os.tmpdir(), "vision-baseline-convert-"));
let targetCreated = false;
let archiveCreated = false;
let swapStarted = false;
try {
  const source = await readBaselineManifest({
    connectionString: sourceUrl,
    repoRoot,
  });
  if (
    source.revision !== "0118_audit_retention_pruner" ||
    source.restoreFingerprint !== expectedLegacyRestore ||
    source.tables.length !== 84 ||
    source.tables.find((item) => item.name === "adr109_legacy_archive")
      ?.rows !== "390"
  ) {
    throw new Error("Source is not the reviewed maintained 0118 legacy schema");
  }
  await assertStoppedWriters();
  const sourceHead = await connected(sourceUrl, async (client) => {
    const result = await client.query(
      "SELECT last_sequence, last_hash FROM public.audit_chain_head",
    );
    if (result.rows.length !== 1) throw new Error("Invalid source audit head");
    return result.rows[0];
  });

  runTool("pg_dump", ["-Fc", "-f", backupPath], sourceUrl);
  if (!statSync(backupPath).size) throw new Error("Full backup is empty");
  runTool("pg_restore", ["--list", backupPath], sourceUrl);
  const manifestPath = path.join(workDir, "source-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(source), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    execFileSync(path.join(repoRoot, "scripts", "with-test-db.sh"), [], {
      cwd: repoRoot,
      env: {
        ...process.env,
        VISION_TEST_DB_TASK: "baseline-restore",
        VISION_BASELINE_BACKUP_PATH: backupPath,
        VISION_BASELINE_SOURCE_MANIFEST: manifestPath,
        VISION_BASELINE_RESTORE_STAGE: "preupgrade",
        TEST_DATABASE_URL: "",
      },
      stdio: "pipe",
      timeout: 10 * 60_000,
    });
  } catch (error) {
    throw new Error(
      `Full backup restore check failed (${error.status ?? error.signal})`,
    );
  }

  runTool(
    "pg_dump",
    ["-Fc", "-t", "public.adr109_legacy_archive", "-f", archivePath],
    sourceUrl,
  );
  if (!statSync(archivePath).size) throw new Error("Archive export is empty");
  runTool(
    "createdb",
    ["--template", "template0", "--owner", ownerRole, archiveName],
    catalogUrl.toString(),
  );
  archiveCreated = true;
  await connected(withDatabase(adminUrl, archiveName), (client) =>
    client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto"),
  );
  runTool(
    "pg_restore",
    [
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      "-d",
      archiveName,
      archivePath,
    ],
    catalogUrl.toString(),
  );
  const oldArchive = source.tables.find(
    (item) => item.name === "adr109_legacy_archive",
  );
  const archiveCopy = await readTableDigest(
    withDatabase(adminUrl, archiveName),
    "adr109_legacy_archive",
  );
  if (
    archiveCopy.rows !== oldArchive.rows ||
    archiveCopy.digest !== oldArchive.digest
  )
    throw new Error("Archive restore has different rows");
  runTool("dropdb", [archiveName], catalogUrl.toString());
  archiveCreated = false;

  runTool(
    "createdb",
    ["--template", "template0", "--owner", ownerRole, targetName],
    catalogUrl.toString(),
  );
  targetCreated = true;
  await connected(targetAdminUrl, (client) =>
    client.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements"),
  );
  await installFreshBaseline({ repoRoot, connectionString: targetOwnerUrl });
  await connected(targetAdminUrl, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(
        "ALTER TABLE public.audit_chain_entries DISABLE TRIGGER USER",
      );
      await client.query(
        "ALTER TABLE public.audit_chain_head DISABLE TRIGGER USER",
      );
      await client.query(
        "TRUNCATE public.adr109_legacy_cleanup_marker, public.audit_chain_entries, public.audit_chain_head, public.insight_digest_state CASCADE",
      );
      await client.query(
        "ALTER TABLE public.audit_chain_entries ENABLE TRIGGER USER",
      );
      await client.query(
        "ALTER TABLE public.audit_chain_head ENABLE TRIGGER USER",
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });

  const dataPath = path.join(workDir, "data.dump");
  runTool(
    "pg_dump",
    [
      "-Fc",
      "--data-only",
      "--no-owner",
      "--no-acl",
      "-T",
      "public.adr109_legacy_archive",
      "-T",
      "public.schema_version",
      "-T",
      "public.alembic_version",
      "-f",
      dataPath,
    ],
    sourceUrl,
  );
  const toc = runTool("pg_restore", ["--list", dataPath], sourceUrl);
  const excludedSequences = [
    "investments_flat_id_seq",
    "portfolio_transactions_flat_id_seq",
    "schema_version_id_seq",
  ];
  const seen = new Set();
  const filtered = toc.split("\n").map((line) => {
    const name = excludedSequences.find((item) =>
      line.includes(`SEQUENCE SET public ${item} `),
    );
    if (name) {
      seen.add(name);
      return `;${line}`;
    }
    return line;
  });
  if (seen.size !== excludedSequences.length)
    throw new Error("Legacy sequence inventory changed");
  const tocPath = path.join(workDir, "data.toc");
  writeFileSync(tocPath, filtered.join("\n"), { flag: "wx", mode: 0o600 });
  runTool(
    "pg_restore",
    [
      "--exit-on-error",
      "--data-only",
      "--disable-triggers",
      "--no-owner",
      "-L",
      tocPath,
      "-d",
      targetName,
      dataPath,
    ],
    catalogUrl.toString(),
    { PGTZ: "UTC" },
  );
  await restoreSequenceState();
  const foreignKeys = await validateForeignKeys(targetAdminUrl);

  const normalizedSource = await readBaselineManifest({
    connectionString: sourceUrl,
    repoRoot,
    timestampUtcColumns: utcColumns,
  });
  const target = await readBaselineManifest({
    connectionString: targetAdminUrl,
    repoRoot,
  });
  const targetByName = new Map(
    target.tables.map((item) => [`${item.schema}.${item.name}`, item]),
  );
  const sourceDomain = normalizedSource.tables.filter(
    (item) =>
      !["alembic_version", "adr109_legacy_archive", "schema_version"].includes(
        item.name,
      ),
  );
  if (
    target.revision !== "0119_squashed_baseline" ||
    target.schemaFingerprint !== expectedFreshSchema ||
    target.tables.length !== 82 ||
    sourceDomain.length !== 81 ||
    sourceDomain.some((item) => {
      const other = targetByName.get(`${item.schema}.${item.name}`);
      return !other || other.rows !== item.rows || other.digest !== item.digest;
    })
  ) {
    throw new Error("Converted database differs from the source domain rows");
  }
  await connected(targetAdminUrl, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(
        "UPDATE public.alembic_version SET version_num = '0118_audit_retention_pruner' WHERE version_num = '0119_squashed_baseline'",
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
  try {
    execFileSync(
      "bun",
      ["run", "apps/node-backend/scripts/db-migrate.js", "upgrade", "head"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL: targetOwnerUrl,
          DATABASE_URL_MIGRATIONS: targetOwnerUrl,
          VISION_SKIP_CONFIG_ENV_LOCAL: "true",
          VISION_BASELINE_BRIDGE_APPROVED: "1",
          VISION_CACHE_DIR: path.join(workDir, "cache"),
        },
        stdio: "pipe",
        timeout: 10 * 60_000,
      },
    );
  } catch (error) {
    throw new Error(
      `0119 audit migration failed (${error.status ?? error.signal})`,
    );
  }
  process.env.DATABASE_URL = targetOwnerUrl;
  process.env.VISION_SKIP_CONFIG_ENV_LOCAL = "true";
  const [{ verifyAuditHistory }, { closePool }] = await Promise.all([
    import("../apps/node-backend/src/services/auditVerificationService.js"),
    import("../apps/node-backend/src/database/connection.js"),
  ]);
  try {
    const result = await verifyAuditHistory({
      trustedCheckpoint: {
        sequence: Number(sourceHead.last_sequence),
        hash: sourceHead.last_hash,
      },
    });
    if (!["verified", "partially_verified"].includes(result.status))
      throw new Error(
        `Converted audit history failed (${result.code || result.status})`,
      );
  } finally {
    await closePool();
  }
  const { ensureAppRole } =
    await import("../apps/node-backend/src/database/roleBootstrap.js");
  const grants = await ensureAppRole({
    databaseUrl: targetAppUrl,
    migrationsUrl: targetOwnerUrl,
    maxAttempts: 1,
  });
  if (["degraded", "error"].includes(grants.status) || grants.grantFailures)
    throw new Error("Converted database role grants failed");

  await connected(targetAppUrl, async (client) => {
    await client.query("BEGIN");
    try {
      const marker = `VISION_BASELINE_SMOKE_${nonce}`;
      const result = await client.query(
        "INSERT INTO public.categories (general, detail) VALUES ($1, 'TEMP') RETURNING id",
        [marker],
      );
      const readBack = await client.query(
        "SELECT path_name FROM public.categories WHERE id = $1",
        [result.rows[0]?.id],
      );
      if (readBack.rows[0]?.path_name !== `${marker}:TEMP`)
        throw new Error("Converted category write/read smoke failed");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  const finalSource = await readBaselineManifest({
    connectionString: sourceUrl,
    repoRoot,
  });
  if (JSON.stringify(finalSource) !== JSON.stringify(source))
    throw new Error("Source changed during conversion; source remains active");
  await assertStoppedWriters();
  const migratedTarget = await readBaselineManifest({
    connectionString: targetAdminUrl,
    repoRoot,
  });
  const targetDigest = createHash("sha256")
    .update(JSON.stringify(migratedTarget))
    .digest("hex");
  const journal = {
    version: 1,
    stage: "swap_pending",
    sourceDatabase: database,
    targetDatabase: targetName,
    rollbackDatabase: rollbackName,
    backupPath,
    archivePath,
    sourceDigest: createHash("sha256")
      .update(JSON.stringify(source))
      .digest("hex"),
    targetDigest,
    timestampPolicy: "UTC",
  };
  writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  swapStarted = true;
  await connected(catalogUrl.toString(), async (client) => {
    await client.query(
      `ALTER DATABASE ${quote(database)} RENAME TO ${quote(rollbackName)}`,
    );
    try {
      await client.query(
        `ALTER DATABASE ${quote(targetName)} RENAME TO ${quote(database)}`,
      );
    } catch (error) {
      await client.query(
        `ALTER DATABASE ${quote(rollbackName)} RENAME TO ${quote(database)}`,
      );
      throw error;
    }
  });
  targetCreated = false;
  const final = await readBaselineManifest({
    connectionString: sourceUrl,
    repoRoot,
  });
  if (
    final.revision !== "0119_squashed_baseline" ||
    final.schemaFingerprint !== expectedFreshSchema ||
    createHash("sha256").update(JSON.stringify(final)).digest("hex") !==
      targetDigest
  ) {
    throw new Error(
      "Post-swap baseline check failed; keep both databases and backups",
    );
  }
  writeFileSync(
    journalPath,
    `${JSON.stringify({ ...journal, stage: "complete" })}\n`,
    { mode: 0o600 },
  );
  console.log(
    `[baseline-convert] Converted ${sourceDomain.length} domain tables; validated ${foreignKeys} foreign keys and the audit chain.`,
  );
  console.log(`[baseline-convert] Full backup: ${backupPath}`);
  console.log(`[baseline-convert] Verified legacy archive: ${archivePath}`);
  console.log(
    `[baseline-convert] Previous database retained as ${rollbackName}.`,
  );
  console.log(`[baseline-convert] Recovery journal: ${journalPath}`);
} finally {
  if (archiveCreated) {
    try {
      runTool("dropdb", [archiveName], catalogUrl.toString());
    } catch {
      /* retain for review */
    }
  }
  if (targetCreated && !swapStarted) {
    try {
      runTool("dropdb", [targetName], catalogUrl.toString());
    } catch {
      /* retain for review */
    }
  }
  rmSync(workDir, { recursive: true, force: true });
}
