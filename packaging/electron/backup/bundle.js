"use strict";

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
 * nonce, and authentication tag. Legacy AES-256-CBC bundles remain readable.
 * The encrypted file is written as .visionbak.enc.
 *
 * Backwards-compatible read: the magic header is also accepted from the legacy
 * .sql.enc format so that runRestore can share the decryption path.
 */

// archiver (65 transitive modules) and yauzl are only needed by the backup
// create/restore paths, all of which run well after boot. Lazy-require them via
// memoized getters so `require('./backup/bundle')` at Electron module-eval time
// stays cheap — the first backup/restore pays the load cost instead of every launch.

// archiver v7 exposes a CJS factory: archiver('zip', opts).
// archiver v8+ is ESM with named class exports: new ZipArchive(opts).
// This shim keeps the call site (`archiver('zip', opts)`) stable across both.
let _archiver = null;
function getArchiver() {
  if (_archiver) return _archiver;
  const archiverPkg = require("archiver");
  _archiver =
    typeof archiverPkg === "function"
      ? archiverPkg
      : (format, opts) => {
          if (format === "zip") return new archiverPkg.ZipArchive(opts);
          if (format === "tar") return new archiverPkg.TarArchive(opts);
          if (format === "json") return new archiverPkg.JsonArchive(opts);
          throw new Error(`Unsupported archiver format: ${format}`);
        };
  return _archiver;
}

let _yauzl = null;
function getYauzl() {
  if (!_yauzl) _yauzl = require("yauzl");
  return _yauzl;
}

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  V1_IV_BYTES,
  isEncryptedFile,
  encryptFileV2,
  decryptFile,
} = require("./encrypted-file");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Magic bytes written at the start of every legacy v1 (CBC) encrypted bundle. */
const BUNDLE_ENC_MAGIC = Buffer.from("VISIONBAK1");

/** Magic bytes for v2 (GCM, AEAD) encrypted bundles. */
const BUNDLE_ENC_MAGIC_V2 = Buffer.from("VISIONBAK2");

/** IV length used for legacy AES-256-CBC encryption. */
const BUNDLE_ENC_IV_BYTES = V1_IV_BYTES;

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
const BUNDLE_VERSION = 1;

// ---------------------------------------------------------------------------
// createBundle
// ---------------------------------------------------------------------------

/**
 * Write a new .visionbak zip file to destDir.
 *
 * @param {object} opts
 * @param {string}      opts.destDir          - output directory
 * @param {string}      opts.deviceId         - short device identifier
 * @param {string}      opts.schemaHead       - alembic_version value at dump time
 * @param {string}      opts.appVersion       - Electron app.getVersion()
 * @param {string}      opts.dbSqlPath        - path to the pg_dump SQL file
 * @param {string|null} opts.attachmentsDir   - local dir mirroring ATTACHMENTS_DIR (or null)
 * @param {object|null} opts.frontendState    - { keys: { … } } localStorage snapshot (or null)
 * @returns {Promise<{bundlePath: string}>}
 */
async function createBundle({
  destDir,
  deviceId,
  schemaHead,
  appVersion,
  dbSqlPath,
  attachmentsDir,
  frontendState,
}) {
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

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(partialPath);
    const archive = getArchiver()("zip", { zlib: { level: 6 } });

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      archive.abort();
      output.destroy();
      fs.unlink(partialPath, () => {});
      reject(err);
    };

    archive.on("error", fail);
    output.on("error", fail);
    output.on("close", () => {
      if (settled) return;
      settled = true;
      // Promote the completed partial to its canonical name. Only a fully
      // finalized archive reaches here (archiver emits 'error' → fail otherwise).
      fs.rename(partialPath, bundlePath, (err) => {
        if (err) {
          fs.unlink(partialPath, () => {});
          reject(err);
          return;
        }
        resolve();
      });
    });

    archive.pipe(output);

    // metadata.json
    archive.append(JSON.stringify(metadata, null, 2), {
      name: "metadata.json",
    });

    // db.sql
    archive.file(dbSqlPath, { name: "db.sql" });

    // attachments/ tree (optional — not every instance has attachments)
    if (attachmentsDir && fs.existsSync(attachmentsDir)) {
      archive.directory(attachmentsDir, "attachments");
    }

    // frontend-state.json (optional)
    if (frontendState) {
      archive.append(JSON.stringify(frontendState, null, 2), {
        name: "frontend-state.json",
      });
    }

    archive.finalize();
  });

  return { bundlePath };
}

// ---------------------------------------------------------------------------
// encryptBundle
// ---------------------------------------------------------------------------

/**
 * Encrypt a bundle in-place with AES-256-GCM (v2 format).
 * Writes the encrypted file as `<bundlePath>.enc`, deletes the original.
 *
 * @param {string} bundlePath
 * @param {string} passphrase - user passphrase; key is derived per-bundle
 *                              with a fresh random salt embedded in the header.
 * @returns {Promise<{encPath: string}>}
 */
async function encryptBundle(bundlePath, passphrase) {
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
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function isBundleEncrypted(filePath) {
  return isEncryptedFile(filePath, [BUNDLE_ENC_MAGIC, BUNDLE_ENC_MAGIC_V2]);
}

async function decryptToTemp(encPath, passphrase, tmpPath) {
  if (!passphrase || typeof passphrase !== "string") {
    throw new Error("decryptToTemp requires a passphrase");
  }
  await decryptFile({
    encryptedPath: encPath,
    destinationPath: tmpPath,
    keyOrPassphrase: passphrase,
    v1Magic: BUNDLE_ENC_MAGIC,
    v2Magic: BUNDLE_ENC_MAGIC_V2,
    v1Salt: "vision-backup-v1",
    requiredError: "Invalid passphrase.",
    invalidError:
      "Invalid passphrase: unable to authenticate encrypted bundle.",
    invalidHeaderMessage: "Invalid encrypted bundle header.",
    unsupportedFormatMessage: "Bundle is not in a recognised encrypted format.",
  });
}

// ---------------------------------------------------------------------------
// extractZip
// ---------------------------------------------------------------------------

/**
 * Extract all entries from a zip file into destDir.
 *
 * @param {string} zipPath
 * @param {string} destDir
 * @returns {Promise<void>}
 */
function extractZip(zipPath, destDir) {
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
        const fail = (message) => {
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
          const declared = Number(entry.uncompressedSize);
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
              readStream.on("data", (chunk) => {
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
 * @param {string} bundlePath
 * @param {object} [opts]
 * @param {Buffer|null} [opts.key] - AES key if encrypted; null = not encrypted or not available
 * @returns {Promise<{
 *   metadata: object,
 *   dbSqlPath: string,
 *   attachmentsDir: string|null,
 *   frontendState: object|null,
 *   cleanup: function
 * }>}
 */
async function openBundle(bundlePath, { passphrase } = {}) {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision_restore_"),
  );

  /** @type {function} */
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

    // metadata.json is required
    const metadataPath = path.join(tmpDir, "metadata.json");
    let metadata;
    try {
      metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
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
    let frontendState = null;
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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createBundle,
  encryptBundle,
  openBundle,
  isBundleEncrypted,
  BUNDLE_ENC_MAGIC,
  BUNDLE_ENC_MAGIC_V2,
  BUNDLE_ENC_IV_BYTES,
  BUNDLE_VERSION,
};
