/**
 * The Vision 2.0.0 -> SQLite transition, end to end (ADR-263).
 *
 *   1. hash the input; for an install, stop early when this backup was
 *      already installed, or refuse when another database is there;
 *   2. decrypt and extract the bundle into a private temporary directory;
 *   3. read db.sql (pass 1: inventory, ledger must be 0001-0005);
 *   4. create a new SQLite database with the backend's migrator;
 *   5. plan the mapping table by table, column by column;
 *   6. load every COPY block in one transaction;
 *   7. verify (pass 2 over db.sql, fresh read-only connection);
 *   8. only when every check passed: install, write a database file, or
 *      write a SQLite backup bundle; then write the report.
 *
 * PostgreSQL is never contacted and the input file is only read.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/database/connection.ts";
import { verifyDatabaseFile } from "../db-file.ts";
import {
  copyAttachments,
  crossCheckAttachments,
  customSqlAnalyses,
  planAttachmentCopies,
  rehashExtracted,
  verifyInstalledAttachments,
} from "./attachments.ts";
import type { AttachmentPlanEntry } from "./attachments.ts";
import {
  SQLITE_BUNDLE_VERSION,
  openV2Bundle,
  readBackSqliteBundle,
  writeSqliteBundle,
} from "./bundle.ts";
import type { OpenedV2Bundle, SqliteBundleMetadata } from "./bundle.ts";
import { scanDump } from "./dump.ts";
import { TransitionError, describeError } from "./errors.ts";
import type { ExitCode } from "./errors.ts";
import { makePrivateDirectory, pathExists, sha256File, syncDirectory, copyNewFile } from "./files.ts";
import { installDatabase, installPaths, preflight } from "./install.ts";
import { loadDump } from "./load.ts";
import { buildPlan, checkLedger } from "./plan.ts";
import { emptyReport, notVerifiableStatement, reportFileName, summary, writeReport } from "./report.ts";
import type { RunMode, TransitionReport } from "./report.ts";
import { createTargetDatabase, readTargetSchema } from "./schema.ts";
import type { SqlValueChecks } from "./typeMapping.ts";
import { verifyDatabase } from "./verify.ts";
import { errorText } from "./util.ts";

export interface RunOptions {
  input: string;
  mode: RunMode;
  /** Vision's data folder (install mode). */
  userData: string;
  /** --to-backup destination. */
  toBackup?: string | undefined;
  /** --output destination (database file). */
  output?: string | undefined;
  /** --report destination; default depends on the mode. */
  report?: string | undefined;
  passphrase: () => Promise<string>;
  /** Lines for stdout. */
  print: (line: string) => void;
  /** Progress lines (stderr). */
  progress: (line: string) => void;
  toolVersion: string;
  /** Parent of the private work directory (default os.tmpdir()). */
  tempRoot?: string | undefined;
  /** Called with the work directory so a signal handler can remove it. */
  onWorkDir?: ((dir: string | null) => void) | undefined;
}

export interface RunResult {
  exitCode: ExitCode;
  report: TransitionReport | null;
  reportPath: string | null;
  alreadyTransitioned: boolean;
}

/** The SQL value checks, through the functions every Vision connection registers. */
function sqlChecks(db: DatabaseSync): SqlValueChecks {
  const numeric = db.prepare("SELECT vision_numeric(?, ?, ?) AS v");
  const jsonb = db.prepare("SELECT vision_jsonb(?) AS v");
  const valid = db.prepare("SELECT json_valid(?) AS v");
  return {
    visionNumeric: (text, precision, scale) => {
      const row = numeric.get(text, precision, scale) as { v: string | number | bigint | null };
      return typeof row.v === "string" || row.v === null ? row.v : String(row.v);
    },
    visionJsonb: (text) => {
      const row = jsonb.get(text) as { v: string | number | bigint | null };
      return typeof row.v === "string" || row.v === null ? row.v : String(row.v);
    },
    jsonValid: (text) => {
      const row = valid.get(text) as { v: unknown };
      return Number(row.v) === 1;
    },
  };
}

function elapsed(since: bigint): number {
  return Number((process.hrtime.bigint() - since) / 1_000_000n);
}

async function assertNoWal(file: string): Promise<void> {
  for (const suffix of ["-wal", "-journal"]) {
    const side = `${file}${suffix}`;
    if (await pathExists(side)) {
      const { size } = await fs.promises.stat(side);
      if (size > 0) throw new TransitionError(`${side} still holds data after the database was closed.`);
      await fs.promises.rm(side, { force: true });
    }
  }
  await fs.promises.rm(`${file}-shm`, { force: true });
}

