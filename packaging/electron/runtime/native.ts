import { verifyRuntimeManifest } from "./runtime-manifest";
export {
  verifyRuntimeManifest,
} from "./runtime-manifest";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, type SpawnOptions } from "node:child_process";
import {
  DATABASE_STATS_SQL,
  parseDatabaseStats,
  type DatabaseStats,
} from "./database-stats";
import { createAuditAnchor, AuditAnchorError } from "../audit-anchor";
import { createKeychainWitness } from "../audit-keychain";

export const POSTGRES_MAJOR = 18;
export const POSTGRES_MINOR = 6;
export const CHROMIUM_VERSION = "150.0.7871.24";
export const DEFAULT_POSTGRES_PORT = 54329;
const DEFAULT_APP_PORT = 3002;
export const LOOPBACK_HOST = "127.0.0.1";
export const RUNTIME_MANAGED_MATERIALIZED_VIEWS = Object.freeze([
  "mv_monthly_summary",
  "mv_category_totals",
]);
export const REQUIRED_POSTGRES_EXTENSIONS = Object.freeze([
  "pg_trgm",
  "pgcrypto",
  "pg_stat_statements",
]);
export const NATIVE_APPLICATION_ENV_KEYS = Object.freeze([
  "TWELVE_DATA_API_KEY",
  "FINNHUB_API_KEY",
  "FMP_API_KEY",
  "ALPHA_VANTAGE_API_KEY",
  "FRED_API_KEY",
  "ADMIN_AUTH_TOKEN",
  "OPENAI_API_ENABLED",
  "OPENAI_API_KEY",
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
  auditStatus?: unknown;
  auditReason?: unknown;
  recoveryErrors?: unknown[];
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
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

/** An updater decision recorded through the private audit bridge. */
export type UpdateDecisionPayload = {
  readonly decision: string;
  readonly mode: string;
  readonly version: string;
};

/** The audit operations an updater decision needs from a runtime. */
export interface UpdateDecisionRuntime {
  readonly mode: string;
  recordAuditUpdateDecision(payload: UpdateDecisionPayload): Promise<unknown>;
  auditRequiresAnchoredClosure(): boolean | Promise<boolean>;
  closeAuditCheckpoint(): Promise<unknown>;
}

export async function recordUpdateDecisionThroughNativeRuntime(
  runtime: UpdateDecisionRuntime | null | undefined,
  payload: UpdateDecisionPayload,
): Promise<unknown> {
  if (runtime?.mode === "native") {
    const recorded = await runtime.recordAuditUpdateDecision(payload);
    if (!(await runtime.auditRequiresAnchoredClosure())) {
      return { auditStatus: "unavailable", recorded };
    }
    const closure = await runtime.closeAuditCheckpoint();
    if (optionalFieldsOf(closure)?.status !== "verified") {
      const error: NativeRuntimeError = new Error(
        "Native update audit checkpoint is unavailable",
      );
      error.code = "AUDIT_UPDATE_CHECKPOINT_UNAVAILABLE";
      throw error;
    }
    return recorded;
  }
  if (payload?.mode === "dev") return;
  throw new Error("Native update audit bridge is unavailable");
}

export function managedPostgresChildEnv(): ChildEnv {
  return safeChildEnv({
    LANG: "C",
    LC_ALL: "C",
    LC_CTYPE: "C",
  });
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

export function managedPostgresArgs(
  dataDirectory: string,
  postgresPort: number,
): string[] {
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
        env: options.env || safeChildEnv(),
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
          reject(wrapped);
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "" });
      },
    );
  });
}

export function parsePostgresMajor(
  output: string | undefined,
): number | undefined {
  const match =
    /PostgreSQL\)\s+(\d+)(?:\.\d+)?|PostgreSQL\s+(\d+)(?:\.\d+)?/i.exec(
      String(output || ""),
    );
  return match ? Number(match[1] || match[2]) : undefined;
}

export function parsePostgresVersionNumber(
  output: string | undefined,
): number | undefined {
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

/**
 * A backup is restorable only when it carries the Kysely migration ledger
 * (`public.kysely_migration`). Alembic-era backups predate the squashed
 * TypeScript baseline and are refused by this code.
 */
export const PRE_BASELINE_BACKUP_CODE = "BACKUP_PRE_BASELINE";
export const PRE_BASELINE_BACKUP_MESSAGE =
  "This backup was taken before Vision switched to the TypeScript migration baseline. Only backups taken after that switch can be restored.";

export function preBaselineBackupError(): NativeRuntimeError {
  const error: NativeRuntimeError = new Error(
    `${PRE_BASELINE_BACKUP_CODE}: ${PRE_BASELINE_BACKUP_MESSAGE}`,
  );
  error.code = PRE_BASELINE_BACKUP_CODE;
  return error;
}

// The schema version is the highest applied Kysely migration name. Names are
// zero-padded `NNNN_name`, so text ordering is migration order. The first
// row reports whether each ledger exists so a missing table is not an error.
const SCHEMA_LEDGER_SQL =
  "SELECT to_regclass('public.kysely_migration') IS NOT NULL, to_regclass('public.alembic_version') IS NOT NULL;";
const SCHEMA_HEAD_SQL = "SELECT max(name) FROM public.kysely_migration;";

export function assertPostgres18Version(label: string, output: string): number {
  const major = parsePostgresMajor(output);
  if (major !== POSTGRES_MAJOR) {
    const error: NativeRuntimeError = new Error(
      `${label} must be PostgreSQL ${POSTGRES_MAJOR}; found major ${major ?? "unknown"}`,
    );
    error.code = "POSTGRES_WRONG_VERSION";
    throw error;
  }
  return major;
}

export function bundledPostgresBin(
  runtimeRoot: string | undefined,
): string | undefined {
  if (!runtimeRoot) return undefined;
  const postgresRoot = path.join(path.resolve(runtimeRoot), "postgres");
  const metadataPath = path.join(postgresRoot, "runtime.json");
  let metadata: unknown;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    const wrapped: NativeRuntimeError = new Error(
      "Packaged PostgreSQL metadata is invalid",
    );
    wrapped.code = "POSTGRES_RUNTIME_CORRUPT";
    throw wrapped;
  }
  if (
    !isRecord(metadata) ||
    metadata.version !== 1 ||
    metadata.postgresMajor !== POSTGRES_MAJOR ||
    metadata.postgresVersion !== `${POSTGRES_MAJOR}.${POSTGRES_MINOR}` ||
    metadata.platform !== process.platform ||
    metadata.architecture !== process.arch ||
    typeof metadata.binRelative !== "string" ||
    path.isAbsolute(metadata.binRelative) ||
    metadata.binRelative.split(/[\\/]/).includes("..")
  ) {
    const error: NativeRuntimeError = new Error(
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
    const error: NativeRuntimeError = new Error(
      "Packaged PostgreSQL binary path is unsafe",
    );
    error.code = "POSTGRES_RUNTIME_CORRUPT";
    throw error;
  }
  return binDir;
}

function postgresBinCandidates(
  explicitBinDir: string | undefined,
  runtimeRoot: string | undefined,
  allowExternalPostgres = false,
): string[] {
  if (explicitBinDir) return [explicitBinDir];
  if (process.env.VISION_POSTGRES_BIN) return [process.env.VISION_POSTGRES_BIN];
  const candidates = [bundledPostgresBin(runtimeRoot)].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  if (allowExternalPostgres) {
    candidates.push(
      "/Applications/Postgres.app/Contents/Versions/18/bin",
      "/opt/homebrew/opt/postgresql@18/bin",
      "/usr/local/opt/postgresql@18/bin",
    );
  }
  return candidates;
}

export interface DiscoverPostgresOptions {
  binDir?: string | undefined;
  runtimeRoot?: string | undefined;
  allowExternalPostgres?: boolean;
  runFile?: RunFile;
}

export interface DiscoveredPostgres {
  binDir: string;
  versions: Record<string, string>;
  versionNumbers: Record<string, number | undefined>;
  managed: boolean;
}

export async function discoverPostgres18({
  binDir,
  runtimeRoot,
  allowExternalPostgres = false,
  runFile = defaultRunFile,
}: DiscoverPostgresOptions = {}): Promise<DiscoveredPostgres> {
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
  const attempts: string[] = [];
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

    const versions: Record<string, string> = {};
    const versionNumbers: Record<string, number | undefined> = {};
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

  const error: NativeRuntimeError = new Error(
    "Vision's packaged PostgreSQL 18.6 runtime was not found. Reinstall Vision or prepare the native runtime before starting.",
  );
  error.code = "POSTGRES_NOT_FOUND";
  throw error;
}

function normalizeRuntimeId(value: string | undefined): string {
  const normalized = String(value || "vision")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(normalized)) {
    throw new Error(`Invalid native runtime id: ${value}`);
  }
  return normalized;
}

export interface RuntimeNames {
  id: string;
  database: string;
  adminRole: string;
  ownerRole: string;
  appRole: string;
}

export function runtimeNames(runtimeId: string | undefined): RuntimeNames {
  const id = normalizeRuntimeId(runtimeId);
  return {
    id,
    database: id,
    adminRole: `${id}_admin`,
    ownerRole: `${id}_owner`,
    appRole: `${id}_app`,
  };
}

