export interface SnapshotRuntime {
  stop(options: { keepPostgres: boolean }): Promise<unknown>;
  start(): Promise<unknown>;
  waitUntilReady(options: { detailed: boolean }): Promise<unknown>;
  pauseAuditClosure(): Promise<unknown>;
  resumeAuditClosure(): void;
}

/** Preserve the existing audit session across an intentional writer pause. */
export async function captureQuiescentSnapshot<T>(
  runtime: SnapshotRuntime,
  capture: () => Promise<T>,
): Promise<T> {
  await runtime.pauseAuditClosure();
  try {
    await runtime.stop({ keepPostgres: true });
    return await capture();
  } finally {
    // A failed dump or partial stop must not leave the application stopped.
    try {
      await runtime.start();
      await runtime.waitUntilReady({ detailed: true });
    } finally {
      runtime.resumeAuditClosure();
    }
  }
}
