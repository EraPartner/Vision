/**
 * Concurrency helpers shared across services and jobs.
 */

/**
 * Process `items` with at most `limit` concurrent async tasks.
 * Work-queue pattern: a fixed pool of workers pulls from a shared queue
 * until it empties.
 *
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} fn
 * @returns {Promise<void>}
 */
export async function forEachConcurrent(items, limit, fn) {
  const queue = [...items];
  async function worker() {
    let item;
    while ((item = queue.shift()) !== undefined) {
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
