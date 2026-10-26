import assert from "node:assert/strict";
import test from "node:test";

import { resolveRuntimeMode } from "./index";

// Retired inputs (saved settings and runtime state) are passed alongside the
// supported options to prove they no longer influence the selection.
function resolveWithRetiredInputs(input: {
  env: NodeJS.ProcessEnv;
  isDemo?: boolean;
  settings: Record<string, unknown>;
  runtimeState?: Record<string, unknown>;
}) {
  return resolveRuntimeMode(input);
}

void test("native is the default runtime for normal Vision", () => {
  assert.equal(resolveWithRetiredInputs({ env: {}, settings: {} }), "native");
});

void test("the seeded Demo always uses its isolated native runtime", () => {
  assert.equal(
    resolveWithRetiredInputs({ env: {}, settings: {}, isDemo: true }),
    "native",
  );
  assert.equal(
    resolveWithRetiredInputs({
      env: {},
      settings: { runtimeMode: "legacy" },
      runtimeState: { activeRuntime: "legacy" },
      isDemo: true,
    }),
    "native",
  );
});

void test("the Demo ignores runtime overrides to keep one synthetic data owner", () => {
  assert.equal(
    resolveWithRetiredInputs({
      env: { VISION_RUNTIME_MODE: "legacy" },
      settings: {},
      isDemo: true,
    }),
    "native",
  );
});

void test("invalid explicit runtime modes fail closed", () => {
  assert.throws(
    () => resolveRuntimeMode({ env: { VISION_RUNTIME_MODE: "sqlite" } }),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "INVALID_RUNTIME_MODE",
  );
});

void test("retired persisted runtime markers no longer affect native selection", () => {
  assert.equal(
    resolveWithRetiredInputs({
      env: {},
      settings: { runtimeMode: "docker" },
      runtimeState: { activeRuntime: "docker", cutoverInProgress: true },
    }),
    "native",
  );
});
