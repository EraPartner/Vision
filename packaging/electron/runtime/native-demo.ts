import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STABLE_TABLES, assertTableCountsEqual } from "./database-stats";

export const DEMO_RUNTIME_ID = "vision_demo";
export const DEMO_USER_DATA_NAME = "Vision Demo";
export const DEMO_RESET_REQUEST = "demo-reset-request.json";
/** The packaged Demo database: migrated to the build's head and loaded with the seed. */
export const DEMO_SEED_DATABASE = "vision-demo.sqlite3";
export const DEMO_SEED_MANIFEST = "manifest.json";

/** Rows per table in the packaged Demo database, as the database tool counted them. */
export interface DemoSeedDatabase {
  readonly tableCounts: Readonly<Record<string, number>>;
  readonly [key: string]: unknown;
}

export interface DemoSeedManifest {
  version: 2;
  format: "sqlite";
  /** Hash of the generated seed SQL: identifies the Demo content across builds. */
  logicalSha256: string;
  /** Hash of the packaged database file. */
  databaseSha256: string;
  databaseBytes: number;
  /** Migration version the packaged database is at. */
  schemaVersion: number;
  database: DemoSeedDatabase;
  [key: string]: unknown;
}

export interface DemoSeed {
  databasePath: string;
  manifest: DemoSeedManifest;
}

/** What the runtime's database tool reports about a database file. */
export interface DemoDatabaseReport {
  schemaVersion: number;
  sha256?: string | undefined;
  tableCounts?: Readonly<Record<string, number>> | undefined;
}

