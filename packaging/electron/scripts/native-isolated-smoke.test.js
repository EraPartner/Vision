"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { runIsolatedSmoke } = require("./native-isolated-smoke");

test("isolated smoke delegates PostgreSQL ownership to the native runtime", async () => {
  const calls = [];
  const result = await runIsolatedSmoke({
    findBin: () => "/synthetic/postgres/bin",
    packagedPayload: true,
    reserve: async () => 55_432,
    runner: async (executable, args, options) => {
      calls.push({ executable, args, options });
    },
  });

  assert.equal(result.port, 55_432);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.deepEqual(calls[0].args, [
    path.join(__dirname, "native-smoke.js"),
    "--cleanup",
  ]);
  assert.equal(calls[0].options.env.VISION_POSTGRES_PORT, "55432");
  assert.equal(
    calls[0].options.env.VISION_POSTGRES_BIN,
    "/synthetic/postgres/bin",
  );
  assert.equal(calls[0].options.env.VISION_SMOKE_PACKAGED_PAYLOAD, "true");
});

test("isolated smoke retries a random-port race without masking other errors", async () => {
  const ports = [55_432, 55_433];
  let calls = 0;
  const result = await runIsolatedSmoke({
    findBin: () => "/synthetic/postgres/bin",
    reserve: async () => ports.shift(),
    runner: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("Native PostgreSQL port 55432 is already in use.");
      }
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.port, 55_433);
});
