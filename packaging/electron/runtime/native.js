"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { DATABASE_STATS_SQL, parseDatabaseStats } = require("./database-stats");

const POSTGRES_MAJOR = 18;
const POSTGRES_MINOR = 6;
const CHROMIUM_VERSION = "150.0.7871.24";
const DEFAULT_POSTGRES_PORT = 54329;
const DEFAULT_APP_PORT = 3002;
const LOOPBACK_HOST = "127.0.0.1";
const RUNTIME_MANAGED_MATERIALIZED_VIEWS = Object.freeze([
  "mv_monthly_summary",
  "mv_category_totals",
  "mv_cashflow_daily",
]);
const NATIVE_APPLICATION_ENV_KEYS = Object.freeze([
  "TWELVE_DATA_API_KEY",
  "FINNHUB_API_KEY",
  "FMP_API_KEY",
  "ALPHA_VANTAGE_API_KEY",
  "FRED_API_KEY",
  "ADMIN_AUTH_TOKEN",
]);

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
];

function executableExists(candidate) {
  if (!candidate || typeof candidate !== "string") return false;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function safeChildEnv(overrides = {}) {
  const env = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = String(value);
  }
  const inheritedPath = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter((entry) => !/\/(?:opt\/)?postgresql@18\/bin\/?$/.test(entry))
    .join(path.delimiter);
  env.PATH = [
    inheritedPath,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
    .filter(Boolean)
    .join(":");
  return env;
}

function validateArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("Process arguments must be a string array");
  }
  return args;
}

function managedPostgresArgs(dataDirectory, postgresPort) {
  return validateArgs([
    "-D",
    dataDirectory,
    "-h",
    LOOPBACK_HOST,
    "-p",
    String(postgresPort),
    "-k",
    "",
  ]);
}

function defaultRunFile(bin, args, options = {}) {
  validateArgs(args);
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        cwd: options.cwd,
        env: options.env || safeChildEnv(),
        timeout: options.timeout ?? 30_000,
        maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(
            (stderr && stderr.trim()) ||
              error.message ||
              `${path.basename(bin)} failed`,
          );
          wrapped.code = error.code;
          wrapped.exitCode = error.code;
          reject(wrapped);
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "" });
      },
    );
  });
}

function parsePostgresMajor(output) {
  const match =
    /PostgreSQL\)\s+(\d+)(?:\.\d+)?|PostgreSQL\s+(\d+)(?:\.\d+)?/i.exec(
      String(output || ""),
    );
  return match ? Number(match[1] || match[2]) : undefined;
}

function parsePostgresVersionNumber(output) {
  const match =
    /PostgreSQL\)\s+(\d+)(?:\.(\d+))?|PostgreSQL\s+(\d+)(?:\.(\d+))?/i.exec(
      String(output || ""),
    );
  if (!match) return undefined;
  const major = Number(match[1] || match[3]);
  const minor = Number(match[2] || match[4] || 0);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return undefined;
  return major * 10_000 + minor;
}

function revisionNumericPrefix(revision) {
  const match = /^(\d+)/.exec(String(revision || ""));
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function pickHighestRevision(revisions) {
  const rows = revisions
    .map((revision) => String(revision).trim())
    .filter(Boolean);
  if (rows.length === 0) return "";
  return rows.reduce((best, candidate) => {
    const candidatePrefix = revisionNumericPrefix(candidate);
    const bestPrefix = revisionNumericPrefix(best);
    if (
      candidatePrefix !== undefined &&
      (bestPrefix === undefined || candidatePrefix > bestPrefix)
    ) {
      return candidate;
    }
    if (candidatePrefix === bestPrefix && candidate > best) return candidate;
    return best;
  });
}

function assertPostgres18Version(label, output) {
  const major = parsePostgresMajor(output);
  if (major !== POSTGRES_MAJOR) {
    const error = new Error(
      `${label} must be PostgreSQL ${POSTGRES_MAJOR}; found major ${major ?? "unknown"}`,
    );
    error.code = "POSTGRES_WRONG_VERSION";
    throw error;
  }
  return major;
}

function bundledPostgresBin(runtimeRoot) {
  if (!runtimeRoot) return undefined;
  const postgresRoot = path.join(path.resolve(runtimeRoot), "postgres");
  const metadataPath = path.join(postgresRoot, "runtime.json");
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    const wrapped = new Error("Packaged PostgreSQL metadata is invalid");
    wrapped.code = "POSTGRES_RUNTIME_CORRUPT";
    throw wrapped;
  }
  if (
    metadata?.version !== 1 ||
    metadata.postgresMajor !== POSTGRES_MAJOR ||
    metadata.postgresVersion !== `${POSTGRES_MAJOR}.${POSTGRES_MINOR}` ||
    metadata.platform !== process.platform ||
    metadata.architecture !== process.arch ||
    typeof metadata.binRelative !== "string" ||
    path.isAbsolute(metadata.binRelative) ||
    metadata.binRelative.split(/[\\/]/).includes("..")
  ) {
    const error = new Error(
      "Packaged PostgreSQL metadata does not match this Vision build",
    );
    error.code = "POSTGRES_RUNTIME_MISMATCH";
    throw error;
  }
  const binDir = path.resolve(
    postgresRoot,
    "root",
    ...metadata.binRelative.split("/"),
  );
  const expectedRoot = `${path.resolve(postgresRoot, "root")}${path.sep}`;
  if (!binDir.startsWith(expectedRoot)) {
    const error = new Error("Packaged PostgreSQL binary path is unsafe");
    error.code = "POSTGRES_RUNTIME_CORRUPT";
    throw error;
  }
  return binDir;
}

function postgresBinCandidates(
  explicitBinDir,
  runtimeRoot,
  allowExternalPostgres = false,
) {
  if (explicitBinDir) return [explicitBinDir];
  if (process.env.VISION_POSTGRES_BIN) return [process.env.VISION_POSTGRES_BIN];
  const candidates = [bundledPostgresBin(runtimeRoot)].filter(Boolean);
  if (allowExternalPostgres) {
    candidates.push(
      "/Applications/Postgres.app/Contents/Versions/18/bin",
      "/opt/homebrew/opt/postgresql@18/bin",
      "/usr/local/opt/postgresql@18/bin",
    );
  }
  return candidates;
}

async function discoverPostgres18({
  binDir,
  runtimeRoot,
  allowExternalPostgres = false,
  runFile = defaultRunFile,
} = {}) {
  const required = [
    "postgres",
    "initdb",
    "pg_ctl",
    "psql",
    "pg_dump",
    "pg_restore",
    "pg_isready",
    "createdb",
    "dropdb",
  ];
  const attempts = [];
  const bundledCandidate = bundledPostgresBin(runtimeRoot);
  for (const candidate of postgresBinCandidates(
    binDir,
    runtimeRoot,
    allowExternalPostgres,
  )) {
    const resolved = path.resolve(candidate);
    if (attempts.includes(resolved)) continue;
    attempts.push(resolved);
    if (!required.every((name) => executableExists(path.join(resolved, name))))
      continue;

    const versions = {};
    const versionNumbers = {};
    for (const name of ["postgres", "psql", "pg_dump", "pg_restore"]) {
      const executable = path.join(resolved, name);
      const { stdout, stderr } = await runFile(executable, ["--version"], {
        timeout: 10_000,
      });
      const output = `${stdout}\n${stderr}`;
      assertPostgres18Version(name, output);
      versions[name] = output.trim();
      versionNumbers[name] = parsePostgresVersionNumber(output);
    }
    return {
      binDir: resolved,
      versions,
      versionNumbers,
      managed:
        bundledCandidate !== undefined &&
        resolved === path.resolve(bundledCandidate),
    };
  }

  const error = new Error(
    "Vision's packaged PostgreSQL 18.6 runtime was not found. Reinstall Vision or prepare the native runtime before starting.",
  );
  error.code = "POSTGRES_NOT_FOUND";
  throw error;
}

function normalizeRuntimeId(value) {
  const normalized = String(value || "vision")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(normalized)) {
    throw new Error(`Invalid native runtime id: ${value}`);
  }
  return normalized;
}

function runtimeNames(runtimeId) {
  const id = normalizeRuntimeId(runtimeId);
  return {
    id,
    database: id,
    adminRole: `${id}_admin`,
    ownerRole: `${id}_owner`,
    appRole: `${id}_app`,
  };
}

