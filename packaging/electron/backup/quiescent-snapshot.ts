export interface SnapshotRuntime {
  stop(): Promise<unknown>;
  start(): Promise<unknown>;
  waitUntilReady(options: { detailed: boolean }): Promise<unknown>;
}

/**
 * Stop the backend, capture, then restart. With the backend stopped no write
 * lands between the database snapshot and the attachment copy, so the two
 * halves of a backup describe the same moment.
 */
export async function captureQuiescentSnapshot<T>(
  runtime: SnapshotRuntime,
  capture: () => Promise<T>,
): Promise<T> {
  try {
    await runtime.stop();
    return await capture();
  } finally {
    // A failed snapshot or partial stop must not leave the application stopped.
    await runtime.start();
    await runtime.waitUntilReady({ detailed: true });
  }
}
