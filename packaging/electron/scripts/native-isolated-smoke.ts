#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { safeChildEnv } from "../runtime/native";
import { resolveNativePayloadRoot } from "./resolve-native-payload";

const LOOPBACK_HOST = "127.0.0.1";
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
  findBin?: () => string;
  packagedPayload?: boolean;
  reserve?: () => Promise<number>;
  runner?: (
    executable: string,
    args: string[],
    options: RunFileOptions,
  ) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): unknown {
  return isRecord(error) ? error.message : undefined;
}

function bundledPostgresBin(): string {
  const postgresRoot = path.join(nativePayloadRoot, "postgres");
  const metadata: unknown = JSON.parse(
    fs.readFileSync(path.join(postgresRoot, "runtime.json"), "utf8"),
  );
  const binRelative = isRecord(metadata) ? metadata.binRelative : undefined;
  if (
    !isRecord(metadata) ||
    metadata.postgresMajor !== 18 ||
    metadata.postgresVersion !== "18.6" ||
    metadata.platform !== process.platform ||
    metadata.architecture !== process.arch ||
    typeof binRelative !== "string" ||
    path.isAbsolute(binRelative) ||
    binRelative.split(/[\\/]/).includes("..")
  ) {
    throw new Error("Prepared PostgreSQL runtime metadata is invalid");
  }
  const root = path.resolve(postgresRoot, "root");
  const bin = path.resolve(root, ...binRelative.split("/"));
  if (!bin.startsWith(`${root}${path.sep}`))
    throw new Error("Prepared PostgreSQL runtime path is unsafe");
  return bin;
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
        env: options.env || process.env,
        timeout: options.timeout || 60_000,
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

export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Reserved port has no TCP address"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export function findPostgresBin(): string {
  const candidates = [
    process.env.VISION_POSTGRES_BIN,
    bundledPostgresBin(),
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/local/opt/postgresql@18/bin",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const required = ["initdb", "postgres", "pg_isready"];
    if (
      required.every((name) => {
        try {
          fs.accessSync(path.join(candidate, name), fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      })
    ) {
      return path.resolve(candidate);
    }
  }
  throw new Error(
    "PostgreSQL 18 initdb, postgres, and pg_isready were not found",
  );
}

const PORT_COLLISION =
  /Native PostgreSQL port \d+ (?:is already in use|is occupied by another server)/;

export async function runIsolatedSmoke({
  findBin = findPostgresBin,
  packagedPayload = process.env.VISION_NATIVE_PAYLOAD_ROOT !== undefined,
  reserve = reservePort,
  runner = runFile,
}: IsolatedSmokeOptions = {}): Promise<{ port: number; postgresBin: string }> {
  const postgresBin = findBin();
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await reserve();
    try {
      // The smoke is a compiled sibling in out/scripts.
      await runner(
        process.execPath,
        [path.join(__dirname, "native-smoke.js"), "--cleanup"],
        {
          env: safeChildEnv({
            VISION_NATIVE_PAYLOAD_ROOT: nativePayloadRoot,
            VISION_POSTGRES_BIN: postgresBin,
            VISION_POSTGRES_PORT: String(port),
            VISION_SMOKE_PACKAGED_PAYLOAD: String(packagedPayload),
          }),
          timeout: 30 * 60_000,
        },
      );
      return { port, postgresBin };
    } catch (error) {
      lastError = error;
      if (
        attempt === 4 ||
        !PORT_COLLISION.test(String(errorMessage(error) || ""))
      )
        throw error;
    }
  }
  throw lastError;
}

export async function main(): Promise<void> {
  await runIsolatedSmoke();
  console.log(
    "Disposable PostgreSQL 18 native runtime, frontend, API, backup, and restore smoke passed.",
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = errorMessage(error);
    console.error(error && message ? String(message) : String(error));
    process.exitCode = 1;
  });
}
