"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { replaceGeneratedDirectory } = require("./replace-generated-directory");

const POSTGRES_MAJOR = 18;
const POSTGRES_VERSION = "18.6";
const REQUIRED_TOOLS = Object.freeze([
  "createdb",
  "dropdb",
  "initdb",
  "pg_ctl",
  "pg_dump",
  "pg_isready",
  "pg_restore",
  "postgres",
  "psql",
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

function findSourceBin(explicitSource) {
  const candidates = [
    explicitSource,
    process.env.VISION_POSTGRES_SOURCE_BIN,
    "/Applications/Postgres.app/Contents/Versions/18/bin",
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/local/opt/postgresql@18/bin",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const binDir = fs.existsSync(path.join(resolved, "pg_config"))
      ? resolved
      : path.join(resolved, "bin");
    if (fs.existsSync(path.join(binDir, "pg_config"))) return binDir;
  }
  throw new Error(
    "A PostgreSQL 18.6 build source is required to prepare the packaged runtime. Set VISION_POSTGRES_SOURCE_BIN or install Postgres.app/Homebrew for build-time use.",
  );
}

function commonDirectory(paths) {
  const resolved = paths.map((entry) => path.resolve(entry));
  const roots = new Set(resolved.map((entry) => path.parse(entry).root));
  if (roots.size !== 1)
    throw new Error("PostgreSQL paths are on different roots");
  const parts = resolved.map((entry) => entry.split(path.sep).filter(Boolean));
  const shared = [];
  for (let index = 0; ; index += 1) {
    const value = parts[0][index];
    if (value === undefined || parts.some((entry) => entry[index] !== value))
      break;
    shared.push(value);
  }
  if (shared.length === 0)
    throw new Error("PostgreSQL build paths have no safe common directory");
  return `${path.parse(resolved[0]).root}${shared.join(path.sep)}`;
}

function inspectDistribution(sourceBin) {
  const pgConfig = path.join(sourceBin, "pg_config");
  const versionText = run(pgConfig, ["--version"]);
  const versionMatch = /PostgreSQL\s+(\d+)\.(\d+)/i.exec(versionText);
  const version = versionMatch
    ? `${Number(versionMatch[1])}.${Number(versionMatch[2])}`
    : undefined;
  if (version !== POSTGRES_VERSION) {
    throw new Error(
      `Packaged PostgreSQL must be ${POSTGRES_VERSION}; found ${version || "unknown"}`,
    );
  }
  const directories = {
    bin: run(pgConfig, ["--bindir"]),
    lib: run(pgConfig, ["--libdir"]),
    pkglib: run(pgConfig, ["--pkglibdir"]),
    share: run(pgConfig, ["--sharedir"]),
  };
  for (const [label, directory] of Object.entries(directories)) {
    const stat = fs.statSync(directory);
    if (!stat.isDirectory())
      throw new Error(`PostgreSQL ${label} path is not a directory`);
  }
  for (const tool of REQUIRED_TOOLS) {
    fs.accessSync(path.join(directories.bin, tool), fs.constants.X_OK);
  }
  const prefix = commonDirectory(Object.values(directories));
  return { pgConfig, version, versionText, directories, prefix };
}

function relativeInside(prefix, target) {
  const relative = path.relative(prefix, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("PostgreSQL build directory escaped its common prefix");
  }
  return relative;
}

function copyDirectory(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
}

function materializeSymlinks(root) {
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const source = fs.realpathSync(absolute);
      const sourceStat = fs.statSync(source);
      fs.unlinkSync(absolute);
      if (sourceStat.isDirectory()) {
        fs.cpSync(source, absolute, { recursive: true, dereference: true });
        visit(absolute);
      } else if (sourceStat.isFile()) {
        fs.copyFileSync(source, absolute);
      } else {
        throw new Error("PostgreSQL build contains an unsupported symlink");
      }
    }
  }
  visit(root);
}

function assertNoSymlinks(root) {
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Packaged PostgreSQL must not contain symbolic links");
      }
      if (entry.isDirectory()) visit(absolute);
    }
  }
  visit(root);
}

function walkFiles(root) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  visit(root);
  return files;
}

