"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createNativeRuntime } = require("./native");

const RUNTIME_MODES = new Set(["native", "docker"]);

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
  const requested = normalizeMode(env.VISION_RUNTIME_MODE);
  if (env.VISION_RUNTIME_MODE && !requested) {
    const error = new Error(
      "VISION_RUNTIME_MODE must be either native or docker",
    );
    error.code = "INVALID_RUNTIME_MODE";
    throw error;
  }
  const persisted = normalizeMode(settings.runtimeMode);
  if (settings.runtimeMode && !persisted) {
    const error = new Error("Saved Vision runtime mode is invalid");
    error.code = "INVALID_RUNTIME_MODE";
    throw error;
  }
  const activeRuntime = normalizeMode(runtimeState.activeRuntime);
  if (runtimeState.activeRuntime && !activeRuntime) {
    const error = new Error("Vision runtime marker is invalid");
    error.code = "INVALID_RUNTIME_STATE";
    throw error;
  }
  if (runtimeState.cutoverInProgress === true) {
    const error = new Error(
      "Vision data cutover is in progress or requires recovery; application startup is blocked.",
    );
    error.code = "RUNTIME_CUTOVER_IN_PROGRESS";
    throw error;
  }
  // Once a runtime has accepted writes, its durable marker is authoritative.
  // Switching providers requires the deliberate cutover/rollback command that
  // updates this marker; an old setting or environment variable must not make
  // subsequent launches alternate databases.
  if (activeRuntime) return activeRuntime;
  if (requested) return requested;
  if (persisted) return persisted;
  // The synthetic Demo image currently depends on its seeded Compose database.
  // Keep it isolated until the native demo seeder is explicitly selected.
  if (isDemo) return "docker";
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
  if (mode === "docker") {
    // Lazy require avoids importing Electron-bound Compose code in native unit
    // tests and in command-line migration tools.
    const { createDockerRuntime } = require("./docker");
    return createDockerRuntime(options.docker);
  }
  throw new Error(`Unsupported Vision runtime mode: ${mode}`);
}

module.exports = {
  RUNTIME_MODES,
  normalizeMode,
  resolveRuntimeMode,
  readRuntimeSelectionState,
  createRuntimeProvider,
};
