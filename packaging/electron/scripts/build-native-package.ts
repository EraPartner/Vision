#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { Arch, Platform, build } from "electron-builder";

import { appRoot } from "../paths";
import {
  assertSafeNativeDestination,
  run as prepareNativeRuntime,
} from "./prepare-native-runtime";
import { buildDemoSeed } from "./build-demo-seed";

export interface PackageArgs {
  demo: boolean;
  directoryOnly: boolean;
}

export interface PackageResource {
  from: string;
  to: string;
}

export interface NativePackageConfig {
  extends?: string;
  extraResources: PackageResource[];
  afterPack: string;
}

export interface BuildNativePackageOptions {
  argv?: string[];
  prepare?: () => void;
  prepareDemo?: (options: {
    nativeRuntimeRoot: string;
  }) => Promise<{ outputRoot: string }>;
  builder?: typeof build;
  compiler?: (
    executable: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => { error?: Error | undefined; status: number | null; stderr: string };
}

const electronRoot = appRoot;

export function parseArgs(argv: readonly string[]): PackageArgs {
  const options = { demo: false, directoryOnly: false };
  for (const arg of argv) {
    if (arg === "--dir") options.directoryOnly = true;
    else if (arg === "--demo") options.demo = true;
    else throw new Error(`Unexpected package argument: ${arg}`);
  }
  return options;
}

export function nativeRuntimeRoot(): string {
  return assertSafeNativeDestination(
    process.env.VISION_NATIVE_RUNTIME_DESTINATION ||
      path.join(electronRoot, "native-runtime"),
  );
}

export function packageResources(
  runtimeRoot: string,
  demoSeedRoot: string | undefined = undefined,
  auditHelper: string | undefined = undefined,
): PackageResource[] {
  const resources = [{ from: runtimeRoot, to: "native-runtime" }];
  if (auditHelper) resources.push({ from: auditHelper, to: "audit-keychain" });
  if (demoSeedRoot) {
    resources.push({ from: demoSeedRoot, to: "demo-seed" });
  }
  return resources;
}

export function packageConfig(
  runtimeRoot: string,
  {
    demoSeedRoot = undefined,
    auditHelper = undefined,
  }: {
    demoSeedRoot?: string | undefined;
    auditHelper?: string | undefined;
  } = {},
): NativePackageConfig {
  return {
    ...(demoSeedRoot ? { extends: "./electron-builder-demo.json" } : {}),
    extraResources: packageResources(runtimeRoot, demoSeedRoot, auditHelper),
    // The hook is compiled next to this module (out/scripts).
    afterPack: path.join(__dirname, "finalize-native-package.js"),
  };
}

function errorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    error.message
  )
    return String(error.message);
  return String(error);
}

export async function main(
  options: BuildNativePackageOptions = {},
): Promise<string[]> {
  const args = parseArgs(options.argv || process.argv.slice(2));
  const prepare = options.prepare || prepareNativeRuntime;
  const prepareDemo = options.prepareDemo || buildDemoSeed;
  const builder = options.builder || build;
  const compiler = options.compiler || spawnSync;
  prepare();
  const runtimeRoot = nativeRuntimeRoot();
  fs.accessSync(path.join(runtimeRoot, "manifest.json"), fs.constants.R_OK);
  fs.accessSync(path.join(runtimeRoot, "vision-backend"), fs.constants.X_OK);
  fs.accessSync(
    path.join(runtimeRoot, "db", "migrations", "0001_baseline.sql"),
    fs.constants.R_OK,
  );
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
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
