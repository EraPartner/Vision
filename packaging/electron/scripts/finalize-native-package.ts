import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";

import { verifyRuntimeManifest } from "../runtime/native";
import { manifestEntries } from "./prepare-native-runtime";

/** The part of electron-builder's AfterPackContext this hook reads. */
export interface PackagedAppContext {
  appOutDir?: string;
  packager?: { appInfo?: { productFilename?: string } };
}

export type CheckedRunner = (
  executable: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => {
  error?: Error | undefined;
  status: number | null;
  stderr?: string | null;
};

export interface FinalizeOptions {
  refreshManifest?: (runtimeRoot: string) => unknown;
  runner?: CheckedRunner;
  verifyManifest?: (
    runtimeRoot: string,
    options: { required: boolean },
  ) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function runChecked(
  executable: string,
  args: string[],
  runner: CheckedRunner = spawnSync,
): void {
  const result = runner(executable, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(executable)} failed: ${(result.stderr || "").trim()}`,
    );
  }
}

export function refreshRuntimeManifest(runtimeRoot: string): number {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    !isRecord(manifest) ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.entries)
  ) {
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

export async function finalizePackagedApp(
  context: PackagedAppContext | null | undefined,
  {
    refreshManifest = refreshRuntimeManifest,
    runner = spawnSync,
    verifyManifest = verifyRuntimeManifest,
  }: FinalizeOptions = {},
): Promise<string> {
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

// electron-builder resolves a hook module's export named after the hook
// ("afterPack") before falling back to the default export.
export const afterPack = finalizePackagedApp;
export default finalizePackagedApp;
