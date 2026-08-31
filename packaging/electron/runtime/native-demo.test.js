"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DEMO_RUNTIME_ID,
  finalizeNativeDemo,
  loadDemoSeed,
  prepareNativeDemo,
  requestNativeDemoReset,
  rollbackNativeDemo,
  validateDemoSeedManifest,
} = require("./native-demo");

const tableCounts = {
  accounts: 6,
  attachments: 0,
  investments: 8,
  planned_transactions: 4,
  portfolio_transactions: 20,
  recipients: 53,
  transactions: 200,
  user_settings: 2,
};
const database = {
  schema: "0099_demo_head",
  postgresVersionNum: 180_006,
  tableCount: Object.keys(tableCounts).length,
  tableCounts,
  importantRowCounts: tableCounts,
};

async function fixture(t) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-demo-test-"),
  );
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "Vision Demo");
  const seedRoot = path.join(root, "seed");
  await fs.promises.mkdir(seedRoot, { recursive: true });
  const dump = Buffer.from("synthetic custom dump");
  const manifest = {
    version: 1,
    logicalSha256: "a".repeat(64),
    dumpSha256: crypto.createHash("sha256").update(dump).digest("hex"),
    schemaRevision: database.schema,
    database,
    summary: { accounts: 6 },
  };
  await fs.promises.writeFile(path.join(seedRoot, "demo-seed.dump"), dump);
  await fs.promises.writeFile(
    path.join(seedRoot, "manifest.json"),
    JSON.stringify(manifest),
  );
  return { manifest, seedRoot, userDataDir };
}

function runtimeMock(userDataDir, initialState = {}) {
  let state = structuredClone(initialState);
  const calls = [];
  const stats = {
    ...database,
    ...tableCounts,
    tableCounts: { ...tableCounts },
  };
  return {
    calls,
    runtimeId: DEMO_RUNTIME_ID,
    paths: {
      nativeRoot: path.join(userDataDir, "native", DEMO_RUNTIME_ID),
    },
    async ensureLayout() {
      calls.push("ensureLayout");
    },
    async discover() {
      calls.push("discover");
    },
    async readState() {
      return structuredClone(state);
    },
    async writeState(next) {
      calls.push("writeState");
      state = { ...state, ...next };
    },
    async ensurePostgresReady() {
      calls.push("ensurePostgresReady");
    },
    async rollbackDatabaseSwitch() {
      calls.push("rollbackDatabaseSwitch");
      state.pendingDatabaseSwitch = undefined;
    },
    async validateCustomDump() {
      calls.push("validateCustomDump");
    },
    async activateRestoredDatabase(_source, options) {
      calls.push(["activateRestoredDatabase", options]);
      return { switchToken: { liveDatabase: "vision_demo" } };
    },
    async getDatabaseStats() {
      calls.push("getDatabaseStats");
      return structuredClone(stats);
    },
    async finalizeDatabaseSwitch() {
      calls.push("finalizeDatabaseSwitch");
    },
    async stop() {
      calls.push("stop");
    },
    state: () => structuredClone(state),
    stats,
  };
}

test("validates and checksums the packaged Demo seed", async (t) => {
  const { manifest, seedRoot } = await fixture(t);
  assert.deepEqual((await loadDemoSeed(seedRoot)).manifest, manifest);
  await fs.promises.appendFile(
    path.join(seedRoot, "demo-seed.dump"),
    "truncated",
  );
  await assert.rejects(
    loadDemoSeed(seedRoot),
    (error) => error.code === "DEMO_SEED_CHECKSUM_MISMATCH",
  );
  assert.throws(
    () => validateDemoSeedManifest({ version: 1 }),
    (error) => error.code === "DEMO_SEED_MANIFEST_INVALID",
  );
});

test("skips an already-current native Demo seed", async (t) => {
  const { manifest, seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir, {
    activeRuntime: "native",
    demoSeed: {
      logicalSha256: manifest.logicalSha256,
      schemaRevision: manifest.schemaRevision,
    },
  });
  const result = await prepareNativeDemo(runtime, { seedRoot });
  assert.equal(result.status, "current");
  assert.ok(!runtime.calls.some((call) => Array.isArray(call)));
  assert.equal(runtime.state().activeRuntime, "native");
});

