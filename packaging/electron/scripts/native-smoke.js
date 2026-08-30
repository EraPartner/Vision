#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  createNativeRuntime,
  directoryFingerprint,
} = require("../runtime/native");
const {
  assertStatsEqual,
  assertLiveStatsEqual,
} = require("../runtime/importer");
const { resolveNativePayloadRoot } = require("./resolve-native-payload");

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function requestJson(port, method, route, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        timeout: 10_000,
        headers: body
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            }
          : undefined,
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
          if (responseBody.length > 1024 * 1024)
            request.destroy(new Error("Smoke-test response is too large"));
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `Smoke-test request returned HTTP ${response.statusCode}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () =>
      request.destroy(new Error("Smoke-test request timed out")),
    );
    if (body) request.write(body);
    request.end();
  });
}

function parseSmokeArgs(argv) {
  if (argv.length === 0) return { cleanup: false };
  if (argv.length === 1 && argv[0] === "--cleanup") return { cleanup: true };
  throw new Error("Native smoke accepts only the optional --cleanup flag");
}

async function cleanupSmokeUserData(userDataDir, enabled, succeeded = true) {
  if (!enabled || !succeeded) return false;
  await fs.promises.rm(userDataDir, { recursive: true, force: true });
  return true;
}

function sanitizeSmokeDiagnostic(value) {
  return String(value || "")
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, "[redacted database URL]")
    .replace(
      /\b(PGPASSWORD|DATABASE_URL|MIGRATION_DATABASE_URL|password|passphrase)\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[redacted]",
    );
}

async function readSmokeLogTail(logPath, maxBytes = 8192) {
  let handle;
  try {
    handle = await fs.promises.open(logPath, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    if (length === 0) return "";
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return sanitizeSmokeDiagnostic(buffer.toString("utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    return `Unable to read the synthetic PostgreSQL log: ${sanitizeSmokeDiagnostic(error?.message)}`;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function selectSmokeRuntimeRoot({
  nativePayloadRoot,
  repoRoot,
  packagedPayload = process.env.VISION_SMOKE_PACKAGED_PAYLOAD === "true" ||
    (process.env.VISION_SMOKE_PACKAGED_PAYLOAD === undefined &&
      process.env.VISION_NATIVE_PAYLOAD_ROOT !== undefined),
}) {
  return {
    requireRuntimeManifest: packagedPayload,
    runtimeRoot: packagedPayload ? nativePayloadRoot : repoRoot,
  };
}

async function main() {
  const { cleanup } = parseSmokeArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const nativePayloadRoot = resolveNativePayloadRoot();
  const { requireRuntimeManifest, runtimeRoot } = selectSmokeRuntimeRoot({
    nativePayloadRoot,
    repoRoot,
  });
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-smoke-"),
  );
  const runtimeId = `vision_smoke_${crypto.randomBytes(4).toString("hex")}`;
  const port = await reservePort();
  const runtime = createNativeRuntime({
    userDataDir,
    repoRoot,
    runtimeRoot,
    postgresRuntimeRoot: nativePayloadRoot,
    browserRuntimeRoot: nativePayloadRoot,
    alembicPath: path.join(nativePayloadRoot, "vision-alembic"),
    requireRuntimeManifest,
    runtimeId,
    appPort: () => port,
    postgresPort: Number(process.env.VISION_POSTGRES_PORT || 54329),
  });
  let databaseSwitch;
  let failure;
  try {
    await runtime.start();
    await runtime.waitUntilReady({ detailed: true });
    await requestJson(port, "PUT", "/api/settings/services_settings", {
      value: { keepServicesOnQuit: false },
    });
    const readBack = await requestJson(
      port,
      "GET",
      "/api/settings/services_settings",
    );
    if (readBack?.data?.value?.keepServicesOnQuit !== false)
      throw new Error("Native API write/read round trip failed");

    const attachment = path.join(runtime.paths.attachments, "smoke.txt");
    await fs.promises.writeFile(
      attachment,
      "synthetic native smoke attachment",
    );
    const attachmentBefore = await directoryFingerprint(
      runtime.paths.attachments,
    );
    // Freeze the only synthetic writer before measuring and dumping. The
    // restore proof must compare one stable source snapshot, not race startup
    // cache refreshes such as exchange_rates.
    await runtime.stop({ keepPostgres: true });
    const before = await runtime.getDatabaseStats();
    const dumpPath = path.join(userDataDir, "smoke.dump");
    await runtime.dumpDatabase(dumpPath, { format: "custom" });
    await runtime.validateCustomDump(dumpPath);

    databaseSwitch = await runtime.activateRestoredDatabase(dumpPath, {
      format: "custom",
      expectedSchemaHead: before.schema,
    });
    const restored = await runtime.getDatabaseStats();
    assertStatsEqual(before, restored);
    await runtime.start();
    await runtime.waitUntilReady({ detailed: true });
    const after = await runtime.getDatabaseStats();
    assertLiveStatsEqual(before, after);
    const attachmentAfter = await directoryFingerprint(
      runtime.paths.attachments,
    );
    if (
      attachmentAfter.count !== attachmentBefore.count ||
      attachmentAfter.digest !== attachmentBefore.digest
    ) {
      throw new Error(
        "Native attachment fingerprint changed during database restore",
      );
    }
    await runtime.finalizeDatabaseSwitch(databaseSwitch.switchToken);
    console.log(
      cleanup
        ? `Native PostgreSQL 18 smoke passed on loopback port ${port}. Synthetic data was removed.`
        : `Native PostgreSQL 18 smoke passed on loopback port ${port}. Synthetic database ${runtimeId} was preserved for inspection.`,
    );
  } catch (error) {
    if (databaseSwitch)
      await runtime
        .rollbackDatabaseSwitch(databaseSwitch.switchToken)
        .catch(() => {});
    failure = error;
  } finally {
    await runtime.stop().catch(() => {});
    if (failure) {
      for (const [label, logPath] of [
        ["PostgreSQL", runtime.paths.postgresLog],
        ["backend", runtime.paths.backendLog],
      ]) {
        const log = await readSmokeLogTail(logPath);
        if (log) console.error(`Synthetic ${label} log (sanitized):\n${log}`);
      }
      if (cleanup) {
        console.error(
          `Synthetic smoke diagnostics were retained at ${userDataDir}`,
        );
      }
    }
    await cleanupSmokeUserData(userDataDir, cleanup, !failure);
  }
  if (failure) throw failure;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  cleanupSmokeUserData,
  main,
  parseSmokeArgs,
  readSmokeLogTail,
  sanitizeSmokeDiagnostic,
  selectSmokeRuntimeRoot,
};
