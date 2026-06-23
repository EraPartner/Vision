'use strict';

/**
 * Vision Backup Bundle — create and open .visionbak files.
 *
 * Bundle layout (zip archive):
 *   metadata.json        — schema version, app version, device ID, timestamps
 *   db.sql               — pg_dump plain SQL
 *   attachments/         — mirrors ATTACHMENTS_DIR tree (present when attachments exist)
 *   frontend-state.json  — localStorage snapshot { keys: { … } }
 *
 * Encryption (optional): when a passphrase is set the entire zip is wrapped in
 * AES-256-CBC with a header: MAGIC (10 bytes) + IV (16 bytes).
 * The encrypted file is written as .visionbak.enc.
 *
 * Backwards-compatible read: the magic header is also accepted from the legacy
 * .sql.enc format so that runRestore can share the decryption path.
 */

// archiver v7 exposes a CJS factory: archiver('zip', opts).
// archiver v8+ is ESM with named class exports: new ZipArchive(opts).
// This shim keeps the call site (`archiver('zip', opts)`) stable across both.
const archiverPkg = require('archiver');
const archiver = typeof archiverPkg === 'function'
  ? archiverPkg
  : (format, opts) => {
      if (format === 'zip') return new archiverPkg.ZipArchive(opts);
      if (format === 'tar') return new archiverPkg.TarArchive(opts);
      if (format === 'json') return new archiverPkg.JsonArchive(opts);
      throw new Error(`Unsupported archiver format: ${format}`);
    };
const yauzl = require('yauzl');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Magic bytes written at the start of every legacy v1 (CBC) encrypted bundle. */
const BUNDLE_ENC_MAGIC = Buffer.from('VISIONBAK1');

/** Magic bytes for v2 (GCM, AEAD) encrypted bundles. */
const BUNDLE_ENC_MAGIC_V2 = Buffer.from('VISIONBAK2');

/** IV length used for legacy AES-256-CBC encryption. */
const BUNDLE_ENC_IV_BYTES = 16;

/** Per-bundle salt for v2 KDF. */
const BUNDLE_ENC_V2_SALT_BYTES = 16;

/** GCM nonce length. */
const BUNDLE_ENC_V2_IV_BYTES = 12;

/** GCM auth tag length. */
const BUNDLE_ENC_V2_TAG_BYTES = 16;

// --- Zip-bomb guards for restore (extractZip) ---
// A legitimate bundle is a DB dump + attachments (each attachment ≤ 10 MB).
// These caps stop a crafted .visionbak whose entries decompress to far more
// than the host can hold. Tracked against the *actual* bytes written, not just
// the header-declared uncompressedSize (which a malicious bundle can lie about).

/** Max total uncompressed bytes written across all entries (10 GiB). */
const MAX_RESTORE_BYTES = 10 * 1024 * 1024 * 1024;

/** Max number of entries (files + dirs) in a restore bundle. */
const MAX_RESTORE_ENTRIES = 100_000;

/** scrypt cost parameters for v2 (OWASP-aligned). */
const BUNDLE_KDF_N = 1 << 15;
const BUNDLE_KDF_R = 8;
const BUNDLE_KDF_P = 1;

/** Current bundle format version stored in metadata.json. */
const BUNDLE_VERSION = 1;

function deriveBundleKeyV1(passphrase) {
  if (!passphrase || typeof passphrase !== 'string') return null;
  // Legacy static-salt KDF — only used for decrypting pre-existing v1 bundles.
  return crypto.scryptSync(passphrase, 'vision-backup-v1', 32);
}