function normalizePermissions(root) {
  function visit(current) {
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

function isMachO(filePath) {
  const result = spawnSync("/usr/bin/file", ["-b", filePath], {
    encoding: "utf8",
  });
  return result.status === 0 && /Mach-O/.test(result.stdout || "");
}

function linkedLibraries(filePath) {
  const output = run("/usr/bin/otool", ["-L", filePath]);
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+\(/, 1)[0])
    .filter(Boolean);
}

function dynamicLibraryId(filePath) {
  const result = spawnSync("/usr/bin/otool", ["-D", filePath], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  return (result.stdout || "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find(Boolean);
}

function systemLibrary(dependency) {
  return (
    dependency.startsWith("/usr/lib/") ||
    dependency.startsWith("/System/Library/")
  );
}

function mappedDestination(dependency, mappings) {
  const resolved = path.resolve(dependency);
  for (const mapping of mappings) {
    const relative = path.relative(mapping.source, resolved);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      const destination = path.join(mapping.destination, relative);
      if (fs.existsSync(destination)) return destination;
    }
  }
  return undefined;
}

function formulaIdentity(filePath) {
  const resolved = fs.realpathSync(filePath);
  const match = /\/Cellar\/([^/]+)\/([^/]+)\//.exec(resolved);
  return match ? { name: match[1], version: match[2] } : undefined;
}

function copyLicenseFiles(sourceFile, licensesRoot, copied) {
  const formula = formulaIdentity(sourceFile);
  if (!formula || copied.has(formula.name)) return;
  copied.add(formula.name);
  const marker = `/Cellar/${formula.name}/${formula.version}/`;
  const real = fs.realpathSync(sourceFile);
  const formulaRoot = real.slice(0, real.indexOf(marker) + marker.length - 1);
  const candidates = walkFiles(formulaRoot).filter((entry) => {
    const relative = path.relative(formulaRoot, entry);
    return (
      relative.split(path.sep).length <= 3 &&
      /^(?:copying|copyright|licen[cs]e|notice)(?:\..*)?$/i.test(
        path.basename(entry),
      )
    );
  });
  const destination = path.join(licensesRoot, formula.name);
  fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
  if (candidates.length === 0) {
    fs.writeFileSync(
      path.join(destination, "SOURCE.txt"),
      `${formula.name} ${formula.version} was supplied by Homebrew. See the Homebrew formula and upstream project for license terms.\n`,
    );
    return;
  }
  for (const candidate of candidates) {
    const relativeName = path
      .relative(formulaRoot, candidate)
      .replaceAll(path.sep, "__");
    fs.copyFileSync(candidate, path.join(destination, relativeName));
  }
}

function relinkDistribution(root, mappings, sourceFiles = []) {
  if (process.platform !== "darwin")
    throw new Error("PostgreSQL macOS relocation must run on macOS");
  const vendorRoot = path.join(root, "vendor", "lib");
  const licensesRoot = path.join(root, "licenses");
  fs.mkdirSync(vendorRoot, { recursive: true, mode: 0o755 });
  fs.mkdirSync(licensesRoot, { recursive: true, mode: 0o755 });
  const copiedLicenses = new Set();
  for (const source of sourceFiles)
    copyLicenseFiles(source, licensesRoot, copiedLicenses);

  const queue = walkFiles(root).filter(isMachO);
  const origins = new Map();
  for (const filePath of queue) {
    for (const mapping of mappings) {
      const relative = path.relative(mapping.destination, filePath);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        origins.set(filePath, path.join(mapping.source, relative));
        break;
      }
    }
  }
  const visited = new Set();
  while (queue.length > 0) {
    const filePath = queue.shift();
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    const libraryId = dynamicLibraryId(filePath);
    for (const dependency of linkedLibraries(filePath)) {
      if (dependency === libraryId || systemLibrary(dependency)) continue;
      if (dependency.startsWith("@loader_path/")) {
        const siblingName = dependency.slice("@loader_path/".length);
        const destination = path.resolve(path.dirname(filePath), siblingName);
        if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) {
          throw new Error(
            "PostgreSQL loader-relative dependency escaped the runtime",
          );
        }
        if (!fs.existsSync(destination)) {
          const origin = origins.get(filePath);
          const source = origin
            ? path.resolve(path.dirname(origin), siblingName)
            : undefined;
          if (!source || !fs.existsSync(source)) {
            throw new Error(
              `PostgreSQL loader-relative dependency is missing: ${path.basename(dependency)}`,
            );
          }
          fs.copyFileSync(fs.realpathSync(source), destination);
          fs.chmodSync(destination, 0o755);
          origins.set(destination, source);
          if (isMachO(destination)) queue.push(destination);
          copyLicenseFiles(source, licensesRoot, copiedLicenses);
        }
        continue;
      }
      if (dependency.startsWith("@")) continue;
      let destination = mappedDestination(dependency, mappings);
      if (!destination) {
        const source = fs.realpathSync(dependency);
        // Preserve the filename used by the Mach-O load command. Homebrew
        // commonly exposes a compatibility symlink such as
        // libicudata.78.dylib whose real file has a longer versioned name.
        destination = path.join(vendorRoot, path.basename(dependency));
        if (!fs.existsSync(destination)) {
          fs.copyFileSync(source, destination);
          fs.chmodSync(destination, 0o755);
          origins.set(destination, dependency);
          if (isMachO(destination)) queue.push(destination);
        }
        copyLicenseFiles(source, licensesRoot, copiedLicenses);
      }
      const relative = path
        .relative(path.dirname(filePath), destination)
        .split(path.sep)
        .join("/");
      run("/usr/bin/install_name_tool", [
        "-change",
        dependency,
        `@loader_path/${relative}`,
        filePath,
      ]);
    }
    if (libraryId) {
      run("/usr/bin/install_name_tool", [
        "-id",
        `@loader_path/${path.basename(filePath)}`,
        filePath,
      ]);
    }
  }

  for (const filePath of walkFiles(root).filter(isMachO)) {
    const libraryId = dynamicLibraryId(filePath);
    const unsafe = linkedLibraries(filePath).filter(
      (dependency) =>
        dependency !== libraryId &&
        !systemLibrary(dependency) &&
        path.isAbsolute(dependency),
    );
    if (unsafe.length > 0) {
      throw new Error(
        `Relocated PostgreSQL file retains an absolute dependency: ${path.basename(filePath)}`,
      );
    }
    run("/usr/bin/codesign", ["--force", "--sign", "-", filePath]);
  }
}

