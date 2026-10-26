import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { parsePort, terminateChild, waitForExit } from "./native-development";

void test("native development accepts only unprivileged TCP ports", () => {
  assert.equal(parsePort(undefined, 3002), 3002);
  assert.equal(parsePort("54329", 3002), 54329);
  for (const value of ["1023", "65536", "1.5", "invalid"]) {
    assert.throws(() => parsePort(value, 3002), /port is invalid/);
  }
});

void test("native development shutdown signals a child and waits for its exit", async () => {
  const signals: NodeJS.Signals[] = [];
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill(signal?: NodeJS.Signals) {
      if (signal) signals.push(signal);
      child.exitCode = 0;
      child.emit("exit", 0, signal);
    },
  });

  const exit = waitForExit(child);
  await terminateChild(child);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(await exit, { code: 0, signal: "SIGTERM" });
});