function deriveBundleKeyV2(passphrase, salt) {
  if (!passphrase || typeof passphrase !== 'string') return null;
  if (!Buffer.isBuffer(salt) || salt.length !== BUNDLE_ENC_V2_SALT_BYTES) {
    throw new Error('deriveBundleKeyV2 requires a 16-byte salt');
  }
  return crypto.scryptSync(passphrase, salt, 32, {
    N: BUNDLE_KDF_N,
    r: BUNDLE_KDF_R,
    p: BUNDLE_KDF_P,
    maxmem: 128 * BUNDLE_KDF_N * BUNDLE_KDF_R * 2,
  });
}

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
async function createBundle({ destDir, deviceId, schemaHead, appVersion, dbSqlPath, attachmentsDir, frontendState }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `vision_backup_${deviceId}_${timestamp}.visionbak`;
  const bundlePath = path.join(destDir, filename);

  await fs.promises.mkdir(destDir, { recursive: true });

  const metadata = {
    bundleVersion: BUNDLE_VERSION,
    schemaHead: schemaHead || '',
    appVersion: appVersion || 'unknown',
    deviceId,
    createdAt: new Date().toISOString(),
    encrypted: false,
  };

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(bundlePath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      archive.abort();
      output.destroy();
      fs.unlink(bundlePath, () => {});
      reject(err);
    };

    archive.on('error', fail);
    output.on('error', fail);
    output.on('close', () => {
      if (settled) return;
      settled = true;
      resolve();
    });

    archive.pipe(output);

    // metadata.json
    archive.append(JSON.stringify(metadata, null, 2), { name: 'metadata.json' });

    // db.sql
    archive.file(dbSqlPath, { name: 'db.sql' });

    // attachments/ tree (optional — not every instance has attachments)
    if (attachmentsDir && fs.existsSync(attachmentsDir)) {
      archive.directory(attachmentsDir, 'attachments');
    }

    // frontend-state.json (optional)
    if (frontendState) {
      archive.append(JSON.stringify(frontendState, null, 2), { name: 'frontend-state.json' });
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
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('encryptBundle requires a passphrase');
  }
  const encPath = `${bundlePath}.enc`;
  const salt = crypto.randomBytes(BUNDLE_ENC_V2_SALT_BYTES);
  const iv = crypto.randomBytes(BUNDLE_ENC_V2_IV_BYTES);
  const key = deriveBundleKeyV2(passphrase, salt);

  try {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(bundlePath);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const output = fs.createWriteStream(encPath);

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        input.destroy();
        cipher.destroy();
        output.destroy();
        fs.unlink(encPath, () => {});
        reject(err);
      };

      input.on('error', fail);
      cipher.on('error', fail);
      output.on('error', fail);

      output.write(BUNDLE_ENC_MAGIC_V2);
      output.write(salt);
      output.write(iv);

      // pipe() honours stream backpressure (the manual cipher.on('data') →
      // output.write() loop ignored write()===false and could balloon memory on
      // a multi-GB bundle). end:false keeps `output` open so we can append the
      // GCM auth tag, which is only available after the cipher finishes.
      input.pipe(cipher).pipe(output, { end: false });
      cipher.on('end', () => {
        try {
          const tag = cipher.getAuthTag();
          output.end(tag);
        } catch (err) {
          fail(err);
        }
      });

      output.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  } finally {
    if (Buffer.isBuffer(key)) key.fill(0);
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
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function isBundleEncrypted(filePath) {
  const headerLen = BUNDLE_ENC_MAGIC.length;
  const buf = Buffer.alloc(headerLen);
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const { bytesRead } = await handle.read(buf, 0, headerLen, 0);
    if (bytesRead !== headerLen) return false;
    return buf.equals(BUNDLE_ENC_MAGIC) || buf.equals(BUNDLE_ENC_MAGIC_V2);
  } catch {
    return false;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// decryptToTemp
// ---------------------------------------------------------------------------

/**
 * Decrypt an encrypted bundle to a temporary file. Auto-detects v1 (CBC) or
 * v2 (GCM, AEAD with per-bundle salt). Pass a passphrase string for either
 * version; callers no longer derive keys themselves.
 *
 * @param {string} encPath
 * @param {string} passphrase
 * @param {string} tmpPath
 * @returns {Promise<void>}
 */
async function decryptToTemp(encPath, passphrase, tmpPath) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('decryptToTemp requires a passphrase');
  }
  const magicLen = BUNDLE_ENC_MAGIC.length;
  const magicBuf = Buffer.alloc(magicLen);
  let handle;
  try {
    handle = await fs.promises.open(encPath, 'r');
    const { bytesRead } = await handle.read(magicBuf, 0, magicLen, 0);
    if (bytesRead !== magicLen) throw new Error('Invalid encrypted bundle header.');
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }

  if (magicBuf.equals(BUNDLE_ENC_MAGIC_V2)) {
    return decryptToTempV2(encPath, passphrase, tmpPath);
  }
  if (magicBuf.equals(BUNDLE_ENC_MAGIC)) {
    return decryptToTempV1(encPath, passphrase, tmpPath);
  }
  throw new Error('Bundle is not in a recognised encrypted format.');
}

