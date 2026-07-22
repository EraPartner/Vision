'use strict';

// ── Backup crypto / passphrase / retention ───────────────────────────────────
// Extracted verbatim from main.js (TODO.md Wave W6). Owns the backup
// passphrase lifecycle (safeStorage), key derivation (legacy v1 static-salt
// scrypt + v2 per-file salt), the v1 (CBC) / v2 (GCM) encrypted-backup file
// format, and backup retention/cleanup. main.js state (APP_NAME) and its
// settings accessors are threaded in via init() so the module observes the
// exact same values the code saw in-file.

const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Context threaded from main.js via init():
//   { APP_NAME, loadSettings, updateSettings }
let ctx = {};
function init(context) {
  ctx = context;
}

const BACKUP_ENC_MAGIC = Buffer.from('VISIONENC1');
const BACKUP_ENC_MAGIC_V2 = Buffer.from('VISIONENC2');
const BACKUP_ENC_IV_BYTES = 16;
const BACKUP_ENC_V2_SALT_BYTES = 16;
const BACKUP_ENC_V2_IV_BYTES = 12;
const BACKUP_ENC_V2_TAG_BYTES = 16;
const BACKUP_KDF_N = 1 << 15;
const BACKUP_KDF_R = 8;
const BACKUP_KDF_P = 1;
const BACKUP_RETENTION_KEEP = 7;
const BACKUP_RETENTION_GRACE_MS = 10 * 60 * 1000;

function getDefaultICloudBackupDir() {
  const root = path.join(app.getPath('home'), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  if (!fs.existsSync(root)) return '';
  return path.join(root, ctx.APP_NAME, 'Backups');
}

function resolveBackupSettingsWithDefaults(raw = {}) {
  const configuredDir = typeof raw.backupDir === 'string' ? raw.backupDir.trim() : '';
  const fallbackDir = getDefaultICloudBackupDir();
  const backupDir = configuredDir || fallbackDir || '';
  const backupOnQuit = configuredDir
    ? raw.backupOnQuit === true
    : Boolean(fallbackDir);
  return { backupDir, backupOnQuit };
}

async function getBackupDeviceId() {
  const settings = await ctx.loadSettings();
  if (typeof settings.backupDeviceId === 'string' && settings.backupDeviceId) {
    return settings.backupDeviceId;
  }
  const machineToken = [
    process.platform,
    process.arch,
    require('os').hostname(),
    app.getPath('userData'),
  ].join('|');
  const backupDeviceId = crypto.createHash('sha1').update(machineToken).digest('hex').slice(0, 8);
  await ctx.updateSettings((cur) => { cur.backupDeviceId = backupDeviceId; });
  return backupDeviceId;
}

async function getBackupPassphrase() {
  const envPassphrase = process.env.VISION_BACKUP_PASSPHRASE;
  if (envPassphrase) return envPassphrase;
  // Read the stored blob BEFORE touching safeStorage. On an unsigned/ad-hoc macOS
  // build every safeStorage call hits the keychain and triggers a password prompt,
  // so we never reach for it unless an encrypted passphrase actually exists.
  const settings = await ctx.loadSettings();
  const encoded = settings.backupPassphraseEncrypted;
  if (!encoded || typeof encoded !== 'string') return null;
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    return null;
  }
  try {
    const raw = Buffer.from(encoded, 'base64');
    return safeStorage.decryptString(raw);
  } catch {
    return null;
  }
}

async function setBackupPassphrase(passphrase) {
  if (!passphrase) {
    await ctx.updateSettings((cur) => { delete cur.backupPassphraseEncrypted; });
    return { success: true, available: true };
  }
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    return { success: false, available: false, error: 'OS secure storage is not available on this device.' };
  }
  try {
    const encrypted = safeStorage.encryptString(passphrase);
    const encoded = encrypted.toString('base64');
    await ctx.updateSettings((cur) => { cur.backupPassphraseEncrypted = encoded; });
    return { success: true, available: true };
  } catch (err) {
    return { success: false, available: true, error: String(err) };
  }
}

async function getBackupPassphraseStatus() {
  const settings = await ctx.loadSettings();
  const hasStoredPassphrase = typeof settings.backupPassphraseEncrypted === 'string' && settings.backupPassphraseEncrypted.length > 0;
  // Only probe isEncryptionAvailable() — which can trigger a keychain prompt on an
  // unsigned macOS build — when a passphrase is already stored (we need the key to
  // decrypt it anyway). With nothing stored, report availability from the API's mere
  // presence; setBackupPassphrase runs the real check when the user actually opts in.
  const hasSafeStorageApi = Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function');
  const secureStorageAvailable = hasStoredPassphrase
    ? hasSafeStorageApi && safeStorage.isEncryptionAvailable()
    : hasSafeStorageApi;
  return {
    hasEnvPassphrase: Boolean(process.env.VISION_BACKUP_PASSPHRASE),
    hasStoredPassphrase,
    secureStorageAvailable,
  };
}

