// Copied next to the downloaded update and run on its own with
// ELECTRON_RUN_AS_NODE, so it may import Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";

export interface NativeInstallerArgs {
  sourceApp: string;
  destinationApp: string;
  hostPid: number;
}

export type SpawnSyncRunner = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => { error?: Error; status: number | null };

export function parseInstallerArgs(
  argv: readonly string[],
): NativeInstallerArgs {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !value ||
      !key ||
      !["--source-app", "--destination-app", "--host-pid"].includes(key)
    ) {
      throw new Error("Invalid native update installer arguments");
    }
    values[key.slice(2)] = value;
  }
  if (
    !values["source-app"] ||
    !values["destination-app"] ||
    !values["host-pid"]
  ) {
    throw new Error("Native update installer arguments are incomplete");
  }
  return {
    sourceApp: validateVisionAppPath(values["source-app"], "source"),
    destinationApp: validateVisionAppPath(
      values["destination-app"],
      "destination",
    ),
    hostPid: validateHostPid(values["host-pid"]),
  };
}

export function validateVisionAppPath(value: unknown, label: string): string {
  const resolved = path.resolve(String(value || ""));
  if (
    path.basename(resolved) !== "Vision.app" ||
    path.dirname(resolved) === path.parse(resolved).root
  ) {
    throw new Error(`Native update ${label} must be a specific Vision.app`);
  }
  return resolved;
}

export function validateHostPid(value: unknown): number {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error("Native update host process id is invalid");
  }
  return pid;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(pid: number, timeoutMs = 60_000): void {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (processExists(pid)) {
    throw new Error("Vision did not exit before the native update deadline");
  }
}

export function installNativeUpdate({
  sourceApp,
  destinationApp,
  hostPid,
  spawnProcess = spawnSync,
}: NativeInstallerArgs & { spawnProcess?: SpawnSyncRunner }): {
  status: "installed";
  cleanupWarning?: string;
} {
  const sourceStat = fs.statSync(sourceApp);
  const destinationStat = fs.statSync(destinationApp);
  if (!sourceStat.isDirectory() || !destinationStat.isDirectory()) {
    throw new Error(
      "Native update source and destination must be applications",
    );
  }

  waitForExit(hostPid);
  const parent = path.dirname(destinationApp);
  const nonce = `${process.pid}-${Date.now()}`;
  const stagingApp = path.join(parent, `.Vision-update-staging-${nonce}.app`);
  const backupApp = path.join(parent, `.Vision-update-backup-${nonce}.app`);
  let liveMoved = false;
  let stagingActivated = false;

  try {
    fs.cpSync(sourceApp, stagingApp, { recursive: true });
    fs.renameSync(destinationApp, backupApp);
    liveMoved = true;
    fs.renameSync(stagingApp, destinationApp);
    stagingActivated = true;

    spawnProcess("/usr/bin/xattr", [
      "-rd",
      "com.apple.quarantine",
      destinationApp,
    ]);
    const launched = spawnProcess("/usr/bin/open", [destinationApp], {
      stdio: "ignore",
    });
    if (launched.error || launched.status !== 0) {
      throw (
        launched.error || new Error("Updated Vision application did not open")
      );
    }
  } catch (error) {
    if (stagingActivated) {
      const failedApp = path.join(parent, `.Vision-update-failed-${nonce}.app`);
      try {
        fs.renameSync(destinationApp, failedApp);
      } catch {
        // Preserve the original error and try to restore the backup below.
      }
    } else {
      fs.rmSync(stagingApp, { recursive: true, force: true });
    }
    if (
      liveMoved &&
      fs.existsSync(backupApp) &&
      !fs.existsSync(destinationApp)
    ) {
      fs.renameSync(backupApp, destinationApp);
      spawnProcess("/usr/bin/open", [destinationApp], { stdio: "ignore" });
    }
    throw error;
  }
  // Launch is the commit point. Cleanup can remove only part of the old app
  // before failing, so it must never move that damaged copy back into service.
  try {
    fs.rmSync(backupApp, { recursive: true, force: true });
    return { status: "installed" };
  } catch {
    return {
      status: "installed",
      cleanupWarning:
        "Previous application cleanup failed; the updated application remains installed.",
    };
  }
}

function errorMessage(error: unknown): unknown {
  return typeof error === "object" && error !== null && "message" in error
    ? error.message
    : undefined;
}

if (require.main === module) {
  try {
    const result = installNativeUpdate(
      parseInstallerArgs(process.argv.slice(2)),
    );
    if (result.cleanupWarning)
      process.stderr.write(`${result.cleanupWarning}\n`);
  } catch (error) {
    const message = errorMessage(error);
    process.stderr.write(`${message ? message : String(error)}\n`);
    process.exitCode = 1;
  }
}
