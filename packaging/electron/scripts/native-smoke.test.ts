import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  cleanupSmokeUserData,
  createSmokeRestoreRuntime,
  decodeFrontendBody,
  parseSmokeArgs,
  readSmokeLogTail,
  sanitizeSmokeDiagnostic,
  selectSmokeRuntimeRoot,
  verifyFrontendAssets,
} from "./native-smoke";
import type { FrontendResponse } from "./native-smoke";
import { restoreNativeBundle } from "../backup/native-transport";

const SNAPSHOT = { sha256: "a".repeat(64) };

function syntheticRestoreRuntime({
  restoredSha256 = SNAPSHOT.sha256,
  failAt,
}: {
  restoredSha256?: string;
  failAt?: string;
} = {}) {
  const calls: string[] = [];
  const databaseToken = { id: "synthetic-database" };
  const attachmentToken = { id: "synthetic-attachments" };
  let active = "original";
  const step = (name: string) => {
    calls.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
  };
  // Runs the body at call time; a throw becomes a rejection, like an async method.
  const settled = <T>(run: () => T): Promise<T> =>
    new Promise((resolve) => resolve(run()));
  const runtime = {
    calls,
    paths: { database: "/synthetic/database/vision.sqlite3" },
    hash: (file: string) =>
      settled(() => {
        assert.equal(file, runtime.paths.database);
        step(`hash:${active}`);
        return active === "restored" ? restoredSha256 : "b".repeat(64);
      }),
    activateRestoredDatabase() {
      return settled(() => {
        step("activateDatabase");
        active = "restored";
        return { switchToken: databaseToken };
      });
    },
    replaceAttachments() {
      return settled(() => {
        step("replaceAttachments");
        return attachmentToken;
      });
    },
    start() {
      return settled(() => {
        step(`start:${active}`);
      });
    },
    waitUntilReady() {
      return settled(() => {
        step("waitUntilReady");
      });
    },
    finalizeDatabaseSwitch(token: unknown) {
      return settled(() => {
        assert.equal(token, databaseToken);
        step("finalizeDatabase");
      });
    },
    finalizeAttachmentSwitch(token: unknown) {
      return settled(() => {
        assert.equal(token, attachmentToken);
        step("finalizeAttachments");
      });
    },
    rollbackAttachmentSwitch(token: unknown) {
      return settled(() => {
        assert.equal(token, attachmentToken);
        step("rollbackAttachments");
      });
    },
    rollbackDatabaseSwitch(token: unknown) {
      return settled(() => {
        assert.equal(token, databaseToken);
        step("rollbackDatabase");
        active = "original";
      });
    },
  };
  return runtime;
}

const syntheticRestoreOptions = {
  databasePath: "/synthetic/db.sqlite3",
  attachmentsDir: "/synthetic/attachments",
  expectedSchemaVersion: 125,
};

void test("smoke proves the restored database is the snapshot before startup can write", async () => {
  const runtime = syntheticRestoreRuntime();
  await restoreNativeBundle(
    createSmokeRestoreRuntime(runtime, SNAPSHOT, runtime.hash),
    syntheticRestoreOptions,
  );
  assert.deepEqual(runtime.calls, [
    "activateDatabase",
    "replaceAttachments",
    "hash:restored",
    "start:restored",
    "waitUntilReady",
    "finalizeDatabase",
    "finalizeAttachments",
  ]);
});

void test("smoke checksum drift rolls back both switch tokens before finalization", async (t) => {
  const diagnostic = t.mock.method(console, "error", () => {});
  const runtime = syntheticRestoreRuntime({ restoredSha256: "c".repeat(64) });
  await assert.rejects(
    restoreNativeBundle(
      createSmokeRestoreRuntime(runtime, SNAPSHOT, runtime.hash),
      syntheticRestoreOptions,
    ),
    { code: "DATABASE_CHECKSUM_MISMATCH" },
  );
  assert.deepEqual(runtime.calls, [
    "activateDatabase",
    "replaceAttachments",
    "hash:restored",
    "rollbackAttachments",
    "rollbackDatabase",
    "start:original",
  ]);
  assert.equal(diagnostic.mock.calls.length, 1);
});

void test("smoke activation failure restarts the original without arming validation", async () => {
  const runtime = syntheticRestoreRuntime({ failAt: "activateDatabase" });
  await assert.rejects(
    restoreNativeBundle(
      createSmokeRestoreRuntime(runtime, SNAPSHOT, runtime.hash),
      syntheticRestoreOptions,
    ),
    /activateDatabase failed/,
  );
  assert.deepEqual(runtime.calls, ["activateDatabase", "start:original"]);
});

