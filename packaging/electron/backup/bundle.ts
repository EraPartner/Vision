/**
 * Vision Backup Bundle — create and open .visionbak files.
 *
 * Bundle layout (zip archive):
 *   metadata.json        — schema version, app version, device ID, timestamps
 *   db.sql               — pg_dump plain SQL
 *   attachments/         — mirrors ATTACHMENTS_DIR tree (present when attachments exist)
 *   frontend-state.json  — localStorage snapshot { keys: { … } }
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
// A legitimate bundle is a DB dump + attachments (each attachment ≤ 10 MB).
// These caps stop a crafted .visionbak whose entries decompress to far more
// than the host can hold. Tracked against the *actual* bytes written, not just
// the header-declared uncompressedSize (which a malicious bundle can lie about).

/** Max total uncompressed bytes written across all entries (10 GiB). */
const MAX_RESTORE_BYTES = 10 * 1024 * 1024 * 1024;

/** Max number of entries (files + dirs) in a restore bundle. */
const MAX_RESTORE_ENTRIES = 100_000;

/** Current bundle format version stored in metadata.json. */
export const BUNDLE_VERSION = 1;

/**
 * Parsed metadata.json. A bundle is untrusted input, so every field is
 * `unknown` until the consumer checks it.
 */
export type BundleMetadata = Readonly<Record<string, unknown>>;

export interface CreateBundleOptions {
  /** output directory */
  destDir: string;
  /** short device identifier */
  deviceId: string;
  /** highest public.kysely_migration name at dump time */
  schemaHead?: string | null | undefined;
  /** Electron app.getVersion() */
  appVersion?: string | null;
  /** path to the pg_dump SQL file */
  dbSqlPath: string;
  /** local dir mirroring ATTACHMENTS_DIR (or null) */
  attachmentsDir?: string | null;
  /** { keys: { … } } localStorage snapshot (or null) */
  frontendState?: unknown;
}

export interface OpenedBundle {
  metadata: BundleMetadata;
  dbSqlPath: string;
  attachmentsDir: string | null;
  frontendState: unknown;
  cleanup: () => void;
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
  schemaHead,
  appVersion,
  dbSqlPath,
  attachmentsDir,
  frontendState,
}: CreateBundleOptions): Promise<{ bundlePath: string }> {
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
    schemaHead: schemaHead || "",
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

    // db.sql
    await archive.file(dbSqlPath, "db.sql");

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
 * Encrypt a bundle in-place with AES-256-GCM (v2 format).
 * Writes the encrypted file as `<bundlePath>.enc`, deletes the original.
 *
 * @param passphrase - user passphrase; key is derived per-bundle
 *                     with a fresh random salt embedded in the header.
 */
export async function encryptBundle(
  bundlePath: string,
  passphrase: string,
): Promise<{ encPath: string }> {
  if (!passphrase || typeof passphrase !== "string") {
    throw new Error("encryptBundle requires a passphrase");
  }
  const encPath = `${bundlePath}.enc`;
  await encryptFileV2(bundlePath, encPath, passphrase, BUNDLE_ENC_MAGIC_V2);

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

    // db.sql is required
    const dbSqlPath = path.join(tmpDir, "db.sql");
    if (!fs.existsSync(dbSqlPath)) {
      throw new Error("Bundle is missing db.sql — file may be corrupt.");
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

    return { metadata, dbSqlPath, attachmentsDir, frontendState, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
