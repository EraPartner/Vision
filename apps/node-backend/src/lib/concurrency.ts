/**
 * Concurrency helpers shared across services and jobs.
 */

/**
 * Process `items` with at most `limit` concurrent async tasks.
 * Work-queue pattern: a fixed pool of workers pulls from a shared queue
 * until it empties.
 */
export async function forEachConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  async function worker() {
    let item;
    while ((item = queue.shift()) !== undefined) {
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
