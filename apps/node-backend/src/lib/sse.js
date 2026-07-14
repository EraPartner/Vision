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

// Some user-agents (notably Chromium-based browsers) hold the first ~1–2 KB of
// a streaming response in an internal buffer before surfacing bytes to the
// fetch reader, which makes per-token SSE feel frozen until the response ends.
// Writing a single comment line of padding immediately pushes the response
// past that threshold so subsequent events are delivered as they arrive.
const SSE_FLUSH_PADDING = `:${' '.repeat(2048)}\n\n`;

/**
 * Create a backpressure-aware SSE writer bound to a req/res pair.
 *
 * Lifecycle:
 * - Tracks client disconnects via the res 'close' event.
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
// Heartbeat comment cadence. Behind a reverse proxy with a default idle
// timeout (nginx 60s), a silent stream — e.g. an Ollama cold-load that takes
// >60s before its first token — gets killed, triggering a client reconnect
// loop. A periodic SSE comment keeps the connection warm; comments (lines
// starting with `:`) are ignored by the EventSource spec.
const SSE_HEARTBEAT_MS = 20_000;

export function createSseWriter(req, res) {
  let closed = false;

  let heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    res.write(':hb\n\n');
  }, SSE_HEARTBEAT_MS);
  // Never let the heartbeat keep the event loop (or a test run) alive.
  if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();
  const stopHeartbeat = () => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  };

  const onClose = () => { closed = true; stopHeartbeat(); };
  // Listen on res only. req is a Readable stream and emits 'close' after the
  // body is consumed by upstream middleware (express.json()), which would
  // mark the writer closed before any event is emitted. res's 'close' event
  // covers both client disconnects and normal end-of-response.
  if (typeof res?.on === 'function') res.on('close', onClose);

  // Flush headers and a padding comment so the client starts seeing bytes
  // immediately. SSE comments (lines starting with `:`) are ignored by spec.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(SSE_FLUSH_PADDING);

  return {
    get closed() { return closed; },

    async write(event, data) {
      if (closed) return;
      const safeEvent = String(event).replace(/[\r\n]/g, '_');
      res.write(`event: ${safeEvent}\ndata: ${JSON.stringify(data)}\n\n`);
      await drainIfNeeded(res);
    },

    end() {
      stopHeartbeat();
      if (!res.writableEnded) res.end();
    },
  };
}
