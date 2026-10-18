import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  DEMO_RUNTIME_ID,
  finalizeNativeDemo,
  loadDemoSeed,
  prepareNativeDemo,
  requestNativeDemoReset,
  rollbackNativeDemo,
  validateDemoSeedManifest,
} from "./native-demo";
import type { NativeDemoRuntime } from "./native-demo";

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

interface MockState {
  activeRuntime?: unknown;
  demoSeed?: { logicalSha256?: unknown; schemaRevision?: unknown };
  pendingDatabaseSwitch?: unknown;
  [key: string]: unknown;
}

type MockCall = string | [string, unknown];

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

async function fixture(t: TestContext) {
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

function runtimeMock(userDataDir: string, initialState: MockState = {}) {
  let state: MockState = structuredClone(initialState);
  const calls: MockCall[] = [];
  const stats = {
    ...database,
    ...tableCounts,
    tableCounts: { ...tableCounts },
    stableImportantRowCounts: undefined as
      { user_settings: number } | undefined,
  };
  const runtime = {
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
    async writeState(next: Record<string, unknown>) {
      calls.push("writeState");
      state = { ...state, ...next };
    },
    async ensurePostgresReady() {
      calls.push("ensurePostgresReady");
    },
    async recoverInterruptedRestore() {
      calls.push("recoverInterruptedRestore");
      state.pendingAttachmentSwitch = undefined;
      state.pendingDatabaseSwitch = undefined;
    },
    async rollbackDatabaseSwitch() {
      calls.push("rollbackDatabaseSwitch");
      state.pendingDatabaseSwitch = undefined;
    },
    async validateCustomDump() {
      calls.push("validateCustomDump");
    },
    async activateRestoredDatabase(_source: string, options: unknown) {
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
  return runtime satisfies NativeDemoRuntime;
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
    hasCode("DEMO_SEED_CHECKSUM_MISMATCH"),
  );
  assert.throws(
    () => validateDemoSeedManifest({ version: 1 }),
    hasCode("DEMO_SEED_MANIFEST_INVALID"),
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

test("recovers paired restore journals before trusting a current Demo seed", async (t) => {
  const { manifest, seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir, {
    pendingDatabaseSwitch: { previousDatabase: "vision_demo_previous" },
    pendingAttachmentSwitch: { previousDirectory: "attachments.previous" },
    demoSeed: {
      logicalSha256: manifest.logicalSha256,
      schemaRevision: manifest.schemaRevision,
    },
  });
  const readState = runtime.readState;
  runtime.readState = async () => {
    const state = await readState();
    assert.equal(state.pendingDatabaseSwitch, undefined);
    assert.equal(state.pendingAttachmentSwitch, undefined);
    assert.ok(runtime.calls.includes("ensurePostgresReady"));
    assert.ok(runtime.calls.includes("recoverInterruptedRestore"));
    return state;
  };

  const prepared = await prepareNativeDemo(runtime, { seedRoot });
  assert.equal(prepared.status, "current");
  assert.ok(!runtime.calls.includes("rollbackDatabaseSwitch"));
  assert.ok(!runtime.calls.some((call) => Array.isArray(call)));
});

test("stops Demo preparation when coordinated recovery fails", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const journals = {
    pendingDatabaseSwitch: { previousDatabase: "vision_demo_previous" },
    pendingAttachmentSwitch: { previousDirectory: "attachments.previous" },
  };
  const runtime = runtimeMock(userDataDir, journals);
  runtime.recoverInterruptedRestore = async () => {
    throw new Error("Synthetic recovery failure");
  };
  await assert.rejects(
    prepareNativeDemo(runtime, { seedRoot }),
    /Synthetic recovery failure/,
  );
  assert.deepEqual(runtime.state(), journals);
  assert.ok(!runtime.calls.includes("writeState"));
  assert.ok(!runtime.calls.includes("rollbackDatabaseSwitch"));
  assert.ok(!runtime.calls.some((call) => Array.isArray(call)));
});

test("activates, verifies, and finalizes a changed Demo seed", async (t) => {
  const { manifest, seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir);
  const prepared = await prepareNativeDemo(runtime, { seedRoot });
  assert.equal(prepared.status, "activated");
  assert.deepEqual(runtime.calls.find((call) => Array.isArray(call))?.[1], {
    format: "custom",
    expectedSchemaHead: manifest.schemaRevision,
  });
  await finalizeNativeDemo(runtime, prepared);
  assert.ok(runtime.calls.includes("finalizeDatabaseSwitch"));
  assert.equal(runtime.state().demoSeed?.logicalSha256, manifest.logicalSha256);
});

test("finalization permits a runtime-owned settings marker", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir);
  const stableImportantRowCounts = {
    user_settings: tableCounts.user_settings,
  };
  runtime.stats.stableImportantRowCounts = stableImportantRowCounts;
  const prepared = await prepareNativeDemo(runtime, { seedRoot });
  runtime.stats.user_settings += 1;
  runtime.stats.tableCounts.user_settings += 1;
  await finalizeNativeDemo(runtime, prepared);
  assert.ok(runtime.calls.includes("finalizeDatabaseSwitch"));

  stableImportantRowCounts.user_settings += 1;
  await assert.rejects(
    finalizeNativeDemo(runtime, prepared),
    hasCode("DATABASE_COUNT_MISMATCH"),
  );
});

test("rolls back a staged Demo database after verification failure", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir);
  runtime.stats.transactions += 1;
  runtime.stats.tableCounts.transactions += 1;
  await assert.rejects(
    prepareNativeDemo(runtime, { seedRoot }),
    hasCode("DATABASE_COUNT_MISMATCH"),
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
    hasCode("ENOENT"),
  );
});

test("rejects a reset request that is a symbolic link, directory or FIFO", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const requestPath = path.join(userDataDir, "demo-reset-request.json");
  await fs.promises.mkdir(userDataDir, { recursive: true });
  const target = path.join(userDataDir, "elsewhere.json");
  await fs.promises.writeFile(target, JSON.stringify({ version: 1 }));
  await fs.promises.symlink(target, requestPath);
  await assert.rejects(
    prepareNativeDemo(runtimeMock(userDataDir), { seedRoot }),
    hasCode("DEMO_RESET_UNSAFE"),
  );
  await fs.promises.unlink(requestPath);
  await fs.promises.mkdir(requestPath);
  await assert.rejects(
    prepareNativeDemo(runtimeMock(userDataDir), { seedRoot }),
    hasCode("DEMO_RESET_UNSAFE"),
  );
  await fs.promises.rmdir(requestPath);
  execFileSync("mkfifo", [requestPath]);
  await assert.rejects(
    prepareNativeDemo(runtimeMock(userDataDir), { seedRoot }),
    hasCode("DEMO_RESET_UNSAFE"),
  );
});

test("refuses to seed outside the Vision Demo application-data directory", async (t) => {
  const { seedRoot } = await fixture(t);
  const runtime = runtimeMock(path.join(os.tmpdir(), "Vision"));
  await assert.rejects(
    prepareNativeDemo(runtime, { seedRoot }),
    hasCode("DEMO_RUNTIME_UNSAFE"),
  );
});
