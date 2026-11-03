/**
 * Opening a Vision 2.0 backup bundle and writing its SQLite counterpart.
 *
 * A 2.0 `.visionbak` (format 1, packaging/electron/backup/bundle.ts at
 * 2.0.0) is a zip of
 *   metadata.json        { bundleVersion: 1, schemaHead, appVersion, deviceId, createdAt, encrypted }
 *   db.sql               pg_dump plain SQL
 *   attachments/...      the attachments directory tree (optional)
 *   frontend-state.json  { keys: { ... } } (optional)
 * optionally encrypted as `.visionbak.enc` (see crypto.ts).
 *
 * The bundle is untrusted input: anything else in the archive stops the
 * run, and every member is extracted into a private directory with its size
 * and CRC-32 checked and its SHA-256 recorded.
 *
 * The SQLite bundle (format 2, written by `--to-backup`) has the same layout
 * with db.sqlite3 in place of db.sql and the metadata the desktop app's
 * restore reads (bundleVersion 2, database "sqlite", schemaVersion,
 * sqliteVersion, databaseSha256, databaseBytes).
 */
import fs from "node:fs";
import path from "node:path";
import { TransitionError } from "./errors.ts";
import { decryptBundle, detectInputKind, encryptBundle } from "./crypto.ts";
import {
  MAX_TOTAL_BYTES,
  createZipWriter,
  extractEntryToFile,
  readEntry,
  readZipEntries,
} from "./zip.ts";
import type { ZipEntry } from "./zip.ts";

export const METADATA_MEMBER = "metadata.json";
export const DUMP_MEMBER = "db.sql";
export const SQLITE_MEMBER = "db.sqlite3";
export const FRONTEND_STATE_MEMBER = "frontend-state.json";
export const ATTACHMENTS_PREFIX = "attachments/";

/** Format of a Vision 2.0 bundle (metadata.bundleVersion). */
export const V2_BUNDLE_VERSION = 1;
/** Format of a SQLite bundle, as packaging/electron/backup/bundle.ts defines it. */
export const SQLITE_BUNDLE_VERSION = 2;

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_FRONTEND_STATE_BYTES = 64 * 1024 * 1024;

export interface V2Metadata {
  bundleVersion: number;
  schemaHead: string;
  appVersion: string;
  deviceId: string;
  createdAt: string;
  /** The parsed object as it was, for the report. */
  raw: Readonly<Record<string, unknown>>;
}

export interface BundleAttachment {
  /** Path below attachments/, with `/` separators, as stored in the archive. */
  relativePath: string;
  extractedPath: string;
  bytes: number;
  sha256: string;
}

export interface OpenedV2Bundle {
  encrypted: boolean;
  /** The zip itself: the input, or its decrypted copy in the work directory. */
  zipPath: string;
  metadata: V2Metadata;
  dumpPath: string;
  dumpBytes: number;
  dumpSha256: string;
  /** frontend-state.json exactly as stored, or null when the bundle has none. */
  frontendStateBytes: Buffer | null;
  /** Its parsed value, as Vision's restore reads it (null when absent or not JSON). */
  frontendState: unknown;
  frontendStateKeys: number | null;
  attachments: BundleAttachment[];
  /** Directories below attachments/ that the archive lists (some may be empty). */
  attachmentDirectories: string[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bundleError(message: string, hint?: string): TransitionError {
  return new TransitionError(message, {
    hint: hint ?? "Use the .visionbak or .visionbak.enc file exactly as Vision 2.0 wrote it.",
  });
}

function parseMetadata(bytes: Buffer): V2Metadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw bundleError("metadata.json in the backup is not valid JSON.");
  }
  if (!isRecord(parsed)) throw bundleError("metadata.json in the backup is not a JSON object.");
  const version = parsed.bundleVersion;
  if (version === SQLITE_BUNDLE_VERSION || parsed.database === "sqlite") {
    throw new TransitionError("This backup is already a SQLite (Vision 2.1+) bundle; it needs no transition.", {
      hint: "Restore it in Vision directly (Settings > Backups > Restore).",
    });
  }
  if (version !== V2_BUNDLE_VERSION) {
    throw bundleError(`metadata.json has bundleVersion ${JSON.stringify(version)}; a Vision 2.0 backup has 1.`);
  }
  const text = (key: string): string => {
    const value = parsed[key];
    if (typeof value !== "string") throw bundleError(`metadata.json has no ${key} string.`);
    return value;
  };
  return {
    bundleVersion: V2_BUNDLE_VERSION,
    schemaHead: text("schemaHead"),
    appVersion: text("appVersion"),
    deviceId: text("deviceId"),
    createdAt: text("createdAt"),
    raw: parsed,
  };
}

