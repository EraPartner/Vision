import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUNDLE_DATABASE_MEMBER,
  createBundle,
  encryptBundle,
  openBundle,
  isBundleEncrypted,
} from "./bundle";
import type { OpenedBundle } from "./bundle";
import {
  getBackupDeviceId,
  getBackupPassphrase,
  cleanupOldBackups,
  isEncryptedBackupFile,
  decryptBackupFileToTemp,
  ERR_PASSPHRASE_REQUIRED,
  ERR_INVALID_PASSPHRASE,
} from "./crypto";
import { restoreNativeBundle, restoreNativeDatabase } from "./native-transport";
import {
  SQLITE_HEADER_BYTES,
  isSqliteDatabaseFile,
  parseSqliteHeader,
  readFileHead,
} from "../runtime/database-stats";
import { packagedMigrationVersion } from "../runtime/native";
import { validateBackupDest } from "../runtime/ipc-schemas";
import type { NativeRestoreRuntime } from "./native-transport";

/** What the runtime reports about a verified database snapshot. */
export interface DatabaseSnapshotReport {
  schemaVersion: number;
  sqliteVersion?: string | undefined;
  sha256?: string | undefined;
  bytes?: number | undefined;
}

/** The native runtime operations backup and restore use. */
export interface NativeBackupRuntime extends NativeRestoreRuntime {
  mode: "native";
  snapshotDatabase(destination: string): Promise<DatabaseSnapshotReport>;
  exportAttachments(destination: string): Promise<unknown>;
}

/** Context threaded from main via init(). */
export interface RestoreContext {
  withBackupSnapshot?: <T>(capture: () => Promise<T>) => Promise<T>;
  workDir?: () => string | undefined;
  repoRootFallback?: string;
  /** Returns the active runtime; only a runtime whose mode is "native" is used. */
  runtimeProvider?: () => unknown;
  // Passed by main but not used by this module.
  appPort?: unknown;
  pollHealth?: unknown;
  HEALTH_POLL_BUILD_ATTEMPTS?: unknown;
}

export interface RestoreRequestOptions {
  passphrase?: string | null | undefined;
}

export interface BundleBackupResult {
  success: true;
  file: string;
  encrypted: boolean;
  warning: string | undefined;
  cleanupRemoved: number;
}

export interface BundleRestoreResult {
  success: true;
  file: string;
  frontendState: unknown;
  warning: string | undefined;
}

let ctx: RestoreContext = {};

