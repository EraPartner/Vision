import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";

import { appRoot } from "../paths";

export const PYINSTALLER_VERSION = "6.22.2";
export const ALEMBIC_VERSION = "1.20.0";
export const ALEMBIC_RUNTIME_IMPORTS = Object.freeze([
  "logging.config",
  "dotenv",
  "psycopg2._psycopg",
]);
const BUILD_ENV_KEYS = Object.freeze([
  "DEVELOPER_DIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "SDKROOT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

export interface AlembicRuntimeResult {
  version: string;
  source: "prebuilt" | "pyinstaller";
}

function run(
  executable: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(executable)} failed: ${(result.stderr || "").trim()}`,
    );
  }
  return (result.stdout || "").trim();
}

function executable(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findPython(explicitPython?: string): string {
  const candidates = [
    explicitPython,
    process.env.VISION_PYTHON_BIN,
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
  ];
  const found = candidates.find(executable);
  if (!found)
    throw new Error("Python is required at build time to package Alembic");
  return found;
}

export function assertSafeDestination(destination: string): string {
  const target = path.resolve(destination);
  if (
    path.basename(target) !== "vision-alembic" ||
    target === path.parse(target).root ||
    target === os.homedir() ||
    target.length < 20
  ) {
    throw new Error("Unsafe packaged Alembic destination");
  }
  return target;
}

export function pyInstallerEnvironment(
  configDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BUILD_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  env.PYINSTALLER_CONFIG_DIR = path.resolve(configDirectory);
  return env;
}

export function verifyAlembicBinary(binary: string): string {
  fs.accessSync(binary, fs.constants.X_OK);
  const version = run(binary, ["--version"]);
  if (version.toLowerCase() !== `alembic ${ALEMBIC_VERSION}`)
    throw new Error(`Packaged Alembic version is unsupported: ${version}`);
  const runtimeCheck = run(binary, ["--vision-runtime-self-test"]);
  if (runtimeCheck !== "vision-alembic runtime ok")
    throw new Error(
      `Packaged Alembic runtime self-test failed: ${runtimeCheck}`,
    );
  if (process.platform === "darwin") {
    const description = run("/usr/bin/file", ["-b", binary]);
    const expected = process.arch === "arm64" ? "arm64" : "x86_64";
    if (!description.includes(expected))
      throw new Error(
        `Packaged Alembic architecture must be ${expected}: ${description}`,
      );
  }
  return version;
}

export function pyInstallerArgs({
  dist,
  work,
  spec,
  entrypoint,
}: {
  dist: string;
  work: string;
  spec: string;
  entrypoint: string;
}): string[] {
  return [
    "-m",
    "PyInstaller",
    "--clean",
    "--noconfirm",
    "--onefile",
    "--name",
    "vision-alembic",
    "--distpath",
    dist,
    "--workpath",
    work,
    "--specpath",
    spec,
    "--collect-submodules",
    "alembic",
    "--collect-submodules",
    "sqlalchemy.dialects.postgresql",
    ...ALEMBIC_RUNTIME_IMPORTS.flatMap((moduleName) => [
      "--hidden-import",
      moduleName,
    ]),
    entrypoint,
  ];
}

export function prepareAlembicRuntime({
  python,
  destination,
  prebuilt,
}: {
  python?: string | undefined;
  destination: string;
  prebuilt?: string | undefined;
}): AlembicRuntimeResult {
  const target = assertSafeDestination(destination);
  const explicitPrebuilt = prebuilt || process.env.VISION_ALEMBIC_RUNTIME_BIN;
  if (explicitPrebuilt) {
    verifyAlembicBinary(path.resolve(explicitPrebuilt));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.resolve(explicitPrebuilt), target);
    fs.chmodSync(target, 0o755);
    return { version: verifyAlembicBinary(target), source: "prebuilt" };
  }

  const pythonBin = findPython(python);
  const buildVersions = run(pythonBin, [
    "-c",
    "import alembic, psycopg2, sqlalchemy, PyInstaller; print(alembic.__version__ + ' ' + PyInstaller.__version__)",
  ]);
  if (buildVersions !== `${ALEMBIC_VERSION} ${PYINSTALLER_VERSION}`) {
    throw new Error(
      `Migration build dependencies must be Alembic ${ALEMBIC_VERSION} and PyInstaller ${PYINSTALLER_VERSION}; found ${buildVersions}`,
    );
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vision-alembic-"));
  const dist = path.join(temp, "dist");
  try {
    const result = spawnSync(
      pythonBin,
      pyInstallerArgs({
        dist,
        work: path.join(temp, "work"),
        spec: path.join(temp, "spec"),
        // The Python entry point is not compiled: it stays in the source
        // scripts directory, not next to this module in out/scripts.
        entrypoint: path.join(appRoot, "scripts", "vision-alembic.py"),
      }),
      {
        stdio: "inherit",
        env: pyInstallerEnvironment(path.join(temp, "config")),
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`PyInstaller exited with status ${result.status}`);
    const built = path.join(dist, "vision-alembic");
    verifyAlembicBinary(built);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(built, target);
    fs.chmodSync(target, 0o755);
    if (process.platform === "darwin")
      run("/usr/bin/codesign", ["--force", "--sign", "-", target]);
    return { version: verifyAlembicBinary(target), source: "pyinstaller" };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const destination = path.resolve(
    process.env.VISION_ALEMBIC_DESTINATION ||
      path.join(appRoot, "native-runtime", "vision-alembic"),
  );
  const result = prepareAlembicRuntime({ destination });
  console.log(`Prepared ${result.version} migration runtime`);
}