type Member =
  | { kind: "metadata" | "dump" | "frontend-state"; entry: ZipEntry }
  | { kind: "attachment-dir"; entry: ZipEntry; relativePath: string }
  | { kind: "attachment"; entry: ZipEntry; relativePath: string };

function classify(entry: ZipEntry): Member {
  if (!entry.isDirectory) {
    if (entry.name === METADATA_MEMBER) return { kind: "metadata", entry };
    if (entry.name === DUMP_MEMBER) return { kind: "dump", entry };
    if (entry.name === FRONTEND_STATE_MEMBER) return { kind: "frontend-state", entry };
  }
  if (entry.name === ATTACHMENTS_PREFIX && entry.isDirectory) {
    return { kind: "attachment-dir", entry, relativePath: "" };
  }
  if (entry.name.startsWith(ATTACHMENTS_PREFIX)) {
    const relativePath = entry.name.slice(ATTACHMENTS_PREFIX.length).replace(/\/$/, "");
    return entry.isDirectory
      ? { kind: "attachment-dir", entry, relativePath }
      : { kind: "attachment", entry, relativePath };
  }
  if (entry.name === SQLITE_MEMBER) {
    throw new TransitionError("This backup holds a SQLite database (db.sqlite3); it needs no transition.", {
      hint: "Restore it in Vision directly (Settings > Backups > Restore).",
    });
  }
  throw bundleError(`The backup contains ${JSON.stringify(entry.name)}, which a Vision 2.0 bundle never holds.`);
}

/**
 * Decrypt (when needed), check and extract a Vision 2.0 bundle into
 * `workDir`, which must exist, be private and be empty.
 */
export async function openV2Bundle(
  input: string,
  workDir: string,
  passphrase: () => Promise<string>,
): Promise<OpenedV2Bundle> {
  const kind = await detectInputKind(input);
  let zipPath = input;
  if (kind === "encrypted-v2") {
    zipPath = path.join(workDir, "bundle.zip");
    await decryptBundle(input, zipPath, await passphrase());
  }
  const entries = await readZipEntries(zipPath);
  const members = entries.map(classify);
  const one = (k: "metadata" | "dump" | "frontend-state"): ZipEntry | undefined =>
    members.find((m) => m.kind === k)?.entry;
  const metadataEntry = one("metadata");
  const dumpEntry = one("dump");
  if (!metadataEntry) throw bundleError("The backup has no metadata.json.");
  if (!dumpEntry) throw bundleError("The backup has no db.sql (the PostgreSQL dump).");
  const budget = { remaining: MAX_TOTAL_BYTES };
  if (metadataEntry.uncompressedSize > MAX_METADATA_BYTES) throw bundleError("metadata.json is implausibly large.");
  const metadata = parseMetadata(await readEntry(zipPath, metadataEntry, budget));
  const warnings: string[] = [];
  if (!/^2\.0\.\d+$/.test(metadata.appVersion)) {
    warnings.push(
      `metadata.json says the backup was made by Vision ${JSON.stringify(metadata.appVersion)}, not 2.0.x; ` +
        "the migration ledger in the dump decides whether it can be converted.",
    );
  }

  const dumpPath = path.join(workDir, DUMP_MEMBER);
  const dump = await extractEntryToFile(zipPath, dumpEntry, dumpPath, budget);

  let frontendStateBytes: Buffer | null = null;
  let frontendState: unknown = null;
  let frontendStateKeys: number | null = null;
  const frontendEntry = one("frontend-state");
  if (frontendEntry) {
    if (frontendEntry.uncompressedSize > MAX_FRONTEND_STATE_BYTES) {
      throw bundleError("frontend-state.json is implausibly large.");
    }
    frontendStateBytes = await readEntry(zipPath, frontendEntry, budget);
    try {
      const state: unknown = JSON.parse(frontendStateBytes.toString("utf8"));
      frontendState = state;
      const keys = isRecord(state) ? state.keys : undefined;
      if (isRecord(keys)) frontendStateKeys = Object.keys(keys).length;
      else warnings.push("frontend-state.json has no { keys: {...} } object; Vision's restore would skip it.");
    } catch {
      warnings.push("frontend-state.json is not valid JSON; Vision's restore would skip it.");
    }
  }

  const attachmentsRoot = path.join(workDir, "attachments");
  const attachments: BundleAttachment[] = [];
  const attachmentDirectories: string[] = [];
  const hasAttachments = members.some((m) => m.kind === "attachment" || m.kind === "attachment-dir");
  if (hasAttachments) await fs.promises.mkdir(attachmentsRoot, { mode: 0o700 });
  for (const member of members) {
    if (member.kind === "attachment-dir") {
      if (member.relativePath !== "") {
        attachmentDirectories.push(member.relativePath);
        await fs.promises.mkdir(path.join(attachmentsRoot, ...member.relativePath.split("/")), {
          recursive: true,
          mode: 0o700,
        });
      }
    } else if (member.kind === "attachment") {
      const extractedPath = path.join(attachmentsRoot, ...member.relativePath.split("/"));
      await fs.promises.mkdir(path.dirname(extractedPath), { recursive: true, mode: 0o700 });
      const result = await extractEntryToFile(zipPath, member.entry, extractedPath, budget);
      attachments.push({ relativePath: member.relativePath, extractedPath, ...result });
    }
  }
  attachments.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

  return {
    encrypted: kind === "encrypted-v2",
    zipPath,
    metadata,
    dumpPath,
    dumpBytes: dump.bytes,
    dumpSha256: dump.sha256,
    frontendStateBytes,
    frontendState,
    frontendStateKeys,
    attachments,
    attachmentDirectories: attachmentDirectories.sort(),
    warnings,
  };
}

