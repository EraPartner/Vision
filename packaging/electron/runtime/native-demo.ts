import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertDatabaseStatsEqual,
  assertStableDatabaseStatsEqual,
} from "./database-stats";
import type {
  ComparableDatabaseStats,
  ImportantRowCounts,
} from "./database-stats";

export const DEMO_RUNTIME_ID = "vision_demo";
export const DEMO_POSTGRES_PORT = 54330;
export const DEMO_USER_DATA_NAME = "Vision Demo";
export const DEMO_RESET_REQUEST = "demo-reset-request.json";

/**
 * Database statistics recorded in the packaged seed manifest. Only the fields
 * validateDemoSeedManifest checks are guaranteed; database-stats compares the
 * rest value by value, so a mistyped field fails as a mismatch.
 */
export type DemoSeedDatabase = ComparableDatabaseStats & {
  readonly importantRowCounts?: Readonly<ImportantRowCounts>;
};

export interface DemoSeedManifest {
  version: 1;
  logicalSha256: string;
  dumpSha256: string;
  schemaRevision: string;
  database: DemoSeedDatabase;
  [key: string]: unknown;
}

export interface DemoSeed {
  dumpPath: string;
  manifest: DemoSeedManifest;
}

/** The part of the native runtime that Demo seeding drives. */
export interface NativeDemoRuntime {
  runtimeId: string;
  paths: { nativeRoot: string };
  ensureLayout(): Promise<unknown>;
  discover(): Promise<unknown>;
  readState(): Promise<unknown>;
  writeState(next: Record<string, unknown>): Promise<unknown>;
  ensurePostgresReady(): Promise<unknown>;
  rollbackDatabaseSwitch(switchToken: unknown): Promise<unknown>;
  validateCustomDump(sourcePath: string): Promise<unknown>;
  activateRestoredDatabase(
    sourcePath: string,
    options: { format: "custom"; expectedSchemaHead: string },
  ): Promise<{ switchToken: unknown }>;
  getDatabaseStats(): Promise<ComparableDatabaseStats>;
  finalizeDatabaseSwitch(switchToken: unknown): Promise<unknown>;
  stop(options: { keepPostgres: boolean }): Promise<unknown>;
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
function fieldsOf(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : undefined;
}

function isSha256(value: unknown): boolean {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function hasDemoSeedManifestShape(value: unknown): value is DemoSeedManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const manifest = value as UnknownRecord;
  if (
    manifest.version !== 1 ||
    !isSha256(manifest.logicalSha256) ||
    !isSha256(manifest.dumpSha256) ||
    typeof manifest.schemaRevision !== "string" ||
    !manifest.schemaRevision.trim()
  ) {
    return false;
  }
  const database = fieldsOf(manifest.database);
  return (
    database !== undefined &&
    !!database.tableCounts &&
    Object.keys(database.tableCounts).length > 0
  );
}

export function validateDemoSeedManifest(value: unknown): DemoSeedManifest {
  if (!hasDemoSeedManifestShape(value)) {
    throw demoError(
      "Packaged Demo seed manifest is invalid",
      "DEMO_SEED_MANIFEST_INVALID",
    );
  }
  if (value.database.schema !== value.schemaRevision) {
    throw demoError(
      "Packaged Demo seed schema metadata is inconsistent",
      "DEMO_SEED_MANIFEST_INVALID",
    );
  }
  return value;
}

export function comparableManifestStats(
  database: DemoSeedDatabase,
): ComparableDatabaseStats {
  return { ...database, ...(database.importantRowCounts || {}) };
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
  if (path.basename(userDataDir) !== DEMO_USER_DATA_NAME) {
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
  try {
    const stat = await fs.promises.lstat(requestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw demoError(
        "Native Demo reset request is unsafe",
        "DEMO_RESET_UNSAFE",
      );
    }
    const request: unknown = JSON.parse(
      await fs.promises.readFile(requestPath, "utf8"),
    );
    if (fieldsOf(request)?.version !== 1) {
      throw demoError(
        "Native Demo reset request is invalid",
        "DEMO_RESET_INVALID",
      );
    }
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
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
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export async function loadDemoSeed(seedRoot: string): Promise<DemoSeed> {
  const root = path.resolve(seedRoot);
  const dumpPath = path.join(root, "demo-seed.dump");
  const manifestPath = path.join(root, "manifest.json");
  for (const candidate of [dumpPath, manifestPath]) {
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
  if ((await sha256File(dumpPath)) !== manifest.dumpSha256) {
    throw demoError(
      "Packaged Demo seed checksum does not match",
      "DEMO_SEED_CHECKSUM_MISMATCH",
    );
  }
  return { dumpPath, manifest };
}

async function readRuntimeState(
  runtime: NativeDemoRuntime,
): Promise<UnknownRecord> {
  return fieldsOf(await runtime.readState()) || {};
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
  let state = await readRuntimeState(runtime);
  if (state.pendingDatabaseSwitch) {
    await runtime.ensurePostgresReady();
    await runtime.rollbackDatabaseSwitch(state.pendingDatabaseSwitch);
    state = await readRuntimeState(runtime);
  }
  const currentSeed = fieldsOf(state.demoSeed);
  if (
    !resetRequested &&
    currentSeed?.logicalSha256 === seed.manifest.logicalSha256 &&
    currentSeed?.schemaRevision === seed.manifest.schemaRevision
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
      schemaRevision: seed.manifest.schemaRevision,
      startedAt: new Date().toISOString(),
    },
  });
  await runtime.validateCustomDump(seed.dumpPath);
  const activation = await runtime.activateRestoredDatabase(seed.dumpPath, {
    format: "custom",
    expectedSchemaHead: seed.manifest.schemaRevision,
  });
  const restored = await runtime.getDatabaseStats();
  try {
    assertDatabaseStatsEqual(
      comparableManifestStats(seed.manifest.database),
      restored,
    );
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
): Promise<{ status: "ready"; seed: string; resetCleanupWarning?: string }> {
  if (!prepared || !prepared.manifest) {
    throw new Error("Native Demo preparation result is missing");
  }
  if (prepared.switchToken) {
    const afterStart = await runtime.getDatabaseStats();
    assertStableDatabaseStatsEqual(
      comparableManifestStats(prepared.manifest.database),
      afterStart,
    );
    await runtime.finalizeDatabaseSwitch(prepared.switchToken);
  }
  await runtime.writeState({
    activeRuntime: "native",
    activation: "demo-native",
    demoSeedInProgress: undefined,
    demoSeed: {
      logicalSha256: prepared.manifest.logicalSha256,
      schemaRevision: prepared.manifest.schemaRevision,
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
  await runtime.stop({ keepPostgres: true }).catch(() => {});
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
