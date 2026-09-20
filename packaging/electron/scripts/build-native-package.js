#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { Arch, Platform, build } = require("electron-builder");
const {
  assertSafeNativeDestination,
  run: prepareNativeRuntime,
} = require("./prepare-native-runtime");
const { buildDemoSeed } = require("./build-demo-seed");

const electronRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const options = { demo: false, directoryOnly: false };
  for (const arg of argv) {
    if (arg === "--dir") options.directoryOnly = true;
    else if (arg === "--demo") options.demo = true;
    else throw new Error(`Unexpected package argument: ${arg}`);
  }
  return options;
}

function nativeRuntimeRoot() {
  return assertSafeNativeDestination(
    process.env.VISION_NATIVE_RUNTIME_DESTINATION ||
      path.join(electronRoot, "native-runtime"),
  );
}

function packageResources(
  runtimeRoot,
  demoSeedRoot = undefined,
  auditHelper = undefined,
) {
  const resources = [{ from: runtimeRoot, to: "native-runtime" }];
  if (auditHelper) resources.push({ from: auditHelper, to: "audit-keychain" });
  if (demoSeedRoot) {
    resources.push({ from: demoSeedRoot, to: "demo-seed" });
  }
  return resources;
}

function packageConfig(
  runtimeRoot,
  { demoSeedRoot = undefined, auditHelper = undefined } = {},
) {
  return {
    ...(demoSeedRoot ? { extends: "./electron-builder-demo.json" } : {}),
    extraResources: packageResources(runtimeRoot, demoSeedRoot, auditHelper),
    afterPack: path.join(__dirname, "finalize-native-package.js"),
  };
}

async function main(options = {}) {
  const args = parseArgs(options.argv || process.argv.slice(2));
  const prepare = options.prepare || prepareNativeRuntime;
  const prepareDemo = options.prepareDemo || buildDemoSeed;
  const builder = options.builder || build;
  const compiler = options.compiler || spawnSync;
  prepare();
  const runtimeRoot = nativeRuntimeRoot();
  fs.accessSync(path.join(runtimeRoot, "manifest.json"), fs.constants.R_OK);
  fs.accessSync(path.join(runtimeRoot, "vision-alembic"), fs.constants.X_OK);
  const demoSeed = args.demo
    ? await prepareDemo({ nativeRuntimeRoot: runtimeRoot })
    : undefined;
  const targets = Platform.MAC.createTarget(
    args.directoryOnly || args.demo ? ["dir"] : ["dmg", "zip"],
    Arch.arm64,
  );
  const helperDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vision-audit-helper-"),
  );
  try {
    const auditHelper = path.join(helperDir, "audit-keychain");
    const result = compiler(
      "/usr/bin/xcrun",
      [
        "swiftc",
        path.join(electronRoot, "audit-keychain.swift"),
        "-o",
        auditHelper,
      ],
      { encoding: "utf8" },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `Audit Keychain helper build failed: ${result.stderr || result.error}`,
      );
    }
    fs.chmodSync(auditHelper, 0o755);
    return await builder({
      projectDir: electronRoot,
      targets,
      publish: "never",
      config: packageConfig(runtimeRoot, {
        demoSeedRoot: demoSeed?.outputRoot,
        auditHelper,
      }),
    });
  } finally {
    fs.rmSync(helperDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  nativeRuntimeRoot,
  packageConfig,
  packageResources,
  parseArgs,
};