/** Write `source` to a new file `destination`: temp name, fsync, SHA-256 check, link. */
async function writeDatabaseFile(source: string, destination: string, sha256: string): Promise<void> {
  if (await pathExists(destination)) {
    throw new TransitionError(`${destination} already exists; the transition never overwrites a file.`, {
      hint: "Choose a new file name for --output.",
    });
  }
  const dir = path.dirname(path.resolve(destination));
  await makePrivateDirectory(dir);
  const temp = path.join(dir, `.${path.basename(destination)}.transition-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const sha = await copyNewFile(source, temp);
    if (sha !== sha256) throw new TransitionError(`The database copy has SHA-256 ${sha}, not ${sha256}.`);
    await fs.promises.link(temp, destination);
  } finally {
    await fs.promises.rm(temp, { force: true });
  }
  await syncDirectory(dir);
}

function defaultReportPath(options: RunOptions, at: Date, failed: boolean): string {
  const name = reportFileName(at);
  if (!failed) {
    if (options.mode === "install") return path.join(installPaths(options.userData).databaseDir, name);
    if (options.mode === "to-backup" && options.toBackup !== undefined) return path.join(path.dirname(path.resolve(options.toBackup)), name);
    if (options.mode === "output" && options.output !== undefined) return path.join(path.dirname(path.resolve(options.output)), name);
  }
  return path.join(os.tmpdir(), name);
}

export async function runTransition(options: RunOptions): Promise<RunResult> {
  const started = new Date();
  const t0 = process.hrtime.bigint();
  const input = path.resolve(options.input);
  const report = emptyReport(options.toolVersion, options.mode, started, input);
  const timings = report.timingsMs;
  let workDir: string | null = null;
  // Assigned inside callbacks, so kept in an object TypeScript does not narrow.
  const written: { path: string | null; byInstall: boolean; linked: string | null } = {
    path: null,
    byInstall: false,
    linked: null,
  };
  let stage = "start";
  try {
    // 1. The input, and the early exits of an install.
    const stat = await fs.promises.stat(input).catch(() => null);
    if (stat === null || !stat.isFile()) {
      throw new TransitionError(`${options.input} is not a file.`, { hint: "Pass the path of the .visionbak or .visionbak.enc backup." });
    }
    let t = process.hrtime.bigint();
    const inputSha = await sha256File(input);
    report.input = { file: input, bytes: stat.size, sha256: inputSha, encrypted: null, unchangedAfterRun: null };
    timings.hashInput = elapsed(t);
    options.progress(`Input ${input} (${stat.size.toLocaleString("en-US")} bytes), SHA-256 ${inputSha}`);
    if (options.mode === "install") {
      const paths = installPaths(options.userData);
      if (!(await pathExists(paths.userData))) {
        throw new TransitionError(`Vision's data folder ${paths.userData} does not exist.`, {
          hint: "Pass --user-data <folder> with the folder Vision uses (on macOS ~/Library/Application Support/Vision).",
        });
      }
      const pre = await preflight(paths, inputSha);
      if (pre.kind === "already") {
        options.print(`Vision is already transitioned from this backup (${input}).`);
        options.print(`  database    ${paths.databaseFile}`);
        options.print(`  installed   ${pre.record.installedAt}`);
        options.print(`  report      ${pre.record.report.file}`);
        options.print(
          pre.databaseUnchanged
            ? "  The database is unchanged since the transition."
            : "  Vision has used the database since (its contents changed); that is expected.",
        );
        options.print("Nothing was changed.");
        return { exitCode: 0, report: null, reportPath: pre.record.report.file, alreadyTransitioned: true };
      }
      if (await pathExists(paths.legacyPostgresData)) {
        report.warnings.push(`Vision 2.0's PostgreSQL data in ${paths.legacyPostgresData} was found and left untouched.`);
      }
    }

    // 2. Decrypt and extract.
    stage = "open bundle";
    workDir = await fs.promises.mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "vision-transition-"));
    await fs.promises.chmod(workDir, 0o700);
    options.onWorkDir?.(workDir);
    t = process.hrtime.bigint();
    options.progress("Opening the backup ...");
    const opened: OpenedV2Bundle = await openV2Bundle(input, workDir, options.passphrase);
    timings.openBundle = elapsed(t);
    report.input.encrypted = opened.encrypted;
    report.warnings.push(...opened.warnings);
    report.bundle.metadata = opened.metadata.raw;
    report.bundle.dumpSha256 = opened.dumpSha256;
    report.bundle.dumpBytes = opened.dumpBytes;
    report.bundle.frontendStateKeys = opened.frontendStateKeys;
    report.attachments.files = opened.attachments.length;
    report.attachments.bytes = opened.attachments.reduce((n, a) => n + a.bytes, 0);
    report.attachments.sha256 = Object.fromEntries(opened.attachments.map((a) => [a.relativePath, a.sha256]));

    // 3. Pass 1 over db.sql.
    stage = "read db.sql";
    t = process.hrtime.bigint();
    options.progress("Reading db.sql ...");
    const inventory = await scanDump(opened.dumpPath);
    timings.scanDump = elapsed(t);
    report.bundle.postgresVersion = inventory.serverVersion;
    report.bundle.pgDumpVersion = inventory.pgDumpVersion ?? null;
    report.bundle.migrationLedger = inventory.ledger;
    checkLedger(inventory.ledger);
    if (opened.metadata.schemaHead !== inventory.ledger.at(-1)) {
      throw new TransitionError(
        `metadata.json says schema ${opened.metadata.schemaHead}, but the dump's ledger ends at ${String(inventory.ledger.at(-1))}.`,
        { hint: "The bundle's parts do not belong together. Use the backup exactly as Vision 2.0 wrote it." },
      );
    }

    // 4./5. New database and plan.
    stage = "create database";
    const databasePath = path.join(workDir, "vision.sqlite3");
    t = process.hrtime.bigint();
    const db = createTargetDatabase(databasePath);
    let plan;
    let load;
    try {
      const target = readTargetSchema(db);
      report.environment.sqliteVersion = target.sqliteVersion;
      report.target.schemaVersion = target.schemaVersion;
      report.target.migrations = target.migrations.map((m) => m.name);
      stage = "plan";
      plan = buildPlan(inventory, target, sqlChecks(db));
      report.skippedDumpTables = plan.skippedDumpTables;
      report.droppedGeneratedColumns = plan.droppedGeneratedColumns;
      report.tablesNotFromDump = plan.targetOnlyTables;
      // 6. Load.
      stage = "load";
      options.progress(`Converting ${plan.tables.length} tables ...`);
      load = await loadDump(db, opened.dumpPath, plan, target, options.progress);
      report.warnings.push(...load.warnings);
      // Compact away the pages the migrations' reference rows and the load
      // left free; verification below reads the compacted file.
      db.exec("VACUUM");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    await assertNoWal(databasePath);
    timings.load = elapsed(t);

    // 7. Verify.
    stage = "verify";
    t = process.hrtime.bigint();
    options.progress("Verifying ...");
    const verification = await verifyDatabase({
      databasePath,
      dumpPath: opened.dumpPath,
      plan,
      load,
      progress: options.progress,
    });
    await assertNoWal(databasePath);
    report.checks.push(...verification.checks);
    report.failures.push(...verification.failures);
    report.decimalTotals = verification.decimalTotals;
    report.sequences = verification.sequences;
    report.target.schemaFingerprint = verification.schemaFingerprint.database;
    report.tables = verification.tables.map((tv) => {
      const loaded = load.tables.get(tv.table);
      const tablePlan = plan.tables.find((p) => p.name === tv.table);
      return {
        ...tv,
        columns: tablePlan?.columns.length ?? 0,
        replacedReferenceRows: loaded?.replacedReferenceRows ?? 0,
        notes: Object.fromEntries(Object.entries(loaded?.notes ?? {})),
      };
    });
    report.totals = {
      tables: verification.tables.length,
      rows: verification.tables.reduce((n, tv) => n + tv.rows.dump, 0),
      values: verification.tables.reduce((n, tv) => n + tv.roundTripValues, 0),
    };
    for (const tv of report.tables) {
      if ((tv.notes["bpchar-padding-removed"] ?? 0) > 0) {
        report.warnings.push(`${tv.table}: ${tv.notes["bpchar-padding-removed"]} char(n) value(s) stored without their space padding, as the SQLite dialect specifies.`);
      }
      if ((tv.notes["negative-zero-real"] ?? 0) > 0) {
        report.warnings.push(`${tv.table}: ${tv.notes["negative-zero-real"]} REAL value(s) of -0 stored as 0.`);
      }
    }
    const inspect = openDatabase(databasePath, "inspect");
    try {
      const cross = crossCheckAttachments(inspect, opened.attachments);
      report.attachments.rows = cross.rows;
      report.warnings.push(...cross.warnings);
      report.customSqlAnalyses = customSqlAnalyses(inspect);
    } finally {
      inspect.close();
    }
    await assertNoWal(databasePath);
    const rehash = await rehashExtracted(opened.attachments);
    report.checks.push({
      name: "attachments",
      ok: rehash.length === 0,
      detail: `${opened.attachments.length} files, SHA-256 of each recorded from the archive and re-checked`,
    });
    for (const problem of rehash) report.failures.push({ check: "attachments", message: problem });
    report.target.databaseSha256 = await sha256File(databasePath);
    report.target.databaseBytes = (await fs.promises.stat(databasePath)).size;
    timings.verify = elapsed(t);
    const verifiedSha = report.target.databaseSha256;
    if (report.failures.length > 0 || report.checks.some((c) => !c.ok)) {
      throw new TransitionError(`Verification failed (${report.failures.length} problem(s)); nothing was installed.`, {
        hint: "Read the failures below and in the report. Do not edit the backup; report the failures.",
      });
    }

    const inputAfter = await sha256File(input);
    report.input.unchangedAfterRun = inputAfter === inputSha;
    if (inputAfter !== inputSha) {
      throw new TransitionError("The input backup changed while the transition ran; nothing was installed.", {
        hint: "Make sure nothing writes to the backup file (sync tools, Vision) and run again.",
      });
    }

    // 8. Output.
    stage = "output";
    t = process.hrtime.bigint();
    report.notVerifiable = notVerifiableStatement(report);
    if (options.mode === "dry-run") {
      report.status = "verified";
    } else if (options.mode === "output") {
      const destination = path.resolve(options.output ?? "");
      await writeDatabaseFile(databasePath, destination, verifiedSha);
      report.output.database = destination;
      report.status = "database-written";
    } else if (options.mode === "to-backup") {
      await writeBackup(options, opened, databasePath, verifiedSha, report, workDir);
      report.status = "backup-written";
    } else {
      const paths = installPaths(options.userData);
      const attachmentPlan: AttachmentPlanEntry[] = await planAttachmentCopies(opened.attachments, paths.attachmentsDir);
      await installDatabase({
        paths,
        inputPath: input,
        inputBytes: stat.size,
        inputSha256: inputSha,
        verifiedDatabase: databasePath,
        verifiedSha256: verifiedSha,
        schemaVersion: verification.schemaVersion,
        toolVersion: options.toolVersion,
        copyAttachments: async () => {
          for (const dir of opened.attachmentDirectories) {
            await makePrivateDirectory(path.join(paths.attachmentsDir, ...dir.split("/")));
          }
          const copied = await copyAttachments(attachmentPlan, paths.attachmentsDir);
          const problems = await verifyInstalledAttachments(attachmentPlan);
          if (problems.length > 0) {
            throw new TransitionError(`Copied attachments do not match the backup: ${problems.slice(0, 5).join("; ")}`, {
              hint: "The disk may be failing or full. The database was not installed.",
            });
          }
          report.attachments.copied = copied;
          report.attachments.alreadyPresent = attachmentPlan.filter((e) => e.present).length;
          report.attachments.destination = paths.attachmentsDir;
          report.checks.push({
            name: "attachments installed",
            ok: true,
            detail: `${copied} copied, ${attachmentPlan.length - copied} already present with the same SHA-256, all re-hashed`,
          });
        },
        writeReport: async (facts) => {
          report.status = "installed";
          report.output.database = facts.database;
          report.output.record = facts.record;
          report.output.transitionSource = facts.transitionSource;
          timings.output = elapsed(t);
          timings.total = elapsed(t0);
          report.finishedAt = new Date().toISOString();
          const target = options.report ?? defaultReportPath(options, started, false);
          const file = await writeReport(target, report);
          written.path = file.file;
          written.byInstall = true;
          return file;
        },
        onLinked: () => {
          written.linked = paths.databaseFile;
        },
      });
    }
    if (!written.byInstall) {
      timings.output = elapsed(t);
      timings.total = elapsed(t0);
      report.finishedAt = new Date().toISOString();
      written.path = (await writeReport(options.report ?? defaultReportPath(options, started, false), report)).file;
    }
    for (const line of summary(report, written.path)) options.print(line);
    return { exitCode: 0, report, reportPath: written.path, alreadyTransitioned: false };
  } catch (err) {
    const exitCode: ExitCode = err instanceof TransitionError ? err.exitCode : 1;
    report.status = "failed";
    report.error = `${stage}: ${err instanceof Error ? err.message : String(err)}`;
    if (exitCode === 2) {
      options.print(describeError(err));
      return { exitCode, report: null, reportPath: null, alreadyTransitioned: false };
    }
    timings.total = elapsed(t0);
    report.finishedAt = new Date().toISOString();
    if (written.byInstall && written.path !== null && written.linked === null) {
      // The install failed after its report was written: replace it with the failure.
      await fs.promises.rm(written.path, { force: true });
      written.path = null;
    }
    try {
      const target =
        written.linked !== null || options.report === undefined ? defaultReportPath(options, started, true) : options.report;
      written.path = (await writeReport(target, report)).file;
    } catch (writeErr) {
      options.print(`(The report could not be written: ${errorText(writeErr)})`);
    }
    if (report.failures.length > 0) for (const line of summary(report, written.path)) options.print(line);
    options.print("");
    options.print(`Error (${stage}): ${describeError(err)}`);
    if (report.failures.length === 0) options.print(`Report: ${written.path ?? "(not written)"}`);
    options.print(
      written.linked !== null
        ? `The database WAS installed at ${written.linked}, but the check after installing failed (see above). ` +
            "Do not start Vision; move that file aside and run the transition again."
        : "Nothing was installed. Your backup file was not modified.",
    );
    return { exitCode, report, reportPath: written.path, alreadyTransitioned: false };
  } finally {
    if (workDir !== null) await fs.promises.rm(workDir, { recursive: true, force: true });
    options.onWorkDir?.(null);
  }
}

