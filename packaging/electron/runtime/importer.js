"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { directoryFingerprint, writeAtomicJson } = require("./native");
const {
  IMPORTANT_TABLES: COUNT_KEYS,
  assertDatabaseStatsEqual,
  assertStableDatabaseStatsEqual,
  databaseStatsManifest,
} = require("./database-stats");

function assertStatsEqual(expected, actual) {
  assertDatabaseStatsEqual(expected, actual);
}

function assertLiveStatsEqual(expected, actual) {
  assertStableDatabaseStatsEqual(expected, actual);
}

function assertTransferToolCompatibility(nativeTools, sourceInfo) {
  if (
    !Number.isInteger(sourceInfo?.serverVersionNum) ||
    !Number.isInteger(nativeTools?.versionNumbers?.pg_dump)
  ) {
    const error = new Error(
      "PostgreSQL source or pg_dump version could not be verified",
    );
    error.code = "POSTGRES_VERSION_UNVERIFIED";
    throw error;
  }
  if (nativeTools.versionNumbers.pg_dump < sourceInfo.serverVersionNum) {
    const error = new Error(
      "Native pg_dump is older than the Docker PostgreSQL source",
    );
    error.code = "POSTGRES_CLIENT_TOO_OLD";
    throw error;
  }
}

async function verifyBackupDirectory(backupPath) {
  const resolved = path.resolve(backupPath);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isDirectory())
    throw new Error("The configured Vision backup path is not a directory");
  await fs.promises.access(resolved, fs.constants.R_OK | fs.constants.W_OK);
  return resolved;
}

