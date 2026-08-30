"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runDockerToNativeCutover } = require("./importer");

function fixtureStats() {
  const tableCounts = {
    accounts: 2,
    attachments: 1,
    investments: 3,
    planned_transactions: 4,
    portfolio_transactions: 5,
    recipients: 6,
    transactions: 7,
    user_settings: 8,
  };
  return {
    schema: "0064_example",
    postgresVersionNum: 180_006,
    tableCount: Object.keys(tableCounts).length,
    tableCounts,
    ...tableCounts,
  };
}

async function makeHarness(
  temp,
  { failVerification = false, pgDumpVersion = 180_006 } = {},
) {
  const calls = [];
  let runtimeState = { activeRuntime: "docker" };
  const nativeRoot = path.join(temp, "native");
  await fs.promises.mkdir(nativeRoot, { recursive: true });
  const stats = fixtureStats();
  const source = {
    assertAvailable: async () => {
      calls.push("source:available");
      return { postgresMajor: 18, serverVersionNum: 180_006 };
    },
    stopWriter: async () => calls.push("source:stop-writer"),
    assertWriterStopped: async () => calls.push("source:writer-stopped"),
    captureStats: async () => ({ ...stats }),
    readApplicationEnv: async () => ({ FRED_API_KEY: "test-only-value" }),
    dumpCustom: async (destination) => {
      calls.push("source:dump");
      await fs.promises.writeFile(destination, "custom-dump");
    },
    exportAttachments: async (destination) => {
      calls.push("source:attachments");
      await fs.promises.mkdir(destination, { recursive: true });
      await fs.promises.writeFile(
        path.join(destination, "receipt.pdf"),
        "receipt",
      );
    },
    stopStack: async () => calls.push("source:stop-stack"),
    startWriter: async () => calls.push("source:start-writer"),
  };
  const nativeRuntime = {
    paths: { nativeRoot },
    readState: async () => ({ ...runtimeState }),
    ensureLayout: async () => calls.push("native:layout"),
    discover: async () => {
      calls.push("native:discover");
      return { versionNumbers: { pg_dump: pgDumpVersion } };
    },
    ensurePostgresReady: async () => calls.push("native:postgres"),
    validateCustomDump: async () => calls.push("native:validate-dump"),
    importApplicationEnv: async () => calls.push("native:import-env"),
    activateRestoredDatabase: async () => {
      calls.push("native:activate-db");
      return { switchToken: { liveDatabase: "vision" } };
    },
    getDatabaseStats: async () => ({ ...stats }),
    replaceAttachments: async (sourceDir) => {
      calls.push("native:replace-attachments");
      const { directoryFingerprint } = require("./native");
      return directoryFingerprint(sourceDir);
    },
    writeState: async (state) => {
      runtimeState = { ...runtimeState, ...state };
      calls.push(`native:state:${state.cutoverPhase}`);
    },
    start: async () => calls.push("native:start"),
    stop: async () => calls.push("native:stop"),
    waitUntilReady: async () => calls.push("native:ready"),
    finalizeDatabaseSwitch: async () => calls.push("native:finalize-db"),
    finalizeAttachmentSwitch: async () =>
      calls.push("native:finalize-attachments"),
    rollbackDatabaseSwitch: async () => calls.push("native:rollback-db"),
    rollbackAttachmentSwitch: async () =>
      calls.push("native:rollback-attachments"),
  };
  const verifyNative = async () => {
    calls.push("verify:workflows");
    if (failVerification) throw new Error("verification failed");
  };
  return { calls, source, nativeRuntime, verifyNative };
}

test("cutover keeps Docker stopped until native verification completes", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-cutover-"),
  );
  try {
    const harness = await makeHarness(temp);
    const result = await runDockerToNativeCutover({
      ...harness,
      backupPath: temp,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    assert.equal(result.status, "complete");
    assert.ok(
      harness.calls.indexOf("source:stop-writer") <
        harness.calls.indexOf("native:start"),
    );
    assert.ok(
      harness.calls.indexOf("verify:workflows") <
        harness.calls.indexOf("native:stop"),
    );
    assert.ok(
      harness.calls.indexOf("native:stop") <
        harness.calls.indexOf("source:stop-stack"),
    );
    assert.equal(harness.calls.includes("source:start-writer"), false);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("failed native verification rolls back before restarting Docker writer", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-cutover-fail-"),
  );
  try {
    const harness = await makeHarness(temp, { failVerification: true });
    await assert.rejects(
      runDockerToNativeCutover({
        ...harness,
        backupPath: temp,
        now: () => new Date("2026-08-30T12:00:00.000Z"),
      }),
      /verification failed/,
    );
    assert.ok(harness.calls.includes("native:rollback-db"));
    assert.ok(harness.calls.includes("native:rollback-attachments"));
    assert.ok(
      harness.calls.indexOf("native:rollback-db") <
        harness.calls.indexOf("source:start-writer"),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("an interrupted cutover lock blocks a second writer before source shutdown", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-cutover-locked-"),
  );
  try {
    const harness = await makeHarness(temp);
    await fs.promises.writeFile(
      path.join(harness.nativeRuntime.paths.nativeRoot, "cutover.lock"),
      "interrupted-test",
      { mode: 0o600 },
    );
    await assert.rejects(
      runDockerToNativeCutover({
        ...harness,
        backupPath: temp,
      }),
      (error) => error.code === "CUTOVER_LOCKED",
    );
    assert.equal(harness.calls.includes("source:stop-writer"), false);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("cutover rejects a pg_dump client older than the Docker source before writer shutdown", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-cutover-old-client-"),
  );
  try {
    const harness = await makeHarness(temp, { pgDumpVersion: 180_005 });
    await assert.rejects(
      runDockerToNativeCutover({
        ...harness,
        backupPath: temp,
      }),
      (error) => error.code === "POSTGRES_CLIENT_TOO_OLD",
    );
    assert.equal(harness.calls.includes("source:stop-writer"), false);
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});

test("a stale attributed cutover lock rolls pending switches back before retry", async () => {
  const temp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-cutover-recovery-"),
  );
  try {
    const harness = await makeHarness(temp);
    await harness.nativeRuntime.writeState({
      activeRuntime: "docker",
      cutoverInProgress: true,
      pendingAttachmentSwitch: { previousDirectory: "/tmp/previous" },
      pendingDatabaseSwitch: { liveDatabase: "vision" },
    });
    await fs.promises.writeFile(
      path.join(harness.nativeRuntime.paths.nativeRoot, "cutover.lock"),
      `${JSON.stringify({ version: 1, pid: 2_147_483_647 })}\n`,
      { mode: 0o600 },
    );

    const result = await runDockerToNativeCutover({
      ...harness,
      backupPath: temp,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    assert.equal(result.status, "complete");
    assert.ok(
      harness.calls.indexOf("native:rollback-attachments") <
        harness.calls.indexOf("source:start-writer"),
    );
    assert.ok(
      harness.calls.indexOf("native:rollback-db") <
        harness.calls.indexOf("source:start-writer"),
    );
    assert.ok(
      harness.calls.indexOf("source:start-writer") <
        harness.calls.indexOf("source:stop-writer"),
    );
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
});