export function init(context: RestoreContext): void {
  ctx = context;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The runtime is trusted to implement the native contract once it reports
// mode "native", as the shell creates it.
function isNativeRuntime(runtime: unknown): runtime is NativeBackupRuntime {
  return isRecord(runtime) && runtime.mode === "native";
}

function getNativeRuntime(): NativeBackupRuntime {
  const runtime =
    typeof ctx.runtimeProvider === "function" ? ctx.runtimeProvider() : null;
  if (!isNativeRuntime(runtime)) {
    const error = Object.assign(
      new Error("Vision backup and restore require the native runtime"),
      { code: "NATIVE_RUNTIME_REQUIRED" },
    );
    throw error;
  }
  return runtime;
}

export function resolveDatabaseEnvironment(): Promise<{
  nativeRuntime: NativeBackupRuntime;
}> {
  // Deferred so a missing native runtime rejects instead of throwing.
  return Promise.resolve().then(() => ({ nativeRuntime: getNativeRuntime() }));
}

function notVisionBackupError(): Error & { code: string } {
  return Object.assign(
    new Error(
      "This file is not a Vision backup. Choose a .visionbak backup or a Vision SQLite database file.",
    ),
    { code: "BACKUP_UNRECOGNIZED" },
  );
}

/** Highest migration shipped with this install, from db/migrations; 0 when unknown. */
function getLocalMigrationVersion(): number {
  try {
    const root = ctx.workDir?.() || ctx.repoRootFallback;
    if (typeof root !== "string") return 0;
    return packagedMigrationVersion(path.join(root, "db", "migrations"));
  } catch {
    return 0;
  }
}

/**
 * Refuses a backup whose schema is newer than this install, with the marker
 * the renderer turns into an "update Vision" message. Restore verification
 * enforces the same rule on the database itself.
 */
export function assertBackupSchemaCompatible(
  candidate: number,
  current: number,
  noun = "backup",
): void {
  if (!Number.isSafeInteger(candidate) || !Number.isSafeInteger(current))
    return;
  if (current <= 0 || candidate <= current) return;
  throw new Error(
    `BUNDLE_SCHEMA_NEWER: This ${noun} was created on schema version ${candidate} ` +
      `but this Vision install is at ${current}. Update Vision to a newer version and retry.`,
  );
}

/** metadata.json is untrusted: only well-formed values become restore expectations. */
function metadataSchemaVersion(metadata: OpenedBundle["metadata"]): number | undefined {
  const value = metadata.schemaVersion;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function metadataSha256(metadata: OpenedBundle["metadata"]): string | undefined {
  const value = metadata.databaseSha256;
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? value
    : undefined;
}

export async function runBundleBackup(
  destDir: string,
  frontendStateJson: unknown = null,
): Promise<BundleBackupResult> {
  if (!destDir) throw new Error("No backup directory configured");
  // Every caller lands here, including the quit-time backup whose folder comes
  // from the stored setting, so the destination is checked at use as well.
  const destError = validateBackupDest(destDir);
  if (destError) throw new Error(destError);
  const nativeRuntime = getNativeRuntime();
  const deviceId = await getBackupDeviceId();
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision_bak_"),
  );
  const databasePath = path.join(tmpDir, BUNDLE_DATABASE_MEMBER);
  const attachmentsDir = path.join(tmpDir, "attachments");
  try {
    if (!ctx.withBackupSnapshot)
      throw new Error("Consistent native backup capture is unavailable");
    // The backend is stopped while both halves are captured, so the database
    // snapshot and the attachment tree describe the same moment.
    const database = await ctx.withBackupSnapshot(async () => {
      const report = await nativeRuntime.snapshotDatabase(databasePath);
      await nativeRuntime.exportAttachments(attachmentsDir);
      return report;
    });
    let frontendState: unknown = null;
    if (frontendStateJson) {
      try {
        frontendState =
          typeof frontendStateJson === "string"
            ? JSON.parse(frontendStateJson)
            : frontendStateJson;
      } catch {
        // Invalid optional UI state does not invalidate the database backup.
      }
    }
    // With a passphrase, the plaintext archive is built in the private
    // staging directory and only its encrypted form reaches destDir.
    const passphrase = await getBackupPassphrase();
    const { bundlePath } = await createBundle({
      destDir: passphrase ? tmpDir : destDir,
      deviceId,
      appVersion:
        typeof app.getVersion === "function" ? app.getVersion() : "unknown",
      databasePath,
      database: {
        schemaVersion: database.schemaVersion,
        sqliteVersion: database.sqliteVersion,
        sha256: database.sha256,
        bytes: database.bytes,
      },
      attachmentsDir,
      frontendState,
    });
    let finalFile = bundlePath;
    let encrypted = false;
    let warning: string | undefined;
    if (passphrase) {
      ({ encPath: finalFile } = await encryptBundle(bundlePath, passphrase, {
        destDir,
      }));
      encrypted = true;
    } else {
      warning = "Backup encryption skipped: no passphrase configured.";
    }
    const cleanup = await cleanupOldBackups(destDir, deviceId);
    return {
      success: true,
      file: finalFile,
      encrypted,
      warning,
      cleanupRemoved: cleanup.removed,
    };
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

export async function runBundleRestore(
  bundlePath: string,
  { passphrase }: RestoreRequestOptions = {},
): Promise<BundleRestoreResult> {
  if (!bundlePath) throw new Error("No backup file specified");
  if (!fs.existsSync(bundlePath))
    throw new Error(`File not found: ${bundlePath}`);
  const encrypted = await isBundleEncrypted(bundlePath);
  let effectivePassphrase: string | null = null;
  if (encrypted) {
    effectivePassphrase = passphrase || (await getBackupPassphrase());
    if (!effectivePassphrase) throw new Error(ERR_PASSPHRASE_REQUIRED);
  }
  let opened: OpenedBundle;
  try {
    opened = await openBundle(bundlePath, { passphrase: effectivePassphrase });
  } catch (error) {
    const details = isRecord(error) ? error : {};
    const message = typeof details.message === "string" ? details.message : "";
    if (
      encrypted &&
      (/bad decrypt|wrong final block|unable to authenticate|missing metadata\.json|missing db\.sqlite3|end of central directory|not a zip file/i.test(
        message,
      ) ||
        details.code === "ERR_OSSL_BAD_DECRYPT" ||
        details.code === "ERR_CRYPTO_INVALID_AUTH_TAG")
    ) {
      throw new Error(ERR_INVALID_PASSPHRASE);
    }
    throw error;
  }
  const { metadata, databasePath, attachmentsDir, frontendState, cleanup } =
    opened;
  try {
    const nativeRuntime = getNativeRuntime();
    // metadata.json is untrusted bundle content. Activation verifies the
    // database itself and refuses it unless it matches what metadata recorded.
    const declaredVersion = metadataSchemaVersion(metadata);
    if (declaredVersion !== undefined)
      assertBackupSchemaCompatible(
        declaredVersion,
        getLocalMigrationVersion(),
        "bundle",
      );
    const restore = await restoreNativeBundle(nativeRuntime, {
      databasePath,
      attachmentsDir,
      expectedSchemaVersion: declaredVersion,
      expectedSha256: metadataSha256(metadata),
    });
    const cleanupWarning = restore.cleanupWarning;
    return {
      success: true,
      file: bundlePath,
      frontendState,
      warning:
        isRecord(cleanupWarning) && typeof cleanupWarning.message === "string"
          ? cleanupWarning.message
          : undefined,
    };
  } finally {
    cleanup();
  }
}

/** user_version of a SQLite file, or undefined when its header cannot be read. */
async function sqliteFileSchemaVersion(file: string): Promise<number | undefined> {
  try {
    return parseSqliteHeader(await readFileHead(file, SQLITE_HEADER_BYTES))
      .userVersion;
  } catch {
    return undefined;
  }
}

/**
 * Restores a bare database file: a Vision SQLite database (for example a
 * pre-migration backup the backend wrote), optionally encrypted. Any other
 * file is refused.
 */
export async function runRestore(
  filePath: string,
  { passphrase }: RestoreRequestOptions = {},
): Promise<{ success: true; file: string }> {
  if (!filePath) throw new Error("No backup file specified");
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  let restoreSource = filePath;
  let cleanupRestoreSource = () => {};
  if (await isEncryptedBackupFile(filePath)) {
    const effectivePassphrase = passphrase || (await getBackupPassphrase());
    if (!effectivePassphrase) throw new Error(ERR_PASSPHRASE_REQUIRED);
    restoreSource = await decryptBackupFileToTemp(
      filePath,
      effectivePassphrase,
    );
    cleanupRestoreSource = () => fs.unlink(restoreSource, () => {});
  }
  try {
    if (!(await isSqliteDatabaseFile(restoreSource)))
      throw notVisionBackupError();
    const nativeRuntime = getNativeRuntime();
    const fileVersion = await sqliteFileSchemaVersion(restoreSource);
    if (fileVersion !== undefined)
      assertBackupSchemaCompatible(fileVersion, getLocalMigrationVersion());
    await restoreNativeDatabase(nativeRuntime, restoreSource);
    return { success: true, file: filePath };
  } finally {
    cleanupRestoreSource();
  }
}
