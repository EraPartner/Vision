"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  restoreNativeBundle,
  restoreNativeDatabase,
} = require("./native-transport");

function fakeRuntime({ failAt, cleanupFails = false } = {}) {
  const calls = [];
  const step = (name, value) => async () => {
    calls.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
    return value;
  };
  return {
    calls,
    activateRestoredDatabase: step("activateDatabase", {
      switchToken: { id: "database" },
    }),
    replaceAttachments: step("replaceAttachments", { id: "attachments" }),
    start: step("start"),
    waitUntilReady: step("waitUntilReady"),
    finalizeDatabaseSwitch: step("finalizeDatabase"),
    finalizeAttachmentSwitch: async () => {
      calls.push("finalizeAttachments");
      if (cleanupFails) throw new Error("attachment cleanup failed");
    },
    rollbackAttachmentSwitch: step("rollbackAttachments"),
    rollbackDatabaseSwitch: step("rollbackDatabase"),
  };
}

function fakeActivationRecoveryFailureRuntime() {
  const runtime = fakeRuntime();
  runtime.activateRestoredDatabase = async () => {
    runtime.calls.push("activateDatabase");
    const error = new Error("database switch recovery failed");
    error.code = "DATABASE_SWITCH_RECOVERY_FAILED";
    throw error;
  };
  return runtime;
}

test("native bundle restore commits only after detailed readiness", async () => {
  const runtime = fakeRuntime();
  const result = await restoreNativeBundle(runtime, {
    dbSqlPath: "/tmp/db.sql",
    attachmentsDir: "/tmp/attachments",
    expectedSchemaHead: "0072_test",
  });
  assert.deepEqual(runtime.calls, [
    "activateDatabase",
    "replaceAttachments",
    "start",
    "waitUntilReady",
    "finalizeDatabase",
    "finalizeAttachments",
  ]);
  assert.equal(result.cleanupWarning, undefined);
});

test("native bundle restore rolls attachments and database back before restarting", async () => {
  const runtime = fakeRuntime({ failAt: "waitUntilReady" });
  await assert.rejects(
    restoreNativeBundle(runtime, {
      dbSqlPath: "/tmp/db.sql",
      attachmentsDir: "/tmp/attachments",
    }),
    /waitUntilReady failed/,
  );
  assert.deepEqual(runtime.calls, [
    "activateDatabase",
    "replaceAttachments",
    "start",
    "waitUntilReady",
    "rollbackAttachments",
    "rollbackDatabase",
    "start",
  ]);
});

test("post-commit attachment cleanup failure is retained as a warning", async () => {
  const runtime = fakeRuntime({ cleanupFails: true });
  const result = await restoreNativeBundle(runtime, {
    dbSqlPath: "/tmp/db.sql",
    attachmentsDir: "/tmp/attachments",
  });
  assert.match(result.cleanupWarning.message, /cleanup failed/);
  assert.equal(runtime.calls.includes("rollbackDatabase"), false);
  assert.equal(runtime.calls.includes("rollbackAttachments"), false);
});

test("native plain SQL restore rolls the database back on readiness failure", async () => {
  const runtime = fakeRuntime({ failAt: "waitUntilReady" });
  await assert.rejects(
    restoreNativeDatabase(runtime, "/tmp/db.sql"),
    /waitUntilReady failed/,
  );
  assert.deepEqual(runtime.calls, [
    "activateDatabase",
    "start",
    "waitUntilReady",
    "rollbackDatabase",
    "start",
  ]);
});

test("an uncertain database switch remains stopped", async () => {
  const runtime = fakeActivationRecoveryFailureRuntime();
  await assert.rejects(
    restoreNativeDatabase(runtime, "/tmp/db.sql"),
    (error) => error.code === "DATABASE_SWITCH_RECOVERY_FAILED",
  );
  assert.deepEqual(runtime.calls, ["activateDatabase"]);
});
