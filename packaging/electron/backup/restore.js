"use strict";

const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const {
  createBundle,
  encryptBundle,
  openBundle,
  isBundleEncrypted,
} = require("./bundle");
const {
  getBackupDeviceId,
  getBackupPassphrase,
  cleanupOldBackups,
  isEncryptedBackupFile,
  decryptBackupFileToTemp,
  ERR_PASSPHRASE_REQUIRED,
  ERR_INVALID_PASSPHRASE,
} = require("./crypto");
const {
  restoreNativeBundle,
  restoreNativeDatabase,
} = require("./native-transport");

let ctx = {};

function init(context) {
  ctx = context;
}

function getNativeRuntime() {
  const runtime =
    typeof ctx.runtimeProvider === "function" ? ctx.runtimeProvider() : null;
  if (runtime?.mode !== "native") {
    const error = new Error(
      "Vision backup and restore require the native runtime",
    );
    error.code = "NATIVE_RUNTIME_REQUIRED";
    throw error;
  }
  return runtime;
}

async function resolveDatabaseEnvironment() {
  return { nativeRuntime: getNativeRuntime() };
}

function revisionNumericPrefix(rev) {
  const match = /^(\d+)/.exec(String(rev || ""));
  return match ? parseInt(match[1], 10) : null;
}

function getLocalMigrationChainHead() {
  try {
    const versionsDir = path.join(
      ctx.workDir?.() || ctx.repoRootFallback,
      "alembic",
      "versions",
    );
    let best = "";
    for (const filename of fs.readdirSync(versionsDir)) {
      if (!filename.endsWith(".py") || filename.startsWith("_")) continue;
      const revision = filename.slice(0, -3);
      const candidate = revisionNumericPrefix(revision);
      const current = revisionNumericPrefix(best);
      if (candidate != null && (current == null || candidate > current))
        best = revision;
    }
    return best;
  } catch {
    return "";
  }
}

function readDumpSchemaHead(sqlPath) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(sqlPath, { encoding: "utf8" });
    const lines = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    let inCopyBlock = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      lines.close();
      stream.destroy();
    };
    lines.on("line", (line) => {
      if (inCopyBlock) {
        const value = line.trim();
        finish(value === "\\." ? "" : value);
        return;
      }
      if (
        /^COPY\s+(?:"?[\w$]+"?\.)?"?alembic_version"?\s*\("?version_num"?\)\s+FROM\s+stdin;/i.test(
          line,
        )
      ) {
        inCopyBlock = true;
        return;
      }
      const insert = line.match(
        /^INSERT INTO\s+(?:"?[\w$]+"?\.)?"?alembic_version"?\s*(?:\("?version_num"?\)\s*)?VALUES\s*\('([^']+)'\)/i,
      );
      if (insert) finish(insert[1]);
    });
    lines.on("close", () => finish(""));
    stream.on("error", () => finish(""));
  });
}

function isSchemaRevisionNewer(candidate, current) {
  const candidateNumber = revisionNumericPrefix(candidate);
  const currentNumber = revisionNumericPrefix(current);
  if (candidateNumber == null || currentNumber == null) return false;
  return candidateNumber > currentNumber;
}

function assertBackupSchemaCompatible(candidate, current, noun = "backup") {
  if (!isSchemaRevisionNewer(candidate, current)) return;
  throw new Error(
    `BUNDLE_SCHEMA_NEWER: This ${noun} was created on schema revision "${candidate}" ` +
      `but this Vision install is at "${current}". Update Vision to a newer version and retry.`,
  );
}

