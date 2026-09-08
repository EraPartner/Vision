"use strict";

// ── Backup crypto / passphrase / retention ───────────────────────────────────
// Extracted verbatim from main.js (TODO.md Wave W6). Owns the backup
// passphrase lifecycle (safeStorage), key derivation (legacy v1 static-salt
// scrypt + v2 per-file salt), the v1 (CBC) / v2 (GCM) encrypted-backup file
// format, and backup retention/cleanup. main.js state (APP_NAME) and its
// settings accessors are threaded in via init() so the module observes the
// exact same values the code saw in-file.

const { app, safeStorage } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  deriveKeyV1,
  deriveKeyV2,
  isEncryptedFile,
  decryptFile,
} = require("./encrypted-file");

// Context threaded from main.js via init():
//   { APP_NAME, loadSettings, updateSettings }
let ctx = {};
function init(context) {
  ctx = context;
}

const BACKUP_ENC_MAGIC = Buffer.from("VISIONENC1");
const BACKUP_ENC_MAGIC_V2 = Buffer.from("VISIONENC2");
const BACKUP_RETENTION_KEEP = 7;
const BACKUP_RETENTION_GRACE_MS = 10 * 60 * 1000;

function getDefaultICloudBackupDir() {
  const root = path.join(
    app.getPath("home"),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
  );
  if (!fs.existsSync(root)) return "";
  return path.join(root, ctx.APP_NAME, "Backups");
}

function resolveBackupSettingsWithDefaults(raw = {}) {
  const configuredDir =
    typeof raw.backupDir === "string" ? raw.backupDir.trim() : "";
  const fallbackDir = getDefaultICloudBackupDir();
  const backupDir = configuredDir || fallbackDir || "";
  const backupOnQuit = configuredDir
    ? raw.backupOnQuit === true
    : Boolean(fallbackDir);
  return { backupDir, backupOnQuit };
}

async function getBackupDeviceId() {
  const settings = await ctx.loadSettings();
  if (typeof settings.backupDeviceId === "string" && settings.backupDeviceId) {
    return settings.backupDeviceId;
  }
  const machineToken = [
    process.platform,
    process.arch,
    require("os").hostname(),
    app.getPath("userData"),
  ].join("|");
  const backupDeviceId = crypto
    .createHash("sha1")
    .update(machineToken)
    .digest("hex")
    .slice(0, 8);
  await ctx.updateSettings((cur) => {
    cur.backupDeviceId = backupDeviceId;
  });
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
  if (!encoded || typeof encoded !== "string") return null;
  if (
    !safeStorage ||
    typeof safeStorage.isEncryptionAvailable !== "function" ||
    !safeStorage.isEncryptionAvailable()
  ) {
    return null;
  }
  try {
    const raw = Buffer.from(encoded, "base64");
    return safeStorage.decryptString(raw);
  } catch {
    return null;
  }
}

async function setBackupPassphrase(passphrase) {
  if (!passphrase) {
    await ctx.updateSettings((cur) => {
      delete cur.backupPassphraseEncrypted;
    });
    return { success: true, available: true };
  }
  if (
    !safeStorage ||
    typeof safeStorage.isEncryptionAvailable !== "function" ||
    !safeStorage.isEncryptionAvailable()
  ) {
    return {
      success: false,
      available: false,
      error: "OS secure storage is not available on this device.",
    };
  }
  try {
    const encrypted = safeStorage.encryptString(passphrase);
    const encoded = encrypted.toString("base64");
    await ctx.updateSettings((cur) => {
      cur.backupPassphraseEncrypted = encoded;
    });
    return { success: true, available: true };
  } catch (err) {
    return { success: false, available: true, error: String(err) };
  }
}

async function getBackupPassphraseStatus() {
  const settings = await ctx.loadSettings();
  const hasStoredPassphrase =
    typeof settings.backupPassphraseEncrypted === "string" &&
    settings.backupPassphraseEncrypted.length > 0;
  // Only probe isEncryptionAvailable() — which can trigger a keychain prompt on an
  // unsigned macOS build — when a passphrase is already stored (we need the key to
  // decrypt it anyway). With nothing stored, report availability from the API's mere
  // presence; setBackupPassphrase runs the real check when the user actually opts in.
  const hasSafeStorageApi = Boolean(
    safeStorage && typeof safeStorage.isEncryptionAvailable === "function",
  );
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
  return deriveKeyV1(passphrase, `${ctx.APP_NAME.toLowerCase()}-backup-v1`);
}

function deriveBackupKeyV2(passphrase, salt) {
  if (!passphrase || typeof passphrase !== "string") return null;
  if (!Buffer.isBuffer(salt) || salt.length !== 16) {
    throw new Error("deriveBackupKeyV2 requires a 16-byte salt");
  }
  return deriveKeyV2(passphrase, salt);
}

async function getBackupEncryptionKey() {
  const passphrase = await getBackupPassphrase();
  return deriveBackupKeyFromPassphrase(passphrase);
}

// Sentinel error messages used to drive UI passphrase prompts. The renderer
// recognises these strings to (re-)open the passphrase modal rather than
// surfacing a generic restore failure.
const ERR_PASSPHRASE_REQUIRED = "PASSPHRASE_REQUIRED";
const ERR_INVALID_PASSPHRASE = "INVALID_PASSPHRASE";

async function cleanupOldBackups(
  destDir,
  deviceId,
  keep = BACKUP_RETENTION_KEEP,
  graceMs = BACKUP_RETENTION_GRACE_MS,
) {
  const prefix = `vision_backup_${deviceId}_`;
  const now = Date.now();
  let names = [];
  try {
    names = await fs.promises.readdir(destDir);
  } catch {
    return { removed: 0 };
  }

  const files = await Promise.all(
    names
      .filter(
        (name) =>
          name.startsWith(prefix) &&
          (name.endsWith(".sql") ||
            name.endsWith(".sql.enc") ||
            name.endsWith(".visionbak") ||
            name.endsWith(".visionbak.enc")),
      )
      .map(async (name) => {
        const fullPath = path.join(destDir, name);
        try {
          const stat = await fs.promises.stat(fullPath);
          return { fullPath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      }),
  );

  const ordered = files.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const stale = ordered.slice(keep).filter((f) => now - f.mtimeMs > graceMs);

  // Orphaned `*.partial` bundles are truncated writes from an interrupted
  // backup (createBundle renames partial → canonical only on clean finalize).
  // They never count toward retention; delete any older than the grace window
  // so an in-progress write is never yanked out from under the backup.
  const partials = names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".partial"))
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
      if (now - stat.mtimeMs > graceMs) {
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
  return isEncryptedFile(filePath, [BACKUP_ENC_MAGIC, BACKUP_ENC_MAGIC_V2]);
}

async function decryptBackupFileToTemp(encryptedFilePath, keyOrPassphrase) {
  const tempSqlPath = path.join(
    app.getPath("temp"),
    "vision_restore_" + Date.now() + "_" + process.pid + ".sql",
  );
  await decryptFile({
    encryptedPath: encryptedFilePath,
    destinationPath: tempSqlPath,
    keyOrPassphrase,
    v1Magic: BACKUP_ENC_MAGIC,
    v2Magic: BACKUP_ENC_MAGIC_V2,
    v1Salt: ctx.APP_NAME.toLowerCase() + "-backup-v1",
    requiredError: ERR_PASSPHRASE_REQUIRED,
    invalidError: ERR_INVALID_PASSPHRASE,
    invalidHeaderMessage: "Invalid encrypted backup header.",
    unsupportedFormatMessage: "Backup is not in a supported encrypted format.",
  });
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
