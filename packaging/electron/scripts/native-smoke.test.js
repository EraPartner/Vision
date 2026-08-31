"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { gzipSync } = require("node:zlib");

const {
  cleanupSmokeUserData,
  decodeFrontendBody,
  parseSmokeArgs,
  readSmokeLogTail,
  sanitizeSmokeDiagnostic,
  selectSmokeRuntimeRoot,
  verifyFrontendAssets,
} = require("./native-smoke");

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
