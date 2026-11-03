import { verifyRuntimeManifestOnLaunch } from "./runtime-manifest";
export {
  verifyRuntimeManifest,
} from "./runtime-manifest";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { execFile, spawn, type SpawnOptions } from "node:child_process";
import {
  readDatabaseFileStats,
  type DatabaseFileStats,
} from "./database-stats";

/** Records the last full payload verification, below the runtime's nativeRoot. */
export const RUNTIME_VERIFICATION_MARKER = "runtime-verification.json";
const DEFAULT_APP_PORT = 3002;
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * The SQLite database lives in `<userData>/database/vision.sqlite3` (ADR-263).
 * The whole directory is one generation: the database file, its `-wal` and
 * `-shm` sidecars and the backend's `pre-migration-backups/` move together
 * when a restore swaps generations, so a write-ahead log never ends up beside
 * the wrong database.
 */
export const DATABASE_DIRECTORY_NAME = "database";
export const DATABASE_FILE_NAME = "vision.sqlite3";
/** Previous database generations kept after a committed restore. */
export const PREVIOUS_DATABASE_GENERATIONS_KEPT = 3;
/** The packaged database tool, run by the backend executable as Bun (BUN_BE_BUN=1). */
export const PACKAGED_DATABASE_TOOL = "tools/db-file.js";
/** The same tool from a source checkout, run with the developer's Bun. */
export const SOURCE_DATABASE_TOOL = "apps/node-backend/scripts/db-file.ts";
/** The script that converts Vision 2.0 (PostgreSQL) backups to SQLite. */
export const TRANSITION_COMMAND = "bun run transition:v2 -- <backup file>";

