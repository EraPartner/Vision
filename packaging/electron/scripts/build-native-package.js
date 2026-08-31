#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
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

function packageResources(runtimeRoot, demoSeedRoot = undefined) {
  const resources = [{ from: runtimeRoot, to: "native-runtime" }];
  if (demoSeedRoot) {
    resources.push({ from: demoSeedRoot, to: "demo-seed" });
  }
  return resources;
}

function packageConfig(runtimeRoot, { demoSeedRoot = undefined } = {}) {
  return {
    ...(demoSeedRoot ? { extends: "./electron-builder-demo.json" } : {}),
    extraResources: packageResources(runtimeRoot, demoSeedRoot),
    afterPack: path.join(__dirname, "finalize-native-package.js"),
  };
}

async function main(options = {}) {
  const args = parseArgs(options.argv || process.argv.slice(2));
  const prepare = options.prepare || prepareNativeRuntime;
  const prepareDemo = options.prepareDemo || buildDemoSeed;
  const builder = options.builder || build;
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
  return builder({
    projectDir: electronRoot,
    targets,
    publish: "never",
    config: packageConfig(runtimeRoot, {
      demoSeedRoot: demoSeed?.outputRoot,
    }),
  });
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
