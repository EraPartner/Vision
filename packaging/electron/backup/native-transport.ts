/** The native runtime operations a restore drives, in commit order. */
export interface NativeRestoreRuntime {
  activateRestoredDatabase(
    sourcePath: string,
    options: { format: string; expectedSchemaHead: string | undefined },
  ): Promise<{ switchToken: unknown }>;
  replaceAttachments(
    sourceDir: string,
    options: { preservePrevious: boolean },
  ): Promise<unknown>;
  start(): Promise<unknown>;
  waitUntilReady(options: { detailed: boolean }): Promise<unknown>;
  finalizeDatabaseSwitch(switchToken: unknown): Promise<unknown>;
  finalizeAttachmentSwitch(switchToken: unknown): Promise<unknown>;
  rollbackAttachmentSwitch(switchToken: unknown): Promise<unknown>;
  rollbackDatabaseSwitch(switchToken: unknown): Promise<unknown>;
}

export interface NativeRestoreOptions {
  expectedSchemaHead?: string | undefined;
}

interface DatabaseSwitch {
  switchToken: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

export async function rollbackNativeRestore(
  runtime: NativeRestoreRuntime,
  {
    databaseSwitch,
    attachmentSwitch,
  }: {
    databaseSwitch?: DatabaseSwitch | undefined;
    attachmentSwitch?: unknown;
  },
  { restart = true }: { restart?: boolean } = {},
): Promise<unknown[]> {
  const rollbackErrors: unknown[] = [];
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

// Attach rollback failures to the restore error so they are not lost.
function markRollbackErrors(error: unknown, rollbackErrors: unknown[]): void {
  if (rollbackErrors.length > 0 && isRecord(error)) {
    error.rollbackErrors = rollbackErrors;
  }
}

export async function restoreNativeDatabase(
  runtime: NativeRestoreRuntime,
  sourcePath: string,
  {
    format = "plain",
    expectedSchemaHead = undefined,
  }: NativeRestoreOptions & { format?: string } = {},
): Promise<{ databaseSwitch: DatabaseSwitch }> {
  let databaseSwitch: DatabaseSwitch | undefined;
  try {
    databaseSwitch = await runtime.activateRestoredDatabase(sourcePath, {
      format,
      expectedSchemaHead,
    });
    await runtime.start();
    await runtime.waitUntilReady({ detailed: true });
    await runtime.finalizeDatabaseSwitch(databaseSwitch.switchToken);
    return { databaseSwitch };
  } catch (error) {
    const rollbackErrors = await rollbackNativeRestore(
      runtime,
      { databaseSwitch },
      { restart: errorCode(error) !== "DATABASE_SWITCH_RECOVERY_FAILED" },
    );
    markRollbackErrors(error, rollbackErrors);
    throw error;
  }
}

export async function restoreNativeBundle(
  runtime: NativeRestoreRuntime,
  {
    dbSqlPath,
    attachmentsDir,
    expectedSchemaHead = undefined,
  }: NativeRestoreOptions & {
    dbSqlPath: string;
    attachmentsDir?: string | null;
  },
): Promise<{
  databaseSwitch: DatabaseSwitch;
  attachmentSwitch: unknown;
  cleanupWarning: unknown;
}> {
  let databaseSwitch: DatabaseSwitch | undefined;
  let attachmentSwitch: unknown;
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
    await runtime.finalizeDatabaseSwitch(databaseSwitch.switchToken);
  } catch (error) {
    const rollbackErrors = await rollbackNativeRestore(
      runtime,
      { databaseSwitch, attachmentSwitch },
      { restart: errorCode(error) !== "DATABASE_SWITCH_RECOVERY_FAILED" },
    );
    markRollbackErrors(error, rollbackErrors);
    throw error;
  }

  // Database finalization is the commit point. Removing the retained previous
  // attachment tree is cleanup only. A cleanup failure must not attempt a
  // rollback after that tree may already have been partly removed.
  let cleanupWarning: unknown;
  if (attachmentSwitch) {
    try {
      await runtime.finalizeAttachmentSwitch(attachmentSwitch);
    } catch (error) {
      cleanupWarning = error;
    }
  }
  return { databaseSwitch, attachmentSwitch, cleanupWarning };
}
