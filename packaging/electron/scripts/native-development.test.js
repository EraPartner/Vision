"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  parsePort,
  terminateChild,
  waitForExit,
} = require("./native-development");

test("native development accepts only unprivileged TCP ports", () => {
  assert.equal(parsePort(undefined, 3002), 3002);
  assert.equal(parsePort("54329", 3002), 54329);
  for (const value of ["1023", "65536", "1.5", "invalid"]) {
    assert.throws(() => parsePort(value, 3002), /port is invalid/);
  }
});

test("native development shutdown signals a child and waits for its exit", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    child.exitCode = 0;
    child.emit("exit", 0, signal);
  };

  const exit = waitForExit(child);
  await terminateChild(child);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.deepEqual(await exit, { code: 0, signal: "SIGTERM" });
});
