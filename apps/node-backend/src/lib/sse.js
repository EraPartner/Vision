/**
 * SSE Writer
 *
 * Backpressure-aware Server-Sent Events helpers.
 * Uses res.write() drain detection to avoid unbounded buffer growth
 * when the client consumes events slower than they are produced.
 */

/**
 * Wait for the response's write buffer to drain if it is currently full.
 * Resolves immediately when no drain is needed.
 *
 * @param {import('http').ServerResponse} res
 * @returns {Promise<void>}
 */
export function drainIfNeeded(res) {
  if (!res.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => res.once('drain', resolve));
}

/**
 * Create a backpressure-aware SSE writer bound to a req/res pair.
 *
 * Lifecycle:
 * - Tracks client disconnects via the req 'close' event.
 * - write() is a no-op when the client has disconnected.
 * - end() is a no-op if the response has already ended.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {{
 *   readonly closed: boolean,
 *   write(event: string, data: unknown): Promise<void>,
 *   end(): void,
 * }}
 */
export function createSseWriter(req, res) {
  let closed = false;
  const onClose = () => { closed = true; };
  if (typeof req?.on === 'function') req.on('close', onClose);
  if (typeof res?.on === 'function') res.on('close', onClose);

  return {
    get closed() { return closed; },

    async write(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      await drainIfNeeded(res);
    },

    end() {
      if (!res.writableEnded) res.end();
    },
  };
}
