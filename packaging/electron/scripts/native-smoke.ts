#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { createNativeRuntime, directoryFingerprint } from "../runtime/native";
import {
  assertDatabaseStatsEqual,
  assertStableDatabaseStatsEqual,
} from "../runtime/database-stats";
import { createBundle, encryptBundle, openBundle } from "../backup/bundle";
import { restoreNativeBundle } from "../backup/native-transport";
import { appRoot } from "../paths";
import { resolveNativePayloadRoot } from "./resolve-native-payload";

type NativeRuntime = ReturnType<typeof createNativeRuntime>;
type NativeRuntimeOptions = Parameters<typeof createNativeRuntime>[0];
type AuditWitnessStore = NonNullable<NativeRuntimeOptions["auditWitness"]>;
type AuditWitnessRecord = Parameters<AuditWitnessStore["create"]>[0];
type DatabaseStats = Parameters<typeof assertDatabaseStatsEqual>[0];

/** The runtime methods the smoke restore wrapper intercepts. */
export interface SmokeRestorable {
  activateRestoredDatabase(...args: never[]): Promise<unknown>;
  start(...args: never[]): Promise<unknown>;
  rollbackDatabaseSwitch(...args: never[]): Promise<unknown>;
  getDatabaseStats(): Promise<DatabaseStats>;
}

export interface FrontendResponse {
  body: Buffer;
  headers: IncomingHttpHeaders;
}

export type FrontendRequester = (
  port: number,
  route: string,
) => Promise<FrontendResponse>;

type PassThrough = (...args: unknown[]) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads a nested JSON response field, like `value?.a?.b`. */
function field(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Bundle metadata is parsed JSON; createBundle always writes a string. */
function schemaHeadOf(metadata: unknown): string | undefined {
  const schemaHead = field(metadata, "schemaHead");
  return typeof schemaHead === "string" ? schemaHead : undefined;
}

function errorCode(error: unknown): unknown {
  return field(error, "code");
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
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

function syntheticAuditOptions() {
  let witness: AuditWitnessRecord | undefined;
  return {
    auditBridgeToken: crypto.randomBytes(32).toString("hex"),
    auditSafeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`synthetic-smoke:${value}`),
      decryptString: (value: Buffer) => {
        const encoded = value.toString();
        if (!encoded.startsWith("synthetic-smoke:"))
          throw new Error("Synthetic smoke audit key is invalid");
        return encoded.slice("synthetic-smoke:".length);
      },
    },
    auditWitness: {
      read: async () => witness && structuredClone(witness),
      create: async (value: AuditWitnessRecord) => {
        if (witness) throw new Error("Synthetic smoke witness exists");
        witness = structuredClone(value);
      },
      replace: async (value: AuditWitnessRecord) => {
        if (!witness) throw new Error("Synthetic smoke witness is missing");
        witness = structuredClone(value);
      },
    },
  };
}

function tableCounts(stats: DatabaseStats): Record<string, number> {
  return stats.tableCounts ?? {};
}

export function createSmokeRestoreRuntime<T extends SmokeRestorable>(
  runtime: T,
  expectedStats: DatabaseStats,
): T {
  let validateNextStart = false;
  // Pass-through calls keep `runtime` as the receiver, as the methods expect.
  const activate = (...args: unknown[]) =>
    (runtime.activateRestoredDatabase as PassThrough).apply(runtime, args);
  const start = (...args: unknown[]) =>
    (runtime.start as PassThrough).apply(runtime, args);
  const rollback = (...args: unknown[]) =>
    (runtime.rollbackDatabaseSwitch as PassThrough).apply(runtime, args);
  return {
    ...runtime,
    async activateRestoredDatabase(...args: unknown[]) {
      validateNextStart = false;
      const restored = await activate(...args);
      // Let the transport retain its rollback token before checking the
      // stopped database. Startup may then write provider/cache telemetry.
      validateNextStart = true;
      return restored;
    },
    async start(...args: unknown[]) {
      if (validateNextStart) {
        validateNextStart = false;
        const restoredStats = await runtime.getDatabaseStats();
        try {
          assertDatabaseStatsEqual(expectedStats, restoredStats);
        } catch (error) {
          if (errorCode(error) === "DATABASE_COUNT_MISMATCH") {
            const expectedCounts = tableCounts(expectedStats);
            const restoredCounts = tableCounts(restoredStats);
            console.error(
              "Synthetic smoke count mismatch:",
              Object.keys(expectedCounts)
                .filter(
                  (table) => expectedCounts[table] !== restoredCounts[table],
                )
                .map((table) => ({
                  table,
                  before: expectedCounts[table],
                  after: restoredCounts[table],
                })),
            );
          }
          throw error;
        }
      }
      return start(...args);
    },
    async rollbackDatabaseSwitch(...args: unknown[]) {
      // Attachment replacement can fail before the one-shot start check.
      // Restarting the original database must never compare it to the bundle.
      validateNextStart = false;
      return rollback(...args);
    },
  };
}

