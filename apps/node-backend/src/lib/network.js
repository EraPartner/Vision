/**
 * Network reachability probe.
 *
 * Used at startup to skip outbound data fetches when the host has no
 * internet connection. Without this, warmups (ECB rates, Yahoo quotes,
 * historical backfills) burn 10–15s on per-call timeouts before falling
 * back to cached/DB data — adding noise and delaying readiness.
 */

import net from 'node:net';
import { logger } from '../config/logger.js';

const DEFAULT_PROBE_HOST = '1.1.1.1';
const DEFAULT_PROBE_PORT = 443;
const DEFAULT_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 30_000;

let cachedResult = null;
let cachedAt = 0;
let inflight = null;

function probe({ host, port, timeoutMs }) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    // node net's socket.setTimeout fires only AFTER connect — useless for
    // gating a hung SYN. Use an explicit timer to bound the connect attempt.
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Returns true if a TCP connection to a public host succeeds within the timeout.
 * Result is cached for 30s so multiple startup callers share one probe.
 *
 * @param {{ force?: boolean, host?: string, port?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function isInternetReachable(opts = {}) {
  const {
    force = false,
    host = DEFAULT_PROBE_HOST,
    port = DEFAULT_PROBE_PORT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  const now = Date.now();
  if (!force && cachedResult !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }
  if (!force && inflight) return inflight;

  inflight = probe({ host, port, timeoutMs })
    .then((ok) => {
      cachedResult = ok;
      cachedAt = Date.now();
      logger.debug('Internet reachability probe', { ok, host, port });
      return ok;
    })
    .finally(() => { inflight = null; });

  return inflight;
}

export function clearReachabilityCache() {
  cachedResult = null;
  cachedAt = 0;
}
