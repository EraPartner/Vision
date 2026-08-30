"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { readRuntimeSelectionState, resolveRuntimeMode } = require("./index");

test("native is the default runtime for normal Vision", () => {
  assert.equal(resolveRuntimeMode({ env: {}, settings: {} }), "native");
});

test("Docker remains an explicit runtime option", () => {
  assert.equal(
    resolveRuntimeMode({ env: { VISION_RUNTIME_MODE: "docker" } }),
    "docker",
  );
  assert.equal(
    resolveRuntimeMode({ env: {}, settings: { runtimeMode: "docker" } }),
    "docker",
  );
  assert.equal(
    resolveRuntimeMode({
      env: {},
      settings: {},
      runtimeState: { activeRuntime: "docker" },
    }),
    "docker",
  );
});

test("the cutover marker takes precedence over stale explicit configuration", () => {
  assert.equal(
    resolveRuntimeMode({
      env: { VISION_RUNTIME_MODE: "native" },
      settings: {},
      runtimeState: { activeRuntime: "docker" },
    }),
    "docker",
  );
  assert.equal(
    resolveRuntimeMode({
      env: { VISION_RUNTIME_MODE: "docker" },
      settings: { runtimeMode: "docker" },
      runtimeState: { activeRuntime: "native" },
    }),
    "native",
  );
});

test("the seeded Demo remains isolated in Docker unless explicitly overridden", () => {
  assert.equal(
    resolveRuntimeMode({ env: {}, settings: {}, isDemo: true }),
    "docker",
  );
  assert.equal(
    resolveRuntimeMode({
      env: { VISION_RUNTIME_MODE: "native" },
      settings: {},
      isDemo: true,
    }),
    "native",
  );
});

test("invalid runtime modes fail closed", () => {
  assert.throws(
    () => resolveRuntimeMode({ env: { VISION_RUNTIME_MODE: "sqlite" } }),
    (error) => error.code === "INVALID_RUNTIME_MODE",
  );
  assert.throws(
    () =>
      resolveRuntimeMode({
        env: {},
        settings: {},
        runtimeState: { activeRuntime: "sqlite" },
      }),
    (error) => error.code === "INVALID_RUNTIME_STATE",
  );
});

test("Electron startup fails closed while cutover recovery is pending", () => {
  assert.throws(
    () =>
      resolveRuntimeMode({
        env: {},
        settings: {},
        runtimeState: {
          activeRuntime: "docker",
          cutoverInProgress: true,
        },
      }),
    (error) => error.code === "RUNTIME_CUTOVER_IN_PROGRESS",
  );
});

test("runtime selection state is read from the durable native marker", async (t) => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-runtime-state-"),
  );
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const markerDir = path.join(root, "native", "vision");
  await fs.promises.mkdir(markerDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(markerDir, "runtime-state.json"),
    JSON.stringify({ activeRuntime: "docker" }),
  );
  assert.deepEqual(await readRuntimeSelectionState(root), {
    activeRuntime: "docker",
  });
});
