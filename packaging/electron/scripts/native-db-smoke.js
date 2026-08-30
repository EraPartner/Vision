#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createNativeRuntime,
  directoryFingerprint,
} = require("../runtime/native");
const { assertStatsEqual } = require("../runtime/importer");
const { resolveNativePayloadRoot } = require("./resolve-native-payload");

async function main() {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
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
    browserRuntimeRoot: nativePayloadRoot,
    alembicPath: path.join(nativePayloadRoot, "vision-alembic"),
    runtimeId,
    appPort: 3002,
    postgresPort: Number(process.env.VISION_POSTGRES_PORT || 54329),
  });
  let databaseSwitch;
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
    assertStatsEqual(before, after);
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

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});