/** The part of the native runtime that Demo seeding drives. */
export interface NativeDemoRuntime {
  runtimeId: string;
  paths: { nativeRoot: string; database: string };
  ensureLayout(): Promise<unknown>;
  discover(): Promise<unknown>;
  readState(): Promise<unknown>;
  writeState(next: Record<string, unknown>): Promise<unknown>;
  recoverInterruptedRestore(): Promise<void>;
  rollbackDatabaseSwitch(switchToken: unknown): Promise<unknown>;
  activateRestoredDatabase(
    sourcePath: string,
    options: { expectedSchemaVersion: number; expectedSha256: string },
  ): Promise<{ switchToken: unknown }>;
  verifyDatabaseFile(file: string): Promise<DemoDatabaseReport>;
  finalizeDatabaseSwitch(switchToken: unknown): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface PreparedNativeDemo {
  status: "current" | "activated";
  manifest: DemoSeedManifest;
  previousDemoSeed?: unknown;
  resetRequested: boolean;
  switchToken?: unknown;
}

type UnknownRecord = Record<string, unknown>;

function demoError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

// Property reads on a parsed JSON value: non-objects carry no fields.
function isObjectValue(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function fieldsOf(value: unknown): UnknownRecord | undefined {
  return isObjectValue(value) ? value : undefined;
}

function isSha256(value: unknown): boolean {
  return /^[a-f0-9]{64}$/.test(typeof value === "string" ? value : "");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasDemoSeedManifestShape(value: unknown): value is DemoSeedManifest {
  if (!isObjectValue(value) || Array.isArray(value)) {
    return false;
  }
  const manifest = value;
  if (
    manifest.version !== 2 ||
    manifest.format !== "sqlite" ||
    !isSha256(manifest.logicalSha256) ||
    !isSha256(manifest.databaseSha256) ||
    !isCount(manifest.databaseBytes) ||
    manifest.databaseBytes === 0 ||
    !isCount(manifest.schemaVersion) ||
    manifest.schemaVersion === 0
  ) {
    return false;
  }
  const tableCounts = fieldsOf(fieldsOf(manifest.database)?.tableCounts);
  return (
    tableCounts !== undefined &&
    !Array.isArray(tableCounts) &&
    Object.keys(tableCounts).length > 0 &&
    Object.values(tableCounts).every(isCount)
  );
}

export function validateDemoSeedManifest(value: unknown): DemoSeedManifest {
  if (!hasDemoSeedManifestShape(value)) {
    throw demoError(
      "Packaged Demo seed manifest is invalid",
      "DEMO_SEED_MANIFEST_INVALID",
    );
  }
  return value;
}

export function assertDemoRuntimeIsolation(
  runtime: Pick<NativeDemoRuntime, "runtimeId" | "paths"> | null | undefined,
): string {
  if (runtime?.runtimeId !== DEMO_RUNTIME_ID) {
    throw demoError(
      "Native Demo seeding requires the Demo runtime id",
      "DEMO_RUNTIME_UNSAFE",
    );
  }
  const userDataDir = path.dirname(path.dirname(runtime.paths.nativeRoot));
  if (
    path.basename(userDataDir) !== DEMO_USER_DATA_NAME ||
    path.dirname(path.dirname(runtime.paths.database)) !== userDataDir
  ) {
    throw demoError(
      "Native Demo seeding is restricted to the Vision Demo data directory",
      "DEMO_RUNTIME_UNSAFE",
    );
  }
  return userDataDir;
}

export function demoResetRequestPath(
  runtime: Pick<NativeDemoRuntime, "runtimeId" | "paths"> | null | undefined,
): string {
  return path.join(assertDemoRuntimeIsolation(runtime), DEMO_RESET_REQUEST);
}

async function hasDemoResetRequest(
  runtime: NativeDemoRuntime,
): Promise<boolean> {
  const requestPath = demoResetRequestPath(runtime);
  const unsafe = () =>
    demoError("Native Demo reset request is unsafe", "DEMO_RESET_UNSAFE");
  let handle: fs.promises.FileHandle;
  try {
    // Check and read the same open file, so a swap after the check cannot be read.
    // O_NONBLOCK keeps a FIFO planted at the path from blocking the open.
    handle = await fs.promises.open(
      requestPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    if (errorCode(error) === "ELOOP") throw unsafe();
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw unsafe();
    const request: unknown = JSON.parse(await handle.readFile("utf8"));
    if (fieldsOf(request)?.version !== 1) {
      throw demoError(
        "Native Demo reset request is invalid",
        "DEMO_RESET_INVALID",
      );
    }
    return true;
  } finally {
    await handle.close();
  }
}

export async function requestNativeDemoReset(
  userDataDir: string,
): Promise<{ status: "requested"; path: string }> {
  const root = path.resolve(userDataDir);
  if (path.basename(root) !== DEMO_USER_DATA_NAME) {
    throw demoError(
      "Native Demo reset is restricted to the Vision Demo data directory",
      "DEMO_RUNTIME_UNSAFE",
    );
  }
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, DEMO_RESET_REQUEST);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(
    temporary,
    `${JSON.stringify({ version: 1, requestedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  await fs.promises.rename(temporary, target);
  return { status: "requested", path: target };
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream: AsyncIterable<Buffer> = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export async function loadDemoSeed(seedRoot: string): Promise<DemoSeed> {
  const root = path.resolve(seedRoot);
  const databasePath = path.join(root, DEMO_SEED_DATABASE);
  const manifestPath = path.join(root, DEMO_SEED_MANIFEST);
  for (const candidate of [databasePath, manifestPath]) {
    const stat = await fs.promises.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw demoError(
        "Packaged Demo seed contains an unsafe file",
        "DEMO_SEED_UNSAFE",
      );
    }
  }
  const manifest = validateDemoSeedManifest(
    JSON.parse(await fs.promises.readFile(manifestPath, "utf8")),
  );
  if ((await sha256File(databasePath)) !== manifest.databaseSha256) {
    throw demoError(
      "Packaged Demo seed checksum does not match",
      "DEMO_SEED_CHECKSUM_MISMATCH",
    );
  }
  return { databasePath, manifest };
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readRuntimeState(
  runtime: NativeDemoRuntime,
): Promise<UnknownRecord> {
  return fieldsOf(await runtime.readState()) ?? {};
}

export async function prepareNativeDemo(
  runtime: NativeDemoRuntime,
  { seedRoot, reset = false }: { seedRoot: string; reset?: boolean },
): Promise<PreparedNativeDemo> {
  assertDemoRuntimeIsolation(runtime);
  const seed = await loadDemoSeed(seedRoot);
  const resetRequested = reset || (await hasDemoResetRequest(runtime));
  await runtime.ensureLayout();
  await runtime.discover();
  // Recover both generations before deciding whether the seed is current.
  // Database-only rollback would leave new attachments against the old data.
  await runtime.recoverInterruptedRestore();
  const state = await readRuntimeState(runtime);
  const currentSeed = fieldsOf(state.demoSeed);
  if (
    !resetRequested &&
    currentSeed?.logicalSha256 === seed.manifest.logicalSha256 &&
    currentSeed.databaseSha256 === seed.manifest.databaseSha256 &&
    currentSeed.schemaVersion === seed.manifest.schemaVersion &&
    (await pathExists(runtime.paths.database))
  ) {
    await runtime.writeState({
      activeRuntime: "native",
      activation: "demo-native",
      demoSeedInProgress: undefined,
    });
    return { status: "current", manifest: seed.manifest, resetRequested };
  }

  await runtime.writeState({
    activeRuntime: "native",
    activation: "demo-native",
    demoSeedInProgress: {
      logicalSha256: seed.manifest.logicalSha256,
      databaseSha256: seed.manifest.databaseSha256,
      schemaVersion: seed.manifest.schemaVersion,
      startedAt: new Date().toISOString(),
    },
  });
  // Activation copies and verifies the seed (integrity, foreign keys, ledger)
  // and refuses it unless its checksum and schema version match the manifest.
  const activation = await runtime.activateRestoredDatabase(seed.databasePath, {
    expectedSchemaVersion: seed.manifest.schemaVersion,
    expectedSha256: seed.manifest.databaseSha256,
  });
  try {
    if ((await sha256File(runtime.paths.database)) !== seed.manifest.databaseSha256) {
      throw demoError(
        "The activated Demo database does not match the packaged seed",
        "DEMO_SEED_CHECKSUM_MISMATCH",
      );
    }
  } catch (error) {
    await runtime.rollbackDatabaseSwitch(activation.switchToken);
    throw error;
  }
  return {
    status: "activated",
    manifest: seed.manifest,
    previousDemoSeed: state.demoSeed,
    resetRequested,
    switchToken: activation.switchToken,
  };
}

export async function finalizeNativeDemo(
  runtime: NativeDemoRuntime,
  prepared: PreparedNativeDemo | null | undefined,
): Promise<{
  status: "ready";
  seed: string;
  resetCleanupWarning?: string | undefined;
}> {
  if (!prepared) {
    throw new Error("Native Demo preparation result is missing");
  }
  if (prepared.switchToken) {
    // The backend has started (and migrated, if this build is newer than the
    // seed); the Demo data it serves must still be the seed's.
    const afterStart = await runtime.verifyDatabaseFile(runtime.paths.database);
    if (afterStart.schemaVersion < prepared.manifest.schemaVersion) {
      throw demoError(
        "The Demo database schema moved backwards after startup",
        "DATABASE_SCHEMA_MISMATCH",
      );
    }
    if (afterStart.tableCounts) {
      assertTableCountsEqual(
        prepared.manifest.database.tableCounts,
        afterStart.tableCounts,
        { tables: STABLE_TABLES },
      );
    }
    await runtime.finalizeDatabaseSwitch(prepared.switchToken);
  }
  await runtime.writeState({
    activeRuntime: "native",
    activation: "demo-native",
    demoSeedInProgress: undefined,
    demoSeed: {
      logicalSha256: prepared.manifest.logicalSha256,
      databaseSha256: prepared.manifest.databaseSha256,
      schemaVersion: prepared.manifest.schemaVersion,
      appliedAt: new Date().toISOString(),
    },
  });
  let resetCleanupWarning: string | undefined;
  if (prepared.resetRequested) {
    try {
      await fs.promises.unlink(demoResetRequestPath(runtime));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        resetCleanupWarning =
          "The Demo database is ready, but its reset request could not be removed; the next launch may repeat the reset.";
      }
    }
  }
  return {
    status: "ready",
    seed: prepared.manifest.logicalSha256,
    resetCleanupWarning,
  };
}

export async function rollbackNativeDemo(
  runtime: NativeDemoRuntime,
  prepared: PreparedNativeDemo | null | undefined,
): Promise<{ status: "rolled-back" }> {
  await runtime.stop().catch(() => {});
  if (prepared?.switchToken) {
    await runtime.rollbackDatabaseSwitch(prepared.switchToken);
  }
  await runtime.writeState({
    activeRuntime: "native",
    activation: "demo-native",
    demoSeed: prepared?.previousDemoSeed,
    demoSeedInProgress: undefined,
    lastDemoSeedFailureAt: new Date().toISOString(),
  });
  return { status: "rolled-back" };
}
