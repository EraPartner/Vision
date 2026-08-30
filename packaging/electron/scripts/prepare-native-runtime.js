"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { preparePostgresRuntime } = require("./prepare-postgres-runtime");
const { prepareAlembicRuntime } = require("./prepare-alembic-runtime");
const { prepareChromiumRuntime } = require("./prepare-chromium-runtime");
const { replaceGeneratedDirectory } = require("./replace-generated-directory");

const electronRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(electronRoot, "..", "..");
const defaultOutputRoot = path.join(electronRoot, "native-runtime");
const frontendRoot = process.env.VISION_FRONTEND_DIST
  ? path.resolve(process.env.VISION_FRONTEND_DIST)
  : path.join(repoRoot, "dist");

function assertSafeNativeDestination(candidate) {
  const destination = path.resolve(candidate);
  if (
    path.basename(destination) !== "native-runtime" ||
    path.dirname(destination) === destination
  ) {
    throw new Error("Native runtime destination must end in native-runtime");
  }
  return destination;
}

function replaceOutputContents(stagingRoot, outputRoot) {
  const replacement = replaceGeneratedDirectory(stagingRoot, outputRoot);
  if (replacement.retainedPrevious) {
    console.warn(
      `Previous generated native runtime retained at ${replacement.retainedPrevious}`,
    );
  }
}

function findExecutable(candidates) {
  return candidates.find((candidate) => {
    if (!candidate) return false;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function signCompiledBackend(binary) {
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

function copyTree(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry);
      return !["__pycache__", ".ruff_cache", ".DS_Store"].includes(name);
    },
  });
}

function hashFile(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function manifestEntries(root) {
  const entries = [];
  function visit(current) {
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

function run() {
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
        path.join(repoRoot, "apps", "node-backend", "src", "main.js"),
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
    copyTree(path.join(repoRoot, "alembic"), path.join(stagingRoot, "alembic"));
    fs.mkdirSync(path.join(stagingRoot, "config"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "config", "alembic.ini"),
      path.join(stagingRoot, "config", "alembic.ini"),
    );
    fs.mkdirSync(path.join(stagingRoot, "docker", "postgres-init"), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(repoRoot, "docker", "postgres-init", "app-role-grants.sql.tpl"),
      path.join(
        stagingRoot,
        "docker",
        "postgres-init",
        "app-role-grants.sql.tpl",
      ),
    );
    preparePostgresRuntime({
      sourceBin: process.env.VISION_POSTGRES_SOURCE_BIN,
      destination: path.join(stagingRoot, "postgres"),
    });
    prepareAlembicRuntime({
      python: process.env.VISION_PYTHON_BIN,
      prebuilt: process.env.VISION_ALEMBIC_RUNTIME_BIN,
      destination: path.join(stagingRoot, "vision-alembic"),
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

    const packageJson = JSON.parse(
      fs.readFileSync(path.join(electronRoot, "package.json"), "utf8"),
    );
    const entries = manifestEntries(stagingRoot);
    const manifest = {
      version: 1,
      appVersion: packageJson.version,
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
      `Prepared native runtime ${packageJson.version}: ${entries.length} files`,
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

module.exports = {
  assertSafeNativeDestination,
  manifestEntries,
  run,
  signCompiledBackend,
};
