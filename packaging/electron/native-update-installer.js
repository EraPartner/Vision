"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function parseInstallerArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !value ||
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

function validateVisionAppPath(value, label) {
  const resolved = path.resolve(String(value || ""));
  if (
    path.basename(resolved) !== "Vision.app" ||
    path.dirname(resolved) === path.parse(resolved).root
  ) {
    throw new Error(`Native update ${label} must be a specific Vision.app`);
  }
  return resolved;
}

function validateHostPid(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error("Native update host process id is invalid");
  }
  return pid;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(pid, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (processExists(pid)) {
    throw new Error("Vision did not exit before the native update deadline");
  }
}

function installNativeUpdate({ sourceApp, destinationApp, hostPid }) {
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

    spawnSync("/usr/bin/xattr", [
      "-rd",
      "com.apple.quarantine",
      destinationApp,
    ]);
    const launched = spawnSync("/usr/bin/open", [destinationApp], {
      stdio: "ignore",
    });
    if (launched.error || launched.status !== 0) {
      throw (
        launched.error || new Error("Updated Vision application did not open")
      );
    }
    fs.rmSync(backupApp, { recursive: true, force: true });
    return { status: "installed" };
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
      spawnSync("/usr/bin/open", [destinationApp], { stdio: "ignore" });
    }
    throw error;
  }
}

if (require.main === module) {
  try {
    installNativeUpdate(parseInstallerArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${error && error.message ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  parseInstallerArgs,
  validateVisionAppPath,
  validateHostPid,
  installNativeUpdate,
};