void test("smoke attachment failure disarms validation before original restart", async () => {
  const runtime = syntheticRestoreRuntime({ failAt: "replaceAttachments" });
  await assert.rejects(
    restoreNativeBundle(
      createSmokeRestoreRuntime(runtime, SNAPSHOT, runtime.hash),
      syntheticRestoreOptions,
    ),
    /replaceAttachments failed/,
  );
  assert.deepEqual(runtime.calls, [
    "activateDatabase",
    "replaceAttachments",
    "rollbackDatabase",
    "start:original",
  ]);
});

void test("smoke consumes its pre-start validation even if the database cannot be read", async () => {
  const runtime = syntheticRestoreRuntime({ failAt: "hash:restored" });
  const wrapped = createSmokeRestoreRuntime(runtime, SNAPSHOT, runtime.hash);
  await wrapped.activateRestoredDatabase();
  await assert.rejects(wrapped.start(), /hash:restored failed/);
  await wrapped.start();
  assert.deepEqual(runtime.calls, [
    "activateDatabase",
    "hash:restored",
    "start:restored",
  ]);
});

void test("native smoke accepts only the explicit cleanup flag", () => {
  assert.deepEqual(parseSmokeArgs([]), { cleanup: false });
  assert.deepEqual(parseSmokeArgs(["--cleanup"]), { cleanup: true });
  assert.throws(() => parseSmokeArgs(["--unknown"]), /only the optional/);
});

void test("isolated smoke cleanup removes only its synthetic user-data directory", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-smoke-cleanup-"),
  );
  await fs.promises.writeFile(path.join(root, "synthetic.txt"), "synthetic");
  await cleanupSmokeUserData(root, true);
  assert.equal(fs.existsSync(root), false);
});

void test("isolated smoke cleanup retains diagnostics after a failure", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-smoke-retain-"),
  );
  await fs.promises.writeFile(path.join(root, "synthetic.txt"), "synthetic");
  const removed = await cleanupSmokeUserData(root, true, false);
  assert.equal(removed, false);
  assert.equal(fs.existsSync(root), true);
  await fs.promises.rm(root, { recursive: true, force: true });
});

void test("smoke diagnostics redact database URLs and password values", () => {
  const diagnostic = sanitizeSmokeDiagnostic(
    "DATABASE_URL=postgresql://vision:secret@127.0.0.1:5432/vision password: secret PGPASSWORD=secret",
  );
  assert.doesNotMatch(diagnostic, /secret/);
  assert.doesNotMatch(diagnostic, /vision:secret/);
  assert.match(diagnostic, /DATABASE_URL=\[redacted\]/);
  assert.match(diagnostic, /password=\[redacted\]/);
  assert.match(diagnostic, /PGPASSWORD=\[redacted\]/);
});

void test("smoke diagnostics read only the bounded end of the backend log", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-smoke-log-"),
  );
  const logPath = path.join(root, "backend.log");
  await fs.promises.writeFile(
    logPath,
    `discarded-prefix-${"x".repeat(32)}-useful-tail`,
  );
  assert.equal(await readSmokeLogTail(logPath, 11), "useful-tail");
  assert.equal(await readSmokeLogTail(path.join(root, "missing.log")), "");
  await fs.promises.rm(root, { recursive: true, force: true });
});

void test("packaged smoke requires the manifest and uses the packaged backend", () => {
  assert.deepEqual(
    selectSmokeRuntimeRoot({
      nativePayloadRoot: "/Applications/Vision.app/native-runtime",
      repoRoot: "/source/Vision",
      packagedPayload: true,
    }),
    {
      requireRuntimeManifest: true,
      runtimeRoot: "/Applications/Vision.app/native-runtime",
    },
  );
  assert.deepEqual(
    selectSmokeRuntimeRoot({
      nativePayloadRoot: "/source/Vision/packaging/electron/native-runtime",
      repoRoot: "/source/Vision",
      packagedPayload: false,
    }),
    { requireRuntimeManifest: false, runtimeRoot: "/source/Vision" },
  );
});

void test("native smoke fetches and decodes the packaged frontend entry", async () => {
  const responses = new Map<string, FrontendResponse>([
    [
      "/",
      {
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from(
          '<div id="root"></div><script type="module" src="/assets/index-abc123.js"></script>',
        ),
      },
    ],
    [
      "/assets/index-abc123.js",
      {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "content-encoding": "gzip",
        },
        body: gzipSync(Buffer.from('console.log("synthetic frontend");')),
      },
    ],
  ]);
  const requested: [number, string][] = [];

  await verifyFrontendAssets(43210, (port, route) => {
    requested.push([port, route]);
    const response = responses.get(route);
    assert.ok(response);
    return Promise.resolve(response);
  });

  assert.deepEqual(requested, [
    [43210, "/"],
    [43210, "/assets/index-abc123.js"],
  ]);
});

void test("native smoke rejects a corrupt packaged frontend response", () => {
  assert.throws(
    () =>
      decodeFrontendBody({
        headers: { "content-encoding": "gzip" },
        body: Buffer.from("not gzip"),
      }),
    /incorrect header check|unknown compression method|invalid/i,
  );
});