function assertSafeDestination(destination) {
  const target = path.resolve(destination);
  if (
    path.basename(target) !== "postgres" ||
    target === path.parse(target).root ||
    target === os.homedir() ||
    target.length < 20
  ) {
    throw new Error("Unsafe packaged PostgreSQL destination");
  }
  return target;
}

function preparePostgresRuntime({ sourceBin, destination }) {
  const resolvedSourceBin = findSourceBin(sourceBin);
  const distribution = inspectDistribution(resolvedSourceBin);
  const target = assertSafeDestination(destination);
  const staging = fs.mkdtempSync(
    path.join(os.tmpdir(), "vision-postgres-runtime-"),
  );
  try {
    const root = path.join(staging, "root");
    const uniqueDirectories = new Map();
    for (const directory of Object.values(distribution.directories)) {
      const relative = relativeInside(distribution.prefix, directory);
      uniqueDirectories.set(directory, path.join(root, relative));
    }
    for (const [source, targetDirectory] of uniqueDirectories)
      copyDirectory(source, targetDirectory);
    materializeSymlinks(root);
    assertNoSymlinks(root);
    normalizePermissions(root);

    const mappings = [...uniqueDirectories].map(([source, destination_]) => ({
      source: path.resolve(source),
      destination: path.resolve(destination_),
    }));
    relinkDistribution(root, mappings, [distribution.pgConfig]);

    const binRelative = path
      .relative(root, uniqueDirectories.get(distribution.directories.bin))
      .split(path.sep)
      .join("/");
    const metadata = {
      version: 1,
      postgresMajor: POSTGRES_MAJOR,
      postgresVersion: distribution.version,
      platform: process.platform,
      architecture: process.arch,
      binRelative,
      sourceKind: distribution.pgConfig.includes("Postgres.app")
        ? "postgres-app"
        : "build-host",
    };
    fs.writeFileSync(
      path.join(staging, "runtime.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { mode: 0o644 },
    );
    const replacement = replaceGeneratedDirectory(staging, target);
    if (replacement.retainedPrevious) {
      console.warn(
        `Previous generated PostgreSQL payload retained at ${replacement.retainedPrevious}`,
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
    process.env.VISION_POSTGRES_DESTINATION ||
      path.join(__dirname, "..", "native-runtime", "postgres"),
  );
  const metadata = preparePostgresRuntime({ destination });
  console.log(
    `Prepared PostgreSQL ${metadata.postgresVersion} runtime for ${metadata.architecture}`,
  );
}

module.exports = {
  POSTGRES_MAJOR,
  POSTGRES_VERSION,
  REQUIRED_TOOLS,
  commonDirectory,
  assertSafeDestination,
  assertNoSymlinks,
  inspectDistribution,
  materializeSymlinks,
  preparePostgresRuntime,
};