export interface SqliteBundleMetadata {
  bundleVersion: typeof SQLITE_BUNDLE_VERSION;
  database: "sqlite";
  schemaVersion: number;
  sqliteVersion: string;
  databaseSha256: string;
  databaseBytes: number;
  appVersion: string;
  deviceId: string;
  createdAt: string;
  encrypted: false;
}

export interface WriteSqliteBundleOptions {
  destination: string;
  /** Scratch space for the unencrypted zip when encrypting. */
  workDir: string;
  databasePath: string;
  metadata: SqliteBundleMetadata;
  attachmentsDir: string | null;
  attachmentDirectories: readonly string[];
  attachments: readonly BundleAttachment[];
  /** Written as createBundle does: JSON.stringify(state, null, 2), omitted when falsy. */
  frontendState: unknown;
  /** Encrypt with this passphrase (the input's), or null for a plain bundle. */
  passphrase: string | null;
}

interface WalkItem {
  name: string;
  directory: boolean;
}

/**
 * The order packaging/electron/backup/zip-writer.ts walks a directory in:
 * each directory's names sorted, every entry followed by its own contents.
 */
export function attachmentWalk(
  directories: readonly string[],
  files: readonly BundleAttachment[],
): WalkItem[] {
  interface Node {
    children: Map<string, Node>;
    file: boolean;
  }
  const root: Node = { children: new Map(), file: false };
  const add = (relative: string, file: boolean): void => {
    let node = root;
    const parts = relative.split("/");
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (child === undefined) {
        child = { children: new Map(), file: file && i === parts.length - 1 };
        node.children.set(part, child);
      }
      node = child;
    });
  };
  for (const d of directories) add(d, false);
  for (const f of files) add(f.relativePath, true);
  const out: WalkItem[] = [];
  const walk = (node: Node, prefix: string): void => {
    for (const name of [...node.children.keys()].sort()) {
      const child = node.children.get(name);
      if (child === undefined) continue;
      const full = prefix === "" ? name : `${prefix}/${name}`;
      out.push({ name: full, directory: !child.file });
      if (!child.file) walk(child, full);
    }
  };
  walk(root, "");
  return out;
}