function deriveBackupKeyFromPassphrase(passphrase) {
  if (!passphrase || typeof passphrase !== 'string') return null;
  // Legacy v1: static salt, default scrypt params. Kept solely for decrypting
  // pre-existing v1 backups. Do not use for new encryptions — see deriveBackupKeyV2.
  return crypto.scryptSync(passphrase, `${ctx.APP_NAME.toLowerCase()}-backup-v1`, 32);
}

function deriveBackupKeyV2(passphrase, salt) {
  if (!passphrase || typeof passphrase !== 'string') return null;
  if (!Buffer.isBuffer(salt) || salt.length !== BACKUP_ENC_V2_SALT_BYTES) {
    throw new Error('deriveBackupKeyV2 requires a 16-byte salt');
  }
  return crypto.scryptSync(passphrase, salt, 32, {
    N: BACKUP_KDF_N,
    r: BACKUP_KDF_R,
    p: BACKUP_KDF_P,
    maxmem: 128 * BACKUP_KDF_N * BACKUP_KDF_R * 2,
  });
}

async function getBackupEncryptionKey() {
  const passphrase = await getBackupPassphrase();
  return deriveBackupKeyFromPassphrase(passphrase);
}

// Sentinel error messages used to drive UI passphrase prompts. The renderer
// recognises these strings to (re-)open the passphrase modal rather than
// surfacing a generic restore failure.
const ERR_PASSPHRASE_REQUIRED = 'PASSPHRASE_REQUIRED';
const ERR_INVALID_PASSPHRASE = 'INVALID_PASSPHRASE';

async function cleanupOldBackups(destDir, deviceId, keep = BACKUP_RETENTION_KEEP, graceMs = BACKUP_RETENTION_GRACE_MS) {
  const prefix = `vision_backup_${deviceId}_`;
  const now = Date.now();
  let names = [];
  try {
    names = await fs.promises.readdir(destDir);
  } catch {
    return { removed: 0 };
  }

  const files = await Promise.all(names
    .filter((name) => name.startsWith(prefix) && (
      name.endsWith('.sql') || name.endsWith('.sql.enc') ||
      name.endsWith('.visionbak') || name.endsWith('.visionbak.enc')
    ))
    .map(async (name) => {
      const fullPath = path.join(destDir, name);
      try {
        const stat = await fs.promises.stat(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }));

  const ordered = files.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const stale = ordered.slice(keep).filter((f) => (now - f.mtimeMs) > graceMs);

  // Orphaned `*.partial` bundles are truncated writes from an interrupted
  // backup (createBundle renames partial → canonical only on clean finalize).
  // They never count toward retention; delete any older than the grace window
  // so an in-progress write is never yanked out from under the backup.
  const partials = names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.partial'))
    .map((name) => path.join(destDir, name));

  let removed = 0;
  for (const file of stale) {
    try {
      await fs.promises.unlink(file.fullPath);
      removed += 1;
    } catch {
      // ignore individual file deletion errors
    }
  }
  for (const partialPath of partials) {
    try {
      const stat = await fs.promises.stat(partialPath);
      if ((now - stat.mtimeMs) > graceMs) {
        await fs.promises.unlink(partialPath);
        removed += 1;
      }
    } catch {
      // ignore individual file deletion errors
    }
  }
  return { removed };
}

async function isEncryptedBackupFile(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const magic = Buffer.alloc(BACKUP_ENC_MAGIC.length);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (bytesRead !== BACKUP_ENC_MAGIC.length) return false;
    return magic.equals(BACKUP_ENC_MAGIC) || magic.equals(BACKUP_ENC_MAGIC_V2);
  } catch {
    return false;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }
}

async function decryptBackupFileToTemp(encryptedFilePath, keyOrPassphrase) {
  if (!keyOrPassphrase) {
    throw new Error(ERR_PASSPHRASE_REQUIRED);
  }

  // Read magic to determine version.
  const magicLen = BACKUP_ENC_MAGIC.length;
  const magicBuf = Buffer.alloc(magicLen);
  let handle;
  try {
    handle = await fs.promises.open(encryptedFilePath, 'r');
    const { bytesRead } = await handle.read(magicBuf, 0, magicLen, 0);
    if (bytesRead !== magicLen) {
      throw new Error('Invalid encrypted backup header.');
    }
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }

  if (magicBuf.equals(BACKUP_ENC_MAGIC_V2)) {
    return decryptBackupV2(encryptedFilePath, keyOrPassphrase);
  }
  if (magicBuf.equals(BACKUP_ENC_MAGIC)) {
    return decryptBackupV1(encryptedFilePath, keyOrPassphrase);
  }
  throw new Error('Backup is not in a supported encrypted format.');
}

async function decryptBackupV1(encryptedFilePath, keyOrPassphrase) {
  const key = Buffer.isBuffer(keyOrPassphrase)
    ? keyOrPassphrase
    : deriveBackupKeyFromPassphrase(keyOrPassphrase);
  if (!key) throw new Error(ERR_PASSPHRASE_REQUIRED);

  const headerLen = BACKUP_ENC_MAGIC.length + BACKUP_ENC_IV_BYTES;
  const header = Buffer.alloc(headerLen);
  let handle;
  try {
    handle = await fs.promises.open(encryptedFilePath, 'r');
    const { bytesRead } = await handle.read(header, 0, headerLen, 0);
    if (bytesRead !== headerLen) throw new Error('Invalid encrypted backup header.');
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }

  const iv = header.subarray(BACKUP_ENC_MAGIC.length, headerLen);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const tempSqlPath = path.join(app.getPath('temp'), `vision_restore_${Date.now()}_${process.pid}.sql`);

  try {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(encryptedFilePath, { start: headerLen });
      const output = fs.createWriteStream(tempSqlPath);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        input.destroy(); decipher.destroy(); output.destroy();
        fs.unlink(tempSqlPath, () => {});
        reject(err);
      };
      input.on('error', fail);
      decipher.on('error', fail);
      output.on('error', fail);
      input.pipe(decipher).pipe(output);
      output.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : '';
    if (/bad decrypt/i.test(msg) || /wrong final block/i.test(msg) || (err && err.code === 'ERR_OSSL_BAD_DECRYPT')) {
      throw new Error(ERR_INVALID_PASSPHRASE);
    }
    throw err;
  } finally {
    if (typeof keyOrPassphrase === 'string' && Buffer.isBuffer(key)) key.fill(0);
  }

  return tempSqlPath;
}

