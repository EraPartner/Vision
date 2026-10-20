#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import {
  buildNativeBackendEnv,
  createNativeRuntime,
  isPortFree,
  parseEnvFile,
  safeChildEnv,
  validateArgs,
} from "../runtime/native";
import { appRoot } from "../paths";

const repoRoot = path.resolve(appRoot, "..", "..");
const nativePayloadRoot = path.resolve(appRoot, "native-runtime");

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null | undefined;
}

/** The part of a ChildProcess that shutdown needs; tests supply a stand-in. */
export interface ExitableChild {
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export function parsePort(value: string | undefined, fallback: number): number {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error("Native development port is invalid");
  return port;
}

export function waitForExit(child: ExitableChild): Promise<ChildExit> {
  if (child.exitCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

export async function terminateChild(
  child: ExitableChild | undefined,
): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    void waitForExit(child).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited && child.exitCode === null) child.kill("SIGKILL");
}

export async function main(): Promise<void> {
  const appPort = parsePort(process.env.VISION_APP_PORT, 3002);
  const postgresPort = parsePort(process.env.VISION_POSTGRES_PORT, 54329);
  if (!(await isPortFree(appPort))) {
    throw Object.assign(
      new Error(
        `Native development backend port ${appPort} is already in use.`,
      ),
      { code: "PORT_COLLISION" },
    );
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
    allowExternalPostgres:
      process.env.VISION_ALLOW_EXTERNAL_POSTGRES === "true",
    runtimeId: "vision_dev",
    appPort,
    postgresPort,
  });
  let backend: ChildProcess | undefined;
  let frontend: ChildProcess | undefined;
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
      }),
      NODE_ENV: "development",
      ENVIRONMENT: "development",
      VISION_DEV: "true",
    };
    const frontendEnv = safeChildEnv({
      VISION_DEV_API_TARGET: `http://127.0.0.1:${appPort}`,
    });
    const bun = tools.bun;
    // Discovery leaves bun unset when no candidate exists; spawn() used to
    // reject that with this same error, before any child was started.
    if (bun === undefined)
      throw Object.assign(
        new TypeError(
          'The "file" argument must be of type string. Received undefined',
        ),
        { code: "ERR_INVALID_ARG_TYPE" },
      );
    backend = spawn(
      bun,
      validateArgs(["--watch", "apps/node-backend/src/main.ts"]),
      {
        cwd: repoRoot,
        env: backendEnv,
        stdio: "inherit",
      },
    );
    frontend = spawn(
      bun,
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

    const stopSignal = new Promise<ChildExit>((resolve) => {
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
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}

function errorMessage(error: unknown): string {
  return error &&
    typeof error === "object" &&
    "message" in error &&
    error.message
    ? String(error.message)
    : String(error);
}
