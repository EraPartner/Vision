"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PYINSTALLER_VERSION = "6.22.2";
const ALEMBIC_VERSION = "1.19.1";
const ALEMBIC_RUNTIME_IMPORTS = Object.freeze([
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

function run(executable, args, options = {}) {
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

function executable(candidate) {
  if (!candidate) return false;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findPython(explicitPython) {
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

function assertSafeDestination(destination) {
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

function pyInstallerEnvironment(configDirectory, source = process.env) {
  const env = {};
  for (const key of BUILD_ENV_KEYS) {
    if (typeof source[key] === "string") env[key] = source[key];
  }
  env.PYINSTALLER_CONFIG_DIR = path.resolve(configDirectory);
  return env;
}

function verifyAlembicBinary(binary) {
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

function pyInstallerArgs({ dist, work, spec, entrypoint }) {
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

function prepareAlembicRuntime({ python, destination, prebuilt } = {}) {
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
        entrypoint: path.join(__dirname, "vision-alembic.py"),
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
      path.join(__dirname, "..", "native-runtime", "vision-alembic"),
  );
  const result = prepareAlembicRuntime({ destination });
  console.log(`Prepared ${result.version} migration runtime`);
}

module.exports = {
  ALEMBIC_VERSION,
  ALEMBIC_RUNTIME_IMPORTS,
  PYINSTALLER_VERSION,
  assertSafeDestination,
  findPython,
  pyInstallerArgs,
  pyInstallerEnvironment,
  prepareAlembicRuntime,
  verifyAlembicBinary,
};
