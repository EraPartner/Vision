import assert from "node:assert/strict";
import test from "node:test";
import { captureQuiescentSnapshot } from "./quiescent-snapshot";

for (const fails of [false, true]) {
  void test(`snapshot blocks writers and resumes runtime after ${fails ? "capture failure" : "success"}`, async () => {
    let running = true;
    const runtime = {
      stop: () => {
        running = false;
        return Promise.resolve();
      },
      start: () => {
        running = true;
        return Promise.resolve();
      },
      waitUntilReady: () => {
        assert.equal(running, true);
        return Promise.resolve();
      },
    };
    const capture = captureQuiescentSnapshot(runtime, () => {
      assert.equal(running, false);
      if (fails) return Promise.reject(new Error("dump failed"));
      return Promise.resolve("snapshot");
    });
    if (fails) await assert.rejects(capture, /dump failed/);
    else assert.equal(await capture, "snapshot");
    assert.equal(running, true);
  });
}

void test("restart failure is surfaced", async () => {
  await assert.rejects(
    captureQuiescentSnapshot(
      {
        stop: () => Promise.resolve(),
        start: () => Promise.reject(new Error("restart failed")),
        waitUntilReady: () => Promise.resolve(),
      },
      () => Promise.resolve("snapshot"),
    ),
    /restart failed/,
  );
});
