"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  restoreNativeBundle,
  restoreNativeDatabase,
  restoreWithAuditRecovery,
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
    assertRestoredAuditHistory: step("verifyAudit"),
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
    "verifyAudit",
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

test("audit mismatch rolls the restored database and attachments back before finalization", async () => {
  const runtime = fakeRuntime({ failAt: "verifyAudit" });
  await assert.rejects(
    restoreNativeBundle(runtime, {
      dbSqlPath: "/tmp/db.sql",
      attachmentsDir: "/tmp/attachments",
    }),
    /verifyAudit failed/,
  );
  assert.deepEqual(runtime.calls, [
    "activateDatabase",
    "replaceAttachments",
    "start",
    "waitUntilReady",
    "verifyAudit",
    "rollbackAttachments",
    "rollbackDatabase",
    "start",
  ]);
});

test("restore pauses live checkpoint closure through verification and finalization", async () => {
  const runtime = fakeRuntime();
  runtime.pauseAuditClosure = async () => runtime.calls.push("pauseAudit");
  runtime.resumeAuditClosure = () => runtime.calls.push("resumeAudit");
  await restoreNativeDatabase(runtime, "/tmp/db.sql");
  assert.deepEqual(runtime.calls, [
    "pauseAudit",
    "activateDatabase",
    "start",
    "waitUntilReady",
    "verifyAudit",
    "finalizeDatabase",
    "resumeAudit",
  ]);
});

test("audit recovery cancellation leaves the rolled-back original database in place", async () => {
  const runtime = fakeRuntime();
  runtime.assertRestoredAuditHistory = async () => {
    runtime.calls.push("verifyAudit");
    const error = new Error("older backup");
    error.code = "RESTORED_AUDIT_INTEGRITY_FAILED";
    throw error;
  };
  const restore = (allowUnverifiedAudit) => {
    assert.equal(allowUnverifiedAudit, false);
    return restoreNativeDatabase(runtime, "/tmp/db.sql");
  };
  const outcome = await restoreWithAuditRecovery(restore, async () => false);
  assert.deepEqual(outcome, { cancelled: true });
  assert.deepEqual(runtime.calls, [
    "activateDatabase",
    "start",
    "waitUntilReady",
    "verifyAudit",
    "rollbackDatabase",
    "start",
  ]);
});

test("failed database rollback suppresses the audit recovery prompt and retry", async () => {
  const runtime = fakeRuntime({ failAt: "rollbackDatabase" });
  runtime.assertRestoredAuditHistory = async () => {
    runtime.calls.push("verifyAudit");
    const error = new Error("audit mismatch");
    error.code = "RESTORED_AUDIT_INTEGRITY_FAILED";
    throw error;
  };
  let prompted = false;
  let attempts = 0;
  await assert.rejects(
    restoreWithAuditRecovery(
      async () => {
        attempts += 1;
        return restoreNativeDatabase(runtime, "/tmp/db.sql");
      },
      async () => {
        prompted = true;
        return true;
      },
    ),
    (error) =>
      error.code === "RESTORED_AUDIT_INTEGRITY_FAILED" &&
      error.auditRecoveryUnsafe === true &&
      error.rollbackErrors?.length === 1,
  );
  assert.equal(attempts, 1);
  assert.equal(prompted, false);
  assert.equal(runtime.calls.includes("finalizeDatabase"), false);
});

test("failed attachment rollback suppresses the audit recovery prompt", async () => {
  const runtime = fakeRuntime({ failAt: "rollbackAttachments" });
  runtime.assertRestoredAuditHistory = async () => {
    runtime.calls.push("verifyAudit");
    const error = new Error("audit mismatch");
    error.code = "RESTORED_AUDIT_INTEGRITY_UNAVAILABLE";
    throw error;
  };
  let prompted = false;
  await assert.rejects(
    restoreWithAuditRecovery(
      async () =>
        restoreNativeBundle(runtime, {
          dbSqlPath: "/tmp/db.sql",
          attachmentsDir: "/tmp/attachments",
        }),
      async () => {
        prompted = true;
        return true;
      },
    ),
    (error) => error.auditRecoveryUnsafe === true,
  );
  assert.equal(prompted, false);
  assert.equal(runtime.calls.includes("finalizeDatabase"), false);
});

test("explicit audit recovery retries the selected backup once", async () => {
  const calls = [];
  const outcome = await restoreWithAuditRecovery(
    async (allowUnverifiedAudit) => {
      calls.push(allowUnverifiedAudit);
      if (!allowUnverifiedAudit) {
        const error = new Error("older backup");
        error.code = "RESTORED_AUDIT_INTEGRITY_FAILED";
        error.auditStatus = "failed";
        throw error;
      }
      return { success: true };
    },
    async (error) => {
      assert.equal(error.auditStatus, "failed");
      return true;
    },
  );
  assert.deepEqual(calls, [false, true]);
  assert.deepEqual(outcome, { result: { success: true }, recovered: true });
});

test("malformed backup errors cannot enter audit recovery", async () => {
  let prompted = false;
  await assert.rejects(
    restoreWithAuditRecovery(
      async () => {
        const error = new Error("invalid backup authentication");
        error.code = "INVALID_BACKUP";
        throw error;
      },
      async () => {
        prompted = true;
        return true;
      },
    ),
    /invalid backup authentication/,
  );
  assert.equal(prompted, false);
});

test("an uncertain database switch remains stopped", async () => {
  const runtime = fakeActivationRecoveryFailureRuntime();
  await assert.rejects(
    restoreNativeDatabase(runtime, "/tmp/db.sql"),
    (error) => error.code === "DATABASE_SWITCH_RECOVERY_FAILED",
  );
  assert.deepEqual(runtime.calls, ["activateDatabase"]);
});
