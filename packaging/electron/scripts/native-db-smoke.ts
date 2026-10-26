#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createNativeRuntime, directoryFingerprint } from "../runtime/native";
import { assertDatabaseStatsEqual } from "../runtime/database-stats";
import { appRoot } from "../paths";
import { resolveNativePayloadRoot } from "./resolve-native-payload";

async function main(): Promise<void> {
  const repoRoot = path.resolve(appRoot, "..", "..");
  const nativePayloadRoot = resolveNativePayloadRoot();
  const userDataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-native-db-smoke-"),
  );
  const runtimeId = `vision_smoke_${crypto.randomBytes(4).toString("hex")}`;
  const runtime = createNativeRuntime({
    userDataDir,
    repoRoot,
    runtimeRoot: repoRoot,
    postgresRuntimeRoot: nativePayloadRoot,
    runtimeId,
    appPort: 3002,
    postgresPort: Number(process.env.VISION_POSTGRES_PORT || 54329),
  });
  let databaseSwitch:
    Awaited<ReturnType<typeof runtime.activateRestoredDatabase>> | undefined;
  try {
    await runtime.ensureLayout();
    await runtime.assertNativeActive();
    await runtime.discover();
    await runtime.migrateDatabase();
    const attachment = path.join(runtime.paths.attachments, "smoke.txt");
    await fs.promises.writeFile(
      attachment,
      "synthetic native smoke attachment",
    );
    const attachmentBefore = await directoryFingerprint(
      runtime.paths.attachments,
    );
    const before = await runtime.getDatabaseStats();
    const dumpPath = path.join(userDataDir, "smoke.dump");
    await runtime.dumpDatabase(dumpPath, { format: "custom" });
    await runtime.validateCustomDump(dumpPath);

    databaseSwitch = await runtime.activateRestoredDatabase(dumpPath, {
      format: "custom",
      expectedSchemaHead: before.schema,
    });
    await runtime.migrateDatabase();
    const after = await runtime.getDatabaseStats();
    assertDatabaseStatsEqual(before, after);
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
      `Native PostgreSQL 18 database smoke passed. Synthetic database ${runtimeId} was preserved for inspection.`,
    );
  } catch (error) {
    if (databaseSwitch)
      await runtime
        .rollbackDatabaseSwitch(databaseSwitch.switchToken)
        .catch(() => {});
    throw error;
  } finally {
    await runtime.stop().catch(() => {});
  }
}

main().catch((error: unknown) => {
  console.error(
    typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string" &&
      error.message !== ""
      ? error.message
      : String(error),
  );
  process.exitCode = 1;
});