export const NATIVE_APPLICATION_ENV_KEYS = Object.freeze([
  "TWELVE_DATA_API_KEY",
  "FINNHUB_API_KEY",
  "FMP_API_KEY",
  "ALPHA_VANTAGE_API_KEY",
  "FRED_API_KEY",
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

/** Environment passed to a child process; every value is a string. */
export type ChildEnv = Record<string, string>;

export interface RunFileOptions {
  cwd?: string | undefined;
  env?: ChildEnv | undefined;
  timeout?: number | undefined;
  maxBuffer?: number | undefined;
}

export interface RunFileResult {
  stdout: string;
  stderr: string;
}

export type RunFile = (
  bin: string,
  args: string[],
  options?: RunFileOptions,
) => Promise<RunFileResult>;

/** The part of a spawned child process the native runtime observes. */
export interface SpawnedChild {
  readonly pid?: number | undefined;
  readonly exitCode?: number | null | undefined;
  once(event: "spawn" | "exit", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "spawn", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  unref?: () => void;
}

export type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => SpawnedChild;

/** The part of a listening server the port probe uses. */
export interface PortProbeServer {
  unref(): unknown;
  once(event: "error", listener: () => void): unknown;
  listen(port: number, host: string, callback: () => void): unknown;
  close(callback: () => void): unknown;
}

/** An Error carrying the machine-readable fields this runtime attaches. */
export interface NativeRuntimeError extends Error {
  code?: string | number | null | undefined;
  exitCode?: string | number | null | undefined;
  recoveryErrors?: unknown[];
  /** Output of a failed child process, kept so a tool's JSON error survives. */
  stdout?: string | undefined;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

/**
 * Field view of an untyped value with `value.field` semantics: null and
 * undefined throw a TypeError, and primitives expose none of the fields read.
 */
function fieldsOf(value: unknown): UnknownRecord {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${String(value)}`);
  }
  return isRecord(value) ? value : {};
}

/** Field view of an untyped value with `value?.field` semantics. */
function optionalFieldsOf(value: unknown): UnknownRecord | undefined {
  if (value === null || value === undefined) return undefined;
  return isRecord(value) ? value : {};
}

function errorCode(error: unknown): unknown {
  return fieldsOf(error).code;
}

function codedError(
  message: string,
  code: string,
  options?: { cause?: unknown },
): NativeRuntimeError {
  const error: NativeRuntimeError = new Error(message, options);
  error.code = code;
  return error;
}

function executableExists(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "string") return false;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function safeChildEnv(
  overrides: Readonly<Record<string, string | number | undefined>> = {},
): ChildEnv {
  const env: ChildEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const inherited = process.env[key];
    if (inherited !== undefined) env[key] = inherited;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = String(value);
  }
  env.PATH = [
    process.env.PATH ?? "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
    .filter(Boolean)
    .join(":");
  return env;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((arg) => typeof arg === "string");
}

export function validateArgs(args: unknown): string[] {
  if (!isStringArray(args)) {
    throw new TypeError("Process arguments must be a string array");
  }
  return args;
}

export function defaultRunFile(
  bin: string,
  args: string[],
  options: RunFileOptions = {},
): Promise<RunFileResult> {
  validateArgs(args);
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? safeChildEnv(),
        timeout: options.timeout ?? 30_000,
        maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped: NativeRuntimeError = new Error(
            (stderr && stderr.trim()) ||
              error.message ||
              `${path.basename(bin)} failed`,
          );
          wrapped.code = error.code;
          wrapped.exitCode = error.code;
          wrapped.stdout = stdout || "";
          reject(wrapped);
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "" });
      },
    );
  });
}

function normalizeRuntimeId(value: string | undefined): string {
  const normalized = (value || "vision").toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(normalized)) {
    throw new Error(`Invalid native runtime id: ${value}`);
  }
  return normalized;
}

export type DatabaseSwitchState =
  | "activated"
  | "between-renames"
  | "before-renames"
  | "unsafe";

export function classifyDatabaseSwitchState({
  liveExists,
  previousExists,
}: {
  liveExists: boolean;
  previousExists: boolean;
}): DatabaseSwitchState {
  if (previousExists && liveExists) return "activated";
  if (previousExists && !liveExists) return "between-renames";
  if (!previousExists && liveExists) return "before-renames";
  return "unsafe";
}

export function parseEnvFile(
  contents: string | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of (contents ?? "").split("\n")) {
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

const NATIVE_ENV_HEADER =
  "# Auto-generated by Vision native runtime. Do not commit or share this file.\n";

/**
 * Secrets of removed features (cloud AI and AI reference mapping). Older
 * runtime env files may still hold them; they are stripped from the file on
 * the next layout check and never passed to a backend or tool child.
 */
export const RETIRED_NATIVE_ENV_KEYS: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY",
  "OPENAI_API_ENABLED",
  "AI_REFERENCE_MAPPING_KEY",
]);

/**
 * Credentials of Vision 2.0's private PostgreSQL cluster. They stay in the
 * file, so Vision 2.0 can still open its untouched data directory, but no
 * child process receives them.
 */
export const LEGACY_POSTGRES_ENV_KEYS: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "DATABASE_URL_MIGRATIONS",
  "DATABASE_URL_ANALYSIS",
  "VISION_POSTGRES_ADMIN_ROLE",
  "VISION_POSTGRES_ADMIN_PASSWORD",
]);

/** Removes every line that assigns a retired key; other lines stay byte-identical. */
export function stripRetiredNativeEnv(contents: string): string {
  const lines = contents.split("\n");
  const kept = lines.filter((line) => {
    const key = /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    return !key || !RETIRED_NATIVE_ENV_KEYS.has(key);
  });
  return kept.length === lines.length ? contents : kept.join("\n");
}

function withoutRetiredEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !RETIRED_NATIVE_ENV_KEYS.has(key) && !LEGACY_POSTGRES_ENV_KEYS.has(key),
    ),
  );
}

export function validateApplicationEnv(
  values: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const key of NATIVE_APPLICATION_ENV_KEYS) {
    const value = values?.[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || /[\r\n\0]/.test(value))
      throw new Error(`Invalid value for native environment key ${key}`);
    filtered[key] = value;
  }
  return filtered;
}

export interface NativeBackendEnvOptions {
  runtimeEnv: Readonly<Record<string, string | undefined>>;
  port: number;
  paths: Pick<NativeRuntimePaths, "attachments" | "cache" | "env" | "database">;
  runtimeRoot?: string | undefined;
  repoRoot?: string | undefined;
  syntheticOffline?: boolean | undefined;
}

export function buildNativeBackendEnv({
  runtimeEnv,
  port,
  paths,
  runtimeRoot,
  repoRoot,
  syntheticOffline,
}: NativeBackendEnvOptions): ChildEnv {
  const resolvedRuntimeRoot = runtimeRoot || repoRoot;
  if (!resolvedRuntimeRoot) {
    throw new Error("Native backend runtime root is unavailable");
  }
  return safeChildEnv({
    ...withoutRetiredEnv(runtimeEnv),
    SERVER_HOST: LOOPBACK_HOST,
    PORT: String(port),
    NODE_ENV: "production",
    ENVIRONMENT: "production",
    VISION_DATABASE_PATH: paths.database,
    ATTACHMENTS_DIR: paths.attachments,
    VISION_RUNTIME_ROOT: resolvedRuntimeRoot,
    VISION_NATIVE_ENV_FILE: paths.env,
    VISION_DIST_DIR: path.join(resolvedRuntimeRoot, "dist"),
    OLLAMA_URL: "http://127.0.0.1:11434",
    VISION_SYNTHETIC_SMOKE_OFFLINE: syntheticOffline ? "1" : undefined,
  });
}

export async function writeAtomic(
  filePath: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
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

export async function writeAtomicJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(
      await fs.promises.readFile(filePath, "utf8"),
    );
    return parsed;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** lstat-based existence: a dangling symlink exists; only ENOENT is absence. */
async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch (error) {
    if (optionalFieldsOf(error)?.code === "ENOENT") return false;
    throw error;
  }
}

/** Makes completed renames in a directory durable; best effort where unsupported. */
async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(directory, "r");
    await handle.sync();
  } catch {
    // Some file systems refuse fsync on a directory; the rename still happened.
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream: AsyncIterable<Buffer> = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export function isPortFree(
  port: number,
  host = LOOPBACK_HOST,
  createServer: () => PortProbeServer = net.createServer,
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function httpGetJson(url: string, timeoutMs = 2_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
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
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("health timeout")));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The message of the backend's last "Failed to start application" log line,
 * so the shell can show why startup stopped instead of polling until timeout.
 */
/** Why the backend stopped during start-up, from its last failure log line. */
export interface BackendStartupFailure {
  message: string;
  /** The error's code when it had one, for example PRE_MIGRATION_BACKUP_FAILED. */
  code?: string;
}

export function lastStartupFailure(
  log: string,
): BackendStartupFailure | undefined {
  const line = log
    .split("\n")
    .reverse()
    .find((entry) => entry.includes("Failed to start application"));
  const json = line?.slice(line.indexOf("{"));
  if (!json?.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) return undefined;
    const { error, code } = parsed;
    if (typeof error !== "string" || !error) return undefined;
    return typeof code === "string" && code
      ? { message: error, code }
      : { message: error };
  } catch {
    return undefined;
  }
}

export function lastStartupError(log: string): string | undefined {
  return lastStartupFailure(log)?.message;
}

export function isDetailedHealthReady(result: unknown): boolean {
  return (
    optionalFieldsOf(optionalFieldsOf(result)?.database)?.connected === true
  );
}

function processExists(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A recorded process id that processExists may probe, or undefined. */
function probeableProcessId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 1
    ? value
    : undefined;
}

function findFirstExecutable(
  candidates: ReadonlyArray<string | undefined>,
): string | undefined {
  for (const candidate of candidates) {
    if (executableExists(candidate)) return candidate;
  }
  return undefined;
}

function resolveBun(
  explicitPath: string | undefined,
  packagedRuntimeRoot: string | undefined,
): string | undefined {
  return findFirstExecutable([
    explicitPath,
    process.env.VISION_BUN_BIN,
    packagedRuntimeRoot && path.join(packagedRuntimeRoot, "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ]);
}

/** Highest `NNNN_name.sql` version in a migrations directory; 0 when there is none. */
export function packagedMigrationVersion(migrationsDir: string): number {
  let names: string[];
  try {
    names = fs.readdirSync(migrationsDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
  let highest = 0;
  for (const name of names) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    if (!match?.[1] || name.endsWith(".down.sql")) continue;
    highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/** What `db-file.ts` prints for a database it checked or wrote. */
export interface DatabaseFileReport {
  file: string;
  bytes: number;
  sha256: string;
  sqliteVersion: string;
  /** Latest migration version recorded in the database's ledger. */
  schemaVersion: number;
  /** Migrations this build would still apply when the backend opens it. */
  pendingMigrations: number;
  /** Rows per table; only `create` reports them. */
  tableCounts?: Record<string, number> | undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseTableCounts(value: unknown): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value))
    throw new Error("The database tool reported invalid table counts");
  const counts: Record<string, number> = {};
  for (const [table, count] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(table) || !isCount(count))
      throw new Error("The database tool reported invalid table counts");
    counts[table] = count;
  }
  return counts;
}

/**
 * The result line of a `db-file.ts` run: the last stdout line that is a JSON
 * object with a boolean `ok` (the backend logger may print lines before it).
 */
export function parseDatabaseToolOutput(
  stdout: string | undefined,
): { ok: true; report: DatabaseFileReport } | { ok: false; error: string } | undefined {
  const lines = (stdout ?? "").split("\n").map((line) => line.trim());
  for (const line of lines.reverse()) {
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.ok !== "boolean") continue;
    if (!parsed.ok) {
      return {
        ok: false,
        error:
          typeof parsed.error === "string" && parsed.error
            ? parsed.error
            : "The database tool failed",
      };
    }
    if (
      typeof parsed.file !== "string" ||
      !isCount(parsed.bytes) ||
      typeof parsed.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(parsed.sha256) ||
      typeof parsed.sqliteVersion !== "string" ||
      !isCount(parsed.schemaVersion) ||
      !isCount(parsed.pendingMigrations)
    ) {
      throw new Error("The database tool returned an invalid report");
    }
    return {
      ok: true,
      report: {
        file: parsed.file,
        bytes: parsed.bytes,
        sha256: parsed.sha256,
        sqliteVersion: parsed.sqliteVersion,
        schemaVersion: parsed.schemaVersion,
        pendingMigrations: parsed.pendingMigrations,
        tableCounts: parseTableCounts(parsed.tableCounts),
      },
    };
  }
  return undefined;
}

export const LEGACY_POSTGRES_DATA_CODE = "LEGACY_POSTGRES_DATA";

/**
 * Startup refusal when Vision 2.0 data exists and no SQLite database does.
 * The fields name the message's parts for the translated dialog text
 * (`app.legacyPostgresData`: {dataDirectory}, {backups}, {command}).
 */
export function legacyPostgresDataError(
  dataDirectory: string,
  preUpdateBackups: string,
): NativeRuntimeError & {
  dataDirectory: string;
  backups: string;
  command: string;
} {
  return Object.assign(
    codedError(
      `Vision found data from Vision 2.0 (PostgreSQL) on this Mac and did not start, so it does not create an empty database in its place. ` +
        `The Vision 2.0 data was left untouched in ${dataDirectory}. ` +
        `Convert a Vision 2.0 backup once with the transition script from a Vision repository checkout: ${TRANSITION_COMMAND}. ` +
        `The backup Vision 2.0 made before the update is usually in ${preUpdateBackups}.`,
      LEGACY_POSTGRES_DATA_CODE,
    ),
    {
      dataDirectory,
      backups: preUpdateBackups,
      command: TRANSITION_COMMAND,
    },
  );
}

export interface FingerprintEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface DirectoryFingerprint {
  count: number;
  digest: string;
  entries: FingerprintEntry[];
}

export async function directoryFingerprint(
  rootDir: string,
): Promise<DirectoryFingerprint> {
  const entries: FingerprintEntry[] = [];
  async function visit(current: string, relative: string): Promise<void> {
    let names: fs.Dirent[];
    try {
      names = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
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
          const stream: AsyncIterable<Buffer> = handle.createReadStream({
            autoClose: false,
          });
          for await (const chunk of stream) hash.update(chunk);
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

export interface DirectorySwitchToken extends DirectoryFingerprint {
  previousDirectory: string | undefined;
  destinationDirectory: string;
}

export interface ReplaceDirectoryOptions {
  preservePrevious?: boolean;
  beforeSwitch?: (token: DirectorySwitchToken) => Promise<void>;
}

export async function atomicReplaceDirectory(
  sourceDir: string,
  destinationDir: string,
  { preservePrevious = false, beforeSwitch }: ReplaceDirectoryOptions = {},
): Promise<DirectorySwitchToken> {
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
  const switchToken: DirectorySwitchToken = {
    ...stagingFingerprint,
    previousDirectory:
      preservePrevious && hadDestination ? previous : undefined,
    destinationDirectory: destinationDir,
  };
  // Journal the intent before either rename, including an absent old tree.
  await beforeSwitch?.(switchToken);
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
  return switchToken;
}

/** A string path from a switch token; a truthy non-string is corrupt state. */
function switchTokenPath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Invalid ${label} in directory switch token`);
  }
  return value;
}

export type DirectoryRollbackResult =
  | { status: "nothing-to-rollback" }
  | { status: "rolled-back"; preservedFailedDirectory: string };

/** Accepts a token from atomicReplaceDirectory or one persisted in state. */
export async function rollbackDirectorySwitch(
  token: unknown,
): Promise<DirectoryRollbackResult> {
  const fields = optionalFieldsOf(token);
  if (!fields?.destinationDirectory) return { status: "nothing-to-rollback" };
  const destination = path.resolve(
    switchTokenPath(fields.destinationDirectory, "destination directory"),
  );
  const previous =
    fields.previousDirectory === undefined
      ? undefined
      : path.resolve(
          switchTokenPath(fields.previousDirectory, "previous directory"),
        );
  if (previous && path.dirname(previous) !== path.dirname(destination))
    throw new Error("Attachment rollback directories must share a parent");
  const destinationExists = await pathExists(destination);
  const previousExists = previous ? await pathExists(previous) : false;
  if (previous && !previousExists) {
    if (!destinationExists)
      throw new Error("Both attachment generations are missing");
    return { status: "nothing-to-rollback" };
  }
  const failed = `${destination}.failed-${Date.now()}-${process.pid}`;
  if (destinationExists) await fs.promises.rename(destination, failed);
  try {
    if (previous) await fs.promises.rename(previous, destination);
  } catch (error) {
    if (destinationExists)
      await fs.promises.rename(failed, destination).catch(() => {});
    throw error;
  }
  return { status: "rolled-back", preservedFailedDirectory: failed };
}

export type DirectoryFinalizeResult =
  | { status: "nothing-to-finalize" }
  | { status: "finalized" };

/** Accepts a token from atomicReplaceDirectory or one persisted in state. */
export async function finalizeDirectorySwitch(
  token: unknown,
): Promise<DirectoryFinalizeResult> {
  const previousDirectory = optionalFieldsOf(token)?.previousDirectory;
  if (!previousDirectory) return { status: "nothing-to-finalize" };
  const previous = switchTokenPath(previousDirectory, "previous directory");
  await fs.promises.rm(path.resolve(previous), {
    recursive: true,
    force: true,
  });
  return { status: "finalized" };
}

export interface NativeRuntimeOptions {
  userDataDir: string;
  repoRoot?: string | undefined;
  runtimeRoot?: string | undefined;
  runtimeId?: string | undefined;
  appPort?: number | (() => number) | undefined;
  bunPath?: string | undefined;
  requireRuntimeManifest?: boolean | undefined;
  /** Receives named startup timings, e.g. the runtime payload verification. */
  recordBootPhase?: ((phase: string, ms: number) => void) | undefined;
  syntheticOffline?: boolean | undefined;
  runFile?: RunFile | undefined;
  spawnProcess?: SpawnProcess | undefined;
  isPortFree?: ((port: number) => Promise<boolean>) | undefined;
}

export interface NativeRuntimePaths {
  readonly nativeRoot: string;
  readonly env: string;
  readonly state: string;
  readonly pid: string;
  readonly logs: string;
  readonly backendLog: string;
  readonly attachments: string;
  readonly cache: string;
  /** `<userData>/database`: one database generation. */
  readonly databaseDir: string;
  /** `<userData>/database/vision.sqlite3`, the backend's VISION_DATABASE_PATH. */
  readonly database: string;
  /** Vision 2.0's PostgreSQL data directory. Read for presence only, never changed. */
  readonly legacyPostgresData: string;
}

export interface NativeTools {
  bun: string | undefined;
  compiledBackend: string | undefined;
}

/** pendingDatabaseSwitch in runtime-state.json for a SQLite generation swap. */
export interface DatabaseSwitchToken {
  version: 2;
  kind: "sqlite-directory";
  liveDirectory: string;
  previousDirectory: string;
  activatedDirectory: string;
  activatedAt: string;
}

/** runtime-state.json. Persisted, so every field is read back as unknown. */
export type NativeRuntimeState = UnknownRecord;

export type StartResult =
  | { status: "already-running"; pid: number; port: number }
  | { status: "started"; pid: number; port: number; database: string };

/** A database the backend migrates forward at its next start. */
export interface PendingSchemaUpgrade {
  databaseVersion: number;
  packagedVersion: number;
}

export interface ActivateRestoreOptions {
  /** Refuse the copy unless its ledger records exactly this version. */
  expectedSchemaVersion?: number | undefined;
  /** Refuse the copy unless its SHA-256 matches (the backup's metadata). */
  expectedSha256?: string | undefined;
}

interface ProcessCommand {
  bin: string;
  args: string[];
  cwd: string | undefined;
}

export function createNativeRuntime(options: NativeRuntimeOptions) {
  const userDataDir = path.resolve(options.userDataDir);
  const repoRoot = options.repoRoot
    ? path.resolve(options.repoRoot)
    : undefined;
  const runtimeRoot = options.runtimeRoot
    ? path.resolve(options.runtimeRoot)
    : repoRoot;
  const runtimeId = normalizeRuntimeId(options.runtimeId || "vision");
  const runFile: RunFile = options.runFile ?? defaultRunFile;
  const spawnProcess: SpawnProcess = options.spawnProcess ?? spawn;
  const checkPortFree: (port: number) => Promise<boolean> =
    options.isPortFree ?? isPortFree;
  const getAppPort: () => number =
    typeof options.appPort === "function"
      ? options.appPort
      : () => {
          // 0 and NaN fall back to the default port, like `||` did.
          const configured = options.appPort;
          return typeof configured === "number" &&
            configured !== 0 &&
            !Number.isNaN(configured)
            ? configured
            : DEFAULT_APP_PORT;
        };
  const nativeRoot = path.join(userDataDir, "native", runtimeId);
  const databaseDir = path.join(userDataDir, DATABASE_DIRECTORY_NAME);
  const paths: NativeRuntimePaths = Object.freeze({
    nativeRoot,
    env: path.join(nativeRoot, "runtime.env"),
    state: path.join(nativeRoot, "runtime-state.json"),
    pid: path.join(nativeRoot, "backend.pid.json"),
    logs: path.join(nativeRoot, "logs"),
    backendLog: path.join(nativeRoot, "logs", "backend.log"),
    attachments: path.join(nativeRoot, "attachments"),
    cache: path.join(nativeRoot, "cache"),
    databaseDir,
    database: path.join(databaseDir, DATABASE_FILE_NAME),
    legacyPostgresData: path.join(nativeRoot, "postgres", "data"),
  });
  let tools: NativeTools | undefined;
  let child: SpawnedChild | undefined;
  // Set when the backend started by start() exits; cleared by the next start().
  let backendExit: { code: number | null | undefined } | undefined;
  let restoreSwitchOwnedThisLaunch = false;
  let startupRestoreRecovery: Promise<void> | undefined;

  /** The discovered tools; like reading `tools.x` before discovery, throws. */
  function requireTools(): NativeTools {
    if (!tools) throw new TypeError("Native runtime tools are not discovered");
    return tools;
  }

  async function ensureLayout(): Promise<{ database: string }> {
    for (const dir of [
      paths.nativeRoot,
      paths.logs,
      paths.attachments,
      paths.cache,
      paths.databaseDir,
    ]) {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.promises.chmod(dir, 0o700);
    }
    const existing = await fs.promises
      .readFile(paths.env, "utf8")
      .catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      });
    if (existing === undefined) {
      await writeAtomic(paths.env, NATIVE_ENV_HEADER, 0o600);
    } else {
      const upgraded = stripRetiredNativeEnv(existing);
      if (upgraded !== existing) await writeAtomic(paths.env, upgraded, 0o600);
      await fs.promises.chmod(paths.env, 0o600);
    }
    return { database: paths.database };
  }

  async function importApplicationEnv(
    values: Readonly<Record<string, unknown>> | undefined,
  ): Promise<{ importedKeys: string[] }> {
    const additions = validateApplicationEnv(values);
    const contents = await fs.promises.readFile(paths.env, "utf8");
    const lines = contents.replace(/\n?$/, "").split("\n");
    const byKey = new Map<string, number>();
    for (const [index, existingLine] of lines.entries()) {
      const key = /^([A-Z_][A-Z0-9_]*)=/.exec(existingLine)?.[1];
      if (key !== undefined) byKey.set(key, index);
    }
    for (const [key, value] of Object.entries(additions)) {
      const line = `${key}=${value}`;
      const existingIndex = byKey.get(key);
      if (existingIndex !== undefined) lines[existingIndex] = line;
      else lines.push(line);
    }
    await writeAtomic(paths.env, `${lines.join("\n")}\n`, 0o600);
    return { importedKeys: Object.keys(additions) };
  }

  async function discover(): Promise<NativeTools> {
    if (runtimeRoot) {
      // Full hashing once per installed payload; a size check afterwards (ADR-235).
      const started = Date.now();
      const verification = await verifyRuntimeManifestOnLaunch(runtimeRoot, {
        required: options.requireRuntimeManifest === true,
        markerPath: path.join(paths.nativeRoot, RUNTIME_VERIFICATION_MARKER),
      });
      if (verification.status === "verified") {
        options.recordBootPhase?.(
          `runtime_manifest_${verification.mode}`,
          Date.now() - started,
        );
      }
    }
    const bun = resolveBun(options.bunPath, runtimeRoot);
    const compiledBackend = runtimeRoot
      ? findFirstExecutable([path.join(runtimeRoot, "vision-backend")])
      : undefined;
    if (!compiledBackend && !bun) {
      throw codedError(
        "Bun was not found and no packaged Vision backend executable is available.",
        "BUN_NOT_FOUND",
      );
    }
    tools = { bun, compiledBackend };
    return tools;
  }

  function isSqliteSwitchToken(token: unknown): boolean {
    const fields = optionalFieldsOf(token);
    return fields?.version === 2 && fields.kind === "sqlite-directory";
  }

  /**
   * The three directories a persisted switch token names, after checking
   * that they are this runtime's database generations: a tampered or foreign
   * token can never make the runtime rename an arbitrary directory.
   */
  function switchTokenDirectories(token: unknown): {
    live: string;
    previous: string;
    activated: string;
  } {
    const fields = optionalFieldsOf(token);
    const generation = (value: unknown, kind: "previous" | "restore") =>
      typeof value === "string" &&
      path.dirname(value) === userDataDir &&
      new RegExp(`^${DATABASE_DIRECTORY_NAME}\\.${kind}-[0-9a-z-]{1,64}$`).test(
        path.basename(value),
      );
    if (
      !isSqliteSwitchToken(token) ||
      fields?.liveDirectory !== paths.databaseDir ||
      !generation(fields.previousDirectory, "previous") ||
      !generation(fields.activatedDirectory, "restore")
    ) {
      throw new Error("No matching native database switch is available");
    }
    return {
      live: paths.databaseDir,
      previous: String(fields.previousDirectory),
      activated: String(fields.activatedDirectory),
    };
  }

  async function recoverInterruptedRestore(): Promise<void> {
    const state = await readState();
    const pendingDatabase = state?.pendingDatabaseSwitch;
    // A journal written by Vision 2.0 names PostgreSQL databases. Only
    // Vision 2.0 can resolve it, so neither generation is touched here.
    if (pendingDatabase && !isSqliteSwitchToken(pendingDatabase)) return;
    const attachments = state?.pendingAttachmentSwitch;
    if (attachments) {
      const token = fieldsOf(attachments);
      if (
        token.destinationDirectory !== paths.attachments ||
        (token.previousDirectory !== undefined &&
          (typeof token.previousDirectory !== "string" ||
            path.dirname(token.previousDirectory) !==
              path.dirname(paths.attachments) ||
            !path
              .basename(token.previousDirectory)
              .startsWith(`${path.basename(paths.attachments)}.previous-`)))
      ) {
        throw new Error("Invalid pending attachment restore journal");
      }
    }
    if (pendingDatabase) {
      await stop();
      if (attachments) await rollbackAttachmentSwitch(attachments);
      await rollbackDatabaseSwitch(pendingDatabase);
    } else if (attachments) {
      // The database commit is durable; never roll its attachment generation back.
      await finalizeAttachmentSwitch(attachments);
    }
  }

  async function recoverOnce(): Promise<void> {
    if (restoreSwitchOwnedThisLaunch) return;
    startupRestoreRecovery ??= recoverInterruptedRestore();
    await startupRestoreRecovery;
  }

  /**
   * Upgrade safety (ADR-263): a Mac that holds Vision 2.0's PostgreSQL data
   * but no SQLite database must not start a new, empty database. The old
   * directory is only checked for presence.
   */
  async function assertNoUntransitionedLegacyData(): Promise<void> {
    if (await pathExists(paths.database)) return;
    // Only a directory with contents is Vision 2.0 data; an empty one never
    // held a cluster. Nothing inside is read or changed.
    const legacyEntries = await fs.promises
      .readdir(paths.legacyPostgresData)
      .catch((error: unknown) => {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR")
          return [];
        throw error;
      });
    if (legacyEntries.length === 0) return;
    throw legacyPostgresDataError(
      paths.legacyPostgresData,
      path.join(userDataDir, "pre-update-backups"),
    );
  }

  /** Layout, interrupted-restore recovery and the upgrade check before a backend opens the database. */
  async function ensureDatabaseReady(): Promise<{ database: string }> {
    await ensureLayout();
    if (!tools) await discover();
    await recoverOnce();
    await assertNoUntransitionedLegacyData();
    return { database: paths.database };
  }

  async function readState(): Promise<NativeRuntimeState | undefined> {
    const state = await readJson(paths.state);
    if (state === undefined) return undefined;
    if (!isRecord(state)) throw new Error("Invalid native runtime state");
    return state;
  }

  async function writeState(next: UnknownRecord): Promise<void> {
    const current = await readState();
    await writeAtomicJson(paths.state, {
      version: 1,
      runtimeId,
      ...(current ?? {}),
      ...next,
      updatedAt: new Date().toISOString(),
    });
  }

  async function assertNativeActive(): Promise<NativeRuntimeState | undefined> {
    const state = await readState();
    if (state?.activeRuntime === "native") return state;
    await writeState({ activeRuntime: "native", activation: "fresh-install" });
    return readState();
  }

  async function health({
    detailed = false,
    timeoutMs = 2_000,
  }: { detailed?: boolean; timeoutMs?: number } = {}): Promise<unknown> {
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
  }: {
    attempts?: number;
    intervalMs?: number;
    detailed?: boolean;
  } = {}): Promise<unknown> {
    let lastError: unknown;
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
    throw codedError(
      `Native backend readiness timed out${lastError ? `: ${String(fieldsOf(lastError).message)}` : ""}`,
      "BACKEND_NOT_READY",
    );
  }

  async function backendCommand(): Promise<ProcessCommand> {
    if (!tools) await discover();
    const { compiledBackend, bun } = requireTools();
    if (compiledBackend)
      return { bin: compiledBackend, args: [], cwd: runtimeRoot };
    if (!repoRoot || !bun)
      throw new Error("Native backend source runtime is unavailable");
    return {
      bin: bun,
      args: ["run", "apps/node-backend/src/main.ts"],
      cwd: repoRoot,
    };
  }

  /**
   * `db-file.ts` through the same Bun that runs the backend: the packaged
   * backend executable acts as Bun when BUN_BE_BUN=1 and runs the bundled
   * tool from the payload; a source checkout runs the script with Bun.
   */
  async function databaseToolCommand(): Promise<
    ProcessCommand & { env: ChildEnv }
  > {
    if (!tools) await discover();
    const { compiledBackend, bun } = requireTools();
    const toolRoot = runtimeRoot ?? repoRoot;
    const env = {
      NODE_ENV: "production",
      ENVIRONMENT: "production",
      VISION_SKIP_DOTENV: "1",
      VISION_RUNTIME_ROOT: toolRoot,
      VISION_DATABASE_PATH: paths.database,
    };
    if (compiledBackend && runtimeRoot) {
      const tool = path.join(runtimeRoot, ...PACKAGED_DATABASE_TOOL.split("/"));
      if (!executableExists(compiledBackend) || !(await pathExists(tool))) {
        throw codedError(
          "Vision's database tool is missing from this installation. Reinstall Vision.",
          "DATABASE_TOOL_MISSING",
        );
      }
      return {
        bin: compiledBackend,
        args: [tool],
        cwd: runtimeRoot,
        env: safeChildEnv({ ...env, BUN_BE_BUN: "1" }),
      };
    }
    if (!repoRoot || !bun) {
      throw codedError(
        "Vision's database tool needs Bun and a Vision source checkout.",
        "DATABASE_TOOL_MISSING",
      );
    }
    return {
      bin: bun,
      args: ["run", SOURCE_DATABASE_TOOL],
      cwd: repoRoot,
      env: safeChildEnv(env),
    };
  }

  async function runDatabaseTool(
    args: string[],
    { timeout = 30 * 60_000, code = "DATABASE_TOOL_FAILED" } = {},
  ): Promise<DatabaseFileReport> {
    const command = await databaseToolCommand();
    let stdout: string;
    try {
      ({ stdout } = await runFile(
        command.bin,
        validateArgs([...command.args, ...args]),
        {
          cwd: command.cwd,
          env: command.env,
          timeout,
          maxBuffer: 16 * 1024 * 1024,
        },
      ));
    } catch (error) {
      const result = parseDatabaseToolOutput(optionalFieldsOf(error)?.stdout as string | undefined);
      throw codedError(
        result?.ok === false
          ? result.error
          : `Vision's database tool failed: ${String(optionalFieldsOf(error)?.message ?? error)}`,
        code,
        { cause: error },
      );
    }
    const result = parseDatabaseToolOutput(stdout);
    if (!result) {
      throw codedError("Vision's database tool returned no result", code);
    }
    if (!result.ok) throw codedError(result.error, code);
    return result.report;
  }

  /** integrity_check, foreign_key_check and the migration ledger of a database file. */
  async function verifyDatabaseFile(file: string): Promise<DatabaseFileReport> {
    return runDatabaseTool(["verify", path.resolve(file)], {
      code: "DATABASE_VERIFY_FAILED",
    });
  }

  /**
   * A consistent copy of the live database (VACUUM INTO, verified) at
   * `destination`. Written to a `.partial` sidecar and renamed only once the
   * tool verified it, so a failure never leaves a file at the final name.
   */
  async function snapshotDatabase(
    destination: string,
  ): Promise<DatabaseFileReport> {
    await ensureLayout();
    if (!(await pathExists(paths.database))) {
      throw codedError(
        "Vision has no database to back up yet.",
        "DATABASE_MISSING",
      );
    }
    const finalPath = path.resolve(destination);
    const partialPath = `${finalPath}.partial`;
    await fs.promises.mkdir(path.dirname(finalPath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.promises.rm(partialPath, { force: true });
    try {
      const report = await runDatabaseTool(
        ["snapshot", paths.database, partialPath],
        { code: "DATABASE_SNAPSHOT_FAILED" },
      );
      await fs.promises.rename(partialPath, finalPath);
      await fs.promises.chmod(finalPath, 0o600);
      return { ...report, file: finalPath };
    } catch (error) {
      await fs.promises.rm(partialPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * A new database at the packaged migration head, optionally loaded with a
   * data-only SQL file (the Demo seed). Requires the `create` command of
   * db-file.ts.
   */
  async function createDatabaseFile(
    destination: string,
    { seedSqlPath }: { seedSqlPath?: string | undefined } = {},
  ): Promise<DatabaseFileReport> {
    const args = ["create", path.resolve(destination)];
    if (seedSqlPath) args.push(path.resolve(seedSqlPath));
    return runDatabaseTool(args, { code: "DATABASE_CREATE_FAILED" });
  }

  /** File statistics of the live database, read without the backend. */
  async function getDatabaseStats(): Promise<DatabaseFileStats> {
    return readDatabaseFileStats(paths.database);
  }

  /** The live database is behind this build's migrations: the backend backs it up and migrates at start. */
  async function pendingSchemaUpgrade(): Promise<
    PendingSchemaUpgrade | undefined
  > {
    if (!runtimeRoot) return undefined;
    const packagedVersion = packagedMigrationVersion(
      path.join(runtimeRoot, "db", "migrations"),
    );
    const stats = await readDatabaseFileStats(paths.database).catch(
      () => undefined,
    );
    const databaseVersion = stats?.schemaVersion;
    // Version 0 is a database no migration has touched yet: nothing to back up.
    if (
      databaseVersion === undefined ||
      databaseVersion === 0 ||
      databaseVersion >= packagedVersion
    )
      return undefined;
    return { databaseVersion, packagedVersion };
  }

  async function processMatchesBackend(
    pid: unknown,
    command?: ProcessCommand,
  ): Promise<boolean> {
    if (!processExists(pid)) return false;
    const expected = command ?? (await backendCommand());
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
        argument.includes("apps/node-backend/src/main.ts") &&
        actual.includes(argument),
    );
  }

  async function waitForChildSpawn(spawned: SpawnedChild): Promise<number> {
    const immediatePid = probeableProcessId(spawned.pid);
    if (immediatePid !== undefined) return immediatePid;
    return new Promise((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        const pid = probeableProcessId(spawned.pid);
        if (pid === undefined) {
          reject(new Error("Native backend did not provide a process id"));
          return;
        }
        resolve(pid);
      };
      const onError = (error: Error) => {
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

  /**
   * Starts the backend, which opens the SQLite file and applies pending
   * migrations itself (after writing its own pre-migration copy).
   */
  async function start(): Promise<StartResult> {
    await assertNativeActive();
    await ensureDatabaseReady();
    const command = await backendCommand();
    const existing = await readJson(paths.pid).catch(() => undefined);
    const existingPid = probeableProcessId(optionalFieldsOf(existing)?.pid);
    if (existingPid !== undefined && processExists(existingPid)) {
      if (!(await processMatchesBackend(existingPid, command))) {
        throw codedError(
          "The recorded backend process id belongs to another process; refusing to signal it.",
          "BACKEND_PID_OWNERSHIP_MISMATCH",
        );
      }
      const healthy = await health().then(
        () => true,
        () => false,
      );
      if (!healthy) {
        throw codedError(
          "A recorded Vision backend process exists but is not healthy; stop it before restart.",
          "BACKEND_STALE_PID",
        );
      }
      return {
        status: "already-running",
        pid: existingPid,
        port: getAppPort(),
      };
    }
    await fs.promises.unlink(paths.pid).catch(() => {});

    const port = getAppPort();
    if (!(await checkPortFree(port))) {
      throw codedError(
        `Native backend port ${port} is already in use.`,
        "PORT_COLLISION",
      );
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
      syntheticOffline: options.syntheticOffline === true,
    });
    const logFd = fs.openSync(paths.backendLog, "a", 0o600);
    backendExit = undefined;
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
    const spawned = child;
    child.once("exit", () => {
      if (child === spawned) backendExit = { code: spawned.exitCode };
      void (async () => {
        const recorded = await readJson(paths.pid).catch(() => undefined);
        if (optionalFieldsOf(recorded)?.pid === childPid)
          await fs.promises.unlink(paths.pid).catch(() => {});
      })();
    });
    if (typeof child.unref === "function") child.unref();
    return {
      status: "started",
      pid: childPid,
      port,
      database: paths.database,
    };
  }

  /** Why the backend from the last start() exited, or undefined while it runs. */
  async function backendStartupFailure(): Promise<
    BackendStartupFailure | undefined
  > {
    if (!backendExit) return undefined;
    const log = await fs.promises
      .readFile(paths.backendLog, "utf8")
      .catch(() => "");
    return (
      lastStartupFailure(log.slice(-65_536)) ?? {
        message: `The Vision backend stopped during startup (exit code ${backendExit.code ?? "unknown"}).`,
      }
    );
  }

  async function stopBackend({
    forceAfterMs = 10_000,
  }: { forceAfterMs?: number } = {}): Promise<{
    status: "stopped";
    service: "backend";
    pid?: number;
  }> {
    const recorded = await readJson(paths.pid).catch(() => undefined);
    const recordedPid = probeableProcessId(optionalFieldsOf(recorded)?.pid);
    if (recordedPid === undefined || !processExists(recordedPid)) {
      await fs.promises.unlink(paths.pid).catch(() => {});
      return { status: "stopped", service: "backend" };
    }
    if (!(await processMatchesBackend(recordedPid))) {
      throw codedError(
        "The recorded backend process id belongs to another process; refusing to signal it.",
        "BACKEND_PID_OWNERSHIP_MISMATCH",
      );
    }
    process.kill(recordedPid, "SIGTERM");
    const deadline = Date.now() + forceAfterMs;
    while (processExists(recordedPid) && Date.now() < deadline)
      await sleep(100);
    if (processExists(recordedPid)) {
      process.kill(recordedPid, "SIGKILL");
      const killedDeadline = Date.now() + 10_000;
      while (processExists(recordedPid) && Date.now() < killedDeadline)
        await sleep(50);
      if (processExists(recordedPid))
        throw new Error(
          "Native backend did not stop; snapshot capture is unsafe",
        );
    }
    await fs.promises.unlink(paths.pid).catch(() => {});
    return { status: "stopped", service: "backend", pid: recordedPid };
  }

  async function stop({ forceAfterMs = 10_000 }: { forceAfterMs?: number } = {}) {
    const backend = await stopBackend({ forceAfterMs });
    return { status: "stopped", backend };
  }

  async function restart(): Promise<StartResult> {
    await stop();
    return start();
  }

  function generationNonce(): string {
    return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  }

  async function copyFileDurably(source: string, destination: string) {
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(destination, 0o600);
    const handle = await fs.promises.open(destination, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Stage a database file as the next generation, verify the staged copy,
   * then swap generations with two directory renames journaled beforehand.
   * Nothing live changes before the copy has passed verification; a failure
   * after the journal is written puts the previous generation back.
   */
  async function activateRestoredDatabase(
    sourcePath: string,
    { expectedSchemaVersion, expectedSha256 }: ActivateRestoreOptions = {},
  ): Promise<{
    switchToken: DatabaseSwitchToken;
    validation: DatabaseFileReport;
  }> {
    await assertNativeActive();
    await ensureLayout();
    if (!tools) await discover();
    await recoverOnce();
    const source = path.resolve(sourcePath);
    const stat = await fs.promises.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      throw codedError(
        "The database to restore is empty or not a file",
        "INVALID_DATABASE_FILE",
      );
    }
    const nonce = generationNonce();
    const staging = path.join(
      userDataDir,
      `${DATABASE_DIRECTORY_NAME}.restore-${nonce}`,
    );
    const previous = path.join(
      userDataDir,
      `${DATABASE_DIRECTORY_NAME}.previous-${nonce}`,
    );
    let switchToken: DatabaseSwitchToken | undefined;
    await fs.promises.mkdir(staging, { mode: 0o700 });
    try {
      const stagedFile = path.join(staging, DATABASE_FILE_NAME);
      await copyFileDurably(source, stagedFile);
      const validation = await verifyDatabaseFile(stagedFile);
      if (
        expectedSha256 !== undefined &&
        validation.sha256 !== expectedSha256
      ) {
        throw codedError(
          "The database in the backup does not match its recorded checksum; the backup is corrupt.",
          "DATABASE_CHECKSUM_MISMATCH",
        );
      }
      if (
        expectedSchemaVersion !== undefined &&
        validation.schemaVersion !== expectedSchemaVersion
      ) {
        throw codedError(
          "Restored database schema revision does not match backup metadata",
          "DATABASE_SCHEMA_MISMATCH",
        );
      }
      switchToken = {
        version: 2,
        kind: "sqlite-directory",
        liveDirectory: paths.databaseDir,
        previousDirectory: previous,
        activatedDirectory: staging,
        activatedAt: new Date().toISOString(),
      };
      // Persist the complete rename plan before touching the live database.
      // Recovery can then distinguish every interruption point without
      // creating a replacement empty database or guessing which copy is live.
      await writeState({ pendingDatabaseSwitch: switchToken });
      restoreSwitchOwnedThisLaunch = true;
      await stop();
      if (await pathExists(paths.databaseDir))
        await fs.promises.rename(paths.databaseDir, previous);
      await fs.promises.rename(staging, paths.databaseDir);
      await syncDirectory(userDataDir);
      return { switchToken, validation };
    } catch (error) {
      if (switchToken) {
        try {
          await rollbackDatabaseSwitch(switchToken);
        } catch (recoveryCause) {
          restoreSwitchOwnedThisLaunch = false;
          startupRestoreRecovery = undefined;
          const recoveryError = codedError(
            "Native database activation failed and automatic rollback did not complete; Vision remains stopped.",
            "DATABASE_SWITCH_RECOVERY_FAILED",
            { cause: error },
          );
          recoveryError.recoveryErrors = [recoveryCause];
          throw recoveryError;
        }
      } else {
        await fs.promises
          .rm(staging, { recursive: true, force: true })
          .catch(() => {});
      }
      throw error;
    }
  }

  async function rollbackDatabaseSwitch(switchToken?: unknown): Promise<{
    status: "rolled-back";
    preservedFailedDatabase: string | undefined;
  }> {
    await ensureLayout();
    const token = switchToken || (await readState())?.pendingDatabaseSwitch;
    if (!token)
      throw new Error("No matching native database switch is available");
    const { live, previous, activated } = switchTokenDirectories(token);
    await stop();
    // ensureLayout recreates an empty live directory; only a database file
    // inside it makes the live generation real.
    const liveExists = await pathExists(path.join(live, DATABASE_FILE_NAME));
    const previousExists = await pathExists(previous);
    const activatedExists = await pathExists(activated);
    const switchState = classifyDatabaseSwitchState({
      liveExists,
      previousExists,
    });
    if (switchState === "unsafe") {
      throw new Error(
        "Neither the live nor previous native database exists; automatic rollback is unsafe",
      );
    }

    let preservedFailedDatabase = activatedExists ? activated : undefined;
    if (switchState === "activated" || switchState === "between-renames") {
      const failed = path.join(
        userDataDir,
        `${DATABASE_DIRECTORY_NAME}.failed-${generationNonce()}`,
      );
      // The live directory exists in both states: as the activated
      // generation, or as the empty directory a layout check recreated.
      const liveDirectoryExists = await pathExists(live);
      if (liveDirectoryExists) await fs.promises.rename(live, failed);
      try {
        await fs.promises.rename(previous, live);
      } catch (error) {
        if (liveDirectoryExists)
          await fs.promises.rename(failed, live).catch(() => {});
        throw error;
      }
      await syncDirectory(userDataDir);
      if (switchState === "activated") preservedFailedDatabase = failed;
      else
        await fs.promises
          .rm(failed, { recursive: true, force: true })
          .catch(() => {});
    }
    await writeState({
      pendingDatabaseSwitch: undefined,
      lastRollback: {
        restoredDatabase:
          switchState === "before-renames" ? live : previous,
        preservedFailedDatabase,
        rolledBackAt: new Date().toISOString(),
      },
    });
    restoreSwitchOwnedThisLaunch = false;
    startupRestoreRecovery = undefined;
    return { status: "rolled-back", preservedFailedDatabase };
  }

  /** Keeps the newest previous generations; older ones are removed. */
  async function prunePreviousDatabaseGenerations(): Promise<void> {
    const prefix = `${DATABASE_DIRECTORY_NAME}.previous-`;
    const entries = await fs.promises.readdir(userDataDir, {
      withFileTypes: true,
    });
    const generations = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map(async (entry) => {
          const full = path.join(userDataDir, entry.name);
          return { full, mtimeMs: (await fs.promises.stat(full)).mtimeMs };
        }),
    );
    generations.sort(
      (a, b) =>
        b.mtimeMs !== a.mtimeMs
          ? b.mtimeMs - a.mtimeMs
          : b.full.localeCompare(a.full),
    );
    for (const old of generations.slice(PREVIOUS_DATABASE_GENERATIONS_KEPT)) {
      await fs.promises.rm(old.full, { recursive: true, force: true });
    }
  }

  async function finalizeDatabaseSwitch(
    switchToken?: unknown,
  ): Promise<
    | { status: "no-pending-switch" }
    | { status: "finalized"; previousDatabase: unknown }
  > {
    const state = await readState();
    const token = switchToken || state?.pendingDatabaseSwitch;
    if (!token) return { status: "no-pending-switch" };
    const previousDatabase = optionalFieldsOf(token)?.previousDirectory;
    await writeState({
      pendingDatabaseSwitch: undefined,
      previousDatabase,
      lastDatabaseSwitchAt: new Date().toISOString(),
    });
    restoreSwitchOwnedThisLaunch = false;
    startupRestoreRecovery = undefined;
    // Retention is cleanup after the commit point; it never fails the restore.
    await prunePreviousDatabaseGenerations().catch((error: unknown) => {
      console.warn(
        `[native] could not prune previous database generations: ${String(optionalFieldsOf(error)?.message ?? error)}`,
      );
    });
    return { status: "finalized", previousDatabase };
  }

  async function exportAttachments(
    destination: string,
  ): Promise<DirectoryFingerprint> {
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

  async function replaceAttachments(
    sourceDir: string,
    replaceOptions: ReplaceDirectoryOptions = {},
  ): Promise<DirectorySwitchToken> {
    const switchToken = await atomicReplaceDirectory(
      sourceDir,
      paths.attachments,
      {
        ...replaceOptions,
        beforeSwitch: async (token) => {
          if (replaceOptions.preservePrevious === true) {
            await writeState({ pendingAttachmentSwitch: token });
          }
          await replaceOptions.beforeSwitch?.(token);
        },
      },
    );
    return switchToken;
  }

  async function rollbackAttachmentSwitch(
    switchToken?: unknown,
  ): Promise<DirectoryRollbackResult> {
    const token = switchToken || (await readState())?.pendingAttachmentSwitch;
    const result = await rollbackDirectorySwitch(token);
    await writeState({ pendingAttachmentSwitch: undefined });
    return result;
  }

  async function finalizeAttachmentSwitch(
    switchToken?: unknown,
  ): Promise<DirectoryFinalizeResult> {
    const token = switchToken || (await readState())?.pendingAttachmentSwitch;
    const result = await finalizeDirectorySwitch(token);
    await writeState({ pendingAttachmentSwitch: undefined });
    return result;
  }

  return Object.freeze({
    mode: "native",
    runtimeId,
    paths,
    ensureLayout,
    importApplicationEnv,
    discover,
    recoverInterruptedRestore,
    ensureDatabaseReady,
    assertNativeActive,
    readState,
    writeState,
    start,
    backendStartupFailure,
    stop,
    restart,
    health,
    waitUntilReady,
    pendingSchemaUpgrade,
    verifyDatabaseFile,
    snapshotDatabase,
    createDatabaseFile,
    getDatabaseStats,
    exportAttachments,
    replaceAttachments,
    rollbackAttachmentSwitch,
    finalizeAttachmentSwitch,
    processMatchesBackend,
    activateRestoredDatabase,
    rollbackDatabaseSwitch,
    finalizeDatabaseSwitch,
  });
}
