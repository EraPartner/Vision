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
const SCHEMA_VERSION = 99;

interface MockState {
  activeRuntime?: unknown;
  demoSeed?:
    | {
        logicalSha256?: unknown;
        databaseSha256?: unknown;
        schemaVersion?: unknown;
        schemaRevision?: unknown;
      }
    | undefined;
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

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fixture(t: TestContext) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-demo-test-"),
  );
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "Vision Demo");
  const seedRoot = path.join(root, "seed");
  await fs.promises.mkdir(seedRoot, { recursive: true });
  const seedDatabase = Buffer.from("SQLite format 3\0synthetic Demo database");
  const manifest = {
    version: 2,
    format: "sqlite",
    logicalSha256: "a".repeat(64),
    databaseSha256: sha256(seedDatabase),
    databaseBytes: seedDatabase.length,
    schemaVersion: SCHEMA_VERSION,
    database: { tableCounts },
    summary: { accounts: 6 },
  };
  await fs.promises.writeFile(
    path.join(seedRoot, "vision-demo.sqlite3"),
    seedDatabase,
  );
  await fs.promises.writeFile(
    path.join(seedRoot, "manifest.json"),
    JSON.stringify(manifest),
  );
  return { manifest, seedRoot, userDataDir };
}

function currentSeedState(manifest: {
  logicalSha256: string;
  databaseSha256: string;
  schemaVersion: number;
}): MockState["demoSeed"] {
  return {
    logicalSha256: manifest.logicalSha256,
    databaseSha256: manifest.databaseSha256,
    schemaVersion: manifest.schemaVersion,
  };
}

function runtimeMock(userDataDir: string, initialState: MockState = {}) {
  let state: MockState = structuredClone(initialState);
  const calls: MockCall[] = [];
  const databaseDir = path.join(userDataDir, "database");
  const database = path.join(databaseDir, "vision.sqlite3");
  const report = {
    schemaVersion: SCHEMA_VERSION,
    tableCounts: { ...tableCounts },
  };
  const runtime = {
    calls,
    runtimeId: DEMO_RUNTIME_ID,
    paths: {
      nativeRoot: path.join(userDataDir, "native", DEMO_RUNTIME_ID),
      database,
    },
    /** What activation writes to the live path; the seed itself by default. */
    activatedContents: undefined as Buffer | undefined,
    ensureLayout() {
      calls.push("ensureLayout");
      return fs.promises.mkdir(databaseDir, { recursive: true });
    },
    discover() {
      calls.push("discover");
      return Promise.resolve();
    },
    readState() {
      return Promise.resolve(structuredClone(state));
    },
    writeState(next: Record<string, unknown>) {
      calls.push("writeState");
      state = { ...state, ...next };
      return Promise.resolve();
    },
    recoverInterruptedRestore() {
      calls.push("recoverInterruptedRestore");
      state.pendingAttachmentSwitch = undefined;
      state.pendingDatabaseSwitch = undefined;
      return Promise.resolve();
    },
    rollbackDatabaseSwitch() {
      calls.push("rollbackDatabaseSwitch");
      state.pendingDatabaseSwitch = undefined;
      return Promise.resolve();
    },
    async activateRestoredDatabase(source: string, options: unknown) {
      calls.push(["activateRestoredDatabase", options]);
      await fs.promises.mkdir(databaseDir, { recursive: true });
      await fs.promises.writeFile(
        database,
        runtime.activatedContents ?? (await fs.promises.readFile(source)),
      );
      return { switchToken: { kind: "sqlite-directory" } };
    },
    verifyDatabaseFile(file: string) {
      calls.push(["verifyDatabaseFile", file]);
      return Promise.resolve(structuredClone(report));
    },
    finalizeDatabaseSwitch() {
      calls.push("finalizeDatabaseSwitch");
      return Promise.resolve();
    },
    stop() {
      calls.push("stop");
      return Promise.resolve();
    },
    state: () => structuredClone(state),
    report,
  };
  return runtime satisfies NativeDemoRuntime;
}

