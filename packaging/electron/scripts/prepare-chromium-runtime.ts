#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { appRoot } from "../paths";
import { replaceGeneratedDirectory } from "./replace-generated-directory";

export const CHROMIUM_VERSION = "150.0.7871.24";

export interface ChromiumRuntimeMetadata {
  version: 1;
  browser: "chrome-headless-shell";
  browserVersion: string;
  versionText: string;
  platform: NodeJS.Platform;
  architecture: NodeJS.Architecture;
  executableRelative: string;
  licenseRelative: string;
}

function run(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(executable)} failed: ${(result.stderr || "").trim()}`,
    );
  }
  return (result.stdout || "").trim();
}

export function expectedCacheExecutable(): string {
  const platform = process.arch === "arm64" ? "mac_arm" : "mac";
  const directory =
    process.arch === "arm64"
      ? "chrome-headless-shell-mac-arm64"
      : "chrome-headless-shell-mac-x64";
  return path.join(
    os.homedir(),
    ".cache",
    "puppeteer",
    "chrome-headless-shell",
    `${platform}-${CHROMIUM_VERSION}`,
    directory,
    "chrome-headless-shell",
  );
}

export function findSourceExecutable(explicitSource?: string): string {
  const candidates = [
    explicitSource,
    process.env.VISION_CHROMIUM_SOURCE,
    expectedCacheExecutable(),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const executable =
      fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? path.join(resolved, "chrome-headless-shell")
        : resolved;
    try {
      fs.accessSync(executable, fs.constants.X_OK);
      return executable;
    } catch {
      // Continue to the pinned Puppeteer cache candidate.
    }
  }
  throw new Error(
    `Chrome Headless Shell ${CHROMIUM_VERSION} is required to prepare native PDF support. Run the pinned Puppeteer browser install first or set VISION_CHROMIUM_SOURCE.`,
  );
}

export function verifyChromium(executable: string): string {
  const output = run(executable, ["--version"]);
  if (!output.includes(CHROMIUM_VERSION)) {
    throw new Error(
      `Packaged Chrome Headless Shell must be ${CHROMIUM_VERSION}; found ${output || "unknown"}`,
    );
  }
  return output;
}

export function assertSafeDestination(destination: string): string {
  const target = path.resolve(destination);
  if (
    path.basename(target) !== "chromium" ||
    target === path.parse(target).root ||
    target === os.homedir() ||
    target.length < 20
  ) {
    throw new Error("Unsafe packaged Chromium destination");
  }
  return target;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  function visit(current: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  visit(root);
  return files;
}

function isMachO(filePath: string): boolean {
  const result = spawnSync("/usr/bin/file", ["-b", filePath], {
    encoding: "utf8",
  });
  return result.status === 0 && /Mach-O/.test(result.stdout || "");
}

function normalizePermissions(root: string): void {
  function visit(current: string): void {
    fs.chmodSync(current, 0o755);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const executable = (fs.statSync(absolute).mode & 0o111) !== 0;
        fs.chmodSync(absolute, executable ? 0o755 : 0o644);
      }
    }
  }
  visit(root);
}

export function prepareChromiumRuntime({
  source,
  destination,
  platform = process.platform,
}: {
  source?: string | undefined;
  destination: string;
  platform?: NodeJS.Platform;
}): ChromiumRuntimeMetadata {
  if (platform !== "darwin")
    throw new Error("The native Chromium payload must be prepared on macOS");
  const executable = findSourceExecutable(source);
  const versionText = verifyChromium(executable);
  const sourceRoot = path.dirname(executable);
  const licensePath = path.join(sourceRoot, "LICENSE.headless_shell");
  if (!fs.existsSync(licensePath))
    throw new Error("Chrome Headless Shell license file is missing");

  const target = assertSafeDestination(destination);
  const staging = fs.mkdtempSync(
    path.join(os.tmpdir(), "vision-chromium-runtime-"),
  );
  try {
    const root = path.join(staging, "root");
    fs.cpSync(sourceRoot, root, { recursive: true, dereference: true });
    normalizePermissions(root);
    for (const filePath of walkFiles(root).filter(isMachO))
      run("/usr/bin/codesign", ["--force", "--sign", "-", filePath]);
    const packagedExecutable = path.join(root, "chrome-headless-shell");
    verifyChromium(packagedExecutable);
    const metadata: ChromiumRuntimeMetadata = {
      version: 1,
      browser: "chrome-headless-shell",
      browserVersion: CHROMIUM_VERSION,
      versionText,
      platform: process.platform,
      architecture: process.arch,
      executableRelative: "root/chrome-headless-shell",
      licenseRelative: "root/LICENSE.headless_shell",
    };
    fs.writeFileSync(
      path.join(staging, "runtime.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { mode: 0o644 },
    );
    const replacement = replaceGeneratedDirectory(staging, target);
    if (replacement.retainedPrevious) {
      console.warn(
        `Previous generated Chromium payload retained at ${replacement.retainedPrevious}`,
      );
    }
    return metadata;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  const destination = path.resolve(
    process.env.VISION_CHROMIUM_DESTINATION ||
      path.join(appRoot, "native-runtime", "chromium"),
  );
  const metadata = prepareChromiumRuntime({ destination });
  console.log(
    `Prepared ${metadata.browser} ${metadata.browserVersion} for ${metadata.architecture}`,
  );
}
