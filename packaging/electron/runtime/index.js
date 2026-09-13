"use strict";

const { createNativeRuntime } = require("./native");

const RUNTIME_MODES = new Set(["native"]);

function normalizeMode(value) {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  return RUNTIME_MODES.has(mode) ? mode : undefined;
}

function resolveRuntimeMode({ env = process.env, isDemo = false } = {}) {
  if (isDemo) return "native";
  const requested = normalizeMode(env.VISION_RUNTIME_MODE);
  if (env.VISION_RUNTIME_MODE && !requested) {
    const error = new Error("VISION_RUNTIME_MODE only supports native");
    error.code = "INVALID_RUNTIME_MODE";
    throw error;
  }
  if (requested) return requested;
  return "native";
}

function createRuntimeProvider(mode, options) {
  if (mode === "native") return createNativeRuntime(options.native);
  throw new Error(`Unsupported Vision runtime mode: ${mode}`);
}

module.exports = {
  RUNTIME_MODES,
  normalizeMode,
  resolveRuntimeMode,
  createRuntimeProvider,
};