void test("validates and checksums the packaged Demo seed", async (t) => {
  const { manifest, seedRoot } = await fixture(t);
  const seed = await loadDemoSeed(seedRoot);
  assert.deepEqual(seed.manifest, manifest);
  assert.equal(seed.databasePath, path.join(seedRoot, "vision-demo.sqlite3"));
  await fs.promises.appendFile(
    path.join(seedRoot, "vision-demo.sqlite3"),
    "truncated",
  );
  await assert.rejects(
    loadDemoSeed(seedRoot),
    hasCode("DEMO_SEED_CHECKSUM_MISMATCH"),
  );
  for (const invalid of [
    { version: 1 },
    { ...manifest, version: 1 },
    { ...manifest, format: "postgresql-custom" },
    { ...manifest, schemaVersion: "0099_demo_head" },
    { ...manifest, database: { tableCounts: {} } },
    { ...manifest, database: { tableCounts: { accounts: -1 } } },
  ]) {
    assert.throws(
      () => validateDemoSeedManifest(invalid),
      hasCode("DEMO_SEED_MANIFEST_INVALID"),
    );
  }
});

void test("skips an already-current native Demo seed", async (t) => {
  const { manifest, seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir, {
    activeRuntime: "native",
    demoSeed: currentSeedState(manifest),
  });
  await fs.promises.mkdir(path.dirname(runtime.paths.database), {
    recursive: true,
  });
  await fs.promises.writeFile(runtime.paths.database, "SQLite format 3\0used");
  const result = await prepareNativeDemo(runtime, { seedRoot });
  assert.equal(result.status, "current");
  assert.ok(!runtime.calls.some((call) => Array.isArray(call)));
  assert.equal(runtime.state().activeRuntime, "native");
});

void test("re-seeds a current Demo seed whose database file is gone", async (t) => {
  const { manifest, seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir, {
    demoSeed: currentSeedState(manifest),
  });
  const result = await prepareNativeDemo(runtime, { seedRoot });
  assert.equal(result.status, "activated");
});

void test("a Vision 2.0 Demo seed marker is replaced by the SQLite seed", async (t) => {
  const { manifest, seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir, {
    demoSeed: {
      logicalSha256: manifest.logicalSha256,
      schemaRevision: "0128_category_path_on_legacy_rename",
    },
  });
  const result = await prepareNativeDemo(runtime, { seedRoot });
  assert.equal(result.status, "activated");
});

void test("recovers paired restore journals before trusting a current Demo seed", async (t) => {
  const { manifest, seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir, {
    pendingDatabaseSwitch: { kind: "sqlite-directory" },
    pendingAttachmentSwitch: { previousDirectory: "attachments.previous" },
    demoSeed: currentSeedState(manifest),
  });
  await fs.promises.mkdir(path.dirname(runtime.paths.database), {
    recursive: true,
  });
  await fs.promises.writeFile(runtime.paths.database, "SQLite format 3\0used");
  const readState = runtime.readState.bind(runtime);
  runtime.readState = async () => {
    const state = await readState();
    assert.equal(state.pendingDatabaseSwitch, undefined);
    assert.equal(state.pendingAttachmentSwitch, undefined);
    assert.ok(runtime.calls.includes("recoverInterruptedRestore"));
    return state;
  };

  const prepared = await prepareNativeDemo(runtime, { seedRoot });
  assert.equal(prepared.status, "current");
  assert.ok(!runtime.calls.includes("rollbackDatabaseSwitch"));
  assert.ok(!runtime.calls.some((call) => Array.isArray(call)));
});

void test("stops Demo preparation when coordinated recovery fails", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const journals = {
    pendingDatabaseSwitch: { kind: "sqlite-directory" },
    pendingAttachmentSwitch: { previousDirectory: "attachments.previous" },
  };
  const runtime = runtimeMock(userDataDir, journals);
  runtime.recoverInterruptedRestore = () =>
    Promise.reject(new Error("Synthetic recovery failure"));
  await assert.rejects(
    prepareNativeDemo(runtime, { seedRoot }),
    /Synthetic recovery failure/,
  );
  assert.deepEqual(runtime.state(), journals);
  assert.ok(!runtime.calls.includes("writeState"));
  assert.ok(!runtime.calls.includes("rollbackDatabaseSwitch"));
  assert.ok(!runtime.calls.some((call) => Array.isArray(call)));
});

