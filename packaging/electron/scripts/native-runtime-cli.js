#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createNativeRuntime } = require("../runtime/native");
const { createDockerSource } = require("../runtime/docker-source");
const {
  verifyNativeCutoverWorkflows,
} = require("../runtime/native-cutover-verifier");
const {
  runDockerToNativeCutover,
  verifyBackupDirectory,
  assertTransferToolCompatibility,
} = require("../runtime/importer");

function parseArgs(argv) {
  const [command = "preflight", ...rest] = argv;
  const values = {
    command,
    execute: false,
    acceptStaleDocker: false,
    externalPostgres: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--execute") values.execute = true;
    else if (arg === "--accept-stale-docker") values.acceptStaleDocker = true;
    else if (arg === "--external-postgres") values.externalPostgres = true;
    else if (arg.startsWith("--")) {
      const key = arg
        .slice(2)
        .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      const value = rest[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value`);
      values[key] = value;
      index += 1;
    } else throw new Error(`Unexpected argument: ${arg}`);
  }
  return values;
}

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      `http://127.0.0.1:${port}/health/detailed`,
      { timeout: 5_000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1024 * 1024)
            request.destroy(new Error("Native health response is too large"));
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(`Native health returned HTTP ${response.statusCode}`),
            );
            return;
          }
          const parsed = JSON.parse(body);
          if (!parsed || parsed.database?.connected !== true)
            reject(
              new Error("Native health did not confirm database readiness"),
            );
          else resolve();
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () =>
      request.destroy(new Error("Native health timeout")),
    );
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const userDataDir = path.resolve(
    args.userData ||
      path.join(os.homedir(), "Library", "Application Support", "Vision"),
  );
  const sourceDir = path.resolve(
    args.source || path.join(userDataDir, "embedded_compose"),
  );
  let appPort = Number(args.port || 3002);
  const settingsPath = path.join(userDataDir, "settings.json");
  try {
    const settings = JSON.parse(
      await fs.promises.readFile(settingsPath, "utf8"),
    );
    if (!args.port && Number.isInteger(settings.appPort))
      appPort = settings.appPort;
  } catch {
    // First install or corrupt settings: use the explicit/default port.
  }
  if (!Number.isInteger(appPort) || appPort < 1024 || appPort > 65535)
    throw new Error("Native application port is invalid");

  const nativeRuntime = createNativeRuntime({
    userDataDir,
    repoRoot,
    runtimeRoot: repoRoot,
    postgresRuntimeRoot: path.join(
      repoRoot,
      "packaging",
      "electron",
      "native-runtime",
    ),
    browserRuntimeRoot: path.join(
      repoRoot,
      "packaging",
      "electron",
      "native-runtime",
    ),
    alembicPath: path.join(
      repoRoot,
      "packaging",
      "electron",
      "native-runtime",
      "vision-alembic",
    ),
    allowExternalPostgres: args.externalPostgres,
    runtimeId: "vision",
    appPort: () => appPort,
  });
  const source = createDockerSource({ workDir: sourceDir });

  if (args.command === "preflight") {
    if (args.backup) await verifyBackupDirectory(args.backup);
    const nativeTools = await nativeRuntime.discover();
    await nativeRuntime.ensurePostgresReady();
    const sourceInfo = await source.assertAvailable();
    assertTransferToolCompatibility(nativeTools, sourceInfo);
    console.log(
      "Native cutover preflight passed. The native application writer was not started.",
    );
    return;
  }

  if (args.command === "cutover") {
    if (!args.execute)
      throw new Error(
        "Cutover is opt-in. Re-run with --execute after all tests pass.",
      );
    if (!args.backup)
      throw new Error("Cutover requires --backup <existing-directory>");
    const result = await runDockerToNativeCutover({
      source,
      nativeRuntime,
      backupPath: args.backup,
      frontendStatePath: args.frontendState,
      verifyNative: async () => {
        await requestHealth(appPort);
        await verifyNativeCutoverWorkflows({ port: appPort });
      },
    });
    console.log(
      `Native cutover complete. Final export: ${result.exportDir}. Database rows and attachments were verified.`,
    );
    return;
  }

  if (args.command === "rollback-stale-docker") {
    if (!args.acceptStaleDocker) {
      throw new Error(
        "Docker is stale after native writes. Pass --accept-stale-docker only to discard those later native writes; otherwise perform a reverse logical migration.",
      );
    }
    await nativeRuntime.stop();
    await nativeRuntime.writeState({
      activeRuntime: "docker",
      cutoverPhase: "rolled-back-to-stale-docker",
      rolledBackAt: new Date().toISOString(),
    });
    await source.startWriter();
    console.log(
      "Vision now selects the preserved Docker source. Native data was not deleted.",
    );
    return;
  }

  if (args.command === "handoff") {
    const state = await nativeRuntime.readState();
    if (
      state?.activeRuntime !== "native" ||
      state.cutoverInProgress === true ||
      state.cutoverPhase !== "complete"
    ) {
      throw new Error(
        "Native handoff requires a completed native cutover marker",
      );
    }
    await nativeRuntime.stop({ keepPostgres: true });
    console.log(
      "Native validation backend stopped. PostgreSQL remains ready for the packaged Vision application.",
    );
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});
