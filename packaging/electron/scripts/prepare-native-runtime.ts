import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { appRoot } from "../paths";
import { preparePostgresRuntime } from "./prepare-postgres-runtime";
import { prepareChromiumRuntime } from "./prepare-chromium-runtime";
import { replaceGeneratedDirectory } from "./replace-generated-directory";

export interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

const electronRoot = appRoot;
const repoRoot = path.resolve(electronRoot, "..", "..");
const defaultOutputRoot = path.join(electronRoot, "native-runtime");
const frontendRoot = process.env.VISION_FRONTEND_DIST
  ? path.resolve(process.env.VISION_FRONTEND_DIST)
  : path.join(repoRoot, "dist");

export function assertSafeNativeDestination(candidate: string): string {
  const destination = path.resolve(candidate);
  if (
    path.basename(destination) !== "native-runtime" ||
    path.dirname(destination) === destination
  ) {
    throw new Error("Native runtime destination must end in native-runtime");
  }
  return destination;
}

function replaceOutputContents(stagingRoot: string, outputRoot: string): void {
  const replacement = replaceGeneratedDirectory(stagingRoot, outputRoot);
  if (replacement.retainedPrevious) {
    console.warn(
      `Previous generated native runtime retained at ${replacement.retainedPrevious}`,
    );
  }
}

function findExecutable(
  candidates: readonly (string | undefined)[],
): string | undefined {
  return candidates.find((candidate): candidate is string => {
    if (!candidate) return false;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function signCompiledBackend(binary: string): void {
  if (process.platform !== "darwin") return;
  const sign = spawnSync(
    "/usr/bin/codesign",
    ["--force", "--sign", "-", binary],
    { encoding: "utf8" },
  );
  if (sign.error) throw sign.error;
  if (sign.status !== 0) {
    throw new Error(
      `Native backend signing failed: ${(sign.stderr || "").trim()}`,
    );
  }
  const verify = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--strict", binary],
    { encoding: "utf8" },
  );
  if (verify.error) throw verify.error;
  if (verify.status !== 0) {
    throw new Error(
      `Native backend signature verification failed: ${(verify.stderr || "").trim()}`,
    );
  }
}

function copyTree(source: string, destination: string): void {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry);
      return name !== ".DS_Store";
    },
  });
}

function hashFile(filePath: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

export function manifestEntries(root: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  function visit(current: string): void {
    const children = fs.readdirSync(current, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = path.join(current, child.name);
      if (child.isDirectory()) visit(absolute);
      else if (child.isFile()) {
        entries.push({
          path: path.relative(root, absolute).split(path.sep).join("/"),
          bytes: fs.statSync(absolute).size,
          sha256: hashFile(absolute),
        });
      } else {
        throw new Error(
          `Native runtime payload contains an unsupported entry: ${path.relative(root, absolute)}`,
        );
      }
    }
  }
  visit(root);
  return entries;
}

function readPackageVersion(): string | undefined {
  const packageJson: unknown = JSON.parse(
    fs.readFileSync(path.join(electronRoot, "package.json"), "utf8"),
  );
  if (
    typeof packageJson === "object" &&
    packageJson !== null &&
    "version" in packageJson &&
    typeof packageJson.version === "string"
  )
    return packageJson.version;
  return undefined;
}

export function run(): void {
  const outputRoot = assertSafeNativeDestination(
    process.env.VISION_NATIVE_RUNTIME_DESTINATION || defaultOutputRoot,
  );
  const frontendIndex = path.join(frontendRoot, "index.html");
  if (!fs.existsSync(frontendIndex)) {
    throw new Error(
      "Production frontend is missing. Run `bun run build` before preparing the native runtime or set VISION_FRONTEND_DIST to a verified build directory.",
    );
  }
  const bun = findExecutable([
    process.env.VISION_BUN_BIN,
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ]);
  if (!bun)
    throw new Error("Bun is required to compile the native backend payload");

  const stagingRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "vision-native-runtime-"),
  );

  try {
    const compile = spawnSync(
      bun,
      [
        "build",
        "--compile",
        // Precompiled bytecode skips parsing ~1,500 bundled modules on every
        // launch: the backend answers /health ~0.35 s sooner.
        "--bytecode",
        path.join(repoRoot, "apps", "node-backend", "src", "main.ts"),
        "--outfile",
        path.join(stagingRoot, "vision-backend"),
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (compile.error) throw compile.error;
    if (compile.status !== 0)
      throw new Error(`Native backend compilation exited ${compile.status}`);
    fs.chmodSync(path.join(stagingRoot, "vision-backend"), 0o755);
    signCompiledBackend(path.join(stagingRoot, "vision-backend"));

    copyTree(frontendRoot, path.join(stagingRoot, "dist"));
    // The compiled backend applies db/migrations in-process on boot and reads
    // db/schema-inventory.sql to verify the baseline fingerprint.
    copyTree(path.join(repoRoot, "db"), path.join(stagingRoot, "db"));
    fs.mkdirSync(path.join(stagingRoot, "config", "postgres"), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(repoRoot, "config", "postgres", "app-role-grants.sql.tpl"),
      path.join(stagingRoot, "config", "postgres", "app-role-grants.sql.tpl"),
    );
    preparePostgresRuntime({
      sourceBin: process.env.VISION_POSTGRES_SOURCE_BIN,
      destination: path.join(stagingRoot, "postgres"),
    });
    prepareChromiumRuntime({
      source: process.env.VISION_CHROMIUM_SOURCE,
      destination: path.join(stagingRoot, "chromium"),
    });
    fs.mkdirSync(path.join(stagingRoot, "licenses"), { recursive: true });
    fs.copyFileSync(
      path.join(electronRoot, "resources", "licenses", "PostgreSQL.txt"),
      path.join(stagingRoot, "licenses", "PostgreSQL.txt"),
    );

    const appVersion = readPackageVersion();
    const entries = manifestEntries(stagingRoot);
    const manifest = {
      version: 1,
      appVersion,
      platform: process.platform,
      architecture: process.arch,
      entries,
    };
    fs.writeFileSync(
      path.join(stagingRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o644 },
    );
    replaceOutputContents(stagingRoot, outputRoot);
    console.log(
      `Prepared native runtime ${appVersion}: ${entries.length} files`,
    );
  } catch (error) {
    try {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      console.warn(`Incomplete native payload retained at ${stagingRoot}`);
    }
    throw error;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

if (require.main === module) run();
