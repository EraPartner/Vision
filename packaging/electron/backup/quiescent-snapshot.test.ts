import assert from "node:assert/strict";
import test from "node:test";
import { captureQuiescentSnapshot } from "./quiescent-snapshot";

for (const fails of [false, true]) {
  test(`snapshot blocks writers and resumes runtime after ${fails ? "capture failure" : "success"}`, async () => {
    let running = true;
    const runtime = {
      stop: async () => {
        running = false;
      },
      start: async () => {
        running = true;
      },
      waitUntilReady: async () => {
        assert.equal(running, true);
      },
    };
    const capture = captureQuiescentSnapshot(runtime, async () => {
      assert.equal(running, false);
      if (fails) throw new Error("dump failed");
      return "snapshot";
    });
    if (fails) await assert.rejects(capture, /dump failed/);
    else assert.equal(await capture, "snapshot");
    assert.equal(running, true);
  });
}

test("restart failure is surfaced", async () => {
  await assert.rejects(
    captureQuiescentSnapshot(
      {
        stop: async () => {},
        start: async () => {
          throw new Error("restart failed");
        },
        waitUntilReady: async () => {},
      },
      async () => "snapshot",
    ),
    /restart failed/,
  );
});