/** Write a format-2 bundle; refuses an existing destination. */
export async function writeSqliteBundle(options: WriteSqliteBundleOptions): Promise<void> {
  if (fs.existsSync(options.destination)) {
    throw new TransitionError(`${options.destination} already exists; the transition never overwrites a file.`, {
      hint: "Choose a new file name for --to-backup.",
    });
  }
  const zipPath = options.passphrase === null ? options.destination : path.join(options.workDir, "out.visionbak");
  const writer = await createZipWriter(zipPath);
  try {
    await writer.addBuffer(METADATA_MEMBER, Buffer.from(JSON.stringify(options.metadata, null, 2), "utf8"));
    await writer.addFile(SQLITE_MEMBER, options.databasePath);
    if (options.attachmentsDir !== null) {
      for (const item of attachmentWalk(options.attachmentDirectories, options.attachments)) {
        if (item.directory) await writer.addDirectory(`${ATTACHMENTS_PREFIX}${item.name}/`);
        else await writer.addFile(`${ATTACHMENTS_PREFIX}${item.name}`, path.join(options.attachmentsDir, ...item.name.split("/")));
      }
    }
    // createBundle: `if (frontendState) append(JSON.stringify(frontendState, null, 2))`.
    if (options.frontendState !== null && options.frontendState !== undefined && options.frontendState !== false &&
      options.frontendState !== 0 && options.frontendState !== "") {
      await writer.addBuffer(FRONTEND_STATE_MEMBER, Buffer.from(JSON.stringify(options.frontendState, null, 2), "utf8"));
    }
    await writer.finalize();
  } catch (err) {
    await writer.abort().catch(() => undefined);
    await fs.promises.rm(zipPath, { force: true });
    throw err;
  }
  if (options.passphrase !== null) {
    try {
      await encryptBundle(zipPath, options.destination, options.passphrase);
    } finally {
      await fs.promises.rm(zipPath, { force: true });
    }
  }
}

/** Facts read back from a written SQLite bundle, for verification. */
export interface ReadBackSqliteBundle {
  metadata: Record<string, unknown>;
  databasePath: string;
  databaseSha256: string;
  attachments: Map<string, string>;
  frontendStateSha256: string | null;
  members: string[];
}

/** Decrypt and extract a format-2 bundle the way a restore would. */
export async function readBackSqliteBundle(
  file: string,
  workDir: string,
  passphrase: string | null,
): Promise<ReadBackSqliteBundle> {
  const kind = await detectInputKind(file);
  let zipPath = file;
  if (kind === "encrypted-v2") {
    if (passphrase === null) throw new TransitionError("The written bundle is encrypted, but no passphrase was used.");
    zipPath = path.join(workDir, "readback.zip");
    await decryptBundle(file, zipPath, passphrase);
  } else if (passphrase !== null) {
    throw new TransitionError("The written bundle is not encrypted, but the input was.");
  }
  const entries = await readZipEntries(zipPath);
  const budget = { remaining: MAX_TOTAL_BYTES };
  let metadata: Record<string, unknown> | undefined;
  let databasePath: string | undefined;
  let databaseSha256 = "";
  let frontendStateSha256: string | null = null;
  const attachments = new Map<string, string>();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.name === METADATA_MEMBER) {
      const parsed: unknown = JSON.parse((await readEntry(zipPath, entry, budget)).toString("utf8"));
      if (!isRecord(parsed)) throw new TransitionError("The written bundle's metadata.json is not an object.");
      metadata = parsed;
    } else if (entry.name === SQLITE_MEMBER) {
      databasePath = path.join(workDir, "readback.sqlite3");
      databaseSha256 = (await extractEntryToFile(zipPath, entry, databasePath, budget)).sha256;
    } else if (entry.name === FRONTEND_STATE_MEMBER) {
      const out = path.join(workDir, "readback-frontend-state.json");
      frontendStateSha256 = (await extractEntryToFile(zipPath, entry, out, budget)).sha256;
    } else if (entry.name.startsWith(ATTACHMENTS_PREFIX)) {
      const out = path.join(workDir, `readback-attachment-${attachments.size}`);
      attachments.set(entry.name.slice(ATTACHMENTS_PREFIX.length), (await extractEntryToFile(zipPath, entry, out, budget)).sha256);
      await fs.promises.rm(out);
    } else {
      throw new TransitionError(`The written bundle contains an unexpected member ${entry.name}.`);
    }
  }
  if (!metadata || !databasePath) throw new TransitionError("The written bundle lacks metadata.json or db.sqlite3.");
  if (zipPath !== file) await fs.promises.rm(zipPath, { force: true });
  return {
    metadata,
    databasePath,
    databaseSha256,
    attachments,
    frontendStateSha256,
    members: entries.map((e) => e.name),
  };
}

