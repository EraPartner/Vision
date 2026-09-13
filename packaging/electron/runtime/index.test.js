"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveRuntimeMode } = require("./index");

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

test("invalid explicit runtime modes fail closed", () => {
  assert.throws(
    () => resolveRuntimeMode({ env: { VISION_RUNTIME_MODE: "sqlite" } }),
    (error) => error.code === "INVALID_RUNTIME_MODE",
  );
});

test("retired persisted runtime markers no longer affect native selection", () => {
  assert.equal(
    resolveRuntimeMode({
      env: {},
      settings: { runtimeMode: "docker" },
      runtimeState: { activeRuntime: "docker", cutoverInProgress: true },
    }),
    "native",
  );
});
