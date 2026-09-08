"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createNativeRuntime } = require("./native");

const RUNTIME_MODES = new Set(["native"]);

function normalizeMode(value) {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  return RUNTIME_MODES.has(mode) ? mode : undefined;
}

function resolveRuntimeMode({
  env = process.env,
  settings = {},
  runtimeState = {},
  isDemo = false,
} = {}) {
  if (isDemo) return "native";
  const requested = normalizeMode(env.VISION_RUNTIME_MODE);
  if (env.VISION_RUNTIME_MODE && !requested) {
    const error = new Error("VISION_RUNTIME_MODE only supports native");
    error.code = "INVALID_RUNTIME_MODE";
    throw error;
  }
  const persisted = normalizeMode(settings.runtimeMode);
  if (settings.runtimeMode && !persisted) {
    const error = new Error(
      "Legacy runtime data must be migrated with Vision 1.0.2 before this version can start.",
    );
    error.code = "LEGACY_RUNTIME_MIGRATION_REQUIRED";
    throw error;
  }
  const activeRuntime = normalizeMode(runtimeState.activeRuntime);
  if (runtimeState.cutoverInProgress === true) {
    const error = new Error(
      "Vision data cutover is in progress or requires recovery; application startup is blocked.",
    );
    error.code = "RUNTIME_CUTOVER_IN_PROGRESS";
    throw error;
  }
  if (runtimeState.activeRuntime && !activeRuntime) {
    const error = new Error(
      "Legacy runtime data must be migrated with Vision 1.0.2 before this version can start.",
    );
    error.code = "LEGACY_RUNTIME_MIGRATION_REQUIRED";
    throw error;
  }
  if (activeRuntime) return activeRuntime;
  if (requested) return requested;
  if (persisted) return persisted;
  return "native";
}

async function readRuntimeSelectionState(userDataDir, runtimeId = "vision") {
  const statePath = path.join(
    path.resolve(userDataDir),
    "native",
    runtimeId,
    "runtime-state.json",
  );
  try {
    const state = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("Vision runtime marker must contain a JSON object");
    }
    return state;
  } catch (cause) {
    if (cause?.code === "ENOENT") return {};
    const error = new Error("Vision runtime marker could not be read safely");
    error.code = "INVALID_RUNTIME_STATE";
    error.cause = cause;
    throw error;
  }
}

function createRuntimeProvider(mode, options) {
  if (mode === "native") return createNativeRuntime(options.native);
  throw new Error(`Unsupported Vision runtime mode: ${mode}`);
}

module.exports = {
  RUNTIME_MODES,
  normalizeMode,
  resolveRuntimeMode,
  readRuntimeSelectionState,
  createRuntimeProvider,
};