function validateIdentifier(value: unknown, label: string): string {
  const identifier = String(value || "");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(`Invalid ${label}`);
  }
  return identifier;
}

function validateNetworkPort(value: unknown, label = "network port"): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${label}`);
  }
  return port;
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

function quoteIdentifier(value: string): string {
  validateIdentifier(value, "PostgreSQL identifier");
  return `"${value}"`;
}

export function materializedViewOwnershipSql(appRole: string): string {
  const owner = quoteIdentifier(appRole);
  return RUNTIME_MANAGED_MATERIALIZED_VIEWS.map(
    (view) =>
      `ALTER MATERIALIZED VIEW IF EXISTS ${quoteIdentifier("public")}.${quoteIdentifier(view)} OWNER TO ${owner};`,
  ).join("\n");
}

function requireHexSecret(value: string | undefined): string {
  const secret = String(value || "");
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error(
      "Native database credentials must be 64 lowercase hexadecimal characters",
    );
  }
  return secret;
}

function quoteHexSecret(value: string | undefined): string {
  return `'${requireHexSecret(value)}'`;
}

export function parseEnvFile(
  contents: string | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
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

export interface NativeDatabaseConfig {
  database: string;
  adminRole: string;
  adminPassword: string;
  appRole: string;
  appPassword: string;
  ownerRole: string;
  ownerPassword: string;
  host: string;
  port: number;
  env: Record<string, string>;
  analysisPassword: string;
}

export function databaseConfigFromEnv(
  contents: string | undefined,
): NativeDatabaseConfig {
  const env = parseEnvFile(contents);
  // String() keeps the URL parser's "Invalid URL" failure for a missing key.
  const appUrl = new URL(String(env.DATABASE_URL));
  const ownerUrl = new URL(String(env.DATABASE_URL_MIGRATIONS));
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
  const analysisUrl = new URL(
    String(env.DATABASE_URL_ANALYSIS || env.DATABASE_URL),
  );
  if (!env.DATABASE_URL_ANALYSIS)
    analysisUrl.username = "vision_analysis_executor";
  if (
    decodeURIComponent(analysisUrl.username) !== "vision_analysis_executor" ||
    analysisUrl.hostname !== config.host ||
    Number(analysisUrl.port || 5432) !== config.port ||
    decodeURIComponent(analysisUrl.pathname.slice(1)) !== config.database ||
    !analysisUrl.password
  ) {
    throw new Error(
      "Native analysis URL must use the fixed executor on the native database",
    );
  }
  const analysisPassword = decodeURIComponent(analysisUrl.password);
  quoteHexSecret(config.appPassword);
  quoteHexSecret(config.ownerPassword);
  const adminPassword = requireHexSecret(config.adminPassword);
  if (new Set([config.adminRole, config.ownerRole, config.appRole]).size !== 3)
    throw new Error("Native PostgreSQL roles must be distinct");
  return { ...config, adminPassword, analysisPassword };
}

export function nativeEnvContents(
  names: Pick<RuntimeNames, "adminRole" | "appRole" | "ownerRole" | "database">,
  { postgresPort = DEFAULT_POSTGRES_PORT }: { postgresPort?: number } = {},
): string {
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

export function ensureNativeAdminEnv(
  contents: string,
  names: Pick<RuntimeNames, "adminRole">,
): string {
  const env = parseEnvFile(contents);
  if (env.VISION_POSTGRES_ADMIN_ROLE && env.VISION_POSTGRES_ADMIN_PASSWORD) {
    return contents;
  }
  const base = String(contents || "").replace(/\n?$/, "\n");
  return `${base}VISION_POSTGRES_ADMIN_ROLE=${names.adminRole}\nVISION_POSTGRES_ADMIN_PASSWORD=${crypto.randomBytes(32).toString("hex")}\n`;
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
  paths: Pick<NativeRuntimePaths, "attachments" | "cache" | "env">;
  runtimeRoot?: string | undefined;
  repoRoot?: string | undefined;
  tools: { chrome?: string | undefined };
  auditBridgeToken?: string | undefined;
  syntheticOffline?: boolean | undefined;
}

export function buildNativeBackendEnv({
  runtimeEnv,
  port,
  paths,
  runtimeRoot,
  repoRoot,
  tools,
  auditBridgeToken,
  syntheticOffline,
}: NativeBackendEnvOptions): ChildEnv {
  const resolvedRuntimeRoot = runtimeRoot || repoRoot;
  if (!resolvedRuntimeRoot) {
    throw new Error("Native backend runtime root is unavailable");
  }
  const openAiEnabled =
    runtimeEnv.OPENAI_API_ENABLED === "true" &&
    Boolean(runtimeEnv.OPENAI_API_KEY);
  return safeChildEnv({
    ...runtimeEnv,
    OPENAI_API_ENABLED: openAiEnabled ? "true" : "false",
    OPENAI_API_KEY: openAiEnabled ? runtimeEnv.OPENAI_API_KEY : undefined,
    SERVER_HOST: LOOPBACK_HOST,
    PORT: String(port),
    NODE_ENV: "production",
    ENVIRONMENT: "production",
    ATTACHMENTS_DIR: paths.attachments,
    VISION_RUNTIME_ROOT: resolvedRuntimeRoot,
    VISION_NATIVE_ENV_FILE: paths.env,
    VISION_DIST_DIR: path.join(resolvedRuntimeRoot, "dist"),
    PUPPETEER_EXECUTABLE_PATH: tools.chrome,
    OLLAMA_URL: "http://127.0.0.1:11434",
    ADMIN_ALLOW_TOKENLESS_NONLOOPBACK: "false",
    VISION_AUDIT_BRIDGE_TOKEN: auditBridgeToken,
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
          reject(error);
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

export function bundledChromiumPath(
  runtimeRoot: string | undefined,
): string | undefined {
  if (!runtimeRoot) return undefined;
  const chromiumRoot = path.join(path.resolve(runtimeRoot), "chromium");
  const metadataPath = path.join(chromiumRoot, "runtime.json");
  let metadata: unknown;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    const wrapped: NativeRuntimeError = new Error(
      "Packaged Chromium metadata is invalid",
    );
    wrapped.code = "CHROMIUM_RUNTIME_CORRUPT";
    throw wrapped;
  }
  if (
    !isRecord(metadata) ||
    metadata.version !== 1 ||
    metadata.browser !== "chrome-headless-shell" ||
    metadata.browserVersion !== CHROMIUM_VERSION ||
    metadata.platform !== process.platform ||
    metadata.architecture !== process.arch ||
    typeof metadata.executableRelative !== "string" ||
    path.isAbsolute(metadata.executableRelative) ||
    metadata.executableRelative.split(/[\\/]/).includes("..")
  ) {
    const error: NativeRuntimeError = new Error(
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
    const error: NativeRuntimeError = new Error(
      "Packaged Chromium executable is missing or unsafe",
    );
    error.code = "CHROMIUM_RUNTIME_CORRUPT";
    throw error;
  }
  return executable;
}

export function discoverChrome(
  explicitPath: string | undefined,
  runtimeRoot: string | undefined,
): string | undefined {
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

export function assertNativeChromeAvailable(
  chromePath: string | undefined,
): string {
  if (chromePath) return chromePath;
  const error: NativeRuntimeError = new Error(
    "Vision's packaged Chrome Headless Shell was not found. Reinstall Vision or prepare the native runtime before starting.",
  );
  error.code = "NATIVE_CHROMIUM_NOT_FOUND";
  throw error;
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
  const exists = (file: string) =>
    fs.promises
      .lstat(file)
      .then(() => true)
      .catch((error: unknown) => {
        if (optionalFieldsOf(error)?.code === "ENOENT") return false;
        throw error;
      });
  const destinationExists = await exists(destination);
  const previousExists = previous ? await exists(previous) : false;
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

type AuditAnchorOptions = Parameters<typeof createAuditAnchor>[0];

/** Encryption the audit anchor uses for its key (Electron's safeStorage). */
export type AuditSafeStorage = AuditAnchorOptions["safeStorage"];

/** External witness of the audit checkpoint (the macOS Keychain helper). */
export type AuditWitness = AuditAnchorOptions["witness"];

/** Sends one request to the backend's private audit bridge. */
export type AuditRequest = (
  endpoint: string,
  payload: UnknownRecord,
) => Promise<unknown>;

const LEGACY_CUTOVER_FIELDS = [
  "dbEditorMaxId",
  "splitMaxId",
  "retagMaxId",
] as const;

const VERIFIED_AUDIT_STATUSES: readonly unknown[] = [
  "verified",
  "partially_verified",
];

/**
 * The audit anchor operations the runtime uses. The anchor validates its own
 * inputs and outputs; the runtime reads its results field by field.
 */
interface NativeAuditAnchor {
  readTrustedCheckpoint(): Promise<unknown>;
  initializeFirstCheckpoint(
    head: unknown,
    legacyCutover: unknown,
    options?: { enrollment?: boolean },
  ): Promise<unknown>;
  persistCheckpoint(head: unknown): Promise<unknown>;
  persistRetentionBoundary(candidate: unknown): Promise<unknown>;
  exportProtectedTransfer(password: unknown): Promise<Buffer>;
  importProtectedTransfer(
    contents: Buffer,
    password: unknown,
    options?: { expectedCurrent?: { sequence: unknown; hash: unknown } },
  ): Promise<unknown>;
  rotateKey(): Promise<unknown>;
}

/** An audit verification or read outcome; bridge results pass through. */
export type AuditResult = UnknownRecord;

export interface AuditReadResult {
  readonly verification: AuditResult;
  readonly entries: readonly unknown[];
  readonly hasMore: boolean;
  readonly [field: string]: unknown;
}

export interface NativeRuntimeOptions {
  userDataDir: string;
  repoRoot?: string | undefined;
  runtimeRoot?: string | undefined;
  postgresRuntimeRoot?: string | undefined;
  browserRuntimeRoot?: string | undefined;
  runtimeId?: string | undefined;
  postgresPort?: number | string | undefined;
  appPort?: number | (() => number) | undefined;
  postgresBinDir?: string | undefined;
  allowExternalPostgres?: boolean | undefined;
  bunPath?: string | undefined;
  chromePath?: string | undefined;
  requireRuntimeManifest?: boolean | undefined;
  syntheticOffline?: boolean | undefined;
  runFile?: RunFile | undefined;
  spawnProcess?: SpawnProcess | undefined;
  spawnPostgresProcess?: SpawnProcess | undefined;
  isPortFree?: ((port: number) => Promise<boolean>) | undefined;
  auditBridgeToken?: string | undefined;
  auditSafeStorage?: AuditSafeStorage | undefined;
  auditKeychainHelper?: string | undefined;
  auditWitness?: AuditWitness | undefined;
  auditPlatform?: NodeJS.Platform | undefined;
  auditRequest?: AuditRequest | undefined;
}

export interface NativeRuntimePaths {
  readonly nativeRoot: string;
  readonly env: string;
  readonly state: string;
  readonly pid: string;
  readonly logs: string;
  readonly backendLog: string;
  readonly postgresLog: string;
  readonly postgresPid: string;
  readonly postgresRoot: string;
  readonly postgresData: string;
  readonly attachments: string;
  readonly cache: string;
}

export interface NativeTools extends DiscoveredPostgres {
  bun: string | undefined;
  compiledBackend: string | undefined;
  chrome: string | undefined;
}

export interface DatabaseSwitchToken {
  version: number;
  liveDatabase: string;
  previousDatabase: string;
  activatedDatabase: string;
  activatedAt: string;
}

/** runtime-state.json. Persisted, so every field is read back as unknown. */
export type NativeRuntimeState = UnknownRecord;

export type ManagedClusterResult =
  | { status: "external"; configChanged: false }
  | {
      status: "existing" | "initialized";
      dataDirectory: string;
      configChanged: boolean;
    };

export type StartResult =
  | { status: "already-running"; pid: number; port: number }
  | { status: "started"; pid: number; port: number; database: string };

export type AuditRetentionResult =
  | { status: "unavailable" | "not_due" | "nothing_due" }
  | { status: "pruned"; removed: unknown };

interface BackendCommand {
  bin: string;
  args: string[];
  cwd: string | undefined;
}

type NativeRuntime = ReturnType<typeof createNativeRuntime>;

export function createNativeRuntime(options: NativeRuntimeOptions) {
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
  const runFile: RunFile = options.runFile || defaultRunFile;
  const spawnProcess: SpawnProcess = options.spawnProcess || spawn;
  const spawnPostgresProcess: SpawnProcess =
    options.spawnPostgresProcess || spawn;
  const checkPortFree: (port: number) => Promise<boolean> =
    options.isPortFree || isPortFree;
  const getAppPort: () => number =
    typeof options.appPort === "function"
      ? options.appPort
      : () => Number(options.appPort || DEFAULT_APP_PORT);
  const auditBridgeToken = options.auditBridgeToken;
  if (
    auditBridgeToken !== undefined &&
    !/^[0-9a-f]{64}$/.test(auditBridgeToken)
  ) {
    throw new TypeError("Invalid native audit bridge token");
  }
  const auditAnchor: NativeAuditAnchor | undefined =
    options.auditSafeStorage &&
    (options.auditKeychainHelper || options.auditWitness)
      ? createAuditAnchor({
          userDataDir,
          safeStorage: options.auditSafeStorage,
          witness:
            options.auditWitness ||
            createKeychainWitness({
              executable: options.auditKeychainHelper,
              runtimeId,
            }),
          platform: options.auditPlatform,
        })
      : undefined;
  const sendAuditRequest: AuditRequest = options.auditRequest || auditRequest;
  const nativeRoot = path.join(userDataDir, "native", runtimeId);
  const paths: NativeRuntimePaths = Object.freeze({
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
  let tools: NativeTools | undefined;
  let child: SpawnedChild | undefined;
  let postgresChild: SpawnedChild | undefined;
  let newClusterCreatedThisLaunch = false;
  let restoreSwitchOwnedThisLaunch = false;
  let startupRestoreRecovery: Promise<void> | undefined;
  let freshAuditReceiptId: unknown;
  let auditSessionEstablished = false;
  let auditLiveClosureEnabled = false;
  let auditAnchorDetectedThisLaunch = false;
  let auditEverTrustedThisLaunch = false;
  let auditCheckpointMetadataSyncedThisLaunch = false;
  let auditClosurePaused = false;
  let auditClosurePromise: Promise<unknown> = Promise.resolve();
  let lastAuditRetentionAttempt = 0;
  let auditRetentionPromise: Promise<AuditRetentionResult> | undefined;

  /** The discovered tools; like reading `tools.x` before discovery, throws. */
  function requireTools(): NativeTools {
    if (!tools) throw new TypeError("Native runtime tools are not discovered");
    return tools;
  }

  async function ensureLayout(): Promise<NativeDatabaseConfig> {
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
        if (errorCode(error) === "ENOENT") return undefined;
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
      const error: NativeRuntimeError = new Error(
        "Native runtime configuration targets a different PostgreSQL port.",
      );
      error.code = "POSTGRES_PORT_MISMATCH";
      throw error;
    }
    return config;
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

  async function discover(): Promise<
    NativeTools & { postgresVersion: number }
  > {
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
    const bun = resolveBun(options.bunPath, runtimeRoot);
    const compiledBackend = runtimeRoot
      ? findFirstExecutable([path.join(runtimeRoot, "vision-backend")])
      : undefined;
    if (!compiledBackend && !bun) {
      const error: NativeRuntimeError = new Error(
        "Bun was not found and no packaged Vision backend executable is available.",
      );
      error.code = "BUN_NOT_FOUND";
      throw error;
    }
    tools = {
      ...postgres,
      bun,
      compiledBackend,
      chrome: discoverChrome(options.chromePath, browserRuntimeRoot),
    };
    return { ...tools, postgresVersion: POSTGRES_MAJOR };
  }

  function postgresConfigString(value: string): string {
    return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
  }

  async function ensureManagedPostgresConfig(
    dataDirectory: string,
  ): Promise<boolean> {
    const visionConfig = path.join(dataDirectory, "vision.conf");
    const desiredConfig = [
      `listen_addresses = ${postgresConfigString(LOOPBACK_HOST)}`,
      `port = ${postgresPort}`,
      "unix_socket_directories = ''",
      "password_encryption = 'scram-sha-256'",
      "shared_preload_libraries = 'pg_stat_statements'",
      "logging_collector = off",
      "",
    ].join("\n");
    const currentConfig = await fs.promises
      .readFile(visionConfig, "utf8")
      .catch((error) => {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      });
    let changed = currentConfig !== desiredConfig;
    if (changed) await writeAtomic(visionConfig, desiredConfig, 0o600);
    const postgresConfig = path.join(dataDirectory, "postgresql.conf");
    const baseConfig = await fs.promises.readFile(postgresConfig, "utf8");
    if (!/^\s*include\s*=\s*'vision\.conf'\s*$/m.test(baseConfig)) {
      await writeAtomic(
        postgresConfig,
        `${baseConfig.replace(/\n?$/, "\n")}include = 'vision.conf'\n`,
        0o600,
      );
      changed = true;
    }
    return changed;
  }

  async function ensureManagedPostgresCluster(
    config: NativeDatabaseConfig,
  ): Promise<ManagedClusterResult> {
    if (!tools?.managed) return { status: "external", configChanged: false };
    const versionPath = path.join(paths.postgresData, "PG_VERSION");
    const existingVersion = await fs.promises
      .readFile(versionPath, "utf8")
      .then((value) => value.trim())
      .catch((error) => {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      });
    if (existingVersion !== undefined) {
      if (existingVersion !== String(POSTGRES_MAJOR)) {
        const error: NativeRuntimeError = new Error(
          `Vision's private PostgreSQL cluster must be major ${POSTGRES_MAJOR}.`,
        );
        error.code = "POSTGRES_DATA_WRONG_VERSION";
        throw error;
      }
      await fs.promises.chmod(paths.postgresData, 0o700);
      const configChanged = await ensureManagedPostgresConfig(
        paths.postgresData,
      );
      return {
        status: "existing",
        dataDirectory: paths.postgresData,
        configChanged,
      };
    }

    const liveStat = await fs.promises
      .lstat(paths.postgresData)
      .catch((error) => {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      });
    if (liveStat?.isSymbolicLink()) {
      const error: NativeRuntimeError = new Error(
        "Vision PostgreSQL data directory is a symlink",
      );
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
        path.join(requireTools().binDir, "initdb"),
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
        {
          timeout: 5 * 60_000,
          maxBuffer: 16 * 1024 * 1024,
          env: managedPostgresChildEnv(),
        },
      );
      await ensureManagedPostgresConfig(staging);
      await fs.promises.chmod(staging, 0o700);
      await fs.promises.rename(staging, paths.postgresData);
      newClusterCreatedThisLaunch = true;
      return {
        status: "initialized",
        dataDirectory: paths.postgresData,
        configChanged: true,
      };
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

  async function inspectReadyPostgres(
    config: NativeDatabaseConfig,
  ): Promise<{ serverVersionNum: number; listenAddresses: string[] }> {
    const psql = path.join(requireTools().binDir, "psql");
    const execute = async (env: ChildEnv, roleArgs: string[]) =>
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
    const result = requireTools().managed
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
      const error: NativeRuntimeError = new Error(
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
      const error: NativeRuntimeError = new Error(
        "PostgreSQL listen_addresses is not loopback-only; refusing to start Vision.",
      );
      error.code = "POSTGRES_UNSAFE_BIND";
      throw error;
    }
    if (requireTools().managed) {
      const actualData = await fs.promises
        .realpath(lines[2] || "")
        .catch(() => "");
      const expectedData = await fs.promises.realpath(paths.postgresData);
      if (actualData !== expectedData) {
        const error: NativeRuntimeError = new Error(
          "The native PostgreSQL port belongs to a different database cluster.",
        );
        error.code = "POSTGRES_PORT_COLLISION";
        throw error;
      }
    }
    return { serverVersionNum, listenAddresses: addresses };
  }

  async function assertExternalPostgresObservability(): Promise<void> {
    if (requireTools().managed) return;
    const result = await runFile(
      path.join(requireTools().binDir, "psql"),
      [
        "-h",
        LOOPBACK_HOST,
        "-p",
        String(postgresPort),
        "--dbname",
        "postgres",
        "--tuples-only",
        "--no-align",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        "SHOW shared_preload_libraries;",
      ],
      { timeout: 10_000, env: safeChildEnv() },
    );
    const preloaded = result.stdout
      .trim()
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!preloaded.includes("pg_stat_statements")) {
      const error: NativeRuntimeError = new Error(
        "External PostgreSQL must preload pg_stat_statements. Install the PostgreSQL contrib package, add pg_stat_statements to shared_preload_libraries, and restart PostgreSQL.",
      );
      error.code = "POSTGRES_OBSERVABILITY_UNAVAILABLE";
      throw error;
    }
  }

  async function startManagedPostgres(
    _config: NativeDatabaseConfig,
  ): Promise<number> {
    if (!(await checkPortFree(postgresPort))) {
      const error: NativeRuntimeError = new Error(
        `Native PostgreSQL port ${postgresPort} is already in use.`,
      );
      error.code = "POSTGRES_PORT_COLLISION";
      throw error;
    }
    const logFd = fs.openSync(paths.postgresLog, "a", 0o600);
    postgresChild = spawnPostgresProcess(
      path.join(requireTools().binDir, "postgres"),
      managedPostgresArgs(paths.postgresData, postgresPort),
      {
        cwd: paths.postgresRoot,
        env: managedPostgresChildEnv(),
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
      if (optionalFieldsOf(recorded)?.pid === pid)
        await fs.promises.unlink(paths.postgresPid).catch(() => {});
    });
    if (typeof postgresChild.unref === "function") postgresChild.unref();
    return pid;
  }

  async function ensurePostgresReady({
    startService = true,
  }: { startService?: boolean } = {}): Promise<{
    serverVersionNum: number;
    listenAddresses: string[];
  }> {
    if (!tools) await discover();
    const config = await ensureLayout();
    const cluster = await ensureManagedPostgresCluster(config);
    const pgIsReady = path.join(requireTools().binDir, "pg_isready");
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
      let inspected: Awaited<ReturnType<typeof inspectReadyPostgres>>;
      try {
        inspected = await inspectReadyPostgres(config);
      } catch (error) {
        if (
          requireTools().managed &&
          errorCode(error) !== "POSTGRES_WRONG_VERSION"
        ) {
          const collision: NativeRuntimeError = new Error(
            `Native PostgreSQL port ${postgresPort} is occupied by another server.`,
          );
          collision.code = "POSTGRES_PORT_COLLISION";
          collision.cause = error;
          throw collision;
        }
        throw error;
      }
      if (!(requireTools().managed && cluster.configChanged)) {
        await assertExternalPostgresObservability();
        return inspected;
      }
      if (!startService) {
        const error: NativeRuntimeError = new Error(
          "Managed PostgreSQL configuration changed and requires a restart.",
        );
        error.code = "POSTGRES_RESTART_REQUIRED";
        throw error;
      }
      await stopPostgres();
      ready = false;
    }
    if (!ready && startService && requireTools().managed) {
      await startManagedPostgres(config);
      // A clean cluster accepts connections ~0.1 s after spawn, so poll finely
      // instead of losing most of a coarse interval on every launch.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (
          postgresChild?.exitCode !== undefined &&
          postgresChild?.exitCode !== null
        )
          break;
        ready = await runFile(pgIsReady, readyArgs, { timeout: 3_000 })
          .then(() => true)
          .catch(() => false);
        if (ready) break;
        await sleep(50);
      }
    }
    if (!ready) {
      const error: NativeRuntimeError = new Error(
        "PostgreSQL 18 did not become ready on 127.0.0.1.",
      );
      error.code = "POSTGRES_UNAVAILABLE";
      throw error;
    }

    const inspected = await inspectReadyPostgres(config);
    await assertExternalPostgresObservability();
    return inspected;
  }

  async function withPgPass<T>(
    config: NativeDatabaseConfig,
    role: string,
    password: string,
    callback: (env: ChildEnv) => Promise<T>,
  ): Promise<T> {
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

  async function runAsClusterAdmin(
    config: NativeDatabaseConfig,
    executable: string,
    args: string[],
    options_: RunFileOptions = {},
  ): Promise<RunFileResult> {
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

  function clusterAdminArgs(config: NativeDatabaseConfig): string[] {
    return tools?.managed ? ["-U", config.adminRole] : [];
  }

  async function runSecretAdminSql(
    config: NativeDatabaseConfig,
    sql: string,
    timeout = 10_000,
  ): Promise<RunFileResult> {
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "vision-pg-admin-"),
    );
    const sqlFile = path.join(tempDir, "command.sql");
    await fs.promises.writeFile(sqlFile, `${sql}\n`, { mode: 0o600 });
    try {
      try {
        return await runAsClusterAdmin(
          config,
          path.join(requireTools().binDir, "psql"),
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
          { timeout },
        );
      } catch {
        const error: NativeRuntimeError = new Error(
          "Native database role bootstrap failed",
        );
        error.code = "POSTGRES_ROLE_BOOTSTRAP_FAILED";
        throw error;
      }
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  async function recoverInterruptedRestore(): Promise<void> {
    const state = await readState();
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
    if (state?.pendingDatabaseSwitch) {
      await stop({ keepPostgres: true });
      if (attachments) await rollbackAttachmentSwitch(attachments);
      await rollbackDatabaseSwitch(state.pendingDatabaseSwitch);
    } else if (attachments) {
      // The database commit is durable; never roll its attachment generation back.
      await finalizeAttachmentSwitch(attachments);
    }
  }

  async function bootstrapDatabase(): Promise<NativeDatabaseConfig> {
    const config = await ensureLayout();
    await ensurePostgresReady();
    if (!tools) await discover();
    if (!restoreSwitchOwnedThisLaunch) {
      startupRestoreRecovery ??= recoverInterruptedRestore();
      await startupRestoreRecovery;
    }
    // One psql session re-asserts every role, the database and (for the
    // managed cluster) its extensions; a process per statement cost ~0.4 s
    // on every launch.
    const ensureRole = (role: string): string => {
      const name = validateIdentifier(role, "PostgreSQL role");
      return `SELECT 'CREATE ROLE ${name} NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') \\gexec`;
    };
    const owner = quoteIdentifier(config.ownerRole);
    const app = quoteIdentifier(config.appRole);
    const database = validateIdentifier(config.database, "database name");
    // Role administration stays in the desktop runtime; the migration owner
    // only grants access to the approved views after migrations have finished.
    const analysisRole = "vision_analysis_executor";
    const analysisPassword = `E'${config.analysisPassword.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
    const statements = [
      ensureRole(config.ownerRole),
      `ALTER ROLE ${owner} WITH LOGIN PASSWORD ${quoteHexSecret(config.ownerPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`,
      ensureRole(config.appRole),
      `ALTER ROLE ${app} WITH LOGIN PASSWORD ${quoteHexSecret(config.appPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`,
      ensureRole(analysisRole),
      `ALTER ROLE ${analysisRole} WITH LOGIN PASSWORD ${analysisPassword} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
      `ALTER ROLE ${analysisRole} SET default_transaction_read_only = on;`,
      `ALTER ROLE ${analysisRole} SET statement_timeout = '5000ms';`,
      `ALTER ROLE ${analysisRole} SET lock_timeout = '1000ms';`,
      `ALTER ROLE ${analysisRole} SET idle_in_transaction_session_timeout = '5000ms';`,
      `ALTER ROLE ${analysisRole} SET search_path = vision_analysis, pg_catalog;`,
      `SELECT 'CREATE DATABASE ${database} OWNER ${owner} TEMPLATE template0' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${database}') \\gexec`,
      `ALTER DATABASE ${quoteIdentifier(database)} OWNER TO ${owner};`,
    ];
    if (requireTools().managed) {
      // pg_stat_statements is not trusted, so only the private cluster
      // administrator can install it. The migration owner stays non-superuser.
      statements.push(
        `\\connect ${database}`,
        ...REQUIRED_POSTGRES_EXTENSIONS.map(
          (extension) => `CREATE EXTENSION IF NOT EXISTS ${extension};`,
        ),
      );
    }
    await runSecretAdminSql(config, statements.join("\n"), 60_000);
    if (!requireTools().managed)
      await installRequiredExtensions(config.database, config);
    return config;
  }

  async function installRequiredExtensions(
    database: string,
    config: NativeDatabaseConfig,
  ): Promise<void> {
    const target = validateIdentifier(database, "database name");
    const psql = path.join(requireTools().binDir, "psql");
    const extensionArgs = (roleArgs: string[]): string[] => [
      "-h",
      LOOPBACK_HOST,
      "-p",
      String(config.port),
      ...roleArgs,
      "-d",
      target,
      "--set",
      "ON_ERROR_STOP=1",
      "--no-psqlrc",
      "--command",
      REQUIRED_POSTGRES_EXTENSIONS.map(
        (extension) => `CREATE EXTENSION IF NOT EXISTS ${extension};`,
      ).join(" "),
    ];
    if (requireTools().managed) {
      // pg_stat_statements is not trusted, so only the private cluster
      // administrator can install it. The migration owner stays non-superuser.
      await runAsClusterAdmin(
        config,
        psql,
        extensionArgs(clusterAdminArgs(config)),
        { timeout: 30_000 },
      );
    } else {
      await withPgPass(config, config.ownerRole, config.ownerPassword, (env) =>
        runFile(psql, extensionArgs(["-U", config.ownerRole]), {
          timeout: 30_000,
          env,
        }),
      );
    }
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
      ...(current || {}),
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
    const error: NativeRuntimeError = new Error(
      `Native backend readiness timed out${lastError ? `: ${String(fieldsOf(lastError).message)}` : ""}`,
    );
    error.code = "BACKEND_NOT_READY";
    throw error;
  }

  async function backendCommand(): Promise<BackendCommand> {
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

  async function migrateDatabase(): Promise<{
    status: "migrated";
    database: string;
  }> {
    const config = await bootstrapDatabase();
    const bun = tools?.bun;
    if (!repoRoot || !bun) {
      const error: NativeRuntimeError = new Error(
        "Listener-free migration is available only from a Vision source checkout",
      );
      error.code = "MIGRATION_SOURCE_UNAVAILABLE";
      throw error;
    }
    const runtimeEnv = parseEnvFile(
      await fs.promises.readFile(paths.env, "utf8"),
    );
    await runFile(
      bun,
      ["run", "apps/node-backend/scripts/db-migrate.ts", "up"],
      {
        cwd: repoRoot,
        timeout: 15 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
        env: safeChildEnv({
          ...runtimeEnv,
          VISION_RUNTIME_ROOT: runtimeRoot || repoRoot,
        }),
      },
    );
    return { status: "migrated", database: config.database };
  }

  async function processMatchesBackend(
    pid: unknown,
    command: BackendCommand | undefined = undefined,
  ): Promise<boolean> {
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
        argument.includes("apps/node-backend/src/main.ts") &&
        actual.includes(argument),
    );
  }

  async function waitForChildSpawn(spawned: SpawnedChild): Promise<number> {
    const immediatePid = probeableProcessId(spawned?.pid);
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

  async function start(): Promise<StartResult> {
    await assertNativeActive();
    const config = await bootstrapDatabase();
    assertNativeChromeAvailable(tools?.chrome);
    const command = await backendCommand();
    const existing = await readJson(paths.pid).catch(() => undefined);
    const existingPid = probeableProcessId(optionalFieldsOf(existing)?.pid);
    if (existingPid !== undefined && processExists(existingPid)) {
      if (!(await processMatchesBackend(existingPid, command))) {
        const error: NativeRuntimeError = new Error(
          "The recorded backend process id belongs to another process; refusing to signal it.",
        );
        error.code = "BACKEND_PID_OWNERSHIP_MISMATCH";
        throw error;
      }
      const healthy = await health().then(
        () => true,
        () => false,
      );
      if (!healthy) {
        const error: NativeRuntimeError = new Error(
          "A recorded Vision backend process exists but is not healthy; stop it before restart.",
        );
        error.code = "BACKEND_STALE_PID";
        throw error;
      }
      if (!auditBridgeToken) {
        return {
          status: "already-running",
          pid: existingPid,
          port: getAppPort(),
        };
      }
      // A backend kept alive across app launches has the previous launch's
      // private token. Restart it before any audit verification request.
      await stopBackend();
    }
    await fs.promises.unlink(paths.pid).catch(() => {});

    const port = getAppPort();
    if (!(await checkPortFree(port))) {
      const error: NativeRuntimeError = new Error(
        `Native backend port ${port} is already in use.`,
      );
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
      tools: requireTools(),
      auditBridgeToken,
      syntheticOffline: options.syntheticOffline === true,
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
      if (optionalFieldsOf(recorded)?.pid === childPid)
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

  function auditRequest(
    endpoint: string,
    payload: UnknownRecord,
  ): Promise<unknown> {
    if (!auditBridgeToken) {
      const error: NativeRuntimeError = new Error(
        "Native audit bridge is not configured",
      );
      error.code = "AUDIT_BRIDGE_UNAVAILABLE";
      throw error;
    }
    const data = JSON.stringify(payload);
    const maxResponseBytes = endpoint === "read" ? 4 * 1024 * 1024 : 16_384;
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          hostname: LOOPBACK_HOST,
          port: getAppPort(),
          path: `/api/internal/audit/${endpoint}`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${auditBridgeToken}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          },
          timeout: 10_000,
        },
        (response) => {
          let body = "";
          let responseBytes = 0;
          response.on("data", (chunk: Buffer) => {
            responseBytes += chunk.length;
            if (responseBytes > maxResponseBytes) {
              request.destroy(new Error("Audit bridge response is too large"));
              return;
            }
            body += chunk;
          });
          response.on("end", () => {
            try {
              const parsed: unknown = JSON.parse(body);
              if (
                response.statusCode !== 200 ||
                optionalFieldsOf(parsed)?.ok !== true ||
                !fieldsOf(parsed).data
              ) {
                throw new Error("Audit bridge rejected request");
              }
              resolve(fieldsOf(parsed).data);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("timeout", () =>
        request.destroy(new Error("Audit bridge timed out")),
      );
      request.on("error", reject);
      request.end(data);
    });
  }

  async function recordAuditUpdateDecision(
    payload: UpdateDecisionPayload,
  ): Promise<unknown> {
    return sendAuditRequest("update-decision", payload);
  }

  function checkpointBridgePayload(metadata: unknown): UnknownRecord {
    const { sequence, headHash, anchorKind, receiptId, receiptHash } =
      fieldsOf(metadata);
    return { sequence, headHash, anchorKind, receiptId, receiptHash };
  }

  function trustedBridgePayload(trusted: UnknownRecord): UnknownRecord {
    return {
      sequence: trusted.sequence,
      hash: trusted.hash,
      ...(trusted.retention ? { retention: trusted.retention } : {}),
    };
  }

  async function readVerifiedAuditEntries({
    afterSequence = 0,
    limit = 100,
  }: {
    afterSequence?: number;
    limit?: number;
  } = {}): Promise<AuditReadResult> {
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new RangeError("Invalid audit read page");
    }
    const unavailable = (status: string, reason: string): AuditReadResult => ({
      verification: { status, reason },
      entries: [],
      hasMore: false,
    });
    if (!auditBridgeToken || !auditAnchor) {
      return unavailable("unavailable", "bridge_or_anchor_unavailable");
    }
    let trustedCheckpoint: unknown;
    try {
      trustedCheckpoint = await auditAnchor.readTrustedCheckpoint();
    } catch (error) {
      if (error instanceof AuditAnchorError && error.code === "uninitialized") {
        return unavailable("unavailable", "no_trusted_anchor");
      }
      return unavailable("failed", "anchor_invalid");
    }
    const trusted = fieldsOf(trustedCheckpoint);
    const result = await sendAuditRequest("read", {
      trustedCheckpoint: trustedBridgePayload(trusted),
      afterSequence,
      limit,
    });
    const verificationValue = optionalFieldsOf(result)?.verification;
    if (!verificationValue) {
      return unavailable("failed", "audit_read_verification_failed");
    }
    const verification = fieldsOf(verificationValue);
    if (
      !VERIFIED_AUDIT_STATUSES.includes(verification.status) ||
      verification.anchoredThrough !== trusted.sequence ||
      verification.retentionThrough !==
        optionalFieldsOf(trusted.retention)?.through ||
      LEGACY_CUTOVER_FIELDS.some(
        (field) =>
          optionalFieldsOf(verification.legacyCutover)?.[field] !==
          fieldsOf(trusted.legacyCutover)[field],
      )
    ) {
      return unavailable("failed", "audit_read_verification_failed");
    }
    // Relational checks use Number(), which coerces exactly like `<=` does.
    const resultFields = fieldsOf(result);
    const { entries, hasMore } = resultFields;
    if (
      !isUnknownArray(entries) ||
      entries.length > limit ||
      typeof hasMore !== "boolean" ||
      entries.some((entry) => {
        const { sequence, anchorStatus } = fieldsOf(entry);
        return (
          typeof sequence !== "number" ||
          !Number.isSafeInteger(sequence) ||
          sequence <=
            Math.max(
              afterSequence,
              Number(optionalFieldsOf(trusted.retention)?.through ?? 0),
            ) ||
          sequence > Number(verification.sequence) ||
          anchorStatus !==
            (sequence <= Number(trusted.sequence)
              ? "anchored"
              : "pending_anchor")
        );
      })
    ) {
      return unavailable("failed", "invalid_audit_read_response");
    }
    const metadata = fieldsOf(trusted.metadata);
    return {
      ...resultFields,
      entries,
      hasMore,
      verification: {
        ...verification,
        ...(metadata.enrollmentSequence !== undefined
          ? { enrollmentSequence: metadata.enrollmentSequence }
          : {}),
      },
    };
  }

  async function verifyAuditHistory({
    forRestore = false,
    establishSession = false,
  }: {
    forRestore?: boolean;
    establishSession?: boolean;
  } = {}): Promise<AuditResult> {
    const establishing = establishSession && !auditSessionEstablished;
    const finish = (result: AuditResult): AuditResult => {
      if (establishing) auditSessionEstablished = true;
      return result;
    };
    if (!auditBridgeToken || !auditAnchor) {
      return finish({
        status: "unavailable",
        reason: "bridge_or_anchor_unavailable",
      });
    }
    let trusted: unknown;
    try {
      trusted = await auditAnchor.readTrustedCheckpoint();
      auditAnchorDetectedThisLaunch = true;
    } catch (error) {
      if (
        !(error instanceof AuditAnchorError) ||
        error.code !== "uninitialized"
      ) {
        auditAnchorDetectedThisLaunch = true;
        return finish({ status: "failed", reason: "anchor_invalid" });
      }
    }
    const result = fieldsOf(
      await sendAuditRequest(
        "verify",
        trusted
          ? {
              trustedCheckpoint: {
                ...trustedBridgePayload(fieldsOf(trusted)),
              },
            }
          : {},
      ),
    );
    if (trusted && result.status === "unavailable") {
      return finish({
        status: "failed",
        reason: "anchored_history_unavailable",
      });
    }
    if (result.status === "failed") return finish(result);
    if (
      trusted &&
      LEGACY_CUTOVER_FIELDS.some(
        (field) =>
          !Number.isSafeInteger(
            optionalFieldsOf(result.legacyCutover)?.[field],
          ) ||
          fieldsOf(result.legacyCutover)[field] !==
            fieldsOf(fieldsOf(trusted).legacyCutover)[field],
      )
    ) {
      return finish({ status: "failed", reason: "legacy_cutover_changed" });
    }
    if (!trusted) {
      if (
        forRestore ||
        !newClusterCreatedThisLaunch ||
        result.status !== "unavailable" ||
        typeof result.sequence !== "number" ||
        !Number.isSafeInteger(result.sequence) ||
        result.sequence < 0 ||
        !/^[0-9a-f]{64}$/.test(String(result.hash)) ||
        !result.legacyUnverified ||
        Object.values(result.legacyUnverified).some((count) => count !== "0")
      ) {
        return finish({ status: "unavailable", reason: "no_trusted_anchor" });
      }
      let metadata: unknown;
      try {
        metadata = await auditAnchor.initializeFirstCheckpoint(
          { sequence: result.sequence, hash: result.hash },
          result.legacyCutover,
        );
      } catch (error) {
        if (error instanceof AuditAnchorError) {
          return finish({ status: "unavailable", reason: error.code });
        }
        throw error;
      }
      await sendAuditRequest("checkpoint", checkpointBridgePayload(metadata));
      auditCheckpointMetadataSyncedThisLaunch = true;
      auditAnchorDetectedThisLaunch = true;
      auditEverTrustedThisLaunch = true;
      freshAuditReceiptId = fieldsOf(metadata).receiptId;
      if (establishing) auditLiveClosureEnabled = true;
      return finish({
        status: "verified",
        sequence: result.sequence,
        hash: result.hash,
      });
    }
    if (!VERIFIED_AUDIT_STATUSES.includes(result.status)) {
      return finish({
        status: "failed",
        reason: "unexpected_verification_status",
      });
    }
    if (
      establishing &&
      !forRestore &&
      !auditCheckpointMetadataSyncedThisLaunch
    ) {
      try {
        await sendAuditRequest(
          "checkpoint",
          checkpointBridgePayload(fieldsOf(trusted).metadata),
        );
        auditCheckpointMetadataSyncedThisLaunch = true;
      } catch {
        return finish({
          status: "failed",
          reason: "checkpoint_metadata_unavailable",
        });
      }
    }
    // A valid prefix does not make the unanchored tail independently trusted.
    // Never promote it to the external anchor during a later startup or restore.
    if (establishing && result.status === "verified") {
      auditLiveClosureEnabled = true;
      auditEverTrustedThisLaunch = true;
    }
    return finish(result);
  }

  async function enrollExistingAuditHistory(): Promise<AuditResult> {
    if (!auditBridgeToken || !auditAnchor) {
      return { status: "unavailable", reason: "bridge_or_anchor_unavailable" };
    }
    try {
      await auditAnchor.readTrustedCheckpoint();
      return { status: "unavailable", reason: "already_enrolled" };
    } catch (error) {
      if (
        !(error instanceof AuditAnchorError) ||
        error.code !== "uninitialized"
      ) {
        return { status: "failed", reason: "anchor_invalid" };
      }
    }
    // The operator explicitly accepts this internally consistent history as
    // the starting point. We cannot attest what happened before this moment.
    const result = optionalFieldsOf(await sendAuditRequest("verify", {}));
    if (
      result?.status !== "unavailable" ||
      typeof result.sequence !== "number" ||
      !Number.isSafeInteger(result.sequence) ||
      result.sequence < 0 ||
      !/^[0-9a-f]{64}$/.test(String(result.hash)) ||
      !result.legacyCutover
    ) {
      return { status: "failed", reason: "history_invalid" };
    }
    let metadata: unknown;
    try {
      metadata = await auditAnchor.initializeFirstCheckpoint(
        { sequence: result.sequence, hash: result.hash },
        result.legacyCutover,
        { enrollment: true },
      );
      await sendAuditRequest("checkpoint", checkpointBridgePayload(metadata));
      auditCheckpointMetadataSyncedThisLaunch = true;
    } catch {
      return { status: "failed", reason: "enrollment_incomplete" };
    }
    auditAnchorDetectedThisLaunch = true;
    const verified = await verifyAuditHistory({ establishSession: true });
    if (!VERIFIED_AUDIT_STATUSES.includes(verified.status)) {
      return { status: "failed", reason: "enrollment_verification_failed" };
    }
    auditLiveClosureEnabled = true;
    auditEverTrustedThisLaunch = true;
    return {
      status: verified.status,
      enrollmentSequence: fieldsOf(metadata).enrollmentSequence,
    };
  }

  async function exportProtectedAuditTransfer(
    password: unknown,
  ): Promise<Buffer> {
    if (!auditAnchor) throw new AuditAnchorError("uninitialized");
    const verified = await verifyAuditHistory();
    if (!VERIFIED_AUDIT_STATUSES.includes(verified.status)) {
      throw new AuditAnchorError("history_unverified");
    }
    if (verified.status === "partially_verified") {
      const closed = await closeAuditCheckpoint();
      if (closed.status !== "verified")
        throw new AuditAnchorError("history_unverified");
    }
    return auditAnchor.exportProtectedTransfer(password);
  }

  async function importProtectedAuditTransfer(
    contents: Buffer,
    password: unknown,
  ): Promise<{ sequence: unknown; hash: unknown }> {
    if (!auditAnchor || !newClusterCreatedThisLaunch || !freshAuditReceiptId) {
      throw new AuditAnchorError("transfer_target_not_fresh");
    }
    await pauseAuditClosure();
    try {
      const current = fieldsOf(await auditAnchor.readTrustedCheckpoint());
      if (
        fieldsOf(current.metadata).receiptId !== freshAuditReceiptId ||
        (await verifyAuditHistory()).status !== "verified"
      ) {
        throw new AuditAnchorError("transfer_target_not_fresh");
      }
      const metadata = fieldsOf(
        await auditAnchor.importProtectedTransfer(contents, password, {
          expectedCurrent: { sequence: current.sequence, hash: current.hash },
        }),
      );
      freshAuditReceiptId = undefined;
      endAuditSession();
      auditCheckpointMetadataSyncedThisLaunch = false;
      return { sequence: metadata.sequence, hash: metadata.headHash };
    } finally {
      resumeAuditClosure();
    }
  }

  async function rotateAuditKey(): Promise<{ sequence: unknown }> {
    if (!auditAnchor) throw new AuditAnchorError("uninitialized");
    const verified = await verifyAuditHistory();
    if (!VERIFIED_AUDIT_STATUSES.includes(verified.status)) {
      throw new AuditAnchorError("history_unverified");
    }
    if (verified.status === "partially_verified") {
      const closed = await closeAuditCheckpoint();
      if (closed.status !== "verified")
        throw new AuditAnchorError("history_unverified");
    }
    const metadata = await auditAnchor.rotateKey();
    freshAuditReceiptId = undefined;
    auditCheckpointMetadataSyncedThisLaunch = false;
    await sendAuditRequest("checkpoint", checkpointBridgePayload(metadata));
    auditCheckpointMetadataSyncedThisLaunch = true;
    return { sequence: fieldsOf(metadata).sequence };
  }

  async function runAuditRetentionIfDue(): Promise<AuditRetentionResult> {
    if (!auditAnchor || !auditBridgeToken || !auditLiveClosureEnabled) {
      return { status: "unavailable" };
    }
    if (auditRetentionPromise) return auditRetentionPromise;
    if (Date.now() - lastAuditRetentionAttempt < 24 * 60 * 60 * 1000) {
      return { status: "not_due" };
    }
    lastAuditRetentionAttempt = Date.now();
    auditRetentionPromise = (async (): Promise<AuditRetentionResult> => {
      let trusted = fieldsOf(await auditAnchor.readTrustedCheckpoint());
      if (trusted.retention) {
        await sendAuditRequest("retention-prune", {
          trustedCheckpoint: trustedBridgePayload(trusted),
        });
      }
      const plan = await sendAuditRequest("retention-plan", {
        trustedCheckpoint: trustedBridgePayload(trusted),
      });
      if (!optionalFieldsOf(plan)?.eligible) return { status: "nothing_due" };
      const metadata = await auditAnchor.persistRetentionBoundary(plan);
      auditCheckpointMetadataSyncedThisLaunch = false;
      await sendAuditRequest("checkpoint", checkpointBridgePayload(metadata));
      auditCheckpointMetadataSyncedThisLaunch = true;
      trusted = fieldsOf(await auditAnchor.readTrustedCheckpoint());
      const pruned = await sendAuditRequest("retention-prune", {
        trustedCheckpoint: trustedBridgePayload(trusted),
      });
      return { status: "pruned", removed: fieldsOf(pruned).removed };
    })();
    try {
      return await auditRetentionPromise;
    } catch (error) {
      lastAuditRetentionAttempt =
        Date.now() - 24 * 60 * 60 * 1000 + 5 * 60 * 1000;
      throw error;
    } finally {
      auditRetentionPromise = undefined;
    }
  }

  function auditClosureEnabled(): boolean {
    return auditLiveClosureEnabled;
  }

  async function auditRequiresAnchoredClosure(): Promise<boolean> {
    if (auditAnchorDetectedThisLaunch || auditEverTrustedThisLaunch)
      return true;
    if (!auditAnchor) return false;
    try {
      await auditAnchor.readTrustedCheckpoint();
      auditAnchorDetectedThisLaunch = true;
      return true;
    } catch (error) {
      if (error instanceof AuditAnchorError && error.code === "uninitialized") {
        return false;
      }
      auditAnchorDetectedThisLaunch = true;
      return true;
    }
  }

  function auditSessionPending(): boolean {
    return !auditSessionEstablished;
  }

  function endAuditSession(): void {
    auditLiveClosureEnabled = false;
    // A recovered backend must establish trust again at the exact external
    // checkpoint. A valid but unanchored tail still cannot start a session.
    auditSessionEstablished = false;
  }

  async function pauseAuditClosure(): Promise<void> {
    auditClosurePaused = true;
    await auditClosurePromise;
  }

  function resumeAuditClosure(): void {
    auditClosurePaused = false;
  }

  function closeAuditCheckpoint(): Promise<AuditResult> {
    const closure = auditClosurePromise.then(async (): Promise<AuditResult> => {
      if (!auditLiveClosureEnabled || auditClosurePaused) {
        return { status: "unavailable", reason: "live_closure_not_active" };
      }
      try {
        const result = await verifyAuditHistory();
        if (result.status === "verified") return result;
        if (result.status !== "partially_verified") {
          auditLiveClosureEnabled = false;
          return result;
        }
        // Partial verification implies an anchor; mirror `undefined.x` otherwise.
        if (!auditAnchor) throw new TypeError("Native audit anchor is missing");
        const metadata = await auditAnchor.persistCheckpoint({
          sequence: result.sequence,
          hash: result.hash,
        });
        await sendAuditRequest("checkpoint", checkpointBridgePayload(metadata));
        auditCheckpointMetadataSyncedThisLaunch = true;
        return { ...result, status: "verified" };
      } catch (error) {
        endAuditSession();
        throw error;
      }
    });
    auditClosurePromise = closure.catch(() => {});
    return closure;
  }

  async function assertRestoredAuditHistory({
    allowUnverifiedAudit = false,
  }: { allowUnverifiedAudit?: boolean } = {}): Promise<AuditResult> {
    if (allowUnverifiedAudit) {
      // Explicit recovery verifies the restored chain independently. An older
      // backup cannot contain the current trusted checkpoint, so it must not
      // be enrolled or used to lower the external receipt.
      const candidate = fieldsOf(await sendAuditRequest("verify", {}));
      if (
        candidate.status !== "unavailable" ||
        typeof candidate.sequence !== "number" ||
        !Number.isSafeInteger(candidate.sequence) ||
        candidate.sequence < 0 ||
        !/^[0-9a-f]{64}$/.test(String(candidate.hash))
      ) {
        const error: NativeRuntimeError = new Error(
          "Restored database audit chain is invalid",
        );
        error.code = "RESTORED_AUDIT_RECOVERY_INVALID";
        throw error;
      }
      endAuditSession();
      return { status: "unavailable", reason: "explicit_recovery" };
    }
    let result: AuditResult;
    try {
      result = await verifyAuditHistory({ forRestore: true });
    } catch {
      const error: NativeRuntimeError = new Error(
        "Restored database audit verification is unavailable",
      );
      error.code = "RESTORED_AUDIT_INTEGRITY_UNAVAILABLE";
      error.auditStatus = "unavailable";
      error.auditReason = "bridge_unavailable";
      throw error;
    }
    if (result.status !== "verified") {
      const error: NativeRuntimeError = new Error(
        result.status === "failed"
          ? "Restored database failed the trusted audit integrity check"
          : "Restored database cannot be verified against the trusted audit checkpoint",
      );
      error.code =
        result.status === "failed"
          ? "RESTORED_AUDIT_INTEGRITY_FAILED"
          : "RESTORED_AUDIT_INTEGRITY_UNAVAILABLE";
      error.auditStatus = result.status;
      error.auditReason = result.reason;
      throw error;
    }
    return result;
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
      const error: NativeRuntimeError = new Error(
        "The recorded backend process id belongs to another process; refusing to signal it.",
      );
      error.code = "BACKEND_PID_OWNERSHIP_MISMATCH";
      throw error;
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

  async function stopPostgres(): Promise<{
    status: "stopped" | "external-not-managed";
    service: "postgres";
  }> {
    const clusterExists = await fs.promises
      .access(path.join(paths.postgresData, "PG_VERSION"))
      .then(() => true)
      .catch(() => false);
    if (!clusterExists) {
      await fs.promises.unlink(paths.postgresPid).catch(() => {});
      return { status: "stopped", service: "postgres" };
    }
    if (!tools) await discover();
    if (!requireTools().managed)
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
        path.join(requireTools().binDir, "pg_ctl"),
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

  async function stop({
    forceAfterMs = 10_000,
    keepPostgres = false,
  }: { forceAfterMs?: number; keepPostgres?: boolean } = {}) {
    const backend = await stopBackend({ forceAfterMs });
    const postgres = keepPostgres ? undefined : await stopPostgres();
    return { status: "stopped", backend, postgres };
  }

  async function restart(): Promise<StartResult> {
    await stop({ keepPostgres: true });
    return start();
  }

  async function getSchemaHead({
    database = undefined,
  }: { database?: string | undefined } = {}): Promise<string> {
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
      async (env) =>
        (await readSchemaLedger(targetDatabase, config, env, 10_000)).head ||
        "",
    );
  }

  async function readSchemaLedger(
    database: string,
    config: NativeDatabaseConfig,
    env: ChildEnv,
    timeout: number,
  ): Promise<{ head: string | undefined; hasAlembicVersion: boolean }> {
    const query = (command: string) =>
      runFile(
        path.join(requireTools().binDir, "psql"),
        [
          "-h",
          LOOPBACK_HOST,
          "-p",
          String(config.port),
          "-U",
          config.ownerRole,
          "-d",
          database,
          "--tuples-only",
          "--no-align",
          "--no-psqlrc",
          "--set",
          "ON_ERROR_STOP=1",
          "--command",
          command,
        ],
        { timeout, env },
      ).then((result) => result.stdout.trim());
    const [hasKysely, hasAlembic] = (await query(SCHEMA_LEDGER_SQL)).split("|");
    const head =
      hasKysely === "t"
        ? (await query(SCHEMA_HEAD_SQL)) || undefined
        : undefined;
    return { head, hasAlembicVersion: hasAlembic === "t" };
  }

  async function adminDatabasePsql(
    database: string,
    command: string,
    timeout = 30_000,
  ): Promise<RunFileResult> {
    if (!tools) await discover();
    const config = await ensureLayout();
    const target = validateIdentifier(database, "database name");
    return runAsClusterAdmin(
      config,
      path.join(requireTools().binDir, "psql"),
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

  async function adminPsql(
    command: string,
    timeout = 30_000,
  ): Promise<RunFileResult> {
    return adminDatabasePsql("postgres", command, timeout);
  }

  async function terminateDatabaseConnections(database: string): Promise<void> {
    const name = validateIdentifier(database, "database name");
    await adminPsql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid();`,
    );
  }

  async function databaseExists(database: string): Promise<boolean> {
    const name = validateIdentifier(database, "database name");
    const result = await adminPsql(
      `SELECT 1 FROM pg_database WHERE datname = '${name}';`,
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .includes("1");
  }

  function restoreDatabaseName(base: string, suffix: string): string {
    const nonce = crypto.randomBytes(5).toString("hex");
    return validateIdentifier(
      `${base.slice(0, 40)}_${suffix}_${nonce}`,
      "temporary database name",
    );
  }

  async function createEmptyDatabase(
    database: string,
    ownerRole: string,
  ): Promise<void> {
    const config = await ensureLayout();
    const name = validateIdentifier(database, "database name");
    const owner = validateIdentifier(ownerRole, "owner role");
    await runAsClusterAdmin(
      config,
      path.join(requireTools().binDir, "createdb"),
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

  async function restoreIntoDatabase(
    sourcePath: string,
    database: string,
    format: string,
    config: NativeDatabaseConfig,
  ): Promise<void> {
    const source = path.resolve(sourcePath);
    const stat = await fs.promises.stat(source);
    if (!stat.isFile() || stat.size <= 0)
      throw new Error("PostgreSQL restore source is empty or not a file");
    const target = validateIdentifier(database, "database name");
    // A staging database is created from template0, so it does not inherit the
    // extensions installed in the live database. Install them with the same
    // least-privilege boundary before replaying application-owned objects.
    await installRequiredExtensions(target, config);
    await withPgPass(
      config,
      config.ownerRole,
      config.ownerPassword,
      async (env) => {
        if (format === "custom") {
          await runFile(
            path.join(requireTools().binDir, "pg_restore"),
            [
              "--exit-on-error",
              "--single-transaction",
              "--no-owner",
              "--no-acl",
              "--no-comments",
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
          path.join(requireTools().binDir, "psql"),
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
    // migration role. These two materialized views are the narrow exception:
    // the runtime service creates, indexes, refreshes, and ANALYZEs them, so the
    // least-privilege application role must own only these derived objects.
    await adminDatabasePsql(
      target,
      materializedViewOwnershipSql(config.appRole),
    );
  }

  async function validateRestoredDatabase(
    database: string,
    config: NativeDatabaseConfig,
    expectedSchemaHead: string | undefined,
  ): Promise<{ schemaHead: string; tableCount: number }> {
    const target = validateIdentifier(database, "database name");
    return withPgPass(
      config,
      config.ownerRole,
      config.ownerPassword,
      async (env) => {
        const result = await runFile(
          path.join(requireTools().binDir, "psql"),
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
            "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';",
          ],
          { timeout: 30_000, env },
        );
        const tableCount = Number(result.stdout.trim());
        if (!Number.isInteger(tableCount) || tableCount <= 0)
          throw new Error("Restored database has no public schema tables");
        const ledger = await readSchemaLedger(target, config, env, 30_000);
        if (!ledger.head || ledger.hasAlembicVersion)
          throw preBaselineBackupError();
        if (expectedSchemaHead && ledger.head !== expectedSchemaHead.trim()) {
          throw new Error(
            "Restored database schema revision does not match backup metadata",
          );
        }
        return { schemaHead: ledger.head, tableCount };
      },
    );
  }

  async function activateRestoredDatabase(
    sourcePath: string,
    {
      format = "plain",
      expectedSchemaHead = undefined,
    }: { format?: string; expectedSchemaHead?: string | undefined } = {},
  ): Promise<{
    switchToken: DatabaseSwitchToken;
    validation: { schemaHead: string; tableCount: number };
  }> {
    await assertNativeActive();
    const config = await bootstrapDatabase();
    const stagingDatabase = restoreDatabaseName(config.database, "restore");
    const previousDatabase = restoreDatabaseName(config.database, "previous");
    let switchToken: DatabaseSwitchToken | undefined;
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
      restoreSwitchOwnedThisLaunch = true;
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
          restoreSwitchOwnedThisLaunch = false;
          startupRestoreRecovery = undefined;
          const recoveryError: NativeRuntimeError = new Error(
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

  async function validateCustomDump(
    sourcePath: string,
  ): Promise<{ bytes: number }> {
    if (!tools) await discover();
    const source = path.resolve(sourcePath);
    const stat = await fs.promises.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      const error: NativeRuntimeError = new Error(
        "PostgreSQL custom dump is empty or not a file",
      );
      error.code = "INVALID_POSTGRES_DUMP";
      throw error;
    }
    try {
      await runFile(
        path.join(requireTools().binDir, "pg_restore"),
        ["--list", source],
        {
          timeout: 60_000,
        },
      );
    } catch (cause) {
      const error: NativeRuntimeError = new Error(
        "PostgreSQL custom dump is corrupt or truncated",
      );
      error.code = "INVALID_POSTGRES_DUMP";
      error.cause = cause;
      throw error;
    }
    return { bytes: stat.size };
  }

  async function getDatabaseStats({
    database = undefined,
  }: { database?: string | undefined } = {}): Promise<DatabaseStats> {
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
          path.join(requireTools().binDir, "psql"),
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

  async function applyOwnerSqlFile(
    sourcePath: string,
    { database = undefined }: { database?: string | undefined } = {},
  ): Promise<{ status: "applied"; database: string; bytes: number }> {
    const source = path.resolve(sourcePath);
    const stat = await fs.promises.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      const error: NativeRuntimeError = new Error(
        "PostgreSQL seed source is empty or not a file",
      );
      error.code = "INVALID_POSTGRES_SEED";
      throw error;
    }
    const config = await bootstrapDatabase();
    const target = validateIdentifier(
      database || config.database,
      "database name",
    );
    await withPgPass(
      config,
      config.ownerRole,
      config.ownerPassword,
      async (env) => {
        await runFile(
          path.join(requireTools().binDir, "psql"),
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
    return { status: "applied", database: target, bytes: stat.size };
  }

  async function rollbackDatabaseSwitch(switchToken?: unknown): Promise<{
    status: "rolled-back";
    preservedFailedDatabase: string | undefined;
  }> {
    const config = await ensureLayout();
    const token = switchToken || (await readState())?.pendingDatabaseSwitch;
    if (!token || fieldsOf(token).liveDatabase !== config.database)
      throw new Error("No matching native database switch is available");
    const { previousDatabase, activatedDatabase } = fieldsOf(token);
    const previous = validateIdentifier(
      previousDatabase,
      "previous database name",
    );
    const activated = validateIdentifier(
      activatedDatabase,
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
    restoreSwitchOwnedThisLaunch = false;
    startupRestoreRecovery = undefined;
    return { status: "rolled-back", preservedFailedDatabase };
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
    await writeState({
      pendingDatabaseSwitch: undefined,
      previousDatabase: fieldsOf(token).previousDatabase,
      lastDatabaseSwitchAt: new Date().toISOString(),
    });
    restoreSwitchOwnedThisLaunch = false;
    startupRestoreRecovery = undefined;
    return {
      status: "finalized",
      previousDatabase: fieldsOf(token).previousDatabase,
    };
  }

  async function dumpDatabase(
    destination: string,
    {
      format = "plain",
      database = undefined,
    }: { format?: string; database?: string | undefined } = {},
  ): Promise<{ path: string; format: string; bytes: number }> {
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
          path.join(requireTools().binDir, "pg_dump"),
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
            "--no-comments",
            ...REQUIRED_POSTGRES_EXTENSIONS.flatMap((extension) => [
              "--exclude-extension",
              extension,
            ]),
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
          path.join(requireTools().binDir, "pg_restore"),
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
    switchToken: unknown = undefined,
  ): Promise<DirectoryRollbackResult> {
    const token = switchToken || (await readState())?.pendingAttachmentSwitch;
    const result = await rollbackDirectorySwitch(token);
    await writeState({ pendingAttachmentSwitch: undefined });
    return result;
  }

  async function finalizeAttachmentSwitch(
    switchToken: unknown = undefined,
  ): Promise<DirectoryFinalizeResult> {
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
    recoverInterruptedRestore,
    bootstrapDatabase,
    assertNativeActive,
    readState,
    writeState,
    start,
    verifyAuditHistory,
    enrollExistingAuditHistory,
    exportProtectedAuditTransfer,
    importProtectedAuditTransfer,
    rotateAuditKey,
    runAuditRetentionIfDue,
    readVerifiedAuditEntries,
    recordAuditUpdateDecision,
    assertRestoredAuditHistory,
    auditClosureEnabled,
    auditRequiresAnchoredClosure,
    auditSessionPending,
    endAuditSession,
    closeAuditCheckpoint,
    pauseAuditClosure,
    resumeAuditClosure,
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
    applyOwnerSqlFile,
  });
}