async function runBundleBackup(destDir, frontendStateJson = null) {
  if (!destDir) throw new Error("No backup directory configured");
  const nativeRuntime = getNativeRuntime();
  const deviceId = await getBackupDeviceId();
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision_bak_"),
  );
  const dbSqlPath = path.join(tmpDir, "db.sql");
  const attachmentsDir = path.join(tmpDir, "attachments");
  try {
    await nativeRuntime.dumpDatabase(dbSqlPath, { format: "plain" });
    await nativeRuntime.exportAttachments(attachmentsDir);
    let frontendState = null;
    if (frontendStateJson) {
      try {
        frontendState =
          typeof frontendStateJson === "string"
            ? JSON.parse(frontendStateJson)
            : frontendStateJson;
      } catch {
        // Invalid optional UI state does not invalidate the database backup.
      }
    }
    const { bundlePath } = await createBundle({
      destDir,
      deviceId,
      schemaHead: await nativeRuntime.getSchemaHead(),
      appVersion: app.getVersion ? app.getVersion() : "unknown",
      dbSqlPath,
      attachmentsDir,
      frontendState,
    });
    const passphrase = await getBackupPassphrase();
    let finalFile = bundlePath;
    let encrypted = false;
    let warning;
    if (passphrase) {
      ({ encPath: finalFile } = await encryptBundle(bundlePath, passphrase));
      encrypted = true;
    } else {
      warning = "Backup encryption skipped: no passphrase configured.";
    }
    const cleanup = await cleanupOldBackups(destDir, deviceId);
    return {
      success: true,
      file: finalFile,
      encrypted,
      warning,
      cleanupRemoved: cleanup.removed,
    };
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

async function runBundleRestore(bundlePath, { passphrase } = {}) {
  if (!bundlePath) throw new Error("No backup file specified");
  if (!fs.existsSync(bundlePath))
    throw new Error(`File not found: ${bundlePath}`);
  const encrypted = await isBundleEncrypted(bundlePath);
  let effectivePassphrase = null;
  if (encrypted) {
    effectivePassphrase = passphrase || (await getBackupPassphrase());
    if (!effectivePassphrase) throw new Error(ERR_PASSPHRASE_REQUIRED);
  }
  let opened;
  try {
    opened = await openBundle(bundlePath, { passphrase: effectivePassphrase });
  } catch (error) {
    const message = String(error?.message || "");
    if (
      encrypted &&
      (/bad decrypt|wrong final block|unable to authenticate|missing metadata\.json|missing db\.sql|end of central directory|not a zip file/i.test(
        message,
      ) ||
        error?.code === "ERR_OSSL_BAD_DECRYPT" ||
        error?.code === "ERR_CRYPTO_INVALID_AUTH_TAG")
    ) {
      throw new Error(ERR_INVALID_PASSPHRASE);
    }
    throw error;
  }
  const { metadata, dbSqlPath, attachmentsDir, frontendState, cleanup } =
    opened;
  const nativeRuntime = getNativeRuntime();
  try {
    if (metadata.schemaHead) {
      const currentHead =
        (await nativeRuntime.getSchemaHead().catch(() => "")) ||
        getLocalMigrationChainHead();
      assertBackupSchemaCompatible(metadata.schemaHead, currentHead, "bundle");
    }
    const restore = await restoreNativeBundle(nativeRuntime, {
      dbSqlPath,
      attachmentsDir,
      expectedSchemaHead: metadata.schemaHead || undefined,
    });
    return {
      success: true,
      file: bundlePath,
      frontendState,
      warning: restore.cleanupWarning?.message,
    };
  } finally {
    cleanup();
  }
}

async function runRestore(sqlFilePath, { passphrase } = {}) {
  if (!sqlFilePath) throw new Error("No backup file specified");
  if (!fs.existsSync(sqlFilePath))
    throw new Error(`File not found: ${sqlFilePath}`);
  let restoreSource = sqlFilePath;
  let cleanupRestoreSource = () => {};
  if (await isEncryptedBackupFile(sqlFilePath)) {
    const effectivePassphrase = passphrase || (await getBackupPassphrase());
    if (!effectivePassphrase) throw new Error(ERR_PASSPHRASE_REQUIRED);
    restoreSource = await decryptBackupFileToTemp(
      sqlFilePath,
      effectivePassphrase,
    );
    cleanupRestoreSource = () => fs.unlink(restoreSource, () => {});
  }
  const nativeRuntime = getNativeRuntime();
  try {
    const dumpHead = await readDumpSchemaHead(restoreSource);
    if (dumpHead) {
      const currentHead =
        (await nativeRuntime.getSchemaHead().catch(() => "")) ||
        getLocalMigrationChainHead();
      assertBackupSchemaCompatible(dumpHead, currentHead);
    }
    await restoreNativeDatabase(nativeRuntime, restoreSource, {
      format: "plain",
      expectedSchemaHead: dumpHead || undefined,
    });
    return { success: true, file: sqlFilePath };
  } finally {
    cleanupRestoreSource();
  }
}

module.exports = {
  assertBackupSchemaCompatible,
  init,
  resolveDatabaseEnvironment,
  runBundleBackup,
  runBundleRestore,
  runRestore,
};
