"use strict";

const AUDIT_RECOVERY_CODES = new Set([
  "RESTORED_AUDIT_INTEGRITY_FAILED",
  "RESTORED_AUDIT_INTEGRITY_UNAVAILABLE",
]);

async function restoreWithAuditRecovery(restoreSelected, confirmRecovery) {
  try {
    return { result: await restoreSelected(false), recovered: false };
  } catch (error) {
    if (!AUDIT_RECOVERY_CODES.has(error?.code)) throw error;
    if (error.auditRecoveryUnsafe || error.rollbackErrors?.length > 0) {
      throw error;
    }
    if (!(await confirmRecovery(error))) return { cancelled: true };
    return { result: await restoreSelected(true), recovered: true };
  }
}

async function rollbackNativeRestore(
  runtime,
  { databaseSwitch, attachmentSwitch },
  { restart = true } = {},
) {
  const rollbackErrors = [];
  if (attachmentSwitch) {
    await runtime.rollbackAttachmentSwitch(attachmentSwitch).catch((error) => {
      rollbackErrors.push(error);
    });
  }
  if (databaseSwitch) {
    await runtime
      .rollbackDatabaseSwitch(databaseSwitch.switchToken)
      .catch((error) => {
        rollbackErrors.push(error);
      });
  }
  if (restart) {
    await runtime.start().catch((error) => {
      rollbackErrors.push(error);
    });
  }
  return rollbackErrors;
}

async function restoreNativeDatabase(
  runtime,
  sourcePath,
  {
    format = "plain",
    expectedSchemaHead = undefined,
    allowUnverifiedAudit = false,
  } = {},
) {
  let databaseSwitch;
  await runtime.pauseAuditClosure?.();
  try {
    databaseSwitch = await runtime.activateRestoredDatabase(sourcePath, {
      format,
      expectedSchemaHead,
    });
    await runtime.start();
    await runtime.waitUntilReady({ detailed: true });
    if (typeof runtime.assertRestoredAuditHistory === "function") {
      await runtime.assertRestoredAuditHistory({ allowUnverifiedAudit });
    }
    await runtime.finalizeDatabaseSwitch(databaseSwitch.switchToken);
    return { databaseSwitch };
  } catch (error) {
    const rollbackErrors = await rollbackNativeRestore(
      runtime,
      { databaseSwitch },
      { restart: error.code !== "DATABASE_SWITCH_RECOVERY_FAILED" },
    );
    if (rollbackErrors.length > 0) {
      error.rollbackErrors = rollbackErrors;
      error.auditRecoveryUnsafe = true;
    }
    throw error;
  } finally {
    runtime.resumeAuditClosure?.();
  }
}

async function restoreNativeBundle(
  runtime,
  {
    dbSqlPath,
    attachmentsDir,
    expectedSchemaHead = undefined,
    allowUnverifiedAudit = false,
  },
) {
  let databaseSwitch;
  let attachmentSwitch;
  await runtime.pauseAuditClosure?.();
  try {
    databaseSwitch = await runtime.activateRestoredDatabase(dbSqlPath, {
      format: "plain",
      expectedSchemaHead,
    });
    if (attachmentsDir) {
      attachmentSwitch = await runtime.replaceAttachments(attachmentsDir, {
        preservePrevious: true,
      });
    }
    await runtime.start();
    await runtime.waitUntilReady({ detailed: true });
    if (typeof runtime.assertRestoredAuditHistory === "function") {
      await runtime.assertRestoredAuditHistory({ allowUnverifiedAudit });
    }
    await runtime.finalizeDatabaseSwitch(databaseSwitch.switchToken);
  } catch (error) {
    const rollbackErrors = await rollbackNativeRestore(
      runtime,
      { databaseSwitch, attachmentSwitch },
      { restart: error.code !== "DATABASE_SWITCH_RECOVERY_FAILED" },
    );
    if (rollbackErrors.length > 0) {
      error.rollbackErrors = rollbackErrors;
      error.auditRecoveryUnsafe = true;
    }
    throw error;
  } finally {
    runtime.resumeAuditClosure?.();
  }

  // Database finalization is the commit point. Removing the retained previous
  // attachment tree is cleanup only. A cleanup failure must not attempt a
  // rollback after that tree may already have been partly removed.
  let cleanupWarning;
  if (attachmentSwitch) {
    try {
      await runtime.finalizeAttachmentSwitch(attachmentSwitch);
    } catch (error) {
      cleanupWarning = error;
    }
  }
  return { databaseSwitch, attachmentSwitch, cleanupWarning };
}

module.exports = {
  restoreWithAuditRecovery,
  rollbackNativeRestore,
  restoreNativeDatabase,
  restoreNativeBundle,
};
