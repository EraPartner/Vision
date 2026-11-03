/**
 * Installing the verified database into Vision's data folder.
 *
 *   <userData>/database/vision.sqlite3                the database (never overwritten)
 *   <userData>/database/vision-transition.json        the transition record (see below)
 *   <userData>/database/transition-source/<sha12>-<name>   byte-for-byte copy of the input backup
 *   <userData>/database/transition-report-<time>.json the report (default location)
 *   <userData>/native/vision/attachments/...          attachments, where Vision 2.0 kept them
 *
 * The transition record is a sidecar JSON file rather than a table: the
 * database must keep exactly the schema of a fresh install (its schema
 * fingerprint is checked by the app's restore verifier), so it holds no
 * extra table. The record names the input backup's SHA-256 and the report's
 * checksum; a run with the same backup finds it and stops with "already
 * transitioned from this backup".
 *
 * The database is installed last: copied to a temporary name in the same
 * directory, fsynced, checked by SHA-256, then given its final name with
 * link(2), which fails rather than replaces an existing file.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TransitionError } from "./errors.ts";
import { copyNewFile, makePrivateDirectory, pathExists, sha256File, syncDirectory, writeNewFile } from "./files.ts";
import { isRecord } from "./util.ts";

export const RUNTIME_ID = "vision";
export const DATABASE_DIRECTORY = "database";
export const DATABASE_FILE = "vision.sqlite3";
export const TRANSITION_RECORD = "vision-transition.json";
export const TRANSITION_SOURCE_DIRECTORY = "transition-source";

export interface InstallPaths {
  userData: string;
  databaseDir: string;
  databaseFile: string;
  record: string;
  transitionSourceDir: string;
  attachmentsDir: string;
  legacyPostgresData: string;
}

export function defaultUserData(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Vision");
}

export function installPaths(userData: string): InstallPaths {
  const root = path.resolve(userData);
  const databaseDir = path.join(root, DATABASE_DIRECTORY);
  return {
    userData: root,
    databaseDir,
    databaseFile: path.join(databaseDir, DATABASE_FILE),
    record: path.join(databaseDir, TRANSITION_RECORD),
    transitionSourceDir: path.join(databaseDir, TRANSITION_SOURCE_DIRECTORY),
    attachmentsDir: path.join(root, "native", RUNTIME_ID, "attachments"),
    legacyPostgresData: path.join(root, "native", RUNTIME_ID, "postgres", "data"),
  };
}

export interface TransitionRecord {
  tool: "vision-v2-to-sqlite";
  recordVersion: 1;
  toolVersion: string;
  installedAt: string;
  input: { file: string; bytes: number; sha256: string };
  transitionSource: string;
  report: { file: string; sha256: string };
  database: { file: string; bytes: number; sha256: string; schemaVersion: number };
}

export async function readRecord(file: string): Promise<TransitionRecord | null> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.tool !== "vision-v2-to-sqlite" || !isRecord(parsed.input)) return null;
  if (typeof parsed.input.sha256 !== "string") return null;
  return parsed as unknown as TransitionRecord;
}

export type PreflightResult =
  | { kind: "fresh" }
  | { kind: "already"; record: TransitionRecord; databaseUnchanged: boolean };

const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"];

/**
 * Decide whether an install may proceed. Throws when a database exists that
 * this backup did not produce, or when leftovers of another database would
 * attach themselves to the new file.
 */
export async function preflight(paths: InstallPaths, inputSha256: string): Promise<PreflightResult> {
  if (await pathExists(paths.databaseFile)) {
    const record = await readRecord(paths.record);
    if (record?.input.sha256 === inputSha256) {
      const current = await sha256File(paths.databaseFile);
      return { kind: "already", record, databaseUnchanged: current === record.database.sha256 };
    }
    throw new TransitionError(
      `${paths.databaseFile} already exists${record ? " and was converted from a different backup" : ""}; ` +
        "the transition never overwrites a database.",
      {
        hint: record
          ? `It was converted from ${record.input.file} (SHA-256 ${record.input.sha256}). Use that backup, or ` +
            "restore the backup you want from Vision's Settings instead."
          : "Vision already has a SQLite database here. To replace it, restore a backup in Vision (Settings > Backups), " +
            "or convert to a bundle with --to-backup and restore that.",
      },
    );
  }
  for (const suffix of SQLITE_SIDECARS) {
    if (await pathExists(`${paths.databaseFile}${suffix}`)) {
      throw new TransitionError(
        `${paths.databaseFile}${suffix} exists without its database; SQLite would apply it to the new database.`,
        { hint: `Move ${paths.databaseFile}${suffix} out of ${paths.databaseDir} (keep it), then run again.` },
      );
    }
  }
  return { kind: "fresh" };
}

