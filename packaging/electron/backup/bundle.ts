/**
 * Vision Backup Bundle — create and open .visionbak files.
 *
 * Bundle layout (zip archive):
 *   metadata.json        — bundle format, database schema version, app version,
 *                          device ID, timestamps, database checksum
 *   db.sqlite3           — a verified SQLite snapshot of the database (ADR-263)
 *   attachments/         — mirrors ATTACHMENTS_DIR tree (present when attachments exist)
 *   frontend-state.json  — localStorage snapshot { keys: { … } }
 *
 * Bundle format 1 (Vision 2.0 and earlier) carried a PostgreSQL `db.sql`
 * dump instead. openBundle still extracts such a bundle so the caller can
 * name the transition path; nothing in the desktop app parses db.sql.
 *
 * Encryption (optional): new bundles use AES-256-GCM with a per-file salt,
 * nonce, and authentication tag. Retired v1 AES-256-CBC bundles are refused.
 * The encrypted file is written as .visionbak.enc.
 *
 * Backwards-compatible read: the magic header is also accepted from the legacy
 * .sql.enc format so that runRestore can share the decryption path.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type * as Yauzl from "yauzl";
import {
  RETIRED_V1_MESSAGE,
  isEncryptedFile,
  encryptFileV2,
  decryptFile,
} from "./encrypted-file";
import { createZipWriter } from "./zip-writer";

// yauzl is only needed by the restore path, which runs well after boot.
// Lazy-require it via a memoized getter so `require('./backup/bundle')` at
// Electron module-eval time stays cheap. A static import would load it
// eagerly, so this stays a synchronous require() typed through the type-only
// import above. The zip writer uses only node builtins.

function isYauzl(value: unknown): value is typeof Yauzl {
  return isRecord(value) && typeof value.open === "function";
}

let _yauzl: typeof Yauzl | undefined;
function getYauzl(): typeof Yauzl {
  if (!_yauzl) {
    const yauzl: unknown = createRequire(__filename)("yauzl");
    if (!isYauzl(yauzl)) throw new TypeError("yauzl failed to load");
    _yauzl = yauzl;
  }
  return _yauzl;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Magic of the retired v1 (CBC) encrypted bundle; restore refuses it by name. */
export const BUNDLE_ENC_MAGIC = Buffer.from("VISIONBAK1");

/** Magic bytes for v2 (GCM, AEAD) encrypted bundles. */
export const BUNDLE_ENC_MAGIC_V2 = Buffer.from("VISIONBAK2");

// --- Zip-bomb guards for restore (extractZip) ---
// A legitimate bundle is a database file + attachments (each attachment ≤ 10 MB).
// These caps stop a crafted .visionbak whose entries decompress to far more
// than the host can hold. Tracked against the *actual* bytes written, not just
// the header-declared uncompressedSize (which a malicious bundle can lie about).

/** Max total uncompressed bytes written across all entries (10 GiB). */
const MAX_RESTORE_BYTES = 10 * 1024 * 1024 * 1024;

/** Max number of entries (files + dirs) in a restore bundle. */
const MAX_RESTORE_ENTRIES = 100_000;

/** Current bundle format version stored in metadata.json (2: SQLite database). */
export const BUNDLE_VERSION = 2;

/** Bundle member holding the SQLite database (format 2). */
export const BUNDLE_DATABASE_MEMBER = "db.sqlite3";

/** Bundle member holding Vision 2.0's PostgreSQL dump (format 1). */
export const LEGACY_BUNDLE_DUMP_MEMBER = "db.sql";

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

/**
 * Parsed metadata.json. A bundle is untrusted input, so every field is
 * `unknown` until the consumer checks it.
 */
export type BundleMetadata = Readonly<Record<string, unknown>>;

/** Facts about the snapshot that metadata.json records for restore checks. */
export interface BundleDatabaseInfo {
  /** Latest migration version in the snapshot's ledger. */
  schemaVersion: number;
  /** SQLite library version that wrote the snapshot. */
  sqliteVersion?: string | null | undefined;
  /** SHA-256 of db.sqlite3; restore refuses a member that does not match. */
  sha256?: string | null | undefined;
  bytes?: number | null | undefined;
}