function validateIdentifier(value, label) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(String(value || ""))) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function validateNetworkPort(value, label = "network port") {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${label}`);
  }
  return port;
}

function classifyDatabaseSwitchState({ liveExists, previousExists }) {
  if (previousExists && liveExists) return "activated";
  if (previousExists && !liveExists) return "between-renames";
  if (!previousExists && liveExists) return "before-renames";
  return "unsafe";
}

function quoteIdentifier(value) {
  validateIdentifier(value, "PostgreSQL identifier");
  return `"${value}"`;
}

function materializedViewOwnershipSql(appRole) {
  const owner = quoteIdentifier(appRole);
  return RUNTIME_MANAGED_MATERIALIZED_VIEWS.map(
    (view) =>
      `ALTER MATERIALIZED VIEW IF EXISTS ${quoteIdentifier("public")}.${quoteIdentifier(view)} OWNER TO ${owner};`,
  ).join("\n");
}

function quoteHexSecret(value) {
  if (!/^[0-9a-f]{64}$/.test(String(value || ""))) {
    throw new Error(
      "Native database credentials must be 64 lowercase hexadecimal characters",
    );
  }
  return `'${value}'`;
}

function parseEnvFile(contents) {
  const result = {};
  for (const line of String(contents || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    result[key] = trimmed.slice(equals + 1);
  }
  return result;
}

function databaseConfigFromEnv(contents) {
  const env = parseEnvFile(contents);
  const appUrl = new URL(env.DATABASE_URL);
  const ownerUrl = new URL(env.DATABASE_URL_MIGRATIONS);
  const database = decodeURIComponent(appUrl.pathname.replace(/^\//, ""));
  const ownerDatabase = decodeURIComponent(
    ownerUrl.pathname.replace(/^\//, ""),
  );
  const config = {
    database: validateIdentifier(database, "database name"),
    adminRole: validateIdentifier(
      env.VISION_POSTGRES_ADMIN_ROLE,
      "cluster administrator role",
    ),
    adminPassword: env.VISION_POSTGRES_ADMIN_PASSWORD,
    appRole: validateIdentifier(
      decodeURIComponent(appUrl.username),
      "application role",
    ),
    appPassword: decodeURIComponent(appUrl.password),
    ownerRole: validateIdentifier(
      decodeURIComponent(ownerUrl.username),
      "owner role",
    ),
    ownerPassword: decodeURIComponent(ownerUrl.password),
    host: appUrl.hostname,
    port: validateNetworkPort(
      appUrl.port || DEFAULT_POSTGRES_PORT,
      "native PostgreSQL port",
    ),
    env,
  };
  if (ownerDatabase !== config.database)
    throw new Error("Native database URLs target different databases");
  if (config.host !== LOOPBACK_HOST || ownerUrl.hostname !== LOOPBACK_HOST) {
    throw new Error("Native PostgreSQL URLs must use 127.0.0.1");
  }
  if (
    validateNetworkPort(
      ownerUrl.port || DEFAULT_POSTGRES_PORT,
      "migration PostgreSQL port",
    ) !== config.port
  ) {
    throw new Error("Native database URLs target different PostgreSQL ports");
  }
  quoteHexSecret(config.appPassword);
  quoteHexSecret(config.ownerPassword);
  quoteHexSecret(config.adminPassword);
  if (new Set([config.adminRole, config.ownerRole, config.appRole]).size !== 3)
    throw new Error("Native PostgreSQL roles must be distinct");
  return config;
}

function nativeEnvContents(
  names,
  { postgresPort = DEFAULT_POSTGRES_PORT } = {},
) {
  const appPassword = crypto.randomBytes(32).toString("hex");
  const ownerPassword = crypto.randomBytes(32).toString("hex");
  const adminPassword = crypto.randomBytes(32).toString("hex");
  return [
    "# Auto-generated by Vision native runtime. Do not commit or share this file.",
    `VISION_POSTGRES_ADMIN_ROLE=${names.adminRole}`,
    `VISION_POSTGRES_ADMIN_PASSWORD=${adminPassword}`,
    `DATABASE_URL=postgresql://${names.appRole}:${appPassword}@${LOOPBACK_HOST}:${postgresPort}/${names.database}`,
    `DATABASE_URL_MIGRATIONS=postgresql://${names.ownerRole}:${ownerPassword}@${LOOPBACK_HOST}:${postgresPort}/${names.database}`,
    "",
  ].join("\n");
}

function ensureNativeAdminEnv(contents, names) {
  const env = parseEnvFile(contents);
  if (env.VISION_POSTGRES_ADMIN_ROLE && env.VISION_POSTGRES_ADMIN_PASSWORD) {
    return contents;
  }
  const base = String(contents || "").replace(/\n?$/, "\n");
  return `${base}VISION_POSTGRES_ADMIN_ROLE=${names.adminRole}\nVISION_POSTGRES_ADMIN_PASSWORD=${crypto.randomBytes(32).toString("hex")}\n`;
}

function validateApplicationEnv(values) {
  const filtered = {};
  for (const key of NATIVE_APPLICATION_ENV_KEYS) {
    const value = values?.[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || /[\r\n\0]/.test(value))
      throw new Error(`Invalid value for native environment key ${key}`);
    filtered[key] = value;
  }
  return filtered;
}

function buildNativeBackendEnv({
  runtimeEnv,
  port,
  paths,
  runtimeRoot,
  repoRoot,
  tools,
}) {
  const resolvedRuntimeRoot = runtimeRoot || repoRoot;
  if (!resolvedRuntimeRoot) {
    throw new Error("Native backend runtime root is unavailable");
  }
  return safeChildEnv({
    ...runtimeEnv,
    SERVER_HOST: LOOPBACK_HOST,
    PORT: String(port),
    NODE_ENV: "production",
    ENVIRONMENT: "production",
    ATTACHMENTS_DIR: paths.attachments,
    VISION_CACHE_DIR: paths.cache,
    VISION_RUNTIME_ROOT: resolvedRuntimeRoot,
    VISION_DIST_DIR: path.join(resolvedRuntimeRoot, "dist"),
    VISION_SKIP_CONFIG_ENV_LOCAL: "true",
    ALEMBIC_BIN: tools.alembic,
    ALEMBIC_CONFIG: path.join(resolvedRuntimeRoot, "config", "alembic.ini"),
    PUPPETEER_EXECUTABLE_PATH: tools.chrome,
    OLLAMA_URL: "http://127.0.0.1:11434",
    ADMIN_ALLOW_TOKENLESS_NONLOOPBACK: "false",
  });
}

async function writeAtomic(filePath, contents, mode = 0o600) {
  await fs.promises.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.promises.writeFile(tempPath, contents, { mode });
    await fs.promises.rename(tempPath, filePath);
    await fs.promises.chmod(filePath, mode);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function writeAtomicJson(filePath, value) {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isPortFree(
  port,
  host = LOOPBACK_HOST,
  createServer = net.createServer,
) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function httpGetJson(url, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("health timeout")));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDetailedHealthReady(result) {
  return result?.database?.connected === true;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findFirstExecutable(candidates) {
  for (const candidate of candidates) {
    if (executableExists(candidate)) return candidate;
  }
  return undefined;
}

async function verifyRuntimeManifest(runtimeRoot, { required = false } = {}) {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
  } catch (error) {
    if (!required && error.code === "ENOENT") return { status: "not-present" };
    const wrapped = new Error("Native runtime manifest is missing or invalid");
    wrapped.code = "NATIVE_RUNTIME_CORRUPT";
    throw wrapped;
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) {
    const error = new Error(
      "Native runtime manifest has an unsupported format",
    );
    error.code = "NATIVE_RUNTIME_CORRUPT";
    throw error;
  }
  const expectedPaths = new Set();
  for (const entry of manifest.entries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !/^[A-Za-z0-9._@+/-]+$/.test(entry.path) ||
      path.isAbsolute(entry.path) ||
      entry.path.split("/").includes("..") ||
      !/^[0-9a-f]{64}$/.test(String(entry.sha256 || "")) ||
      expectedPaths.has(entry.path)
    ) {
      const error = new Error(
        "Native runtime manifest contains an invalid entry",
      );
      error.code = "NATIVE_RUNTIME_CORRUPT";
      throw error;
    }
    expectedPaths.add(entry.path);
    const absolute = path.join(runtimeRoot, ...entry.path.split("/"));
    let contents;
    try {
      contents = await fs.promises.readFile(absolute);
    } catch {
      const error = new Error(
        `Native runtime payload is missing ${entry.path}`,
      );
      error.code = "NATIVE_RUNTIME_CORRUPT";
      throw error;
    }
    const digest = crypto.createHash("sha256").update(contents).digest("hex");
    if (contents.length !== entry.bytes || digest !== entry.sha256) {
      const error = new Error(
        `Native runtime payload failed checksum verification: ${entry.path}`,
      );
      error.code = "NATIVE_RUNTIME_CORRUPT";
      throw error;
    }
  }
  const actualPaths = new Set();
  async function visit(current) {
    const children = await fs.promises.readdir(current, {
      withFileTypes: true,
    });
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = path
        .relative(runtimeRoot, absolute)
        .split(path.sep)
        .join("/");
      if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) {
        const error = new Error(
          `Native runtime payload contains an unsupported entry: ${relative}`,
        );
        error.code = "NATIVE_RUNTIME_CORRUPT";
        throw error;
      }
      if (child.isDirectory()) await visit(absolute);
      else if (relative !== "manifest.json") actualPaths.add(relative);
    }
  }
  await visit(runtimeRoot);
  if (
    actualPaths.size !== expectedPaths.size ||
    [...actualPaths].some((entry) => !expectedPaths.has(entry))
  ) {
    const error = new Error(
      "Native runtime payload contains files not covered by its manifest",
    );
    error.code = "NATIVE_RUNTIME_CORRUPT";
    throw error;
  }
  return { status: "verified", entries: manifest.entries.length };
}