void test("activates, verifies, and finalizes a changed Demo seed", async (t) => {
  const { manifest, seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir);
  const prepared = await prepareNativeDemo(runtime, { seedRoot });
  assert.equal(prepared.status, "activated");
  assert.deepEqual(runtime.calls.find((call) => Array.isArray(call))?.[1], {
    expectedSchemaVersion: manifest.schemaVersion,
    expectedSha256: manifest.databaseSha256,
  });
  assert.equal(
    sha256(await fs.promises.readFile(runtime.paths.database)),
    manifest.databaseSha256,
  );
  await finalizeNativeDemo(runtime, prepared);
  assert.ok(
    runtime.calls.some(
      (call) =>
        Array.isArray(call) &&
        call[0] === "verifyDatabaseFile" &&
        call[1] === runtime.paths.database,
    ),
  );
  assert.ok(runtime.calls.includes("finalizeDatabaseSwitch"));
  assert.deepEqual(runtime.state().demoSeed && {
    ...runtime.state().demoSeed,
    appliedAt: undefined,
  }, { ...currentSeedState(manifest), appliedAt: undefined });
});

void test("finalization permits runtime-owned settings rows but protects Demo data", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir);
  const prepared = await prepareNativeDemo(runtime, { seedRoot });
  runtime.report.tableCounts.user_settings += 1;
  await finalizeNativeDemo(runtime, prepared);
  assert.ok(runtime.calls.includes("finalizeDatabaseSwitch"));

  runtime.report.tableCounts.transactions -= 1;
  await assert.rejects(
    finalizeNativeDemo(runtime, prepared),
    hasCode("DATABASE_COUNT_MISMATCH"),
  );
});

void test("finalization refuses a Demo database whose schema moved backwards", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir);
  const prepared = await prepareNativeDemo(runtime, { seedRoot });
  runtime.report.schemaVersion = SCHEMA_VERSION - 1;
  await assert.rejects(
    finalizeNativeDemo(runtime, prepared),
    hasCode("DATABASE_SCHEMA_MISMATCH"),
  );
  assert.ok(!runtime.calls.includes("finalizeDatabaseSwitch"));
});

void test("rolls back an activated Demo database that does not match the seed", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(userDataDir);
  runtime.activatedContents = Buffer.from("SQLite format 3\0different");
  await assert.rejects(
    prepareNativeDemo(runtime, { seedRoot }),
    hasCode("DEMO_SEED_CHECKSUM_MISMATCH"),
  );
  assert.ok(runtime.calls.includes("rollbackDatabaseSwitch"));
});

void test("rollback restores the seed marker that belongs to the previous database", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const previousDemoSeed = {
    logicalSha256: "b".repeat(64),
    databaseSha256: "c".repeat(64),
    schemaVersion: SCHEMA_VERSION,
  };
  const runtime = runtimeMock(userDataDir, { demoSeed: previousDemoSeed });
  const prepared = await prepareNativeDemo(runtime, { seedRoot });
  await runtime.writeState({
    demoSeed: {
      logicalSha256: "a".repeat(64),
      databaseSha256: "d".repeat(64),
      schemaVersion: SCHEMA_VERSION,
    },
  });
  await rollbackNativeDemo(runtime, prepared);
  assert.deepEqual(runtime.state().demoSeed, previousDemoSeed);
});

void test("reset requests are isolated and retained until successful finalization", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  await requestNativeDemoReset(userDataDir);
  const runtime = runtimeMock(userDataDir, {
    demoSeed: {
      logicalSha256: "a".repeat(64),
      databaseSha256: "d".repeat(64),
      schemaVersion: SCHEMA_VERSION,
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

void test("rejects a reset request that is a symbolic link, directory or FIFO", async (t) => {
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

void test("refuses to seed outside the Vision Demo application-data directory", async (t) => {
  const { seedRoot, userDataDir } = await fixture(t);
  const runtime = runtimeMock(path.join(os.tmpdir(), "Vision"));
  await assert.rejects(
    prepareNativeDemo(runtime, { seedRoot }),
    hasCode("DEMO_RUNTIME_UNSAFE"),
  );
  // A Demo runtime whose database path leaves the Demo directory is refused too.
  const escaped = runtimeMock(userDataDir);
  escaped.paths.database = path.join(
    path.dirname(userDataDir),
    "Vision",
    "database",
    "vision.sqlite3",
  );
  await assert.rejects(
    prepareNativeDemo(escaped, { seedRoot }),
    hasCode("DEMO_RUNTIME_UNSAFE"),
  );
});
