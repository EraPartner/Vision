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

const archiver = require('archiver');
const yauzl = require('yauzl');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Magic bytes written at the start of every encrypted bundle. */
const BUNDLE_ENC_MAGIC = Buffer.from('VISIONBAK1');

/** IV length used for AES-256-CBC encryption. */
const BUNDLE_ENC_IV_BYTES = 16;

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
 * Encrypt a bundle in-place with AES-256-CBC.
 * Writes the encrypted file as `<bundlePath>.enc`, deletes the original.
 *
 * @param {string} bundlePath
 * @param {Buffer} key - 32-byte AES key (from scrypt)
 * @returns {Promise<{encPath: string}>}
 */
async function encryptBundle(bundlePath, key) {
  const encPath = `${bundlePath}.enc`;
  const iv = crypto.randomBytes(BUNDLE_ENC_IV_BYTES);

  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(bundlePath);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
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

    // Write header: magic + IV
    output.write(BUNDLE_ENC_MAGIC);
    output.write(iv);

    input.pipe(cipher).pipe(output);

    output.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });

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
    return bytesRead === headerLen && buf.equals(BUNDLE_ENC_MAGIC);
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
 * Decrypt an encrypted bundle to a temporary file.
 *
 * @param {string} encPath
 * @param {Buffer} key - 32-byte AES key
 * @param {string} tmpPath - destination path for decrypted output
 * @returns {Promise<void>}
 */
async function decryptToTemp(encPath, key, tmpPath) {
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

  const magic = header.subarray(0, BUNDLE_ENC_MAGIC.length);
  if (!magic.equals(BUNDLE_ENC_MAGIC)) throw new Error('Bundle is not in a recognised encrypted format.');

  const iv = header.subarray(BUNDLE_ENC_MAGIC.length, headerLen);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(encPath, { start: headerLen });
    const output = fs.createWriteStream(tmpPath);

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      input.destroy();
      decipher.destroy();
      output.destroy();
      fs.unlink(tmpPath, () => {});
      reject(err);
    };

    input.on('error', fail);
    decipher.on('error', fail);
    output.on('error', fail);

    input.pipe(decipher).pipe(output);

    output.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
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
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err);

      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        const entryPath = path.join(destDir, entry.fileName);

        // Guard against path traversal
        if (!entryPath.startsWith(destDir + path.sep) && entryPath !== destDir) {
          return reject(new Error(`Unsafe zip entry path: ${entry.fileName}`));
        }

        if (/\/$/.test(entry.fileName)) {
          // Directory entry
          fs.mkdir(entryPath, { recursive: true }, (mkdirErr) => {
            if (mkdirErr && mkdirErr.code !== 'EEXIST') return reject(mkdirErr);
            zipfile.readEntry();
          });
          return;
        }

        // File entry
        fs.mkdir(path.dirname(entryPath), { recursive: true }, (mkdirErr) => {
          if (mkdirErr && mkdirErr.code !== 'EEXIST') return reject(mkdirErr);

          zipfile.openReadStream(entry, (rsErr, readStream) => {
            if (rsErr) return reject(rsErr);
            const writeStream = fs.createWriteStream(entryPath);
            readStream.pipe(writeStream);
            writeStream.on('finish', () => zipfile.readEntry());
            writeStream.on('error', reject);
            readStream.on('error', reject);
          });
        });
      });

      zipfile.on('end', resolve);
      zipfile.on('error', reject);
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
async function openBundle(bundlePath, { key } = {}) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vision_restore_'));

  /** @type {function} */
  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true }, () => {});

  try {
    let zipPath = bundlePath;

    const encrypted = await isBundleEncrypted(bundlePath);
    if (encrypted) {
      if (!key) throw new Error('This bundle is encrypted. Set a backup passphrase to restore it.');
      const decryptedPath = path.join(tmpDir, 'bundle.visionbak');
      await decryptToTemp(bundlePath, key, decryptedPath);
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
  BUNDLE_ENC_IV_BYTES,
  BUNDLE_VERSION,
};