function bundledChromiumPath(runtimeRoot) {
  if (!runtimeRoot) return undefined;
  const chromiumRoot = path.join(path.resolve(runtimeRoot), "chromium");
  const metadataPath = path.join(chromiumRoot, "runtime.json");
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    const wrapped = new Error("Packaged Chromium metadata is invalid");
    wrapped.code = "CHROMIUM_RUNTIME_CORRUPT";
    throw wrapped;
  }
  if (
    metadata?.version !== 1 ||
    metadata.browser !== "chrome-headless-shell" ||
    metadata.browserVersion !== CHROMIUM_VERSION ||
    metadata.platform !== process.platform ||
    metadata.architecture !== process.arch ||
    typeof metadata.executableRelative !== "string" ||
    path.isAbsolute(metadata.executableRelative) ||
    metadata.executableRelative.split(/[\\/]/).includes("..")
  ) {
    const error = new Error(
      "Packaged Chromium metadata does not match this Vision build",
    );
    error.code = "CHROMIUM_RUNTIME_MISMATCH";
    throw error;
  }
  const executable = path.resolve(
    chromiumRoot,
    ...metadata.executableRelative.split("/"),
  );
  if (
    !executable.startsWith(`${path.resolve(chromiumRoot)}${path.sep}`) ||
    !executableExists(executable)
  ) {
    const error = new Error(
      "Packaged Chromium executable is missing or unsafe",
    );
    error.code = "CHROMIUM_RUNTIME_CORRUPT";
    throw error;
  }
  return executable;
}

function discoverChrome(explicitPath, runtimeRoot) {
  return findFirstExecutable([
    explicitPath,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    bundledChromiumPath(runtimeRoot),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/opt/homebrew/bin/chromium",
    "/usr/local/bin/chromium",
  ]);
}

function assertNativeChromeAvailable(chromePath) {
  if (chromePath) return chromePath;
  const error = new Error(
    "Vision's packaged Chrome Headless Shell was not found. Reinstall Vision or prepare the native runtime before starting.",
  );
  error.code = "NATIVE_CHROMIUM_NOT_FOUND";
  throw error;
}

function resolveBun(explicitPath, packagedRuntimeRoot) {
  return findFirstExecutable([
    explicitPath,
    process.env.VISION_BUN_BIN,
    packagedRuntimeRoot && path.join(packagedRuntimeRoot, "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ]);
}

async function resolveAlembic(
  explicitPath,
  repoRoot,
  runFile = defaultRunFile,
) {
  const candidates = [
    explicitPath,
    process.env.ALEMBIC_BIN,
    repoRoot && path.join(repoRoot, "vision-alembic"),
    repoRoot && path.join(repoRoot, "venv", "bin", "alembic"),
    "/opt/homebrew/bin/alembic",
    "/usr/local/bin/alembic",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!executableExists(candidate)) continue;
    try {
      await runFile(candidate, ["--version"], { timeout: 10_000 });
      return candidate;
    } catch {
      // A checked-in venv may belong to a container and have a dead interpreter.
    }
  }
  const error = new Error(
    "Vision's packaged Alembic migration runtime was not found. Reinstall Vision or prepare the native runtime before starting.",
  );
  error.code = "ALEMBIC_NOT_FOUND";
  throw error;
}

async function directoryFingerprint(rootDir) {
  const entries = [];
  async function visit(current, relative) {
    let names;
    try {
      names = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of names) {
      if (entry.isSymbolicLink())
        throw new Error(
          `Attachment tree contains a symlink: ${path.join(relative, entry.name)}`,
        );
      const absolute = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, childRelative);
      } else if (entry.isFile()) {
        const hash = crypto.createHash("sha256");
        const handle = await fs.promises.open(absolute, "r");
        try {
          for await (const chunk of handle.createReadStream({
            autoClose: false,
          }))
            hash.update(chunk);
        } finally {
          await handle.close().catch(() => {});
        }
        const stat = await fs.promises.stat(absolute);
        entries.push({
          path: childRelative.split(path.sep).join("/"),
          size: stat.size,
          sha256: hash.digest("hex"),
        });
      }
    }
  }
  await visit(rootDir, "");
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  return { count: entries.length, digest, entries };
}

async function atomicReplaceDirectory(
  sourceDir,
  destinationDir,
  { preservePrevious = false } = {},
) {
  const parent = path.dirname(destinationDir);
  const base = path.basename(destinationDir);
  const nonce = `${Date.now()}-${process.pid}`;
  const staging = path.join(parent, `${base}.staging-${nonce}`);
  const previous = path.join(parent, `${base}.previous-${nonce}`);
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.cp(sourceDir, staging, {
    recursive: true,
    errorOnExist: false,
  });
  const sourceFingerprint = await directoryFingerprint(sourceDir);
  const stagingFingerprint = await directoryFingerprint(staging);
  if (
    sourceFingerprint.count !== stagingFingerprint.count ||
    sourceFingerprint.digest !== stagingFingerprint.digest
  ) {
    await fs.promises.rm(staging, { recursive: true, force: true });
    throw new Error("Attachment staging verification failed");
  }

  const hadDestination = await fs.promises
    .access(destinationDir)
    .then(() => true)
    .catch(() => false);
  try {
    if (hadDestination) await fs.promises.rename(destinationDir, previous);
    await fs.promises.rename(staging, destinationDir);
    await fs.promises.chmod(destinationDir, 0o700);
  } catch (error) {
    await fs.promises
      .rm(staging, { recursive: true, force: true })
      .catch(() => {});
    if (hadDestination) {
      const destinationExists = await fs.promises
        .access(destinationDir)
        .then(() => true)
        .catch(() => false);
      if (!destinationExists)
        await fs.promises.rename(previous, destinationDir).catch(() => {});
    }
    throw error;
  }
  if (!preservePrevious)
    await fs.promises.rm(previous, { recursive: true, force: true });
  return {
    ...stagingFingerprint,
    previousDirectory:
      preservePrevious && hadDestination ? previous : undefined,
    destinationDirectory: destinationDir,
  };
}

async function rollbackDirectorySwitch(token) {
  if (!token?.previousDirectory || !token?.destinationDirectory)
    return { status: "nothing-to-rollback" };
  const previous = path.resolve(token.previousDirectory);
  const destination = path.resolve(token.destinationDirectory);
  if (path.dirname(previous) !== path.dirname(destination))
    throw new Error("Attachment rollback directories must share a parent");
  const failed = `${destination}.failed-${Date.now()}-${process.pid}`;
  await fs.promises.rename(destination, failed);
  try {
    await fs.promises.rename(previous, destination);
  } catch (error) {
    await fs.promises.rename(failed, destination).catch(() => {});
    throw error;
  }
  return { status: "rolled-back", preservedFailedDirectory: failed };
}

async function finalizeDirectorySwitch(token) {
  if (!token?.previousDirectory) return { status: "nothing-to-finalize" };
  await fs.promises.rm(path.resolve(token.previousDirectory), {
    recursive: true,
    force: true,
  });
  return { status: "finalized" };
}

