import assert from "node:assert/strict";
import test from "node:test";
import { captureQuiescentSnapshot } from "./quiescent-snapshot";

for (const fails of [false, true]) {
  test(`snapshot blocks writers and resumes runtime after ${fails ? "capture failure" : "success"}`, async () => {
    let running = true;
    let auditPaused = false;
    const runtime = {
      pauseAuditClosure: async () => {
        auditPaused = true;
      },
      stop: async () => {
        assert.equal(auditPaused, true);
        running = false;
      },
      start: async () => {
        running = true;
      },
      waitUntilReady: async () => {
        assert.equal(running, true);
      },
      resumeAuditClosure: () => {
        auditPaused = false;
      },
    };
    const capture = captureQuiescentSnapshot(runtime, async () => {
      assert.equal(running, false);
      assert.equal(auditPaused, true);
      if (fails) throw new Error("dump failed");
      return "snapshot";
    });
    if (fails) await assert.rejects(capture, /dump failed/);
    else assert.equal(await capture, "snapshot");
    assert.equal(running, true);
    assert.equal(auditPaused, false);
  });
}

test("restart failure is surfaced and the audit pause is released", async () => {
  let resumed = false;
  await assert.rejects(
    captureQuiescentSnapshot(
      {
        pauseAuditClosure: async () => {},
        stop: async () => {},
        start: async () => {
          throw new Error("restart failed");
        },
        waitUntilReady: async () => {},
        resumeAuditClosure: () => {
          resumed = true;
        },
      },
      async () => "snapshot",
    ),
    /restart failed/,
  );
  assert.equal(resumed, true);
});
