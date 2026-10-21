// One-time removal of what the retired audit-history feature left on disk and
// in the macOS login keychain: the `audit-anchor` receipt folder in userData
// and the Keychain witness item. Runs fire-and-forget after launch, never
// throws, and records a marker once the folder is gone so later launches do
// not spawn `security` again. The Keychain delete is tried once only: the item's
// access list trusts the removed helper, so macOS may ask before deleting it,
// and a refused prompt must not come back on every launch.
import { execFile as nodeExecFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const LEGACY_DIRECTORY = "audit-anchor";
const MARKER_FILE = ".legacy-audit-cleanup-done";
const KEYCHAIN_ACCOUNT = "latest-checkpoint";
const SECURITY_TOOL = "/usr/bin/security";
// `security` exits with errSecItemNotFound's low byte when the item is absent.
const SECURITY_ITEM_NOT_FOUND = 44;
const SECURITY_TIMEOUT_MS = 15_000;

/** Node's `execFile` callback signature, narrowed to what the cleanup uses. */
export type LegacyCleanupExecFile = (
  file: string,
  args: readonly string[],
  options: { shell: false; timeout: number; windowsHide: true },
  callback: (
    error: (Error & { code?: unknown }) | null,
    stdout: string,
    stderr: string,
  ) => void,
) => unknown;

interface LegacyCleanupLog {
  info(message: string): void;
  warn(message: string): void;
}

interface LegacyAuditCleanupOptions {
  userDataDir: string;
  /** Native runtime id (`vision`, `vision_demo`, ...). */
  runtimeName: string;
  /**
   * Resolves true once the live database has applied the migration that
   * retired audit history. Until then nothing is removed and no marker is
   * written, so a failed upgrade can still go back to the previous build.
   */
  retirementApplied: () => Promise<boolean>;
  execFile?: LegacyCleanupExecFile;
  log: LegacyCleanupLog;
  platform?: NodeJS.Platform;
}

type LegacyAuditCleanupResult =
  | "skipped"
  | "deferred"
  | "completed"
  | "incomplete";

/**
 * Keychain service the retired helper used, or undefined for runtimes that
 * never had a Keychain witness (the old helper accepted only these two).
 */
function legacyAuditKeychainService(runtimeName: string): string | undefined {
  if (runtimeName !== "vision" && runtimeName !== "vision_demo") {
    return undefined;
  }
  return `com.vaultvoyager.${runtimeName.replace("_", "-")}.audit-witness`;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function removeLegacyDirectory(
  userDataDir: string,
  log: LegacyCleanupLog,
): Promise<boolean> {
  const root = path.resolve(userDataDir);
  const target = path.resolve(root, LEGACY_DIRECTORY);
  if (
    path.dirname(target) !== root ||
    path.basename(target) !== LEGACY_DIRECTORY
  ) {
    log.warn("[legacy-audit-cleanup] refusing receipt folder outside userData");
    return false;
  }
  try {
    let stats;
    try {
      stats = await fs.lstat(target);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      await fs.unlink(target);
      log.info(
        "[legacy-audit-cleanup] removed audit receipt folder link (target left untouched)",
      );
      return true;
    }
    if (!stats.isDirectory()) {
      log.warn(
        "[legacy-audit-cleanup] audit-anchor is not a directory; left in place",
      );
      return true;
    }
    await fs.rm(target, { recursive: true, force: true });
    log.info("[legacy-audit-cleanup] removed audit receipt folder");
    return true;
  } catch (error) {
    log.warn(
      `[legacy-audit-cleanup] could not remove audit receipt folder: ${describe(error)}`,
    );
    return false;
  }
}

function removeKeychainItem(
  service: string,
  execFile: LegacyCleanupExecFile,
  log: LegacyCleanupLog,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(
        SECURITY_TOOL,
        ["delete-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT],
        { shell: false, timeout: SECURITY_TIMEOUT_MS, windowsHide: true },
        (error) => {
          if (!error) {
            log.info(`[legacy-audit-cleanup] removed Keychain item ${service}`);
            resolve(true);
          } else if (errorCode(error) === SECURITY_ITEM_NOT_FOUND) {
            resolve(true);
          } else {
            log.warn(
              `[legacy-audit-cleanup] could not remove Keychain item ${service}: ${describe(error)}`,
            );
            resolve(false);
          }
        },
      );
    } catch (error) {
      log.warn(
        `[legacy-audit-cleanup] could not run security: ${describe(error)}`,
      );
      resolve(false);
    }
  });
}

/**
 * Remove the retired audit-history leftovers once, after the database has
 * applied the retiring migration. Never throws: failures are logged as
 * warnings. A deferred run or a folder failure leaves the marker unwritten so
 * the next launch retries; a Keychain failure does not.
 */
export async function cleanupLegacyAuditArtifacts({
  userDataDir,
  runtimeName,
  retirementApplied,
  execFile = nodeExecFile,
  log,
  platform = process.platform,
}: LegacyAuditCleanupOptions): Promise<LegacyAuditCleanupResult> {
  try {
    const markerPath = path.join(path.resolve(userDataDir), MARKER_FILE);
    if (await exists(markerPath)) return "skipped";
    if (!(await retirementApplied())) {
      log.info(
        "[legacy-audit-cleanup] audit history is not retired in the database yet; left in place",
      );
      return "deferred";
    }

    const directoryDone = await removeLegacyDirectory(userDataDir, log);
    const service = legacyAuditKeychainService(runtimeName);
    const keychainDone =
      platform === "darwin" && service
        ? await removeKeychainItem(service, execFile, log)
        : true;

    if (!directoryDone) return "incomplete";
    await fs.writeFile(markerPath, `${new Date().toISOString()}\n`, {
      mode: 0o600,
    });
    return keychainDone ? "completed" : "incomplete";
  } catch (error) {
    log.warn(`[legacy-audit-cleanup] failed: ${describe(error)}`);
    return "incomplete";
  }
}