async function decryptToTempV1(encPath, passphrase, tmpPath) {
  const key = deriveBundleKeyV1(passphrase);
  if (!key) throw new Error('Invalid passphrase.');
  const headerLen = BUNDLE_ENC_MAGIC.length + BUNDLE_ENC_IV_BYTES;
  const header = Buffer.alloc(headerLen);
  let handle;
  try {
    handle = await fs.promises.open(encPath, 'r');
    const { bytesRead } = await handle.read(header, 0, headerLen, 0);
    if (bytesRead !== headerLen) throw new Error('Invalid encrypted bundle header.');
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }

  const iv = header.subarray(BUNDLE_ENC_MAGIC.length, headerLen);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

  try {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(encPath, { start: headerLen });
      const output = fs.createWriteStream(tmpPath);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        input.destroy(); decipher.destroy(); output.destroy();
        fs.unlink(tmpPath, () => {});
        reject(err);
      };
      input.on('error', fail);
      decipher.on('error', fail);
      output.on('error', fail);
      input.pipe(decipher).pipe(output);
      output.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    });
  } finally {
    if (Buffer.isBuffer(key)) key.fill(0);
  }
}

async function decryptToTempV2(encPath, passphrase, tmpPath) {
  const headerLen = BUNDLE_ENC_MAGIC_V2.length + BUNDLE_ENC_V2_SALT_BYTES + BUNDLE_ENC_V2_IV_BYTES;
  const stat = await fs.promises.stat(encPath);
  if (stat.size < headerLen + BUNDLE_ENC_V2_TAG_BYTES) {
    throw new Error('Invalid encrypted bundle: file too small.');
  }
  const header = Buffer.alloc(headerLen);
  const tag = Buffer.alloc(BUNDLE_ENC_V2_TAG_BYTES);
  const tagOffset = stat.size - BUNDLE_ENC_V2_TAG_BYTES;
  let handle;
  try {
    handle = await fs.promises.open(encPath, 'r');
    const h = await handle.read(header, 0, headerLen, 0);
    if (h.bytesRead !== headerLen) throw new Error('Invalid encrypted bundle header.');
    const t = await handle.read(tag, 0, BUNDLE_ENC_V2_TAG_BYTES, tagOffset);
    if (t.bytesRead !== BUNDLE_ENC_V2_TAG_BYTES) throw new Error('Invalid encrypted bundle auth tag.');
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }

  const salt = header.subarray(BUNDLE_ENC_MAGIC_V2.length, BUNDLE_ENC_MAGIC_V2.length + BUNDLE_ENC_V2_SALT_BYTES);
  const iv = header.subarray(BUNDLE_ENC_MAGIC_V2.length + BUNDLE_ENC_V2_SALT_BYTES, headerLen);
  const key = deriveBundleKeyV2(passphrase, salt);
  if (!key) throw new Error('Invalid passphrase.');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const cipherTextLen = stat.size - headerLen - BUNDLE_ENC_V2_TAG_BYTES;

  try {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(encPath, { start: headerLen, end: headerLen + cipherTextLen - 1 });
      const output = fs.createWriteStream(tmpPath);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        input.destroy(); decipher.destroy(); output.destroy();
        fs.unlink(tmpPath, () => {});
        reject(err);
      };
      input.on('error', fail);
      decipher.on('error', fail);
      output.on('error', fail);
      input.pipe(decipher).pipe(output);
      output.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    });
  } finally {
    if (Buffer.isBuffer(key)) key.fill(0);
  }
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
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
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

      zipfile.on('entry', (entry) => {
        if (settled) return;

        if (++entryCount > MAX_RESTORE_ENTRIES) {
          return fail(`Restore bundle has too many entries (> ${MAX_RESTORE_ENTRIES}) — refusing to extract.`);
        }

        const entryPath = path.join(destDir, entry.fileName);

        // Guard against path traversal
        if (!entryPath.startsWith(destDir + path.sep) && entryPath !== destDir) {
          return fail(`Unsafe zip entry path: ${entry.fileName}`);
        }

        if (/\/$/.test(entry.fileName)) {
          // Directory entry
          fs.mkdir(entryPath, { recursive: true }, (mkdirErr) => {
            if (mkdirErr && mkdirErr.code !== 'EEXIST') return fail(mkdirErr);
            zipfile.readEntry();
          });
          return;
        }

        // Reject implausible header-declared sizes up front (cheap pre-check).
        const declared = Number(entry.uncompressedSize);
        if (Number.isFinite(declared) && (declared < 0 || totalBytes + declared > MAX_RESTORE_BYTES)) {
          return fail(`Restore bundle exceeds the maximum uncompressed size (${MAX_RESTORE_BYTES} bytes) — possible zip bomb.`);
        }

        // File entry
        fs.mkdir(path.dirname(entryPath), { recursive: true }, (mkdirErr) => {
          if (mkdirErr && mkdirErr.code !== 'EEXIST') return fail(mkdirErr);

          zipfile.openReadStream(entry, (rsErr, readStream) => {
            if (rsErr) return fail(rsErr);
            const writeStream = fs.createWriteStream(entryPath);

            // Enforce the cap against bytes actually written — a crafted bundle
            // can understate uncompressedSize, so the header check isn't enough.
            readStream.on('data', (chunk) => {
              totalBytes += chunk.length;
              if (totalBytes > MAX_RESTORE_BYTES) {
                readStream.unpipe(writeStream);
                readStream.destroy();
                writeStream.destroy();
                fail(`Restore bundle exceeds the maximum uncompressed size (${MAX_RESTORE_BYTES} bytes) — possible zip bomb.`);
              }
            });

            readStream.pipe(writeStream);
            writeStream.on('finish', () => { if (!settled) zipfile.readEntry(); });
            writeStream.on('error', fail);
            readStream.on('error', fail);
          });
        });
      });

      zipfile.on('end', () => { if (!settled) { settled = true; resolve(); } });
      zipfile.on('error', fail);
    });
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
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vision_restore_'));

  /** @type {function} */
  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true }, () => {});

  try {
    let zipPath = bundlePath;

    const encrypted = await isBundleEncrypted(bundlePath);
    if (encrypted) {
      if (!passphrase) throw new Error('This bundle is encrypted. Set a backup passphrase to restore it.');
      const decryptedPath = path.join(tmpDir, 'bundle.visionbak');
      await decryptToTemp(bundlePath, passphrase, decryptedPath);
      zipPath = decryptedPath;
    }

    await extractZip(zipPath, tmpDir);

    // metadata.json is required
    const metadataPath = path.join(tmpDir, 'metadata.json');
    let metadata;
    try {
      metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8'));
    } catch {
      throw new Error('Bundle is missing metadata.json — file may be corrupt.');
    }

    // db.sql is required
    const dbSqlPath = path.join(tmpDir, 'db.sql');
    if (!fs.existsSync(dbSqlPath)) {
      throw new Error('Bundle is missing db.sql — file may be corrupt.');
    }

    // attachments/ is optional
    const attachmentsDir = fs.existsSync(path.join(tmpDir, 'attachments'))
      ? path.join(tmpDir, 'attachments')
      : null;

    // frontend-state.json is optional
    let frontendState = null;
    const frontendStatePath = path.join(tmpDir, 'frontend-state.json');
    if (fs.existsSync(frontendStatePath)) {
      try {
        frontendState = JSON.parse(await fs.promises.readFile(frontendStatePath, 'utf8'));
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
