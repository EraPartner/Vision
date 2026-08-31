#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { safeChildEnv } = require("../runtime/native");
const { resolveNativePayloadRoot } = require("./resolve-native-payload");

const LOOPBACK_HOST = "127.0.0.1";
const nativePayloadRoot = resolveNativePayloadRoot();

function bundledPostgresBin() {
  const postgresRoot = path.join(nativePayloadRoot, "postgres");
  const metadata = JSON.parse(
    fs.readFileSync(path.join(postgresRoot, "runtime.json"), "utf8"),
  );
  if (
    metadata?.postgresMajor !== 18 ||
    metadata.postgresVersion !== "18.6" ||
    metadata.platform !== process.platform ||
    metadata.architecture !== process.arch ||
    typeof metadata.binRelative !== "string" ||
    path.isAbsolute(metadata.binRelative) ||
    metadata.binRelative.split(/[\\/]/).includes("..")
  ) {
    throw new Error("Prepared PostgreSQL runtime metadata is invalid");
  }
  const root = path.resolve(postgresRoot, "root");
  const bin = path.resolve(root, ...metadata.binRelative.split("/"));
  if (!bin.startsWith(`${root}${path.sep}`))
    throw new Error("Prepared PostgreSQL runtime path is unsafe");
  return bin;
}

function runFile(executable, args, options = {}) {
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
          const wrapped = new Error(
            (stderr && stderr.trim()) || error.message || "Process failed",
          );
          wrapped.code = error.code;
          reject(wrapped);
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "" });
      },
    );
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function findPostgresBin() {
  const candidates = [
    process.env.VISION_POSTGRES_BIN,
    bundledPostgresBin(),
    "/opt/homebrew/opt/postgresql@18/bin",
    "/usr/local/opt/postgresql@18/bin",
  ].filter(Boolean);
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

async function runIsolatedSmoke({
  findBin = findPostgresBin,
  packagedPayload = process.env.VISION_NATIVE_PAYLOAD_ROOT !== undefined,
  reserve = reservePort,
  runner = runFile,
} = {}) {
  const postgresBin = findBin();
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await reserve();
    try {
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
      if (attempt === 4 || !PORT_COLLISION.test(String(error?.message || "")))
        throw error;
    }
  }
  throw lastError;
}

async function main() {
  await runIsolatedSmoke();
  console.log(
    "Disposable PostgreSQL 18 native runtime, frontend, API, backup, and restore smoke passed.",
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  findPostgresBin,
  main,
  reservePort,
  runFile,
  runIsolatedSmoke,
};
