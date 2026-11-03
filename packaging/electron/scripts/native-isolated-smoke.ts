#!/usr/bin/env node
import path from "node:path";
import { execFile } from "node:child_process";
import { safeChildEnv } from "../runtime/native";
import { resolveNativePayloadRoot } from "./resolve-native-payload";

const nativePayloadRoot = resolveNativePayloadRoot();

export interface RunFileOptions {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

export interface RunFileResult {
  stdout: string;
  stderr: string;
}

export interface IsolatedSmokeOptions {
  packagedPayload?: boolean;
  runner?: (
    executable: string,
    args: string[],
    options: RunFileOptions,
  ) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string | undefined {
  return isRecord(error) && typeof error.message === "string"
    ? error.message
    : undefined;
}

export function runFile(
  executable: string,
  args: string[],
  options: RunFileOptions = {},
): Promise<RunFileResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        env: options.env ?? process.env,
        timeout:
          options.timeout === undefined || options.timeout === 0
            ? 60_000
            : options.timeout,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = Object.assign(
            new Error(
              (stderr && stderr.trim()) || error.message || "Process failed",
            ),
            { code: error.code },
          );
          reject(wrapped);
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "" });
      },
    );
  });
}

// native-smoke reserves a free loopback port for each backend it starts;
// another process can take it before the backend binds it.
const PORT_COLLISION = /Native backend port \d+ is already in use/;

const ATTEMPTS = 5;

/**
 * Runs the native smoke in a child process with a minimal environment, so no
 * developer database path, credentials or profile leaks into it. Each run
 * uses its own temporary application-data directory and SQLite database.
 */
export async function runIsolatedSmoke({
  packagedPayload = process.env.VISION_NATIVE_PAYLOAD_ROOT !== undefined,
  runner = runFile,
}: IsolatedSmokeOptions = {}): Promise<{ attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      // The smoke is a compiled sibling in out/scripts.
      await runner(
        process.execPath,
        [path.join(__dirname, "native-smoke.js"), "--cleanup"],
        {
          env: safeChildEnv({
            VISION_NATIVE_PAYLOAD_ROOT: nativePayloadRoot,
            VISION_SMOKE_PACKAGED_PAYLOAD: String(packagedPayload),
          }),
          timeout: 30 * 60_000,
        },
      );
      return { attempts: attempt };
    } catch (error) {
      lastError = error;
      if (
        attempt === ATTEMPTS ||
        !PORT_COLLISION.test(errorMessage(error) ?? "")
      )
        throw error;
    }
  }
  throw lastError;
}

export async function main(): Promise<void> {
  await runIsolatedSmoke();
  console.log(
    "Disposable SQLite native runtime, frontend, API, backup, and restore smoke passed.",
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = errorMessage(error);
    console.error(message !== undefined && message !== "" ? message : String(error));
    process.exitCode = 1;
  });
}
