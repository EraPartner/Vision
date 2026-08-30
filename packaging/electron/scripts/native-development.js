#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  buildNativeBackendEnv,
  createNativeRuntime,
  isPortFree,
  parseEnvFile,
  safeChildEnv,
  validateArgs,
} = require("../runtime/native");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const nativePayloadRoot = path.resolve(__dirname, "..", "native-runtime");

function parsePort(value, fallback) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error("Native development port is invalid");
  return port;
}

function waitForExit(child) {
  if (child.exitCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    waitForExit(child).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited && child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  const appPort = parsePort(process.env.VISION_APP_PORT, 3002);
  const postgresPort = parsePort(process.env.VISION_POSTGRES_PORT, 54329);
  if (!(await isPortFree(appPort))) {
    const error = new Error(
      `Native development backend port ${appPort} is already in use.`,
    );
    error.code = "PORT_COLLISION";
    throw error;
  }

  const userDataDir = path.resolve(
    process.env.VISION_DEV_USER_DATA ||
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Vision Development",
      ),
  );
  const runtime = createNativeRuntime({
    userDataDir,
    repoRoot,
    runtimeRoot: repoRoot,
    postgresRuntimeRoot: nativePayloadRoot,
    browserRuntimeRoot: nativePayloadRoot,
    alembicPath: path.join(nativePayloadRoot, "vision-alembic"),
    allowExternalPostgres:
      process.env.VISION_ALLOW_EXTERNAL_POSTGRES === "true",
    runtimeId: "vision_dev",
    appPort,
    postgresPort,
  });
  let backend;
  let frontend;
  try {
    await runtime.ensureLayout();
    await runtime.importApplicationEnv(process.env);
    await runtime.writeState({
      activeRuntime: "native",
      developmentRuntime: true,
    });
    const tools = await runtime.discover();
    await runtime.bootstrapDatabase();
    const runtimeEnv = parseEnvFile(
      await fs.promises.readFile(runtime.paths.env, "utf8"),
    );
    const backendEnv = {
      ...buildNativeBackendEnv({
        runtimeEnv,
        port: appPort,
        paths: runtime.paths,
        runtimeRoot: repoRoot,
        repoRoot,
        tools,
      }),
      NODE_ENV: "development",
      ENVIRONMENT: "development",
      VISION_DEV: "true",
    };
    const frontendEnv = safeChildEnv({
      VITE_API_URL: `http://127.0.0.1:${appPort}`,
    });
    backend = spawn(
      tools.bun,
      validateArgs(["--watch", "apps/node-backend/src/main.js"]),
      {
        cwd: repoRoot,
        env: backendEnv,
        stdio: "inherit",
      },
    );
    frontend = spawn(
      tools.bun,
      validateArgs([
        "run",
        "--filter",
        "vision-frontend",
        "dev",
        "--host",
        "127.0.0.1",
      ]),
      {
        cwd: repoRoot,
        env: frontendEnv,
        stdio: "inherit",
      },
    );

    const stopSignal = new Promise((resolve) => {
      process.once("SIGINT", () => resolve({ code: 0, signal: "SIGINT" }));
      process.once("SIGTERM", () => resolve({ code: 0, signal: "SIGTERM" }));
    });
    const result = await Promise.race([
      waitForExit(backend),
      waitForExit(frontend),
      stopSignal,
    ]);
    if (result.code && result.code !== 0) process.exitCode = result.code;
  } finally {
    await Promise.all([terminateChild(backend), terminateChild(frontend)]);
    await runtime.stopPostgres();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { main, parsePort, terminateChild, waitForExit };
