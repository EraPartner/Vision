#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");

const {
  createNativeRuntime,
  directoryFingerprint,
} = require("../runtime/native");
const {
  assertDatabaseStatsEqual,
  assertStableDatabaseStatsEqual,
} = require("../runtime/database-stats");
const { createBundle, encryptBundle, openBundle } = require("../backup/bundle");
const { restoreNativeBundle } = require("../backup/native-transport");
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

function syntheticAuditOptions() {
  let witness;
  return {
    auditBridgeToken: crypto.randomBytes(32).toString("hex"),
    auditSafeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`synthetic-smoke:${value}`),
      decryptString: (value) => {
        const encoded = value.toString();
        if (!encoded.startsWith("synthetic-smoke:"))
          throw new Error("Synthetic smoke audit key is invalid");
        return encoded.slice("synthetic-smoke:".length);
      },
    },
    auditWitness: {
      read: async () => witness && structuredClone(witness),
      create: async (value) => {
        if (witness) throw new Error("Synthetic smoke witness exists");
        witness = structuredClone(value);
      },
      replace: async (value) => {
        if (!witness) throw new Error("Synthetic smoke witness is missing");
        witness = structuredClone(value);
      },
    },
  };
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

function requestBuffer(port, route, { acceptEncoding = "gzip" } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        timeout: 10_000,
        headers: { "Accept-Encoding": acceptEncoding },
      },
      (response) => {
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            request.destroy(
              new Error("Smoke-test frontend response is too large"),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `Smoke-test frontend request returned HTTP ${response.statusCode}`,
              ),
            );
            return;
          }
          resolve({
            body: Buffer.concat(chunks),
            headers: response.headers,
          });
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () =>
      request.destroy(new Error("Smoke-test frontend request timed out")),
    );
  });
}

function decodeFrontendBody(response) {
  const encoding = String(response.headers["content-encoding"] || "").trim();
  if (!encoding) return response.body;
  if (encoding === "gzip") return gunzipSync(response.body);
  throw new Error(`Unsupported frontend content encoding: ${encoding}`);
}

