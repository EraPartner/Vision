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
import { preBaselineBackupError } from "../runtime/native";
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

export async function resolveDatabaseEnvironment(): Promise<{
  nativeRuntime: NativeBackupRuntime;
}> {
  return { nativeRuntime: getNativeRuntime() };
}

function revisionNumericPrefix(rev: string): number | undefined {
  const match = /^(\d+)_/.exec(String(rev || ""));
  return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : undefined;
}

/** Highest migration shipped with this install, from db/migrations. */
function getLocalMigrationChainHead(): string {
  try {
    const root = ctx.workDir?.() || ctx.repoRootFallback;
    // path.join() rejects a missing root; that is "no local chain".
    if (typeof root !== "string") return "";
    return (
      fs
        .readdirSync(path.join(root, "db", "migrations"))
        .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
        .filter((name) => !name.endsWith(".down.sql"))
        .map((name) => name.slice(0, -".sql".length))
        .sort()
        .at(-1) || ""
    );
  } catch {
    return "";
  }
}

interface DumpSchemaLedger {
  /** Highest public.kysely_migration name, or "" when the ledger is absent. */
  head: string;
}

const KYSELY_COPY =
  /^COPY\s+(?:"?public"?\.)?"?kysely_migration"?\s*\(\s*"?name"?\s*,[^)]*\)\s+FROM\s+stdin;/i;
const KYSELY_INSERT =
  /^INSERT INTO\s+(?:"?public"?\.)?"?kysely_migration"?\s*(?:\([^)]*\)\s*)?VALUES\s*\('([^']+)'/i;
const ANY_COPY = /^COPY\s+\S.*\s+FROM\s+stdin;$/i;

// Reads the migration ledger rows from a plain pg_dump. A plain dump writes
// one COPY block per table, so the scan reads the whole file.
function readDumpSchemaLedger(sqlPath: string): Promise<DumpSchemaLedger> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(sqlPath, { encoding: "utf8" });
    const lines = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    const ledger: DumpSchemaLedger = { head: "" };
    const record = (name: string | undefined) => {
      if (name && name > ledger.head) ledger.head = name;
    };
    let copyBlock: "kysely" | "other" | undefined;
    lines.on("line", (line) => {
      // COPY rows are table data; only statements outside them are parsed.
      if (copyBlock) {
        if (line === "\\.") copyBlock = undefined;
        else if (copyBlock === "kysely") record(line.split("\t", 1)[0]);
        return;
      }
      if (KYSELY_COPY.test(line)) copyBlock = "kysely";
      else if (ANY_COPY.test(line)) copyBlock = "other";
      else record(KYSELY_INSERT.exec(line)?.[1]);
    });
    // A read error rejects first; the later close cannot settle the promise.
    stream.on("error", reject);
    lines.on("close", () => resolve(ledger));
  });
}

/**
 * Refuses a backup taken before the TypeScript migration baseline: it has no
 * Kysely migration ledger.
 */
function assertPostBaselineBackup(ledger: DumpSchemaLedger): string {
  if (!ledger.head) throw preBaselineBackupError();
  return ledger.head;
}

function isSchemaRevisionNewer(candidate: string, current: string): boolean {
  const candidateNumber = revisionNumericPrefix(candidate);
  const currentNumber = revisionNumericPrefix(current);
  if (candidateNumber === undefined || currentNumber === undefined)
    return false;
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

export interface BundleBackupOptions {
  /**
   * The caller guarantees no backend is running (PostgreSQL is up), so the
   * capture is already quiescent and must not stop or restart the backend.
   * Used by the pre-migration backup at launch.
   */
  backendStopped?: boolean;
}

export async function runBundleBackup(
  destDir: string,
  frontendStateJson: unknown = null,
  { backendStopped = false }: BundleBackupOptions = {},
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
    const capture = async () => {
      await nativeRuntime.dumpDatabase(dbSqlPath, { format: "plain" });
      await nativeRuntime.exportAttachments(attachmentsDir);
      return nativeRuntime.getSchemaHead();
    };
    let schemaHead: string | undefined;
    if (backendStopped) {
      schemaHead = await capture();
    } else {
      if (!ctx.withBackupSnapshot)
        throw new Error("Consistent native backup capture is unavailable");
      schemaHead = await ctx.withBackupSnapshot(capture);
    }
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
      schemaHead,
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
    // metadata.json is untrusted bundle content; the dump's own migration
    // ledger decides the schema revision and must agree with it.
    const schemaHead = assertPostBaselineBackup(
      await readDumpSchemaLedger(dbSqlPath),
    );
    if (metadata.schemaHead && String(metadata.schemaHead) !== schemaHead) {
      throw new Error(
        "Backup schema revision does not match its metadata; the bundle is corrupt.",
      );
    }
    const currentHead =
      (await nativeRuntime.getSchemaHead().catch(() => "")) ||
      getLocalMigrationChainHead();
    assertBackupSchemaCompatible(schemaHead, currentHead, "bundle");
    const restore = await restoreNativeBundle(nativeRuntime, {
      dbSqlPath,
      attachmentsDir,
      expectedSchemaHead: schemaHead,
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
  { passphrase }: RestoreRequestOptions = {},
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
    const dumpHead = assertPostBaselineBackup(
      await readDumpSchemaLedger(restoreSource),
    );
    const currentHead =
      (await nativeRuntime.getSchemaHead().catch(() => "")) ||
      getLocalMigrationChainHead();
    assertBackupSchemaCompatible(dumpHead, currentHead);
    await restoreNativeDatabase(nativeRuntime, restoreSource, {
      format: "plain",
      expectedSchemaHead: dumpHead,
    });
    return { success: true, file: sqlFilePath };
  } finally {
    cleanupRestoreSource();
  }
}
