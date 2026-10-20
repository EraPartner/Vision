export interface SnapshotRuntime {
  stop(options: { keepPostgres: boolean }): Promise<unknown>;
  start(): Promise<unknown>;
  waitUntilReady(options: { detailed: boolean }): Promise<unknown>;
}

/** Stop the backend writer while PostgreSQL stays up, capture, then restart. */
export async function captureQuiescentSnapshot<T>(
  runtime: SnapshotRuntime,
  capture: () => Promise<T>,
): Promise<T> {
  try {
    await runtime.stop({ keepPostgres: true });
    return await capture();
  } finally {
    // A failed dump or partial stop must not leave the application stopped.
    await runtime.start();
    await runtime.waitUntilReady({ detailed: true });
  }
}