async function decryptBackupV2(encryptedFilePath, keyOrPassphrase) {
  const headerLen = BACKUP_ENC_MAGIC_V2.length + BACKUP_ENC_V2_SALT_BYTES + BACKUP_ENC_V2_IV_BYTES;
  const header = Buffer.alloc(headerLen);
  const stat = await fs.promises.stat(encryptedFilePath);
  if (stat.size < headerLen + BACKUP_ENC_V2_TAG_BYTES) {
    throw new Error('Invalid encrypted backup: file too small.');
  }
  const tagOffset = stat.size - BACKUP_ENC_V2_TAG_BYTES;
  const tag = Buffer.alloc(BACKUP_ENC_V2_TAG_BYTES);
  let handle;
  try {
    handle = await fs.promises.open(encryptedFilePath, 'r');
    const h = await handle.read(header, 0, headerLen, 0);
    if (h.bytesRead !== headerLen) throw new Error('Invalid encrypted backup header.');
    const t = await handle.read(tag, 0, BACKUP_ENC_V2_TAG_BYTES, tagOffset);
    if (t.bytesRead !== BACKUP_ENC_V2_TAG_BYTES) throw new Error('Invalid encrypted backup auth tag.');
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }

  const salt = header.subarray(BACKUP_ENC_MAGIC_V2.length, BACKUP_ENC_MAGIC_V2.length + BACKUP_ENC_V2_SALT_BYTES);
  const iv = header.subarray(BACKUP_ENC_MAGIC_V2.length + BACKUP_ENC_V2_SALT_BYTES, headerLen);

  let key;
  if (Buffer.isBuffer(keyOrPassphrase)) {
    key = keyOrPassphrase;
  } else {
    key = deriveBackupKeyV2(keyOrPassphrase, salt);
  }
  if (!key) throw new Error(ERR_PASSPHRASE_REQUIRED);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const tempSqlPath = path.join(app.getPath('temp'), `vision_restore_${Date.now()}_${process.pid}.sql`);

  const cipherTextLen = stat.size - headerLen - BACKUP_ENC_V2_TAG_BYTES;
  try {
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(encryptedFilePath, { start: headerLen, end: headerLen + cipherTextLen - 1 });
      const output = fs.createWriteStream(tempSqlPath);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        input.destroy(); decipher.destroy(); output.destroy();
        fs.unlink(tempSqlPath, () => {});
        reject(err);
      };
      input.on('error', fail);
      decipher.on('error', fail);
      output.on('error', fail);
      input.pipe(decipher).pipe(output);
      output.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : '';
    if (
      /unable to authenticate/i.test(msg)
      || /bad decrypt/i.test(msg)
      || /unsupported state/i.test(msg)
      || (err && err.code === 'ERR_OSSL_BAD_DECRYPT')
      || (err && err.code === 'ERR_CRYPTO_INVALID_AUTH_TAG')
    ) {
      throw new Error(ERR_INVALID_PASSPHRASE);
    }
    throw err;
  } finally {
    if (typeof keyOrPassphrase === 'string' && Buffer.isBuffer(key)) key.fill(0);
  }

  return tempSqlPath;
}

module.exports = {
  init,
  getDefaultICloudBackupDir,
  resolveBackupSettingsWithDefaults,
  getBackupDeviceId,
  getBackupPassphrase,
  setBackupPassphrase,
  getBackupPassphraseStatus,
  deriveBackupKeyFromPassphrase,
  deriveBackupKeyV2,
  getBackupEncryptionKey,
  ERR_PASSPHRASE_REQUIRED,
  ERR_INVALID_PASSPHRASE,
  cleanupOldBackups,
  isEncryptedBackupFile,
  decryptBackupFileToTemp,
};
