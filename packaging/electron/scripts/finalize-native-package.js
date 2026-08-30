"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyRuntimeManifest } = require("../runtime/native");
const { manifestEntries } = require("./prepare-native-runtime");

function runChecked(executable, args, runner = spawnSync) {
  const result = runner(executable, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(executable)} failed: ${(result.stderr || "").trim()}`,
    );
  }
}

function refreshRuntimeManifest(runtimeRoot) {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error("Native runtime manifest has an unsupported format");
  }
  const entries = manifestEntries(runtimeRoot).filter(
    (entry) => entry.path !== "manifest.json",
  );
  const temporary = path.join(
    runtimeRoot,
    `.manifest-${process.pid}-${Date.now()}.tmp`,
  );
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ ...manifest, entries }, null, 2)}\n`,
    { mode: 0o644 },
  );
  fs.renameSync(temporary, manifestPath);
  return entries.length;
}

async function finalizePackagedApp(
  context,
  {
    refreshManifest = refreshRuntimeManifest,
    runner = spawnSync,
    verifyManifest = verifyRuntimeManifest,
  } = {},
) {
  const productFilename = context?.packager?.appInfo?.productFilename;
  if (!context?.appOutDir || !productFilename) {
    throw new Error("Electron builder did not provide the packaged app path");
  }
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);
  const packagedRuntime = path.join(
    appPath,
    "Contents",
    "Resources",
    "native-runtime",
  );
  await verifyManifest(packagedRuntime, { required: true });
  runChecked(
    "/usr/bin/codesign",
    ["--force", "--deep", "--sign", "-", appPath],
    runner,
  );
  refreshManifest(packagedRuntime);
  runChecked("/usr/bin/codesign", ["--force", "--sign", "-", appPath], runner);
  runChecked(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", appPath],
    runner,
  );
  await verifyManifest(packagedRuntime, { required: true });
  return appPath;
}

module.exports = finalizePackagedApp;
module.exports.afterPack = finalizePackagedApp;
module.exports.finalizePackagedApp = finalizePackagedApp;
module.exports.refreshRuntimeManifest = refreshRuntimeManifest;
module.exports.runChecked = runChecked;
