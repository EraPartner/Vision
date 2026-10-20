import { AppError } from "../../middleware/errorHandler.ts";

// Admit work before database reads and HTML allocation.
const ACTIVE_LIMIT = 2;
const QUEUED_LIMIT = 8;
let active = 0;
const queue: Array<() => void> = [];

async function acquire(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (active < ACTIVE_LIMIT) {
    active++;
    return;
  }
  if (queue.length >= QUEUED_LIMIT) {
    throw new AppError("Report capacity is full. Try again shortly.", {
      status: 503,
    });
  }
  await new Promise<void>((resolve, reject) => {
    const granted = () => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    };
    const aborted = () => {
      const index = queue.indexOf(granted);
      if (index !== -1) queue.splice(index, 1);
      signal?.removeEventListener("abort", aborted);
      const reason: unknown = signal?.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error("Report request cancelled", { cause: reason }),
      );
    };
    queue.push(granted);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export async function withReportSlot<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await acquire(signal);
  try {
    signal?.throwIfAborted();
    return await work();
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}