async function verifyFrontendAssets(port, requester = requestBuffer) {
  const shellResponse = await requester(port, "/");
  const shellType = String(shellResponse.headers["content-type"] || "");
  if (!shellType.includes("text/html"))
    throw new Error("Native frontend shell did not return HTML");
  const shell = decodeFrontendBody(shellResponse).toString("utf8");
  const entryMatch = shell.match(
    /<script\b[^>]*\bsrc=["'](\/assets\/[A-Za-z0-9_.-]+\.js)["'][^>]*>/i,
  );
  if (!entryMatch)
    throw new Error("Native frontend shell has no packaged JavaScript entry");

  const entryResponse = await requester(port, entryMatch[1]);
  const entryType = String(entryResponse.headers["content-type"] || "");
  if (!/(?:java|ecma)script/i.test(entryType))
    throw new Error("Native frontend entry has an invalid content type");
  if (entryResponse.headers["content-encoding"] !== "gzip")
    throw new Error("Native frontend entry did not exercise gzip delivery");
  const entry = decodeFrontendBody(entryResponse);
  if (entry.length === 0 || entry.subarray(0, 1).toString() === "<")
    throw new Error("Native frontend entry did not decode as JavaScript");
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
    syntheticOffline: true,
    ...syntheticAuditOptions(),
  });
  let transferTarget;
  let transferTargetDir;
  let failure;
  try {
    await runtime.start();
    await runtime.waitUntilReady({ detailed: true });
    const auditAtStart = await runtime.verifyAuditHistory({
      establishSession: true,
    });
    if (auditAtStart.status !== "verified")
      throw new Error("Synthetic native audit enrollment failed");
    await verifyFrontendAssets(port);
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

    const syntheticAccountName = "Native smoke account";
    const syntheticAccount = await requestJson(port, "POST", "/api/accounts", {
      name: syntheticAccountName,
      display_name: "Native smoke original",
      currency: "EUR",
    });
    const accountId = syntheticAccount?.data?.id;
    if (!Number.isInteger(accountId))
      throw new Error("Native smoke account creation failed");
    const syntheticRecipient = await requestJson(
      port,
      "POST",
      "/api/recipients",
      { name: "Native smoke recipient" },
    );
    const recipientId = syntheticRecipient?.data?.id;
    if (!Number.isInteger(recipientId))
      throw new Error("Native smoke recipient creation failed");
    const syntheticTransaction = await requestJson(
      port,
      "POST",
      "/api/transactions",
      {
        transaction_date: "2026-01-15",
        account_id: accountId,
        recipient_id: recipientId,
        amount: -42.5,
        currency: "EUR",
        memo: "Native smoke original transaction",
      },
    );
    const transactionId = syntheticTransaction?.data?.id;
    if (!Number.isInteger(transactionId))
      throw new Error("Native smoke transaction creation failed");
    const originalTransactionMemo = syntheticTransaction?.data?.memo;
    if (typeof originalTransactionMemo !== "string")
      throw new Error("Native smoke transaction readback failed");

    const attachment = path.join(runtime.paths.attachments, "smoke.txt");
    await fs.promises.writeFile(
      attachment,
      "synthetic native smoke attachment",
    );
    const frontendState = {
      keys: {
        "vision.language": "nl",
        "vision.theme": "dark",
      },
    };
    // Freeze the only synthetic writer before creating the bundle. The
    // restore proof must compare one stable source snapshot, not race startup
    // cache refreshes such as exchange_rates.
    await runtime.stop({ keepPostgres: true });
    const before = await runtime.getDatabaseStats();
    const bundleInputDir = path.join(userDataDir, "bundle-input");
    const bundleOutputDir = path.join(userDataDir, "backups");
    const dbSqlPath = path.join(bundleInputDir, "db.sql");
    const attachmentsDir = path.join(bundleInputDir, "attachments");
    await fs.promises.mkdir(bundleInputDir, { recursive: true, mode: 0o700 });
    await runtime.dumpDatabase(dbSqlPath, { format: "plain" });
    await runtime.exportAttachments(attachmentsDir);
    const { bundlePath } = await createBundle({
      destDir: bundleOutputDir,
      deviceId: "native-smoke",
      schemaHead: before.schema,
      appVersion: "native-smoke",
      dbSqlPath,
      attachmentsDir,
      frontendState,
    });
    const passphrase = crypto.randomBytes(24).toString("base64url");
    const { encPath } = await encryptBundle(bundlePath, passphrase);

    // Prove restore replaces changed state rather than merely accepting an
    // already-identical database and attachment tree.
    await runtime.start();
    await runtime.waitUntilReady({ detailed: true });
    await requestJson(port, "PUT", "/api/settings/services_settings", {
      value: { keepServicesOnQuit: true },
    });
    await requestJson(port, "PATCH", `/api/accounts/${accountId}`, {
      display_name: "Native smoke mutated",
    });
    await requestJson(port, "PATCH", `/api/transactions/${transactionId}`, {
      memo: "Native smoke mutated transaction",
    });
    await fs.promises.writeFile(attachment, "post-backup mutation");
    await runtime.stop({ keepPostgres: true });

    const opened = await openBundle(encPath, { passphrase });
    try {
      if (opened.metadata.schemaHead !== before.schema)
        throw new Error("Native bundle schema revision changed");
      if (
        JSON.stringify(opened.frontendState) !== JSON.stringify(frontendState)
      )
        throw new Error("Native bundle frontend state changed");
      await restoreNativeBundle(runtime, {
        dbSqlPath: opened.dbSqlPath,
        attachmentsDir: opened.attachmentsDir,
        expectedSchemaHead: opened.metadata.schemaHead,
      });
    } finally {
      opened.cleanup();
    }

    const after = await runtime.getDatabaseStats();
    try {
      assertDatabaseStatsEqual(before, after);
    } catch (error) {
      if (error.code === "DATABASE_COUNT_MISMATCH") {
        console.error(
          "Synthetic smoke count mismatch:",
          Object.keys(before.tableCounts)
            .filter(
              (table) => before.tableCounts[table] !== after.tableCounts[table],
            )
            .map((table) => ({
              table,
              before: before.tableCounts[table],
              after: after.tableCounts[table],
            })),
        );
      }
      throw error;
    }
    assertStableDatabaseStatsEqual(before, after);
    const restoredSettings = await requestJson(
      port,
      "GET",
      "/api/settings/services_settings",
    );
    if (restoredSettings?.data?.value?.keepServicesOnQuit !== false)
      throw new Error("Native bundle database state was not restored");
    const restoredAccount = await requestJson(
      port,
      "GET",
      `/api/accounts/${accountId}`,
    );
    if (
      restoredAccount?.data?.name !== syntheticAccountName ||
      restoredAccount?.data?.display_name !== "Native smoke original" ||
      restoredAccount?.data?.currency !== "EUR"
    )
      throw new Error("Native bundle account state was not restored");
    const restoredTransaction = await requestJson(
      port,
      "GET",
      `/api/transactions/${transactionId}`,
    );
    if (
      restoredTransaction?.data?.transaction_date !== "2026-01-15" ||
      restoredTransaction?.data?.bank_account !== syntheticAccountName ||
      restoredTransaction?.data?.recipient_id !== recipientId ||
      restoredTransaction?.data?.amount !== -42.5 ||
      restoredTransaction?.data?.currency !== "EUR" ||
      restoredTransaction?.data?.memo !== originalTransactionMemo
    )
      throw new Error(
        `Native bundle transaction state was not restored: ${JSON.stringify({
          transaction_date: restoredTransaction?.data?.transaction_date,
          bank_account: restoredTransaction?.data?.bank_account,
          recipient_id: restoredTransaction?.data?.recipient_id,
          amount: restoredTransaction?.data?.amount,
          currency: restoredTransaction?.data?.currency,
          memo: restoredTransaction?.data?.memo,
        })}`,
      );
    const attachmentAfter = await directoryFingerprint(
      runtime.paths.attachments,
    );
    const restoredAttachment = await fs.promises.readFile(attachment, "utf8");
    if (
      attachmentAfter.count !== 1 ||
      restoredAttachment !== "synthetic native smoke attachment"
    )
      throw new Error("Native bundle attachment state was not restored");

    const transferPassword = crypto.randomBytes(24).toString("base64url");
    const transfer =
      await runtime.exportProtectedAuditTransfer(transferPassword);
    await runtime.stop({ keepPostgres: true });
    transferTargetDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "vision-audit-transfer-smoke-"),
    );
    const transferPort = await reservePort();
    transferTarget = createNativeRuntime({
      userDataDir: transferTargetDir,
      repoRoot,
      runtimeRoot,
      postgresRuntimeRoot: nativePayloadRoot,
      browserRuntimeRoot: nativePayloadRoot,
      alembicPath: path.join(nativePayloadRoot, "vision-alembic"),
      requireRuntimeManifest,
      runtimeId: `vision_transfer_${crypto.randomBytes(4).toString("hex")}`,
      appPort: () => transferPort,
      postgresPort: await reservePort(),
      ...syntheticAuditOptions(),
    });
    await transferTarget.start();
    await transferTarget.waitUntilReady({ detailed: true });
    const freshAudit = await transferTarget.verifyAuditHistory({
      establishSession: true,
    });
    if (freshAudit.status !== "verified")
      throw new Error("Synthetic transfer target enrollment failed");
    await transferTarget.importProtectedAuditTransfer(
      transfer,
      transferPassword,
    );
    await transferTarget.stop({ keepPostgres: true });
    const transferredBundle = await openBundle(encPath, { passphrase });
    try {
      await restoreNativeBundle(transferTarget, {
        dbSqlPath: transferredBundle.dbSqlPath,
        attachmentsDir: transferredBundle.attachmentsDir,
        expectedSchemaHead: transferredBundle.metadata.schemaHead,
      });
    } finally {
      transferredBundle.cleanup();
    }
    if ((await transferTarget.verifyAuditHistory()).status !== "verified")
      throw new Error("Transferred audit checkpoint did not verify backup");
    const movedAccount = await requestJson(
      transferPort,
      "GET",
      `/api/accounts/${accountId}`,
    );
    if (movedAccount?.data?.display_name !== "Native smoke original")
      throw new Error("Device-move backup data was not restored");

    const tamperedSqlPath = path.join(transferTargetDir, "tampered-db.sql");
    const originalSql = await fs.promises.readFile(dbSqlPath, "utf8");
    await fs.promises.writeFile(
      tamperedSqlPath,
      `${originalSql}\nALTER TABLE public.audit_chain_entries DISABLE TRIGGER audit_chain_entries_immutable;\nUPDATE public.audit_chain_entries SET payload = '{"stream":"synthetic_tamper"}'::jsonb WHERE sequence = (SELECT min(sequence) FROM public.audit_chain_entries);\nALTER TABLE public.audit_chain_entries ENABLE TRIGGER audit_chain_entries_immutable;\n`,
      { mode: 0o600 },
    );
    const tamperedBundle = await createBundle({
      destDir: path.join(transferTargetDir, "tampered-backups"),
      deviceId: "native-smoke-tampered",
      schemaHead: before.schema,
      appVersion: "native-smoke",
      dbSqlPath: tamperedSqlPath,
      attachmentsDir,
      frontendState,
    });
    const tamperedEncrypted = await encryptBundle(
      tamperedBundle.bundlePath,
      passphrase,
    );
    await transferTarget.stop({ keepPostgres: true });
    const openedTampered = await openBundle(tamperedEncrypted.encPath, {
      passphrase,
    });
    try {
      let rejected = false;
      try {
        await restoreNativeBundle(transferTarget, {
          dbSqlPath: openedTampered.dbSqlPath,
          attachmentsDir: openedTampered.attachmentsDir,
          expectedSchemaHead: openedTampered.metadata.schemaHead,
        });
      } catch (error) {
        if (error.code !== "RESTORED_AUDIT_INTEGRITY_FAILED") throw error;
        rejected = true;
      }
      if (!rejected)
        throw new Error("Tampered synthetic backup passed audit restore");
    } finally {
      openedTampered.cleanup();
    }
    await transferTarget.waitUntilReady({ detailed: true });
    if ((await transferTarget.verifyAuditHistory()).status !== "verified")
      throw new Error(
        "Tampered restore did not preserve the original audit state",
      );
    console.log(
      cleanup
        ? `Native PostgreSQL 18 smoke passed on loopback port ${port}. Synthetic data was removed.`
        : `Native PostgreSQL 18 smoke passed on loopback port ${port}. Synthetic database ${runtimeId} was preserved for inspection.`,
    );
  } catch (error) {
    failure = error;
  } finally {
    await transferTarget?.stop().catch(() => {});
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
    if (transferTargetDir) {
      if (failure && cleanup)
        console.error(
          `Synthetic transfer diagnostics were retained at ${transferTargetDir}`,
        );
      await cleanupSmokeUserData(transferTargetDir, cleanup, !failure);
    }
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
  decodeFrontendBody,
  main,
  parseSmokeArgs,
  readSmokeLogTail,
  requestBuffer,
  sanitizeSmokeDiagnostic,
  selectSmokeRuntimeRoot,
  verifyFrontendAssets,
};