function createNativeRuntime(options) {
  const userDataDir = path.resolve(options.userDataDir);
  const repoRoot = options.repoRoot
    ? path.resolve(options.repoRoot)
    : undefined;
  const runtimeRoot = options.runtimeRoot
    ? path.resolve(options.runtimeRoot)
    : repoRoot;
  const postgresRuntimeRoot = options.postgresRuntimeRoot
    ? path.resolve(options.postgresRuntimeRoot)
    : runtimeRoot;
  const browserRuntimeRoot = options.browserRuntimeRoot
    ? path.resolve(options.browserRuntimeRoot)
    : runtimeRoot;
  const runtimeId = normalizeRuntimeId(options.runtimeId || "vision");
  const postgresPort = validateNetworkPort(
    options.postgresPort ?? DEFAULT_POSTGRES_PORT,
    "native PostgreSQL port",
  );
  const names = runtimeNames(runtimeId);
  const runFile = options.runFile || defaultRunFile;
  const spawnProcess = options.spawnProcess || spawn;
  const spawnPostgresProcess = options.spawnPostgresProcess || spawn;
  const checkPortFree = options.isPortFree || isPortFree;
  const getAppPort =
    typeof options.appPort === "function"
      ? options.appPort
      : () => Number(options.appPort || DEFAULT_APP_PORT);
  const nativeRoot = path.join(userDataDir, "native", runtimeId);
  const paths = Object.freeze({
    nativeRoot,
    env: path.join(nativeRoot, "runtime.env"),
    state: path.join(nativeRoot, "runtime-state.json"),
    pid: path.join(nativeRoot, "backend.pid.json"),
    logs: path.join(nativeRoot, "logs"),
    backendLog: path.join(nativeRoot, "logs", "backend.log"),
    postgresLog: path.join(nativeRoot, "logs", "postgres.log"),
    postgresPid: path.join(nativeRoot, "postgres.pid.json"),
    postgresRoot: path.join(nativeRoot, "postgres"),
    postgresData: path.join(nativeRoot, "postgres", "data"),
    attachments: path.join(nativeRoot, "attachments"),
    cache: path.join(nativeRoot, "cache"),
  });
  let tools;
  let child;
  let postgresChild;

  async function ensureLayout() {
    for (const dir of [
      paths.nativeRoot,
      paths.logs,
      paths.attachments,
      paths.cache,
      paths.postgresRoot,
    ]) {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.promises.chmod(dir, 0o700);
    }
    const existing = await fs.promises
      .readFile(paths.env, "utf8")
      .catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    if (existing === undefined) {
      await writeAtomic(
        paths.env,
        nativeEnvContents(names, {
          postgresPort,
        }),
        0o600,
      );
    } else {
      const upgraded = ensureNativeAdminEnv(existing, names);
      databaseConfigFromEnv(upgraded);
      if (upgraded !== existing) await writeAtomic(paths.env, upgraded, 0o600);
      await fs.promises.chmod(paths.env, 0o600);
    }
    const config = databaseConfigFromEnv(
      await fs.promises.readFile(paths.env, "utf8"),
    );
    if (config.port !== postgresPort) {
      const error = new Error(
        "Native runtime configuration targets a different PostgreSQL port.",
      );
      error.code = "POSTGRES_PORT_MISMATCH";
      throw error;
    }
    return config;
  }

  async function importApplicationEnv(values) {
    const additions = validateApplicationEnv(values);
    const contents = await fs.promises.readFile(paths.env, "utf8");
    const lines = contents.replace(/\n?$/, "").split("\n");
    const byKey = new Map();
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^([A-Z_][A-Z0-9_]*)=/.exec(lines[index]);
      if (match) byKey.set(match[1], index);
    }
    for (const [key, value] of Object.entries(additions)) {
      const line = `${key}=${value}`;
      if (byKey.has(key)) lines[byKey.get(key)] = line;
      else lines.push(line);
    }
    await writeAtomic(paths.env, `${lines.join("\n")}\n`, 0o600);
    return { importedKeys: Object.keys(additions) };
  }

  async function discover() {
    if (runtimeRoot)
      await verifyRuntimeManifest(runtimeRoot, {
        required: options.requireRuntimeManifest === true,
      });
    const postgres = await discoverPostgres18({
      binDir: options.postgresBinDir,
      runtimeRoot: postgresRuntimeRoot,
      allowExternalPostgres: options.allowExternalPostgres === true,
      runFile,
    });
    const alembic = await resolveAlembic(
      options.alembicPath,
      repoRoot || runtimeRoot,
      runFile,
    );
    const bun = resolveBun(options.bunPath, runtimeRoot);
    const compiledBackend =
      runtimeRoot &&
      findFirstExecutable([path.join(runtimeRoot, "vision-backend")]);
    if (!compiledBackend && !bun) {
      const error = new Error(
        "Bun was not found and no packaged Vision backend executable is available.",
      );
      error.code = "BUN_NOT_FOUND";
      throw error;
    }
    tools = {
      ...postgres,
      alembic,
      bun,
      compiledBackend,
      chrome: discoverChrome(options.chromePath, browserRuntimeRoot),
    };
    return { ...tools, postgresVersion: POSTGRES_MAJOR };
  }

  function postgresConfigString(value) {
    return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
  }

  async function ensureManagedPostgresCluster(config) {
    if (!tools?.managed) return { status: "external" };
    const versionPath = path.join(paths.postgresData, "PG_VERSION");
    const existingVersion = await fs.promises
      .readFile(versionPath, "utf8")
      .then((value) => value.trim())
      .catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    if (existingVersion !== undefined) {
      if (existingVersion !== String(POSTGRES_MAJOR)) {
        const error = new Error(
          `Vision's private PostgreSQL cluster must be major ${POSTGRES_MAJOR}.`,
        );
        error.code = "POSTGRES_DATA_WRONG_VERSION";
        throw error;
      }
      await fs.promises.chmod(paths.postgresData, 0o700);
      return { status: "existing", dataDirectory: paths.postgresData };
    }

    const liveStat = await fs.promises
      .lstat(paths.postgresData)
      .catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    if (liveStat?.isSymbolicLink()) {
      const error = new Error("Vision PostgreSQL data directory is a symlink");
      error.code = "POSTGRES_DATA_UNSAFE";
      throw error;
    }
    if (liveStat) {
      const quarantine = path.join(
        paths.postgresRoot,
        `data.incomplete-${Date.now()}`,
      );
      await fs.promises.rename(paths.postgresData, quarantine);
    }

    const staging = path.join(
      paths.postgresRoot,
      `data.initializing-${process.pid}-${Date.now()}`,
    );
    const secretDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "vision-initdb-"),
    );
    const passwordFile = path.join(secretDir, "password");
    await fs.promises.writeFile(passwordFile, `${config.adminPassword}\n`, {
      mode: 0o600,
    });
    try {
      await runFile(
        path.join(tools.binDir, "initdb"),
        [
          "-D",
          staging,
          "--encoding=UTF8",
          "--locale=C",
          "--data-checksums",
          "--auth-local=scram-sha-256",
          "--auth-host=scram-sha-256",
          "--username",
          config.adminRole,
          "--pwfile",
          passwordFile,
        ],
        { timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const visionConfig = path.join(staging, "vision.conf");
      await fs.promises.writeFile(
        visionConfig,
        [
          `listen_addresses = ${postgresConfigString(LOOPBACK_HOST)}`,
          `port = ${postgresPort}`,
          "unix_socket_directories = ''",
          "password_encryption = 'scram-sha-256'",
          "logging_collector = off",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const postgresConfig = path.join(staging, "postgresql.conf");
      const baseConfig = await fs.promises.readFile(postgresConfig, "utf8");
      await writeAtomic(
        postgresConfig,
        `${baseConfig.replace(/\n?$/, "\n")}include = 'vision.conf'\n`,
        0o600,
      );
      await fs.promises.chmod(staging, 0o700);
      await fs.promises.rename(staging, paths.postgresData);
      return { status: "initialized", dataDirectory: paths.postgresData };
    } catch (error) {
      const stagingExists = await fs.promises
        .access(staging)
        .then(() => true)
        .catch(() => false);
      if (stagingExists) {
        await fs.promises
          .rename(
            staging,
            path.join(paths.postgresRoot, `data.failed-${Date.now()}`),
          )
          .catch(() => {});
      }
      throw error;
    } finally {
      await fs.promises.rm(secretDir, { recursive: true, force: true });
    }
  }

  async function inspectReadyPostgres(config) {
    const psql = path.join(tools.binDir, "psql");
    const execute = async (env, roleArgs) =>
      runFile(
        psql,
        [
          "-h",
          LOOPBACK_HOST,
          "-p",
          String(postgresPort),
          ...roleArgs,
          "--dbname",
          "postgres",
          "--tuples-only",
          "--no-align",
          "--no-psqlrc",
          "--set",
          "ON_ERROR_STOP=1",
          "--command",
          "SHOW server_version_num; SHOW listen_addresses; SHOW data_directory;",
        ],
        { timeout: 10_000, env },
      );
    const result = tools.managed
      ? await withPgPass(
          config,
          config.adminRole,
          config.adminPassword,
          (env) => execute(env, ["-U", config.adminRole]),
        )
      : await execute(safeChildEnv(), []);
    const lines = result.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const serverVersionNum = Number(lines[0]);
    if (
      !Number.isInteger(serverVersionNum) ||
      Math.floor(serverVersionNum / 10_000) !== POSTGRES_MAJOR
    ) {
      const error = new Error(
        `Native PostgreSQL server must be major ${POSTGRES_MAJOR}.`,
      );
      error.code = "POSTGRES_WRONG_VERSION";
      throw error;
    }
    const addresses = String(lines[1] || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (
      addresses.length === 0 ||
      !addresses.every((entry) =>
        ["localhost", LOOPBACK_HOST, "::1"].includes(entry),
      )
    ) {
      const error = new Error(
        "PostgreSQL listen_addresses is not loopback-only; refusing to start Vision.",
      );
      error.code = "POSTGRES_UNSAFE_BIND";
      throw error;
    }
    if (tools.managed) {
      const actualData = await fs.promises
        .realpath(lines[2] || "")
        .catch(() => "");
      const expectedData = await fs.promises.realpath(paths.postgresData);
      if (actualData !== expectedData) {
        const error = new Error(
          "The native PostgreSQL port belongs to a different database cluster.",
        );
        error.code = "POSTGRES_PORT_COLLISION";
        throw error;
      }
    }
    return { serverVersionNum, listenAddresses: addresses };
  }

  async function startManagedPostgres(config) {
    if (!(await checkPortFree(postgresPort))) {
      const error = new Error(
        `Native PostgreSQL port ${postgresPort} is already in use.`,
      );
      error.code = "POSTGRES_PORT_COLLISION";
      throw error;
    }
    const logFd = fs.openSync(paths.postgresLog, "a", 0o600);
    postgresChild = spawnPostgresProcess(
      path.join(tools.binDir, "postgres"),
      managedPostgresArgs(paths.postgresData, postgresPort),
      {
        cwd: paths.postgresRoot,
        env: safeChildEnv(),
        stdio: ["ignore", logFd, logFd],
        detached: false,
      },
    );
    fs.closeSync(logFd);
    const pid = await waitForChildSpawn(postgresChild);
    await writeAtomicJson(paths.postgresPid, {
      pid,
      runtimeId,
      port: postgresPort,
      dataDirectory: paths.postgresData,
      startedAt: new Date().toISOString(),
    });
    postgresChild.once("exit", async () => {
      const recorded = await readJson(paths.postgresPid).catch(() => undefined);
      if (recorded?.pid === pid)
        await fs.promises.unlink(paths.postgresPid).catch(() => {});
    });
    if (typeof postgresChild.unref === "function") postgresChild.unref();
    return pid;
  }

  async function ensurePostgresReady({ startService = true } = {}) {
    if (!tools) await discover();
    const config = await ensureLayout();
    await ensureManagedPostgresCluster(config);
    const pgIsReady = path.join(tools.binDir, "pg_isready");
    const readyArgs = [
      "-h",
      LOOPBACK_HOST,
      "-p",
      String(postgresPort),
      "-d",
      "postgres",
    ];
    let ready = await runFile(pgIsReady, readyArgs, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (ready) {
      try {
        return await inspectReadyPostgres(config);
      } catch (error) {
        if (tools.managed && error.code !== "POSTGRES_WRONG_VERSION") {
          const collision = new Error(
            `Native PostgreSQL port ${postgresPort} is occupied by another server.`,
          );
          collision.code = "POSTGRES_PORT_COLLISION";
          collision.cause = error;
          throw collision;
        }
        throw error;
      }
    }
    if (!ready && startService && tools.managed) {
      await startManagedPostgres(config);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (
          postgresChild?.exitCode !== undefined &&
          postgresChild?.exitCode !== null
        )
          break;
        ready = await runFile(pgIsReady, readyArgs, { timeout: 3_000 })
          .then(() => true)
          .catch(() => false);
        if (ready) break;
        await sleep(500);
      }
    }
    if (!ready) {
      const error = new Error(
        "PostgreSQL 18 did not become ready on 127.0.0.1.",
      );
      error.code = "POSTGRES_UNAVAILABLE";
      throw error;
    }

    return inspectReadyPostgres(config);
  }

  async function withPgPass(config, role, password, callback) {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "vision-pgpass-"),
    );
    const pgpass = path.join(tempDir, "pgpass");
    await fs.promises.writeFile(
      pgpass,
      `${LOOPBACK_HOST}:${config.port}:*:${role}:${password}\n`,
      { mode: 0o600 },
    );
    try {
      return await callback(safeChildEnv({ PGPASSFILE: pgpass }));
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  async function runAsClusterAdmin(config, executable, args, options_ = {}) {
    if (!tools?.managed)
      return runFile(executable, args, {
        ...options_,
        env: safeChildEnv(options_.env || {}),
      });
    return withPgPass(config, config.adminRole, config.adminPassword, (env) =>
      runFile(executable, args, {
        ...options_,
        env: safeChildEnv({ ...env, ...(options_.env || {}) }),
      }),
    );
  }

  function clusterAdminArgs(config) {
    return tools?.managed ? ["-U", config.adminRole] : [];
  }

  async function runSecretAdminSql(config, sql) {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "vision-pg-admin-"),
    );
    const sqlFile = path.join(tempDir, "command.sql");
    await fs.promises.writeFile(sqlFile, `${sql}\n`, { mode: 0o600 });
    try {
      try {
        return await runAsClusterAdmin(
          config,
          path.join(tools.binDir, "psql"),
          [
            "-h",
            LOOPBACK_HOST,
            "-p",
            String(postgresPort),
            ...clusterAdminArgs(config),
            "--dbname",
            "postgres",
            "--set",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--file",
            sqlFile,
          ],
          { timeout: 10_000 },
        );
      } catch {
        const error = new Error("Native database role bootstrap failed");
        error.code = "POSTGRES_ROLE_BOOTSTRAP_FAILED";
        throw error;
      }
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  async function bootstrapDatabase() {
    const config = await ensureLayout();
    await ensurePostgresReady();
    if (!tools) await discover();
    const psql = path.join(tools.binDir, "psql");
    const adminArgs = [
      "-h",
      LOOPBACK_HOST,
      "-p",
      String(postgresPort),
      ...clusterAdminArgs(config),
      "--dbname",
      "postgres",
      "--set",
      "ON_ERROR_STOP=1",
      "--no-psqlrc",
    ];

    const roleExists = async (role) => {
      const escaped = role.replace(/'/g, "''");
      const result = await runAsClusterAdmin(
        config,
        psql,
        [
          ...adminArgs,
          "--tuples-only",
          "--no-align",
          "--command",
          `SELECT 1 FROM pg_roles WHERE rolname = '${escaped}';`,
        ],
        { timeout: 10_000 },
      );
      return result.stdout.trim() === "1";
    };

    if (!(await roleExists(config.ownerRole))) {
      await runSecretAdminSql(
        config,
        `CREATE ROLE ${quoteIdentifier(config.ownerRole)} LOGIN PASSWORD ${quoteHexSecret(config.ownerPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`,
      );
    }
    await runSecretAdminSql(
      config,
      `ALTER ROLE ${quoteIdentifier(config.ownerRole)} WITH LOGIN PASSWORD ${quoteHexSecret(config.ownerPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`,
    );
    if (!(await roleExists(config.appRole))) {
      await runSecretAdminSql(
        config,
        `CREATE ROLE ${quoteIdentifier(config.appRole)} LOGIN PASSWORD ${quoteHexSecret(config.appPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`,
      );
    }
    await runSecretAdminSql(
      config,
      `ALTER ROLE ${quoteIdentifier(config.appRole)} WITH LOGIN PASSWORD ${quoteHexSecret(config.appPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`,
    );

    const dbExists = await runAsClusterAdmin(
      config,
      psql,
      [
        ...adminArgs,
        "--tuples-only",
        "--no-align",
        "--command",
        `SELECT 1 FROM pg_database WHERE datname = '${config.database}';`,
      ],
      { timeout: 10_000 },
    );
    if (dbExists.stdout.trim() !== "1") {
      await runAsClusterAdmin(
        config,
        path.join(tools.binDir, "createdb"),
        [
          "-h",
          LOOPBACK_HOST,
          "-p",
          String(postgresPort),
          ...clusterAdminArgs(config),
          "--template",
          "template0",
          "--owner",
          config.ownerRole,
          config.database,
        ],
        { timeout: 30_000 },
      );
    }
    await runAsClusterAdmin(
      config,
      psql,
      [
        ...adminArgs,
        "--command",
        `ALTER DATABASE ${quoteIdentifier(config.database)} OWNER TO ${quoteIdentifier(config.ownerRole)};`,
      ],
      { timeout: 10_000 },
    );

    await withPgPass(
      config,
      config.ownerRole,
      config.ownerPassword,
      async (env) => {
        await runFile(
          psql,
          [
            "-h",
            LOOPBACK_HOST,
            "-p",
            String(config.port),
            "-U",
            config.ownerRole,
            "-d",
            config.database,
            "--set",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--command",
            "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;",
          ],
          { timeout: 30_000, env },
        );
      },
    );
    return config;
  }

  async function readState() {
    return readJson(paths.state);
  }

  async function writeState(next) {
    const current = await readState();
    await writeAtomicJson(paths.state, {
      version: 1,
      runtimeId,
      ...(current || {}),
      ...next,
      updatedAt: new Date().toISOString(),
    });
  }

  async function assertNativeActive({ allowUncutover = false } = {}) {
    const state = await readState();
    if (allowUncutover) return state;
    if (state?.activeRuntime === "docker") {
      const error = new Error(
        "Runtime marker selects Docker; native startup is blocked to prevent split-brain writes.",
      );
      error.code = "RUNTIME_SPLIT_BRAIN_GUARD";
      throw error;
    }
    if (state?.activeRuntime === "native") return state;
    const legacyEnv = path.join(userDataDir, "embedded_compose", ".env");
    const legacyInstall = await fs.promises
      .access(legacyEnv)
      .then(() => true)
      .catch(() => false);
    if (legacyInstall) {
      const error = new Error(
        "Existing Docker-backed Vision data was detected. Run the opt-in native importer before native startup.",
      );
      error.code = "NATIVE_CUTOVER_REQUIRED";
      throw error;
    }
    await writeState({ activeRuntime: "native", activation: "fresh-install" });
    return readState();
  }

  async function health({ detailed = false, timeoutMs = 2_000 } = {}) {
    const port = getAppPort();
    return httpGetJson(
      `http://${LOOPBACK_HOST}:${port}${detailed ? "/health/detailed" : "/health"}`,
      timeoutMs,
    );
  }

  async function waitUntilReady({
    attempts = 200,
    intervalMs = 300,
    detailed = false,
  } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await health({
          detailed,
          timeoutMs: Math.max(1_000, intervalMs * 2),
        });
        if (!detailed || isDetailedHealthReady(result)) return result;
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs);
    }
    const error = new Error(
      `Native backend readiness timed out${lastError ? `: ${lastError.message}` : ""}`,
    );
    error.code = "BACKEND_NOT_READY";
    throw error;
  }

  async function backendCommand() {
    if (!tools) await discover();
    if (tools.compiledBackend)
      return { bin: tools.compiledBackend, args: [], cwd: runtimeRoot };
    if (!repoRoot || !tools.bun)
      throw new Error("Native backend source runtime is unavailable");
    return {
      bin: tools.bun,
      args: ["run", "apps/node-backend/src/main.js"],
      cwd: repoRoot,
    };
  }

  async function migrateDatabase() {
    const config = await bootstrapDatabase();
    if (!repoRoot || !tools?.bun) {
      const error = new Error(
        "Listener-free migration is available only from a Vision source checkout",
      );
      error.code = "MIGRATION_SOURCE_UNAVAILABLE";
      throw error;
    }
    const runtimeEnv = parseEnvFile(
      await fs.promises.readFile(paths.env, "utf8"),
    );
    await runFile(
      tools.bun,
      ["run", "apps/node-backend/scripts/db-migrate.js", "upgrade", "head"],
      {
        cwd: repoRoot,
        timeout: 15 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
        env: safeChildEnv({
          ...runtimeEnv,
          VISION_RUNTIME_ROOT: runtimeRoot || repoRoot,
          VISION_CACHE_DIR: paths.cache,
          VISION_SKIP_CONFIG_ENV_LOCAL: "true",
          ALEMBIC_BIN: tools.alembic,
          ALEMBIC_CONFIG: path.join(
            runtimeRoot || repoRoot,
            "config",
            "alembic.ini",
          ),
        }),
      },
    );
    return { status: "migrated", database: config.database };
  }

  async function processMatchesBackend(pid, command = undefined) {
    if (!processExists(pid)) return false;
    const expected = command || (await backendCommand());
    const result = await runFile(
      "/bin/ps",
      ["-p", String(pid), "-o", "command="],
      { timeout: 5_000 },
    ).catch(() => ({ stdout: "" }));
    const actual = result.stdout.trim();
    if (!actual) return false;
    if (expected.bin && actual.includes(expected.bin)) return true;
    return expected.args.some(
      (argument) =>
        argument.includes("apps/node-backend/src/main.js") &&
        actual.includes(argument),
    );
  }

  async function waitForChildSpawn(spawned) {
    if (Number.isInteger(spawned?.pid) && spawned.pid > 1) return spawned.pid;
    return new Promise((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        if (!Number.isInteger(spawned.pid) || spawned.pid <= 1) {
          reject(new Error("Native backend did not provide a process id"));
          return;
        }
        resolve(spawned.pid);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        spawned.removeListener("spawn", onSpawn);
        spawned.removeListener("error", onError);
      };
      spawned.once("spawn", onSpawn);
      spawned.once("error", onError);
    });
  }

  async function start({ allowUncutover = false } = {}) {
    await assertNativeActive({ allowUncutover });
    const config = await bootstrapDatabase();
    assertNativeChromeAvailable(tools?.chrome);
    const command = await backendCommand();
    const existing = await readJson(paths.pid).catch(() => undefined);
    if (existing?.pid && processExists(existing.pid)) {
      if (!(await processMatchesBackend(existing.pid, command))) {
        const error = new Error(
          "The recorded backend process id belongs to another process; refusing to signal it.",
        );
        error.code = "BACKEND_PID_OWNERSHIP_MISMATCH";
        throw error;
      }
      try {
        await health();
        return {
          status: "already-running",
          pid: existing.pid,
          port: getAppPort(),
        };
      } catch {
        const error = new Error(
          "A recorded Vision backend process exists but is not healthy; stop it before restart.",
        );
        error.code = "BACKEND_STALE_PID";
        throw error;
      }
    }
    await fs.promises.unlink(paths.pid).catch(() => {});

    const port = getAppPort();
    if (!(await checkPortFree(port))) {
      const error = new Error(`Native backend port ${port} is already in use.`);
      error.code = "PORT_COLLISION";
      throw error;
    }
    const runtimeEnv = parseEnvFile(
      await fs.promises.readFile(paths.env, "utf8"),
    );
    const env = buildNativeBackendEnv({
      runtimeEnv,
      port,
      paths,
      runtimeRoot,
      repoRoot,
      tools,
    });
    const logFd = fs.openSync(paths.backendLog, "a", 0o600);
    child = spawnProcess(command.bin, validateArgs(command.args), {
      cwd: command.cwd,
      env,
      stdio: ["ignore", logFd, logFd],
      detached: false,
    });
    fs.closeSync(logFd);
    const childPid = await waitForChildSpawn(child);
    await writeAtomicJson(paths.pid, {
      pid: childPid,
      port,
      runtimeId,
      startedAt: new Date().toISOString(),
      command: path.basename(command.bin),
    });
    child.once("exit", async () => {
      const recorded = await readJson(paths.pid).catch(() => undefined);
      if (recorded?.pid === childPid)
        await fs.promises.unlink(paths.pid).catch(() => {});
    });
    if (typeof child.unref === "function") child.unref();
    return {
      status: "started",
      pid: childPid,
      port,
      database: config.database,
    };
  }

  async function stopBackend({ forceAfterMs = 10_000 } = {}) {
    const recorded = await readJson(paths.pid).catch(() => undefined);
    if (!recorded?.pid || !processExists(recorded.pid)) {
      await fs.promises.unlink(paths.pid).catch(() => {});
      return { status: "stopped", service: "backend" };
    }
    if (!(await processMatchesBackend(recorded.pid))) {
      const error = new Error(
        "The recorded backend process id belongs to another process; refusing to signal it.",
      );
      error.code = "BACKEND_PID_OWNERSHIP_MISMATCH";
      throw error;
    }
    process.kill(recorded.pid, "SIGTERM");
    const deadline = Date.now() + forceAfterMs;
    while (processExists(recorded.pid) && Date.now() < deadline)
      await sleep(100);
    if (processExists(recorded.pid)) process.kill(recorded.pid, "SIGKILL");
    await fs.promises.unlink(paths.pid).catch(() => {});
    return { status: "stopped", service: "backend", pid: recorded.pid };
  }

  async function stopPostgres() {
    const clusterExists = await fs.promises
      .access(path.join(paths.postgresData, "PG_VERSION"))
      .then(() => true)
      .catch(() => false);
    if (!clusterExists) {
      await fs.promises.unlink(paths.postgresPid).catch(() => {});
      return { status: "stopped", service: "postgres" };
    }
    if (!tools) await discover();
    if (!tools.managed)
      return { status: "external-not-managed", service: "postgres" };
    const postmasterPid = path.join(paths.postgresData, "postmaster.pid");
    const running = await fs.promises
      .access(postmasterPid)
      .then(() => true)
      .catch(() => false);
    if (!running) {
      await fs.promises.unlink(paths.postgresPid).catch(() => {});
      return { status: "stopped", service: "postgres" };
    }
    try {
      await runFile(
        path.join(tools.binDir, "pg_ctl"),
        ["-D", paths.postgresData, "-m", "fast", "-w", "-t", "30", "stop"],
        { timeout: 35_000 },
      );
    } catch (error) {
      const stillRunning = await fs.promises
        .access(postmasterPid)
        .then(() => true)
        .catch(() => false);
      if (stillRunning) throw error;
    }
    await fs.promises.unlink(paths.postgresPid).catch(() => {});
    return { status: "stopped", service: "postgres" };
  }

  async function stop({ forceAfterMs = 10_000, keepPostgres = false } = {}) {
    const backend = await stopBackend({ forceAfterMs });
    const postgres = keepPostgres ? undefined : await stopPostgres();
    return { status: "stopped", backend, postgres };
  }

  async function restart(options_) {
    await stop({ keepPostgres: true });
    return start(options_);
  }

  async function getSchemaHead({ database = undefined } = {}) {
    const config = await ensureLayout();
    if (!tools) await discover();
    const targetDatabase = validateIdentifier(
      database || config.database,
      "database name",
    );
    return withPgPass(
      config,
      config.ownerRole,
      config.ownerPassword,
      async (env) => {
        const result = await runFile(
          path.join(tools.binDir, "psql"),
          [
            "-h",
            LOOPBACK_HOST,
            "-p",
            String(config.port),
            "-U",
            config.ownerRole,
            "-d",
            targetDatabase,
            "--tuples-only",
            "--no-align",
            "--no-psqlrc",
            "--command",
            "SELECT version_num FROM alembic_version ORDER BY version_num;",
          ],
          { timeout: 10_000, env },
        );
        return pickHighestRevision(result.stdout.split("\n"));
      },
    );
  }

  async function adminDatabasePsql(database, command, timeout = 30_000) {
    if (!tools) await discover();
    const config = await ensureLayout();
    const target = validateIdentifier(database, "database name");
    return runAsClusterAdmin(
      config,
      path.join(tools.binDir, "psql"),
      [
        "-h",
        LOOPBACK_HOST,
        "-p",
        String(postgresPort),
        ...clusterAdminArgs(config),
        "--dbname",
        target,
        "--set",
        "ON_ERROR_STOP=1",
        "--no-psqlrc",
        "--command",
        command,
      ],
      { timeout },
    );
  }

  async function adminPsql(command, timeout = 30_000) {
    return adminDatabasePsql("postgres", command, timeout);
  }

  async function terminateDatabaseConnections(database) {
    const name = validateIdentifier(database, "database name");
    await adminPsql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid();`,
    );
  }

  async function databaseExists(database) {
    const name = validateIdentifier(database, "database name");
    const result = await adminPsql(
      `SELECT 1 FROM pg_database WHERE datname = '${name}';`,
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .includes("1");
  }

  function restoreDatabaseName(base, suffix) {
    const nonce = crypto.randomBytes(5).toString("hex");
    return validateIdentifier(
      `${base.slice(0, 40)}_${suffix}_${nonce}`,
      "temporary database name",
    );
  }

  async function createEmptyDatabase(database, ownerRole) {
    const config = await ensureLayout();
    const name = validateIdentifier(database, "database name");
    const owner = validateIdentifier(ownerRole, "owner role");
    await runAsClusterAdmin(
      config,
      path.join(tools.binDir, "createdb"),
      [
        "-h",
        LOOPBACK_HOST,
        "-p",
        String(postgresPort),
        ...clusterAdminArgs(config),
        "--template",
        "template0",
        "--owner",
        owner,
        name,
      ],
      { timeout: 30_000 },
    );
  }

  async function restoreIntoDatabase(sourcePath, database, format, config) {
    const source = path.resolve(sourcePath);
    const stat = await fs.promises.stat(source);
    if (!stat.isFile() || stat.size <= 0)
      throw new Error("PostgreSQL restore source is empty or not a file");
    const target = validateIdentifier(database, "database name");
    await withPgPass(
      config,
      config.ownerRole,
      config.ownerPassword,
      async (env) => {
        if (format === "custom") {
          await runFile(
            path.join(tools.binDir, "pg_restore"),
            [
              "--exit-on-error",
              "--single-transaction",
              "--no-owner",
              "--no-acl",
              "-h",
              LOOPBACK_HOST,
              "-p",
              String(config.port),
              "-U",
              config.ownerRole,
              "-d",
              target,
              source,
            ],
            { timeout: 30 * 60_000, env, maxBuffer: 4 * 1024 * 1024 },
          );
          return;
        }
        if (format !== "plain")
          throw new Error(`Unsupported restore format: ${format}`);
        await runFile(
          path.join(tools.binDir, "psql"),
          [
            "-h",
            LOOPBACK_HOST,
            "-p",
            String(config.port),
            "-U",
            config.ownerRole,
            "-d",
            target,
            "--set",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--single-transaction",
            "--file",
            source,
          ],
          { timeout: 30 * 60_000, env, maxBuffer: 4 * 1024 * 1024 },
        );
      },
    );
    // A no-owner restore intentionally assigns restored objects to the
    // migration role. These three materialized views are the narrow exception:
    // the runtime service creates, indexes, refreshes, and ANALYZEs them, so the
    // least-privilege application role must own only these derived objects.
    await adminDatabasePsql(
      target,
      materializedViewOwnershipSql(config.appRole),
    );
  }

  async function validateRestoredDatabase(
    database,
    config,
    expectedSchemaHead,
  ) {
    const target = validateIdentifier(database, "database name");
    return withPgPass(
      config,
      config.ownerRole,
      config.ownerPassword,
      async (env) => {
        const result = await runFile(
          path.join(tools.binDir, "psql"),
          [
            "-h",
            LOOPBACK_HOST,
            "-p",
            String(config.port),
            "-U",
            config.ownerRole,
            "-d",
            target,
            "--tuples-only",
            "--no-align",
            "--no-psqlrc",
            "--set",
            "ON_ERROR_STOP=1",
            "--command",
            "SELECT version_num FROM alembic_version ORDER BY version_num; SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';",
          ],
          { timeout: 30_000, env },
        );
        const lines = result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const tableCount = Number(lines.at(-1));
        const schemaHeads = lines.slice(0, -1);
        if (!Number.isInteger(tableCount) || tableCount <= 0)
          throw new Error("Restored database has no public schema tables");
        if (expectedSchemaHead) {
          const expectedHeads = String(expectedSchemaHead)
            .split(",")
            .map((head) => head.trim())
            .filter(Boolean)
            .sort();
          const restoredHeads = [...schemaHeads].sort();
          const matches =
            expectedHeads.length > 1
              ? JSON.stringify(restoredHeads) === JSON.stringify(expectedHeads)
              : restoredHeads.includes(expectedHeads[0]);
          if (!matches) {
            throw new Error(
              "Restored database schema revision does not match backup metadata",
            );
          }
        }
        return { schemaHeads, tableCount };
      },
    );
  }

  async function activateRestoredDatabase(
    sourcePath,
    {
      format = "plain",
      expectedSchemaHead = undefined,
      allowUncutover = false,
    } = {},
  ) {
    await assertNativeActive({ allowUncutover });
    const config = await bootstrapDatabase();
    const stagingDatabase = restoreDatabaseName(config.database, "restore");
    const previousDatabase = restoreDatabaseName(config.database, "previous");
    let switchToken;
    await createEmptyDatabase(stagingDatabase, config.ownerRole);
    try {
      await restoreIntoDatabase(sourcePath, stagingDatabase, format, config);
      const validation = await validateRestoredDatabase(
        stagingDatabase,
        config,
        expectedSchemaHead,
      );
      switchToken = {
        version: 1,
        liveDatabase: config.database,
        previousDatabase,
        activatedDatabase: stagingDatabase,
        activatedAt: new Date().toISOString(),
      };
      // Persist the complete rename plan before touching the live database.
      // Recovery can then distinguish every interruption point without
      // creating a replacement empty database or guessing which copy is live.
      await writeState({ pendingDatabaseSwitch: switchToken });
      await stop({ keepPostgres: true });
      await terminateDatabaseConnections(config.database);
      await terminateDatabaseConnections(stagingDatabase);
      await adminPsql(
        `ALTER DATABASE ${quoteIdentifier(config.database)} RENAME TO ${quoteIdentifier(previousDatabase)};`,
      );
      await adminPsql(
        `ALTER DATABASE ${quoteIdentifier(stagingDatabase)} RENAME TO ${quoteIdentifier(config.database)};`,
      );
      return { switchToken, validation };
    } catch (error) {
      if (switchToken) {
        try {
          await rollbackDatabaseSwitch(switchToken);
        } catch (recoveryCause) {
          const recoveryError = new Error(
            "Native database activation failed and automatic rollback did not complete; Vision remains stopped.",
            { cause: error },
          );
          recoveryError.code = "DATABASE_SWITCH_RECOVERY_FAILED";
          recoveryError.recoveryErrors = [recoveryCause];
          throw recoveryError;
        }
      } else if (await databaseExists(stagingDatabase)) {
        await terminateDatabaseConnections(stagingDatabase).catch(() => {});
        await adminPsql(
          `DROP DATABASE ${quoteIdentifier(stagingDatabase)};`,
        ).catch(() => {});
      }
      throw error;
    }
  }

  async function validateCustomDump(sourcePath) {
    if (!tools) await discover();
    const source = path.resolve(sourcePath);
    const stat = await fs.promises.stat(source);
    if (!stat.isFile() || stat.size <= 0) {
      const error = new Error("PostgreSQL custom dump is empty or not a file");
      error.code = "INVALID_POSTGRES_DUMP";
      throw error;
    }
    try {
      await runFile(path.join(tools.binDir, "pg_restore"), ["--list", source], {
        timeout: 60_000,
      });
    } catch (cause) {
      const error = new Error("PostgreSQL custom dump is corrupt or truncated");
      error.code = "INVALID_POSTGRES_DUMP";
      error.cause = cause;
      throw error;
    }
    return { bytes: stat.size };
  }

  async function getDatabaseStats({ database = undefined } = {}) {
    const config = await ensureLayout();
    if (!tools) await discover();
    const target = validateIdentifier(
      database || config.database,
      "database name",
    );
    return withPgPass(
      config,
      config.ownerRole,
      config.ownerPassword,
      async (env) => {
        const result = await runFile(
          path.join(tools.binDir, "psql"),
          [
            "-h",
            LOOPBACK_HOST,
            "-p",
            String(config.port),
            "-U",
            config.ownerRole,
            "-d",
            target,
            "--tuples-only",
            "--no-align",
            "--field-separator",
            "\t",
            "--quiet",
            "--no-psqlrc",
            "--set",
            "ON_ERROR_STOP=1",
            "--command",
            DATABASE_STATS_SQL,
          ],
          { timeout: 60_000, env },
        );
        return parseDatabaseStats(result.stdout);
      },
    );
  }

  async function rollbackDatabaseSwitch(switchToken) {
    const config = await ensureLayout();
    const token = switchToken || (await readState())?.pendingDatabaseSwitch;
    if (!token || token.liveDatabase !== config.database)
      throw new Error("No matching native database switch is available");
    const previous = validateIdentifier(
      token.previousDatabase,
      "previous database name",
    );
    const activated = validateIdentifier(
      token.activatedDatabase,
      "activated database name",
    );
    await stop({ keepPostgres: true });
    const liveExists = await databaseExists(config.database);
    const previousExists = await databaseExists(previous);
    const activatedExists = await databaseExists(activated);
    const switchState = classifyDatabaseSwitchState({
      liveExists,
      previousExists,
    });
    if (switchState === "unsafe") {
      throw new Error(
        "Neither the live nor previous native database exists; automatic rollback is unsafe",
      );
    }
    if (liveExists) await terminateDatabaseConnections(config.database);
    if (previousExists) await terminateDatabaseConnections(previous);
    if (activatedExists) await terminateDatabaseConnections(activated);

    let preservedFailedDatabase = activatedExists ? activated : undefined;
    if (switchState === "activated") {
      const failedDatabase = restoreDatabaseName(config.database, "failed");
      await adminPsql(
        `ALTER DATABASE ${quoteIdentifier(config.database)} RENAME TO ${quoteIdentifier(failedDatabase)};`,
      );
      try {
        await adminPsql(
          `ALTER DATABASE ${quoteIdentifier(previous)} RENAME TO ${quoteIdentifier(config.database)};`,
        );
      } catch (error) {
        await adminPsql(
          `ALTER DATABASE ${quoteIdentifier(failedDatabase)} RENAME TO ${quoteIdentifier(config.database)};`,
        ).catch(() => {});
        throw error;
      }
      preservedFailedDatabase = failedDatabase;
    } else if (switchState === "between-renames") {
      await adminPsql(
        `ALTER DATABASE ${quoteIdentifier(previous)} RENAME TO ${quoteIdentifier(config.database)};`,
      );
    }
    await writeState({
      pendingDatabaseSwitch: undefined,
      lastRollback: {
        restoredDatabase:
          switchState === "before-renames" ? config.database : previous,
        preservedFailedDatabase,
        rolledBackAt: new Date().toISOString(),
      },
    });
    return { status: "rolled-back", preservedFailedDatabase };
  }

  async function finalizeDatabaseSwitch(switchToken) {
    const state = await readState();
    const token = switchToken || state?.pendingDatabaseSwitch;
    if (!token) return { status: "no-pending-switch" };
    await writeState({
      pendingDatabaseSwitch: undefined,
      previousDatabase: token.previousDatabase,
      lastDatabaseSwitchAt: new Date().toISOString(),
    });
    return {
      status: "finalized",
      previousDatabase: token.previousDatabase,
    };
  }

  async function dumpDatabase(
    destination,
    { format = "plain", database = undefined } = {},
  ) {
    const config = await ensureLayout();
    if (!tools) await discover();
    if (!["plain", "custom"].includes(format))
      throw new Error(`Unsupported dump format: ${format}`);
    const finalPath = path.resolve(destination);
    const partialPath = `${finalPath}.partial`;
    await fs.promises.mkdir(path.dirname(finalPath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.promises.unlink(partialPath).catch(() => {});
    try {
      await withPgPass(config, config.ownerRole, config.ownerPassword, (env) =>
        runFile(
          path.join(tools.binDir, "pg_dump"),
          [
            "-h",
            LOOPBACK_HOST,
            "-p",
            String(config.port),
            "-U",
            config.ownerRole,
            "-d",
            database || config.database,
            "--no-owner",
            "--no-acl",
            ...(format === "custom" ? ["--format=custom"] : ["--format=plain"]),
            "--file",
            partialPath,
          ],
          { timeout: 30 * 60_000, env, maxBuffer: 1024 * 1024 },
        ),
      );
      const stat = await fs.promises.stat(partialPath);
      if (stat.size <= 0) throw new Error("PostgreSQL dump is empty");
      if (format === "custom") {
        await runFile(
          path.join(tools.binDir, "pg_restore"),
          ["--list", partialPath],
          { timeout: 60_000 },
        );
      }
      await fs.promises.rename(partialPath, finalPath);
      await fs.promises.chmod(finalPath, 0o600);
      return { path: finalPath, format, bytes: stat.size };
    } catch (error) {
      await fs.promises.unlink(partialPath).catch(() => {});
      throw error;
    }
  }

  async function exportAttachments(destination) {
    const sourceExists = await fs.promises
      .access(paths.attachments)
      .then(() => true)
      .catch(() => false);
    await fs.promises.rm(destination, { recursive: true, force: true });
    await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
    if (sourceExists)
      await fs.promises.cp(paths.attachments, destination, { recursive: true });
    return directoryFingerprint(destination);
  }

  async function replaceAttachments(sourceDir, replaceOptions = {}) {
    const switchToken = await atomicReplaceDirectory(
      sourceDir,
      paths.attachments,
      replaceOptions,
    );
    if (replaceOptions.preservePrevious === true) {
      await writeState({ pendingAttachmentSwitch: switchToken });
    }
    return switchToken;
  }

  async function rollbackAttachmentSwitch(switchToken = undefined) {
    const token = switchToken || (await readState())?.pendingAttachmentSwitch;
    const result = await rollbackDirectorySwitch(token);
    await writeState({ pendingAttachmentSwitch: undefined });
    return result;
  }

  async function finalizeAttachmentSwitch(switchToken = undefined) {
    const token = switchToken || (await readState())?.pendingAttachmentSwitch;
    const result = await finalizeDirectorySwitch(token);
    await writeState({ pendingAttachmentSwitch: undefined });
    return result;
  }

  return Object.freeze({
    mode: "native",
    runtimeId,
    names,
    paths,
    ensureLayout,
    importApplicationEnv,
    discover,
    ensureManagedPostgresCluster,
    ensurePostgresReady,
    bootstrapDatabase,
    assertNativeActive,
    readState,
    writeState,
    start,
    stop,
    stopPostgres,
    restart,
    health,
    waitUntilReady,
    getSchemaHead,
    dumpDatabase,
    exportAttachments,
    replaceAttachments,
    rollbackAttachmentSwitch,
    finalizeAttachmentSwitch,
    processMatchesBackend,
    migrateDatabase,
    activateRestoredDatabase,
    rollbackDatabaseSwitch,
    finalizeDatabaseSwitch,
    validateCustomDump,
    getDatabaseStats,
  });
}

module.exports = {
  POSTGRES_MAJOR,
  POSTGRES_MINOR,
  CHROMIUM_VERSION,
  DEFAULT_POSTGRES_PORT,
  LOOPBACK_HOST,
  RUNTIME_MANAGED_MATERIALIZED_VIEWS,
  NATIVE_APPLICATION_ENV_KEYS,
  safeChildEnv,
  validateArgs,
  defaultRunFile,
  parsePostgresMajor,
  parsePostgresVersionNumber,
  classifyDatabaseSwitchState,
  revisionNumericPrefix,
  pickHighestRevision,
  assertPostgres18Version,
  bundledPostgresBin,
  discoverPostgres18,
  runtimeNames,
  parseEnvFile,
  databaseConfigFromEnv,
  nativeEnvContents,
  materializedViewOwnershipSql,
  ensureNativeAdminEnv,
  validateApplicationEnv,
  buildNativeBackendEnv,
  assertNativeChromeAvailable,
  bundledChromiumPath,
  writeAtomic,
  writeAtomicJson,
  isPortFree,
  isDetailedHealthReady,
  managedPostgresArgs,
  directoryFingerprint,
  atomicReplaceDirectory,
  rollbackDirectorySwitch,
  finalizeDirectorySwitch,
  discoverChrome,
  verifyRuntimeManifest,
  createNativeRuntime,
};
