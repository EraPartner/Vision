import assert from "node:assert/strict";
import test from "node:test";

import { restoreNativeBundle, restoreNativeDatabase } from "./native-transport";
import type { NativeRestoreRuntime } from "./native-transport";

type FakeRuntime = NativeRestoreRuntime & { calls: string[] };

function codedError(
  message: string,
  code: string,
  extra: Record<string, unknown> = {},
): Error {
  return Object.assign(new Error(message), { code }, extra);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function field(error: unknown, name: string): unknown {
  return isRecord(error) ? error[name] : undefined;
}

function fakeRuntime({
  failAt,
  cleanupFails = false,
}: { failAt?: string; cleanupFails?: boolean } = {}): FakeRuntime {
  const calls: string[] = [];
  const step =
    <T>(name: string, value: T) =>
    (): Promise<T> => {
      calls.push(name);
      if (failAt === name) return Promise.reject(new Error(`${name} failed`));
      return Promise.resolve(value);
    };
  return {
    calls,
    activateRestoredDatabase: step("activateDatabase", {
      switchToken: { id: "database" },
    }),
    replaceAttachments: step("replaceAttachments", { id: "attachments" }),
    start: step("start", undefined),
    waitUntilReady: step("waitUntilReady", undefined),
    finalizeDatabaseSwitch: step("finalizeDatabase", undefined),
    finalizeAttachmentSwitch: () => {
      calls.push("finalizeAttachments");
      return cleanupFails
        ? Promise.reject(new Error("attachment cleanup failed"))
        : Promise.resolve();
    },
    rollbackAttachmentSwitch: step("rollbackAttachments", undefined),
    rollbackDatabaseSwitch: step("rollbackDatabase", undefined),
  };
}

function fakeActivationRecoveryFailureRuntime(): FakeRuntime {
  const runtime = fakeRuntime();
  runtime.activateRestoredDatabase = () => {
    runtime.calls.push("activateDatabase");
    return Promise.reject(
      codedError(
        "database switch recovery failed",
        "DATABASE_SWITCH_RECOVERY_FAILED",
      ),
    );
  };
  return runtime;
}

void test("native bundle restore commits only after detailed readiness", async () => {
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

void test("native bundle restore rolls attachments and database back before restarting", async () => {
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

void test("post-commit attachment cleanup failure is retained as a warning", async () => {
  const runtime = fakeRuntime({ cleanupFails: true });
  const result = await restoreNativeBundle(runtime, {
    dbSqlPath: "/tmp/db.sql",
    attachmentsDir: "/tmp/attachments",
  });
  assert.match(
    String(field(result.cleanupWarning, "message")),
    /cleanup failed/,
  );
  assert.equal(runtime.calls.includes("rollbackDatabase"), false);
  assert.equal(runtime.calls.includes("rollbackAttachments"), false);
});

void test("native plain SQL restore rolls the database back on readiness failure", async () => {
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

void test("a failed rollback is attached to the restore error", async () => {
  const runtime = fakeRuntime({ failAt: "rollbackDatabase" });
  runtime.waitUntilReady = () => {
    runtime.calls.push("waitUntilReady");
    return Promise.reject(codedError("backend not ready", "BACKEND_NOT_READY"));
  };
  await assert.rejects(
    restoreNativeDatabase(runtime, "/tmp/db.sql"),
    (error) => {
      const rollbackErrors = field(error, "rollbackErrors");
      return (
        field(error, "code") === "BACKEND_NOT_READY" &&
        Array.isArray(rollbackErrors) &&
        rollbackErrors.length === 1
      );
    },
  );
  assert.equal(runtime.calls.includes("finalizeDatabase"), false);
});

void test("an uncertain database switch remains stopped", async () => {
  const runtime = fakeActivationRecoveryFailureRuntime();
  await assert.rejects(
    restoreNativeDatabase(runtime, "/tmp/db.sql"),
    (error) => field(error, "code") === "DATABASE_SWITCH_RECOVERY_FAILED",
  );
  assert.deepEqual(runtime.calls, ["activateDatabase"]);
});