test("activates, verifies, and finalizes a changed Demo seed", async (t) => {
  const { manifest, seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir);
  const prepared = await prepareNativeDemo(runtime, { seedRoot });
  assert.equal(prepared.status, "activated");
  assert.deepEqual(runtime.calls.find((call) => Array.isArray(call))[1], {
    format: "custom",
    expectedSchemaHead: manifest.schemaRevision,
    allowUncutover: true,
  });
  await finalizeNativeDemo(runtime, prepared);
  assert.ok(runtime.calls.includes("finalizeDatabaseSwitch"));
  assert.equal(runtime.state().demoSeed.logicalSha256, manifest.logicalSha256);
});

test("finalization permits a runtime-owned settings marker", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir);
  runtime.stats.stableImportantRowCounts = {
    user_settings: tableCounts.user_settings,
  };
  const prepared = await prepareNativeDemo(runtime, { seedRoot });
  runtime.stats.user_settings += 1;
  runtime.stats.tableCounts.user_settings += 1;
  await finalizeNativeDemo(runtime, prepared);
  assert.ok(runtime.calls.includes("finalizeDatabaseSwitch"));

  runtime.stats.stableImportantRowCounts.user_settings += 1;
  await assert.rejects(
    finalizeNativeDemo(runtime, prepared),
    (error) => error.code === "DATABASE_COUNT_MISMATCH",
  );
});

test("rolls back a staged Demo database after verification failure", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir);
  runtime.stats.transactions += 1;
  runtime.stats.tableCounts.transactions += 1;
  await assert.rejects(
    prepareNativeDemo(runtime, { seedRoot }),
    (error) => error.code === "DATABASE_COUNT_MISMATCH",
  );
  assert.ok(runtime.calls.includes("rollbackDatabaseSwitch"));
});

test("rollback restores the seed marker that belongs to the previous database", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const previousDemoSeed = {
    logicalSha256: "b".repeat(64),
    schemaRevision: database.schema,
  };
  const runtime = runtimeMock(userDataDir, { demoSeed: previousDemoSeed });
  const prepared = await prepareNativeDemo(runtime, { seedRoot });
  await runtime.writeState({
    demoSeed: {
      logicalSha256: "a".repeat(64),
      schemaRevision: database.schema,
    },
  });
  await rollbackNativeDemo(runtime, prepared);
  assert.deepEqual(runtime.state().demoSeed, previousDemoSeed);
});

test("reset requests are isolated and retained until successful finalization", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  await requestNativeDemoReset(userDataDir);
  const runtime = runtimeMock(userDataDir, {
    demoSeed: {
      logicalSha256: "a".repeat(64),
      schemaRevision: database.schema,
    },
  });
  const prepared = await prepareNativeDemo(runtime, { seedRoot });
  assert.equal(prepared.status, "activated");
  assert.equal(prepared.resetRequested, true);
  await rollbackNativeDemo(runtime, prepared);
  assert.equal(
    await fs.promises
      .access(path.join(userDataDir, "demo-reset-request.json"))
      .then(() => true),
    true,
  );

  const retryRuntime = runtimeMock(userDataDir, runtime.state());
  const retried = await prepareNativeDemo(retryRuntime, { seedRoot });
  assert.equal(retried.status, "activated");
  await finalizeNativeDemo(retryRuntime, retried);
  await assert.rejects(
    fs.promises.access(path.join(userDataDir, "demo-reset-request.json")),
    (error) => error.code === "ENOENT",
  );
});

test("refuses to seed outside the Vision Demo application-data directory", async (t) => {
  const { seedRoot } = await fixture(t);
  const runtime = runtimeMock(path.join(os.tmpdir(), "Vision"));
  await assert.rejects(
    prepareNativeDemo(runtime, { seedRoot }),
    (error) => error.code === "DEMO_RUNTIME_UNSAFE",
  );
});