function requestJson(
  port: number,
  method: string,
  route: string,
  payload?: unknown,
): Promise<unknown> {
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
        response.on("data", (chunk: string) => {
          responseBody += chunk;
          if (responseBody.length > 1024 * 1024)
            request.destroy(new Error("Smoke-test response is too large"));
        });
        response.on("end", () => {
          if (isUnsuccessful(response.statusCode)) {
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

function isUnsuccessful(statusCode: number | undefined): boolean {
  return statusCode !== undefined && (statusCode < 200 || statusCode >= 300);
}

export function requestBuffer(
  port: number,
  route: string,
  { acceptEncoding = "gzip" }: { acceptEncoding?: string } = {},
): Promise<FrontendResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
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
        response.on("data", (chunk: Buffer) => {
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
          if (isUnsuccessful(response.statusCode)) {
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

export function decodeFrontendBody(response: FrontendResponse): Buffer {
  const encoding = String(response.headers["content-encoding"] || "").trim();
  if (!encoding) return response.body;
  if (encoding === "gzip") return gunzipSync(response.body);
  throw new Error(`Unsupported frontend content encoding: ${encoding}`);
}

export async function verifyFrontendAssets(
  port: number,
  requester: FrontendRequester = requestBuffer,
): Promise<void> {
  const shellResponse = await requester(port, "/");
  const shellType = String(shellResponse.headers["content-type"] || "");
  if (!shellType.includes("text/html"))
    throw new Error("Native frontend shell did not return HTML");
  const shell = decodeFrontendBody(shellResponse).toString("utf8");
  const entryPath = shell.match(
    /<script\b[^>]*\bsrc=["'](\/assets\/[A-Za-z0-9_.-]+\.js)["'][^>]*>/i,
  )?.[1];
  if (!entryPath)
    throw new Error("Native frontend shell has no packaged JavaScript entry");

  const entryResponse = await requester(port, entryPath);
  const entryType = String(entryResponse.headers["content-type"] || "");
  if (!/(?:java|ecma)script/i.test(entryType))
    throw new Error("Native frontend entry has an invalid content type");
  if (entryResponse.headers["content-encoding"] !== "gzip")
    throw new Error("Native frontend entry did not exercise gzip delivery");
  const entry = decodeFrontendBody(entryResponse);
  if (entry.length === 0 || entry.subarray(0, 1).toString() === "<")
    throw new Error("Native frontend entry did not decode as JavaScript");
}

export function parseSmokeArgs(argv: readonly string[]): { cleanup: boolean } {
  if (argv.length === 0) return { cleanup: false };
  if (argv.length === 1 && argv[0] === "--cleanup") return { cleanup: true };
  throw new Error("Native smoke accepts only the optional --cleanup flag");
}

export async function cleanupSmokeUserData(
  userDataDir: string,
  enabled: boolean,
  succeeded = true,
): Promise<boolean> {
  if (!enabled || !succeeded) return false;
  await fs.promises.rm(userDataDir, { recursive: true, force: true });
  return true;
}

export function sanitizeSmokeDiagnostic(value: unknown): string {
  return String(value || "")
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, "[redacted database URL]")
    .replace(
      /\b(PGPASSWORD|DATABASE_URL|MIGRATION_DATABASE_URL|password|passphrase)\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[redacted]",
    );
}

export async function readSmokeLogTail(
  logPath: string,
  maxBytes = 8192,
): Promise<string> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(logPath, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    if (length === 0) return "";
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return sanitizeSmokeDiagnostic(buffer.toString("utf8")).trim();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "";
    return `Unable to read the synthetic PostgreSQL log: ${sanitizeSmokeDiagnostic(field(error, "message"))}`;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function selectSmokeRuntimeRoot({
  nativePayloadRoot,
  repoRoot,
  packagedPayload = process.env.VISION_SMOKE_PACKAGED_PAYLOAD === "true" ||
    (process.env.VISION_SMOKE_PACKAGED_PAYLOAD === undefined &&
      process.env.VISION_NATIVE_PAYLOAD_ROOT !== undefined),
}: {
  nativePayloadRoot: string;
  repoRoot: string;
  packagedPayload?: boolean;
}): { requireRuntimeManifest: boolean; runtimeRoot: string } {
  return {
    requireRuntimeManifest: packagedPayload,
    runtimeRoot: packagedPayload ? nativePayloadRoot : repoRoot,
  };
}

export async function main(): Promise<void> {
  const { cleanup } = parseSmokeArgs(process.argv.slice(2));
  const repoRoot = path.resolve(appRoot, "..", "..");
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
    requireRuntimeManifest,
    runtimeId,
    appPort: () => port,
    postgresPort: Number(process.env.VISION_POSTGRES_PORT || 54329),
    syntheticOffline: true,
    ...syntheticAuditOptions(),
  });
  let transferTarget: NativeRuntime | undefined;
  let transferTargetDir: string | undefined;
  let failure: unknown;
  try {
    await runtime.start();
    await runtime.waitUntilReady({ detailed: true });
    const auditAtStart = await runtime.verifyAuditHistory({
      establishSession: true,
    });
    if (auditAtStart.status !== "verified")
      throw new Error("Synthetic native audit enrollment failed");
    await verifyFrontendAssets(port);
    const initialServices = await requestJson(
      port,
      "GET",
      "/api/settings/services_settings",
    );
    await requestJson(port, "PUT", "/api/settings/services_settings", {
      expected: field(initialServices, "data", "expected"),
      value: { keepServicesOnQuit: false },
    });
    const readBack = await requestJson(
      port,
      "GET",
      "/api/settings/services_settings",
    );
    if (field(readBack, "data", "value", "keepServicesOnQuit") !== false)
      throw new Error("Native API write/read round trip failed");

    const syntheticAccountName = "Native smoke account";
    const syntheticAccount = await requestJson(port, "POST", "/api/accounts", {
      name: syntheticAccountName,
      display_name: "Native smoke original",
      currency: "EUR",
    });
    const accountId = field(syntheticAccount, "data", "id");
    if (!Number.isInteger(accountId))
      throw new Error("Native smoke account creation failed");
    const syntheticRecipient = await requestJson(
      port,
      "POST",
      "/api/recipients",
      { name: "Native smoke recipient" },
    );
    const recipientId = field(syntheticRecipient, "data", "id");
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
    const transactionId = field(syntheticTransaction, "data", "id");
    if (!Number.isInteger(transactionId))
      throw new Error("Native smoke transaction creation failed");
    const originalTransactionMemo = field(syntheticTransaction, "data", "memo");
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
      expected: field(readBack, "data", "expected"),
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
      await restoreNativeBundle(createSmokeRestoreRuntime(runtime, before), {
        dbSqlPath: opened.dbSqlPath,
        attachmentsDir: opened.attachmentsDir,
        expectedSchemaHead: schemaHeadOf(opened.metadata),
      });
    } finally {
      opened.cleanup();
    }

    const after = await runtime.getDatabaseStats();
    assertStableDatabaseStatsEqual(before, after);
    const restoredSettings = await requestJson(
      port,
      "GET",
      "/api/settings/services_settings",
    );
    if (
      field(restoredSettings, "data", "value", "keepServicesOnQuit") !== false
    )
      throw new Error("Native bundle database state was not restored");
    const restoredAccount = await requestJson(
      port,
      "GET",
      `/api/accounts/${accountId}`,
    );
    const restoredAccountData = field(restoredAccount, "data");
    if (
      field(restoredAccountData, "name") !== syntheticAccountName ||
      field(restoredAccountData, "display_name") !== "Native smoke original" ||
      field(restoredAccountData, "currency") !== "EUR"
    )
      throw new Error("Native bundle account state was not restored");
    const restoredTransaction = await requestJson(
      port,
      "GET",
      `/api/transactions/${transactionId}`,
    );
    const restoredTransactionData = field(restoredTransaction, "data");
    if (
      field(restoredTransactionData, "transaction_date") !== "2026-01-15" ||
      field(restoredTransactionData, "bank_account") !== syntheticAccountName ||
      field(restoredTransactionData, "recipient_id") !== recipientId ||
      field(restoredTransactionData, "amount") !== -42.5 ||
      field(restoredTransactionData, "currency") !== "EUR" ||
      field(restoredTransactionData, "memo") !== originalTransactionMemo
    )
      throw new Error(
        `Native bundle transaction state was not restored: ${JSON.stringify({
          transaction_date: field(restoredTransactionData, "transaction_date"),
          bank_account: field(restoredTransactionData, "bank_account"),
          recipient_id: field(restoredTransactionData, "recipient_id"),
          amount: field(restoredTransactionData, "amount"),
          currency: field(restoredTransactionData, "currency"),
          memo: field(restoredTransactionData, "memo"),
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
        expectedSchemaHead: schemaHeadOf(transferredBundle.metadata),
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
    if (field(movedAccount, "data", "display_name") !== "Native smoke original")
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
          expectedSchemaHead: schemaHeadOf(openedTampered.metadata),
        });
      } catch (error) {
        if (errorCode(error) !== "RESTORED_AUDIT_INTEGRITY_FAILED") throw error;
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
      const logs: [string, string][] = [
        ["PostgreSQL", runtime.paths.postgresLog],
        ["backend", runtime.paths.backendLog],
      ];
      for (const [label, logPath] of logs) {
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
  main().catch((error: unknown) => {
    const message = field(error, "message");
    console.error(error && message ? String(message) : String(error));
    process.exitCode = 1;
  });
}
