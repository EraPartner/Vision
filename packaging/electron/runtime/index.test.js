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

test("the seeded Demo always uses its isolated native runtime", () => {
  assert.equal(
    resolveRuntimeMode({ env: {}, settings: {}, isDemo: true }),
    "native",
  );
  assert.equal(
    resolveRuntimeMode({
      env: {},
      settings: { runtimeMode: "legacy" },
      runtimeState: { activeRuntime: "legacy" },
      isDemo: true,
    }),
    "native",
  );
});

test("the Demo ignores runtime overrides to keep one synthetic data owner", () => {
  assert.equal(
    resolveRuntimeMode({
      env: { VISION_RUNTIME_MODE: "legacy" },
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
    (error) => error.code === "LEGACY_RUNTIME_MIGRATION_REQUIRED",
  );
});

test("Electron startup fails closed while cutover recovery is pending", () => {
  assert.throws(
    () =>
      resolveRuntimeMode({
        env: {},
        settings: {},
        runtimeState: {
          activeRuntime: "legacy",
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
    JSON.stringify({ activeRuntime: "native" }),
  );
  assert.deepEqual(await readRuntimeSelectionState(root), {
    activeRuntime: "native",
  });
});
