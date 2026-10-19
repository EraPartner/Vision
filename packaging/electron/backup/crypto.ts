// ── Backup crypto / passphrase / retention ───────────────────────────────────
// Extracted verbatim from main.js (TODO.md Wave W6). Owns the backup
// passphrase lifecycle (safeStorage), the v2 (GCM, per-file salt) encrypted
// backup file format (the retired v1 CBC format is refused by name), and backup
// retention/cleanup. main.js state (APP_NAME) and its
// settings accessors are threaded in via init() so the module observes the
// exact same values the code saw in-file.

import { app, safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RETIRED_V1_MESSAGE,
  isEncryptedFile,
  decryptFile,
} from "./encrypted-file";

/** The persisted settings fields this module reads and writes. */
export interface BackupCryptoSettings {
  backupDeviceId?: unknown;
  backupPassphraseEncrypted?: unknown;
}

/** Context threaded from main.js via init(). */
export interface BackupCryptoContext {
  APP_NAME: string;
  loadSettings(): Promise<BackupCryptoSettings>;
  updateSettings(mutate: (current: BackupCryptoSettings) => void): unknown;
}

export interface BackupSettingsInput {
  backupDir?: unknown;
  backupOnQuit?: unknown;
}

export interface PassphraseUpdateResult {
  success: boolean;
  available: boolean;
  error?: string;
}

export interface PassphraseStatus {
  hasEnvPassphrase: boolean;
  hasStoredPassphrase: boolean;
  secureStorageAvailable: boolean;
}

let ctx: BackupCryptoContext | undefined;
export function init(context: BackupCryptoContext): void {
  ctx = context;
}

// Like the original empty context, use before init() fails with a TypeError.
function context(): BackupCryptoContext {
  if (!ctx) throw new TypeError("backup/crypto used before init()");
  return ctx;
}

const BACKUP_ENC_MAGIC = Buffer.from("VISIONENC1");
const BACKUP_ENC_MAGIC_V2 = Buffer.from("VISIONENC2");
const BACKUP_RETENTION_KEEP = 7;
const BACKUP_RETENTION_GRACE_MS = 10 * 60 * 1000;

export function getDefaultICloudBackupDir(): string {
  const root = path.join(
    app.getPath("home"),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
  );
  if (!fs.existsSync(root)) return "";
  return path.join(root, context().APP_NAME, "Backups");
}

export function resolveBackupSettingsWithDefaults(
  raw: BackupSettingsInput = {},
): { backupDir: string; backupOnQuit: boolean } {
  const configuredDir =
    typeof raw.backupDir === "string" ? raw.backupDir.trim() : "";
  const fallbackDir = getDefaultICloudBackupDir();
  const backupDir = configuredDir || fallbackDir || "";
  const backupOnQuit = configuredDir
    ? raw.backupOnQuit === true
    : Boolean(fallbackDir);
  return { backupDir, backupOnQuit };
}

export async function getBackupDeviceId(): Promise<string> {
  const settings = await context().loadSettings();
  if (typeof settings.backupDeviceId === "string" && settings.backupDeviceId) {
    return settings.backupDeviceId;
  }
  const machineToken = [
    process.platform,
    process.arch,
    os.hostname(),
    app.getPath("userData"),
  ].join("|");
  const backupDeviceId = crypto
    .createHash("sha1")
    .update(machineToken)
    .digest("hex")
    .slice(0, 8);
  await context().updateSettings((cur) => {
    cur.backupDeviceId = backupDeviceId;
  });
  return backupDeviceId;
}

export async function getBackupPassphrase(): Promise<string | null> {
  const envPassphrase = process.env.VISION_BACKUP_PASSPHRASE;
  if (envPassphrase) return envPassphrase;
  // Read the stored blob BEFORE touching safeStorage. On an unsigned/ad-hoc macOS
  // build every safeStorage call hits the keychain and triggers a password prompt,
  // so we never reach for it unless an encrypted passphrase actually exists.
  const settings = await context().loadSettings();
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

export async function setBackupPassphrase(
  passphrase: string | null | undefined,
): Promise<PassphraseUpdateResult> {
  if (!passphrase) {
    await context().updateSettings((cur) => {
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
    await context().updateSettings((cur) => {
      cur.backupPassphraseEncrypted = encoded;
    });
    return { success: true, available: true };
  } catch (err) {
    return { success: false, available: true, error: String(err) };
  }
}

export async function getBackupPassphraseStatus(): Promise<PassphraseStatus> {
  const settings = await context().loadSettings();
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

// Sentinel error messages used to drive UI passphrase prompts. The renderer
// recognises these strings to (re-)open the passphrase modal rather than
// surfacing a generic restore failure.
export const ERR_PASSPHRASE_REQUIRED = "PASSPHRASE_REQUIRED";
export const ERR_INVALID_PASSPHRASE = "INVALID_PASSPHRASE";

interface BackupFileStat {
  fullPath: string;
  mtimeMs: number;
}

export async function cleanupOldBackups(
  destDir: string,
  deviceId: string,
  keep: number = BACKUP_RETENTION_KEEP,
  graceMs: number = BACKUP_RETENTION_GRACE_MS,
): Promise<{ removed: number }> {
  const prefix = `vision_backup_${deviceId}_`;
  const now = Date.now();
  let names: string[] = [];
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
      .map(async (name): Promise<BackupFileStat | null> => {
        const fullPath = path.join(destDir, name);
        try {
          const stat = await fs.promises.stat(fullPath);
          return { fullPath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      }),
  );

  const ordered = files
    .filter((file): file is BackupFileStat => file !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
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

export async function isEncryptedBackupFile(
  filePath: string,
): Promise<boolean> {
  return isEncryptedFile(filePath, [BACKUP_ENC_MAGIC, BACKUP_ENC_MAGIC_V2]);
}

export async function decryptBackupFileToTemp(
  encryptedFilePath: string,
  keyOrPassphrase: string | Buffer | null | undefined,
): Promise<string> {
  const tempSqlPath = path.join(
    app.getPath("temp"),
    "vision_restore_" + Date.now() + "_" + process.pid + ".sql",
  );
  await decryptFile({
    encryptedPath: encryptedFilePath,
    destinationPath: tempSqlPath,
    keyOrPassphrase,
    retiredV1Magic: BACKUP_ENC_MAGIC,
    v2Magic: BACKUP_ENC_MAGIC_V2,
    requiredError: ERR_PASSPHRASE_REQUIRED,
    invalidError: ERR_INVALID_PASSPHRASE,
    invalidHeaderMessage: "Invalid encrypted backup header.",
    unsupportedFormatMessage: "Backup is not in a supported encrypted format.",
    retiredFormatMessage: RETIRED_V1_MESSAGE,
  });
  return tempSqlPath;
}