export interface InstallOptions {
  paths: InstallPaths;
  inputPath: string;
  inputBytes: number;
  inputSha256: string;
  /** The verified database (closed, no -wal file). */
  verifiedDatabase: string;
  verifiedSha256: string;
  schemaVersion: number;
  toolVersion: string;
  /** Copies the attachments (planned and conflict-checked by the caller). */
  copyAttachments: () => Promise<void>;
  /** Writes the report once the install facts are known; returns its path and SHA-256. */
  writeReport: (facts: InstalledFacts) => Promise<{ file: string; sha256: string }>;
  /** Called the moment the database has its final name. */
  onLinked?: () => void;
}

export interface InstalledFacts {
  database: string;
  record: string;
  transitionSource: string;
  attachmentsDir: string;
  installedAt: string;
}

export async function copyTransitionSource(paths: InstallPaths, inputPath: string, inputSha256: string): Promise<string> {
  await makePrivateDirectory(paths.transitionSourceDir);
  const destination = path.join(paths.transitionSourceDir, `${inputSha256.slice(0, 12)}-${path.basename(inputPath)}`);
  if (await pathExists(destination)) {
    const sha = await sha256File(destination);
    if (sha === inputSha256) return destination;
    throw new TransitionError(`${destination} exists and differs from the input backup; it was not overwritten.`, {
      hint: `Move ${destination} aside (keep it) and run again.`,
    });
  }
  const temp = path.join(paths.transitionSourceDir, `.transition-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const sha = await copyNewFile(inputPath, temp);
    if (sha !== inputSha256) {
      throw new TransitionError(`The copy of the input backup has SHA-256 ${sha}, not ${inputSha256}.`, {
        hint: "The input file changed while the transition ran, or the disk is failing. Nothing was installed.",
      });
    }
    await fs.promises.link(temp, destination);
  } finally {
    await fs.promises.rm(temp, { force: true });
  }
  await syncDirectory(paths.transitionSourceDir);
  return destination;
}

/** Install the verified database. Returns the facts the report records. */
export async function installDatabase(options: InstallOptions): Promise<InstalledFacts & { report: { file: string; sha256: string } }> {
  const { paths } = options;
  const again = await preflight(paths, options.inputSha256);
  if (again.kind !== "fresh") throw new TransitionError(`${paths.databaseFile} appeared while the transition ran.`);
  await makePrivateDirectory(paths.databaseDir);

  const transitionSource = await copyTransitionSource(paths, options.inputPath, options.inputSha256);
  await options.copyAttachments();

  const temp = path.join(paths.databaseDir, `.${DATABASE_FILE}.transition-${randomBytes(6).toString("hex")}.tmp`);
  let recordWritten = false;
  try {
    const sha = await copyNewFile(options.verifiedDatabase, temp);
    if (sha !== options.verifiedSha256) {
      throw new TransitionError(`The database copy has SHA-256 ${sha}, not the verified ${options.verifiedSha256}.`, {
        hint: "The disk may be failing or full. Nothing was installed.",
      });
    }
    const installedAt = new Date().toISOString();
    const facts: InstalledFacts = {
      database: paths.databaseFile,
      record: paths.record,
      transitionSource,
      attachmentsDir: paths.attachmentsDir,
      installedAt,
    };
    const report = await options.writeReport(facts);
    const record: TransitionRecord = {
      tool: "vision-v2-to-sqlite",
      recordVersion: 1,
      toolVersion: options.toolVersion,
      installedAt,
      input: { file: path.resolve(options.inputPath), bytes: options.inputBytes, sha256: options.inputSha256 },
      transitionSource,
      report,
      database: {
        file: paths.databaseFile,
        bytes: (await fs.promises.stat(temp)).size,
        sha256: options.verifiedSha256,
        schemaVersion: options.schemaVersion,
      },
    };
    // The record goes first: a crash before the link leaves a record without
    // a database, which the next run replaces.
    const recordTemp = `${paths.record}.${randomBytes(6).toString("hex")}.tmp`;
    await writeNewFile(recordTemp, `${JSON.stringify(record, null, 2)}\n`);
    await fs.promises.rename(recordTemp, paths.record);
    recordWritten = true;
    try {
      await fs.promises.link(temp, paths.databaseFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new TransitionError(`${paths.databaseFile} appeared while the transition ran; it was not overwritten.`, {
          hint: "Quit Vision and run the transition again.",
        });
      }
      throw err;
    }
    recordWritten = false;
    options.onLinked?.();
    await syncDirectory(paths.databaseDir);
    const installedSha = await sha256File(paths.databaseFile);
    if (installedSha !== options.verifiedSha256) {
      throw new TransitionError(`The installed database has SHA-256 ${installedSha}, not ${options.verifiedSha256}.`, {
        hint: `Quit Vision, move ${paths.databaseFile} aside, check the disk, and run again.`,
      });
    }
    return { ...facts, report };
  } finally {
    await fs.promises.rm(temp, { force: true });
    if (recordWritten) await fs.promises.rm(paths.record, { force: true });
  }
}
