import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
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
import type { NativeRestoreRuntime } from "./native-transport";

/** The native runtime operations backup and restore use. */
export interface NativeBackupRuntime extends NativeRestoreRuntime {
  mode: "native";
  dumpDatabase(
    destination: string,
    options: { format: "plain" },
  ): Promise<unknown>;
  exportAttachments(destination: string): Promise<unknown>;
  getSchemaHead(): Promise<string | undefined>;
}

/** Context threaded from main via init(). */
export interface RestoreContext {
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
  passphrase?: string | null;
  allowUnverifiedAudit?: boolean;
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

export async function resolveDatabaseEnvironment(): Promise<{
  nativeRuntime: NativeBackupRuntime;
}> {
  return { nativeRuntime: getNativeRuntime() };
}

function revisionNumericPrefix(rev: string): number | null {
  const match = /^(\d+)/.exec(String(rev || ""));
  return match?.[1] !== undefined ? parseInt(match[1], 10) : null;
}

function getLocalMigrationChainHead(): string {
  try {
    const root = ctx.workDir?.() || ctx.repoRootFallback;
    // path.join() rejects a missing root; that is "no local chain".
    if (typeof root !== "string") return "";
    const versionsDir = path.join(root, "alembic", "versions");
    let best = "";
    for (const filename of fs.readdirSync(versionsDir)) {
      if (!filename.endsWith(".py") || filename.startsWith("_")) continue;
      const revision = filename.slice(0, -3);
      const candidate = revisionNumericPrefix(revision);
      const current = revisionNumericPrefix(best);
      if (candidate != null && (current == null || candidate > current))
        best = revision;
    }
    return best;
  } catch {
    return "";
  }
}

function readDumpSchemaHead(sqlPath: string): Promise<string> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(sqlPath, { encoding: "utf8" });
    const lines = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    let inCopyBlock = false;
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
      lines.close();
      stream.destroy();
    };
    lines.on("line", (line) => {
      if (inCopyBlock) {
        const value = line.trim();
        finish(value === "\\." ? "" : value);
        return;
      }
      if (
        /^COPY\s+(?:"?[\w$]+"?\.)?"?alembic_version"?\s*\("?version_num"?\)\s+FROM\s+stdin;/i.test(
          line,
        )
      ) {
        inCopyBlock = true;
        return;
      }
      const insert = line.match(
        /^INSERT INTO\s+(?:"?[\w$]+"?\.)?"?alembic_version"?\s*(?:\("?version_num"?\)\s*)?VALUES\s*\('([^']+)'\)/i,
      );
      if (insert) finish(insert[1] ?? "");
    });
    lines.on("close", () => finish(""));
    stream.on("error", () => finish(""));
  });
}

function isSchemaRevisionNewer(candidate: string, current: string): boolean {
  const candidateNumber = revisionNumericPrefix(candidate);
  const currentNumber = revisionNumericPrefix(current);
  if (candidateNumber == null || currentNumber == null) return false;
  return candidateNumber > currentNumber;
}

export function assertBackupSchemaCompatible(
  candidate: string,
  current: string,
  noun = "backup",
): void {
  if (!isSchemaRevisionNewer(candidate, current)) return;
  throw new Error(
    `BUNDLE_SCHEMA_NEWER: This ${noun} was created on schema revision "${candidate}" ` +
      `but this Vision install is at "${current}". Update Vision to a newer version and retry.`,
  );
}

export async function runBundleBackup(
  destDir: string,
  frontendStateJson: unknown = null,
): Promise<BundleBackupResult> {
  if (!destDir) throw new Error("No backup directory configured");
  const nativeRuntime = getNativeRuntime();
  const deviceId = await getBackupDeviceId();
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision_bak_"),
  );
  const dbSqlPath = path.join(tmpDir, "db.sql");
  const attachmentsDir = path.join(tmpDir, "attachments");
  try {
    await nativeRuntime.dumpDatabase(dbSqlPath, { format: "plain" });
    await nativeRuntime.exportAttachments(attachmentsDir);
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
    const { bundlePath } = await createBundle({
      destDir,
      deviceId,
      schemaHead: await nativeRuntime.getSchemaHead(),
      appVersion:
        typeof app.getVersion === "function" ? app.getVersion() : "unknown",
      dbSqlPath,
      attachmentsDir,
      frontendState,
    });
    const passphrase = await getBackupPassphrase();
    let finalFile = bundlePath;
    let encrypted = false;
    let warning: string | undefined;
    if (passphrase) {
      ({ encPath: finalFile } = await encryptBundle(bundlePath, passphrase));
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
  { passphrase, allowUnverifiedAudit = false }: RestoreRequestOptions = {},
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
    const message = String(details.message || "");
    if (
      encrypted &&
      (/bad decrypt|wrong final block|unable to authenticate|missing metadata\.json|missing db\.sql|end of central directory|not a zip file/i.test(
        message,
      ) ||
        details.code === "ERR_OSSL_BAD_DECRYPT" ||
        details.code === "ERR_CRYPTO_INVALID_AUTH_TAG")
    ) {
      throw new Error(ERR_INVALID_PASSPHRASE);
    }
    throw error;
  }
  const { metadata, dbSqlPath, attachmentsDir, frontendState, cleanup } =
    opened;
  const nativeRuntime = getNativeRuntime();
  try {
    // metadata.json is untrusted bundle content; a schema head is compared as text.
    const schemaHead = metadata.schemaHead
      ? String(metadata.schemaHead)
      : undefined;
    if (schemaHead) {
      const currentHead =
        (await nativeRuntime.getSchemaHead().catch(() => "")) ||
        getLocalMigrationChainHead();
      assertBackupSchemaCompatible(schemaHead, currentHead, "bundle");
    }
    const restore = await restoreNativeBundle(nativeRuntime, {
      dbSqlPath,
      attachmentsDir,
      expectedSchemaHead: schemaHead,
      allowUnverifiedAudit,
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

export async function runRestore(
  sqlFilePath: string,
  { passphrase, allowUnverifiedAudit = false }: RestoreRequestOptions = {},
): Promise<{ success: true; file: string }> {
  if (!sqlFilePath) throw new Error("No backup file specified");
  if (!fs.existsSync(sqlFilePath))
    throw new Error(`File not found: ${sqlFilePath}`);
  let restoreSource = sqlFilePath;
  let cleanupRestoreSource = () => {};
  if (await isEncryptedBackupFile(sqlFilePath)) {
    const effectivePassphrase = passphrase || (await getBackupPassphrase());
    if (!effectivePassphrase) throw new Error(ERR_PASSPHRASE_REQUIRED);
    restoreSource = await decryptBackupFileToTemp(
      sqlFilePath,
      effectivePassphrase,
    );
    cleanupRestoreSource = () => fs.unlink(restoreSource, () => {});
  }
  const nativeRuntime = getNativeRuntime();
  try {
    const dumpHead = await readDumpSchemaHead(restoreSource);
    if (dumpHead) {
      const currentHead =
        (await nativeRuntime.getSchemaHead().catch(() => "")) ||
        getLocalMigrationChainHead();
      assertBackupSchemaCompatible(dumpHead, currentHead);
    }
    await restoreNativeDatabase(nativeRuntime, restoreSource, {
      format: "plain",
      expectedSchemaHead: dumpHead || undefined,
      allowUnverifiedAudit,
    });
    return { success: true, file: sqlFilePath };
  } finally {
    cleanupRestoreSource();
  }
}