export interface CreateBundleOptions {
  /** output directory */
  destDir: string;
  /** short device identifier */
  deviceId: string;
  /** Electron app.getVersion() */
  appVersion?: string | null;
  /** path to a verified SQLite snapshot of the database */
  databasePath: string;
  database: BundleDatabaseInfo;
  /** local dir mirroring ATTACHMENTS_DIR (or null) */
  attachmentsDir?: string | null;
  /** { keys: { … } } localStorage snapshot (or null) */
  frontendState?: unknown;
}

export interface OpenedBundle {
  metadata: BundleMetadata;
  /** The extracted db.sqlite3; null for a Vision 2.0 (format 1) bundle. */
  databasePath: string | null;
  /** The extracted Vision 2.0 db.sql; null for a SQLite bundle. Never parsed here. */
  dbSqlPath: string | null;
  attachmentsDir: string | null;
  frontendState: unknown;
  cleanup: () => void;
}

async function assertSqliteFile(file: string): Promise<void> {
  const handle = await fs.promises.open(file, "r");
  try {
    const head = Buffer.alloc(SQLITE_MAGIC.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead !== head.length || !head.equals(SQLITE_MAGIC)) {
      throw new Error("The backup database is not a SQLite database file.");
    }
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// createBundle
// ---------------------------------------------------------------------------

/** Write a new .visionbak zip file to destDir. */
export async function createBundle({
  destDir,
  deviceId,
  appVersion,
  databasePath,
  database,
  attachmentsDir,
  frontendState,
}: CreateBundleOptions): Promise<{ bundlePath: string }> {
  if (!Number.isSafeInteger(database.schemaVersion) || database.schemaVersion < 1) {
    throw new Error("createBundle requires the database schema version");
  }
  await assertSqliteFile(databasePath);
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const filename = `vision_backup_${deviceId}_${timestamp}.visionbak`;
  const bundlePath = path.join(destDir, filename);

  await fs.promises.mkdir(destDir, { recursive: true });

  const metadata = {
    bundleVersion: BUNDLE_VERSION,
    database: "sqlite",
    schemaVersion: database.schemaVersion,
    sqliteVersion: database.sqliteVersion || null,
    databaseSha256: database.sha256 || null,
    databaseBytes: database.bytes ?? null,
    appVersion: appVersion || "unknown",
    deviceId,
    createdAt: new Date().toISOString(),
    encrypted: false,
  };

  // Write to a `.partial` sidecar and rename to the canonical name only after
  // the archive finalizes cleanly. An interrupted backup (e.g. a second ⌘Q
  // during quit-backup) then leaves a truncated `*.partial` — which retention
  // cleanup deletes — never a truncated file at the final, restorable name.
  const partialPath = `${bundlePath}.partial`;

  const archive = await createZipWriter(partialPath, { level: 6 });
  try {
    // metadata.json
    await archive.append("metadata.json", JSON.stringify(metadata, null, 2));

    // db.sqlite3
    await archive.file(databasePath, BUNDLE_DATABASE_MEMBER);

    // attachments/ tree (optional — not every instance has attachments)
    if (attachmentsDir && fs.existsSync(attachmentsDir)) {
      await archive.directory(attachmentsDir, "attachments");
    }

    // frontend-state.json (optional)
    if (frontendState) {
      await archive.append(
        "frontend-state.json",
        JSON.stringify(frontendState, null, 2),
      );
    }

    // Writes the central directory and fsyncs before closing.
    await archive.finalize();
    // Promote the completed partial to its canonical name. Only a fully
    // finalized archive reaches here.
    await fs.promises.rename(partialPath, bundlePath);
  } catch (err) {
    await archive.abort().catch(() => {});
    await fs.promises.unlink(partialPath).catch(() => {});
    throw err;
  }

  return { bundlePath };
}

// ---------------------------------------------------------------------------
// encryptBundle
// ---------------------------------------------------------------------------

/**
 * Encrypt a bundle with AES-256-GCM (v2 format) and delete the plaintext.
 * Writes `<destDir>/<bundle name>.enc` (destDir defaults to the bundle's own
 * directory) through a `.partial` sidecar, so an interrupted write never
 * leaves a truncated file at the restorable name. Building the plaintext
 * bundle in a private staging directory and passing the backup folder as
 * destDir keeps the unencrypted archive out of that folder (e.g. iCloud Drive).
 *
 * @param passphrase - user passphrase; key is derived per-bundle
 *                     with a fresh random salt embedded in the header.
 */
export async function encryptBundle(
  bundlePath: string,
  passphrase: string,
  { destDir = path.dirname(bundlePath) }: { destDir?: string } = {},
): Promise<{ encPath: string }> {
  if (!passphrase || typeof passphrase !== "string") {
    throw new Error("encryptBundle requires a passphrase");
  }
  await fs.promises.mkdir(destDir, { recursive: true });
  const encPath = path.join(destDir, `${path.basename(bundlePath)}.enc`);
  const partialPath = `${encPath}.partial`;
  try {
    await encryptFileV2(
      bundlePath,
      partialPath,
      passphrase,
      BUNDLE_ENC_MAGIC_V2,
    );
    await fs.promises.rename(partialPath, encPath);
  } catch (err) {
    await fs.promises.unlink(partialPath).catch(() => {});
    throw err;
  }

  await fs.promises.unlink(bundlePath);
  return { encPath };
}

// ---------------------------------------------------------------------------
// isBundleEncrypted
// ---------------------------------------------------------------------------

/**
 * Peek at the first bytes of a file to check for the encryption magic header.
 * Works for both .visionbak.enc (new) and .sql.enc (legacy) files.
 */
export async function isBundleEncrypted(filePath: string): Promise<boolean> {
  return isEncryptedFile(filePath, [BUNDLE_ENC_MAGIC, BUNDLE_ENC_MAGIC_V2]);
}

async function decryptToTemp(
  encPath: string,
  passphrase: string,
  tmpPath: string,
): Promise<void> {
  if (!passphrase || typeof passphrase !== "string") {
    throw new Error("decryptToTemp requires a passphrase");
  }
  await decryptFile({
    encryptedPath: encPath,
    destinationPath: tmpPath,
    keyOrPassphrase: passphrase,
    retiredV1Magic: BUNDLE_ENC_MAGIC,
    v2Magic: BUNDLE_ENC_MAGIC_V2,
    requiredError: "Invalid passphrase.",
    invalidError:
      "Invalid passphrase: unable to authenticate encrypted bundle.",
    invalidHeaderMessage: "Invalid encrypted bundle header.",
    unsupportedFormatMessage: "Bundle is not in a recognised encrypted format.",
    retiredFormatMessage: RETIRED_V1_MESSAGE,
  });
}

// ---------------------------------------------------------------------------
// extractZip
// ---------------------------------------------------------------------------

/** Extract all entries from a zip file into destDir. */
function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    getYauzl().open(
      zipPath,
      { lazyEntries: true, autoClose: true },
      (err, zipfile) => {
        if (err) return reject(err);

        let entryCount = 0;
        let totalBytes = 0;
        let settled = false;

        // Reject once and stop reading further entries. zipfile autoCloses.
        const fail = (message: string | Error) => {
          if (settled) return;
          settled = true;
          reject(message instanceof Error ? message : new Error(message));
        };

        zipfile.readEntry();

        zipfile.on("entry", (entry) => {
          if (settled) return;

          if (++entryCount > MAX_RESTORE_ENTRIES) {
            return fail(
              `Restore bundle has too many entries (> ${MAX_RESTORE_ENTRIES}) — refusing to extract.`,
            );
          }

          const entryPath = path.join(destDir, entry.fileName);

          // Guard against path traversal
          if (
            !entryPath.startsWith(destDir + path.sep) &&
            entryPath !== destDir
          ) {
            return fail(`Unsafe zip entry path: ${entry.fileName}`);
          }

          if (/\/$/.test(entry.fileName)) {
            // Directory entry
            fs.mkdir(entryPath, { recursive: true }, (mkdirErr) => {
              if (mkdirErr && mkdirErr.code !== "EEXIST") return fail(mkdirErr);
              zipfile.readEntry();
            });
            return;
          }

          // Reject implausible header-declared sizes up front (cheap pre-check).
          const declared = entry.uncompressedSize;
          if (
            Number.isFinite(declared) &&
            (declared < 0 || totalBytes + declared > MAX_RESTORE_BYTES)
          ) {
            return fail(
              `Restore bundle exceeds the maximum uncompressed size (${MAX_RESTORE_BYTES} bytes) — possible zip bomb.`,
            );
          }

          // File entry
          fs.mkdir(path.dirname(entryPath), { recursive: true }, (mkdirErr) => {
            if (mkdirErr && mkdirErr.code !== "EEXIST") return fail(mkdirErr);

            zipfile.openReadStream(entry, (rsErr, readStream) => {
              if (rsErr) return fail(rsErr);
              const writeStream = fs.createWriteStream(entryPath);

              // Enforce the cap against bytes actually written — a crafted bundle
              // can understate uncompressedSize, so the header check isn't enough.
              readStream.on("data", (chunk: Buffer) => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_RESTORE_BYTES) {
                  readStream.unpipe(writeStream);
                  readStream.destroy();
                  writeStream.destroy();
                  fail(
                    `Restore bundle exceeds the maximum uncompressed size (${MAX_RESTORE_BYTES} bytes) — possible zip bomb.`,
                  );
                }
              });

              readStream.pipe(writeStream);
              writeStream.on("finish", () => {
                if (!settled) zipfile.readEntry();
              });
              writeStream.on("error", fail);
              readStream.on("error", fail);
            });
          });
        });

        zipfile.on("end", () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        zipfile.on("error", fail);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// openBundle
// ---------------------------------------------------------------------------

/**
 * Open a .visionbak (or .visionbak.enc) file:
 *   1. Detect and decrypt if needed.
 *   2. Extract zip to a temp directory.
 *   3. Return paths + parsed content + cleanup function.
 *
 * @param opts.passphrase - required when the bundle is encrypted
 */
export async function openBundle(
  bundlePath: string,
  { passphrase }: { passphrase?: string | null } = {},
): Promise<OpenedBundle> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision_restore_"),
  );

  const cleanup = () =>
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});

  try {
    let zipPath = bundlePath;

    const encrypted = await isBundleEncrypted(bundlePath);
    if (encrypted) {
      if (!passphrase)
        throw new Error(
          "This bundle is encrypted. Set a backup passphrase to restore it.",
        );
      const decryptedPath = path.join(tmpDir, "bundle.visionbak");
      await decryptToTemp(bundlePath, passphrase, decryptedPath);
      zipPath = decryptedPath;
    }

    await extractZip(zipPath, tmpDir);

    // metadata.json is required, and must hold a JSON object
    const metadataPath = path.join(tmpDir, "metadata.json");
    let metadata: BundleMetadata;
    try {
      const parsed: unknown = JSON.parse(
        await fs.promises.readFile(metadataPath, "utf8"),
      );
      if (!isRecord(parsed)) throw new TypeError("metadata is not an object");
      metadata = parsed;
    } catch {
      throw new Error("Bundle is missing metadata.json — file may be corrupt.");
    }

    // db.sqlite3 is required; a Vision 2.0 bundle carries db.sql instead,
    // which only the caller's refusal message ever looks at.
    const databaseCandidate = path.join(tmpDir, BUNDLE_DATABASE_MEMBER);
    const dumpCandidate = path.join(tmpDir, LEGACY_BUNDLE_DUMP_MEMBER);
    const databasePath = fs.existsSync(databaseCandidate)
      ? databaseCandidate
      : null;
    const dbSqlPath =
      !databasePath && fs.existsSync(dumpCandidate) ? dumpCandidate : null;
    if (!databasePath && !dbSqlPath) {
      throw new Error(
        `Bundle is missing ${BUNDLE_DATABASE_MEMBER} — file may be corrupt.`,
      );
    }

    // attachments/ is optional
    const attachmentsDir = fs.existsSync(path.join(tmpDir, "attachments"))
      ? path.join(tmpDir, "attachments")
      : null;

    // frontend-state.json is optional
    let frontendState: unknown = null;
    const frontendStatePath = path.join(tmpDir, "frontend-state.json");
    if (fs.existsSync(frontendStatePath)) {
      try {
        frontendState = JSON.parse(
          await fs.promises.readFile(frontendStatePath, "utf8"),
        );
      } catch {
        // Non-fatal — restore continues without localStorage
      }
    }

    return {
      metadata,
      databasePath,
      dbSqlPath,
      attachmentsDir,
      frontendState,
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}
