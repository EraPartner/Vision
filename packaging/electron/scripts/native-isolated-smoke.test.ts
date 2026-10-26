import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runIsolatedSmoke } from "./native-isolated-smoke";
import type { RunFileOptions } from "./native-isolated-smoke";

void test("isolated smoke delegates PostgreSQL ownership to the native runtime", async () => {
  const calls: {
    executable: string;
    args: string[];
    options: RunFileOptions;
  }[] = [];
  const result = await runIsolatedSmoke({
    findBin: () => "/synthetic/postgres/bin",
    packagedPayload: true,
    reserve: () => Promise.resolve(55_432),
    runner: (executable, args, options) => {
      calls.push({ executable, args, options });
      return Promise.resolve();
    },
  });

  assert.equal(result.port, 55_432);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.executable, process.execPath);
  assert.deepEqual(calls[0].args, [
    path.join(__dirname, "native-smoke.js"),
    "--cleanup",
  ]);
  assert.equal(calls[0].options.env?.VISION_POSTGRES_PORT, "55432");
  assert.equal(
    calls[0].options.env.VISION_POSTGRES_BIN,
    "/synthetic/postgres/bin",
  );
  assert.equal(calls[0].options.env.VISION_SMOKE_PACKAGED_PAYLOAD, "true");
});

void test("isolated smoke retries a random-port race without masking other errors", async () => {
  const ports = [55_432, 55_433];
  let calls = 0;
  const result = await runIsolatedSmoke({
    findBin: () => "/synthetic/postgres/bin",
    reserve: () => {
      const port = ports.shift();
      assert.ok(port !== undefined);
      return Promise.resolve(port);
    },
    runner: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(
          new Error("Native PostgreSQL port 55432 is already in use."),
        );
      }
      return Promise.resolve();
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.port, 55_433);
});
