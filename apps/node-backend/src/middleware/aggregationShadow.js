/**
 * Aggregation shadow-mode middleware (Phase 8).
 *
 * Purpose: during the Phase 2 → Phase 9 rollout window we run both the legacy
 * `/api/info/*` endpoints and the new `/api/aggregations/*` endpoints. This
 * middleware intercepts responses from the new routes, replays the paired
 * legacy route in the background, walks both payloads, and logs any numeric
 * delta greater than `thresholdCents` (default 1¢).
 *
 * Design goals:
 *   - Zero user-visible impact. If the legacy call fails or times out, the
 *     new response is still returned unchanged — shadow is observational only.
 *   - Pure factory, no module-level side effects. All deps (logger, legacy
 *     fetcher, clock) are injected so the middleware is unit-testable without
 *     Express / Postgres / fetch.
 *   - Deep walk that works on the `{ data, meta }` envelope standardized in
 *     Phase 2 and on any array/object shape the legacy surface emits.
 *
 * Removal: scheduled for Phase 9 once the cross-check has held quiet for a
 * full release cycle. See docs/adr/NNNN-aggregation-strategy.md.
 */

const DEFAULT_THRESHOLD_CENTS = 1;
const CENTS_PER_UNIT = 100;

/**
 * Recursively collect numeric leaves keyed by dotted path so the two payloads
 * can be diffed deterministically. Strings that look like decimals (Postgres
 * NUMERIC serialization) are coerced.
 *
 * @param {unknown} value
 * @param {string} path
 * @param {Map<string, number>} out
 */
function collectNumericLeaves(value, path, out) {
  if (value === null || value === undefined) return;

  if (typeof value === 'number' && Number.isFinite(value)) {
    out.set(path, value);
    return;
  }

  if (typeof value === 'string') {
    // Postgres NUMERIC → string. Only coerce if it parses cleanly.
    const trimmed = value.trim();
    if (trimmed !== '' && /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      out.set(path, Number(trimmed));
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectNumericLeaves(value[i], `${path}[${i}]`, out);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const nextPath = path === '' ? key : `${path}.${key}`;
      collectNumericLeaves(child, nextPath, out);
    }
  }
}

/**
 * Unwrap the Phase 2 envelope `{ data, meta }` so shadow comparison ignores
 * the meta block (computedAt / source drift).
 *
 * @param {unknown} payload
 * @returns {unknown}
 */
function unwrapEnvelope(payload) {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    'data' in payload &&
    'meta' in payload
  ) {
    return /** @type {{ data: unknown }} */ (payload).data;
  }
  return payload;
}

/**
 * Unwrap up to two levels of `{ data, meta }` envelope. Needed because
 * aggregation route bodies are double-wrapped: the outer `res.ok` envelope
 * (`{ ok, data: <inner>, meta: requestId }`) wraps the inner aggregation
 * envelope (`{ data: <payload>, meta: { computedAt, source } }`). Legacy info
 * responses only have the outer layer.
 *
 * @param {unknown} payload
 * @returns {unknown}
 */
function fullyUnwrap(payload) {
  const once = unwrapEnvelope(payload);
  return once !== payload ? unwrapEnvelope(once) : once;
}

/**
 * Compare two payloads, returning every leaf delta that exceeds the threshold.
 *
 * @param {unknown} nextPayload
 * @param {unknown} legacyPayload
 * @param {number} thresholdUnits  monetary units (e.g. euros), not cents
 * @returns {Array<{ path: string, next: number | null, legacy: number | null, delta: number }>}
 */
export function diffPayloads(nextPayload, legacyPayload, thresholdUnits) {
  const nextLeaves = new Map();
  const legacyLeaves = new Map();
  collectNumericLeaves(fullyUnwrap(nextPayload), '', nextLeaves);
  collectNumericLeaves(fullyUnwrap(legacyPayload), '', legacyLeaves);

  /** @type {Array<{ path: string, next: number | null, legacy: number | null, delta: number }>} */
  const divergences = [];
  const allPaths = new Set([...nextLeaves.keys(), ...legacyLeaves.keys()]);

  for (const path of allPaths) {
    const next = nextLeaves.has(path) ? nextLeaves.get(path) : null;
    const legacy = legacyLeaves.has(path) ? legacyLeaves.get(path) : null;

    // One side missing the leaf entirely is a structural drift, not numeric.
    // We only flag it if the present side is non-zero beyond threshold so
    // benign shape differences (e.g. new empty field) stay silent.
    if (next === null || legacy === null) {
      const present = next ?? legacy ?? 0;
      if (Math.abs(present) > thresholdUnits) {
        divergences.push({ path, next, legacy, delta: Math.abs(present) });
      }
      continue;
    }

    const delta = Math.abs(next - legacy);
    if (delta > thresholdUnits) {
      divergences.push({ path, next, legacy, delta });
    }
  }

  return divergences;
}

/**
 * Factory returning an Express middleware that shadows the new aggregation
 * response against a legacy fetcher.
 *
 * Example:
 *   app.use('/api/aggregations/monthly-summary',
 *     createAggregationShadow({
 *       fetchLegacy: (req) => infoClient.getMonthlySummary(req.query),
 *       logger,
 *     }),
 *     aggregationsRouter,
 *   );
 *
 * @param {object} deps
 * @param {(req: import('express').Request) => Promise<unknown>} deps.fetchLegacy
 * @param {{ warn: Function, error: Function, debug?: Function }} deps.logger
 * @param {number} [deps.thresholdCents=1]
 * @param {number} [deps.timeoutMs=5000]
 * @returns {import('express').RequestHandler}
 */
export function createAggregationShadow({
  fetchLegacy,
  logger,
  thresholdCents = DEFAULT_THRESHOLD_CENTS,
  timeoutMs = 5000,
  persistDivergence,
}) {
  if (typeof fetchLegacy !== 'function') {
    throw new TypeError('createAggregationShadow: fetchLegacy must be a function');
  }
  if (!logger || typeof logger.warn !== 'function') {
    throw new TypeError('createAggregationShadow: logger with .warn is required');
  }

  const thresholdUnits = thresholdCents / CENTS_PER_UNIT;

  return function aggregationShadow(req, res, next) {
    // Only shadow successful reads — GET + 2xx.
    if (req.method !== 'GET') return next();

    const originalJson = res.json.bind(res);

    res.json = function shadowedJson(body) {
      // Fire-and-forget the comparison. `queueMicrotask` keeps it off the
      // response hot path while still running in the current event-loop tick.
      queueMicrotask(() => {
        const started = Date.now();
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('shadow-timeout')), timeoutMs).unref?.(),
        );

        Promise.race([Promise.resolve().then(() => fetchLegacy(req)), timeout])
          .then((legacyPayload) => {
            const divergences = diffPayloads(body, legacyPayload, thresholdUnits);
            if (divergences.length === 0) {
              logger.debug?.('aggregation-shadow: parity ok', {
                path: req.path,
                durationMs: Date.now() - started,
              });
              return;
            }
            logger.warn('aggregation-shadow: divergence detected', {
              path: req.path,
              query: req.query,
              count: divergences.length,
              divergences: divergences.slice(0, 20), // cap log volume
              thresholdCents,
            });
            if (typeof persistDivergence === 'function') {
              persistDivergence(req.path, req.query, divergences).catch((err) => {
                logger.warn('aggregation-shadow: persistDivergence failed', {
                  path: req.path,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          })
          .catch((err) => {
            // Shadow failures must never surface — log at warn, swallow.
            logger.warn('aggregation-shadow: legacy fetch failed', {
              path: req.path,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      });

      return originalJson(body);
    };

    next();
  };
}
