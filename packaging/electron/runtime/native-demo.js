"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertDatabaseStatsEqual,
  assertStableDatabaseStatsEqual,
} = require("./database-stats");

const DEMO_RUNTIME_ID = "vision_demo";
const DEMO_POSTGRES_PORT = 54330;
const DEMO_USER_DATA_NAME = "Vision Demo";
const DEMO_RESET_REQUEST = "demo-reset-request.json";

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function validateDemoSeedManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    !isSha256(value.logicalSha256) ||
    !isSha256(value.dumpSha256) ||
    typeof value.schemaRevision !== "string" ||
    !value.schemaRevision.trim() ||
    !value.database ||
    typeof value.database !== "object" ||
    !value.database.tableCounts ||
    Object.keys(value.database.tableCounts).length === 0
  ) {
    const error = new Error("Packaged Demo seed manifest is invalid");
    error.code = "DEMO_SEED_MANIFEST_INVALID";
    throw error;
  }
  if (value.database.schema !== value.schemaRevision) {
    const error = new Error(
      "Packaged Demo seed schema metadata is inconsistent",
    );
    error.code = "DEMO_SEED_MANIFEST_INVALID";
    throw error;
  }
  return value;
}

function comparableManifestStats(database) {
  return { ...database, ...(database.importantRowCounts || {}) };
}

function assertDemoRuntimeIsolation(runtime) {
  if (runtime?.runtimeId !== DEMO_RUNTIME_ID) {
    const error = new Error("Native Demo seeding requires the Demo runtime id");
    error.code = "DEMO_RUNTIME_UNSAFE";
    throw error;
  }
  const userDataDir = path.dirname(path.dirname(runtime.paths.nativeRoot));
  if (path.basename(userDataDir) !== DEMO_USER_DATA_NAME) {
    const error = new Error(
      "Native Demo seeding is restricted to the Vision Demo data directory",
    );
    error.code = "DEMO_RUNTIME_UNSAFE";
    throw error;
  }
  return userDataDir;
}

function demoResetRequestPath(runtime) {
  return path.join(assertDemoRuntimeIsolation(runtime), DEMO_RESET_REQUEST);
}

async function hasDemoResetRequest(runtime) {
  const requestPath = demoResetRequestPath(runtime);
  try {
    const stat = await fs.promises.lstat(requestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      const error = new Error("Native Demo reset request is unsafe");
      error.code = "DEMO_RESET_UNSAFE";
      throw error;
    }
    const request = JSON.parse(await fs.promises.readFile(requestPath, "utf8"));
    if (request?.version !== 1) {
      const error = new Error("Native Demo reset request is invalid");
      error.code = "DEMO_RESET_INVALID";
      throw error;
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function requestNativeDemoReset(userDataDir) {
  const root = path.resolve(userDataDir);
  if (path.basename(root) !== DEMO_USER_DATA_NAME) {
    const error = new Error(
      "Native Demo reset is restricted to the Vision Demo data directory",
    );
    error.code = "DEMO_RUNTIME_UNSAFE";
    throw error;
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

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function loadDemoSeed(seedRoot) {
  const root = path.resolve(seedRoot);
  const dumpPath = path.join(root, "demo-seed.dump");
  const manifestPath = path.join(root, "manifest.json");
  for (const candidate of [dumpPath, manifestPath]) {
    const stat = await fs.promises.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      const error = new Error("Packaged Demo seed contains an unsafe file");
      error.code = "DEMO_SEED_UNSAFE";
      throw error;
    }
  }
  const manifest = validateDemoSeedManifest(
    JSON.parse(await fs.promises.readFile(manifestPath, "utf8")),
  );
  if ((await sha256File(dumpPath)) !== manifest.dumpSha256) {
    const error = new Error("Packaged Demo seed checksum does not match");
    error.code = "DEMO_SEED_CHECKSUM_MISMATCH";
    throw error;
  }
  return { dumpPath, manifest };
}

async function prepareNativeDemo(runtime, { seedRoot, reset = false } = {}) {
  assertDemoRuntimeIsolation(runtime);
  const seed = await loadDemoSeed(seedRoot);
  const resetRequested = reset || (await hasDemoResetRequest(runtime));
  await runtime.ensureLayout();
  await runtime.discover();
  let state = (await runtime.readState()) || {};
  if (state.pendingDatabaseSwitch) {
    await runtime.ensurePostgresReady();
    await runtime.rollbackDatabaseSwitch(state.pendingDatabaseSwitch);
    state = (await runtime.readState()) || {};
  }
  if (
    !resetRequested &&
    state.demoSeed?.logicalSha256 === seed.manifest.logicalSha256 &&
    state.demoSeed?.schemaRevision === seed.manifest.schemaRevision
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
    allowUncutover: true,
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

async function finalizeNativeDemo(runtime, prepared) {
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
  let resetCleanupWarning;
  if (prepared.resetRequested) {
    try {
      await fs.promises.unlink(demoResetRequestPath(runtime));
    } catch (error) {
      if (error.code !== "ENOENT") {
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

async function rollbackNativeDemo(runtime, prepared) {
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

module.exports = {
  DEMO_POSTGRES_PORT,
  DEMO_RESET_REQUEST,
  DEMO_RUNTIME_ID,
  DEMO_USER_DATA_NAME,
  assertDemoRuntimeIsolation,
  comparableManifestStats,
  demoResetRequestPath,
  finalizeNativeDemo,
  loadDemoSeed,
  prepareNativeDemo,
  requestNativeDemoReset,
  rollbackNativeDemo,
  sha256File,
  validateDemoSeedManifest,
};
