"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createDockerRuntime } = require("./docker");

function makeRuntime() {
  const calls = [];
  const compose = {
    checkDocker: async (workDir) => {
      calls.push(["check", workDir]);
      return "ok";
    },
    composeStartOrUp: async (workDir, overrides, skipBuild) => {
      calls.push(["start", workDir, overrides, skipBuild]);
      return { started: true };
    },
    stopContainers: async (workDir, overrides) => {
      calls.push(["stop", workDir, overrides]);
    },
  };
  return {
    calls,
    runtime: createDockerRuntime({
      compose,
      workDir: () => "/tmp/vision-compose",
      overrideFiles: () => ["docker-compose.dev.yml"],
      appPort: () => 3002,
    }),
  };
}

test("Docker provider keeps lifecycle behavior behind the runtime boundary", async () => {
  const { calls, runtime } = makeRuntime();
  assert.equal(runtime.mode, "docker");
  assert.equal(await runtime.check(), "ok");
  await runtime.start({ skipBuild: true });
  await runtime.restart({ skipBuild: false });
  await runtime.stop();
  assert.deepEqual(calls, [
    ["check", "/tmp/vision-compose"],
    ["start", "/tmp/vision-compose", ["docker-compose.dev.yml"], true],
    ["stop", "/tmp/vision-compose", ["docker-compose.dev.yml"]],
    ["start", "/tmp/vision-compose", ["docker-compose.dev.yml"], false],
    ["stop", "/tmp/vision-compose", ["docker-compose.dev.yml"]],
  ]);
});

test("Docker provider requires an explicit Compose adapter", () => {
  assert.throws(() => createDockerRuntime({}), /Compose adapter/);
});