async function writeBackup(
  options: RunOptions,
  opened: OpenedV2Bundle,
  databasePath: string,
  databaseSha: string,
  report: TransitionReport,
  workDir: string,
): Promise<void> {
  const destination = path.resolve(options.toBackup ?? "");
  const passphrase = opened.encrypted ? await options.passphrase() : null;
  const version = report.environment.sqliteVersion ?? "";
  const metadata: SqliteBundleMetadata = {
    bundleVersion: SQLITE_BUNDLE_VERSION,
    database: "sqlite",
    schemaVersion: report.target.schemaVersion ?? 0,
    sqliteVersion: version,
    databaseSha256: databaseSha,
    databaseBytes: report.target.databaseBytes ?? 0,
    appVersion: options.toolVersion,
    deviceId: opened.metadata.deviceId,
    createdAt: new Date().toISOString(),
    encrypted: false,
  };
  await writeSqliteBundle({
    destination,
    workDir,
    databasePath,
    metadata,
    attachmentsDir: opened.attachments.length > 0 || opened.attachmentDirectories.length > 0 ? path.join(workDir, "attachments") : null,
    attachmentDirectories: opened.attachmentDirectories,
    attachments: opened.attachments,
    frontendState: opened.frontendState,
    passphrase,
  });
  // Read it back the way a restore would.
  const readDir = path.join(workDir, "readback");
  await fs.promises.mkdir(readDir, { mode: 0o700 });
  const back = await readBackSqliteBundle(destination, readDir, passphrase);
  const problems: string[] = [];
  if (back.databaseSha256 !== databaseSha) problems.push("db.sqlite3 differs from the verified database");
  if (back.metadata.databaseSha256 !== databaseSha) problems.push("metadata.databaseSha256 is wrong");
  if (back.metadata.bundleVersion !== SQLITE_BUNDLE_VERSION || back.metadata.database !== "sqlite") {
    problems.push("metadata does not declare a SQLite bundle");
  }
  for (const a of opened.attachments) {
    if (back.attachments.get(a.relativePath) !== a.sha256) problems.push(`attachment ${a.relativePath} differs`);
  }
  const files = [...back.attachments.keys()].filter((k) => !k.endsWith("/"));
  if (files.length !== opened.attachments.length) problems.push("the attachment count differs");
  const app = await verifyDatabaseFile(back.databasePath).catch((err: unknown) => ({ ok: false, error: errorText(err) }));
  if (!app.ok) problems.push(`Vision's restore verifier refuses db.sqlite3: ${"error" in app ? app.error : ""}`);
  report.checks.push({
    name: "backup bundle read back",
    ok: problems.length === 0,
    detail: problems.length === 0 ? "decrypted, extracted and verified as a restore would" : problems.join("; "),
  });
  if (problems.length > 0) {
    await fs.promises.rm(destination, { force: true });
    throw new TransitionError(`The written backup failed its read-back check: ${problems.join("; ")}. It was deleted.`);
  }
  report.output.backup = destination;
  report.output.backupSha256 = await sha256File(destination);
  report.output.backupEncrypted = passphrase !== null;
  report.output.backupFormat = SQLITE_BUNDLE_VERSION;
}
