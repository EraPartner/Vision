"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { gzipSync } = require("node:zlib");

const {
  cleanupSmokeUserData,
  createSmokeRestoreRuntime,
  decodeFrontendBody,
  parseSmokeArgs,
  readSmokeLogTail,
  sanitizeSmokeDiagnostic,
  selectSmokeRuntimeRoot,
  verifyFrontendAssets,
} = require("./native-smoke");
const { restoreNativeBundle } = require("../backup/native-transport");
const {
  assertStableDatabaseStatsEqual,
  parseDatabaseStats,
} = require("../runtime/database-stats");

function syntheticStats({
  providerHealth = 0,
  receipts = 1,
  transactions = 1,
} = {}) {
  return parseDatabaseStats(
    [
      "schema\t0125",
      "postgres_version_num\t180000",
      "stable:user_settings\t1",
      "table:accounts\t1",
      "table:attachments\t1",
      "table:investments\t1",
      "table:planned_transactions\t0",
      "table:portfolio_transactions\t1",
      "table:recipients\t1",
      `table:transactions\t${transactions}`,
      "table:user_settings\t1",
      `table:provider_health\t${providerHealth}`,
      `table:portfolio_import_reconciliations\t${receipts}`,
    ].join("\n"),
  );
}

function syntheticRestoreRuntime({
  restoredStats = syntheticStats(),
  failAt,
  startupTransactions = 1,
} = {}) {
  const calls = [];
  const databaseToken = { id: "synthetic-database" };
  const attachmentToken = { id: "synthetic-attachments" };
  let active = "original";
  let stats = syntheticStats({ transactions: 2 });
  const step = (name) => {
    calls.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
  };
  return {
    calls,
    async activateRestoredDatabase() {
      step("activateDatabase");
      active = "restored";
      stats = structuredClone(restoredStats);
      return { switchToken: databaseToken };
    },
    async replaceAttachments() {
      step("replaceAttachments");
      return attachmentToken;
    },
    async getDatabaseStats() {
      step(`getStats:${active}`);
      return structuredClone(stats);
    },
    async start() {
      step(`start:${active}`);
      if (active === "restored") {
        stats = syntheticStats({
          providerHealth: 1,
          transactions: startupTransactions,
        });
      }
    },
    async waitUntilReady() {
      step("waitUntilReady");
    },
    async assertRestoredAuditHistory() {
      step("verifyAudit");
    },
    async finalizeDatabaseSwitch(token) {
      assert.equal(token, databaseToken);
      step("finalizeDatabase");
    },
    async finalizeAttachmentSwitch(token) {
      assert.equal(token, attachmentToken);
      step("finalizeAttachments");
    },
    async rollbackAttachmentSwitch(token) {
      assert.equal(token, attachmentToken);
      step("rollbackAttachments");
    },
    async rollbackDatabaseSwitch(token) {
      assert.equal(token, databaseToken);
      step("rollbackDatabase");
      active = "original";
      stats = syntheticStats({ transactions: 2 });
    },
  };
}

const syntheticRestoreOptions = {
  dbSqlPath: "/synthetic/db.sql",
  attachmentsDir: "/synthetic/attachments",
  expectedSchemaHead: "0125",
};

test("smoke validates every restored table before startup telemetry can write", async () => {
  const expected = syntheticStats();
  const runtime = syntheticRestoreRuntime();
  await restoreNativeBundle(
    createSmokeRestoreRuntime(runtime, expected),
    syntheticRestoreOptions,
  );
  assert.deepEqual(runtime.calls, [
    "activateDatabase",
    "replaceAttachments",
    "getStats:restored",
    "start:restored",
    "waitUntilReady",
    "verifyAudit",
    "finalizeDatabase",
    "finalizeAttachments",
  ]);
  const after = await runtime.getDatabaseStats();
  assert.equal(after.tableCounts.provider_health, 1);
  assert.doesNotThrow(() => assertStableDatabaseStatsEqual(expected, after));
});

test("smoke count drift rolls back both switch tokens before finalization", async (t) => {
  const diagnostic = t.mock.method(console, "error", () => {});
  for (const [table, restoredStats] of [
    ["provider_health", syntheticStats({ providerHealth: 1 })],
    ["portfolio_import_reconciliations", syntheticStats({ receipts: 2 })],
  ]) {
    const runtime = syntheticRestoreRuntime({ restoredStats });
    await assert.rejects(
      restoreNativeBundle(
        createSmokeRestoreRuntime(runtime, syntheticStats()),
        syntheticRestoreOptions,
      ),
      { code: "DATABASE_COUNT_MISMATCH", message: new RegExp(table) },
    );
    assert.deepEqual(runtime.calls, [
      "activateDatabase",
      "replaceAttachments",
      "getStats:restored",
      "rollbackAttachments",
      "rollbackDatabase",
      "start:original",
    ]);
  }
  assert.equal(diagnostic.mock.calls.length, 2);
});