async function copyFrontendState(sourcePath, destinationPath) {
  if (!sourcePath) return false;
  const parsed = JSON.parse(await fs.promises.readFile(sourcePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || typeof parsed.keys !== "object")
    throw new Error("Frontend state export must contain a keys object");
  await fs.promises.copyFile(sourcePath, destinationPath);
  await fs.promises.chmod(destinationPath, 0o600);
  return true;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function recoverInterruptedCutover(nativeRuntime, source) {
  const state = await nativeRuntime.readState();
  if (state?.activeRuntime === "native" && state.cutoverInProgress !== true) {
    const error = new Error("Vision has already completed native cutover");
    error.code = "CUTOVER_ALREADY_COMPLETE";
    throw error;
  }
  if (state?.cutoverInProgress !== true) return;

  const recoveryErrors = [];
  await nativeRuntime
    .stop({ keepPostgres: true })
    .catch((error) => recoveryErrors.push(error));
  if (state.pendingAttachmentSwitch) {
    await nativeRuntime
      .rollbackAttachmentSwitch(state.pendingAttachmentSwitch)
      .catch((error) => recoveryErrors.push(error));
  }
  if (state.pendingDatabaseSwitch) {
    await nativeRuntime
      .rollbackDatabaseSwitch(state.pendingDatabaseSwitch)
      .catch((error) => recoveryErrors.push(error));
  }
  await nativeRuntime
    .writeState({
      activeRuntime: "docker",
      cutoverInProgress: false,
      cutoverPhase: "interrupted-recovered",
      cutoverRecoveredAt: new Date().toISOString(),
    })
    .catch((error) => recoveryErrors.push(error));
  await source.startWriter().catch((error) => recoveryErrors.push(error));
  if (recoveryErrors.length > 0) {
    const error = new Error(
      "Interrupted cutover recovery did not complete; native Vision remains stopped",
    );
    error.code = "CUTOVER_RECOVERY_FAILED";
    error.recoveryErrors = recoveryErrors;
    throw error;
  }
}

async function acquireCutoverLock(lockPath, nativeRuntime, source) {
  let lock;
  try {
    lock = await fs.promises.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let metadata;
    try {
      metadata = JSON.parse(await fs.promises.readFile(lockPath, "utf8"));
    } catch {
      const wrapped = new Error(
        "A cutover lock exists but cannot be safely attributed to a stopped process",
      );
      wrapped.code = "CUTOVER_LOCKED";
      throw wrapped;
    }
    if (processExists(metadata.pid)) {
      const wrapped = new Error("Another Vision native cutover is in progress");
      wrapped.code = "CUTOVER_LOCKED";
      throw wrapped;
    }
    await recoverInterruptedCutover(nativeRuntime, source);
    await fs.promises.unlink(lockPath);
    lock = await fs.promises.open(lockPath, "wx", 0o600);
  }
  await lock.writeFile(
    `${JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
  );
  return lock;
}

async function runDockerToNativeCutover({
  source,
  nativeRuntime,
  backupPath,
  frontendStatePath,
  verifyNative,
  now = () => new Date(),
}) {
  if (!source || !nativeRuntime)
    throw new Error(
      "Cutover requires Docker source and native runtime providers",
    );
  const backupRoot = await verifyBackupDirectory(backupPath);
  await nativeRuntime.ensureLayout();
  const nativeTools = await nativeRuntime.discover();
  await nativeRuntime.ensurePostgresReady();

  const lockPath = path.join(nativeRuntime.paths.nativeRoot, "cutover.lock");
  const lock = await acquireCutoverLock(lockPath, nativeRuntime, source);

  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const exportDir = path.join(backupRoot, `vision-native-cutover-${stamp}`);
  const dumpPath = path.join(exportDir, "final-postgres.dump");
  const attachmentsPath = path.join(exportDir, "attachments");
  let databaseSwitch;
  let attachmentSwitch;
  let sourceStopped = false;
  let nativeStarted = false;
  let cutoverBegan = false;

  try {
    const state = await nativeRuntime.readState();
    if (state?.activeRuntime === "native" && state.cutoverInProgress !== true) {
      const error = new Error("Vision has already completed native cutover");
      error.code = "CUTOVER_ALREADY_COMPLETE";
      throw error;
    }
    const sourceInfo = await source.assertAvailable();
    assertTransferToolCompatibility(nativeTools, sourceInfo);
    await fs.promises.mkdir(exportDir, { mode: 0o700 });
    await nativeRuntime.writeState({
      activeRuntime: "docker",
      cutoverInProgress: true,
      cutoverPhase: "source-freeze",
      cutoverStartedAt: now().toISOString(),
    });
    cutoverBegan = true;
    sourceStopped = true;
    await source.stopWriter();
    await source.assertWriterStopped();

    const sourceStats = await source.captureStats();
    const applicationEnv = source.readApplicationEnv
      ? await source.readApplicationEnv()
      : {};
    await nativeRuntime.importApplicationEnv(applicationEnv);
    await source.dumpCustom(dumpPath);
    await nativeRuntime.validateCustomDump(dumpPath);
    await source.exportAttachments(attachmentsPath);
    const sourceAttachments = await directoryFingerprint(attachmentsPath);
    const frontendStateIncluded = await copyFrontendState(
      frontendStatePath,
      path.join(exportDir, "frontend-state.json"),
    );
    await writeAtomicJson(path.join(exportDir, "manifest.json"), {
      version: 1,
      createdAt: now().toISOString(),
      sourcePostgresVersionNum: sourceInfo.serverVersionNum,
      database: databaseStatsManifest(sourceStats),
      attachments: {
        count: sourceAttachments.count,
        sha256: sourceAttachments.digest,
      },
      frontendStateIncluded,
      applicationEnvironmentKeysPreserved: Object.keys(applicationEnv).length,
    });

    databaseSwitch = await nativeRuntime.activateRestoredDatabase(dumpPath, {
      format: "custom",
      expectedSchemaHead: sourceStats.schema,
      allowUncutover: true,
    });
    const restoredStats = await nativeRuntime.getDatabaseStats();
    assertStatsEqual(sourceStats, restoredStats);
    attachmentSwitch = await nativeRuntime.replaceAttachments(attachmentsPath, {
      preservePrevious: true,
    });
    if (
      attachmentSwitch.count !== sourceAttachments.count ||
      attachmentSwitch.digest !== sourceAttachments.digest
    ) {
      const error = new Error("Native attachment verification mismatch");
      error.code = "ATTACHMENT_COUNT_MISMATCH";
      throw error;
    }

    await nativeRuntime.writeState({
      activeRuntime: "docker",
      cutoverInProgress: true,
      activation: "docker-import",
      cutoverPhase: "native-validation",
      sourceSchema: sourceStats.schema,
      sourcePostgresVersionNum: sourceInfo.serverVersionNum,
      sourceTableCount: sourceStats.tableCount,
      sourceTableCounts: sourceStats.tableCounts,
      sourceCounts: Object.fromEntries(
        COUNT_KEYS.map((key) => [key, sourceStats[key]]),
      ),
      sourceAttachmentCount: sourceAttachments.count,
      sourceAttachmentDigest: sourceAttachments.digest,
    });
    await nativeRuntime.start({ allowUncutover: true });
    nativeStarted = true;
    await nativeRuntime.waitUntilReady({ detailed: true });
    const liveStats = await nativeRuntime.getDatabaseStats();
    assertLiveStatsEqual(sourceStats, liveStats);
    if (verifyNative) await verifyNative({ sourceStats, liveStats, exportDir });

    // The source-checkout verifier and the packaged app intentionally use
    // different backend executables. Stop the verified source writer before
    // finalizing the marker so Electron can start its checksummed backend
    // without encountering a recorded-PID ownership mismatch. PostgreSQL stays
    // available and no second application writer is started during the handoff.
    await nativeRuntime.stop({ keepPostgres: true });
    nativeStarted = false;
    await source.stopStack();
    await nativeRuntime.finalizeDatabaseSwitch(databaseSwitch.switchToken);
    await nativeRuntime.finalizeAttachmentSwitch(attachmentSwitch);
    await nativeRuntime.writeState({
      activeRuntime: "native",
      cutoverInProgress: false,
      cutoverPhase: "complete",
      cutoverCompletedAt: now().toISOString(),
      rollbackWarning:
        "Docker is a stale rollback source after native writes. Reverse logical migration is required to preserve later writes.",
    });
    return {
      status: "complete",
      exportDir,
      counts: Object.fromEntries(
        COUNT_KEYS.map((key) => [key, sourceStats[key]]),
      ),
      attachmentCount: sourceAttachments.count,
      frontendStateIncluded,
    };
  } catch (error) {
    if (!cutoverBegan) throw error;
    if (nativeStarted)
      await nativeRuntime.stop({ keepPostgres: true }).catch(() => {});
    if (attachmentSwitch)
      await nativeRuntime
        .rollbackAttachmentSwitch(attachmentSwitch)
        .catch(() => {});
    if (databaseSwitch)
      await nativeRuntime
        .rollbackDatabaseSwitch(databaseSwitch.switchToken)
        .catch(() => {});
    await nativeRuntime
      .writeState({
        activeRuntime: "docker",
        cutoverInProgress: false,
        cutoverPhase: "failed",
        cutoverFailedAt: now().toISOString(),
      })
      .catch(() => {});
    if (sourceStopped) await source.startWriter().catch(() => {});
    throw error;
  } finally {
    await lock.close().catch(() => {});
    await fs.promises.unlink(lockPath).catch(() => {});
  }
}

module.exports = {
  COUNT_KEYS,
  assertStatsEqual,
  assertLiveStatsEqual,
  assertTransferToolCompatibility,
  verifyBackupDirectory,
  runDockerToNativeCutover,
};
