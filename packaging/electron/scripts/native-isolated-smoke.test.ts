import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runIsolatedSmoke } from "./native-isolated-smoke";
import type { RunFileOptions } from "./native-isolated-smoke";

void test("isolated smoke runs the native smoke with only the payload settings", async () => {
  const calls: {
    executable: string;
    args: string[];
    options: RunFileOptions;
  }[] = [];
  const result = await runIsolatedSmoke({
    packagedPayload: true,
    runner: (executable, args, options) => {
      calls.push({ executable, args, options });
      return Promise.resolve();
    },
  });

  assert.equal(result.attempts, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.executable, process.execPath);
  assert.deepEqual(calls[0].args, [
    path.join(__dirname, "native-smoke.js"),
    "--cleanup",
  ]);
  const env = calls[0].options.env ?? {};
  assert.equal(env.VISION_SMOKE_PACKAGED_PAYLOAD, "true");
  assert.ok(env.VISION_NATIVE_PAYLOAD_ROOT);
  for (const key of Object.keys(env)) {
    assert.doesNotMatch(key, /^(?:PG|DATABASE_URL|VISION_POSTGRES|VISION_DATABASE_PATH)/);
  }
});

void test("isolated smoke retries a backend port race without masking other errors", async () => {
  let calls = 0;
  const result = await runIsolatedSmoke({
    runner: () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(
          new Error("Native backend port 55432 is already in use."),
        );
      }
      return Promise.resolve();
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);

  let failures = 0;
  await assert.rejects(
    runIsolatedSmoke({
      runner: () => {
        failures += 1;
        return Promise.reject(new Error("restore verification failed"));
      },
    }),
    /restore verification failed/,
  );
  assert.equal(failures, 1);
});