test("smoke activation failure restarts the original without arming validation", async () => {
  const runtime = syntheticRestoreRuntime({ failAt: "activateDatabase" });
  await assert.rejects(
    restoreNativeBundle(
      createSmokeRestoreRuntime(runtime, syntheticStats()),
      syntheticRestoreOptions,
    ),
    /activateDatabase failed/,
  );
  assert.deepEqual(runtime.calls, ["activateDatabase", "start:original"]);
});

test("smoke attachment failure disarms validation before original restart", async () => {
  const runtime = syntheticRestoreRuntime({ failAt: "replaceAttachments" });
  await assert.rejects(
    restoreNativeBundle(
      createSmokeRestoreRuntime(runtime, syntheticStats()),
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

test("smoke consumes its pre-start validation even if statistics cannot be read", async () => {
  const runtime = syntheticRestoreRuntime({ failAt: "getStats:restored" });
  const wrapped = createSmokeRestoreRuntime(runtime, syntheticStats());
  await wrapped.activateRestoredDatabase();
  await assert.rejects(wrapped.start(), /getStats:restored failed/);
  await wrapped.start();
  assert.deepEqual(runtime.calls, [
    "activateDatabase",
    "getStats:restored",
    "start:restored",
  ]);
});

test("smoke post-start stable validation still rejects user transaction drift", async () => {
  const expected = syntheticStats();
  const runtime = syntheticRestoreRuntime({ startupTransactions: 2 });
  await restoreNativeBundle(
    createSmokeRestoreRuntime(runtime, expected),
    syntheticRestoreOptions,
  );
  const after = await runtime.getDatabaseStats();
  assert.throws(() => assertStableDatabaseStatsEqual(expected, after), {
    code: "DATABASE_COUNT_MISMATCH",
    message: /transactions/,
  });
});

test("native smoke accepts only the explicit cleanup flag", () => {
  assert.deepEqual(parseSmokeArgs([]), { cleanup: false });
  assert.deepEqual(parseSmokeArgs(["--cleanup"]), { cleanup: true });
  assert.throws(() => parseSmokeArgs(["--unknown"]), /only the optional/);
});

test("isolated smoke cleanup removes only its synthetic user-data directory", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-smoke-cleanup-"),
  );
  await fs.promises.writeFile(path.join(root, "synthetic.txt"), "synthetic");
  await cleanupSmokeUserData(root, true);
  assert.equal(fs.existsSync(root), false);
});

test("isolated smoke cleanup retains diagnostics after a failure", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-smoke-retain-"),
  );
  await fs.promises.writeFile(path.join(root, "synthetic.txt"), "synthetic");
  const removed = await cleanupSmokeUserData(root, true, false);
  assert.equal(removed, false);
  assert.equal(fs.existsSync(root), true);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("smoke diagnostics redact database URLs and password values", () => {
  const diagnostic = sanitizeSmokeDiagnostic(
    "DATABASE_URL=postgresql://vision:secret@127.0.0.1:5432/vision password: secret PGPASSWORD=secret",
  );
  assert.doesNotMatch(diagnostic, /secret/);
  assert.doesNotMatch(diagnostic, /vision:secret/);
  assert.match(diagnostic, /DATABASE_URL=\[redacted\]/);
  assert.match(diagnostic, /password=\[redacted\]/);
  assert.match(diagnostic, /PGPASSWORD=\[redacted\]/);
});

test("smoke diagnostics read only the bounded end of the PostgreSQL log", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-smoke-log-"),
  );
  const logPath = path.join(root, "postgres.log");
  await fs.promises.writeFile(
    logPath,
    `discarded-prefix-${"x".repeat(32)}-useful-tail`,
  );
  assert.equal(await readSmokeLogTail(logPath, 11), "useful-tail");
  assert.equal(await readSmokeLogTail(path.join(root, "missing.log")), "");
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("packaged smoke requires the manifest and uses the packaged backend", () => {
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

test("native smoke fetches and decodes the packaged frontend entry", async () => {
  const responses = new Map([
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
  const requested = [];

  await verifyFrontendAssets(43210, async (port, route) => {
    requested.push([port, route]);
    return responses.get(route);
  });

  assert.deepEqual(requested, [
    [43210, "/"],
    [43210, "/assets/index-abc123.js"],
  ]);
});

test("native smoke rejects a corrupt packaged frontend response", () => {
  assert.throws(
    () =>
      decodeFrontendBody({
        headers: { "content-encoding": "gzip" },
        body: Buffer.from("not gzip"),
      }),
    /incorrect header check|unknown compression method|invalid/i,
  );
});
